import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Вебхук транскриптів — єдина двері в застосунок, яку відчиняє не людина, а
// чужий сервіс: провайдер телефонії шле текст дзвінка, і з нього тут
// народжується аналіз, взаємодія в історії та задача на фолоу-ап.
//
// Тому перевіряються три речі, якими такий вхід відрізняється від кнопки:
//   • він мусить сам знайти, про кого цей дзвінок, і не маючи наших id;
//   • він мусить відмовити зрозуміло, коли ліда не знайшов або тексту нема що
//     аналізувати — а не записати аналіз «комусь»;
//   • наступний крок, про який домовились у дзвінку, мусить стати задачею, бо
//     саме через неї продавець про нього згадає;
//   • і він мусить бути зачинений, доки токен не налаштували: вхід, який
//     відкривається від того, що змінну забули, — це відкритий вхід.
//
// Аналіз тут рахує детермінована половина (без ключа провайдера), тож
// очікування в тестах — це правила тієї половини, а не вигадка моделі.

async function startServer({ port, savedState = null, env = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-transcript-test-"));
  const statePath = join(directory, "state.json");
  if (savedState) await writeFile(statePath, JSON.stringify(savedState), "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      ...env
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) break;
    } catch {
      // Ще піднімається.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const token = "transcript-webhook-token";
  return {
    origin,
    token,
    /** Налаштувати провайдера транскриптів і отримати робочий токен вебхука. */
    async configureTranscripts() {
      const response = await fetch(`${origin}/api/integrations/transcripts/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "aircall", apiToken: token, webhookUrl: `${origin}/api/webhooks/call-transcript` })
      });
      assert.equal(response.status, 200);
      await response.json();
      return token;
    },
    async savedState() {
      return JSON.parse(await readFile(statePath, "utf8"));
    },
    async transcript(body, { webhookToken = token } = {}) {
      const headers = { "Content-Type": "application/json" };
      if (webhookToken !== null) headers["x-webhook-token"] = webhookToken;
      const response = await fetch(`${origin}/api/webhooks/call-transcript`, {
        method: "POST",
        headers,
        body: JSON.stringify(body || {})
      });
      return { status: response.status, payload: await response.json() };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const lead = {
  id: "lead-call",
  name: "Daria Lysenko",
  company: "Portside Games",
  title: "Head of User Acquisition",
  email: "daria@portsidegames.example",
  linkedin: "https://www.linkedin.com/in/daria-lysenko",
  status: "contacted"
};

// Довше за сорок символів і з домовленістю про наступний крок.
const agreedCall = "Daria asked for the workflow and said send me the deck next week so we can follow up with her team.";
// Так само довгий, але без жодного наступного кроку.
const flatCall = "We walked through the current reporting setup and the team history for about ten minutes in total today.";

test("дзвінок без ліда не записується нікому", async () => {
  const server = await startServer({ port: 43321, savedState: { version: 1, prospects: [lead], interactions: [] } });
  try {
    await server.configureTranscripts();
    const { status, payload } = await server.transcript({ name: "Nobody Here", company: "Nowhere Ltd", transcript: agreedCall });
    assert.equal(status, 404);
    assert.match(payload.error, /не знайдено/i);

    // Жодного аналізу не причепилось до єдиного ліда, що є.
    const saved = await server.savedState();
    assert.ok(!saved.prospects.find((item) => item.id === "lead-call").callAnalysis);
    assert.deepEqual(saved.interactions, []);
  } finally {
    await server.stop();
  }
});

test("текст, закороткий для аналізу, відхиляється, а не аналізується наполовину", async () => {
  const server = await startServer({ port: 43322, savedState: { version: 1, prospects: [lead], interactions: [] } });
  try {
    await server.configureTranscripts();
    const { status, payload } = await server.transcript({ prospectId: "lead-call", transcript: "подзвонили, ок" });
    assert.equal(status, 400);
    assert.match(payload.error, /закороткий/i);
  } finally {
    await server.stop();
  }
});

test("вебхук знаходить ліда за іменем і компанією, без наших id", async () => {
  const server = await startServer({ port: 43323, savedState: { version: 1, prospects: [lead], interactions: [] } });
  try {
    await server.configureTranscripts();
    const { status, payload } = await server.transcript({
      name: "Daria Lysenko",
      company: "Portside Games",
      transcript: agreedCall,
      source: "aircall",
      callId: "aircall-7781"
    });
    assert.equal(status, 200);

    const prospect = payload.prospects.find((item) => item.id === "lead-call");
    assert.equal(prospect.callAnalysis.source, "aircall");
    assert.equal(prospect.callAnalysis.externalCallId, "aircall-7781");
    assert.equal(prospect.callAnalysis.sentiment, "positive");
    assert.ok(prospect.callAnalysis.summary.includes("Portside Games"));

    // Дзвінок лишає слід в історії людини — інакше наступний, хто її відкриє,
    // не знатиме, що з нею вже говорили.
    const logged = payload.interactions.filter((item) => item.prospectId === "lead-call" && item.type === "call_completed");
    assert.equal(logged.length, 1);

    // І сам канал видно як живий, з часом останнього приходу.
    assert.equal(payload.integrations.transcripts.status, "receiving_calls");
    assert.ok(payload.integrations.transcripts.lastIngestedAt);
  } finally {
    await server.stop();
  }
});

test("домовленість про наступний крок стає задачею, а дзвінок без неї — ні", async () => {
  const server = await startServer({ port: 43324, savedState: { version: 1, prospects: [lead], interactions: [], followUpTasks: [] } });
  try {
    await server.configureTranscripts();
    const agreed = await server.transcript({ prospectId: "lead-call", transcript: agreedCall });
    assert.equal(agreed.status, 200);
    const tasksAfterAgreement = agreed.payload.followUpTasks.filter((item) => item.prospectId === "lead-call");
    assert.equal(tasksAfterAgreement.length, 1);
    assert.ok(tasksAfterAgreement[0].due, "у задачі немає дати, за якою про неї згадають");
    assert.match(tasksAfterAgreement[0].label, /Daria Lysenko/);
    // Задача приходить з каналом сповіщення з налаштувань, інакше вона нікого
    // не розбудить.
    assert.ok(Object.hasOwn(tasksAfterAgreement[0], "notificationChannel"));
    // І сам аналіз каже, що наступний крок є, а не лише задача збоку.
    assert.ok(agreed.payload.prospects.find((item) => item.id === "lead-call").callAnalysis.followUpTask);

    const flat = await server.transcript({ prospectId: "lead-call", transcript: flatCall });
    assert.equal(flat.status, 200);
    const analysis = flat.payload.prospects.find((item) => item.id === "lead-call").callAnalysis;
    assert.equal(analysis.sentiment, "neutral");
    assert.equal(analysis.followUpTask, null);
    // Задача з попереднього дзвінка не зникає: її закриває людина, не наступний дзвінок.
    assert.equal(flat.payload.followUpTasks.filter((item) => item.prospectId === "lead-call").length, 1);
  } finally {
    await server.stop();
  }
});

test("прийнятий дзвінок лежить у файлі стану, а не лише в пам'яті", async () => {
  const server = await startServer({ port: 43329, savedState: { version: 1, prospects: [lead], interactions: [], followUpTasks: [] } });
  try {
    await server.configureTranscripts();
    const { status } = await server.transcript({
      prospectId: "lead-call",
      transcript: agreedCall,
      source: "aircall",
      callId: "aircall-9002"
    });
    assert.equal(status, 200);

    // Відповідь 200 провайдеру означає «записано», і вдруге він той самий
    // дзвінок не надішле. Тому все, що народилось із нього, мусить бути вже
    // на диску на момент відповіді — не після таймера й не після наступної
    // дії людини: рестарт тут трапляється кілька разів на день, бо кожен пуш
    // у main — це деплой.
    const saved = await server.savedState();
    const prospect = saved.prospects.find((item) => item.id === "lead-call");
    assert.ok(prospect.callAnalysis, "аналіз дзвінка не дожив до файлу стану");
    assert.equal(prospect.callAnalysis.externalCallId, "aircall-9002");
    assert.equal(
      saved.interactions.filter((item) => item.prospectId === "lead-call" && item.type === "call_completed").length,
      1,
      "слід дзвінка в історії людини не дожив до файлу стану"
    );
    assert.equal(
      saved.followUpTasks.filter((item) => item.prospectId === "lead-call").length,
      1,
      "задача на фолоу-ап не дожила до файлу стану"
    );
    // І сам канал видно живим після підняття заново.
    assert.equal(saved.integrationSettings.transcripts.status, "receiving_calls");
  } finally {
    await server.stop();
  }
});

test("вебхук зачинений, доки токен не налаштували, і чужий токен не відчиняє його", async () => {
  const server = await startServer({ port: 43325, savedState: { version: 1, prospects: [lead], interactions: [] } });
  try {
    // Токена ще немає в налаштуваннях — отже вхід зачинений, а не відкритий.
    const unset = await server.transcript({ prospectId: "lead-call", transcript: agreedCall }, { webhookToken: null });
    assert.equal(unset.status, 401);

    await server.configureTranscripts();
    const wrong = await server.transcript({ prospectId: "lead-call", transcript: agreedCall }, { webhookToken: "not-the-token" });
    assert.equal(wrong.status, 401);
    const missing = await server.transcript({ prospectId: "lead-call", transcript: agreedCall }, { webhookToken: null });
    assert.equal(missing.status, 401);

    // Жодна відмова не лишила по собі аналізу.
    const saved = await server.savedState();
    assert.ok(!saved.prospects.find((item) => item.id === "lead-call").callAnalysis);

    const accepted = await server.transcript({ prospectId: "lead-call", transcript: agreedCall });
    assert.equal(accepted.status, 200);
  } finally {
    await server.stop();
  }
});
