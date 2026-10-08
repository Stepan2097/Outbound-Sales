import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Усе, що людина змінює в застосунку, мусить пережити деплой — а тут кожен пуш
// у main це деплой. Правило провайдера, транскрипт вебхука й «Збагатити» вже
// були окремими таксами; цей файл закриває решту класу: бюджети (разом із
// жорстким лімітом витрат), ручні перемикачі моделей, маршрутизацію задач,
// вибір моделей аналізу й письма, слід дій AI-оператора, ICP і токен вебхука
// транскриптів.
//
// Рестарт тут справжній: сервер запускається двічі на одному файлі стану.
// Ключ OpenRouter навмисно порожній — інакше сервер при старті пішов би в
// мережу синхронізувати каталог моделей.

const QUIET = { OPENROUTER_API_KEY: "", OPENROUTER_ANALYSIS_MODEL: "", OPENROUTER_WRITING_MODEL: "", TRANSCRIPT_WEBHOOK_TOKEN: "" };

async function boot({ port, statePath, env = {} }) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...QUIET, PORT: String(port), STATE_FILE_PATH: statePath, AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1", ...env },
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
    async state() {
      return (await fetch(`${origin}/api/state`)).json();
    },
    async post(path, body, headers = {}) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body || {})
      });
      return { status: response.status, payload: await response.json() };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  };
}

async function workspace(saved = { version: 1, prospects: [], interactions: [] }) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-restart-test-"));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify(saved), "utf8");
  return {
    statePath,
    file: async () => JSON.parse(await readFile(statePath, "utf8")),
    async cleanup() { await rm(directory, { recursive: true, force: true }); }
  };
}

/** Змінити щось, переконатись, що файл уже має це, перезапустити — і віддати перший сервер на перевірку другого. */
async function restarted(space, ports, change, { env } = {}) {
  const first = await boot({ port: ports[0], statePath: space.statePath, env });
  try {
    await change(first);
  } finally {
    await first.stop();
  }
  return boot({ port: ports[1], statePath: space.statePath, env });
}

test("бюджети й жорсткий ліміт витрат переживають рестарт", async () => {
  const space = await workspace();
  const changed = { monthlyWorkspaceBudgetUsd: 123, dailyWorkspaceBudgetUsd: 11, perUserMonthlyBudgetUsd: 22, hardLimitEnabled: false, warningThresholdPercent: 55 };
  let second;
  try {
    second = await restarted(space, [43381, 43382], async (server) => {
      assert.equal((await server.post("/api/budgets/update", changed)).status, 200);
      // Файл читається одразу після відповіді: саме з нього сервер підніметься.
      assert.deepEqual((await space.file()).budgets, changed, "бюджети не дійшли до файлу стану");
    });
    // Типово жорсткий ліміт увімкнений, тож «вимкнено» — саме те, що не мусить повернутись у «увімкнено» мовчки.
    assert.deepEqual((await second.state()).budgets, changed);
  } finally {
    await second?.stop();
    await space.cleanup();
  }
});

test("ручний перемикач моделі переживає рестарт", async () => {
  const space = await workspace();
  let second;
  try {
    second = await restarted(space, [43383, 43384], async (server) => {
      const before = (await server.state()).models.find((model) => model.id === "mock/premium");
      assert.equal(before.enabled, true, "припущення тесту: модель типово ввімкнена");
      assert.equal((await server.post("/api/models/toggle", { modelId: "mock/premium", enabled: false })).status, 200);
      assert.deepEqual((await space.file()).modelToggles, { "mock/premium": false });
    });
    const models = (await second.state()).models;
    assert.equal(models.find((model) => model.id === "mock/premium").enabled, false, "вимкнену модель після рестарту ввімкнено знову");
    assert.equal(models.find((model) => model.id === "mock/balanced").enabled, true, "сусідню модель зачепило");
  } finally {
    await second?.stop();
    await space.cleanup();
  }
});

test("маршрутизація задачі — модель, ліміт витрат, приватність — переживає рестарт", async () => {
  const space = await workspace();
  const change = { taskType: "COLD_EMAIL", primaryModel: "mock/premium", fallbackModels: ["mock/balanced"], qualityTier: "premium", maxCostUsd: 0.5, maxLatencyMs: 9000, privacyLevel: "zero_retention" };
  let second;
  try {
    second = await restarted(space, [43385, 43386], async (server) => {
      assert.equal((await server.post("/api/tasks/update", change)).status, 200);
      assert.ok((await space.file()).taskRouting.some((record) => record.taskType === "COLD_EMAIL" && record.maxCostUsd === 0.5), "маршрутизація не дійшла до файлу");
    });
    const task = (await second.state()).tasks.find((item) => item.taskType === "COLD_EMAIL");
    assert.deepEqual(
      { taskType: task.taskType, primaryModel: task.primaryModel, fallbackModels: task.fallbackModels, qualityTier: task.qualityTier, maxCostUsd: task.maxCostUsd, maxLatencyMs: task.maxLatencyMs, privacyLevel: task.privacyLevel },
      change
    );
  } finally {
    await second?.stop();
    await space.cleanup();
  }
});

test("вибір моделей аналізу й письма переживає рестарт, навіть коли ключа ще немає", async () => {
  const space = await workspace();
  let second;
  try {
    second = await restarted(space, [43387, 43388], async (server) => {
      // Без ключа запит відхиляється, але вибір моделей уже застосований — і мусить бути збережений, а не лишитись напівзробленим.
      const refused = await server.post("/api/openrouter/configure", { analysisModel: "vendor/analysis-x", writingModel: "vendor/writing-y" });
      assert.equal(refused.status, 400);
      assert.deepEqual((await space.file()).aiModelDefaults, { analysisModel: "vendor/analysis-x", writingModel: "vendor/writing-y" });
    });
    assert.deepEqual((await second.state()).aiModelDefaults, { analysisModel: "vendor/analysis-x", writingModel: "vendor/writing-y" });
  } finally {
    await second?.stop();
    await space.cleanup();
  }
});

test("слід дій AI-оператора переживає рестарт", async () => {
  const lead = { id: "lead-trail", name: "Daria Lysenko", company: "Portside Games", title: "Head of UA", status: "new" };
  const space = await workspace({ version: 1, prospects: [lead], interactions: [] });
  let second;
  try {
    let summary;
    second = await restarted(space, [43389, 43391], async (server) => {
      const { status, payload } = await server.post("/api/assistant/task", { instruction: "mark all leads as follow up due", scope: "all" });
      assert.equal(status, 200);
      summary = payload.aiActions[0].summary;
      assert.ok(summary, "припущення тесту: дія має підсумок");
      assert.ok(((await space.file()).aiActions || []).length >= 1, "слід дії не дійшов до файлу стану");
    });
    const trail = (await second.state()).aiActions;
    assert.ok(trail.length >= 1, "після рестарту слід дій порожній");
    assert.equal(trail[0].summary, summary);
  } finally {
    await second?.stop();
    await space.cleanup();
  }
});

test("ICP: сід-ліди, профіль із них і відомості про останній платний пошук переживають рестарт", async () => {
  const space = await workspace();
  let second;
  try {
    second = await restarted(space, [43392, 43395], async (server) => {
      const seeded = await server.post("/api/icp/seeds/import", {
        prospects: [{ name: "Ivan Teslenko", company: "Harbor Interactive", title: "Head of User Acquisition", location: "Warsaw, Poland" }]
      });
      assert.equal(seeded.status, 200);
      assert.equal((await server.post("/api/icp/lookalike-json", { totalResults: 777 })).status, 200);
      const saved = await space.file();
      assert.equal(saved.icp.seedLeadIds.length, 1, "сід-лід не дійшов до файлу");
      assert.equal(saved.icp.lookalikeSearch.totalResults, 777, "параметри пошуку не дійшли до файлу");
    });
    const { icp } = await second.state();
    assert.equal(icp.seedLeadCount, 1, "після рестарту лічильник сідів — нуль, хоча самі ліди в черзі");
    assert.equal(icp.profile.status, "trained", "профіль після рестарту порожній над повним списком сідів");
    assert.equal(icp.lookalikeSearch.totalResults, 777);
  } finally {
    await second?.stop();
    await space.cleanup();
  }
});

test("токен вебхука транскриптів із середовища відчиняє вебхук без жодного налаштування в застосунку", async () => {
  const lead = { id: "lead-env", name: "Daria Lysenko", company: "Portside Games", title: "Head of UA", status: "contacted" };
  const space = await workspace({ version: 1, prospects: [lead], interactions: [] });
  const call = { prospectId: "lead-env", transcript: "Daria asked for the workflow and said send me the deck next week so we can follow up with her team." };
  const env = { TRANSCRIPT_WEBHOOK_TOKEN: "env-webhook-token-12345" };
  let second;
  try {
    // Два запуски поспіль: токен із середовища однаково працює після кожного
    // рестарту, і саме цього не було в токена, введеного в застосунку.
    second = await restarted(space, [43393, 43396], async (server) => {
      assert.equal((await server.post("/api/webhooks/call-transcript", call, { "x-webhook-token": "env-webhook-token-12345" })).status, 200);
    }, { env });
    assert.equal((await second.post("/api/webhooks/call-transcript", call, { "x-webhook-token": "wrong-token" })).status, 401);
    assert.equal((await second.post("/api/webhooks/call-transcript", call)).status, 401);
    assert.equal((await second.post("/api/webhooks/call-transcript", call, { "x-webhook-token": "env-webhook-token-12345" })).status, 200);
    assert.equal((await second.state()).integrations.transcripts.configured, true);
  } finally {
    await second?.stop();
    await space.cleanup();
  }
});

test("без змінної токена вебхук лишається зачиненим", async () => {
  const lead = { id: "lead-env", name: "Daria Lysenko", company: "Portside Games", title: "Head of UA", status: "contacted" };
  const space = await workspace({ version: 1, prospects: [lead], interactions: [] });
  const server = await boot({ port: 43397, statePath: space.statePath });
  try {
    const call = { prospectId: "lead-env", transcript: "Daria asked for the workflow and said send me the deck next week so we can follow up with her team." };
    assert.equal((await server.post("/api/webhooks/call-transcript", call, { "x-webhook-token": "anything" })).status, 401);
  } finally {
    await server.stop();
    await space.cleanup();
  }
});

test("зіпсований файл стану не валить старт і не стирає типові значення", async () => {
  const space = await workspace({
    version: 1,
    prospects: [],
    interactions: [],
    budgets: "x",
    aiModelDefaults: [1],
    modelToggles: ["a"],
    taskRouting: "x",
    aiActions: { not: "a list" },
    icp: 5
  });
  const server = await boot({ port: 43398, statePath: space.statePath });
  try {
    const state = await server.state();
    assert.equal(state.budgets.hardLimitEnabled, true, "жорсткий ліміт типово мусить бути в силі");
    assert.equal(state.budgets.monthlyWorkspaceBudgetUsd, 500);
    assert.ok(state.models.every((model) => typeof model.enabled === "boolean"));
    assert.ok(Array.isArray(state.aiActions));
    assert.ok(state.tasks.length > 0);
  } finally {
    await server.stop();
    await space.cleanup();
  }
});
