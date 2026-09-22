import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Перезапуск сервера і незавершене дослідження.
//
// Прод перезбирається з кожного пуша в `main`, тож робота, яка триває
// хвилини, регулярно опиняється посеред вимкнення. Раніше вона позначалася
// «провалено» з проханням натиснути кнопку ще раз — тобто людину просили
// доробити те, що зламав деплой. Тепер сервер доробляє сам, з тієї стадії, на
// якій його застали.
//
// Жоден тест тут не ходить у мережу: стадії, які вже завершені, не
// переробляються, і саме на цьому й будується перевірка.

const STAGE_LABELS = [
  ["company", "Компанія і її продукти"],
  ["people", "Люди в компанії"],
  ["contacts", "Перевірені контакти"],
  ["scoring", "Відповідність і бал"],
  ["profile", "Опис клієнта і підходи"],
  ["writing", "Варіанти першого повідомлення"],
  ["crm", "Запис у CRM"]
];

/** Стадії роботи, де всі до `stoppedAt` завершені, а та сама — в польоті. */
function stagesInterruptedAt(stoppedAt) {
  return STAGE_LABELS.map(([id, label], index) => {
    const position = STAGE_LABELS.findIndex(([stageId]) => stageId === stoppedAt);
    if (index < position) return { id, label, status: "complete", detail: `зроблено ${id}` };
    if (index === position) return { id, label, status: "running", startedAt: new Date().toISOString() };
    return { id, label, status: "pending" };
  });
}

function jobRow(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "research-resume-1",
    prospectId: "prospect-1",
    prospectName: "Тест Тестенко",
    company: "Фліт",
    productId: "product-1",
    productName: "Продукт",
    profile: "balanced",
    force: false,
    language: "",
    actor: null,
    status: "running",
    progress: 43,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    stages: stagesInterruptedAt("scoring"),
    ...overrides
  };
}

async function startServer({ port, savedState }) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-resume-test-"));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify(savedState), "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1"
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break;
    } catch {
      // Ще піднімається.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    /** Роботу видно в /api/state; чекаємо, поки вона дійде до стану, який перевіряємо. */
    async job(until = () => true) {
      const until_ = Date.now() + 6000;
      let last = null;
      while (Date.now() < until_) {
        const payload = await (await fetch(`${origin}/api/state`)).json();
        last = (payload.researchJobs || [])[0] || null;
        if (last && until(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return last;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const PROSPECT = {
  id: "prospect-1",
  name: "Тест Тестенко",
  company: "Фліт",
  title: "Head of Ops",
  status: "new"
};

test("дослідження, яке урвав перезапуск, доробляється саме і не переробляє зроблене", async () => {
  // Усі сім стадій уже завершені, а робота лишилася «running»: рівно той
  // випадок, коли процес убили між останньою стадією і записом «complete».
  // Відновлення має дійти до кінця, не зробивши жодного зовнішнього запиту —
  // якби воно переробляло зроблене, тест пішов би в мережу і не був би таким.
  const server = await startServer({
    port: 43301,
    savedState: {
      version: 1,
      prospects: [PROSPECT],
      researchJobs: [jobRow({
        stages: STAGE_LABELS.map(([id, label]) => ({ id, label, status: "complete", detail: `зроблено ${id}` }))
      })]
    }
  });

  try {
    const job = await server.job((item) => ["complete", "failed"].includes(item.status));
    assert.equal(job.status, "complete", "перезапуск не має коштувати людині натискання кнопки");
    assert.equal(job.progress, 100);
    assert.equal(job.resumes, 1, "і в роботі видно, що її відновлювали");
    assert.doesNotMatch(String(job.error || ""), /Запусти його ще раз/);
  } finally {
    await server.stop();
  }
});

test("стадія, яку застали в польоті, повертається в чергу, а завершені лишаються завершеними", async () => {
  // Лід зник, поки сервер лежав: відновлення не має за що взятися і каже про
  // це чесно. Важливе тут — що сталося зі стадіями дорогою.
  const server = await startServer({
    port: 43302,
    savedState: {
      version: 1,
      prospects: [],
      researchJobs: [jobRow()]
    }
  });

  try {
    const job = await server.job((item) => item.status === "failed");
    const byId = Object.fromEntries(job.stages.map((stage) => [stage.id, stage.status]));
    assert.equal(byId.company, "complete", "зроблене не скасовується перезапуском");
    assert.equal(byId.people, "complete");
    assert.equal(byId.contacts, "complete");
    assert.equal(byId.scoring, "pending", "а та, що була в польоті, просто чекає своєї черги");
    assert.equal(byId.writing, "pending");
    assert.match(job.error, /немає в черзі/, "причина — зниклий лід, а не перезапуск");
    assert.doesNotMatch(job.error, /Запусти його ще раз/);
  } finally {
    await server.stop();
  }
});

test("робота, яка переривається знову і знову, зупиняється сама після трьох спроб", async () => {
  // Запобіжник. Без нього робота, яка валить процес, відновлювалася б вічно і
  // з кожним колом витрачала гроші наново.
  const server = await startServer({
    port: 43303,
    savedState: {
      version: 1,
      prospects: [PROSPECT],
      researchJobs: [jobRow({ resumes: 3 })]
    }
  });

  try {
    const job = await server.job((item) => item.status === "failed");
    assert.equal(job.status, "failed");
    assert.equal(job.resumes, 4);
    assert.match(job.error, /більше не відновлюється саме/);
    assert.match(job.error, /Запусти його вручну/, "і людині сказано, що робити далі");
    // Навіть здавшись, зібране не викидається.
    const byId = Object.fromEntries(job.stages.map((stage) => [stage.id, stage.status]));
    assert.equal(byId.company, "complete");
  } finally {
    await server.stop();
  }
});
