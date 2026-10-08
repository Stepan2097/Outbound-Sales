import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSavedState } from "./saved-state.mjs";
import { listeningOrigin } from "./server-origin.mjs";

// Скоринг у цьому застосунку — дві різні речі, і плутати їх дорого.
//
// Бал ліда рахується з фактів про людину детерміновано: та сама людина завжди
// отримує те саме число, бо на цьому числі стоїть порядок у черзі, і баєр, що
// відкрив сьогодні 37-го ліда, має побачити той самий бал, що й учора.
//
// Модель скорингу — окрема штука: вона вчиться на розв'язаних результатах з
// CRM і вмикається лише тоді, коли тих результатів справді набралось. Поки їх
// мало, вона не має права чіпати живі бали — інакше бал поїде від чотирьох
// випадкових відповідей, а не від даних.
//
// Нижче тести правил, не рубрики: конкретні ваги можна крутити, а правила —
// ні.

async function startServer({ savedState = null, env = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-scoring-test-"));
  const statePath = join(directory, "state.json");
  if (savedState) await writeFile(statePath, JSON.stringify(savedState), "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: "0",
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      ...env
    },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = await listeningOrigin(child);
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
  return {
    origin,
    statePath,
    async savedState() {
      return readSavedState(statePath);
    },
    async get(path) {
      const response = await fetch(`${origin}${path}`);
      return { status: response.status, payload: await response.json() };
    },
    async post(path, body) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

function savedProspect(saved, name) {
  return saved.prospects.find((item) => item.name === name);
}

// Бал, що його віддає /api/state, — це бал аналізу під вибраний продукт, і до
// дослідження він нуль. Рубрика ліда живе в збереженому стані, тож саме туди
// ці два тести й дивляться: інакше вони перевіряли б не те, що називають.

test("бал ліда рахується з фактів: ті самі факти — те саме число, і стеля не пробивається", async () => {
  const server = await startServer({});
  try {
    const senior = {
      name: "Maryna Holod",
      company: "Northwind Apps",
      title: "VP Sales",
      notes: "Шукає канал під mobile UA",
      website: "northwind.example",
      linkedin: "https://www.linkedin.com/in/maryna-holod"
    };
    const bare = { name: "Petro Lysyi", company: "Northwind Apps" };

    const first = await server.post("/api/prospects/import", { prospects: [senior, bare] });
    assert.equal(first.status, 200);
    const afterFirst = await server.savedState();
    const seniorScore = savedProspect(afterFirst, "Maryna Holod").score;
    const bareScore = savedProspect(afterFirst, "Petro Lysyi").score;

    // Та сама людина, вставлена вдруге — те саме число, і не другий рядок.
    await server.post("/api/prospects/import", { prospects: [senior] });
    const afterSecond = await server.savedState();
    const sameNames = afterSecond.prospects.filter((item) => item.name === "Maryna Holod");
    assert.equal(sameNames.length, 1);
    assert.equal(sameNames[0].score, seniorScore);

    // Посада й контекст важать: заповнений профіль не може стояти нижче за
    // голий рядок із тієї ж компанії.
    assert.ok(seniorScore > bareScore, `${seniorScore} має бути вище за ${bareScore}`);
    // Стеля існує, інакше кілька сигналів разом дали б бал поза шкалою.
    assert.ok(seniorScore <= 96, `бал ${seniorScore} пробив стелю`);
    assert.ok(bareScore > 0);
  } finally {
    await server.stop();
  }
});

test("бал, що прийшов разом із лідом, не перераховується", async () => {
  const server = await startServer({});
  try {
    await server.post("/api/prospects/import", {
      prospects: [{ name: "Olena Kravets", company: "Dovzhenko Games", title: "Head of Growth", score: 41 }]
    });
    // 41 — це чужа оцінка (CRM або людина). Переписати її своєю рубрикою
    // означає тихо втратити рішення, яке вже хтось ухвалив.
    const saved = await server.savedState();
    assert.equal(savedProspect(saved, "Olena Kravets").score, 41);
  } finally {
    await server.stop();
  }
});

test("модель скорингу не вмикається, поки розв'язаних результатів мало, і нічого не важить", async () => {
  const server = await startServer({
    savedState: {
      version: 1,
      prospects: [
        { id: "lead-1", name: "Ihor Sydir", company: "Kodiak Studio", title: "VP Sales", score: 77 },
        { id: "lead-2", name: "Dana Verb", company: "Kodiak Studio", title: "Analyst", score: 32 }
      ],
      interactions: [
        // Перегляд профілю — не результат: ним нічого не розв'язано.
        { id: "i-1", prospectId: "lead-1", type: "linkedin_profile_viewed", outcome: "", note: "", at: new Date().toISOString() },
        { id: "i-2", prospectId: "lead-2", type: "linkedin_reply", outcome: "replied", note: "", at: new Date().toISOString() }
      ]
    }
  });
  try {
    const { status, payload } = await server.post("/api/scoring/retrain", {});
    assert.equal(status, 200);
    const model = payload.scoringModel;
    assert.equal(model.status, "insufficient_data");
    // Порахувався лише той лід, у якого є розв'язаний результат.
    assert.equal(model.sampleSize, 1);
    assert.equal(model.positiveOutcomes, 1);
    assert.equal(model.negativeOutcomes, 0);
    // Ваги модель рахує завжди, але поки статус не «trained», вони не йдуть у
    // бал — тому тут перевіряється не число ваги, а те, що статус і нотатка
    // прямо кажуть, чого бракує. Без цього «insufficient_data» нічого не
    // означає для людини, яка натиснула «перенавчити».
    assert.equal(model.minimumSamples, 20);
    assert.match(model.notes.join(" "), /19 more resolved CRM lead outcomes/);

    // І головне: перенавчання не переписує збережені бали лідів — 77 і 32
    // прийшли зі станом і мають лишитись такими ж.
    const saved = await server.savedState();
    assert.equal(saved.prospects.find((item) => item.id === "lead-1").score, 77);
    assert.equal(saved.prospects.find((item) => item.id === "lead-2").score, 32);
  } finally {
    await server.stop();
  }
});

test("двадцять розв'язаних результатів вмикають модель, і ваги їдуть від даних", async () => {
  const prospects = [];
  const interactions = [];
  const at = new Date().toISOString();
  // Десять лідів, що відповіли, і десять, що злились — із різними профілями,
  // бо модель не має чого вчити, якщо обидві групи виглядають однаково.
  for (let index = 0; index < 10; index += 1) {
    prospects.push({
      id: `won-${index}`,
      name: `Winner ${index}`,
      company: "Replying Co",
      title: "VP Growth",
      website: "replying.example",
      linkedin: `https://www.linkedin.com/in/winner-${index}`,
      notes: "Запускає нову гру в Q4"
    });
    interactions.push({ id: `wi-${index}`, prospectId: `won-${index}`, type: "linkedin_reply", outcome: "replied", note: "meeting_booked", at });
    prospects.push({ id: `lost-${index}`, name: `Quiet ${index}`, company: "Silent Co" });
    interactions.push({ id: `li-${index}`, prospectId: `lost-${index}`, type: "linkedin_invite_sent", outcome: "no_reply", note: "", at });
  }
  const server = await startServer({ savedState: { version: 1, prospects, interactions } });
  try {
    const { payload } = await server.post("/api/scoring/retrain", {});
    const model = payload.scoringModel;
    assert.equal(model.status, "trained");
    assert.equal(model.sampleSize, 20);
    assert.equal(model.positiveOutcomes, 10);
    assert.equal(model.negativeOutcomes, 10);
    // Навчена модель — це ваги, що відрізняються від одиниці хоча б десь,
    // інакше «навчена» нічого не означає.
    const moved = Object.values(model.featureMultipliers).filter((value) => value !== 1);
    assert.ok(moved.length, "жодна вага не зрушила після навчання");
    // І вони лишаються в межах, за які модель не має права виходити.
    for (const [feature, multiplier] of Object.entries(model.featureMultipliers)) {
      assert.ok(multiplier >= 0.75 && multiplier <= 1.35, `вага ${feature} = ${multiplier} вийшла за межі`);
    }
    assert.match(model.notes.join(" "), /learned from saved CRM/i);
  } finally {
    await server.stop();
  }
});
