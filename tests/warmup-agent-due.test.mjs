import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { activeLease, coolOffUntil, decideNext, leaseAccount, resetScheduler } from "../warmup/scheduler.mjs";
import { DEFAULT_STRATEGY } from "../warmup/strategy.mjs";

/**
 * The route and the decision over a real query path.
 *
 * `anty` is pointed at a PostgREST-shaped stub in this process rather than at
 * Supabase: the filters are not what is under test here, the arithmetic and the
 * lease are, and a test that needs a database password is a test nobody runs.
 */

const rows = { wl_accounts: [], wl_runs: [], wl_day_actions: [], anty_browser_profiles: [] };
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
  // Nothing open in Anty unless a test says so.
  rows.anty_browser_profiles = [
    { id: "profile-acc-1", status: "stopped", is_deleted: false },
    { id: "profile-acc-2", status: "stopped", is_deleted: false }
  ];
});

// The window is the operator's local clock, so the hour is fixed here rather
// than left to whenever the suite happens to run.
const insideTheWindow = () => { const at = new Date(); at.setHours(10, 0, 0, 0); return at; };

test("asking who is next takes nothing, however often it is asked", async () => {
  const now = insideTheWindow();

  const first = await decideNext({ now });
  assert.equal(first.next.accountId, "acc-1", "the older run goes first");
  assert.equal(first.next.label, "Chloe Stewart");
  assert.equal(first.next.profileRemoteId, "profile-acc-1");
  assert.equal(first.reason, null);
  assert.ok(first.next.remaining > 0);
  assert.equal(first.next.leaseId, null, "a GET is a question, not a claim");
  assert.equal(first.next.leaseExpiresAt, null);

  // A monitor, a curl, a tab left open: none of it costs an account a morning.
  for (let index = 0; index < 5; index += 1) await decideNext({ now });
  assert.equal(activeLease(now.getTime()), null);
  assert.equal(written.filter((row) => row.table === "wl_events").length, 0, "and none of it is a start, so none of it is logged as one");

  const second = await decideNext({ now: new Date(now.getTime() + 1000) });
  assert.equal(second.next.accountId, "acc-1", "the same answer, because nothing has been taken");
});

test("two workers racing: one takes it, the loser is told who and when", async () => {
  const now = insideTheWindow();
  const shown = await decideNext({ now });

  const winner = await leaseAccount({ accountId: shown.next.accountId, now });
  assert.equal(winner.ok, true);
  assert.ok(winner.lease.leaseId);
  assert.ok(Date.parse(winner.lease.leaseExpiresAt) > now.getTime());
  assert.equal(winner.lease.accountId, "acc-1");
  assert.deepEqual(winner.lease.kinds, shown.next.kinds);

  const loser = await leaseAccount({ accountId: "acc-1", now });
  assert.equal(loser.ok, false);
  assert.equal(loser.status, 409);
  assert.equal(loser.error, "Chloe Stewart is already running");
  assert.ok(loser.retryAfterSeconds >= 1 && loser.retryAfterSeconds <= 900);

  // And the other account is refused too — one account runs at a time.
  const other = await leaseAccount({ accountId: "acc-2", now });
  assert.equal(other.error, "Chloe Stewart is already running");

  assert.equal(written.filter((row) => row.table === "wl_events" && row.body.type === "scheduler.started").length, 1,
    "exactly one start, written when the account was taken rather than when it was named");
});

test("an account that stopped being due between the poll and the lease is a 409, not a retry", async () => {
  const now = insideTheWindow();
  rows.wl_day_actions = [
    { account_id: "acc-1", kind: "profile_view", done: 99 },
    { account_id: "acc-1", kind: "like", done: 99 }
  ];

  const outcome = await leaseAccount({ accountId: "acc-1", now });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.equal(outcome.error, "that account does not owe work right now");
  assert.ok(outcome.retryAfterSeconds >= 300 && outcome.retryAfterSeconds <= 540);
  assert.equal(activeLease(now.getTime()), null);
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
  const handed = await leaseAccount({ accountId: "acc-1", now: insideTheWindow() });
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.lease.leaseId, ok: true }
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
  const handed = await leaseAccount({ accountId: "acc-1", now: insideTheWindow() });
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.lease.leaseId, ok: false, note: "Anty would not start" }
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

  const handed = await leaseAccount({ accountId: "acc-1", now: insideTheWindow() });
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.lease.leaseId, ok: false }
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

test("the route takes the account only on the POST", async () => {
  const shown = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(shown.status, 200);
  assert.equal(shown.payload.next.leaseId, null);
  assert.equal(activeLease(Date.now()), null);

  const taken = await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId: "acc-1" } });
  assert.equal(taken.status, 200);
  assert.equal(taken.payload.success, true);
  assert.equal(taken.payload.lease.accountId, "acc-1");
  assert.ok(taken.payload.lease.leaseId);

  const refused = await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId: "acc-2" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.payload.success, false);
  assert.equal(refused.payload.error, refused.payload.reason, "the sentence the worker logs and the sentence it reads are one");
  assert.ok(refused.payload.retryAfterSeconds >= 1);

  const unknown = await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId: "acc-nobody" } });
  assert.equal(unknown.status, 404);

  const malformed = await call({ method: "POST", path: "/api/warmup/agent/lease", body: null });
  assert.equal(malformed.status, 400);
});

test("no wait ever exceeds the 900 seconds the worker was promised", async () => {
  process.env.WARMUP_LEASE_MINUTES = "60";
  try {
    const now = insideTheWindow();
    await leaseAccount({ accountId: "acc-1", now });
    const answer = await decideNext({ now });
    assert.match(answer.reason, /is already running/);
    assert.equal(answer.retryAfterSeconds, 900, "a lease somebody lengthened must not lengthen the worker's sleep");
  } finally {
    delete process.env.WARMUP_LEASE_MINUTES;
  }
});

// ── the launcher that does not ask ────────────────────────────────────────

test("a profile Anty already has open is not handed out, whatever it owes", async () => {
  const now = insideTheWindow();
  rows.anty_browser_profiles = [
    { id: "profile-acc-1", status: "running", is_deleted: false },
    { id: "profile-acc-2", status: "stopped", is_deleted: false }
  ];

  // A lease covers the workers that ask. This is the one that does not: a second
  // scheduler on the old build, or a person who opened the profile by hand.
  const answer = await decideNext({ now });
  assert.equal(answer.next.accountId, "acc-2", "the busy one is skipped, the next one is still offered");

  const refused = await leaseAccount({ accountId: "acc-1", now });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal(refused.error, "Chloe Stewart already has its profile open");
  assert.equal(activeLease(now.getTime()), null);
});

test("every profile open means nobody is due, and the answer says which", async () => {
  const now = insideTheWindow();
  rows.anty_browser_profiles = [
    { id: "profile-acc-1", status: "running", is_deleted: false },
    { id: "profile-acc-2", status: "running", is_deleted: false }
  ];
  const answer = await decideNext({ now });
  assert.equal(answer.next, null);
  assert.equal(answer.reason, "Chloe Stewart already has its profile open");
  assert.ok(answer.retryAfterSeconds >= 300 && answer.retryAfterSeconds <= 540);
});

test("a deleted profile carries a stale status and is not open anywhere", async () => {
  const now = insideTheWindow();
  rows.anty_browser_profiles = [
    { id: "profile-acc-1", status: "running", is_deleted: true },
    { id: "profile-acc-2", status: "stopped", is_deleted: false }
  ];
  assert.equal((await decideNext({ now })).next.accountId, "acc-1");
});
