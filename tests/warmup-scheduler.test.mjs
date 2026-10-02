import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_KINDS, VIEWS_HELD_BACK, activeLease, coolOffUntil, decideNext, dueFrom, finishRun, gapSeconds, grantLease,
  leaseMinutes, releaseLease, resetScheduler, restingUntil, sameDayGapMinutes, secondsUntilWindowOpens, startCoolOff,
  sweepLeases, upkeepFor, viewsHeldBack
} from "../warmup/scheduler.mjs";
import { DEFAULT_STRATEGY, dailyQuota } from "../warmup/strategy.mjs";
import { MAX_INVITES_PER_RUN } from "../warmup/invites.mjs";
import { SESSION_WINDOW, windowLabel } from "../warmup/schedule.mjs";

const TODAY = "2026-09-17";

function account(id, overrides = {}) {
  return { id, label: `Account ${id}`, profile_remote_id: `profile-${id}`, status: "warming", health: "ok", ...overrides };
}

function run(accountId, { startedAt = "2026-09-16T08:00:00.000Z", ...overrides } = {}) {
  return {
    id: `run-${accountId}`,
    account_id: accountId,
    state: "running",
    started_at: startedAt,
    paused_days: 0,
    paused_until: null,
    strategy_snapshot: DEFAULT_STRATEGY,
    ...overrides
  };
}

/** Today's counters, filled to the quota so an account has nothing left. */
function complete(accountId, day) {
  return AGENT_KINDS.map((kind) => ({
    account_id: accountId,
    kind,
    done: dailyQuota(DEFAULT_STRATEGY, accountId, day, kind)
  }));
}

/** `currentDay` counts from the start date, so day 2 is yesterday's start. */
const startedForDay = (day, now) => {
  const started = new Date(now);
  started.setUTCDate(started.getUTCDate() - (day - 1));
  return started.toISOString();
};

test.beforeEach(() => {
  resetScheduler();
  delete process.env.WARMUP_LEASE_MINUTES;
  delete process.env.WARMUP_COOL_OFF_MINUTES;
  delete process.env.WARMUP_SAME_DAY_GAP_MINUTES;
  delete process.env.WARMUP_SCHEDULER_DISABLED;
});

// ── who is due ────────────────────────────────────────────────────────────

test("an account warming inside its plan with quota left is due", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const { ready } = dueFrom({
    accounts: [account("a")],
    runs: [run("a", { startedAt: startedForDay(2, now) })],
    dayActions: [],
    todayIso: TODAY,
    nowMs: now.getTime()
  });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].day, 2);
  assert.ok(ready[0].remaining > 0);
  assert.deepEqual(ready[0].kinds, ["profile_view"], "day 2 is views only, and a kind with no quota is not offered");
});

test("a finished quota is 'nothing owes work', not an account handed out to do nothing", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const { ready, held } = dueFrom({
    accounts: [account("a")],
    runs: [run("a", { startedAt: startedForDay(2, now) })],
    dayActions: complete("a", 2),
    // The day's inbox read is work too; done here, so nothing is left.
    inboxSyncedToday: new Set(["a"]),
    todayIso: TODAY,
    nowMs: now.getTime()
  });
  assert.equal(ready.length, 0);
  assert.equal(held.length, 0);
});

test("the inbox is read once a day on every day of the plan, and not while a pause holds", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  // Day 2, views done: the only thing left is today's read.
  const rows = {
    accounts: [account("a")],
    runs: [run("a", { startedAt: startedForDay(2, now) })],
    dayActions: complete("a", 2),
    todayIso: TODAY,
    nowMs: now.getTime()
  };

  const { ready } = dueFrom(rows);
  assert.equal(ready.length, 1, "not read today is a reason to open the browser, inside the plan too");
  assert.equal(ready[0].remaining, 0, "and it spends no quota");
  assert.equal(ready[0].upkeep.inbox, true);
  assert.deepEqual(ready[0].kinds, []);

  assert.equal(dueFrom({ ...rows, inboxSyncedToday: new Set(["a"]) }).ready.length, 0, "once read, done for the day");

  // Working mode reads it the same way.
  const working = dueFrom({ ...rows, runs: [run("a", { startedAt: startedForDay(30, now) })], dayActions: complete("a", 30) });
  assert.equal(working.ready[0]?.upkeep.inbox, true);
  assert.equal(working.ready[0]?.mode, "working");

  // A pause is nothing at all, the inbox included.
  const paused = dueFrom({ ...rows, runs: [run("a", { startedAt: startedForDay(2, now), state: "paused", paused_until: TODAY })] });
  assert.equal(paused.ready.length + paused.held.length + paused.busy.length, 0);

  // And the semaphore says the same thing the scheduler woke it for.
  assert.equal(upkeepFor({ accountId: "a", inPlan: true }).inbox, true);
  assert.equal(upkeepFor({ accountId: "a", inPlan: true, inboxSyncedToday: new Set(["a"]) }).inbox, false);
});

test("no run and a pause that covers today take an account out; a pause that ran out does not", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  const { ready, held, busy } = dueFrom({
    accounts: [account("a"), account("b", { status: "restricted" })],
    runs: [
      // "a" has no live run at all.
      run("b", { startedAt: startedForDay(10, now), state: "paused", paused_days: 2, paused_until: TODAY })
    ],
    dayActions: [],
    pendingInvites: new Map([["a", 3], ["b", 3]]),
    todayIso: TODAY,
    nowMs
  });
  assert.equal(ready.length + held.length + busy.length, 0, "not due, not held, not busy — not there at all");

  // What a warning leaves behind, the day after its last paused date: due
  // again on its own, on the day the count says, with nobody having written
  // anything back.
  const warned = { startedAt: startedForDay(10, now), state: "paused", paused_days: 2 };
  const back = dueFrom({
    accounts: [account("b", { status: "restricted" })],
    runs: [run("b", { ...warned, paused_until: "2026-09-16" })],
    dayActions: [],
    todayIso: TODAY,
    nowMs
  });
  assert.equal(back.ready.length, 1);
  assert.equal(back.ready[0].day, 8, "ten days in, less the two it sat out");

  // The same row left standing for four more days by the old code, which
  // never wrote a pause back: the days nobody took it are not progress. It
  // comes back on the day after its warning day, which was day 3.
  const stalled = dueFrom({
    accounts: [account("b", { status: "restricted" })],
    runs: [run("b", { ...warned, paused_until: "2026-09-12" })],
    dayActions: [],
    todayIso: TODAY,
    nowMs
  });
  assert.equal(stalled.ready[0]?.day, 4);
  assert.equal(stalled.ready[0].mode, "warmup");
});

test("invitations are checked once a day, not every time the account is looked at", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  // Working mode, today's views and likes done, the inbox read, nobody to
  // invite: the four sent invitations are the only thing left.
  const rows = {
    accounts: [account("c")],
    runs: [run("c", { startedAt: startedForDay(20, now) })],
    dayActions: complete("c", 20),
    pendingInvites: new Map([["c", 4]]),
    inboxSyncedToday: new Set(["c"]),
    todayIso: TODAY,
    nowMs: now.getTime()
  };

  const { ready } = dueFrom(rows);
  assert.equal(ready.length, 1, "an account holding sent invitations is opened to look at them");
  assert.equal(ready[0].remaining, 0, "which spends no quota");
  assert.equal(ready[0].upkeep.checks, 4);
  assert.deepEqual(ready[0].kinds, []);

  // Once they were checked today, a second poll finds nothing owing.
  const again = dueFrom({ ...rows, checkedToday: new Set(["c"]) });
  assert.equal(again.ready.length, 0);
  assert.equal(again.held.length, 0);
});

test("duplicate counters for one day are summed, and a stopped run's are not this run's", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const id = "dup";
  const quota = dailyQuota(DEFAULT_STRATEGY, id, 8, "connect");
  assert.ok(quota >= 2, "day 8 allows a few requests");
  const rows = {
    accounts: [account(id)],
    runs: [run(id, { startedAt: startedForDay(8, now) })],
    invitesWaiting: new Map([[id, 5]]),
    inboxSyncedToday: new Set([id]),
    todayIso: TODAY,
    nowMs: now.getTime()
  };
  const views = complete(id, 8).map((row) => ({ ...row, run_id: `run-${id}` }));

  // Two writers that both found no row each inserted one; the day's requests
  // are all spent between them. Read last-row-wins, the second row alone left
  // "connects" to wake the account for, all morning, with nothing to send.
  const spent = dueFrom({
    ...rows,
    dayActions: [
      ...views,
      { account_id: id, run_id: `run-${id}`, kind: "connect", done: quota - 1 },
      { account_id: id, run_id: `run-${id}`, kind: "connect", done: 1 }
    ]
  });
  assert.equal(spent.ready.length, 0, "the sum is the day's total");

  // A row the account's previous run left today counts for nothing here.
  const other = dueFrom({
    ...rows,
    dayActions: [...views, { account_id: id, run_id: "run-stopped-this-morning", kind: "connect", done: quota }]
  });
  assert.equal(other.ready[0]?.invites, quota);
});

test("out of plan, an account that approached nobody is left alone", () => {
  // Out of plan is no longer reachable from a real strategy — past the last
  // phase is working mode — so the rule is asked of `upkeepFor` directly, the
  // function both the scheduler and the semaphore answer with.
  const outOfPlan = { accountId: "c", inPlan: false };

  // Nothing sent, nothing waiting, nobody who could have written. "We have not
  // read the inbox today" is a statement about us, not evidence that there is
  // anything to read — and this account would otherwise open a browser every
  // morning, forever, to find an empty one.
  assert.equal(upkeepFor(outOfPlan).any, false);

  // One open conversation is the evidence, and then it is worth opening.
  const upkeep = upkeepFor({ ...outOfPlan, openConversations: new Map([["c", 1]]) });
  assert.equal(upkeep.inbox, true);
  assert.equal(upkeep.any, true);
  assert.equal(upkeep.checks, 0, "nothing is awaiting an answer — this is only about reading");
});

test("an account with a plan to follow goes before one that only needs looking after", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const { ready } = dueFrom({
    accounts: [account("older"), account("newer")],
    runs: [
      // The upkeep-only account has the older run, so without the rule it wins.
      run("older", { startedAt: startedForDay(20, now) }),
      run("newer", { startedAt: startedForDay(2, now) })
    ],
    // "older" is in working mode with today's quota already done.
    dayActions: complete("older", 20),
    pendingInvites: new Map([["older", 2]]),
    todayIso: TODAY,
    nowMs: now.getTime()
  });

  // One account runs at a time inside a four-hour window. Upkeep keeps until
  // tomorrow; a day of a plan does not.
  assert.equal(ready[0].account.id, "newer");
  assert.ok(ready[0].remaining > 0);
  assert.equal(ready[1].account.id, "older");
});

// ── working mode ──────────────────────────────────────────────────────────

/** An account whose working-mode request quota on `day` is more than one run hands over. */
function accountDealtMoreThanOneRun(day) {
  for (let index = 0; index < 200; index += 1) {
    const id = `w-${index}`;
    if (dailyQuota(DEFAULT_STRATEGY, id, day, "connect") > MAX_INVITES_PER_RUN) return id;
  }
  throw new Error("no account draws more than one run's worth — the working-mode range has changed");
}

test("past the last phase an account works: views, likes and requests at the working rate", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const { ready } = dueFrom({
    accounts: [account("w")],
    runs: [run("w", { startedAt: startedForDay(20, now) })],
    dayActions: [],
    invitesWaiting: new Map([["w", 40]]),
    todayIso: TODAY,
    nowMs: now.getTime()
  });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].day, 20);
  assert.equal(ready[0].mode, "working");
  assert.deepEqual(ready[0].kinds, ["profile_view", "like", "connect"]);
  const quota = dailyQuota(DEFAULT_STRATEGY, "w", 20, "connect");
  assert.ok(quota >= 10 && quota <= 15, `drew ${quota}`);
  assert.equal(ready[0].invites, quota, "forty waiting, but only today's allowance is owed");
});

test("an account that sent one run's worth is woken again the same day while its allowance lasts", () => {
  // A run hands over at most ten; working mode allows up to fifteen. Without a
  // second session the top of the range is never reached.
  assert.ok(MAX_INVITES_PER_RUN < DEFAULT_STRATEGY.workingMode.quotas.connect[1]);
  const now = new Date("2026-09-17T10:00:00.000Z");
  const id = accountDealtMoreThanOneRun(20);
  const quota = dailyQuota(DEFAULT_STRATEGY, id, 20, "connect");
  const afterFirstRun = [
    ...complete(id, 20),
    { account_id: id, kind: "connect", done: MAX_INVITES_PER_RUN }
  ];
  const rows = {
    accounts: [account(id)],
    runs: [run(id, { startedAt: startedForDay(20, now) })],
    invitesWaiting: new Map([[id, 8]]),
    // The first run read the inbox, as a run does when it is owed.
    inboxSyncedToday: new Set([id]),
    todayIso: TODAY,
    nowMs: now.getTime()
  };

  const { ready } = dueFrom({ ...rows, dayActions: afterFirstRun });
  assert.equal(ready.length, 1, "views and likes are done, the requests are not");
  assert.deepEqual(ready[0].kinds, ["connect"]);
  assert.equal(ready[0].invites, quota - MAX_INVITES_PER_RUN, "exactly the rest of today's allowance");
  assert.equal(ready[0].remaining, quota - MAX_INVITES_PER_RUN);

  // And once the day's allowance is spent, eight still waiting is tomorrow's work.
  const spent = dueFrom({ ...rows, dayActions: [...complete(id, 20), { account_id: id, kind: "connect", done: quota }] });
  assert.equal(spent.ready.length, 0);

  // A run started before working mode existed behaves the same, unrestarted.
  const legacy = { name: DEFAULT_STRATEGY.name, phases: DEFAULT_STRATEGY.phases, pauseDays: 2 };
  const old = dueFrom({
    ...rows,
    runs: [run(id, { startedAt: startedForDay(20, now), strategy_snapshot: legacy })],
    dayActions: afterFirstRun
  });
  assert.equal(old.ready[0]?.invites, quota - MAX_INVITES_PER_RUN);
});

test("a day with more requests than one run keeps two views for the session that sends the rest", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const id = accountDealtMoreThanOneRun(20);
  const views = dailyQuota(DEFAULT_STRATEGY, id, 20, "profile_view");
  const likes = dailyQuota(DEFAULT_STRATEGY, id, 20, "like");
  const quota = dailyQuota(DEFAULT_STRATEGY, id, 20, "connect");
  assert.ok(views >= 4 && quota > MAX_INVITES_PER_RUN);
  const rows = {
    accounts: [account(id)],
    runs: [run(id, { startedAt: startedForDay(20, now) })],
    invitesWaiting: new Map([[id, quota]]),
    inboxSyncedToday: new Set([id]),
    todayIso: TODAY,
    nowMs: now.getTime()
  };

  // The first session: two views are not its work.
  const first = dueFrom({ ...rows, dayActions: [] }).ready[0];
  assert.deepEqual(first.kinds, ["profile_view", "like", "connect"]);
  assert.equal(first.remaining, views - VIEWS_HELD_BACK + likes + quota);

  // It did everything it was handed. What is left fits in one run, so the
  // session that sends it starts on the two views — not on a Connect.
  const afterFirst = [
    { account_id: id, kind: "profile_view", done: views - VIEWS_HELD_BACK },
    { account_id: id, kind: "like", done: likes },
    { account_id: id, kind: "connect", done: MAX_INVITES_PER_RUN }
  ];
  const second = dueFrom({ ...rows, invitesWaiting: new Map([[id, quota - MAX_INVITES_PER_RUN]]), dayActions: afterFirst }).ready[0];
  assert.deepEqual(second.kinds, ["profile_view", "connect"]);
  assert.equal(second.remaining, VIEWS_HELD_BACK + quota - MAX_INVITES_PER_RUN);

  // The first session failed after three requests. Its views are done, so
  // the two are the next session's however many requests are still to go:
  // it opens on them, not on a Connect.
  const crashed = [
    { account_id: id, kind: "profile_view", done: views - VIEWS_HELD_BACK },
    { account_id: id, kind: "like", done: likes },
    { account_id: id, kind: "connect", done: 3 }
  ];
  const retry = dueFrom({ ...rows, invitesWaiting: new Map([[id, quota - 3]]), dayActions: crashed }).ready[0];
  assert.deepEqual(retry.kinds, ["profile_view", "connect"]);
  assert.equal(retry.remaining, VIEWS_HELD_BACK + quota - 3);
});

test("views are kept back only when a second session is coming and there are views to spare", () => {
  const more = MAX_INVITES_PER_RUN + 1;
  const day = { viewQuota: 10, viewsDone: 0, connectQuota: more, requestsAhead: more };
  assert.equal(viewsHeldBack(day), VIEWS_HELD_BACK);
  assert.equal(viewsHeldBack({ ...day, viewQuota: 4 }), VIEWS_HELD_BACK);
  assert.equal(viewsHeldBack({ ...day, viewQuota: 3 }), 0, "three views are not split");
  assert.equal(viewsHeldBack({ ...day, connectQuota: MAX_INVITES_PER_RUN }), 0, "one run carries the day");
  assert.equal(viewsHeldBack({ ...day, connectQuota: 0 }), 0);
  assert.equal(viewsHeldBack({ ...day, requestsAhead: MAX_INVITES_PER_RUN }), 0, "people for one run: one session sends them all");
  assert.equal(viewsHeldBack({ ...day, requestsAhead: 0 }), 0);
  assert.equal(viewsHeldBack({ ...day, viewsDone: 10 - VIEWS_HELD_BACK - 1 }), VIEWS_HELD_BACK, "the first session is still on its views");
  assert.equal(viewsHeldBack({ ...day, viewsDone: 10 - VIEWS_HELD_BACK }), 0, "its views are done: the two are the next session's");
  assert.equal(viewsHeldBack({ ...day, viewsDone: 10 }), 0);

  // Through the scheduler: a working-mode day with more requests allowed than
  // one run carries, but seven people waiting and no folder — one session
  // sends them all, so it does every view and nothing wakes the account again
  // for two of them.
  const now0 = new Date("2026-09-17T10:00:00.000Z");
  const id = accountDealtMoreThanOneRun(20);
  const views = dailyQuota(DEFAULT_STRATEGY, id, 20, "profile_view");
  const likes = dailyQuota(DEFAULT_STRATEGY, id, 20, "like");
  const rows = {
    accounts: [account(id)],
    runs: [run(id, { startedAt: startedForDay(20, now0) })],
    dayActions: [],
    invitesWaiting: new Map([[id, 7]]),
    inboxSyncedToday: new Set([id]),
    todayIso: TODAY,
    nowMs: now0.getTime()
  };
  assert.equal(dueFrom(rows).ready[0].remaining, views + likes + 7);
  // With a folder that has people for more than one run, the second session is coming.
  const fed = dueFrom({ ...rows, folderFeeds: new Map([[id, [{ fromDay: 7, available: 20 }]]]) }).ready[0];
  assert.ok(fed.invites > MAX_INVITES_PER_RUN);
  assert.equal(fed.remaining, views - VIEWS_HELD_BACK + likes + fed.invites);

  // Through the scheduler: a day of three views and twelve requests keeps all three.
  const now = new Date("2026-09-17T10:00:00.000Z");
  const strategy = {
    name: "few views", pauseDays: 2,
    phases: [{ fromDay: 1, toDay: 30, label: "All at once", quotas: { profile_view: [3, 3], connect: [12, 12] }, connectionNote: false, rules: [] }]
  };
  const { ready } = dueFrom({
    accounts: [account("few")],
    runs: [run("few", { startedAt: startedForDay(5, now), strategy_snapshot: strategy })],
    dayActions: [],
    invitesWaiting: new Map([["few", 12]]),
    inboxSyncedToday: new Set(["few"]),
    todayIso: TODAY,
    nowMs: now.getTime()
  });
  assert.equal(ready[0].remaining, 3 + 12);
});

test("the oldest run goes first", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const { ready } = dueFrom({
    accounts: [account("new"), account("old"), account("middle")],
    runs: [
      run("new", { startedAt: startedForDay(1, now) }),
      run("old", { startedAt: startedForDay(3, now) }),
      run("middle", { startedAt: startedForDay(2, now) })
    ],
    dayActions: [],
    todayIso: TODAY,
    nowMs: now.getTime()
  });
  assert.deepEqual(ready.map((item) => item.account.id), ["old", "middle", "new"]);
});

// ── the second session of a morning ───────────────────────────────────────

/** Account `w`, in working mode, after a first session that sent one run's worth. */
function afterFirstSession(now, id = accountDealtMoreThanOneRun(56)) {
  return {
    id,
    account: account(id),
    run: run(id, { startedAt: startedForDay(56, now) }),
    dayActions: [...complete(id, 56), { account_id: id, kind: "connect", done: MAX_INVITES_PER_RUN }]
  };
}

test("an account that has not had a session today goes before one that has, however old its run", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  const working = afterFirstSession(now);
  const rows = {
    accounts: [working.account, account("fresh")],
    runs: [working.run, run("fresh", { startedAt: startedForDay(2, now) })],
    dayActions: working.dayActions,
    invitesWaiting: new Map([[working.id, 8]]),
    inboxSyncedToday: new Set([working.id]),
    todayIso: TODAY,
    nowMs
  };

  // Today's counters say the working account was worked this morning — which
  // a restart does not forget. Its leftover requests keep; day 2 does not.
  assert.deepEqual(dueFrom(rows).ready.map((item) => item.account.id), ["fresh", working.id]);

  // And so does the session itself, counters or not.
  const lease = grantLease(working.account, nowMs - 3 * 60 * 60_000);
  releaseLease(working.id, lease.leaseId, nowMs - 2 * 60 * 60_000);
  const bySession = dueFrom({ ...rows, dayActions: [] });
  assert.deepEqual(bySession.ready.map((item) => item.account.id), ["fresh", working.id]);

  // Without either, the oldest run goes first, as always.
  resetScheduler();
  assert.deepEqual(dueFrom({ ...rows, dayActions: [] }).ready.map((item) => item.account.id), [working.id, "fresh"]);
});

test("the same account is not handed out again until an hour after its session ended", async (t) => {
  // No database here: the report's log line has nowhere to go, and says so.
  t.mock.method(console, "error", () => {});
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  const working = afterFirstSession(now);
  const rows = {
    accounts: [working.account],
    runs: [working.run],
    dayActions: working.dayActions,
    invitesWaiting: new Map([[working.id, 8]]),
    inboxSyncedToday: new Set([working.id]),
    todayIso: TODAY
  };
  assert.equal(sameDayGapMinutes(), 60);

  const lease = grantLease(working.account, nowMs);
  const endedAt = nowMs + 20 * 60_000;
  await finishRun({ account: working.account, run: working.run, leaseId: lease.leaseId, ok: true, now: new Date(endedAt) });
  assert.equal(restingUntil(working.id), endedAt + 60 * 60_000);

  // Two to seven minutes later — the old gap — it owes requests and nothing
  // else, so the session would open on a Connect.
  const soon = dueFrom({ ...rows, nowMs: endedAt + 5 * 60_000 });
  assert.equal(soon.ready.length, 0);
  assert.equal(soon.held[0]?.account.id, working.id, "held back, and said so");
  assert.equal(soon.held[0].resting, true);
  assert.equal(soon.held[0].until, endedAt + 60 * 60_000);
  assert.deepEqual(soon.held[0].kinds, ["connect"]);

  assert.equal(dueFrom({ ...rows, nowMs: endedAt + 59 * 60_000 }).ready.length, 0);
  assert.equal(dueFrom({ ...rows, nowMs: endedAt + 60 * 60_000 }).ready[0]?.account.id, working.id);

  // Configurable like every other minute setting here.
  process.env.WARMUP_SAME_DAY_GAP_MINUTES = "90";
  assert.equal(dueFrom({ ...rows, nowMs: endedAt + 60 * 60_000 }).ready.length, 0);
  assert.equal(dueFrom({ ...rows, nowMs: endedAt + 90 * 60_000 }).ready.length, 1);
});

test("a session that never reported back costs its lease and no rest; a late report that it finished starts the rest then", async (t) => {
  // No database here: the report's log line has nowhere to go, and says so.
  t.mock.method(console, "error", () => {});
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  const working = afterFirstSession(now);
  const rows = {
    accounts: [working.account],
    runs: [working.run],
    dayActions: working.dayActions,
    invitesWaiting: new Map([[working.id, 8]]),
    inboxSyncedToday: new Set([working.id]),
    todayIso: TODAY
  };
  const lease = grantLease(working.account, nowMs);
  assert.equal(restingUntil(working.id), 0, "taken is not finished: no rest is owed yet");

  // A worker that died: the lease is the whole cost, and the account is back
  // the moment it runs out — not an hour after.
  assert.equal(dueFrom({ ...rows, nowMs: lease.expiresAt - 1 }).ready.length, 0, "still somebody's");
  const back = dueFrom({ ...rows, nowMs: lease.expiresAt });
  assert.equal(back.ready[0]?.account.id, working.id);
  assert.equal(back.held.length, 0);

  // The worker was only slow: it reports ten minutes after the lease ran out.
  const late = new Date(lease.expiresAt + 10 * 60_000);
  sweepLeases(late.getTime());
  const outcome = await finishRun({ account: working.account, run: working.run, leaseId: lease.leaseId, ok: true, now: late });
  assert.equal(outcome.released, false);
  assert.equal(restingUntil(working.id), late.getTime() + 60 * 60_000);
});

test("a failed session waits out the cool-off and nothing more", async (t) => {
  // No database here: the report's log line has nowhere to go, and says so.
  // What it says is checked over the route (`warmup-agent-due.test.mjs`).
  t.mock.method(console, "error", () => {});
  process.env.WARMUP_COOL_OFF_MINUTES = "15";
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  const working = afterFirstSession(now);
  const rows = {
    accounts: [working.account],
    runs: [working.run],
    dayActions: working.dayActions,
    invitesWaiting: new Map([[working.id, 8]]),
    inboxSyncedToday: new Set([working.id]),
    todayIso: TODAY
  };

  const lease = grantLease(working.account, nowMs);
  const endedAt = nowMs + 5 * 60_000;
  const outcome = await finishRun({
    account: working.account, run: working.run, leaseId: lease.leaseId, ok: false, note: "Anty would not start", now: new Date(endedAt)
  });
  assert.equal(outcome.coolOffMinutes, 15);
  assert.equal(restingUntil(working.id), 0, "no same-morning rest on top of the cool-off");

  const cooling = dueFrom({ ...rows, nowMs: endedAt + 14 * 60_000 });
  assert.equal(cooling.ready.length, 0);
  assert.equal(cooling.held[0]?.resting, undefined, "held by the cool-off, not by a rest");
  assert.equal(dueFrom({ ...rows, nowMs: endedAt + 15 * 60_000 }).ready[0]?.account.id, working.id,
    "back when the cool-off says, not an hour later");
});

// ── the lease ─────────────────────────────────────────────────────────────

test("a leased account is not offered a second time", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  const rows = {
    accounts: [account("a"), account("b")],
    runs: [run("a", { startedAt: startedForDay(3, now) }), run("b", { startedAt: startedForDay(2, now) })],
    dayActions: [],
    todayIso: TODAY,
    nowMs
  };

  const first = dueFrom(rows).ready[0];
  assert.equal(first.account.id, "a");
  grantLease(first.account, nowMs);

  const second = dueFrom(rows).ready;
  assert.deepEqual(second.map((item) => item.account.id), ["b"], "the account somebody is running is out of the list");
});

test("a lease expires on its own, and the account comes back", () => {
  const nowMs = Date.parse("2026-09-17T10:00:00.000Z");
  const lease = grantLease(account("a"), nowMs);
  assert.equal(lease.expiresAt - nowMs, leaseMinutes() * 60_000);

  assert.equal(activeLease(nowMs + 60_000)?.leaseId, lease.leaseId);
  assert.equal(activeLease(lease.expiresAt), null, "a lease is over at the moment it expires, not a second later");

  assert.deepEqual(sweepLeases(nowMs + 60_000).length, 0);
  assert.deepEqual(sweepLeases(lease.expiresAt).map((item) => item.leaseId), [lease.leaseId]);
  assert.equal(activeLease(lease.expiresAt), null);
});

test("LEASE_MINUTES is configurable and the default is 25", () => {
  assert.equal(leaseMinutes(), 25);
  process.env.WARMUP_LEASE_MINUTES = "5";
  const nowMs = Date.now();
  assert.equal(grantLease(account("a"), nowMs).expiresAt - nowMs, 5 * 60_000);
});

test("releasing somebody else's lease does not free the account", () => {
  const nowMs = Date.now();
  const lease = grantLease(account("a"), nowMs);

  assert.deepEqual(releaseLease("a", "a-lease-id-from-a-previous-run").released, false);
  assert.equal(activeLease(nowMs)?.leaseId, lease.leaseId, "somebody is still running that account");

  assert.equal(releaseLease("a", lease.leaseId).released, true);
  assert.equal(activeLease(nowMs), null);
  assert.equal(releaseLease("a", lease.leaseId).released, false, "releasing twice is not an error, it is a no-op");
});

// ── the cool-off ──────────────────────────────────────────────────────────

test("a cooling-off account is held back, and says so by name", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  const rows = {
    accounts: [account("a")],
    runs: [run("a", { startedAt: startedForDay(2, now) })],
    dayActions: [],
    todayIso: TODAY,
    nowMs
  };
  assert.equal(dueFrom(rows).ready.length, 1);

  const until = startCoolOff("a", nowMs);
  assert.equal(until - nowMs, 45 * 60_000);

  const cooling = dueFrom(rows);
  assert.equal(cooling.ready.length, 0);
  assert.equal(cooling.held[0].account.label, "Account a");

  // And it comes back by itself once the cool-off has run out.
  assert.equal(dueFrom({ ...rows, nowMs: until }).ready.length, 1);
});

test("an account with nothing left today is not reported as cooling off", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  startCoolOff("a", nowMs);
  const { ready, held } = dueFrom({
    accounts: [account("a")],
    runs: [run("a", { startedAt: startedForDay(2, now) })],
    dayActions: complete("a", 2),
    inboxSyncedToday: new Set(["a"]),
    todayIso: TODAY,
    nowMs
  });
  assert.equal(ready.length, 0);
  assert.equal(held.length, 0, "'in cool-off' has to mean work is waiting, or it reads as a stuck account");
});

test("COOL_OFF_MINUTES is configurable", () => {
  process.env.WARMUP_COOL_OFF_MINUTES = "10";
  const nowMs = Date.now();
  assert.equal(startCoolOff("a", nowMs) - nowMs, 10 * 60_000);
  assert.equal(coolOffUntil("a"), nowMs + 10 * 60_000);
  assert.equal(coolOffUntil("b"), 0);
});

// ── the arithmetic the worker sleeps on ───────────────────────────────────

test("the wait for the window is capped, so a worker never sleeps through a change", () => {
  const beforeOpening = new Date(2026, 8, 17, 8, 55, 0);
  assert.equal(secondsUntilWindowOpens(beforeOpening), 300);

  // 22:00 is eleven hours from the next opening; the answer is fifteen minutes.
  assert.equal(secondsUntilWindowOpens(new Date(2026, 8, 17, 22, 0, 0)), 900);
  assert.equal(secondsUntilWindowOpens(new Date(2026, 8, 17, 3, 0, 0)), 900);

  // Never zero, whatever the clock says: a worker told to sleep 0 is a hot loop.
  const oneSecondBefore = new Date(2026, 8, 17, SESSION_WINDOW.startHour - 1, 59, 59, 500);
  assert.equal(secondsUntilWindowOpens(oneSecondBefore), 1);
});

test("the gap is drawn inside 120–420 and both bounds are reachable", () => {
  assert.equal(gapSeconds(() => 0), 120);
  assert.equal(gapSeconds(() => 0.999999), 420);
  for (let index = 0; index < 200; index += 1) {
    const drawn = gapSeconds();
    assert.ok(Number.isInteger(drawn) && drawn >= 120 && drawn <= 420, `drew ${drawn}`);
  }
});

// ── the answer itself ─────────────────────────────────────────────────────

test("outside the window the answer is the window, a reason and a capped wait", async () => {
  const answer = await decideNext({ now: new Date(2026, 8, 17, 22, 0, 0) });
  assert.equal(answer.success, true);
  assert.equal(answer.window.open, false);
  assert.equal(answer.window.label, windowLabel());
  assert.equal(answer.next, null);
  assert.equal(answer.reason, `outside ${windowLabel()}`);
  assert.equal(answer.retryAfterSeconds, 900);
});

test("a disabled deployment drives nothing and says which", async () => {
  process.env.WARMUP_SCHEDULER_DISABLED = "1";
  // Inside the window, so only the flag can be the reason.
  const answer = await decideNext({ now: new Date(2026, 8, 17, 10, 0, 0) });
  assert.equal(answer.next, null);
  assert.equal(answer.reason, "the scheduler is switched off on this deployment");
  assert.equal(answer.retryAfterSeconds, 900);
});

test("while somebody holds a lease the answer names them and waits exactly that long", async () => {
  const now = new Date(2026, 8, 17, 10, 0, 0);
  const lease = grantLease({ id: "a", label: "Chloe Stewart" }, now.getTime());

  const answer = await decideNext({ now });
  assert.equal(answer.next, null);
  assert.equal(answer.reason, "Chloe Stewart is already running");
  // Capped, not the whole 25 minutes: the worker was promised 900 at most, and
  // coming back early to be told the same thing costs one poll.
  assert.equal(answer.retryAfterSeconds, 900);

  const later = new Date(lease.expiresAt - 90_000);
  assert.equal((await decideNext({ now: later })).retryAfterSeconds, 90);
});

test("no reason ever carries a number that moves under the worker's log", async () => {
  const now = new Date(2026, 8, 17, 10, 0, 0);
  grantLease({ id: "a", label: "Chloe Stewart" }, now.getTime());
  // Late in the lease, where the countdown is under the cap and so actually moves.
  const first = await decideNext({ now: new Date(now.getTime() + 11 * 60_000) });
  const second = await decideNext({ now: new Date(now.getTime() + 12 * 60_000) });
  assert.equal(first.reason, second.reason, "the worker logs a reason once and stays quiet until it changes");
  assert.notEqual(first.retryAfterSeconds, second.retryAfterSeconds, "the countdown belongs here instead");
});
