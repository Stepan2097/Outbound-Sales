import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// AI-оператор робить пачками те, що продавець робив би руками: сортує чергу,
// переставляє статуси, пише взаємодії в історію. Коли ключа провайдера немає
// або провайдер лежить, інструкцію розбирає локальний парсер — і саме цей шлях
// тут і перевіряється, бо він єдиний, що працює без грошей і без мережі.
//
// Два правила, на яких усе тримається:
//   • оператор ніколи не вигадує дії, якої не зрозумів — він каже «не зрозумів»
//     і перелічує, що вміє, замість зробити щось навмання;
//   • кожна виконана дія лишає слід: результат у відповіді, подію в журналі й
//     зміну в збереженому стані, а не лише повідомлення на екрані.
//
// Статус у відповіді /api/state перекривається станом дослідження під вибраний
// продукт, тож статуси лідів тести читають зі збереженого стану.

async function startServer({ port, savedState = null, env = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-operator-test-"));
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
  return {
    origin,
    async savedState() {
      return JSON.parse(await readFile(statePath, "utf8"));
    },
    async task(body) {
      const response = await fetch(`${origin}/api/assistant/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      const payload = await response.json();
      return { status: response.status, payload, action: payload.aiActions?.[0] };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function savedWith(prospects) {
  // Інтеракції порожнім списком — інакше в стані лишаються засіяні, і тест
  // «нічого не записалось» перевіряв би не те.
  return { version: 1, prospects, interactions: [] };
}

function threeLeads() {
  return [
    { id: "lead-low", name: "Low Signal", company: "Alpha Co", title: "Analyst", score: 40, status: "new" },
    { id: "lead-high", name: "High Signal", company: "Beta Co", title: "VP Growth", score: 90, status: "new" },
    { id: "lead-mid", name: "Mid Signal", company: "Gamma Co", title: "Manager", score: 65, status: "new" }
  ];
}

test("інструкція, закоротка щоб бути задачею, нічого не запускає", async () => {
  const server = await startServer({ port: 43315, savedState: savedWith(threeLeads()) });
  try {
    const { status, action } = await server.task({ instruction: "go", scope: "all" });
    assert.equal(status, 200);
    assert.equal(action.status, "blocked");
    assert.deepEqual(action.results, []);
    assert.match(action.warnings.join(" "), /Type a task/i);

    // Нічого не зрушило: ні статуси, ні історія.
    const saved = await server.savedState();
    assert.deepEqual(saved.prospects.map((item) => item.status), ["new", "new", "new"]);
    assert.equal((saved.interactions || []).length, 0);
  } finally {
    await server.stop();
  }
});

test("інструкцію, якої оператор не зрозумів, він не вигадує, а каже що вміє", async () => {
  const server = await startServer({ port: 43316, savedState: savedWith(threeLeads()) });
  try {
    const { action } = await server.task({ instruction: "what is the weather in Kyiv today", scope: "all" });
    assert.equal(action.status, "blocked");
    assert.deepEqual(action.results, []);
    // Повідомлення мусить перелічити, що саме можна попросити, інакше людина
    // лишається з «не зрозумів» і без наступного кроку.
    const warning = action.warnings.join(" ");
    assert.match(warning, /No supported action was detected/i);
    assert.match(warning, /sort/i);
    assert.match(warning, /status/i);

    const saved = await server.savedState();
    assert.deepEqual(saved.prospects.map((item) => item.status), ["new", "new", "new"]);
  } finally {
    await server.stop();
  }
});

test("«sort leads by score» перевпорядковує чергу, і напрямок справді напрямок", async () => {
  const server = await startServer({ port: 43317, savedState: savedWith(threeLeads()) });
  try {
    const descending = await server.task({ instruction: "sort leads by score", scope: "all" });
    assert.equal(descending.action.status, "completed");
    assert.equal(descending.action.results[0].type, "sort_leads");
    const afterDesc = await server.savedState();
    assert.deepEqual(afterDesc.prospects.map((item) => item.id), ["lead-high", "lead-mid", "lead-low"]);

    const ascending = await server.task({ instruction: "sort leads by score asc", scope: "all" });
    assert.equal(ascending.action.status, "completed");
    const afterAsc = await server.savedState();
    assert.deepEqual(afterAsc.prospects.map((item) => item.id), ["lead-low", "lead-mid", "lead-high"]);
  } finally {
    await server.stop();
  }
});

test("статус пачкою переставляється й лишає подію в журналі", async () => {
  const server = await startServer({ port: 43318, savedState: savedWith(threeLeads()) });
  try {
    const { payload, action } = await server.task({ instruction: "mark all leads as follow up due", scope: "all" });
    assert.equal(action.status, "completed");
    assert.match(action.results.map((item) => item.message).join(" "), /follow_up_due/);

    const saved = await server.savedState();
    assert.deepEqual(saved.prospects.map((item) => item.status), ["follow_up_due", "follow_up_due", "follow_up_due"]);
    // Слід у журналі подій, а не лише рядок у відповіді.
    assert.ok(payload.events.some((event) => /moved to follow_up_due/.test(event.text)));
  } finally {
    await server.stop();
  }
});

test("записана взаємодія з'являється по одній на лід і підтягує статус за собою", async () => {
  const server = await startServer({ port: 43319, savedState: savedWith(threeLeads()) });
  try {
    const { action } = await server.task({ instruction: "log a linkedin reply for all leads", scope: "all" });
    assert.equal(action.status, "completed");

    const saved = await server.savedState();
    const logged = saved.interactions.filter((item) => item.type === "linkedin_reply");
    assert.equal(logged.length, 3);
    assert.deepEqual([...new Set(logged.map((item) => item.prospectId))].sort(), ["lead-high", "lead-low", "lead-mid"]);
    // Відповідь означає «відреагував» — статус їде за фактом, не окремою дією.
    assert.deepEqual(saved.prospects.map((item) => item.status), ["engaged", "engaged", "engaged"]);
  } finally {
    await server.stop();
  }
});

test("пачка, під яку не підпадає жоден лід, повертає причину, а не тихий успіх", async () => {
  const server = await startServer({ port: 43320, savedState: savedWith(threeLeads()) });
  try {
    // Жоден лід не має статусу meeting_booked, тож дія не має над чим працювати.
    const { action } = await server.task({ instruction: "mark all leads as follow up due", scope: "meeting_booked" });
    assert.equal(action.status, "blocked");
    assert.deepEqual(action.results, []);
    assert.match(action.warnings.join(" "), /No leads matched scope "meeting_booked"/);

    const saved = await server.savedState();
    assert.deepEqual(saved.prospects.map((item) => item.status), ["new", "new", "new"]);
  } finally {
    await server.stop();
  }
});
