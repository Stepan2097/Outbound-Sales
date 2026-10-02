import { randomUUID } from "node:crypto";

import { anty, today } from "./db.mjs";
import { SESSION_WINDOW, insideWindow, windowLabel } from "./schedule.mjs";
import { dailyQuota, dayOfRun, hasPlanOn, inWorkingMode, pausedOn } from "./strategy.mjs";
import { LIVE_ACCOUNT_STATUSES, LIVE_RUN_STATES, logEvent, readHoldsFrom, settlePause } from "./store.mjs";
import {
  MAX_INVITES_PER_RUN, MAX_INVITE_CHECKS_PER_RUN, checkedTodayAccounts, folderAddedToday, heldCounts,
  openConversationCounts, pendingCounts
} from "./invites.mjs";
import { syncedTodayAccounts } from "./inbox.mjs";
import { connectCeiling, weeklyConnectCounts } from "./weekly.mjs";
import { claimCutoff, folderWork, fromDayLookup } from "./campaigns.mjs";
import { folderFeeds } from "./feed.mjs";

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
 * named person — picked in the lead workspace, or taken from a campaign's
 * folder — and an account is woken for them only when there is somebody: a
 * waiting row, or a folder that still has people for it — see `invitesWaiting`
 * and `folderFeeds` in `dueFrom`. Putting `connect` here instead would make
 * every account due every morning for as long as it had allowance, and the
 * browser would open to send nothing.
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
 * one lease period and nothing more: the same-morning rest starts only from a
 * session that reported it finished (`finishRun`).
 */
export function leaseMinutes() {
  return minutes("WARMUP_LEASE_MINUTES", 25);
}

/**
 * The backstop for the failures health does not capture — Anty holding the
 * profile open, a proxy that is down, a browser that would not start.
 *
 * The whole wait after a failed session: no same-morning rest is added on
 * top, so the number the `scheduler.finished` line states is the real one.
 */
export function coolOffMinutes() {
  return minutes("WARMUP_COOL_OFF_MINUTES", 45);
}

/**
 * How long one account rests between two sessions on the same morning.
 *
 * Working mode sends 10–15 requests a day and a run carries 10, so most
 * working days need a second session — and with nothing to hold it back it
 * started two to seven minutes after the first one ended, on an account
 * LinkedIn had just watched leave. An hour apart, the second visit is a
 * second visit.
 *
 * The gap alone does not decide how that visit opens: with the day's views
 * and likes spent in the first session, the second went straight to Connect —
 * the "request thirty seconds into a session" shape the whole warm-up exists
 * to avoid. That is `viewsHeldBack`'s job.
 *
 * Only after a session that finished. A failed one is paced by the cool-off
 * alone, and a lease that ran out with no report by the lease alone.
 */
export function sameDayGapMinutes() {
  return minutes("WARMUP_SAME_DAY_GAP_MINUTES", 60);
}

/**
 * How many profile views are kept back from a session so that a later one the
 * same day has them to start with.
 *
 * The agent works views, likes, invitations, in that order, and a run carries
 * `MAX_INVITES_PER_RUN` requests. On a day that allows more than that — working
 * mode's 10–15 — the rest go in a second session, and a first session that
 * spent every view left that one nothing to do before its first Connect. So
 * the first session is handed all but two of the day's views, and every
 * session after it starts with the two, however many requests the first one
 * managed to send: kept back only while today's views done are short of
 * `quota − 2`. Read off what was sent instead, a first session that failed
 * after three requests kept them held, and the session after it opened on a
 * Connect.
 *
 * Only when a later session for requests is really coming: the day allows
 * more than one run's worth (`connectQuota`, the day's figure), and there are
 * more than one run's worth of requests the hand-off can send today
 * (`requestsAhead`): the waiting rows it would give out, up to the connects
 * still left today, plus what the folder may still add — the figure `dueFrom`
 * wakes the account on as `invites`. With fewer, one session sends them all,
 * and two views kept for nothing would wake the account again just for them.
 * Counted without that cap, fifteen people waiting on a day a seller had
 * already sent five of fourteen by hand kept two views back from a session
 * that sent everything the day had left — and the account was opened again
 * an hour later for two views. A day with fewer than four views keeps none:
 * two views are not worth thinning a session that small.
 *
 * Asked from the day's counters and the people waiting — the same rows the
 * scheduler and `GET /agent` both read — so the two cannot disagree about it,
 * and a restart forgets nothing. The day's totals never pass the quotas: the
 * views kept back are the day's own, and `checkQuota` never refuses one.
 *
 * **Exported because there are two callers and there must be one answer**,
 * like `upkeepFor`: an account woken for views `GET /agent` then held back is a
 * browser opened for nothing. `viewsHeldBackFor` asks it for one account.
 */
export const VIEWS_HELD_BACK = 2;
const MIN_VIEWS_TO_HOLD_BACK = 4;

export function viewsHeldBack({ viewQuota, viewsDone, connectQuota, requestsAhead }) {
  const views = Number(viewQuota) || 0;
  return views >= MIN_VIEWS_TO_HOLD_BACK
    && (Number(viewsDone) || 0) < views - VIEWS_HELD_BACK
    && (Number(connectQuota) || 0) > MAX_INVITES_PER_RUN
    && (Number(requestsAhead) || 0) > MAX_INVITES_PER_RUN
    ? VIEWS_HELD_BACK
    : 0;
}

/**
 * The invitation work one account has people for today: the waiting rows the
 * hand-off would give out (`waiting`, already cut by `sendableToday`), and how
 * many its campaigns' folders may still add (`fromFolder`, the top-up's own
 * sum — see `folderWork`). `left` is today's connects not yet spent, and
 * `invites` what the hand-off can really send today: the waiting rows up to
 * `left`, plus the folder's share (which `folderWork` already cuts by it).
 *
 * One sum for `dueFrom` and `viewsHeldBackFor`, so the account the poll wakes
 * and the plan `GET /agent` hands it are counted from the same people.
 */
function peopleToday({ waiting = 0, claimed = 0, feeds, day, connectQuota, connectsDone, fedToday = 0 }) {
  const left = Math.max(0, connectQuota - connectsDone);
  const fromFolder = folderWork({ feeds, day, left, waiting, claimed, quota: connectQuota, fedToday });
  return { left, waiting, fromFolder, invites: Math.min(waiting, left) + fromFolder };
}

/**
 * `viewsHeldBack` for one account, from the rows `candidates()` reads for
 * every account: its waiting rows and claims (`heldCounts`), its folders
 * (`folderFeeds`, bounded like the poll's) and what the folder already added
 * today. The people are read only when the counters leave the answer open —
 * most days and most sessions they do not.
 */
export async function viewsHeldBackFor({
  account, run, campaigns = [], viewQuota, viewsDone, connectQuota, connectsDone, now = new Date()
}) {
  const counters = { viewQuota, viewsDone, connectQuota };
  if (!viewsHeldBack({ ...counters, requestsAhead: Infinity })) return 0;

  const nowMs = now.getTime();
  const todayIso = today();
  const day = dayOfRun(run, now);
  const { waiting, claimed } = await heldCounts([account.id], {
    claimsSince: claimCutoff(nowMs), todayIso, dayOf: new Map([[account.id, day]]), fromDayOf: fromDayLookup(campaigns)
  });
  const feeds = await boundedFolderFeeds({ campaigns, runs: [run], nowMs, todayIso });
  const fedToday = (await folderAddedToday([account.id], todayIso)).get(account.id) ?? 0;
  const people = peopleToday({
    waiting: waiting.get(account.id) ?? 0,
    claimed: claimed.get(account.id) ?? 0,
    feeds: feeds.get(account.id),
    day,
    connectQuota: Number(connectQuota) || 0,
    connectsDone: Number(connectsDone) || 0,
    fedToday
  });
  return viewsHeldBack({ ...counters, requestsAhead: people.invites });
}

/**
 * How long the poll waits for the campaign folders before it answers without
 * them. The folder check is the one read in the poll that leaves this
 * database for the CRM, and `fetch` has no timeout of its own: a CRM that
 * hangs would hang `/agent/due` and `/agent/lease` with it, and a worker that
 * gives up on a lease the server already granted leaves the account held by
 * nobody for a whole lease. Five seconds is many times a normal walk.
 */
export function folderCheckMs() {
  const parsed = Number(process.env.WARMUP_FOLDER_CHECK_SECONDS);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 5) * 1000;
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

/**
 * Which accounts have already been given their chance at today's inbox read.
 *
 * The read is a reason to open a browser, and like every other reason it needs
 * a bound — here the one the read itself cannot provide. An agent that does
 * not read the inbox (an older build, selectors that broke) never writes
 * `inbox.done`, so "not read today" would stay true all morning and the
 * account would be handed out every few minutes to do nothing. So a session
 * that was handed the account with the read owing, and came back saying it
 * finished, spends the day's wake for it: the read stays owing, and the agent
 * is still told so if the account is opened for anything else, but it does
 * not open a browser on its own again until tomorrow. In memory for the same
 * reason the cool-off is: a restart forgets one wasted wake at most.
 */
const inboxOffered = new Map();

/**
 * Each account's last session: the date it was handed out on, and — once it
 * reported that it finished — when it ended.
 *
 * Two uses, both about the same morning. An account that has already had a
 * session today goes after every account that has not: working mode's second
 * session is the one kind of work that can wait an hour, and a warming
 * account whose day counts by the calendar cannot get its day back. And the
 * same account is not handed out again until `sameDayGapMinutes` after a
 * session that finished.
 *
 * Only one that finished. A failed session has the cool-off, which is what its
 * log line promises; an hour's rest on top overrode any cool-off shorter than
 * it and made that line wrong. A lease that runs out with nobody reporting
 * costs the lease and nothing more — a dead worker is not a visit LinkedIn
 * watched end.
 *
 * In memory for the same reason the cool-off is. A restart forgets the gap —
 * one early second session at most — but not the order: today's counters
 * also say an account has been worked today (`dueFrom`).
 */
const lastSession = new Map();

function isoDateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Taken: worked today, and no rest owed until it says it finished. */
function noteSessionStarted(lease) {
  lastSession.set(lease.accountId, { date: isoDateOf(lease.grantedAt), endedAt: null });
}

function noteSessionFinished(accountId, nowMs) {
  lastSession.set(accountId, { date: isoDateOf(nowMs), endedAt: nowMs });
}

/** When this account may be handed out again after its last finished session, or 0. */
export function restingUntil(accountId) {
  const endedAt = lastSession.get(accountId)?.endedAt;
  return endedAt ? endedAt + sameDayGapMinutes() * 60_000 : 0;
}

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
  noteSessionStarted(lease);
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

// What the panels show as the next session has to agree with what this module
// will actually hand out, so they read the same holds.
readHoldsFrom((accountId) => Math.max(restingUntil(accountId), coolOffUntil(accountId)));

/** Tests only — the process itself clears this by restarting. */
export function resetScheduler() {
  leases.clear();
  coolingOff.clear();
  inboxOffered.clear();
  lastSession.clear();
  folderCheckFailing = false;
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
 *
 * **Exported because there are two callers and there must be one answer.** The
 * scheduler decides who to wake; the semaphore tells the agent what to do when
 * it arrives. A second copy of this arithmetic that drifted would wake an
 * account by one rule and hand it an empty list by the other — a browser opened
 * for nothing, which is the exact failure upkeep exists to prevent.
 */
export function upkeepFor({ accountId, inPlan, pendingInvites, openConversations, checkedToday, inboxSyncedToday }) {
  // Invitations are checked on any day, in or out of plan: a sent request can
  // be accepted on a day this account happens to owe nothing else, and "every
  // day" was the ask.
  const checks = checkedToday?.has(accountId) ? 0 : Math.min(pendingInvites?.get(accountId) ?? 0, MAX_INVITE_CHECKS_PER_RUN);

  // The inbox is read once a day, on every day the account has a plan —
  // warming or working. What people wrote back is copied to their CRM contact
  // from that read, so "once a day" is a promise to the sales team, and it
  // used to be kept only by accident: the agent read at the end of whatever
  // sessions it happened to be given, which could be three a morning or none.
  // Now "not read today" is a reason of its own, and `inbox.done` is what
  // settles it. Inside the plan this costs no extra session on an ordinary
  // day, because the day's views open the browser anyway and the read rides
  // along; it only wakes an account whose other work was done without it.
  //
  // Out of plan — only a snapshot with no working mode to fall back on — it
  // still needs evidence. "We have not read it today" is a statement about us;
  // an account that approached nobody has nobody who could have written, and
  // opening a browser daily forever to find an empty inbox is exactly the
  // allowance-instead-of-evidence mistake this whole rule exists to prevent.
  //
  // A pause is not here because it never reaches here: both callers answer
  // "nothing at all" before asking.
  const inbox = !inboxSyncedToday?.has(accountId)
    && (inPlan || (openConversations?.get(accountId) ?? 0) > 0);

  return { checks, inbox, any: checks > 0 || inbox };
}

export function dueFrom({
  accounts, runs, dayActions, openProfiles, invitesWaiting, invitesClaimed, folderFeeds: feedsByAccount,
  folderAdded, pendingInvites, openConversations, checkedToday, inboxSyncedToday, weeklyConnects,
  todayIso, nowMs = Date.now()
}) {
  const runByAccount = new Map((runs ?? []).map((row) => [row.account_id, row]));

  // Summed per kind, never last-row-wins. There is no unique index on
  // (run, date, kind), so two writers that both found no row each insert one,
  // and each row carries its own writer's count — `commitAction` adds to the
  // oldest from then on. The day's total is the sum, which is what
  // `checkQuota` refuses by; read any other way the poll saw connects the
  // quota had already spent and woke the account all morning to be handed
  // nothing. Only the run being asked about counts: a row a stopped run left
  // today is not this run's day.
  const doneByAccount = new Map();
  for (const row of dayActions ?? []) {
    const live = runByAccount.get(row.account_id);
    if (row.run_id && live && row.run_id !== live.id) continue;
    const perKind = doneByAccount.get(row.account_id) ?? new Map();
    perKind.set(row.kind, (perKind.get(row.kind) ?? 0) + (Number(row.done) || 0));
    doneByAccount.set(row.account_id, perKind);
  }

  const ready = [];
  const held = [];
  const busy = [];
  for (const account of accounts ?? []) {
    const run = runByAccount.get(account.id);
    if (!run) continue;
    // Nothing at all while a pause holds — not the quota, not the invitations
    // to look at, not the inbox. "Stop all actions" after a warning means the
    // browser stays shut, and a session opened only to read messages is still
    // a session. The day after `paused_until` the account is due again by
    // every rule below, whatever its row still says.
    if (pausedOn(run, todayIso)) continue;

    // The clock comes from the caller, like every other time in this function.
    // Left to default, `currentDay` read the wall clock while `nowMs` and
    // `todayIso` were pinned — so which day of the plan an account is on
    // depended on the date the suite happened to run, and a test written on the
    // day it passed went red the following week. A decision function takes its
    // time as an argument. The dates after a pause that nobody took the
    // account on count as paused, not as progress — see `pausedDaysOn`.
    const day = dayOfRun(run, new Date(nowMs));
    // Past the last phase is working mode, and that is still a plan: views,
    // likes and 10–15 requests a day, the same arithmetic as any warming day.
    // Only a snapshot with no working mode to fall back on is out of plan —
    // and even that may still be holding invitations nobody has looked at and
    // replies nobody has read, which do not end when the plan does.
    const inPlan = hasPlanOn(run.strategy_snapshot, day);
    const mode = inWorkingMode(run.strategy_snapshot, day) ? "working" : "warmup";

    const done = doneByAccount.get(account.id);
    const connectsDone = done?.get("connect") ?? 0;
    const connectQuota = inPlan ? connectCeiling(
      dailyQuota(run.strategy_snapshot, account.id, day, "connect"), connectsDone,
      weeklyConnects?.get(account.id) ?? connectsDone
    ) : 0;

    // Invitations are work only when there is somebody to invite. The evidence
    // is a waiting row, not an unspent allowance: an account with five connects
    // left and nobody queued owes nothing, and waking it would open a browser
    // to do nothing at all. Bounded by the allowance too, so an account is
    // never handed more invitations than it may send today.
    //
    // Counted against what was actually sent today, not against sessions: a
    // run hands over at most MAX_INVITES_PER_RUN (10), and working mode allows
    // up to 15. The account that sent ten this morning is due again, for the
    // rest and the views kept for it, once it has rested.
    //
    // A campaign's folder is evidence too, from its `fromDay` on: somebody is
    // there to invite, and the agent's `GET /agent` after taking the account
    // writes them down as waiting.
    // Counted by the same sum the top-up fills by (`folderWork` is
    // `folderRoom` over what the folder can offer), so an account woken for
    // its folder is never handed an empty list — which would be a browser
    // opened for nothing every few minutes, for as long as the room lasted.
    // That sum includes the day's cap: an account the folder has already fed
    // twice its quota today is not woken for the folder again.
    const { invites } = peopleToday({
      waiting: invitesWaiting?.get(account.id) ?? 0,
      claimed: invitesClaimed?.get(account.id) ?? 0,
      feeds: feedsByAccount?.get(account.id),
      day,
      connectQuota,
      connectsDone,
      fedToday: folderAdded?.get(account.id) ?? 0
    });

    // The views kept for a later session today are not this one's work, by
    // the same rule `GET /agent` cuts its plan by: an account woken for them
    // now would be handed a plan without them.
    const viewQuota = inPlan ? dailyQuota(run.strategy_snapshot, account.id, day, "profile_view") : 0;
    const heldBack = viewsHeldBack({
      viewQuota,
      viewsDone: done?.get("profile_view") ?? 0,
      connectQuota,
      requestsAhead: invites
    });
    const kinds = [];
    let remaining = 0;
    for (const kind of inPlan ? AGENT_KINDS : []) {
      const quota = dailyQuota(run.strategy_snapshot, account.id, day, kind) - (kind === "profile_view" ? heldBack : 0);
      const left = Math.max(0, quota - (done?.get(kind) ?? 0));
      if (left > 0) kinds.push(kind);
      remaining += left;
    }

    if (invites > 0) {
      kinds.push("connect");
      remaining += invites;
    }

    const upkeep = upkeepFor({ accountId: account.id, inPlan, pendingInvites, openConversations, checkedToday, inboxSyncedToday });
    // Upkeep is counted apart from `remaining` on purpose: `remaining` is the
    // day's quota and paces the worker, and a check spends none of it. An
    // account can be due on upkeep alone, with `remaining: 0`.
    //
    // The inbox wakes an account once a day at most (`inboxOffered`); after
    // that it is still owed, and still said in `upkeep`, but it is not a
    // reason on its own.
    const wakesForInbox = upkeep.inbox && inboxOffered.get(account.id) !== todayIso;
    if (remaining <= 0 && upkeep.checks <= 0 && !wakesForInbox) continue;

    if (openProfiles?.has(account.profile_remote_id)) {
      busy.push({ account, run, day, mode, remaining, kinds, invites, upkeep });
      continue;
    }

    const until = coolingOff.get(account.id) ?? 0;
    if (until > nowMs) {
      held.push({ account, run, day, mode, remaining, kinds, invites, upkeep, until });
      continue;
    }
    // Expiry rather than presence: a lease is swept by the tick and by the
    // decision, but an account whose lease simply ran out is available again
    // even if nothing has got round to deleting it yet.
    if ((leases.get(account.id)?.expiresAt ?? 0) > nowMs) continue;

    // Its last session finished less than `sameDayGapMinutes` ago: whatever is
    // left waits. Said like the cool-off, so a morning where this is the only
    // thing left reads as "resting", not as a stuck account.
    const rest = restingUntil(account.id);
    if (rest > nowMs) {
      held.push({ account, run, day, mode, remaining, kinds, invites, upkeep, until: rest, resting: true });
      continue;
    }

    // Worked today: handed out earlier this morning, or anything counted
    // today — which a restart does not forget.
    const workedToday = lastSession.get(account.id)?.date === todayIso
      || [...(done?.values() ?? [])].some((value) => value > 0);

    ready.push({ account, run, day, mode, remaining, kinds, invites, upkeep, workedToday });
  }

  // First sessions before second ones, then warming before upkeep, then
  // oldest run first. One account runs at a time inside a four-hour window,
  // and the day of a warming account counts by the calendar whether or not it
  // got a session. Working mode's leftover requests — the oldest runs, so
  // first by age alone — used to take the morning's sessions from accounts
  // that had not had one at all. An account that only needs looking after
  // must not take a session from one that still has a plan to follow either:
  // its work keeps until tomorrow, and the plan does not.
  ready.sort((a, b) =>
    Number(a.workedToday) - Number(b.workedToday)
    || Number(b.remaining > 0) - Number(a.remaining > 0)
    || Date.parse(a.run.started_at) - Date.parse(b.run.started_at));
  held.sort((a, b) => a.until - b.until);
  return { ready, held, busy };
}

async function candidates(todayIso, nowMs, campaigns = []) {
  const accounts = await anty.from("wl_accounts").select("*")
    // `restricted` too: that is what a warning leaves behind, and nothing
    // writes it back when the pause runs out. `dueFrom` skips the ones whose
    // pause still holds.
    .in("status", LIVE_ACCOUNT_STATUSES)
    // Health is the persistent half of "do not keep trying this one": an
    // account that needs a login or is sitting on a checkpoint needs a person,
    // and handing it out every five minutes only teaches LinkedIn our schedule.
    .eq("health", "ok")
    .notNull("profile_remote_id")
    .rows();
  if (!accounts.length) return { ready: [], held: [], busy: [] };

  const ids = accounts.map((account) => account.id);
  const profileIds = accounts.map((account) => account.profile_remote_id);
  const runs = await anty.from("wl_runs").select("*").in("account_id", ids).in("state", LIVE_RUN_STATES).rows();
  // By run, like `checkQuota`: the counters of a run that was stopped today
  // are not the day of the run that replaced it.
  const dayActions = runs.length
    ? await anty.from("wl_day_actions").select("account_id,run_id,kind,done")
      .in("run_id", runs.map((run) => run.id)).eq("on_date", todayIso).rows()
    : [];
  // A deleted profile can still carry the status it had when it went, so it is
  // not open anywhere — the same reading the sessions sync already takes.
  const profiles = await anty.from("anty_browser_profiles").select("id,status,is_deleted").in("id", profileIds).rows();
  const openProfiles = new Set(
    profiles.filter((profile) => profile.status === "running" && !profile.is_deleted).map((profile) => profile.id)
  );
  // Who is holding somebody for an invitation, and who holds claims a person
  // took to send by hand. One query for every account, not one per account:
  // this runs on every worker poll. Only what the hand-off would give out
  // today is counted — not a row held today, not a parked one, and not a
  // folder's row before its campaign's `fromDay` — see `sendableToday`. So
  // the day each account is on goes in, read off the same clock as `dueFrom`.
  const dayOf = new Map(runs.map((run) => [run.account_id, dayOfRun(run, new Date(nowMs))]));
  const { waiting: invitesWaiting, claimed: invitesClaimed } = await heldCounts(ids, {
    claimsSince: claimCutoff(nowMs), todayIso, dayOf, fromDayOf: fromDayLookup(campaigns)
  });
  // What each running campaign's folder could still offer the accounts it
  // feeds today, and how much of the day's cap each account has already had.
  // Only read, never taken: the poll takes nothing. Bounded, because it is
  // the CRM's answer and not ours — see `folderCheckMs`.
  const feeds = await boundedFolderFeeds({ campaigns, runs, nowMs, todayIso });
  const folderAdded = await folderAddedToday(ids, todayIso);
  const weeklyConnects = await weeklyConnectCounts(ids, todayIso);
  // The upkeep evidence: what is outstanding, and what has already been done
  // today. Three queries for every account rather than three per account.
  const [pendingInvites, openConversations, checkedToday, inboxSyncedToday] = await Promise.all([
    pendingCounts(ids),
    openConversationCounts(ids),
    checkedTodayAccounts(ids, todayIso),
    syncedTodayAccounts(ids, todayIso)
  ]);

  return dueFrom({
    accounts, runs, dayActions, openProfiles, invitesWaiting, invitesClaimed, folderFeeds: feeds, folderAdded,
    pendingInvites, openConversations, checkedToday, inboxSyncedToday, weeklyConnects, todayIso, nowMs
  });
}

/**
 * Whether the last folder check went wrong, so an outage is said once on the
 * console rather than on every poll — every few minutes all morning — and
 * said again only after a clean check and a new failure.
 */
let folderCheckFailing = false;
const TIMED_OUT = Symbol("timed out");

function noteFolderCheck(problem) {
  if (problem && !folderCheckFailing) {
    console.error("[warmup] folder check: campaign folders count as empty until the CRM answers again —", problem);
  }
  folderCheckFailing = Boolean(problem);
}

/**
 * `folderFeeds`, or no folder at all when the CRM does not answer in time.
 *
 * Counted as empty for this poll, which costs at most the folder's share of
 * a wake — the waiting rows, the views, the likes and the inbox are all
 * still counted, and the next poll asks again. The walk that lost the race is
 * left to finish on its own; it only reads.
 */
async function boundedFolderFeeds(args) {
  const problems = [];
  const walk = folderFeeds({
    ...args,
    onError: (campaign, error) => problems.push(`"${campaign.name}": ${error.message}`)
  });
  // Handled from the start: a walk that fails after losing the race has
  // nobody waiting for it, and must not surface as an unhandled rejection.
  walk.catch(() => {});
  const limitMs = folderCheckMs();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), limitMs);
    timer.unref?.();
  });
  try {
    const feeds = await Promise.race([walk, timeout]);
    if (feeds === TIMED_OUT) throw new Error(`no answer in ${limitMs / 1000} s`);
    // A folder that failed on its own already counts as empty; the others
    // keep what they answered.
    noteFolderCheck(problems.length ? problems.join("; ") : null);
    return feeds;
  } catch (error) {
    noteFolderCheck(error.message);
    return new Map();
  } finally {
    clearTimeout(timer);
  }
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
export async function decideNext({ now = new Date(), random = Math.random, campaigns = [] } = {}) {
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

  const { ready, held, busy } = await candidates(today(), nowMs, campaigns);
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
  if (cooling?.resting) return `${cooling.account.label} is resting between sessions`;
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
    // "warmup" or "working" — past the last phase the day keeps counting and
    // this says which of the two it is counting in.
    mode: pick.mode ?? "warmup",
    remaining: pick.remaining,
    kinds: pick.kinds,
    // What is owed that is not the day's quota: invitations to look at, and
    // whether the inbox has been read today. An account can be handed over with
    // `remaining: 0` and one of these set.
    upkeep: pick.upkeep ?? { checks: 0, inbox: false, any: false },
    // How many of `remaining` are invitations — waiting ones, and the ones a
    // campaign's folder will add when the agent asks `GET /agent`. A worker
    // that sees `connect` in `kinds` still has to ask `/agent` for who they
    // are; this is so the log line says "3 views, 2 invitations" rather than
    // "5 things".
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
export async function leaseAccount({ accountId, now = new Date(), random = Math.random, campaigns = [] }) {
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

  const { ready, held, busy } = await candidates(today(), nowMs, campaigns);
  // Asked again after the reads and before the grant, with no await between
  // the two. The check above ran before `candidates`, which is a dozen round
  // trips and a folder walk; a second worker taking another account in that
  // time is not something `dueFrom` sees — it only leaves out the account
  // the lease is on — so both would have been granted and two profiles
  // opened at once.
  const raced = activeLease(nowMs);
  if (raced) {
    return refuse(`${raced.label} is already running`, secondsUntil(raced.expiresAt, nowMs));
  }
  const pick = ready.find((item) => item.account.id === accountId);
  if (!pick) {
    const mine = (list) => list.find((item) => item.account.id === accountId);
    // Not an error on the worker's part: it asked for what it was shown, and
    // the answer moved underneath it. It polls again like any other refusal.
    return refuse(blockedReason(mine(busy), mine(held), "that account does not owe work right now"), between(IDLE, random));
  }

  const lease = grantLease(pick.account, nowMs);
  // Remembered on the lease, so the report that ends it can say whether this
  // session was the day's chance at the inbox (`inboxOffered`).
  lease.inboxDue = Boolean(pick.upkeep?.inbox);
  // An account handed out the first time after a pause: write down that the
  // pause is over. Here rather than in the poll, because the poll takes
  // nothing and must write nothing; and it does not matter which of the two
  // sees the expiry first, because the account is due either way and the
  // write is conditional.
  await settlePause(pick.account, pick.run, today());
  await logEvent({
    accountId: pick.account.id,
    runId: pick.run.id,
    type: "scheduler.started",
    message: `Handed to a worker — ${pick.mode === "working" ? "working mode, " : ""}day ${pick.day}, ${pick.remaining} action(s) left today`,
    meta: { day: pick.day, mode: pick.mode ?? "warmup", remaining: pick.remaining, kinds: pick.kinds, leaseId: lease.leaseId }
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
  const { released, held } = releaseLease(account.id, leaseId);
  // The rest before the same account's next session counts from here, and only
  // for a session that finished: a failed one gets the cool-off below and
  // nothing added to it. A report for a lease that has already run out is
  // still a session that ended now. One for somebody else's live lease is not:
  // that run's own report will say when it ended.
  if (ok && (released || !held)) noteSessionFinished(account.id, nowMs);
  // A session handed the inbox read that finished has had its chance today,
  // read or not. Only a finished one: a failed session is cooled off and may
  // be woken again for the read once the cool-off ends.
  if (ok && released && held?.inboxDue) inboxOffered.set(account.id, now.toISOString().slice(0, 10));

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
