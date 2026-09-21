import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_KINDS, activeLease, coolOffUntil, decideNext, dueFrom, gapSeconds, grantLease, leaseMinutes,
  releaseLease, resetScheduler, secondsUntilWindowOpens, startCoolOff, sweepLeases
} from "../warmup/scheduler.mjs";
import { DEFAULT_STRATEGY, dailyQuota } from "../warmup/strategy.mjs";
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
    todayIso: TODAY,
    nowMs: now.getTime()
  });
  assert.equal(ready.length, 0);
  assert.equal(held.length, 0);
});

test("no run, a pause that covers today, and a plan that has run out all take an account out", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const nowMs = now.getTime();
  const accounts = [account("a"), account("b"), account("c")];
  const { ready } = dueFrom({
    accounts,
    runs: [
      // "a" has no running run at all.
      run("b", { startedAt: startedForDay(2, now), paused_until: TODAY }),
      run("c", { startedAt: startedForDay(20, now) })
    ],
    dayActions: [],
    // "c" is past the last day of its plan, which takes it out of the warming
    // queue — but not out of upkeep, which outlives the plan. Saying its inbox
    // was read today is what leaves it owing nothing at all.
    inboxSyncedToday: new Set(["c"]),
    todayIso: TODAY,
    nowMs
  });
  assert.equal(ready.length, 0);

  // A pause that ended yesterday does not hold anything back.
  const { ready: after } = dueFrom({
    accounts: [account("b")],
    runs: [run("b", { startedAt: startedForDay(2, now), paused_until: "2026-09-16" })],
    dayActions: [],
    todayIso: TODAY,
    nowMs
  });
  assert.equal(after.length, 1);
});

test("an account past the end of its plan is still opened for what it is holding", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const finished = { accounts: [account("c")], runs: [run("c", { startedAt: startedForDay(20, now) })], dayActions: [], todayIso: TODAY, nowMs: now.getTime() };

  // Warming ends; looking after what it sent does not. An account reaches its
  // last day holding exactly the invitations it sent most recently, which is
  // the worst moment to stop watching them.
  const { ready } = dueFrom({ ...finished, pendingInvites: new Map([["c", 4]]), inboxSyncedToday: new Set(["c"]) });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].remaining, 0, "nothing is owed against a quota — the plan is over");
  assert.equal(ready[0].upkeep.checks, 4);
  assert.deepEqual(ready[0].kinds, [], "and it is not offered any warming work to do");

  // Once a day. A second poll the same day finds nothing owing.
  const { ready: again } = dueFrom({
    ...finished,
    pendingInvites: new Map([["c", 4]]),
    checkedToday: new Set(["c"]),
    inboxSyncedToday: new Set(["c"])
  });
  assert.equal(again.length, 0);
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
    dayActions: [],
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
