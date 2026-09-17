import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { activeLease, coolOffUntil, decideNext, resetScheduler } from "../warmup/scheduler.mjs";
import { DEFAULT_STRATEGY } from "../warmup/strategy.mjs";

/**
 * The route and the decision over a real query path.
 *
 * `anty` is pointed at a PostgREST-shaped stub in this process rather than at
 * Supabase: the filters are not what is under test here, the arithmetic and the
 * lease are, and a test that needs a database password is a test nobody runs.
 */

const rows = { wl_accounts: [], wl_runs: [], wl_day_actions: [] };
const written = [];
let stub;
let previousEnv;

/** The time `currentDay` is measured against is the real one, so day 2 is yesterday. */
function startedForDay(day) {
  const started = new Date();
  started.setUTCDate(started.getUTCDate() - (day - 1));
  started.setUTCHours(8, 0, 0, 0);
  return started.toISOString();
}

function account(id, label) {
  return { id, label, login: `${id}@example.com`, profile_remote_id: `profile-${id}`, status: "warming", health: "ok" };
}

function run(accountId, day) {
  return {
    id: `run-${accountId}`, account_id: accountId, state: "running", started_at: startedForDay(day),
    paused_days: 0, paused_until: null, strategy_snapshot: DEFAULT_STRATEGY
  };
}

/** One route call, with the request and response the server would have handed over. */
async function call({ method, path, body = null }) {
  let captured = null;
  await handleWarmupApi({
    request: { method, headers: {} },
    response: {},
    url: new URL(`http://127.0.0.1${path}`),
    sendJson: (_response, status, payload) => { captured = { status, payload }; },
    readJson: async () => body,
    campaigns: { read: () => [], readTargeting: () => null, write: async () => {} }
  });
  return captured;
}

test.before(async () => {
  stub = createServer((request, response) => {
    const [route, query] = request.url.split("?");
    const table = route.replace("/rest/v1/", "");
    if (request.method === "GET") {
      // Only `id=eq.` is honoured, because only one caller depends on a filter
      // rather than on the fixture: looking up an account that does not exist.
      const wanted = new URLSearchParams(query || "").get("id");
      const found = (rows[table] ?? []).filter((row) => !wanted?.startsWith("eq.") || row.id === wanted.slice(3));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(found));
      return;
    }
    let payload = "";
    request.on("data", (chunk) => { payload += chunk; });
    request.on("end", () => {
      written.push({ table, body: payload ? JSON.parse(payload) : null });
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end("[]");
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));

  previousEnv = { url: process.env.ANTY_SUPABASE_URL, key: process.env.ANTY_SERVICE_ROLE_KEY };
  process.env.ANTY_SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.ANTY_SERVICE_ROLE_KEY = "stub-key";
});

test.after(async () => {
  process.env.ANTY_SUPABASE_URL = previousEnv.url ?? "";
  process.env.ANTY_SERVICE_ROLE_KEY = previousEnv.key ?? "";
  await new Promise((resolve) => stub.close(resolve));
});

test.beforeEach(() => {
  resetScheduler();
  written.length = 0;
  delete process.env.WARMUP_SCHEDULER_DISABLED;
  rows.wl_accounts = [account("acc-1", "Chloe Stewart"), account("acc-2", "Dan Moreau")];
  rows.wl_runs = [run("acc-1", 3), run("acc-2", 2)];
  rows.wl_day_actions = [];
});

// The window is the operator's local clock, so the hour is fixed here rather
// than left to whenever the suite happens to run.
const insideTheWindow = () => { const at = new Date(); at.setHours(10, 0, 0, 0); return at; };

test("two polls in a row never hand out the same account twice", async () => {
  const now = insideTheWindow();

  const first = await decideNext({ now });
  assert.equal(first.next.accountId, "acc-1", "the older run goes first");
  assert.equal(first.next.label, "Chloe Stewart");
  assert.equal(first.next.profileRemoteId, "profile-acc-1");
  assert.equal(first.reason, null);
  assert.ok(first.next.remaining > 0);
  assert.ok(Date.parse(first.next.leaseExpiresAt) > now.getTime());

  const second = await decideNext({ now: new Date(now.getTime() + 1000) });
  assert.equal(second.next, null, "acc-2 is not handed out either — one account runs at a time");
  assert.equal(second.reason, "Chloe Stewart is already running");
  assert.ok(second.retryAfterSeconds > 0 && second.retryAfterSeconds <= 25 * 60);

  assert.equal(written.filter((row) => row.table === "wl_events" && row.body.type === "scheduler.started").length, 1);
});

test("the poll answers 200 and the whole envelope even when nobody owes work", async () => {
  process.env.WARMUP_SCHEDULER_DISABLED = "1";
  const answer = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.payload).sort(), ["next", "reason", "retryAfterSeconds", "success", "window"]);
  assert.equal(answer.payload.next, null);
  assert.equal(answer.payload.reason, "the scheduler is switched off on this deployment");
  assert.equal(answer.payload.retryAfterSeconds, 900);
  assert.equal(answer.payload.window.label, "09:00–13:00");
});

test("a finished run gives the lease back and is told when to come again", async () => {
  const handed = await decideNext({ now: insideTheWindow() });
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.next.leaseId, ok: true }
  });

  assert.equal(answer.status, 200);
  assert.equal(answer.payload.success, true);
  assert.equal(answer.payload.released, true);
  assert.ok(answer.payload.nextInSeconds >= 120 && answer.payload.nextInSeconds <= 420);
  assert.equal(activeLease(Date.now()), null);
  assert.equal(coolOffUntil("acc-1"), 0, "a run that worked is not punished");

  const event = written.findLast((row) => row.table === "wl_events").body;
  assert.equal(event.type, "scheduler.finished");
  assert.equal(event.level, "info");
});

test("a failed run costs that account 45 minutes and nobody else anything", async () => {
  const handed = await decideNext({ now: insideTheWindow() });
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.next.leaseId, ok: false, note: "Anty would not start" }
  });

  assert.ok(answer.payload.nextInSeconds >= 120 && answer.payload.nextInSeconds <= 420,
    "the cool-off is about the account, not about the Mac — the worker comes back at the usual gap");
  assert.ok(coolOffUntil("acc-1") > Date.now() + 44 * 60_000);

  const event = written.findLast((row) => row.table === "wl_events").body;
  assert.equal(event.level, "warn");
  assert.match(event.message, /Anty would not start/);

  // And the next poll goes to the other account rather than idling.
  const next = await decideNext({ now: insideTheWindow() });
  assert.equal(next.next.accountId, "acc-2");
});

test("a run.finished whose lease has already gone is accepted, not refused", async () => {
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: "a-lease-that-expired-mid-run", ok: false }
  });

  assert.equal(answer.status, 200, "the run happened either way, and the report is worth more than the bookkeeping");
  assert.equal(answer.payload.released, false);
  assert.ok(answer.payload.nextInSeconds >= 120);
  assert.ok(coolOffUntil("acc-1") > Date.now(), "the cool-off still lands — that is the part worth saving");
});

test("a run.finished for an account nobody knows is the one real refusal", async () => {
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-nobody", ok: true }
  });
  assert.equal(answer.status, 404);
});

test("an account in cool-off is named, and the answer is still a normal idle wait", async () => {
  rows.wl_accounts = [account("acc-1", "Chloe Stewart")];
  rows.wl_runs = [run("acc-1", 3)];

  const handed = await decideNext({ now: insideTheWindow() });
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.next.leaseId, ok: false }
  });

  const answer = await decideNext({ now: insideTheWindow() });
  assert.equal(answer.next, null);
  assert.equal(answer.reason, "Chloe Stewart is in cool-off");
  assert.ok(answer.retryAfterSeconds >= 300 && answer.retryAfterSeconds <= 540);
});

test("nothing left in today's quota reads as nothing owing, not as a fault", async () => {
  rows.wl_day_actions = [
    { account_id: "acc-1", kind: "profile_view", done: 99 },
    { account_id: "acc-1", kind: "like", done: 99 },
    { account_id: "acc-2", kind: "profile_view", done: 99 },
    { account_id: "acc-2", kind: "like", done: 99 }
  ];
  const answer = await decideNext({ now: insideTheWindow() });
  assert.equal(answer.next, null);
  assert.equal(answer.reason, "nothing owes work today");
  assert.ok(answer.retryAfterSeconds >= 300 && answer.retryAfterSeconds <= 540);
});
