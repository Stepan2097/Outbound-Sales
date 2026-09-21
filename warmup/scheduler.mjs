import { randomUUID } from "node:crypto";

import { anty, today } from "./db.mjs";
import { SESSION_WINDOW, insideWindow, windowLabel } from "./schedule.mjs";
import { currentDay, dailyQuota, totalDays } from "./strategy.mjs";
import { logEvent } from "./store.mjs";
import { MAX_INVITE_CHECKS_PER_RUN, checkedTodayAccounts, openConversationCounts, pendingCounts, waitingCounts } from "./invites.mjs";
import { syncedTodayAccounts } from "./inbox.mjs";

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
/**
 * The kinds the agent does on its own initiative, against nobody in particular.
 *
 * Connection requests are deliberately absent and stay absent. They go to a
 * named person from the lead workspace, and an account is woken for them only
 * when one is actually waiting — see `invitesWaiting` in `dueFrom`. Putting
 * `connect` here instead would make every account due every morning for as long
 * as it had allowance, and the browser would open to send nothing.
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
 *
 * `openProfiles` is the profiles Anty reports running right now, and it is the
 * only guard here that is not about us. A lease covers the workers that ask;
 * nothing covers a second launcher that does not — a portal left running on the
 * old build, or a person who opened the profile in Anty by hand. Anty sees both,
 * because both have to go through it to get a browser, so an account whose
 * profile is already open is not due however much it owes.
 */
/**
 * Looking after what was already done, as opposed to warming.
 *
 * Warming is finite: a plan has a last day and every account reaches it. Two
 * things are not finite — checking whether a sent invitation was accepted, and
 * reading what people wrote back — and until now both rode along on warming
 * work. The day an account's views and likes were done, nobody looked; the day
 * its plan ended, nobody ever looked again. An account reaches the end of its
 * plan holding exactly the invitations it sent last, which is the worst
 * possible moment to stop watching them.
 *
 * So upkeep is its own reason to open a browser, with the same two rules the
 * rest of this function follows: evidence rather than allowance — there must be
 * something outstanding — and a bound, which here is once a day.
 */
function upkeepFor({ accountId, inPlan, pendingInvites, openConversations, checkedToday, inboxSyncedToday }) {
  // Invitations are checked on any day, in or out of plan: a sent request can
  // be accepted on a day this account happens to owe nothing else, and "every
  // day" was the ask.
  const checks = checkedToday?.has(accountId) ? 0 : Math.min(pendingInvites?.get(accountId) ?? 0, MAX_INVITE_CHECKS_PER_RUN);

  // The inbox is different in two ways, and both are restrictions.
  //
  // Only out-of-plan accounts need it as a reason at all: inside the plan
  // tomorrow's quota opens the browser anyway and the inbox is read while it is
  // there, so making "not read today" a reason of its own would hand every
  // account a session every morning whether or not it had anything else to do.
  //
  // And it needs the same evidence the rest of this function demands. "We have
  // not read it today" is a statement about us; an account that finished
  // warming without ever approaching anybody has nobody who could have written,
  // and opening a browser daily forever to find an empty inbox is exactly the
  // allowance-instead-of-evidence mistake this whole rule exists to prevent.
  const inbox = !inPlan
    && (openConversations?.get(accountId) ?? 0) > 0
    && !inboxSyncedToday?.has(accountId);

  return { checks, inbox, any: checks > 0 || inbox };
}

export function dueFrom({
  accounts, runs, dayActions, openProfiles, invitesWaiting,
  pendingInvites, openConversations, checkedToday, inboxSyncedToday,
  todayIso, nowMs = Date.now()
}) {
  const runByAccount = new Map((runs ?? []).map((row) => [row.account_id, row]));

  const doneByAccount = new Map();
  for (const row of dayActions ?? []) {
    const perKind = doneByAccount.get(row.account_id) ?? new Map();
    perKind.set(row.kind, Number(row.done) || 0);
    doneByAccount.set(row.account_id, perKind);
  }

  const ready = [];
  const held = [];
  const busy = [];
  for (const account of accounts ?? []) {
    const run = runByAccount.get(account.id);
    if (!run) continue;
    if (run.paused_until && run.paused_until >= todayIso) continue;

    // The clock comes from the caller, like every other time in this function.
    // Left to default, `currentDay` read the wall clock while `nowMs` and
    // `todayIso` were pinned — so which day of the plan an account is on
    // depended on the date the suite happened to run, and a test written on the
    // day it passed went red the following week. A decision function takes its
    // time as an argument.
    const day = currentDay(new Date(run.started_at), run.paused_days ?? 0, new Date(nowMs));
    // An account past the last day of its plan has no warming left — but it
    // may still be holding invitations nobody has looked at and replies nobody
    // has read, and those do not end when the plan does.
    const inPlan = day <= totalDays(run.strategy_snapshot);

    const done = doneByAccount.get(account.id);
    const kinds = [];
    let remaining = 0;
    for (const kind of inPlan ? AGENT_KINDS : []) {
      const left = Math.max(0, dailyQuota(run.strategy_snapshot, account.id, day, kind) - (done?.get(kind) ?? 0));
      if (left > 0) kinds.push(kind);
      remaining += left;
    }

    // Invitations are work only when there is somebody to invite. The evidence
    // is a waiting row, not an unspent allowance: an account with five connects
    // left and nobody queued owes nothing, and waking it would open a browser
    // to do nothing at all. Bounded by the allowance too, so an account is
    // never handed more invitations than it may send today.
    const connectLeft = inPlan
      ? Math.max(0, dailyQuota(run.strategy_snapshot, account.id, day, "connect") - (done?.get("connect") ?? 0))
      : 0;
    const invites = Math.min(invitesWaiting?.get(account.id) ?? 0, connectLeft);
    if (invites > 0) {
      kinds.push("connect");
      remaining += invites;
    }

    const upkeep = upkeepFor({ accountId: account.id, inPlan, pendingInvites, openConversations, checkedToday, inboxSyncedToday });
    // Upkeep is counted apart from `remaining` on purpose: `remaining` is the
    // day's quota and paces the worker, and a check spends none of it. An
    // account can be due on upkeep alone, with `remaining: 0`.
    if (remaining <= 0 && !upkeep.any) continue;

    if (openProfiles?.has(account.profile_remote_id)) {
      busy.push({ account, run, day, remaining, kinds, invites, upkeep });
      continue;
    }

    const until = coolingOff.get(account.id) ?? 0;
    if (until > nowMs) {
      held.push({ account, run, day, remaining, kinds, invites, upkeep, until });
      continue;
    }
    // Expiry rather than presence: a lease is swept by the tick and by the
    // decision, but an account whose lease simply ran out is available again
    // even if nothing has got round to deleting it yet.
    if ((leases.get(account.id)?.expiresAt ?? 0) > nowMs) continue;

    ready.push({ account, run, day, remaining, kinds, invites, upkeep });
  }

  // Warming before upkeep, then oldest run first. One account runs at a time
  // inside a four-hour window, so an account that only needs looking after must
  // not take a session from one that still has a plan to follow — its work
  // keeps until tomorrow, and the plan does not.
  ready.sort((a, b) =>
    Number(b.remaining > 0) - Number(a.remaining > 0)
    || Date.parse(a.run.started_at) - Date.parse(b.run.started_at));
  held.sort((a, b) => a.until - b.until);
  return { ready, held, busy };
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
  if (!accounts.length) return { ready: [], held: [], busy: [] };

  const ids = accounts.map((account) => account.id);
  const profileIds = accounts.map((account) => account.profile_remote_id);
  const runs = await anty.from("wl_runs").select("*").in("account_id", ids).eq("state", "running").rows();
  const dayActions = await anty.from("wl_day_actions").select("account_id,kind,done")
    .in("account_id", ids).eq("on_date", todayIso).rows();
  // A deleted profile can still carry the status it had when it went, so it is
  // not open anywhere — the same reading the sessions sync already takes.
  const profiles = await anty.from("anty_browser_profiles").select("id,status,is_deleted").in("id", profileIds).rows();
  const openProfiles = new Set(
    profiles.filter((profile) => profile.status === "running" && !profile.is_deleted).map((profile) => profile.id)
  );
  // Who is holding somebody for an invitation. One query for every account,
  // not one per account: this runs on every worker poll.
  const invitesWaiting = await waitingCounts(ids);
  // The upkeep evidence: what is outstanding, and what has already been done
  // today. Three queries for every account rather than three per account.
  const [pendingInvites, openConversations, checkedToday, inboxSyncedToday] = await Promise.all([
    pendingCounts(ids),
    openConversationCounts(ids),
    checkedTodayAccounts(ids, todayIso),
    syncedTodayAccounts(ids, todayIso)
  ]);

  return dueFrom({
    accounts, runs, dayActions, openProfiles, invitesWaiting,
    pendingInvites, openConversations, checkedToday, inboxSyncedToday, todayIso, nowMs
  });
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
 * It takes nothing. Asking is a GET and behaves like one: `next` is what would
 * be handed out, `leaseId` is always null, and the account is still free when
 * the answer arrives. Taking it is `leaseAccount`, a POST, because a read that
 * parked a real account for twenty-five minutes would have had a curl, a health
 * check, a monitor or a client-side timeout costing a session in the middle of
 * the morning, with a quiet morning as the only symptom.
 */
export async function decideNext({ now = new Date(), random = Math.random } = {}) {
  const nowMs = now.getTime();
  const window = { ...SESSION_WINDOW, label: windowLabel(), open: insideWindow(now) };
  const idle = (reason, retryAfterSeconds) => ({ success: true, window, next: null, reason, retryAfterSeconds });

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

  const { ready, held, busy } = await candidates(today(), nowMs);
  if (!ready.length) {
    // The open profile is reported ahead of the cool-off: one says wait, the
    // other says something is running this account that did not ask us, and
    // that is the sentence somebody needs to see.
    return idle(blockedReason(busy[0], held[0]), between(IDLE, random));
  }

  return {
    success: true,
    window,
    // Field-identical to what `leaseAccount` hands back, so a worker parses one
    // shape. The two nulls are the difference between being told who is next
    // and holding it.
    next: { ...offer(ready[0]), leaseId: null, leaseExpiresAt: null },
    reason: null,
    // A fallback, not the pacing: a worker takes the account it was just shown
    // and is paced by `nextInSeconds` when it reports back. This is what it
    // comes back on if it never gets that far.
    retryAfterSeconds: between(GAP, random)
  };
}

/**
 * Why nothing can be handed out, in the stable wording the worker deduplicates
 * on — no countdown, no timestamp, nothing that moves between two identical
 * states.
 */
function blockedReason(busy, cooling, fallback = "nothing owes work today") {
  if (busy) return `${busy.account.label} already has its profile open`;
  if (cooling) return `${cooling.account.label} is in cool-off`;
  return fallback;
}

/** The account, as both answers describe it. */
function offer(pick) {
  return {
    accountId: pick.account.id,
    label: pick.account.label,
    profileRemoteId: pick.account.profile_remote_id,
    day: pick.day,
    remaining: pick.remaining,
    kinds: pick.kinds,
    // What is owed that is not the day's quota: invitations to look at, and
    // whether the inbox has been read today. An account can be handed over with
    // `remaining: 0` and one of these set.
    upkeep: pick.upkeep ?? { checks: 0, inbox: false, any: false },
    // How many of `remaining` are invitations. A worker that sees `connect` in
    // `kinds` still has to ask `/agent` for who they are; this is so the log
    // line says "3 views, 2 invitations" rather than "5 things".
    invites: pick.invites ?? 0
  };
}

/**
 * Take the account.
 *
 * Separate from the question deliberately, and it must stay separate: the
 * moment a GET can lease, every probe of it is a lost session and nothing says
 * so. The split is also what makes a race honest — two workers asking at once
 * both get told the same account is next, one POST wins, and the loser is told
 * who holds it and when to ask again rather than quietly running the same
 * profile from a second machine.
 *
 * Everything is re-checked here rather than trusted from the GET: an answer a
 * worker sat on for ten minutes is a claim about a window, a quota and a lease
 * that may all have moved.
 */
export async function leaseAccount({ accountId, now = new Date(), random = Math.random }) {
  const nowMs = now.getTime();
  const refuse = (error, retryAfterSeconds) => ({ ok: false, status: 409, error, retryAfterSeconds });

  if (schedulerDisabled()) {
    return refuse("the scheduler is switched off on this deployment", OUTSIDE_WINDOW_CAP);
  }
  if (!insideWindow(now)) {
    return refuse(`outside ${windowLabel()}`, secondsUntilWindowOpens(now));
  }

  sweepLeases(nowMs);
  const running = activeLease(nowMs);
  if (running) {
    return refuse(`${running.label} is already running`, secondsUntil(running.expiresAt, nowMs));
  }

  const { ready, held, busy } = await candidates(today(), nowMs);
  const pick = ready.find((item) => item.account.id === accountId);
  if (!pick) {
    const mine = (list) => list.find((item) => item.account.id === accountId);
    // Not an error on the worker's part: it asked for what it was shown, and
    // the answer moved underneath it. It polls again like any other refusal.
    return refuse(blockedReason(mine(busy), mine(held), "that account does not owe work right now"), between(IDLE, random));
  }

  const lease = grantLease(pick.account, nowMs);
  await logEvent({
    accountId: pick.account.id,
    runId: pick.run.id,
    type: "scheduler.started",
    message: `Handed to a worker — day ${pick.day}, ${pick.remaining} action(s) left today`,
    meta: { day: pick.day, remaining: pick.remaining, kinds: pick.kinds, leaseId: lease.leaseId }
  });

  return {
    ok: true,
    lease: { ...offer(pick), leaseId: lease.leaseId, leaseExpiresAt: new Date(lease.expiresAt).toISOString() }
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
