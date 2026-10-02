import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { activeLease, coolOffUntil, decideNext, leaseAccount, resetScheduler } from "../warmup/scheduler.mjs";
import { DEFAULT_STRATEGY, dailyQuota } from "../warmup/strategy.mjs";
import { MAX_INVITES_PER_RUN } from "../warmup/invites.mjs";

/**
 * The route and the decision over a real query path.
 *
 * `anty` is pointed at a PostgREST-shaped stub in this process rather than at
 * Supabase: the filters are not what is under test here, the arithmetic and the
 * lease are, and a test that needs a database password is a test nobody runs.
 */

const rows = { wl_accounts: [], wl_runs: [], wl_day_actions: [], wl_events: [], anty_browser_profiles: [] };
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

/**
 * Today's inbox read, done. The read is owed once a day on every day of a
 * plan, so "nothing left today" has to include it. The stub hands every
 * `wl_events` row to every read of the table, which is fine here: nothing
 * else these tests ask of it is about events.
 */
function inboxReadToday(...accountIds) {
  rows.wl_events = accountIds.map((accountId) => ({
    account_id: accountId, type: "inbox.synced", created_at: new Date().toISOString(), meta: { threadsSeen: 0 }
  }));
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
  rows.wl_events = [];
  // Nothing open in Anty unless a test says so.
  rows.anty_browser_profiles = [
    { id: "profile-acc-1", status: "stopped", is_deleted: false },
    { id: "profile-acc-2", status: "stopped", is_deleted: false }
  ];
});

// The window is the operator's local clock, so the hour is fixed here rather
// than left to whenever the suite happens to run.
const insideTheWindow = () => { const at = new Date(); at.setHours(10, 0, 0, 0); return at; };

/**
 * The tests that go through the route cannot pass a time in — the route
 * reads the clock itself, which is the whole point of it. So they pin the
 * clock instead. Without this the suite is green before 13:00 and red after,
 * which is worse than having no test: it teaches people that a red run is the
 * time of day rather than a fault.
 */
function freezeInsideTheWindow(t) {
  t.mock.timers.enable({ apis: ["Date"], now: insideTheWindow().getTime() });
}

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

  // At the same moment, for two different accounts — both told something
  // true a moment ago. Each lease reads a dozen rows before it grants, so
  // both are past the first "is anybody running" before either grants; only
  // the check made again right before the grant keeps it to one.
  const answers = await Promise.all([
    leaseAccount({ accountId: "acc-1", now }),
    leaseAccount({ accountId: "acc-2", now })
  ]);
  const winners = answers.filter((answer) => answer.ok);
  assert.equal(winners.length, 1, "one account at a time, across every worker");
  const [winner] = winners;
  const loser = answers.find((answer) => !answer.ok);
  assert.ok(winner.lease.leaseId);
  assert.ok(Date.parse(winner.lease.leaseExpiresAt) > now.getTime());
  assert.equal(activeLease(now.getTime()).leaseId, winner.lease.leaseId);
  if (winner.lease.accountId === "acc-1") assert.deepEqual(winner.lease.kinds, shown.next.kinds);

  assert.equal(loser.status, 409);
  assert.equal(loser.error, `${winner.lease.label} is already running`);
  assert.ok(loser.retryAfterSeconds >= 1 && loser.retryAfterSeconds <= 900);

  // And the same account asked for again is refused the same way.
  const again = await leaseAccount({ accountId: winner.lease.accountId, now });
  assert.equal(again.error, `${winner.lease.label} is already running`);

  assert.equal(written.filter((row) => row.table === "wl_events" && row.body.type === "scheduler.started").length, 1,
    "exactly one start, written when the account was taken rather than when it was named");

  // Two workers after the same account at once: one of them, too.
  resetScheduler();
  written.length = 0;
  const same = await Promise.all([leaseAccount({ accountId: "acc-1", now }), leaseAccount({ accountId: "acc-1", now })]);
  assert.equal(same.filter((answer) => answer.ok).length, 1);
  assert.equal(same.find((answer) => !answer.ok).error, "Chloe Stewart is already running");
});

test("an account whose session just ended rests before it is handed out again", async (t) => {
  freezeInsideTheWindow(t);
  rows.wl_accounts = [account("acc-1", "Chloe Stewart")];
  rows.wl_runs = [run("acc-1", 3)];

  const handed = await leaseAccount({ accountId: "acc-1", now: insideTheWindow() });
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.lease.leaseId, ok: true }
  });

  // Views still owed, and nobody else to go instead: the answer is a wait,
  // in words that do not move, not the same profile two minutes later.
  const answer = await decideNext({ now: insideTheWindow() });
  assert.equal(answer.next, null);
  assert.equal(answer.reason, "Chloe Stewart is resting between sessions");
  assert.ok(answer.retryAfterSeconds >= 300 && answer.retryAfterSeconds <= 540);
  const refused = await leaseAccount({ accountId: "acc-1", now: insideTheWindow() });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "Chloe Stewart is resting between sessions");

  const later = new Date(insideTheWindow().getTime() + 61 * 60_000);
  t.mock.timers.setTime(later.getTime());
  assert.equal((await decideNext({ now: later })).next?.accountId, "acc-1");
});

test("the agent's plan counts every counter row of the day, not the last one read", async (t) => {
  freezeInsideTheWindow(t);
  rows.wl_accounts = [account("acc-1", "Chloe Stewart")];
  rows.wl_runs = [run("acc-1", 3)];
  const quota = dailyQuota(DEFAULT_STRATEGY, "acc-1", 3, "profile_view");
  assert.ok(quota >= 3);
  // Two writers that both found no row, each with its own count.
  rows.wl_day_actions = [
    { run_id: "run-acc-1", account_id: "acc-1", kind: "profile_view", done: 2 },
    { run_id: "run-acc-1", account_id: "acc-1", kind: "profile_view", done: 1 }
  ];
  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  const views = agent.payload.plan.find((row) => row.kind === "profile_view");
  assert.equal(views.done, 3);
  assert.equal(views.remaining, quota - 3);
});

test("an account that stopped being due between the poll and the lease is a 409, not a retry", async () => {
  const now = insideTheWindow();
  rows.wl_day_actions = [
    { account_id: "acc-1", kind: "profile_view", done: 99 },
    { account_id: "acc-1", kind: "like", done: 99 }
  ];
  inboxReadToday("acc-1");

  const outcome = await leaseAccount({ accountId: "acc-1", now });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.equal(outcome.error, "that account does not owe work right now");
  assert.ok(outcome.retryAfterSeconds >= 300 && outcome.retryAfterSeconds <= 540);
  assert.equal(activeLease(now.getTime()), null);
});

test("the poll answers 200 and the whole envelope even when nobody owes work", async (t) => {
  freezeInsideTheWindow(t);
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

test("a failed run costs that account 45 minutes and nobody else anything", async (t) => {
  freezeInsideTheWindow(t);
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

test("an account in cool-off is named, and the answer is still a normal idle wait", async (t) => {
  freezeInsideTheWindow(t);
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
  // And both inboxes read today — the one thing a finished quota still owes.
  inboxReadToday("acc-1", "acc-2");
  const answer = await decideNext({ now: insideTheWindow() });
  assert.equal(answer.next, null);
  assert.equal(answer.reason, "nothing owes work today");
  assert.ok(answer.retryAfterSeconds >= 300 && answer.retryAfterSeconds <= 540);
});

test("an agent that never reads the inbox is woken for it once a day, not all morning", async (t) => {
  freezeInsideTheWindow(t);
  rows.wl_accounts = [account("acc-1", "Chloe Stewart")];
  rows.wl_runs = [run("acc-1", 3)];
  rows.wl_day_actions = [
    { account_id: "acc-1", kind: "profile_view", done: 99 },
    { account_id: "acc-1", kind: "like", done: 99 }
  ];

  // Views done, inbox not read: today's read is the reason to open it.
  const shown = await decideNext({ now: insideTheWindow() });
  assert.equal(shown.next?.accountId, "acc-1");
  assert.equal(shown.next.remaining, 0, "the read spends no quota");
  assert.equal(shown.next.upkeep.inbox, true);

  // An older build, or broken selectors: the session finishes and never posts
  // `inbox.done`. Without a bound this account would be handed out every few
  // minutes until 13:00 to do nothing.
  const handed = await leaseAccount({ accountId: "acc-1", now: insideTheWindow() });
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.lease.leaseId, ok: true }
  });
  const after = await decideNext({ now: insideTheWindow() });
  assert.equal(after.next, null, "it had its chance at today's read");
  assert.equal(after.reason, "nothing owes work today");

  // The read is still owed, and said so whenever the account is opened.
  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(agent.payload.inbox.due, true);
});

test("the route takes the account only on the POST", async (t) => {
  freezeInsideTheWindow(t);
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

test("in working mode an account that sent one run's worth is handed out again the same day", async (t) => {
  freezeInsideTheWindow(t);
  // A day on which acc-1 is dealt more requests than one run can carry.
  let day = 15;
  while (dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "connect") <= MAX_INVITES_PER_RUN) day += 1;
  const quota = dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "connect");

  rows.wl_accounts = [account("acc-1", "Chloe Stewart")];
  rows.wl_runs = [run("acc-1", day)];
  // This morning's run did its views and likes and sent the ten it was handed.
  rows.wl_day_actions = [
    { account_id: "acc-1", kind: "profile_view", done: 99 },
    { account_id: "acc-1", kind: "like", done: 99 },
    { account_id: "acc-1", kind: "connect", done: MAX_INVITES_PER_RUN }
  ];
  rows.wl_outreach = Array.from({ length: 8 }, (_, index) => ({ id: `o-${index}`, account_id: "acc-1", status: "waiting" }));
  t.after(() => { delete rows.wl_outreach; });

  const answer = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(answer.payload.next.accountId, "acc-1", "the rest of today's allowance is a reason to open it again");
  assert.equal(answer.payload.next.mode, "working");
  assert.deepEqual(answer.payload.next.kinds, ["connect"]);
  assert.equal(answer.payload.next.invites, quota - MAX_INVITES_PER_RUN, "the rest, and no more");
  assert.equal(answer.payload.next.day, day);

  const taken = await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId: "acc-1" } });
  assert.equal(taken.payload.lease.mode, "working");
  const started = written.findLast((row) => row.table === "wl_events").body;
  assert.match(started.message, /working mode, day/);
});

test("the agent's plan keeps two views for the second session, exactly as the poll counts them", async (t) => {
  freezeInsideTheWindow(t);
  // A working-mode day on which acc-1 is dealt more requests than one run carries.
  let day = 15;
  while (dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "connect") <= MAX_INVITES_PER_RUN) day += 1;
  const views = dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "profile_view");
  const likes = dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "like");
  const quota = dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "connect");
  assert.ok(views >= 4);
  rows.wl_accounts = [account("acc-1", "Chloe Stewart")];
  rows.wl_runs = [run("acc-1", day)];
  inboxReadToday("acc-1");
  // People for the whole day's allowance: more than one run, so a second session is coming.
  rows.wl_outreach = Array.from({ length: quota }, (_, index) => ({ id: `o-${index}`, account_id: "acc-1", status: "waiting" }));
  t.after(() => { delete rows.wl_outreach; });
  const viewsRow = async () => (await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" }))
    .payload.plan.find((row) => row.kind === "profile_view");

  // The first session: two views wait, and the poll does not count them either.
  const first = await viewsRow();
  assert.equal(first.quota, views, "the day's figure is still the day's figure");
  assert.equal(first.heldBack, 2);
  assert.equal(first.remaining, views - 2);
  const shown = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(shown.payload.next.remaining, views - 2 + likes + quota);

  // Its views and likes done and nothing sent yet: the two are the next
  // session's now, whatever is still to send — it starts on them.
  rows.wl_day_actions = [
    { run_id: "run-acc-1", account_id: "acc-1", kind: "profile_view", done: views - 2 },
    { run_id: "run-acc-1", account_id: "acc-1", kind: "like", done: likes }
  ];
  const second = await viewsRow();
  assert.equal(second.heldBack, 0);
  assert.equal(second.remaining, 2);
  const again = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.deepEqual(again.payload.next?.kinds, ["profile_view", "connect"]);
  assert.equal(again.payload.next.remaining, 2 + quota);

  // People for one run only: one session sends them all, so nothing is kept
  // back and nothing wakes the account again for two views.
  rows.wl_outreach = rows.wl_outreach.slice(0, 7);
  rows.wl_day_actions = [];
  const alone = await viewsRow();
  assert.equal(alone.heldBack, 0);
  assert.equal(alone.remaining, views);
  const once = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(once.payload.next.remaining, views + likes + 7);
});

test("people beyond the connects left today keep no views back: one session sends all the day has left", async (t) => {
  freezeInsideTheWindow(t);
  // Fourteen requests allowed today, five of them already sent by a seller by
  // hand, and fifteen people waiting: nine can still go, one run's worth.
  let day = 15;
  while (dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "connect") !== 14) day += 1;
  const views = dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "profile_view");
  const likes = dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "like");
  assert.ok(views >= 4);
  rows.wl_accounts = [account("acc-1", "Chloe Stewart")];
  rows.wl_runs = [run("acc-1", day)];
  inboxReadToday("acc-1");
  rows.wl_day_actions = [{ run_id: "run-acc-1", account_id: "acc-1", kind: "connect", done: 5 }];
  rows.wl_outreach = Array.from({ length: 15 }, (_, index) => ({ id: `o-${index}`, account_id: "acc-1", status: "waiting" }));
  t.after(() => { delete rows.wl_outreach; });

  const plan = (await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" })).payload.plan;
  const viewsRow = plan.find((row) => row.kind === "profile_view");
  assert.equal(viewsRow.heldBack, 0, "no second session is coming for requests");
  assert.equal(viewsRow.remaining, views);
  const first = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.deepEqual(first.payload.next.kinds, ["profile_view", "like", "connect"]);
  assert.equal(first.payload.next.invites, 14 - 5);
  assert.equal(first.payload.next.remaining, views + likes + 14 - 5, "the poll counts every view too");

  // The session does what its plan said and sends the nine: nothing wakes
  // the account again today for two views.
  rows.wl_day_actions = [
    { run_id: "run-acc-1", account_id: "acc-1", kind: "profile_view", done: viewsRow.remaining },
    { run_id: "run-acc-1", account_id: "acc-1", kind: "like", done: likes },
    { run_id: "run-acc-1", account_id: "acc-1", kind: "connect", done: 14 }
  ];
  rows.wl_outreach = rows.wl_outreach.slice(0, 6);
  const after = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(after.payload.next?.kinds.includes("profile_view") ?? false, false);
  assert.equal(after.payload.next?.remaining ?? 0, 0);
});

test("a failed run is handed out again when its cool-off ends, and its log line says that wait", async (t) => {
  freezeInsideTheWindow(t);
  process.env.WARMUP_COOL_OFF_MINUTES = "15";
  t.after(() => { delete process.env.WARMUP_COOL_OFF_MINUTES; });
  rows.wl_accounts = [account("acc-1", "Chloe Stewart")];
  rows.wl_runs = [run("acc-1", 3)];

  const handed = await leaseAccount({ accountId: "acc-1", now: insideTheWindow() });
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "run.finished", accountId: "acc-1", leaseId: handed.lease.leaseId, ok: false, note: "proxy down" }
  });
  const event = written.findLast((row) => row.table === "wl_events").body;
  assert.equal(event.type, "scheduler.finished");
  assert.match(event.message, /not handed out again for 15 min/);
  assert.equal(event.meta.coolOffMinutes, 15);

  const cooling = await decideNext({ now: new Date(insideTheWindow().getTime() + 14 * 60_000) });
  assert.equal(cooling.reason, "Chloe Stewart is in cool-off");
  const later = new Date(insideTheWindow().getTime() + 16 * 60_000);
  t.mock.timers.setTime(later.getTime());
  const back = await decideNext({ now: later });
  assert.equal(back.next?.accountId, "acc-1", "the fifteen minutes the line promised, not the hour a finished session rests");
});
