import { randomUUID } from "node:crypto";

import { anty, today } from "./db.mjs";
import { SESSION_WINDOW, insideWindow, windowLabel } from "./schedule.mjs";
import { currentDay, dailyQuota, totalDays } from "./strategy.mjs";
import { logEvent } from "./store.mjs";

/**
 * Who is allowed to run, and when the asker should come back.
 *
 * This is the decision the portal on the Mac used to make, moved to the server
 * and nothing else: the same four questions in the same order, sorted the same
 * way. What deliberately did not come with it is the doing. The old scheduler
 * ended in a `spawn` because the browser was in the same process tree; here the
 * browser is on somebody's laptop, so the answer leaves as JSON and a worker
 * carries it out.
 *
 * Because the worker carries no window, no order and no gap of its own, every
 * number it acts on is drawn here. A wrong one does not show up as a broken
 * screen — it shows up as a Mac that sleeps through the morning.
 */

/**
 * What the agent can actually carry out, and therefore the only work that can
 * make an account due.
 *
 * Connection requests are deliberately absent: they go from a campaign's queue
 * with a person attached to each one, and are counted separately. Comments and
 * follows are absent because the agent cannot do them — counting work it cannot
 * do would hand out an account every poll to open a browser and achieve nothing.
 *
 * Keep in step with `agent/run-account.mjs` in the warm-up repo.
 */
export const AGENT_KINDS = ["profile_view", "like"];

/**
 * The pacing, in seconds, all of it.
 *
 * `OUTSIDE_WINDOW_CAP` is why a worker asked at 22:00 is told 900 rather than
 * the eleven real hours: a number that large is indistinguishable from a worker
 * that has stopped, and the window on screen can move while it sleeps.
 *
 * `GAP` is two to seven minutes because two sessions a minute apart from one
 * machine, through two proxies, is the shape of a tool. `IDLE` is longer
 * because nothing owing work is a state that rarely changes in five minutes.
 */
const OUTSIDE_WINDOW_CAP = 900;
const IDLE = { min: 300, max: 540 };
const GAP = { min: 120, max: 420 };

function minutes(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How long a handed-out account is somebody's. A worker that dies mid-run costs
 * one lease period, which is shorter than the gap between accounts anyway.
 */
export function leaseMinutes() {
  return minutes("WARMUP_LEASE_MINUTES", 25);
}

/**
 * The backstop for the failures health does not capture — Anty holding the
 * profile open, a proxy that is down, a browser that would not start.
 */
export function coolOffMinutes() {
  return minutes("WARMUP_COOL_OFF_MINUTES", 45);
}

/** A deployment that is not meant to drive anybody's Mac says so. */
export function schedulerDisabled() {
  return process.env.WARMUP_SCHEDULER_DISABLED === "1";
}

/** Inclusive on both ends, so the drawn seconds can be either bound. */
function between({ min, max }, random) {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Whole seconds, never zero and never longer than the cap.
 *
 * Zero is a hot loop. The cap is the promise the worker was given — every
 * `retryAfterSeconds` is between 1 and 900 — and it is enforced here rather
 * than documented, because the one number that could outgrow it is the wait on
 * a lease, and that is `LEASE_MINUTES`, which a deployment can raise. Coming
 * back before a lease expires costs one poll; coming back an hour late because
 * somebody set it to 60 costs a morning.
 */
function secondsUntil(target, nowMs) {
  return Math.min(OUTSIDE_WINDOW_CAP, Math.max(1, Math.ceil((target - nowMs) / 1000)));
}

/**
 * Seconds until the window opens again, capped.
 *
 * Only ever asked outside the window, so a start hour that has already passed
 * today is tomorrow's.
 */
export function secondsUntilWindowOpens(now = new Date()) {
  const opens = new Date(now);
  opens.setHours(SESSION_WINDOW.startHour, 0, 0, 0);
  if (opens.getTime() <= now.getTime()) opens.setDate(opens.getDate() + 1);
  return secondsUntil(opens.getTime(), now.getTime());
}

/**
 * Leases and cool-offs, in memory and deliberately so.
 *
 * A lease is about right now. A server that has restarted and forgotten one is
 * a server that correctly believes nobody is running — the alternative is a
 * row that outlives the process that meant it and an account nobody can take.
 * The cool-off is in memory for the same reason the old scheduler's was:
 * restarting is also how you clear it.
 */
const leases = new Map();
const coolingOff = new Map();

/** Everything expired, dropped and handed back so a caller can log it. */
export function sweepLeases(nowMs = Date.now()) {
  const expired = [];
  for (const [accountId, lease] of leases) {
    if (lease.expiresAt <= nowMs) {
      leases.delete(accountId);
      expired.push(lease);
    }
  }
  return expired;
}

/** The lease somebody is holding, if anybody is. Only one account runs at a time. */
export function activeLease(nowMs = Date.now()) {
  for (const lease of leases.values()) {
    if (lease.expiresAt > nowMs) return lease;
  }
  return null;
}

/**
 * The label is carried on the lease rather than looked up when it is needed:
 * "Chloe Stewart is already running" is answered on every poll for twenty-five
 * minutes, and it should not cost a query each time.
 */
export function grantLease(account, nowMs = Date.now()) {
  const lease = {
    leaseId: randomUUID(),
    accountId: account.id,
    label: account.label,
    grantedAt: nowMs,
    expiresAt: nowMs + leaseMinutes() * 60_000
  };
  leases.set(account.id, lease);
  return lease;
}

/**
 * Give the account back.
 *
 * A `leaseId` that does not match the lease being held is not a reason to
 * release it: that is somebody else's run, still in progress. The report is
 * still accepted — see the route — this only decides whether the account
 * becomes available again.
 */
export function releaseLease(accountId, leaseId) {
  const held = leases.get(accountId);
  if (!held) return { released: false, held: null };
  if (leaseId && held.leaseId !== leaseId) return { released: false, held };
  leases.delete(accountId);
  return { released: true, held };
}

export function startCoolOff(accountId, nowMs = Date.now()) {
  const until = nowMs + coolOffMinutes() * 60_000;
  coolingOff.set(accountId, until);
  return until;
}

export function coolOffUntil(accountId) {
  return coolingOff.get(accountId) ?? 0;
}

/** Tests only — the process itself clears this by restarting. */
export function resetScheduler() {
  leases.clear();
  coolingOff.clear();
}

/**
 * Who owes work, from rows.
 *
 * Split from the reads so the decision can be tested against a fixture rather
 * than against a live Supabase — the arithmetic here is the part that decides
 * whether a real account gets opened.
 *
 * Cool-off is checked last, after the quota, so an account that is cooling off
 * but has nothing left today is simply not due rather than reported as held
 * back: "Chloe Stewart is in cool-off" should mean work is waiting on her.
 */
export function dueFrom({ accounts, runs, dayActions, todayIso, nowMs = Date.now() }) {
  const runByAccount = new Map((runs ?? []).map((row) => [row.account_id, row]));

  const doneByAccount = new Map();
  for (const row of dayActions ?? []) {
    const perKind = doneByAccount.get(row.account_id) ?? new Map();
    perKind.set(row.kind, Number(row.done) || 0);
    doneByAccount.set(row.account_id, perKind);
  }

  const ready = [];
  const held = [];
  for (const account of accounts ?? []) {
    const run = runByAccount.get(account.id);
    if (!run) continue;
    if (run.paused_until && run.paused_until >= todayIso) continue;

    const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
    if (day > totalDays(run.strategy_snapshot)) continue;

    const done = doneByAccount.get(account.id);
    const kinds = [];
    let remaining = 0;
    for (const kind of AGENT_KINDS) {
      const left = Math.max(0, dailyQuota(run.strategy_snapshot, account.id, day, kind) - (done?.get(kind) ?? 0));
      if (left > 0) kinds.push(kind);
      remaining += left;
    }
    if (remaining <= 0) continue;

    const until = coolingOff.get(account.id) ?? 0;
    if (until > nowMs) {
      held.push({ account, run, day, remaining, kinds, until });
      continue;
    }
    // Expiry rather than presence: a lease is swept by the tick and by the
    // decision, but an account whose lease simply ran out is available again
    // even if nothing has got round to deleting it yet.
    if ((leases.get(account.id)?.expiresAt ?? 0) > nowMs) continue;

    ready.push({ account, run, day, remaining, kinds });
  }

  // Oldest run first: an account that has been waiting since day 1 goes before
  // one that was enabled five minutes ago.
  ready.sort((a, b) => Date.parse(a.run.started_at) - Date.parse(b.run.started_at));
  held.sort((a, b) => a.until - b.until);
  return { ready, held };
}

async function candidates(todayIso, nowMs) {
  const accounts = await anty.from("wl_accounts").select("*")
    .eq("status", "warming")
    // Health is the persistent half of "do not keep trying this one": an
    // account that needs a login or is sitting on a checkpoint needs a person,
    // and handing it out every five minutes only teaches LinkedIn our schedule.
    .eq("health", "ok")
    .notNull("profile_remote_id")
    .rows();
  if (!accounts.length) return { ready: [], held: [] };

  const ids = accounts.map((account) => account.id);
  const runs = await anty.from("wl_runs").select("*").in("account_id", ids).eq("state", "running").rows();
  const dayActions = await anty.from("wl_day_actions").select("account_id,kind,done")
    .in("account_id", ids).eq("on_date", todayIso).rows();

  return dueFrom({ accounts, runs, dayActions, todayIso, nowMs });
}

/**
 * The whole answer to "what should I do now", for one worker.
 *
 * `reason` carries nothing that varies between two polls of the same state —
 * no countdown, no timestamp, no jitter. The worker logs it once and stays
 * quiet until it changes, and a number inside it would turn that into the log
 * spam the rule exists to prevent. Countdowns go in `retryAfterSeconds`, which
 * is expected to move.
 *
 * `peek` answers the same question without taking the account.
 *
 * Asking is a GET and reads like one, but the answer is a lease — so a curl
 * while debugging, a health check, a monitor, or a browser tab left open on
 * this URL parks a real account for twenty-five minutes in the middle of the
 * morning, and the only symptom is a quiet morning. Anything that is not a
 * worker about to run should ask with `peek`, and a peeked answer carries no
 * `leaseId`, so an agent that used it by mistake has nothing to report back
 * with and cannot run on it.
 */
export async function decideNext({ now = new Date(), random = Math.random, peek = false } = {}) {
  const nowMs = now.getTime();
  const window = { ...SESSION_WINDOW, label: windowLabel(), open: insideWindow(now) };
  const idle = (reason, retryAfterSeconds) => ({ success: true, window, next: null, reason, retryAfterSeconds, peek });

  if (schedulerDisabled()) {
    return idle("the scheduler is switched off on this deployment", OUTSIDE_WINDOW_CAP);
  }
  if (!window.open) {
    return idle(`outside ${window.label}`, secondsUntilWindowOpens(now));
  }

  sweepLeases(nowMs);
  const running = activeLease(nowMs);
  // One account at a time, across every worker: two profiles opening within the
  // same minute from one machine is the pattern the whole warm-up avoids.
  if (running) {
    return idle(`${running.label} is already running`, secondsUntil(running.expiresAt, nowMs));
  }

  const { ready, held } = await candidates(today(), nowMs);
  if (!ready.length) {
    const cooling = held[0];
    return idle(cooling ? `${cooling.account.label} is in cool-off` : "nothing owes work today", between(IDLE, random));
  }

  const pick = ready[0];
  // A peek grants nothing and writes nothing: `scheduler.started` means an
  // account was given to somebody who is about to run it, and a log full of
  // starts that were monitoring is a log that cannot be read.
  const lease = peek ? null : grantLease(pick.account, nowMs);
  if (lease) {
    await logEvent({
      accountId: pick.account.id,
      runId: pick.run.id,
      type: "scheduler.started",
      message: `Handed to a worker — day ${pick.day}, ${pick.remaining} action(s) left today`,
      meta: { day: pick.day, remaining: pick.remaining, kinds: pick.kinds, leaseId: lease.leaseId }
    });
  }

  return {
    success: true,
    window,
    peek,
    next: {
      accountId: pick.account.id,
      label: pick.account.label,
      profileRemoteId: pick.account.profile_remote_id,
      day: pick.day,
      remaining: pick.remaining,
      kinds: pick.kinds,
      leaseId: lease?.leaseId ?? null,
      leaseExpiresAt: lease ? new Date(lease.expiresAt).toISOString() : null
    },
    reason: peek ? "nobody is running, and this account is next" : null,
    // A fallback, not the pacing: a worker that finishes reports back and is
    // given `nextInSeconds` there. This is what it comes back on if it dies
    // between being handed an account and saying what happened.
    retryAfterSeconds: between(GAP, random)
  };
}

/** The gap after a session, wherever it is drawn. */
export function gapSeconds(random = Math.random) {
  return between(GAP, random);
}

/**
 * The run is over, whatever the outcome.
 *
 * Accepted with an unknown or expired lease rather than refused: the run
 * happened either way, and the account's log and its cool-off are worth more
 * than the bookkeeping. A worker whose session overran the lease would
 * otherwise have its one honest report of a failure thrown away.
 */
export async function finishRun({ account, run, leaseId, ok, note, now = new Date(), random = Math.random }) {
  const nowMs = now.getTime();
  const { released } = releaseLease(account.id, leaseId);

  let coolOffMin = 0;
  if (!ok) {
    startCoolOff(account.id, nowMs);
    coolOffMin = coolOffMinutes();
  }

  await logEvent({
    accountId: account.id,
    runId: run?.id ?? null,
    level: ok ? "info" : "warn",
    type: "scheduler.finished",
    message: ok
      ? `Worker finished the session${note ? ` — ${note}` : ""}`
      : `The session did not finish — not handed out again for ${coolOffMin} min${note ? ` (${note})` : ""}`,
    meta: { ok, note: note ?? null, leaseId: leaseId ?? null, released, coolOffMinutes: coolOffMin || null }
  });

  return { released, coolOffMinutes: coolOffMin, nextInSeconds: gapSeconds(random) };
}

/**
 * The tick.
 *
 * It starts nothing — the worker's poll is what moves work along now. What is
 * left for a clock is the bookkeeping nobody else is awake to do: a lease whose
 * worker died leaves no trace otherwise, and "the account was handed out and
 * never reported back" is exactly the line somebody needs when they ask why a
 * morning was quiet.
 */
const TICK_MIN_MS = 5 * 60_000;
const TICK_MAX_MS = 9 * 60_000;
let timer = null;

async function tick() {
  try {
    for (const lease of sweepLeases()) {
      await logEvent({
        accountId: lease.accountId,
        level: "warn",
        type: "scheduler.lease_expired",
        message: `Handed out ${Math.round((Date.now() - lease.grantedAt) / 60_000)} min ago and never reported back — available again`,
        meta: { leaseId: lease.leaseId }
      });
    }
  } catch (error) {
    console.error("[warmup] scheduler tick failed:", error.message);
  }
}

function schedule(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void tick().finally(() => schedule(TICK_MIN_MS + Math.random() * (TICK_MAX_MS - TICK_MIN_MS)));
  }, delayMs);
  // Never hold the process open on its own account.
  timer.unref?.();
}

export function startScheduler() {
  if (timer) return;
  if (schedulerDisabled()) {
    console.log("[warm-up] scheduler off (WARMUP_SCHEDULER_DISABLED=1) — /agent/due will hand out nothing");
    return;
  }
  console.log(`[warm-up] scheduler on — sessions run ${windowLabel()}, a worker asks and this process decides`);
  schedule(30_000);
}

export function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}
