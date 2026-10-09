import { withAccountQuota } from "./store.mjs";
import { connectCeiling, weeklyAllowance, weeklyConnectAllowance, weeklyConnectCounts } from "./weekly.mjs";
import { anty, crm, CONTACT_ID_BATCH, antyTeamId, crmError, leadById, queueTotal, today } from "./db.mjs";
import { RestError } from "./rest.mjs";
import {
  ACTION_KINDS, ACTION_LABEL, DEFAULT_STRATEGY, dayOfRun, hasPlanOn, inWorkingMode, noteRuleOn, noteUnderRule,
  pausedDaysOn, pausedOn, planForDay, resumeCredit, runDay, totalDays, validateStrategy, workingModeOf, currentDay, fromDays, nextNoteDay, noteAllowedOnDay, toDays
} from "./strategy.mjs";
import { SESSION_WINDOW, insideWindow, nextSession, windowLabel } from "./schedule.mjs";
import { HEALTH_LABEL, HEALTH_VALUES, deriveStatus, isHealth, pauseCause } from "./status.mjs";
import { PLATFORMS, parseProxy, platformOf, proxyString, retag } from "./platform.mjs";
import { CLAIM_STATUS, OUTREACH_COLUMNS, OUTREACH_STATUSES, describeClaim, describeOutreach, personSnapshot, sentBy } from "./outreach.mjs";
import {
  ACCEPTED_STATUS, INVITE_HELD_OUTCOMES, INVITE_OUTCOMES, INVITE_PERSON_OUTCOMES, MAX_INVITES_PER_RUN, MAX_INVITE_CHECKS_PER_RUN,
  OUTREACH_SENT, WAITING_STATUS, cancelInvite, copyRequestToCrm, fedInvites, folderAddedToday,
  heldCounts, heldRetryAnswer, describeInvite, inviteEvents, invitesToCheck, invitesToSend, lastCheckedAt as invitesLastCheckedAt,
  checkedTodayAccounts, moveStatus, openConversationCounts, outreachForContact, pendingCounts,
  reassignInvite, recordCheck, recordFailed, recordSent, releaseFedInvite, requestInvite, waitingFacts
} from "./invites.mjs";
import { antyTimestampToIso, describeSession, durationMin } from "./sessions.mjs";
import { encryptSecret, secretsConfigured } from "./secretbox.mjs";
import { RECHECK_DONE, RECHECK_REQUESTED, issueLoginCheck, readLoginCheck } from "./login-check.mjs";
import {
  activeRun, checkQuota, commitAction, connectQuotaToday, describeAccount, ensureDefaultStrategy, heldUntil,
  latestWarnings, logEvent, loadAccount, loginIdentities, newestRun, openSession, pauseForWarning, probeEventWriteAccess, recordAction,
  toStrategy
} from "./store.mjs";
import {
  describeTargeting, folderNameOf, forecastFor, listFolders, normalizeFilters
} from "./targeting.mjs";
import {
  AUDIT_HIDDEN_TYPES, MAX_THREADS_PER_RUN, adoptWaitingThreads, lastSyncedAt, listThreads, markRead, markSynced, normalizeThreadInput,
  messagesForContact, outreachFor, readThread, retryCrmCopies, storeThread, summarizeAccounts, syncSummary,
  syncedTodayAccounts, threadKeyOf, unreadCount
} from "./inbox.mjs";
import {
  REPLY_LIMIT, cancelReply, markReplyFailed, markReplySent, prepareReply, queueReply, repliesOf, repliesToSend, visibleReplies
} from "./outbox.mjs";
import { activeLease, decideNext, finishRun, leaseAccount, upkeepFor, viewsHeldBackFor } from "./scheduler.mjs";
import {
  DEFAULT_FROM_DAY, allowanceReason, claimCapacity, claimCutoff, defaultFilters, describeCampaign, feedingFor,
  folderRoom, fromDayLookup, isCampaignState, migrateCampaigns, moveTo, nextOrder, normalizeCampaign, parseFromDay,
  progressApproximate, progressFrom, renumber, runningFor, targetingOf
} from "./campaigns.mjs";
import { nextCandidates, takeFromCampaigns } from "./feed.mjs";

/**
 * The warm-up's HTTP surface, mounted under /api/warmup.
 *
 * Every route here sits behind the workspace sign-in the rest of the app
 * already enforces. That matters: the standalone portal this was ported from
 * held a service-role key and could only be safe by binding to 127.0.0.1.
 */

const AGENT_SESSION_MAX_MS = 2 * 60 * 60 * 1000;

function fail(response, sendJson, status, error) {
  sendJson(response, status, { success: false, error });
  return true;
}

/** A refusal, worded and shaped identically wherever it came from. */
function refusal(response, sendJson, outcome) {
  sendJson(response, outcome.status, {
    success: false,
    error: outcome.error,
    ...(outcome.quota === undefined ? {} : { quota: outcome.quota, done: outcome.done })
  });
  return true;
}

function intParam(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

async function setAccountStatus(accountId, status) {
  await anty.from("wl_accounts").update({ status, updated_at: new Date().toISOString() }).eq("id", accountId).rows();
}

/**
 * The first day this strategy allows a connection request. An empty column on
 * day 2 reads as broken; it is not, the plan forbids requests for three days.
 * Only while that day is still ahead — "from day 4" on day 9 would be a lie.
 */
function connectStartsDay(run) {
  const phases = run?.strategy_snapshot?.phases;
  if (!run || !phases?.length) return null;
  const first = phases.find((phase) => Array.isArray(phase.quotas?.connect) && phase.quotas.connect[1] > 0);
  if (!first) return null;
  const day = dayOfRun(run);
  return day < first.fromDay ? first.fromDay : null;
}

function phaseOf(account, run) {
  return account.status === "excluded" ? "excluded"
    : !run || run.state === "stopped" ? "idle"
    : run.state === "completed" ? "finished"
    : run.paused_until && run.paused_until >= today() ? "paused"
    : "warming";
}

/** A claimed or sent person, with only the columns a queue has any use for. */
const CLAIM_COLUMNS =
  "id,account_id,crm_contact_id,person_name,person_company,person_position,person_linkedin,status,created_at";

/**
 * Which of these contacts sit in this folder.
 *
 * An outreach row carries no campaign id — it cannot, without a migration — so
 * this is how a row is attributed to a campaign: its account worked the row,
 * and the folder holds the person.
 */
async function contactsInFolder(folderId, contactIds) {
  const found = new Set();
  for (let start = 0; start < contactIds.length; start += CONTACT_ID_BATCH) {
    const rows = await crm.from("contacts").select("id")
      .eq("folder_id", folderId).in("id", contactIds.slice(start, start + CONTACT_ID_BATCH)).rows();
    for (const row of rows) found.add(row.id);
  }
  return found;
}

/**
 * How many connection requests each of these accounts has actually sent today.
 *
 * Read from the warm-up's own day counter rather than from the outreach rows: a
 * row claimed yesterday and sent this morning still carries yesterday's
 * `created_at`, and the day counter is the number the quota is checked against,
 * so it cannot disagree with what an account was allowed.
 */
async function connectDoneToday(accountIds) {
  const done = new Map(accountIds.map((id) => [id, 0]));
  if (!accountIds.length) return done;

  const runs = await anty.from("wl_runs").select("id,account_id,started_at")
    .in("account_id", accountIds).in("state", ["running", "paused"])
    .order("started_at", { ascending: false }).rows();

  const accountByRun = new Map();
  const seen = new Set();
  for (const run of runs) {
    // Newest first, so the first run seen for an account is its live one.
    if (seen.has(run.account_id)) continue;
    seen.add(run.account_id);
    accountByRun.set(run.id, run.account_id);
  }
  if (!accountByRun.size) return done;

  const rows = await anty.from("wl_day_actions").select("run_id,done")
    .in("run_id", [...accountByRun.keys()]).eq("on_date", today()).eq("kind", "connect").rows();
  for (const row of rows) {
    const accountId = accountByRun.get(row.run_id);
    if (accountId) done.set(accountId, (done.get(accountId) ?? 0) + (Number(row.done) || 0));
  }
  return done;
}

/**
 * What this account is allowed to send today, and why.
 *
 * Asked through `checkQuota` — the same call the send itself makes — so a claim
 * can never allocate work the send would refuse. Nothing here writes: quota is
 * spent when something is sent, never when it is claimed.
 */
async function connectAllowance(account) {
  if (account.status === "excluded") return { blocked: "Excluded from warm-up" };
  if (account.health !== "ok") return { blocked: `Account health: ${HEALTH_LABEL[account.health] ?? account.health}` };

  const run = await activeRun(account.id);
  if (!run) return { blocked: "No warm-up in progress" };
  // `paused` so a caller can tell "stop everything" from "no requests today":
  // the first one also holds back the checks, which cost no allowance.
  if (pausedOn(run, today())) return { blocked: `Paused until ${run.paused_until}`, paused: true };

  const allowance = await checkQuota(account, run, "connect", 1);
  const day = dayOfRun(run);
  return {
    run,
    day,
    totalDays: totalDays(run.strategy_snapshot),
    // Past the last phase: still sending, at the working-mode rate.
    working: inWorkingMode(run.strategy_snapshot, day),
    // A refusal for a day with no requests planned carries no quota, because
    // there is none: zero is the whole answer, not a missing one.
    quota: allowance.quota ?? 0,
    spent: allowance.ok ? allowance.done - allowance.step : allowance.done ?? 0,
    startsDay: connectStartsDay(run),
    weekly: allowance.weekly ?? null
  };
}

/**
 * What this run has done today, per kind.
 *
 * Summed per kind, the way `checkQuota` counts the day: two writers that both
 * found no row each insert one with their own count. Read last-row-wins, the
 * plan offered connects the quota had already spent.
 */
async function doneToday(run) {
  const rows = await anty.from("wl_day_actions").select("kind,done").eq("run_id", run.id).eq("on_date", today()).rows();
  const doneByKind = new Map();
  for (const row of rows) doneByKind.set(row.kind, (doneByKind.get(row.kind) ?? 0) + (Number(row.done) || 0));
  return doneByKind;
}

/**
 * The views `GET /agent`'s plan keeps back from this run today, asked with
 * the plan's own quotas and today's counters — the one rule the scheduler
 * counts by (`viewsHeldBackFor`). `viewsDone` is passed in: the plan counts
 * what was done before the session, a recorded view what was done before it.
 */
async function heldBackViews(account, run, campaigns, { day, viewsDone, doneByKind }) {
  const { quotas } = planForDay(run.strategy_snapshot, account.id, day);
  const weekly = await weeklyConnectAllowance(account.id);
  quotas.connect = connectCeiling(quotas.connect, doneByKind.get("connect") ?? 0, weekly.done);
  return viewsHeldBackFor({
    account, run, campaigns,
    viewQuota: quotas.profile_view,
    viewsDone,
    connectQuota: quotas.connect,
    connectsDone: doneByKind.get("connect") ?? 0
  });
}

/**
 * The note rule for the day an allowance is about: the phase's
 * `connectionNote`, or `false` when nothing may be sent at all. Read from the
 * same allowance the send list is cut by, so the list and its notes are
 * decided by one day, not two.
 */
function noteRuleFor(allowance) {
  return allowance.blocked || !allowance.run ? false : noteRuleOn(allowance.run.strategy_snapshot, allowance.day);
}

/**
 * One invitation as a screen sees it, with the account-level facts filled in.
 *
 * `lastCheckedAt` belongs to the account, not to the person: a check is one
 * pass over the whole board and its event names no contact. Looked for among
 * the person's own events it was null forever, and the line that says when we
 * last looked never appeared.
 *
 * Whether it is parked is asked the way the hand-off asks it (`waitingFacts`),
 * so the card and the agent cannot disagree about it.
 */
async function inviteView(row, events = []) {
  if (!row) return null;
  const parked = row.status === WAITING_STATUS && (await waitingFacts([row])).parked.has(String(row.id));
  return describeInvite(row, events, { checkedAt: await invitesLastCheckedAt(row.account_id), parked });
}

/**
 * What this account owes that is not the day's quota.
 *
 * The same rule the scheduler decides by, asked per account: invitations are
 * checked on any day once a day, and the inbox is read once a day on every day
 * the account has a plan — warming or working — see `upkeepFor`.
 */
async function upkeepWorkFor(account, run, { now = new Date() } = {}) {
  const todayIso = today();
  // Asked exactly as `dueFrom` asks it: a pause is nothing at all, upkeep
  // included, so the account the scheduler would not wake is not handed
  // anything to do if it arrives anyway.
  if (!run || pausedOn(run, todayIso)) return { checks: 0, inbox: false, any: false };
  const [pendingInvites, openConversations, checkedToday, inboxSyncedToday] = await Promise.all([
    pendingCounts([account.id]),
    openConversationCounts([account.id]),
    checkedTodayAccounts([account.id], todayIso),
    syncedTodayAccounts([account.id], todayIso)
  ]);
  // The clock is an argument here too. It does not matter for a request served
  // now, but this is the shape that already rotted once in the scheduler, and
  // a second copy of it living where nothing tests it against a pinned time is
  // how it comes back.
  const day = dayOfRun(run, now);
  return upkeepFor({
    accountId: account.id,
    // Asked exactly as `dueFrom` asks it: working mode is inside the plan.
    inPlan: hasPlanOn(run.strategy_snapshot, day),
    pendingInvites,
    openConversations,
    checkedToday,
    inboxSyncedToday
  });
}

/**
 * The invitation work this account may actually do right now.
 *
 * `toSend` is cut to today's remaining allowance before it leaves the portal.
 * The refusal on `invite.sent` is a real answer and stays, but it should be the
 * rare case rather than the way the agent finds out. Its notes are cut the same
 * way, to today's phase rule: an empty note is a request to send bare. What
 * is not today's to send at all — held today, parked, or from a folder whose
 * campaign starts later — is left out by the same rule the scheduler counts
 * by (`sendableToday`), which is why the campaigns come in.
 */
async function inviteWorkFor(account, campaigns = []) {
  const allowance = await connectAllowance(account);
  const left = allowance.blocked ? 0 : Math.max(0, (allowance.quota || 0) - (allowance.spent || 0));
  const strategy = allowance.run?.strategy_snapshot;
  // Today's rule about notes, and the first day that has one. Both travel with
  // the work rather than being left for the agent to derive: an empty `toSend`
  // on an account with people queued is otherwise indistinguishable from a
  // fault, and "their note cannot go out until day 11" is the one sentence
  // that explains it.
  const notesAllowed = Boolean(strategy) && noteAllowedOnDay(strategy, allowance.day);
  return {
    toSend: await invitesToSend(account.id, Math.min(left, MAX_INVITES_PER_RUN), {
      noteRule: noteRuleFor(allowance),
      notesAllowed,
      todayIso: today(),
      day: allowance.day ?? null,
      fromDayOf: fromDayLookup(campaigns)
    }),
    // Not even the checks while a pause holds: reading the sent list is still
    // the browser on LinkedIn, and a warning stops all of it.
    toCheck: allowance.paused ? [] : await invitesToCheck(account.id, MAX_INVITE_CHECKS_PER_RUN),
    lastCheckedAt: await invitesLastCheckedAt(account.id),
    connectsLeft: left,
    weekly: allowance.weekly,
    notesAllowedToday: notesAllowed,
    nextNoteDay: strategy ? nextNoteDay(strategy, allowance.day || 1) : null
  };
}

/**
 * Top an account's waiting invitations up from its campaigns' folders, to
 * today's remaining allowance and not one more.
 *
 * This is what makes a running campaign send. Without it a campaign only
 * proposed: its people reached the agent one at a time, through a seller
 * queueing each of them from the lead workspace. Now every account ticked on
 * a running campaign, from the campaign's `fromDay` on — working mode
 * included — is filled from the folder when the agent asks for its work
 * (`GET /agent`, straight after it takes the account). The poll and the lease
 * only count; see `folderFeeds`.
 *
 * - **The same path as a seller's invitation.** `requestInvite` — a `waiting`
 *   row and an `invite.requested` event — so the person's history shows it,
 *   the phase's note rule applies to it, and cancel and move work on it. It
 *   carries no note: nobody wrote one.
 * - **Picked by hand first.** What is already held — waiting invitations and
 *   live claims — comes off the room before the folder adds anybody, and
 *   `invitesToSend` sends the picked ones ahead of the folder's.
 * - **Idempotent.** The room is today's allowance minus what is held now, so a
 *   second call finds zero. One call per account at a time, so two of the
 *   agent's questions arriving together cannot both fill it.
 * - **Nobody twice.** `nextCandidates` steps over everyone with any
 *   `wl_outreach` row, from any account, anyone the folder let go, and a
 *   second contact for a profile already approached; the unique index
 *   catches the rest.
 * - **Twice the quota a day, at most.** A person the browser could not reach
 *   is let go and the folder fills their place, which is right once and a
 *   drain when every attempt fails — see `FOLDER_DAILY_FACTOR`.
 */
const fillsInFlight = new Map();

function topUpFromFolder(account, campaigns) {
  const previous = fillsInFlight.get(account.id) ?? Promise.resolve();
  const current = previous.then(() => fillFromFolder(account, campaigns), () => fillFromFolder(account, campaigns));
  fillsInFlight.set(account.id, current);
  const settle = () => {
    if (fillsInFlight.get(account.id) === current) fillsInFlight.delete(account.id);
  };
  current.then(settle, settle);
  return current;
}

async function fillFromFolder(account, campaigns) {
  const nothing = { added: 0, collided: 0 };
  // Asked before anything is read: most accounts on most calls are on no
  // running campaign at all, and that answer costs no query.
  if (!crm.configured() || !runningFor(campaigns, account.id).length) return nothing;
  const allowance = await connectAllowance(account);
  if (allowance.blocked || !allowance.run) return nothing;
  const feeding = feedingFor(campaigns, account.id, allowance.day);
  if (!feeding.length) return nothing;

  const left = Math.max(0, (allowance.quota || 0) - (allowance.spent || 0));
  const todayIso = today();
  const { waiting, claimed } = await heldCounts([account.id], {
    claimsSince: claimCutoff(), todayIso, dayOf: new Map([[account.id, allowance.day]]),
    notesAllowedOf: new Map([[account.id, noteAllowedOnDay(allowance.run?.strategy_snapshot, allowance.day)]]), fromDayOf: fromDayLookup(campaigns)
  });
  const held = { waiting: waiting.get(account.id) ?? 0, claimed: claimed.get(account.id) ?? 0 };
  // The day's cap: what the folder already added to this account today, let
  // go or not, comes off twice the day's quota — see `FOLDER_DAILY_FACTOR`.
  const fedToday = (await folderAddedToday([account.id], todayIso)).get(account.id) ?? 0;
  const need = folderRoom({ left, ...held, quota: allowance.quota || 0, fedToday });
  if (need <= 0) return nothing;

  const outcome = await takeFromCampaigns({
    campaigns: feeding,
    need,
    take: (lead, campaign) => requestInvite({ account, lead, campaign: { id: campaign.id, name: campaign.name } })
  });

  const added = outcome.taken.length;
  if (added) {
    const names = [...new Set(feeding.map((campaign) => `"${campaign.folderName || campaign.name}"`))].slice(0, 3).join(", ");
    await logEvent({
      accountId: account.id,
      runId: allowance.run.id,
      type: "campaign.fed",
      message: `Queued ${added} from ${names} — today allows ${left} more, ${held.waiting + held.claimed} already held`,
      meta: {
        added, collided: outcome.collided, left, ...held, fedToday: fedToday + added, day: allowance.day,
        campaignIds: feeding.map((campaign) => campaign.id)
      }
    });
  }
  if (outcome.error) {
    await logEvent({
      accountId: account.id,
      runId: allowance.run.id,
      level: "warn",
      type: "campaign.feed_failed",
      message: `Could not read the folder of "${outcome.campaign?.name ?? "a campaign"}": ${crmError(outcome.error)}`,
      meta: { campaignId: outcome.campaign?.id ?? null, added }
    });
  }
  return { added, collided: outcome.collided };
}

/**
 * The top-up where it rides along on something else — the agent asking for
 * its work. A folder that could not be read must not cost the run it was
 * riding on: the run still has its views, its likes and whatever was already
 * waiting.
 */
async function topUpQuietly(account, campaigns) {
  try {
    return await topUpFromFolder(account, campaigns);
  } catch (error) {
    console.error(`[warmup] folder top-up for ${account.label} failed:`, error.message);
    return { added: 0, collided: 0 };
  }
}

/**
 * One held report per invitation at a time.
 *
 * The agent retries a report three seconds after a socket it did not get an
 * answer on, and the first may still be running then. Both would find no
 * earlier report and both would act — two failures on the record, the person
 * let go twice. Taking them in turn makes the second one the retry it is
 * (`heldRetryAnswer`). In memory, like the folder's top-up: one process
 * serves the agent.
 */
const heldReportsInFlight = new Map();

function oneHeldReportAtATime(outreachId, work) {
  const previous = heldReportsInFlight.get(outreachId) ?? Promise.resolve();
  const current = previous.then(work, work);
  heldReportsInFlight.set(outreachId, current);
  const settle = () => {
    if (heldReportsInFlight.get(outreachId) === current) heldReportsInFlight.delete(outreachId);
  };
  current.then(settle, settle);
  return current;
}

/**
 * Whether the pause this run is under was started by this same `blocked`
 * report: the newest `run.warning` that started a pause (`extended: false`)
 * came from a block page on this invitation, in the same session when both
 * say which (`pauseForWarning` writes both down).
 *
 * That is the report asked again after its first attempt paused the account
 * and then failed before its answer was written — the `invite.failed` insert,
 * or the account row. There is no stored answer to give it, so it is handled
 * again, and read as "paused already" it parked nobody: the person whose block
 * page paused the account was handed out again after the pause, first in the
 * queue, and paused it a second time. The pause is its own; it is the first
 * report still.
 */
async function pausedByThisReport(run, { outreachId, leaseId }) {
  const started = await anty.from("wl_events").select("meta")
    .eq("run_id", run.id).eq("type", "run.warning").eq("meta->>extended", "false")
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(1).maybeSingle();
  const meta = started?.meta;
  return meta?.source === "invite.blocked"
    && String(meta.outreachId ?? "") === String(outreachId)
    && (!meta.leaseId || !leaseId || meta.leaseId === leaseId);
}

/**
 * The browser could not send this invitation — `no_button`, `cannot_connect`,
 * `no_note`, `profile_gone` or `blocked` — and what that does. Answers what the route
 * sends back, or `{ refused, error }` — an HTTP status and why — for a refusal.
 *
 * - **A seller's row** stays `waiting` for that seller: it rests until
 *   tomorrow (`waitingFacts`), and a `blocked` one is parked at once.
 * - **A folder's row** is let go (`releaseFedInvite`) — it has no seller to
 *   wait for it — and the folder is told never to offer them again only when
 *   the outcome was about the person (`INVITE_PERSON_OUTCOMES`). `no_button`
 *   — the card itself was never found — and a bare request's `no_note` are
 *   about our browser, so the person goes back to the pool unmarked: a page
 *   LinkedIn redesigned must not empty the folder. `cannot_connect` is the
 *   other half: the card was there and offered no way to connect.
 * - **`blocked`** also pauses the account for two days, whoever picked the
 *   row: a block page on Connect is LinkedIn's warning arriving mid-send.
 *   Its answer says `overQuota` beside `stopSending`, which is what an agent
 *   built before `blocked` paused anything stops on.
 * - **A report while the pause already holds** — the agent carried on after
 *   an earlier block page or warning — is about the account, not the person:
 *   every page is a block page then. Nobody is parked or skipped for it: a
 *   folder's row goes back to the pool unmarked, a seller's stays waiting.
 *   Otherwise an agent that does not stop on `blocked` parked or skipped
 *   every person left in its `toSend`, one block page each. A pause this
 *   same report started, on an attempt that failed before its answer was
 *   written, is not "already" (`pausedByThisReport`).
 *
 * A report given before is answered as it was the first time and changes
 * nothing (`heldRetryAnswer`) — the agent retries what it got no answer to.
 * That is why the `invite.failed` holding the answer is written before the
 * row is let go: once it is gone, that event is all a retry can find. A retry
 * that finds the row still there after an answer that let it go is the first
 * report's release failing half-way (the skip marker or the delete), and it is
 * finished before the answer goes back.
 */
async function reportHeld({ account, outreachId, outcome, leaseId }) {
  const outreach = await anty.from("wl_outreach").select(OUTREACH_COLUMNS).eq("id", outreachId).maybeSingle();
  if (!outreach) {
    // Let go by this same report a moment ago, and asked about again.
    const earlier = await heldRetryAnswer({ accountId: account.id, outreachId, outcome, gone: true });
    if (earlier) return earlier;
    // A seller cancelled between the agent being handed this row and the
    // browser clicking Connect. The person is back in the pool, but the
    // invitation may be on their LinkedIn — so the orphan goes on the record
    // rather than vanishing with the row.
    await logEvent({
      accountId: account.id, level: "warn", type: "invite.failed",
      message: "Agent reported a request for an invitation that no longer exists — it was cancelled mid-send",
      meta: { outreachId, outcome: "row_gone", reported: outcome }
    });
    return { refused: 404, error: "That invitation is gone" };
  }
  if (outreach.account_id !== account.id) return { refused: 409, error: "That invitation belongs to another account" };

  const again = await heldRetryAnswer({ accountId: account.id, outreachId: outreach.id, outcome, leaseId });
  if (again) {
    // Said let go, and still here: the first report wrote its answer and then
    // failed to let the row go. Left like that, a folder's person stayed in
    // the account's queue — a blocked one as «Потребує уваги» for good.
    if (again.released === true && outreach.status === WAITING_STATUS) {
      const fed = (await fedInvites([outreach.id])).get(String(outreach.id)) ?? null;
      if (fed) await releaseFedInvite({ account, outreach, fed, outcome, skip: again.skipped === true });
    }
    return again;
  }

  const run = await activeRun(account.id);
  const fed = (await fedInvites([outreach.id])).get(String(outreach.id)) ?? null;
  const waiting = outreach.status === WAITING_STATUS;
  // Paused before this report came: by an earlier block page in this pause,
  // or a warning. What LinkedIn shows a paused account says nothing about the
  // person it was showing. Not a pause this report's own first attempt
  // started: that page is the one this report is about.
  const duringPause = Boolean(run) && pausedOn(run, today())
    && !(outcome === "blocked" && await pausedByThisReport(run, { outreachId: outreach.id, leaseId }));

  // A note the portal handed over as "none" cannot be missing. An agent that
  // says it is was built before bare requests were the plan, and it will say
  // the same about every request it is handed: worth an error on the log, not
  // only a warning per person. With no queued note the hand-off was bare
  // whatever the day's rule; with one, only the run's rule can say.
  const rule = run ? noteRuleOn(run.strategy_snapshot, runDay(run)) : null;
  const handedBare = !String(outreach.note || "").trim() || (rule !== null && !noteUnderRule(outreach.note, rule).note);
  const mismatch = outcome === "no_note" && handedBare;
  if (mismatch) {
    await logEvent({
      accountId: account.id, runId: run?.id ?? null, level: "error", type: "invite.agent_mismatch",
      message: `Agent reported no_note for ${outreach.person_name || "a contact"}, whose request was handed over bare — the agent is out of date`,
      meta: { outreachId: outreach.id, crmContactId: outreach.crm_contact_id, outcome }
    });
  }

  // Only a row still waiting: one a seller already sent by hand or moved on
  // is theirs now, whatever the folder once did. The mismatch goes back to
  // the pool unmarked: it says nothing about the person, and a skip would let
  // an out-of-date agent empty the folder for good.
  // So does a report that came while the account was already paused.
  // `released` is what was decided here, before the delete, because the
  // answer is stored before it: a seller's click in the same instant can
  // still take the row first, and the delete then finds nothing to do.
  const release = Boolean(fed) && waiting;
  const skip = release && !mismatch && !duringPause && INVITE_PERSON_OUTCOMES.includes(outcome);
  const answer = { status: outreach.status, moved: false, recorded: outcome, released: release, skipped: skip };

  if (outcome === "blocked") {
    const note = `Block page on the request to ${outreach.person_name || "a contact"}`;
    const pause = run
      ? await pauseForWarning({ account, run, source: "invite.blocked", note, report: { outreachId: outreach.id, leaseId } })
      : null;
    Object.assign(answer, {
      // A seller's row is parked by the failure written below; a folder's
      // row is let go and skipped instead (see `INVITE_HELD_OUTCOMES`) —
      // neither when the account was already paused.
      parked: waiting && !fed && !duringPause,
      paused: Boolean(pause), pausedUntil: pause?.pausedUntil ?? null,
      // `overQuota` too, like a `sent` during a pause: an agent built before
      // a block page paused anything stops on that flag, and without it went
      // on to the next person — and the next block page.
      overQuota: true, stopSending: true
    });
  }
  if (duringPause) Object.assign(answer, { duringPause: true, overQuota: true, stopSending: true });

  await recordFailed({ account, run, outreach, outcome, leaseId, answer, duringPause });
  if (release) await releaseFedInvite({ account, outreach, fed, outcome, skip });
  return answer;
}

/**
 * Let go of claims that outlived their session.
 *
 * A `queued` row holds a person out of everybody's pool while it stands, so a
 * crash between claiming and sending would otherwise burn a real contact for
 * good. Twenty hours is longer than any working session and shorter than a day:
 * the worst a crash costs is one day of one account's allocation.
 */
async function releaseExpiredClaims() {
  const gone = await anty.from("wl_outreach")
    .eq("status", CLAIM_STATUS).lt("created_at", claimCutoff())
    .remove().select("id").rows();
  if (gone.length) {
    await logEvent({
      type: "campaign.released",
      message: `Released ${gone.length} claim${gone.length > 1 ? "s" : ""} nobody worked in time`,
      meta: { released: gone.length, reason: "expired" }
    });
  }
  return gone.length;
}

/** Delete claims by id, in batches a URL can carry. */
async function deleteClaims(ids) {
  let released = 0;
  for (let start = 0; start < ids.length; start += CONTACT_ID_BATCH) {
    const gone = await anty.from("wl_outreach")
      .in("id", ids.slice(start, start + CONTACT_ID_BATCH)).eq("status", CLAIM_STATUS)
      .remove().select("id").rows();
    released += gone.length;
  }
  return released;
}

/**
 * The claims a deleted campaign was holding.
 *
 * Its accounts' rows, for contacts in its folder — and when the CRM cannot say
 * which those are, only the accounts no other campaign works. Another
 * campaign's allocation is not this one's to throw away.
 */
async function releaseCampaignClaims(campaign, campaigns) {
  if (!campaign.accountIds.length) return 0;
  const queued = await anty.from("wl_outreach").select("id,account_id,crm_contact_id")
    .in("account_id", campaign.accountIds).eq("status", CLAIM_STATUS).rows();
  if (!queued.length) return 0;

  let mine = queued;
  try {
    const inFolder = await contactsInFolder(campaign.folderId, [...new Set(queued.map((row) => row.crm_contact_id))]);
    mine = queued.filter((row) => inFolder.has(row.crm_contact_id));
  } catch {
    const shared = new Set(campaigns.flatMap((other) => (other.id === campaign.id ? [] : other.accountIds)));
    mine = queued.filter((row) => !shared.has(row.account_id));
  }
  return deleteClaims(mine.map((row) => row.id));
}

/**
 * A folder that is really there, accounts that are really rows, a product the
 * workspace really sells.
 *
 * Checked rather than taken on trust: a folder id that is not there makes every
 * later screen say "nobody matches" for a reason nobody can see.
 */
async function checkCampaignInput({ folderId, accountIds, productId, products }) {
  let folderName;
  try {
    folderName = await folderNameOf(folderId);
  } catch (error) {
    return { status: 502, error: crmError(error) };
  }
  if (folderName === null) return { status: 404, error: "Такої папки немає в CRM" };

  if (accountIds.length) {
    const known = await anty.from("wl_accounts").select("id").in("id", accountIds).rows();
    const missing = accountIds.filter((id) => !known.some((row) => row.id === id));
    if (missing.length) return { status: 400, error: `Невідомий акаунт: ${missing.join(", ")}` };
  }

  // A product is the workspace's own, and nothing about the message is decided
  // here — a campaign stores which product it is for and no wording at all.
  if (productId && !products.some((product) => product.id === productId)) {
    return { status: 400, error: `Невідомий продукт: ${productId}` };
  }

  return { folderName };
}

/**
 * Which campaign each claimed row belongs to: its account's campaign, in order,
 * whose folder holds the person. Without the CRM the rows are still worth
 * showing, so they come back with no campaign named rather than not at all.
 */
async function claimOwners(campaigns, rows) {
  const owners = new Map();
  if (!rows.length || !campaigns.length) return owners;
  const contactIds = [...new Set(rows.map((row) => row.crm_contact_id).filter(Boolean))];

  try {
    for (const campaign of campaigns) {
      const inFolder = await contactsInFolder(campaign.folderId, contactIds);
      for (const row of rows) {
        if (owners.has(row.id)) continue;
        if (campaign.accountIds.includes(row.account_id) && inFolder.has(row.crm_contact_id)) owners.set(row.id, campaign);
      }
    }
  } catch {
    return owners;
  }
  return owners;
}

/**
 * Everything the campaign list needs from both databases, gathered once.
 *
 * Each row costs a forecast of its own — it is a count across two databases and
 * there is no honest way to share it — but who has been approached, what went
 * out today and which contacts sit in which folder is the same handful of
 * queries for one campaign as for twenty.
 */
async function campaignContext(campaigns) {
  const accountIds = [...new Set(campaigns.flatMap((campaign) => campaign.accountIds))];
  const folderIds = [...new Set(campaigns.map((campaign) => campaign.folderId).filter(Boolean))];

  const [rows, sentToday] = await Promise.all([
    accountIds.length
      ? anty.from("wl_outreach").select(CLAIM_COLUMNS).in("account_id", accountIds).rows()
      : Promise.resolve([]),
    connectDoneToday(accountIds)
  ]);

  const folderNames = new Map();
  const inFolder = new Map();
  try {
    if (folderIds.length) {
      const folders = await crm.from("contact_folders").select("id,name").in("id", folderIds).rows();
      for (const folder of folders) folderNames.set(folder.id, folder.name);
    }
    const contactIds = [...new Set(rows.map((row) => row.crm_contact_id).filter(Boolean))];
    for (const folderId of folderIds) {
      inFolder.set(folderId, contactIds.length ? await contactsInFolder(folderId, contactIds) : new Set());
    }
  } catch {
    // A CRM that is not answering costs the folder names and the attribution,
    // not the list: the panel exists to show the campaigns, and it must not
    // lose them because a count could not be taken.
    inFolder.clear();
  }

  return { rows, sentToday, folderNames, inFolder };
}

/** One campaign with its forecast and its progress, for the list and for a write. */
async function enrichCampaign(campaign, campaigns, context) {
  const mine = context.inFolder.get(campaign.folderId);
  const rows = context.rows.filter((row) =>
    campaign.accountIds.includes(row.account_id) && (!mine || mine.has(row.crm_contact_id)));

  const progress = progressFrom(rows, {
    todayIso: today(),
    sentToday: campaign.accountIds.reduce((total, id) => total + (context.sentToday.get(id) ?? 0), 0)
  });

  let forecast = null;
  let forecastError = null;
  try {
    forecast = campaign.folderId ? await forecastFor(targetingOf(campaign)) : null;
  } catch (error) {
    forecast = null;
    forecastError = crmError(error);
  }

  return {
    ...describeCampaign(campaign, context.folderNames.get(campaign.folderId) ?? null),
    forecast,
    forecastError,
    progress,
    // Either two campaigns share an account and a folder, or the CRM could not
    // say which rows are in the folder at all. Both make the number a caveat.
    progressApproximate: !mine || progressApproximate(campaign, campaigns)
  };
}

async function enrichCampaigns(campaigns) {
  const context = await campaignContext(campaigns);
  const enriched = [];
  // One at a time: a forecast is several counts across two databases, and
  // twenty campaigns firing them all at once is how a CRM starts refusing.
  for (const campaign of campaigns) enriched.push(await enrichCampaign(campaign, campaigns, context));
  return enriched;
}

/**
 * A thread as every screen sees it: what the inbox module derived, plus who
 * holds it and what had already been done with the person.
 *
 * `accountLabel` is the profile's name in this app; `accountIdentity` is who
 * the browser turned out to be signed in as. Both, because they disagree often
 * enough — "Profile 47 - linkedin" is not something to put in front of a seller
 * deciding which of five logins somebody answered.
 */
function describeThread(thread, { labels, identities, outreach }) {
  const found = outreach.get(threadKeyOf(thread)) || { crmContactId: null, outreachStatus: null };
  return {
    threadKey: thread.threadKey,
    accountId: thread.accountId,
    accountLabel: labels.get(thread.accountId) ?? null,
    accountIdentity: identities.get(thread.accountId)?.name ?? null,
    participant: thread.participant,
    lastMessage: thread.lastMessage,
    messageCount: thread.messageCount,
    unread: thread.unread,
    // An approach of this account's names the contact first; otherwise the one
    // the thread was tied to when its messages were stored or the person was
    // added to the CRM.
    crmContactId: found.crmContactId ?? thread.crmContactId ?? null,
    outreachStatus: found.outreachStatus,
    lastSyncedAt: thread.lastSyncedAt
  };
}

/**
 * Whether the account's browser will be opened at all, and so whether a reply
 * written for it can ever go out. A reply is sent by the account's own session,
 * so an account the agent does not open — excluded, no warm-up, on pause, marked
 * unhealthy — would take the reply and never send it. Better said when it is
 * written than found out three days later.
 */
async function replyDoor(account) {
  if (!account) return { open: false, reason: "Акаунт не знайдено." };
  if (account.status === "excluded") {
    return { open: false, reason: "Цей акаунт виключено з прогріву — агент його не відкриває, тож відповісти звідси не вийде." };
  }
  const run = await activeRun(account.id);
  if (!run) {
    return { open: false, reason: "Для цього акаунта не запущено прогрів — агент його не відкриває, тож відповісти звідси не вийде." };
  }
  if (pausedOn(run, today())) {
    return { open: false, reason: `Акаунт на паузі до ${run.paused_until} — поки вона триває, агент його не відкриває.` };
  }
  if (account.health !== "ok") {
    return { open: false, reason: "Акаунт позначено як проблемний — агент його не відкриває, поки це не знято." };
  }
  return { open: true, reason: null };
}

/** What the plan hands the agent: the replies it sends this session, in the shape it reads them. */
async function outboxPlan(accountId) {
  const work = await repliesToSend(accountId, { todayIso: today() });
  return {
    toSend: work.toSend.map((reply) => ({
      id: reply.id, threadKey: reply.threadKey, text: reply.body, name: reply.participantName
    })),
    waiting: work.waiting, sentToday: work.sentToday, perDay: work.perDay
  };
}

/**
 * When a reply written now goes out: the account's next session, which is also
 * when it reads the inbox. Today's, if it has not happened yet, otherwise
 * tomorrow's — at the time that session is planned for.
 */
async function replyGoesOut(account) {
  const read = await syncedTodayAccounts([account.id], today());
  const next = nextSession(account.id, { outstanding: !read.has(account.id) });
  return { at: next.at, today: next.today, soon: next.overdue };
}


/* ── the link in the group: "I have logged in, carry on" ──────────────────── */

/**
 * How long a request waits for the watch to answer it. The watch looks every
 * minute, and one look costs about a minute of browser; past this the page
 * stops promising and says so.
 */
const RECHECK_PATIENCE_MS = 10 * 60_000;

function sendPage(response, status, title, lines, { refresh = 0 } = {}) {
  const escape = (text) => String(text).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  const body = `<!doctype html><html lang="uk"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${refresh ? `<meta http-equiv="refresh" content="${refresh}" />` : ""}
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; padding: 24px; }
  main { max-width: 32rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p { margin: .5rem 0; }
  small { opacity: .65; }
</style></head><body><main><h1>${escape(title)}</h1>
${lines.map((line) => `<p>${escape(line)}</p>`).join("\n")}
</main></body></html>`;
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

/** The request this nonce stands for, and the answer if one was written. */
async function recheckState(nonce) {
  const [requested, done] = await Promise.all([
    anty.from("wl_events").select("id,account_id,meta,created_at")
      .eq("type", RECHECK_REQUESTED).eq("meta->>nonce", nonce).maybeSingle(),
    anty.from("wl_events").select("id,account_id,meta,created_at")
      .eq("type", RECHECK_DONE).eq("meta->>nonce", nonce).maybeSingle()
  ]);
  return { requested, done };
}

const RECHECK_REFUSALS = {
  not_configured: "Сервер не налаштований перевіряти ці посилання.",
  malformed: "Посилання неповне — скопіюй його з повідомлення цілим.",
  bad_signature: "Це посилання не наше.",
  expired: "Посилання застаріло — дочекайся наступного повідомлення в групі."
};

export async function handleWarmupApi({ request, response, url, sendJson, readJson, campaigns: campaignStore }) {
  const path = url.pathname.replace(/^\/api\/warmup/, "") || "/";
  const method = request.method;

  /**
   * The link from the group message. No session: the signature is the
   * authorisation, and the page is for a phone, not for the dashboard.
   *
   * It does not check the login itself — nothing here owns a browser. It
   * records the ask, the watch picks it up within a minute, and this page
   * shows the answer when it lands. Opening the same link twice is the same
   * ask, not a second one: the nonce is recorded once.
   */
  if (method === "GET" && path === "/login-check") {
    const read = readLoginCheck(url.searchParams.get("t"));
    if (!read.ok) {
      sendPage(response, read.why === "not_configured" ? 503 : 400, "Не можу прийняти посилання",
        [RECHECK_REFUSALS[read.why] ?? "Посилання не підходить."]);
      return true;
    }
    const account = await loadAccount(read.accountId);
    if (!account) {
      sendPage(response, 404, "Акаунта вже немає", ["Цей акаунт прибрали з прогріву."]);
      return true;
    }

    const { requested, done } = await recheckState(read.nonce);
    if (done) {
      const ok = done.meta?.signedIn === true;
      sendPage(response, 200, ok ? "Вхід відновлено" : "Входу ще не видно",
        ok
          ? [`${account.label}: вхід перевірений, прогрів продовжено.`, "Нічого більше робити не треба."]
          : [`${account.label}: ${done.meta?.reason || "браузер не побачив входу"}.`,
             "Перевір, що залогінився саме в цьому профілі в Anty, і відкрий посилання з наступного повідомлення в групі."]);
      return true;
    }

    if (!requested) {
      await logEvent({
        accountId: account.id, type: RECHECK_REQUESTED,
        message: `Попросили перевірити вхід за посиланням із групи — ${account.label}`,
        meta: { nonce: read.nonce, issuedAt: read.issuedAt }
      });
    }
    const waitingSince = Date.parse(requested?.created_at ?? "") || Date.now();
    const tooLong = Date.now() - waitingSince > RECHECK_PATIENCE_MS;
    sendPage(response, 200, tooLong ? "Перевірка затягнулась" : "Прийняв — перевіряю вхід",
      tooLong
        ? [`${account.label}: запит прийнятий, але відповіді від агента досі немає.`,
           "Схоже, агент прогріву не працює. Скажи про це в чаті розробки."]
        : [`${account.label}: відкриваю профіль і дивлюсь, чи є вхід.`,
           "Це займає до хвилини. Сторінка обновиться сама, а відповідь прийде і в групу."],
      { refresh: tooLong ? 0 : 10 });
    return true;
  }

  /**
   * The campaigns, migrating Phase 1's single targeting on the first read.
   *
   * The migrated list is written through immediately, so from that moment there
   * is exactly one place that answers "which folder is this account working".
   * The old key is read and never written: a rollback to Phase 1 finds its
   * targeting exactly as it left it.
   */
  const loadCampaigns = async () => {
    const { campaigns, migrated } = migrateCampaigns(campaignStore.read(), campaignStore.readTargeting());
    if (migrated) await campaignStore.write(campaigns);
    return campaigns;
  };

  // Every write leaves the list a dense 0..n-1: `order` is the place a campaign
  // is in, and a gap left by a delete would make the next move land oddly.
  const saveCampaigns = (list) => campaignStore.write(renumber(list));

  // The same list for the agent's routes, without the write-through: the poll
  // takes nothing and writes nothing, and a migration is the panel's to save.
  const readCampaigns = () => migrateCampaigns(campaignStore.read(), campaignStore.readTargeting()).campaigns;

  // The folders being worked right now: a person the CRM holds twice is copied
  // to the record sitting in one of these (`contactBySlug`).
  const runningFolderIds = () => readCampaigns()
    .filter((campaign) => campaign.state === "running" && campaign.folderId).map((campaign) => campaign.folderId);

  try {
    // ── configuration ──────────────────────────────────────────────────────
    if (method === "GET" && path === "/config") {
      // The nav badge's number, so a screen that already asks for the config
      // does not need a second request to know whether anybody wrote.
      //
      // Null rather than 0 when the database cannot be reached: "nobody wrote"
      // and "we could not tell" have to be tellable apart, or a badge that
      // quietly vanishes during an outage reads as an empty inbox.
      let unreadReplies = null;
      if (anty.configured()) {
        try {
          unreadReplies = await unreadCount();
        } catch (error) {
          console.error("[warmup] could not count unread replies:", error.message);
        }
      }

      sendJson(response, 200, {
        success: true,
        configured: anty.configured(),
        missing: anty.missing(),
        crmConfigured: crm.configured(),
        crmMissing: crm.missing(),
        secretsConfigured: secretsConfigured(),
        teamConfigured: Boolean(antyTeamId()),
        window: { ...SESSION_WINDOW, label: windowLabel(), open: insideWindow() },
        actionKinds: ACTION_KINDS.map((kind) => ({ kind, label: ACTION_LABEL[kind] })),
        healthValues: HEALTH_VALUES.map((value) => ({ value, label: HEALTH_LABEL[value] })),
        unreadReplies
      });
      return true;
    }

    // ── overview ───────────────────────────────────────────────────────────
    if (method === "GET" && path === "/dashboard") {
      const rows = await anty.from("wl_accounts").select("*").rows();
      const accounts = await Promise.all(rows.map(describeAccount));

      const totals = { total: accounts.length, warming: 0, working: 0, paused: 0, completed: 0, idle: 0 };
      let plannedToday = 0;
      let doneToday = 0;
      const attention = [];

      for (const account of accounts) {
        const warmup = account.warmup;
        if (!warmup) { totals.idle += 1; continue; }
        if (warmup.state === "paused") {
          totals.paused += 1;
          attention.push({
            id: account.id, label: account.label,
            reason: warmup.pauseCause === "invite_limit"
              ? `LinkedIn invitation limit — paused until ${warmup.pausedUntil}`
              : `Paused after a warning until ${warmup.pausedUntil}`
          });
          continue;
        }
        if (warmup.finished) {
          totals.completed += 1;
          attention.push({ id: account.id, label: account.label, reason: "Warm-up finished — nothing planned after the last phase" });
          continue;
        }
        // Working mode is counted apart from warming but planned the same way:
        // its views, likes and requests are today's work like anybody's.
        if (warmup.working) totals.working += 1;
        else totals.warming += 1;
        for (const kind of Object.keys(warmup.quotas)) {
          plannedToday += warmup.quotas[kind];
          doneToday += Math.min(warmup.done[kind], warmup.quotas[kind]);
        }
        if (!account.profileRemoteId) {
          attention.push({ id: account.id, label: account.label, reason: "No Anty profile linked" });
        }
      }

      // Messages live in this table too, and there are far more of them than
      // there are audit lines — eight replies would push a whole day of history
      // off a panel that shows eight rows.
      const recent = await anty.from("wl_events").select("id,account_id,level,type,message,created_at")
        .notIn("type", AUDIT_HIDDEN_TYPES)
        .order("created_at", { ascending: false }).limit(8).rows();

      sendJson(response, 200, {
        success: true,
        date: today(),
        totals,
        todayProgress: { planned: plannedToday, done: doneToday },
        attention: attention.slice(0, 8),
        recent
      });
      return true;
    }

    // ── Anty profiles, with the warm-up joined on ──────────────────────────
    if (method === "GET" && path === "/profiles") {
      const platform = url.searchParams.get("platform") || "linkedin";
      const showExcluded = url.searchParams.get("excluded") === "1";
      const search = (url.searchParams.get("q") || "").trim().toLowerCase();
      const teamId = antyTeamId();

      let query = anty.from("anty_browser_profiles")
        .select("id,name,status,start_page,tags,proxy,last_launched_at,created_by_name,created_by_email")
        .eq("is_deleted", false);
      if (teamId) query = query.eq("team_id", teamId);
      const profileRows = await query.order("name").rows();

      // Every account with its newest session embedded: PostgREST applies the
      // limit per parent row, so this stays one round trip however many
      // sessions there are.
      const linked = await anty.from("wl_accounts")
        .select("id,profile_remote_id,status,health,health_note,wl_sessions(started_at,ended_at)")
        .order("started_at", { ascending: false, foreignTable: "wl_sessions" })
        .limit(1, { foreignTable: "wl_sessions" })
        .rows();

      // One query for every run rather than one per profile: the list is the
      // screen people keep open, and it should not cost 22 round trips to draw.
      const runs = await anty.from("wl_runs")
        .select("account_id,state,paused_until,started_at,paused_days,strategy_snapshot")
        .in("state", ["running", "paused", "completed"])
        .order("started_at", { ascending: false })
        .rows();

      const runByAccount = new Map();
      for (const run of runs) if (!runByAccount.has(run.account_id)) runByAccount.set(run.account_id, run);

      const todayIso = today();
      const dayRows = await anty.from("wl_day_actions").select("account_id,on_date,kind,quota,done").rows();
      const weeklyByAccount = await weeklyConnectCounts(linked.map((account) => account.id), todayIso);
      const connectionsByAccount = new Map();
      const outstandingByAccount = new Map();
      const hasDayRow = new Set();
      for (const row of dayRows) {
        if (row.on_date === todayIso) hasDayRow.add(row.account_id);
        if (row.kind === "connect") {
          const sum = connectionsByAccount.get(row.account_id) || { today: 0, total: 0 };
          sum.total += row.done ?? 0;
          if (row.on_date === todayIso) sum.today += row.done ?? 0;
          connectionsByAccount.set(row.account_id, sum);
        }
        if (row.on_date === todayIso && (row.done ?? 0) < (row.quota ?? 0)) {
          outstandingByAccount.set(row.account_id, true);
        }
      }

      const outreachRows = await anty.from("wl_outreach").select("account_id").rows();
      const outreachByAccount = new Map();
      for (const row of outreachRows) {
        outreachByAccount.set(row.account_id, (outreachByAccount.get(row.account_id) ?? 0) + 1);
      }

      // Who each browser is actually signed in as — one query for the whole
      // list, the same rule everything else on this endpoint follows.
      const identityByAccount = await loginIdentities();
      // Why each paused account is paused — only those, so an ordinary morning
      // costs nothing extra.
      const pausedIds = linked
        .filter((account) => { const run = runByAccount.get(account.id); return run?.paused_until && run.paused_until >= todayIso; })
        .map((account) => account.id);
      const warningByAccount = await latestWarnings(pausedIds);

      const byProfile = new Map(linked.map((account) => [account.profile_remote_id, account]));

      const describe = (row) => {
        const account = byProfile.get(row.id) || null;
        const run = account ? runByAccount.get(account.id) || null : null;
        const last = account?.wl_sessions?.[0] || null;
        const paused = Boolean(account && run?.paused_until && run.paused_until >= todayIso);
        const cause = paused ? pauseCause(warningByAccount.get(account.id)) : null;
        const status = deriveStatus(account, run, todayIso, cause);
        // The day the account is on, so the list's Day column has something to
        // put there. Read from the run's own snapshot, which is what the detail
        // panel reads too — two ways of counting the day is two answers.
        const day = run && run.state !== "stopped"
          ? { day: runDay(run), totalDays: totalDays(run.strategy_snapshot) }
          : null;
        return {
          id: row.id,
          name: row.name,
          platform: platformOf(row),
          startPage: row.start_page,
          proxy: row.proxy?.host ? proxyString(row.proxy) : null,
          lastLaunchedAt: row.last_launched_at,
          owner: row.created_by_name?.trim() || row.created_by_email || null,
          ownerEmail: row.created_by_email,
          account: account ? { id: account.id, status: account.status, phase: phaseOf(account, run) } : null,
          // The profile's label is what somebody typed in Anty; this is the
          // person LinkedIn thinks is signed in. They are rarely the same string.
          identity: account ? identityByAccount.get(account.id) ?? null : null,
          // Past the last phase the day keeps counting, with no "of 14" to
          // count towards: working mode says itself in the status column.
          day: day ? (day.day <= day.totalDays ? `${day.day}/${day.totalDays}` : String(day.day)) : null,
          health: account?.health ?? "ok",
          healthNote: account?.health_note ?? null,
          status,
          // Until when, and why: «Ліміт LinkedIn · до 11.10» rather than a bare «На паузі».
          pause: paused ? { until: run.paused_until, cause } : null,
          isRunningNow: row.status === "running",
          connections: {
            ...(connectionsByAccount.get(account?.id ?? "") || { today: 0, total: 0 }),
            quota: connectCeiling(connectQuotaToday(account, run, todayIso),
              connectionsByAccount.get(account?.id)?.today ?? 0, weeklyByAccount.get(account?.id) ?? 0),
            weekly: weeklyAllowance(weeklyByAccount.get(account?.id) ?? 0, todayIso),
            startsDay: connectStartsDay(run)
          },
          outreachTotal: outreachByAccount.get(account?.id ?? "") ?? 0,
          lastSession: last
            ? { startedAt: last.started_at, endedAt: last.ended_at, durationMin: durationMin(last.started_at, last.ended_at) }
            : null,
          // Only an account that is warming and not already open has a next
          // session: promising "next at 14:20" for one that is off or blocked
          // would be a commitment nobody is going to keep.
          nextSession: account && (status === "warming" || status === "working") && row.status !== "running"
            ? nextSession(account.id, {
                // No day row yet means today has not been started at all, which
                // is the most outstanding a day can be.
                outstanding: outstandingByAccount.get(account.id) ?? !hasDayRow.has(account.id),
                notBefore: heldUntil(account.id)
              })
            : null
        };
      };

      const profiles = profileRows
        .map(describe)
        .filter((profile) => (platform === "all" ? true : profile.platform === platform))
        .filter((profile) => (showExcluded ? profile.account?.phase === "excluded" : profile.account?.phase !== "excluded"))
        .filter((profile) => (search ? profile.name.toLowerCase().includes(search) : true));

      const counts = { all: 0, excluded: 0 };
      for (const row of profileRows) {
        if (byProfile.get(row.id)?.status === "excluded") { counts.excluded += 1; continue; }
        const name = platformOf(row);
        counts[name] = (counts[name] ?? 0) + 1;
        counts.all += 1;
      }

      sendJson(response, 200, { success: true, profiles, counts, teamConfigured: Boolean(teamId) });
      return true;
    }

    /**
     * Edit an Anty profile: name, owner, type or proxy. These rows belong to
     * Anty and its desktop app syncs them, so every write here is a write into
     * somebody else's product — which is why each field is validated first and
     * the type is re-tagged rather than stored in a column of our own.
     */
    if (method === "PATCH" && path === "/profiles") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Який профіль?");

      const profile = await anty.from("anty_browser_profiles")
        .select("id,name,start_page,tags,proxy,created_by_name,created_by_email")
        .eq("id", String(body.id)).maybeSingle();
      if (!profile) return fail(response, sendJson, 404, "Профіль не знайдено");

      const patch = { updated_at: new Date().toISOString() };
      const changes = [];

      if (typeof body.name === "string") {
        const name = body.name.trim();
        if (!name) return fail(response, sendJson, 400, "Назва не може бути порожньою");
        if (name !== profile.name) { patch.name = name; changes.push(`renamed to "${name}"`); }
      }

      if (typeof body.owner === "string") {
        const owner = body.owner.trim();
        if (owner !== (profile.created_by_name ?? "")) {
          patch.created_by_name = owner || null;
          changes.push(owner ? `owner set to "${owner}"` : "owner cleared");
        }
      }

      if (typeof body.platform === "string") {
        if (!PLATFORMS.includes(body.platform)) return fail(response, sendJson, 400, "Невідомий тип");
        if (platformOf(profile) !== body.platform) {
          const result = retag(profile, body.platform);
          if (result.conflict) {
            return fail(response, sendJson, 409, `Стартова сторінка профілю — ${result.conflict}. Спочатку зміни її, інакше вони суперечитимуть одна одній`);
          }
          patch.tags = result.tags;
          changes.push(`marked as ${body.platform}`);
        }
      }

      if (typeof body.proxy === "string") {
        const input = body.proxy.trim();
        if (!input) {
          if (profile.proxy?.host) { patch.proxy = null; changes.push("proxy removed"); }
        } else {
          const parsed = parseProxy(input);
          if (parsed.error) return fail(response, sendJson, 400, `Proxy: ${parsed.error}`);
          patch.proxy = parsed;
          changes.push(`proxy set to ${parsed.host}:${parsed.port}`);
        }
      }

      if (!changes.length) { sendJson(response, 200, { success: true, unchanged: true }); return true; }

      await anty.from("anty_browser_profiles").update(patch).eq("id", profile.id).rows();
      // The proxy password is not repeated into the log; the host is enough to
      // know which proxy was meant.
      await logEvent({ type: "profile.edited", message: `"${profile.name}": ${changes.join(", ")}`, meta: { profileId: profile.id } });
      sendJson(response, 200, { success: true });
      return true;
    }

    // ── accounts ───────────────────────────────────────────────────────────
    if (method === "GET" && path === "/accounts") {
      // One account by id, for the detail panel — the list is too heavy an
      // answer to a question about a single row.
      const single = url.searchParams.get("id");
      if (single) {
        const account = await loadAccount(single);
        if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");
        sendJson(response, 200, {
          success: true,
          secretsConfigured: secretsConfigured(),
          account: await describeAccount(account)
        });
        return true;
      }

      const status = url.searchParams.get("status");
      const search = (url.searchParams.get("q") || "").trim();

      let query = anty.from("wl_accounts").select("*");
      if (status && status !== "all") query = query.eq("status", status);
      if (search) query = query.or(`label.ilike.*${search}*,login.ilike.*${search}*`);
      const rows = await query.order("created_at", { ascending: false }).rows();

      sendJson(response, 200, {
        success: true,
        secretsConfigured: secretsConfigured(),
        accounts: await Promise.all(rows.map(describeAccount))
      });
      return true;
    }

    if (method === "POST" && path === "/accounts") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");

      const label = String(body.label || "").trim();
      const login = String(body.login || "").trim();
      const password = String(body.password || "");
      const profileRemoteId = body.profileRemoteId ? String(body.profileRemoteId) : null;

      // A login is optional: an account created from an Anty profile is
      // identified by that profile, and demanding one here is what made
      // "Warm up" fail on a screen that has no field to type it into.
      if (!label) return fail(response, sendJson, 400, "Назва обов'язкова");

      // One warm-up record per profile — two would count the same day twice.
      if (profileRemoteId) {
        const existing = await anty.from("wl_accounts").select("*").eq("profile_remote_id", profileRemoteId).maybeSingle();
        if (existing) { sendJson(response, 200, { success: true, account: await describeAccount(existing) }); return true; }
      }

      // Refuse rather than save the account with the password silently dropped.
      if (password && !secretsConfigured()) {
        return fail(response, sendJson, 503, "Сховище паролів не налаштоване на цьому сервері (LINKEDIN_SECRET_KEY)");
      }

      const strategy = body.strategyId ? { id: String(body.strategyId) } : await ensureDefaultStrategy();

      const created = await anty.from("wl_accounts").insert({
        label,
        login: login || null,
        password_cipher: password ? encryptSecret(password) : null,
        profile_remote_id: profileRemoteId,
        proxy_id: body.proxyId ? String(body.proxyId) : null,
        strategy_id: strategy.id,
        owner_note: body.note ? String(body.note) : null
      }).select("*").single();

      await logEvent({ accountId: created.id, type: "account.created", message: `Account "${label}" added`, meta: { login } });
      sendJson(response, 201, { success: true, account: await describeAccount(created) });
      return true;
    }

    if (method === "PATCH" && path === "/accounts") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Який акаунт?");

      const account = await loadAccount(String(body.id));
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");

      const patch = { updated_at: new Date().toISOString() };
      const changed = [];
      if (typeof body.label === "string" && body.label.trim()) { patch.label = body.label.trim(); changed.push("name"); }
      if (typeof body.login === "string" && body.login.trim()) { patch.login = body.login.trim(); changed.push("login"); }
      if ("proxyId" in body) { patch.proxy_id = body.proxyId || null; changed.push("proxy"); }
      if ("profileRemoteId" in body) { patch.profile_remote_id = body.profileRemoteId || null; changed.push("Anty profile"); }
      if ("strategyId" in body) { patch.strategy_id = body.strategyId || null; changed.push("strategy"); }
      if ("note" in body) { patch.owner_note = body.note ? String(body.note) : null; changed.push("note"); }
      if (typeof body.password === "string" && body.password) {
        if (!secretsConfigured()) return fail(response, sendJson, 503, "Сховище паролів не налаштоване (LINKEDIN_SECRET_KEY)");
        patch.password_cipher = encryptSecret(body.password);
        changed.push("password");
      }

      await anty.from("wl_accounts").update(patch).eq("id", account.id).rows();
      if (changed.length) {
        // The value is not logged — a proxy change is worth knowing about, the
        // credentials behind it are not something to leave in a log table.
        await logEvent({ accountId: account.id, type: "account.updated", message: `Changed ${changed.join(", ")}` });
      }

      const fresh = await loadAccount(account.id);
      sendJson(response, 200, { success: true, account: await describeAccount(fresh) });
      return true;
    }

    if (method === "DELETE" && path === "/accounts") {
      const id = url.searchParams.get("id");
      if (!id) return fail(response, sendJson, 400, "Який акаунт?");
      const account = await loadAccount(id);
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");

      await logEvent({ accountId: null, level: "warn", type: "account.deleted", message: `Account "${account.label}" deleted` });
      await anty.from("wl_accounts").remove().eq("id", account.id).rows();
      sendJson(response, 200, { success: true });
      return true;
    }

    /**
     * Health: what a human saw when they opened the profile.
     *
     * Nothing here can detect a block — the browser is Anty's and LinkedIn does
     * not send a webhook — so this is a hand-set flag. It exists because
     * "blocked" has to outrank every warm-up state in the list: a run that
     * keeps advancing on a blocked account is exactly how the next account gets
     * treated the same way.
     */
    if (method === "POST" && path === "/accounts/health") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      if (!body.accountId) return fail(response, sendJson, 400, "Який акаунт?");
      if (!isHealth(body.health)) return fail(response, sendJson, 400, `Стан має бути одним із: ${HEALTH_VALUES.join(", ")}`);

      const account = await loadAccount(String(body.accountId));
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");

      const health = body.health;
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
      if (health === account.health && note === account.health_note) {
        sendJson(response, 200, { success: true, unchanged: true, account: await describeAccount(account) });
        return true;
      }

      const now = new Date().toISOString();
      const fresh = await anty.from("wl_accounts").update({
        health,
        // Always written, even to null: a "captcha on login" note left on an
        // account that is OK again is a note somebody will act on by mistake.
        health_note: note,
        // "Blocked since Tuesday" must survive a note added on Thursday, so the
        // timestamp moves only with the health itself.
        health_changed_at: health === account.health ? account.health_changed_at : now,
        updated_at: now
      }).eq("id", account.id).select("*").single();

      await logEvent({
        accountId: account.id,
        type: "account.health",
        // Anything but OK is a person's problem to solve, which is what warn
        // means in this log.
        level: health === "ok" ? "info" : "warn",
        message: `Health: ${HEALTH_LABEL[health]}${note ? ` — ${note}` : ""}`,
        meta: { health, previous: account.health, note }
      });

      sendJson(response, 200, { success: true, account: await describeAccount(fresh) });
      return true;
    }

    /**
     * Warm-up control: exclude, include, start, warning, resume, stop, record.
     *
     * Every branch writes to the event log on the same path as the change,
     * because this log is what gets read when an account is restricted and
     * somebody needs to know what was done to it in the days before.
     */
    if (method === "POST" && path === "/control") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");
      const action = String(body.action || "");

      // Excluded is a state rather than a deletion, because "we decided not to
      // warm this one" is a decision worth keeping — otherwise the profile
      // reappears in the list and gets put on warm-up by the next person.
      if (action === "exclude") {
        const running = await activeRun(account.id);
        if (running) {
          await anty.from("wl_runs").update({ state: "stopped", completed_at: new Date().toISOString() }).eq("id", running.id).rows();
        }
        await setAccountStatus(account.id, "excluded");
        await logEvent({
          accountId: account.id, level: "warn", type: "account.excluded",
          message: running ? "Excluded from warm-up — the run in progress was stopped" : "Excluded from warm-up"
        });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "include") {
        await setAccountStatus(account.id, "idle");
        await logEvent({ accountId: account.id, type: "account.included", message: "Back in the warm-up list" });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "start") {
        if (account.status === "excluded") return fail(response, sendJson, 409, "Цей акаунт виключено з прогріву");
        if (await activeRun(account.id)) return fail(response, sendJson, 409, "Цей акаунт уже прогрівається");

        let strategy;
        if (account.strategy_id) {
          const row = await anty.from("wl_strategies").select("*").eq("id", account.strategy_id).maybeSingle();
          strategy = row ? toStrategy(row) : await ensureDefaultStrategy();
        } else {
          strategy = await ensureDefaultStrategy();
        }

        const run = await anty.from("wl_runs").insert({
          account_id: account.id,
          strategy_id: strategy.id,
          // Snapshot: editing a strategy later must not rewrite what an account
          // part-way through was working to. Working mode goes in with it — the
          // strategy row has no column for one, so it is the code default,
          // frozen here like everything else.
          strategy_snapshot: {
            name: strategy.name, phases: strategy.phases, pauseDays: strategy.pauseDays,
            workingMode: workingModeOf(strategy)
          }
        }).select("*").single();

        await setAccountStatus(account.id, "warming");
        await logEvent({
          accountId: account.id, runId: run.id, type: "run.started",
          message: `Warm-up started on "${strategy.name}"`, meta: { days: totalDays(strategy) }
        });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      const run = await activeRun(account.id);
      if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

      // The same pause the agent starts when it reports one — see
      // `pauseForWarning`. It ends by itself; Resume is for ending it early.
      if (action === "warning") {
        const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;
        await pauseForWarning({ account, run, source: "operator", note });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      // Early, the paused dates not yet reached go back into the count: they
      // were taken when the warning came in, and the account is working them
      // now. Late — after the pause ran out, which already put the account
      // back to work — it only tidies the row, and the count stays as it is.
      if (action === "resume") {
        const todayIso = today();
        const credit = resumeCredit(run, todayIso, run.strategy_snapshot?.pauseDays ?? DEFAULT_STRATEGY.pauseDays);
        await anty.from("wl_runs").update({
          paused_until: null,
          state: "running",
          // From the dates the count is taken with now, stall included — the
          // same number `settlePause` would write — so a late resume leaves
          // the day where every screen already showed it.
          paused_days: Math.max(0, pausedDaysOn(run, todayIso) - credit)
        }).eq("id", run.id).rows();
        await setAccountStatus(account.id, "warming");
        await logEvent({
          accountId: account.id, runId: run.id, type: "run.resumed",
          message: credit ? `Warm-up resumed early — ${credit} paused day(s) given back to the count` : "Warm-up resumed",
          meta: { auto: false, givenBack: credit }
        });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "stop") {
        await anty.from("wl_runs").update({ state: "stopped", completed_at: new Date().toISOString() }).eq("id", run.id).rows();
        await setAccountStatus(account.id, "idle");
        await logEvent({ accountId: account.id, runId: run.id, level: "warn", type: "run.stopped", message: "Warm-up stopped" });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "record") {
        const kind = String(body.kind || "");
        if (!ACTION_KINDS.includes(kind)) return fail(response, sendJson, 400, "Невідома дія");
        const step = Number.isInteger(body.count) ? Math.max(1, Number(body.count)) : 1;
        const outcome = await recordAction(account, run, kind, step);
        if (!outcome.ok) return refusal(response, sendJson, outcome);
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      return fail(response, sendJson, 400, "Невідома дія");
    }

    // ── strategies ─────────────────────────────────────────────────────────
    //
    // A strategy is stored as phases and edited as days, and the fold from one
    // to the other lives here rather than on the screen: it is the half with
    // the rules — neighbouring days that say the same thing are one phase, and
    // what comes out has to be contiguous from day 1 or `validateStrategy`
    // refuses it. A client that sends `days` gets it done for them; one that
    // sends `phases` is talking to the same endpoint it always was.
    if (method === "GET" && path === "/strategies") {
      await ensureDefaultStrategy();
      const rows = await anty.from("wl_strategies").select("*").eq("is_archived", false)
        .order("is_default", { ascending: false }).order("created_at").rows();
      sendJson(response, 200, {
        success: true,
        strategies: rows.map((row) => {
          const strategy = toStrategy(row);
          return { ...strategy, days: toDays(strategy), totalDays: totalDays(strategy) };
        })
      });
      return true;
    }

    if (method === "POST" && path === "/strategies") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      if (Array.isArray(body.days)) body.phases = fromDays(body.days);
      const problem = validateStrategy(body);
      if (problem) return fail(response, sendJson, 400, problem);

      const created = await anty.from("wl_strategies").insert({
        name: String(body.name).trim(),
        description: body.description ? String(body.description) : null,
        phases: body.phases,
        pause_days: Number.isInteger(body.pauseDays) ? body.pauseDays : 2
      }).select("*").single();

      await logEvent({ type: "strategy.created", message: `Strategy "${created.name}" created` });
      sendJson(response, 201, { success: true, strategy: toStrategy(created) });
      return true;
    }

    if (method === "PATCH" && path === "/strategies") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Яка стратегія?");
      if (Array.isArray(body.days)) body.phases = fromDays(body.days);
      const problem = validateStrategy(body);
      if (problem) return fail(response, sendJson, 400, problem);

      const existing = await anty.from("wl_strategies").select("*").eq("id", String(body.id)).maybeSingle();
      if (!existing) return fail(response, sendJson, 404, "Стратегію не знайдено");

      const updated = await anty.from("wl_strategies").update({
        name: String(body.name).trim(),
        description: body.description ? String(body.description) : null,
        phases: body.phases,
        pause_days: Number.isInteger(body.pauseDays) ? body.pauseDays : existing.pause_days,
        updated_at: new Date().toISOString()
      }).eq("id", existing.id).select("*").single();

      // Runs already under way keep their snapshot; only future ones see this.
      await logEvent({
        type: "strategy.updated",
        message: `Strategy "${updated.name}" edited — runs already in progress keep the version they started on`
      });
      sendJson(response, 200, { success: true, strategy: toStrategy(updated) });
      return true;
    }

    if (method === "DELETE" && path === "/strategies") {
      const id = url.searchParams.get("id");
      if (!id) return fail(response, sendJson, 400, "Яка стратегія?");
      const existing = await anty.from("wl_strategies").select("*").eq("id", id).maybeSingle();
      if (!existing) return fail(response, sendJson, 404, "Стратегію не знайдено");
      if (existing.is_default) return fail(response, sendJson, 409, "Стратегію за замовчуванням видалити не можна");

      // Archived, not deleted: accounts point at it, and runs reference it for
      // provenance even though they carry their own snapshot.
      await anty.from("wl_strategies").update({ is_archived: true }).eq("id", existing.id).rows();
      await logEvent({ type: "strategy.archived", level: "warn", message: `Strategy "${existing.name}" archived` });
      sendJson(response, 200, { success: true });
      return true;
    }

    // ── proxies ────────────────────────────────────────────────────────────
    if (method === "GET" && path === "/proxies") {
      const rows = await anty.from("wl_proxies")
        .select("id,label,kind,host,port,username,country,status,last_checked_at,last_check_note")
        .order("created_at", { ascending: false }).rows();

      // How many accounts sit behind each proxy: when one burns, that is the
      // blast radius, and it belongs on the list rather than in someone's head.
      const usage = await anty.from("wl_accounts").select("proxy_id").rows();
      const counts = new Map();
      for (const row of usage) {
        if (row.proxy_id) counts.set(row.proxy_id, (counts.get(row.proxy_id) ?? 0) + 1);
      }

      sendJson(response, 200, { success: true, proxies: rows.map((proxy) => ({ ...proxy, accounts: counts.get(proxy.id) ?? 0 })) });
      return true;
    }

    if (method === "POST" && path === "/proxies") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");

      const label = String(body.label || "").trim();
      const host = String(body.host || "").trim();
      const port = Number(body.port);
      if (!label || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
        return fail(response, sendJson, 400, "Назва, хост і коректний порт обов'язкові");
      }
      const password = String(body.password || "");
      if (password && !secretsConfigured()) {
        return fail(response, sendJson, 503, "Сховище паролів не налаштоване (LINKEDIN_SECRET_KEY)");
      }

      const created = await anty.from("wl_proxies").insert({
        label, host, port,
        kind: ["http", "https", "socks5"].includes(String(body.kind)) ? String(body.kind) : "http",
        username: body.username ? String(body.username) : null,
        password_cipher: password ? encryptSecret(password) : null,
        country: body.country ? String(body.country) : null
      }).select("id,label,kind,host,port,username,country,status,last_checked_at").single();

      await logEvent({ type: "proxy.created", message: `Proxy "${label}" added (${host}:${port})` });
      sendJson(response, 201, { success: true, proxy: { ...created, accounts: 0 } });
      return true;
    }

    if (method === "DELETE" && path === "/proxies") {
      const id = url.searchParams.get("id");
      if (!id) return fail(response, sendJson, 400, "Який проксі?");
      const proxy = await anty.from("wl_proxies").select("id,label").eq("id", id).maybeSingle();
      if (!proxy) return fail(response, sendJson, 404, "Проксі не знайдено");

      // Accounts survive; they fall back to whatever their browser profile uses.
      await anty.from("wl_proxies").remove().eq("id", proxy.id).rows();
      await logEvent({ type: "proxy.deleted", level: "warn", message: `Proxy "${proxy.label}" deleted` });
      sendJson(response, 200, { success: true });
      return true;
    }

    // ── the log, sessions and outreach history ─────────────────────────────
    if (method === "GET" && path === "/events") {
      const accountId = url.searchParams.get("accountId");
      const level = url.searchParams.get("level");
      const limit = intParam(url.searchParams.get("limit"), 100, 500);

      // This route hands back `meta`, and for a message row `meta` is the
      // message — somebody's private reply, body and all. The inbox has screens
      // of its own; an account's history panel is not one of them.
      let query = anty.from("wl_events").select("id,account_id,level,type,message,meta,created_at")
        .notIn("type", AUDIT_HIDDEN_TYPES);
      if (accountId) query = query.eq("account_id", accountId);
      if (level && level !== "all") query = query.eq("level", level);
      const events = await query.order("created_at", { ascending: false }).limit(limit).rows();

      sendJson(response, 200, { success: true, events });
      return true;
    }

    if (method === "GET" && path === "/sessions") {
      const accountId = url.searchParams.get("accountId");
      if (!accountId) return fail(response, sendJson, 400, "Який акаунт?");
      // Capped rather than paged: the question this answers is "what has this
      // account been doing lately", and lately is not four months ago.
      const rows = await anty.from("wl_sessions")
        .select("id,account_id,profile_remote_id,started_at,ended_at,source,running_on,actions,note")
        .eq("account_id", accountId).order("started_at", { ascending: false }).limit(100).rows();
      sendJson(response, 200, { success: true, sessions: rows.map(describeSession) });
      return true;
    }

    if (method === "GET" && path === "/outreach") {
      const accountId = url.searchParams.get("accountId");
      if (!accountId) return fail(response, sendJson, 400, "Який акаунт?");
      const limit = intParam(url.searchParams.get("limit"), 100, 500);
      // Claims are deliberately not here: this list means "who we approached",
      // and a queued row is an allocation nobody has sent yet. GET /queue is
      // where those live. A waiting invitation is the same kind of thing — a
      // person held, nothing sent — and belongs with them.
      const rows = await anty.from("wl_outreach").select(OUTREACH_COLUMNS)
        .eq("account_id", accountId).notIn("status", [CLAIM_STATUS, WAITING_STATUS])
        .order("created_at", { ascending: false }).limit(limit).rows();
      sendJson(response, 200, { success: true, outreach: rows.map(describeOutreach) });
      return true;
    }

    /**
     * What came of a request: connected, declined, or withdrawn. Set by hand,
     * because nothing here can see the other person's answer.
     */
    if (method === "PATCH" && path === "/outreach") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Який запис аутрічу?");
      const status = String(body.status || "");
      if (!OUTREACH_STATUSES.includes(status)) return fail(response, sendJson, 400, "Невідомий статус");

      const existing = await anty.from("wl_outreach").select(OUTREACH_COLUMNS).eq("id", String(body.id)).maybeSingle();
      if (!existing) return fail(response, sendJson, 404, "Цього запису аутрічу вже немає");

      const patch = { status };
      if (typeof body.note === "string") patch.note = body.note.trim() || null;
      // Stamped on the way out of pending and cleared on the way back in, so the
      // time always means "when they answered". Kept as it was when one is
      // already recorded: correcting declined to connected should not move the
      // answer to the moment somebody fixed the typo.
      // `pending` has not answered and `accepted` has not either — it means
      // accepted and silent, which is the whole reason that status exists.
      // Stamping it would put a reply time on somebody who never wrote, and
      // that is the column the panel reads to say they did.
      patch.responded_at = ["pending", ACCEPTED_STATUS].includes(status)
        ? (status === "pending" ? null : existing.responded_at ?? null)
        : existing.responded_at ?? new Date().toISOString();

      const updated = await anty.from("wl_outreach").update(patch).eq("id", existing.id).select(OUTREACH_COLUMNS).single();
      await logEvent({
        accountId: existing.account_id, type: "outreach.updated",
        message: `${existing.person_name ?? "A contact"}: ${existing.status} → ${status}`,
        meta: { outreachId: existing.id, crmContactId: existing.crm_contact_id, from: existing.status, to: status }
      });
      sendJson(response, 200, { success: true, outreach: describeOutreach(updated) });
      return true;
    }

    // ── targeting: which folder, narrowed how, worked by whom ──────────────
    if (method === "GET" && path === "/folders") {
      try {
        sendJson(response, 200, {
          success: true,
          folders: await listFolders({ includeArchived: url.searchParams.get("archived") === "1" })
        });
      } catch (error) {
        return fail(response, sendJson, 502, crmError(error));
      }
      return true;
    }

    // ── campaigns: folder x accounts x product, and what they come to ─────
    if (method === "GET" && path === "/campaigns") {
      sendJson(response, 200, { success: true, campaigns: await enrichCampaigns(await loadCampaigns()) });
      return true;
    }

    /**
     * Create one. A campaign starts `draft` and last in order: nothing begins
     * working a folder of twenty thousand people because a form was submitted.
     */
    if (method === "POST" && path === "/campaigns") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");

      const name = String(body.name ?? "").trim();
      if (!name) return fail(response, sendJson, 400, "Дай кампанії назву");
      const folderId = String(body.folderId ?? "").trim();
      if (!folderId) return fail(response, sendJson, 400, "Обери папку, перш ніж зберігати кампанію");

      const accountIds = [...new Set((Array.isArray(body.accountIds) ? body.accountIds : [])
        .map((id) => String(id).trim()).filter(Boolean))];
      const productId = body.productId === undefined || body.productId === null ? null : String(body.productId).trim() || null;
      const fromDay = body.fromDay === undefined || body.fromDay === null ? { value: DEFAULT_FROM_DAY } : parseFromDay(body.fromDay);
      if (fromDay.error) return fail(response, sendJson, 400, fromDay.error);

      const checked = await checkCampaignInput({ folderId, accountIds, productId, products: campaignStore.products() });
      if (checked.error) return fail(response, sendJson, checked.status, checked.error);

      const campaigns = await loadCampaigns();
      const created = normalizeCampaign({
        name,
        folderId,
        folderName: checked.folderName,
        // Absent filters on a new campaign start where Phase 1 started: the lead
        // status the queue has always meant. Absent filters on a PATCH keep what
        // was saved, because a box cleared on purpose means every status.
        filters: body.filters === undefined ? defaultFilters() : normalizeFilters(body.filters),
        accountIds,
        productId,
        fromDay: fromDay.value,
        state: "draft",
        order: nextOrder(campaigns)
      });

      const next = [...campaigns, created];
      await saveCampaigns(next);
      await logEvent({
        type: "campaign.created",
        message: `Campaign "${created.name}" on "${checked.folderName}"${accountIds.length ? ` worked by ${accountIds.length} account${accountIds.length > 1 ? "s" : ""}` : " with no account chosen"}`,
        meta: { campaignId: created.id, folderId, accountIds, productId, fromDay: created.fromDay }
      });

      sendJson(response, 201, {
        success: true,
        campaign: await enrichCampaign(created, next, await campaignContext(next))
      });
      return true;
    }

    /**
     * Change one. Every field is optional and what is absent keeps its value,
     * so ticking an account can post `{ id, accountIds }` alone.
     */
    if (method === "PATCH" && path === "/campaigns") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Яка кампанія?");

      const campaigns = await loadCampaigns();
      const current = campaigns.find((campaign) => campaign.id === String(body.id));
      if (!current) return fail(response, sendJson, 404, "Цієї кампанії вже немає");

      const folderId = body.folderId === undefined ? current.folderId : String(body.folderId ?? "").trim();
      if (!folderId) return fail(response, sendJson, 400, "Обери папку, перш ніж зберігати кампанію");
      const accountIds = body.accountIds === undefined
        ? current.accountIds
        : [...new Set((Array.isArray(body.accountIds) ? body.accountIds : []).map((id) => String(id).trim()).filter(Boolean))];
      const productId = body.productId === undefined
        ? current.productId
        : body.productId === null ? null : String(body.productId).trim() || null;

      if (body.state !== undefined && !isCampaignState(body.state)) {
        return fail(response, sendJson, 400, `Невідомий стан: ${String(body.state)}`);
      }
      const state = body.state === undefined ? current.state : body.state;
      const fromDay = body.fromDay === undefined ? { value: current.fromDay } : parseFromDay(body.fromDay);
      if (fromDay.error) return fail(response, sendJson, 400, fromDay.error);

      const checked = await checkCampaignInput({ folderId, accountIds, productId, products: campaignStore.products() });
      if (checked.error) return fail(response, sendJson, checked.status, checked.error);

      const updated = normalizeCampaign({
        ...current,
        name: body.name === undefined ? current.name : String(body.name).trim() || current.name,
        folderId,
        folderName: checked.folderName,
        filters: body.filters === undefined ? current.filters : normalizeFilters(body.filters),
        accountIds,
        productId,
        fromDay: fromDay.value,
        state,
        order: current.order,
        updatedAt: new Date().toISOString()
      });

      // `order` moves the campaign to that position and renumbers its siblings.
      // Writing the number alone would leave two campaigns claiming one place.
      const wanted = body.order === undefined || body.order === null ? null : Number(body.order);
      const edited = campaigns.map((campaign) => (campaign.id === updated.id ? updated : campaign));
      const next = Number.isFinite(wanted) ? moveTo(edited, updated.id, wanted) : renumber(edited);
      await saveCampaigns(next);

      // Only the two moves an operator would look for in the log later: a
      // campaign that started sending, and one that stopped.
      if (state !== current.state && (state === "running" || state === "paused")) {
        await logEvent({
          type: state === "running" ? "campaign.started" : "campaign.paused",
          message: `Campaign "${updated.name}" ${state === "running" ? "started" : "paused"}`,
          meta: { campaignId: updated.id, from: current.state, to: state, accountIds: updated.accountIds }
        });
      }

      // The saved copy, not the one built above: a move renumbers it, and the
      // panel has to hear the position it actually landed in.
      const saved = next.find((campaign) => campaign.id === updated.id);
      sendJson(response, 200, {
        success: true,
        campaign: await enrichCampaign(saved, next, await campaignContext(next))
      });
      return true;
    }

    /**
     * Delete one, and let go of what it was holding. Rows already sent stay:
     * they are history, and history is not the campaign's to delete.
     */
    if (method === "DELETE" && path === "/campaigns") {
      const id = url.searchParams.get("id");
      if (!id) return fail(response, sendJson, 400, "Яка кампанія?");

      const campaigns = await loadCampaigns();
      const doomed = campaigns.find((campaign) => campaign.id === id);
      if (!doomed) return fail(response, sendJson, 404, "Цієї кампанії вже немає");

      const released = await releaseCampaignClaims(doomed, campaigns);
      await saveCampaigns(campaigns.filter((campaign) => campaign.id !== id));
      await logEvent({
        type: "campaign.deleted",
        message: `Campaign "${doomed.name}" deleted${released ? `, ${released} claim${released > 1 ? "s" : ""} released` : ""}`,
        meta: { campaignId: doomed.id, released }
      });

      sendJson(response, 200, { success: true, released });
      return true;
    }

    /**
     * Claim the next people for an account.
     *
     * A claim is an allocation, not a send: it costs no quota, and its cap is
     * today's remaining allowance so that nothing is allocated that could not
     * be sent. An account whose quota has not opened yet — every account for
     * its first three days — gets an empty list and a sentence saying when
     * requests start, because that is the ordinary answer, not a failure.
     */
    if (method === "POST" && path === "/campaigns/claim") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");
      const limit = intParam(body.limit, 0, 50);

      // First, before anything is counted: a claim nobody worked in time is a
      // person held out of the pool, and the capacity below has to see them gone.
      const released = await releaseExpiredClaims();

      const allowance = await connectAllowance(account);
      if (allowance.blocked) return fail(response, sendJson, 409, allowance.blocked);

      // Everything this account already holds counts against today: its claims,
      // and its waiting invitations — the folder's top-up among them. Without
      // the second, a claim on a day the folder had already filled allocated
      // people the day could never send. Counted as the hand-off counts them,
      // so a row it will not send today does not hold the day's room either.
      const campaigns = await loadCampaigns();
      const { waiting, claimed: held } = await heldCounts([account.id], {
        todayIso: today(), dayOf: new Map([[account.id, allowance.day]]),
    notesAllowedOf: new Map([[account.id, noteAllowedOnDay(allowance.run?.strategy_snapshot, allowance.day)]]), fromDayOf: fromDayLookup(campaigns)
      });
      const holding = (held.get(account.id) ?? 0) + (waiting.get(account.id) ?? 0);

      const remainingQuota = Math.max(0, allowance.quota - allowance.spent);
      const capacity = claimCapacity({ ...allowance, queued: holding, limit });
      const empty = (reason) => {
        sendJson(response, 200, { success: true, claimed: [], remainingQuota, reason, released });
        return true;
      };

      if (capacity === 0) return empty(allowanceReason({ ...allowance, queued: holding }));

      const working = runningFor(campaigns, account.id);
      if (!working.length) return empty("No running campaign works this account");

      // wl_outreach_person_once turning an insert down is somebody else
      // claiming this person a moment ago — `takeFromCampaigns` counts it and
      // moves on. That is the index doing its job, not a failed batch.
      const { taken: claimed, collided: taken, error } = await takeFromCampaigns({
        campaigns: working,
        need: capacity,
        take: async (lead, campaign) => describeClaim(await anty.from("wl_outreach").insert({
          account_id: account.id,
          ...personSnapshot(lead),
          sent_by: sentBy(account),
          status: CLAIM_STATUS
        }).select(CLAIM_COLUMNS).single(), campaign)
      });
      if (error) return fail(response, sendJson, 502, crmError(error));

      if (!claimed.length) {
        const first = working[0];
        return empty(`Nothing left in "${first.folderName || first.name}" that has not been approached`);
      }

      await logEvent({
        accountId: account.id, runId: allowance.run.id, type: "campaign.claimed",
        message: `Claimed ${claimed.length} contact${claimed.length > 1 ? "s" : ""} for ${account.label}${taken ? ` (${taken} taken by someone else)` : ""}`,
        meta: { claimed: claimed.length, skipped: taken, remainingQuota, campaignIds: [...new Set(claimed.map((row) => row.campaignId))] }
      });

      sendJson(response, 200, { success: true, claimed, remainingQuota, reason: null, released });
      return true;
    }

    /** Let go: everything expired, or everything this account is holding. */
    if (method === "POST" && path === "/campaigns/release") {
      // No body is the whole-board release, which is the common case — it should
      // not need an empty object typed out to be understood.
      const body = (await readJson(request)) || {};

      let released = await releaseExpiredClaims();
      const accountId = body.accountId ? String(body.accountId).trim() : "";
      if (accountId) {
        const rows = await anty.from("wl_outreach").select("id")
          .eq("account_id", accountId).eq("status", CLAIM_STATUS).rows();
        const count = await deleteClaims(rows.map((row) => row.id));
        released += count;
        if (count) {
          await logEvent({
            accountId, type: "campaign.released",
            message: `Released ${count} claim${count > 1 ? "s" : ""} back to the pool`,
            meta: { released: count, reason: "asked" }
          });
        }
      }

      sendJson(response, 200, { success: true, released });
      return true;
    }

    /**
     * What is claimed to an account right now, oldest first.
     *
     * Always a 200: an account that is paused, unhealthy or three days from its
     * first request still has a queue worth showing, and "why is it empty" is
     * the question the panel is really asking. The answer is `reason`.
     */
    if (method === "GET" && path === "/queue") {
      const accountId = url.searchParams.get("accountId");
      if (!accountId) return fail(response, sendJson, 400, "Який акаунт?");
      const account = await loadAccount(accountId);
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");

      // Expired claims are hidden rather than deleted here: a read that quietly
      // rewrites the database is a read nobody can reason about. The next claim
      // releases them.
      const rows = await anty.from("wl_outreach").select(CLAIM_COLUMNS)
        .eq("account_id", account.id).eq("status", CLAIM_STATUS)
        .gte("created_at", claimCutoff())
        .order("created_at", { ascending: true }).rows();

      const all = await loadCampaigns();
      const campaigns = runningFor(all, account.id);
      const byFolder = await claimOwners(campaigns, rows);
      const allowance = await connectAllowance(account);

      let reason = null;
      if (!rows.length) {
        reason = allowance.blocked
          ?? allowanceReason({ ...allowance, queued: 0 })
          ?? (campaigns.length ? "Nothing is claimed to this account right now" : "No running campaign works this account");
      }

      // What the agent will send from this account, and which of it the folder
      // added. The claims above are a person's list; these are the agent's.
      const waitingRows = await anty.from("wl_outreach").select(CLAIM_COLUMNS)
        .eq("account_id", account.id).eq("status", WAITING_STATUS)
        .order("created_at", { ascending: true }).limit(100).rows();
      // What decides whether each goes: the same facts the hand-off reads, so a
      // row the agent will never be handed is shown as needing a person.
      const facts = await waitingFacts(waitingRows, today());
      const fed = facts.fed;

      // Whether the campaign on screen fills this account by itself today, and
      // from which day it will. Said as facts — the panel words them — because
      // "not yet" and "not at all" need different sentences.
      const wanted = url.searchParams.get("campaignId");
      const shown = (wanted && all.find((campaign) => campaign.id === wanted)) || campaigns[0] || null;
      const day = allowance.blocked ? null : allowance.day;
      // The running campaigns ranked above the shown one that feed this
      // account today. The top-up fills the room first campaign first, so
      // while any of these has people the shown one's folder never moves, and
      // `on` alone read as "this folder is being worked".
      const feeding = day === null ? [] : feedingFor(all, account.id, day);
      const shownAt = shown ? feeding.findIndex((campaign) => campaign.id === shown.id) : -1;
      const ahead = feeding.slice(0, Math.max(0, shownAt)).map((campaign) => ({ id: campaign.id, name: campaign.name }));
      const autoFeed = shown ? {
        campaignId: shown.id,
        campaignName: shown.name,
        fromDay: shown.fromDay,
        day,
        working: Boolean(allowance.working),
        running: shown.state === "running",
        ticked: shown.accountIds.includes(account.id),
        blocked: allowance.blocked ?? null,
        on: !allowance.blocked && shown.state === "running" && shown.accountIds.includes(account.id) && day >= shown.fromDay,
        ahead,
        connectsLeft: allowance.blocked ? 0 : Math.max(0, (allowance.quota || 0) - (allowance.spent || 0))
      } : null;

      sendJson(response, 200, {
        success: true,
        accountId: account.id,
        queue: rows.map((row) => describeClaim(row, byFolder.get(row.id) ?? null)),
        reason,
        waiting: waitingRows.map((row) => ({
          ...describeClaim(row),
          fromFolder: fed.has(String(row.id)),
          campaignName: fed.get(String(row.id))?.campaignName ?? null,
          // A block page on this request: parked — the agent is not handed it
          // again until a person moves it to another account or cancels it.
          parked: facts.parked.has(String(row.id))
        })),
        autoFeed
      });
      return true;
    }

    // ── the lead queue ─────────────────────────────────────────────────────
    /**
     * The next people a campaign would reach — the manual path, kept as it was
     * except that the folder now comes from a campaign rather than from the one
     * saved targeting. Without `campaignId` it is the first running campaign,
     * which is the same one `claim` would serve.
     */
    if (method === "GET" && path === "/leads") {
      const limit = intParam(url.searchParams.get("limit"), 10, 50);
      const campaigns = await loadCampaigns();
      const wanted = url.searchParams.get("campaignId");
      const campaign = wanted
        ? campaigns.find((row) => row.id === wanted)
        : campaigns.find((row) => row.state === "running" && row.folderId) || campaigns.find((row) => row.folderId);

      // An empty queue and an unconfigured one are different answers, and only
      // one of them is the operator's to fix.
      if (!campaign?.folderId) {
        sendJson(response, 409, {
          success: false,
          error: wanted ? "Цієї кампанії вже немає" : "Створи кампанію, перш ніж тягнути ліди",
          // Kept under its Phase 1 name as well, so a panel that has not moved
          // to campaigns yet still tells the prompt from a real failure.
          needsCampaign: true,
          needsTargeting: true
        });
        return true;
      }

      const targeting = targetingOf(campaign);
      try {
        const [leads, total, name] = await Promise.all([
          nextCandidates(limit, targeting),
          queueTotal(targeting),
          folderNameOf(targeting.folderId)
        ]);
        sendJson(response, 200, {
          success: true,
          campaign: describeCampaign(campaign, name),
          targeting: describeTargeting(targeting, name),
          queueTotal: total,
          leads: leads.map((lead) => ({
            id: lead.id,
            name: lead.name,
            company: lead.company,
            position: lead.position,
            linkedin: lead.linkedin,
            country: lead.country,
            createdAt: lead.created_at
          }))
        });
      } catch (error) {
        // The CRM being unreachable is a different answer from "nobody left to
        // approach", and the panel has to be able to tell them apart.
        return fail(response, sendJson, 502, crmError(error));
      }
      return true;
    }

    /**
     * "I sent this person a connection request."
     *
     * One click that has to land in two places at once: the outreach record, so
     * nobody is approached twice from any account, and the warm-up day counter,
     * so a request sent from here costs the same as one recorded by hand.
     *
     * The order below is the whole design. The quota is asked first and nothing
     * is written when it refuses, so a request that was never allowed leaves no
     * trace claiming the person has been approached. The outreach row goes in
     * next, because that is the write that can still fail — the person may have
     * been taken from another account a second ago — and only once it is safely
     * in does the day counter move.
     */
    // ── invitations asked for from the lead workspace ─────────────────────
    //
    // The quota is read here and spent elsewhere: what is worth counting is
    // the request that actually leaves an account, and the agent is the only
    // thing that knows when that happened. A seller may queue an invitation on
    // an account with nothing left today — it goes out tomorrow, and the screen
    // says which account and since when.

    if (method === "GET" && path === "/invites/accounts") {
      // Named columns rather than `*`: this answer is assembled field by field
      // so nothing leaks today, but the next route copied from this one will
      // return whatever it selected, and `wl_accounts` holds a password cipher.
      const rows = await anty.from("wl_accounts")
        .select("id,label,login,status,health,profile_remote_id")
        .neq("status", "excluded").rows();
      const accounts = await Promise.all(rows.map(async (account) => {
        const allowance = await connectAllowance(account);
        const waiting = await anty.from("wl_outreach").select("id")
          .eq("account_id", account.id).eq("status", WAITING_STATUS).count();
        const left = allowance.blocked ? 0 : Math.max(0, (allowance.quota || 0) - (allowance.spent || 0));
        const strategy = allowance.run?.strategy_snapshot;
        // What this account's plan says about notes, sent to the screen where
        // the note is actually written. A seller approves a sentence days
        // before the request goes out, and on a day that forbids notes it
        // would never reach anybody — silently, and looking like a success.
        // Saying it at the keyboard is the only place it can still be acted
        // on.
        const notesAllowed = Boolean(strategy) && noteAllowedOnDay(strategy, allowance.day);
        return {
          id: account.id,
          label: account.label,
          login: account.login,
          status: account.status,
          health: account.health,
          connectQuota: allowance.blocked ? 0 : allowance.quota || 0,
          connectsDone: allowance.blocked ? 0 : allowance.spent || 0,
          connectsLeft: left,
          waiting,
          // Today's note rule on this account — `false` for none, or
          // `{ maxWords, allowLinks }`; `null` when the account cannot send at
          // all, which says nothing about notes. The form uses it to say, while
          // the note is typed, whether it will go; the hand-off decides for
          // real, by the rule of the day the request actually leaves.
          noteRule: allowance.blocked ? null : noteRuleFor(allowance),
          day: allowance.blocked ? null : allowance.day ?? null,
          notesAllowedToday: notesAllowed,
          nextNoteDay: strategy ? nextNoteDay(strategy, allowance.day || 1) : null,
          // An account that cannot carry an invitation is still listed, with
          // the reason. Hiding it leaves a seller wondering where their login
          // went; saying "on a captcha" tells them what to go and fix.
          canSend: !allowance.blocked && Boolean(account.profile_remote_id),
          reason: allowance.blocked || (account.profile_remote_id ? "" : "Профіль Anty не прив'язано")
        };
      }));
      accounts.sort((left, right) => Number(right.canSend) - Number(left.canSend) || right.connectsLeft - left.connectsLeft);
      sendJson(response, 200, { success: true, accounts });
      return true;
    }

    /**
     * Everything that ever passed between us and one person, in one list.
     *
     * Keyed by the CRM contact rather than by a thread: a thread is one
     * conversation on one account, and the question a seller asks in front of
     * a lead is "what has anybody here ever said to them". The invitation, the
     * LinkedIn messages both ways, and — when Phase 4 lands — the emails.
     *
     * The invitation is dated by its `invite.sent` event rather than by the
     * row's `created_at`, which is the moment the person was held: hours or a
     * day earlier, and a timeline ordered by it puts the request before things
     * that happened before it.
     */
    if (method === "GET" && path === "/history") {
      const crmContactId = url.searchParams.get("crmContactId");
      if (!crmContactId) return fail(response, sendJson, 400, "Який контакт?");

      const outreach = await outreachForContact(crmContactId);
      const events = await inviteEvents(crmContactId);
      // Asked even with no approach on record: a person found by the LinkedIn
      // link on their contact has messages under their key and no row here.
      const found = await messagesForContact({
        accountId: outreach?.account_id ?? null,
        crmContactId,
        personName: outreach?.person_name,
        personLinkedin: outreach?.person_linkedin
      });
      // Which login each message is on, by the name the screens already use.
      const accountIds = [...new Set(found.map((message) => message.accountId).filter(Boolean))];
      const labels = new Map((accountIds.length
        ? await anty.from("wl_accounts").select("id,label,login").in("id", accountIds).rows()
        : []).map((row) => [row.id, row.login?.trim() || row.label || ""]));
      const messages = found.map((message) => ({ ...message, accountLabel: labels.get(message.accountId) || null }));

      const invite = await inviteView(outreach, events);
      const entries = [
        ...events
          // `invite.checked` is written on every look, including the ones that
          // saw nothing. It belongs in the account's log, not in a person's
          // story, where a fortnight of "checked, no change" would bury the
          // three lines that matter.
          .filter((event) => event.type !== "invite.checked")
          .map((event) => ({
            id: event.id,
            kind: "invite",
            direction: "out",
            // The event's own timestamp, which is the whole reason the
            // invitation is read from events rather than from the row.
            at: event.at,
            event: event.type,
            body: event.message,
            meta: event.meta
          })),
        ...messages
      ].sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));

      sendJson(response, 200, {
        success: true,
        contact: {
          crmContactId,
          name: outreach?.person_name || "",
          company: outreach?.person_company || ""
        },
        invite,
        outreach: outreach ? describeOutreach(outreach) : null,
        entries,
        // Said plainly rather than left for somebody to work out from an empty
        // list: nothing has been written to this person from this workspace.
        empty: entries.length === 0
      });
      return true;
    }

    if (method === "GET" && path === "/invites") {
      const crmContactId = url.searchParams.get("crmContactId");
      if (!crmContactId) return fail(response, sendJson, 400, "Який контакт?");
      const row = await outreachForContact(crmContactId);
      const events = row ? await inviteEvents(crmContactId) : [];
      sendJson(response, 200, { success: true, invite: await inviteView(row, events), events });
      return true;
    }

    if (method === "POST" && path === "/invites") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      if (!body.crmContactId) return fail(response, sendJson, 400, "Який контакт?");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");

      let lead;
      try {
        lead = await leadById(String(body.crmContactId));
      } catch (error) {
        return fail(response, sendJson, 502, crmError(error));
      }
      if (!lead) return fail(response, sendJson, 404, "Цього контакту вже немає в CRM");
      if (!lead.linkedin) return fail(response, sendJson, 400, "У цього контакту немає LinkedIn — нема куди слати запит");

      let row;
      try {
        row = await requestInvite({
          account,
          lead,
          note: String(body.note || ""),
          requestedBy: request.auth?.profile?.email || ""
        });
      } catch (error) {
        // wl_outreach_person_once. Not an error — the answer to "who has this
        // person", which is a screen rather than a failure.
        if (error instanceof RestError && error.code === "23505") {
          const existing = await outreachForContact(lead.id);
          sendJson(response, 409, {
            success: false,
            error: "Ця людина вже в аутрічі",
            existing: await inviteView(existing, existing ? await inviteEvents(lead.id) : [])
          });
          return true;
        }
        throw error;
      }

      const allowance = await connectAllowance(account);
      sendJson(response, 200, {
        success: true,
        invite: await inviteView(row, await inviteEvents(lead.id)),
        connectsLeft: allowance.blocked ? 0 : Math.max(0, (allowance.quota || 0) - (allowance.spent || 0))
      });
      return true;
    }

    if (method === "POST" && path === "/invites/cancel") {
      const body = await readJson(request);
      if (!body?.outreachId) return fail(response, sendJson, 400, "Яке запрошення?");
      const gone = await cancelInvite({
        outreachId: String(body.outreachId),
        cancelledBy: request.auth?.profile?.email || ""
      });
      if (!gone) return fail(response, sendJson, 409, "Скасувати можна лише те, що ще не надіслано");
      // `skipped`: the folder had added this person, and will not again.
      sendJson(response, 200, { success: true, released: gone.crm_contact_id, skipped: gone.skipped });
      return true;
    }

    if (method === "POST" && path === "/invites/reassign") {
      const body = await readJson(request);
      if (!body?.outreachId || !body?.accountId) return fail(response, sendJson, 400, "Яке запрошення і на який акаунт?");
      const account = await loadAccount(String(body.accountId));
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");
      const moved = await reassignInvite({
        outreachId: String(body.outreachId),
        account,
        movedBy: request.auth?.profile?.email || ""
      });
      if (!moved) return fail(response, sendJson, 409, "Перекинути можна лише те, що ще не надіслано");
      sendJson(response, 200, { success: true, invite: await inviteView(moved, await inviteEvents(moved.crm_contact_id)) });
      return true;
    }

    /**
     * "I sent it myself" — the seller clicked Connect in their own browser.
     *
     * This is the one place the quota gives way, and it gives way on purpose:
     * the request already exists on LinkedIn. Refusing to write it down does
     * not un-send it, it only makes our own record false — and a person with no
     * `wl_outreach` row is handed straight back to the next campaign that asks.
     * The quota governs what we *cause*; this is recording what we *observe*.
     * Beyond the allowance it is still written, flagged, and logged at warn.
     */
    if (method === "POST" && path === "/invites/sent-by-hand") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      if (!body.crmContactId) return fail(response, sendJson, 400, "Який контакт?");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");
      return await withAccountQuota(account.id, async () => {

      let lead;
      try {
        lead = await leadById(String(body.crmContactId));
      } catch (error) {
        return fail(response, sendJson, 502, crmError(error));
      }
      if (!lead) return fail(response, sendJson, 404, "Цього контакту вже немає в CRM");

      const run = await activeRun(account.id);
      const allowance = run ? await checkQuota(account, run, "connect") : { ok: false };
      const overQuota = !allowance.ok;

      const existing = await outreachForContact(lead.id);
      let outreach;
      if (existing && existing.status === WAITING_STATUS) {
        const moved = await moveStatus({
          outreachId: existing.id,
          to: "pending",
          patch: { account_id: account.id, ...personSnapshot(lead), sent_by: sentBy(account) }
        });
        if (!moved.moved) return fail(response, sendJson, 409, "Це запрошення вже не чекає — перечитай картку");
        outreach = moved.row;
      } else if (existing) {
        return fail(response, sendJson, 409, `Ця людина вже в аутрічі (${existing.sent_by}, ${existing.status})`);
      } else {
        try {
          outreach = await anty.from("wl_outreach").insert({
            account_id: account.id,
            ...personSnapshot(lead),
            sent_by: sentBy(account),
            status: "pending",
            note: String(body.note || "").trim() || null
          }).select(OUTREACH_COLUMNS).single();
        } catch (error) {
          if (error instanceof RestError && error.code === "23505") {
            return fail(response, sendJson, 409, "Ця людина вже в аутрічі");
          }
          throw error;
        }
      }

      if (!overQuota) await commitAction(account, run, "connect", allowance, "sent by hand");
      await recordSent({ account, run, outreach, by: "seller", overQuota, allowance: overQuota ? null : allowance });

      sendJson(response, 200, {
        success: true,
        invite: await inviteView(outreach, await inviteEvents(lead.id)),
        overQuota
      });
      return true;
      });
    }

    if (method === "POST" && path === "/leads/take") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      if (!body.crmContactId) return fail(response, sendJson, 400, "Який контакт?");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");
      return await withAccountQuota(account.id, async () => {

      const run = await activeRun(account.id);
      if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

      // Re-read rather than trusting what the panel had on screen: it may have
      // been open for an hour, and the snapshot we keep is the answer to "who
      // did we approach" long after the CRM row has moved on.
      let lead;
      try {
        lead = await leadById(String(body.crmContactId));
      } catch (error) {
        return fail(response, sendJson, 502, crmError(error));
      }
      if (!lead) return fail(response, sendJson, 404, "Цього контакту вже немає в CRM");

      const allowance = await checkQuota(account, run, "connect");
      if (!allowance.ok) return refusal(response, sendJson, allowance);

      // A claim already standing for this person is the row this send belongs
      // to. Updating it keeps one row per person and never fights the unique
      // index — an insert beside a claim would lose to it every time.
      //
      // Scoped to this account on purpose. Unscoped, a send from account B
      // rewrote a claim account A was holding — the patch sets `account_id` —
      // and A's allocation vanished with nothing recording the reassignment.
      // Harmless while only campaigns claimed; reachable the day a person can
      // pick the account by hand.
      const claim = await anty.from("wl_outreach").select("id,account_id")
        .eq("crm_contact_id", lead.id).eq("account_id", account.id).eq("status", CLAIM_STATUS).maybeSingle();
      if (!claim) {
        const elsewhere = await anty.from("wl_outreach").select("id,sent_by,status,created_at")
          .eq("crm_contact_id", lead.id).maybeSingle();
        if (elsewhere) {
          return fail(response, sendJson, 409, elsewhere.status === CLAIM_STATUS
            ? `Цю людину закріпив інший акаунт (${elsewhere.sent_by})`
            : "Ця людина вже в аутрічі");
        }
      }

      let outreach;
      try {
        const sent = {
          account_id: account.id,
          ...personSnapshot(lead),
          sent_by: sentBy(account),
          status: "pending"
        };
        if (claim) {
          // Guarded on the status it was read with, so two screens sending the
          // same claim leave one send and one honest refusal rather than two.
          const updated = await anty.from("wl_outreach").update(sent)
            .eq("id", claim.id).eq("status", CLAIM_STATUS).select(OUTREACH_COLUMNS).rows();
          if (!updated.length) return fail(response, sendJson, 409, "Ця людина вже в аутрічі");
          outreach = updated[0];
        } else {
          // The manual path: nobody claimed this person, so the send makes the row.
          outreach = await anty.from("wl_outreach").insert(sent).select(OUTREACH_COLUMNS).single();
        }
      } catch (error) {
        // wl_outreach_person_once: one person, one approach, across every
        // account. A race between two screens is expected here, not exceptional.
        if (error instanceof RestError && error.code === "23505") {
          return fail(response, sendJson, 409, "Ця людина вже в аутрічі");
        }
        throw error;
      }

      await commitAction(account, run, "connect", allowance);

      const sentEvent = await logEvent({
        accountId: account.id, runId: run.id, type: OUTREACH_SENT,
        message: `Connection request to ${lead.name ?? "a contact"}${lead.company ? ` (${lead.company})` : ""}`,
        meta: {
          outreachId: outreach.id, crmContactId: lead.id, claimed: Boolean(claim),
          day: allowance.day, done: allowance.done, quota: allowance.quota
        }
      }, { returning: true });
      // A request sent by hand is still a request on the person's CRM timeline.
      await copyRequestToCrm({ account, outreach, event: sentEvent });

      sendJson(response, 200, {
        success: true,
        outreach: describeOutreach(outreach),
        account: await describeAccount(await loadAccount(account.id))
      });
      return true;
      });
    }

    /**
     * Whether this deployment's key may update a row in `wl_events`.
     *
     * A POST because it writes — the scheduler already learned what a GET with
     * a side effect costs, and a probe somebody curls should not be the thing
     * that leaves a row behind.
     */
    if (method === "POST" && path === "/diagnostics/event-write") {
      sendJson(response, 200, { success: true, probe: await probeEventWriteAccess() });
      return true;
    }

    // ── reconciling Anty's "profile is running" with the sessions table ────
    if (method === "POST" && path === "/sync") {
      sendJson(response, 200, await syncSessions());
      return true;
    }

    // ── the inbox ──────────────────────────────────────────────────────────
    //
    // Everything under here reads and writes through `warmup/inbox.mjs` and
    // never names the table the messages happen to live in. That is the whole
    // point of that module: when a Postgres password arrives and threads get
    // tables of their own, this file does not change.
    if (method === "GET" && path === "/inbox") {
      const accountId = url.searchParams.get("accountId") || null;
      const unreadOnly = url.searchParams.get("unread") === "1";
      // Everything first, then the filter: the per-account summary has to keep
      // saying how much an account holds in total while the list above it shows
      // only what is unread. Filtering first would make the two disagree.
      const held = await listThreads({ accountId });
      const threads = unreadOnly ? held.filter((thread) => thread.unread) : held;

      const accounts = await anty.from("wl_accounts").select("id,label").rows();
      const [identities, outreach] = await Promise.all([loginIdentities(), outreachFor(threads)]);
      const labels = new Map(accounts.map((account) => [account.id, account.label]));

      sendJson(response, 200, {
        success: true,
        unread: held.filter((thread) => thread.unread).length,
        // A reply belongs to the login it arrived on, and the screen groups by
        // exactly this: one heading per account, carrying its own unread count.
        accounts: summarizeAccounts(held).map((account) => ({
          ...account,
          label: labels.get(account.accountId) ?? null,
          identity: identities.get(account.accountId)?.name ?? null
        })),
        // Top level as well as per thread: the one case this value decides —
        // an empty inbox — is the case with no thread to carry it, and
        // "nothing arrived" and "the agent never ran" need different people to
        // do different things.
        sync: { ...await syncSummary(accounts.map((account) => account.id)), window: windowLabel() },
        threads: threads.map((thread) => describeThread(thread, { labels, identities, outreach }))
      });
      return true;
    }

    if (method === "GET" && path === "/inbox/thread") {
      const accountId = url.searchParams.get("accountId") || "";
      const threadKey = url.searchParams.get("threadKey") || "";
      if (!accountId || !threadKey) return fail(response, sendJson, 400, "Треду потрібні accountId і threadKey");

      const found = await readThread({ accountId, threadKey });
      if (!found) return fail(response, sendJson, 404, "Тред не знайдено");

      const account = await loadAccount(accountId);
      const [identities, outreach] = await Promise.all([loginIdentities(), outreachFor([found.thread])]);

      // What can be done with the conversation from here. A reply is only to
      // somebody who wrote, from an account the agent will open — and the
      // screen is told which, and why not, rather than left to find out.
      const door = await replyDoor(account);
      const answerable = found.messages.some((message) => message.direction === "in");
      const [queue, goesOut] = await Promise.all([
        account ? repliesOf(account.id) : [],
        door.open && account ? replyGoesOut(account) : null
      ]);
      const own = queue.filter((reply) => reply.threadKey === threadKey);
      const allowance = account && door.open ? await repliesToSend(account.id, { todayIso: today() }) : null;

      sendJson(response, 200, {
        success: true,
        thread: describeThread(found.thread, {
          labels: new Map(account ? [[account.id, account.label]] : []),
          identities,
          outreach
        }),
        messages: found.messages,
        outbox: visibleReplies(own, found.messages),
        reply: {
          canWrite: door.open && answerable,
          reason: !door.open ? door.reason : (answerable ? null : "Тут ще ніхто не відповів — це не відповідь, а перше повідомлення, і воно йде через «Прогрів»."),
          limit: REPLY_LIMIT,
          goesOutAt: goesOut?.at ?? null,
          goesOutToday: goesOut?.today ?? null,
          goesOutSoon: goesOut?.soon ?? false,
          window: windowLabel(),
          sentToday: allowance?.sentToday ?? 0,
          perDay: allowance?.perDay ?? null
        }
      });
      return true;
    }

    // A reply, written on the screen and sent by the account. This only asks:
    // the browser is the agent's, and the reply goes out in the account's own
    // next session (see `outbox.mjs` for why that is the design and not a gap).
    if (method === "POST" && path === "/inbox/reply") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      const accountId = String(body.accountId || "");
      const threadKey = String(body.threadKey || "");
      if (!accountId || !threadKey) return fail(response, sendJson, 400, "Відповіді потрібні accountId і threadKey");

      const account = await loadAccount(accountId);
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");
      const door = await replyDoor(account);
      if (!door.open) return fail(response, sendJson, 409, door.reason);

      const found = await readThread({ accountId, threadKey });
      if (!found) return fail(response, sendJson, 404, "Тред не знайдено");
      if (!found.messages.some((message) => message.direction === "in")) {
        return fail(response, sendJson, 409, "Тут ще ніхто не відповів — це не відповідь, а перше повідомлення, і воно йде через «Прогрів».");
      }

      return await withAccountQuota(account.id, async () => {
        const queued = await queueReply({
          accountId, threadKey, text: body.text,
          participantName: found.thread.participant?.name ?? null,
          todayIso: today()
        });
        if (!queued.ok) return fail(response, sendJson, queued.status, queued.error);
        const goesOut = await replyGoesOut(account);
        sendJson(response, queued.duplicate ? 200 : 201, {
          success: true, reply: queued.reply, duplicate: queued.duplicate,
          goesOutAt: goesOut.at, goesOutToday: goesOut.today, goesOutSoon: goesOut.soon, window: windowLabel()
        });
        return true;
      });
    }

    // Take a reply back before it is sent, or put away one that did not go.
    if (method === "POST" && path === "/inbox/reply/cancel") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      const accountId = String(body.accountId || "");
      const replyId = String(body.replyId || "");
      if (!accountId || !replyId) return fail(response, sendJson, 400, "Потрібні accountId і replyId");
      if (!await loadAccount(accountId)) return fail(response, sendJson, 404, "Акаунт не знайдено");
      const cancelled = await cancelReply(accountId, replyId);
      if (!cancelled.ok) return fail(response, sendJson, cancelled.status, cancelled.error);
      sendJson(response, 200, { success: true, reply: cancelled.reply });
      return true;
    }

    if (method === "POST" && path === "/inbox/read") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      const accountId = String(body.accountId || "");
      const threadKey = String(body.threadKey || "");
      if (!accountId || !threadKey) return fail(response, sendJson, 400, "Треду потрібні accountId і threadKey");
      if (!await loadAccount(accountId)) return fail(response, sendJson, 404, "Акаунт не знайдено");

      // Marking an already-read thread is a harmless no-op, and the mark is
      // written anyway: opening a thread twice is the normal case, and the
      // second mark is what keeps it read when a reply landed between the two.
      const readAt = await markRead(accountId, threadKey);
      // The badge's new number, so the one screen that just changed it does not
      // have to ask for the whole config again to find out.
      sendJson(response, 200, { success: true, readAt, unread: await unreadCount() });
      return true;
    }

    // ── the seam between the portal and the agent ──────────────────────────
    // The agent knows a profile by its name, not by an id, and has to resolve
    // one to the other before it can ask for anything else. Under /agent so the
    // agent token reaches it, and deliberately thin — ids, names and the linked
    // profile, nothing about proxies, no secrets and nothing from the CRM. A
    // token sitting on somebody's laptop is not a copy of the workspace.
    /**
     * What somebody asked to have looked at, by opening the link in the group.
     *
     * The page cannot check a login — it owns no browser — so it records the
     * ask and this is where the watch collects it. Only the unanswered ones,
     * and only from today: a request nobody got to in a day is stale, and the
     * daily check covers that account anyway.
     */
    if (method === "GET" && path === "/agent/login-checks") {
      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const asked = await anty.from("wl_events").select("id,account_id,meta,created_at")
        .eq("type", RECHECK_REQUESTED).gte("created_at", since)
        .order("created_at", { ascending: true }).limit(50).rows();
      const answered = new Set((await anty.from("wl_events").select("meta")
        .eq("type", RECHECK_DONE).gte("created_at", since).limit(200).rows())
        .map((row) => String(row.meta?.nonce ?? "")));
      sendJson(response, 200, {
        success: true,
        checks: asked
          .filter((row) => row.meta?.nonce && !answered.has(String(row.meta.nonce)))
          .map((row) => ({ nonce: String(row.meta.nonce), accountId: row.account_id, requestedAt: row.created_at }))
      });
      return true;
    }

    if (method === "GET" && path === "/agent/accounts") {
      const rows = await anty.from("wl_accounts").select("id,label,login,profile_remote_id,status,health").rows();
      /**
       * The signed link for an account that needs a person, made here rather
       * than by the agent: the key is the portal's, and the agent image does
       * not carry this folder at all. A path, not a URL — the watch knows
       * which address of this portal it is allowed to publish.
       *
       * A fresh nonce on every read is deliberate: each message carries its
       * own single-use link, so yesterday's link in the chat cannot be the one
       * that answers today's question.
       */
      const linkFor = (row) => {
        if (!["needs_login", "captcha"].includes(row.health)) return null;
        try {
          return `/api/warmup/login-check?t=${encodeURIComponent(issueLoginCheck(row.id))}`;
        } catch {
          // No token configured to sign with: the watch simply sends no button.
          return null;
        }
      };
      sendJson(response, 200, {
        success: true,
        accounts: rows.map((row) => ({
          id: row.id,
          label: row.label,
          login: row.login,
          profileRemoteId: row.profile_remote_id,
          status: row.status,
          health: row.health,
          loginCheckPath: linkFor(row)
        }))
      });
      return true;
    }

    // The worker's only question, and the whole of the pacing.
    //
    // It answers 200 in every state — "nobody owes work" is an answer, not an
    // error — because the thing asking has no window, no order and no gap of
    // its own, and a 4xx would leave it with nothing to sleep on.
    //
    // It grants nothing, and that is the whole design: a GET that leased would
    // have made every curl, health check, monitor and client-side timeout cost
    // a real account its session, with a quiet morning as the only symptom.
    // Taking the account is the POST below.
    if (method === "GET" && path === "/agent/due") {
      // The campaigns go in so a folder with people left counts as work. They
      // are only read here — nothing is taken until the account is.
      sendJson(response, 200, await decideNext({ campaigns: readCampaigns() }));
      return true;
    }

    // Taking it. Separate from the question on purpose — see `leaseAccount` —
    // and the only place a lease is ever granted.
    if (method === "POST" && path === "/agent/lease") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");
      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Account not found");

      const campaigns = readCampaigns();
      const outcome = await leaseAccount({ accountId: account.id, campaigns });
      if (!outcome.ok) {
        // 409 rather than an error the worker has to interpret: somebody else
        // got there first is an ordinary state, and the answer carries both the
        // sentence for the log and the number to sleep on.
        sendJson(response, outcome.status, {
          success: false,
          error: outcome.error,
          reason: outcome.error,
          retryAfterSeconds: outcome.retryAfterSeconds
        });
        return true;
      }
      // Answered at once, with nothing written for the folder here. The
      // top-up happens on `GET /agent`, which the agent asks straight after
      // taking the account and which fills the same room idempotently; doing
      // it here as well only doubled the work and held back the one answer
      // whose loss strands a lease — a worker that times out on this reply
      // never learns the `leaseId` the server already granted.
      sendJson(response, 200, { success: true, lease: outcome.lease });
      return true;
    }

    if (method === "GET" && path === "/agent") {
      const accountId = url.searchParams.get("accountId");
      // Without an account, the one thing worth answering is whether the agent
      // should be running at all right now.
      if (!accountId) {
        sendJson(response, 200, { success: true, window: { ...SESSION_WINDOW, label: windowLabel(), open: insideWindow() } });
        return true;
      }

      const account = await loadAccount(accountId);
      if (!account) return fail(response, sendJson, 404, "Account not found");

      const run = await activeRun(account.id);
      const session = await openSession(account.id);
      // After a warning nothing is handed out, whatever the agent asks for:
      // no plan, no invitations to send or to check, no claims, no inbox.
      // Every list below is empty rather than missing, so an agent that reads
      // them without looking at `runnable` still finds nothing to do.
      const paused = pausedOn(run, today());
      // The folder's share, written down here and only here: the people the
      // poll counted become waiting invitations, and so does the place of a
      // person the agent could not reach earlier today. Idempotent: what is
      // held already comes off the room, so asking twice adds nothing the
      // second time. Before `invites` below, which is cut from what waits.
      if (run && !paused && account.status !== "excluded") await topUpQuietly(account, readCampaigns());
      // Warming ends; looking after what it sent does not. Computed here, where
      // the run is already in hand, so the "finished" answer below can say
      // "nothing to warm, but something to check" instead of a flat no.
      const upkeep = await upkeepWorkFor(account, run);

      // What is already claimed to this account, so a run does not need a
      // second call to find its work. Expired claims are left out: they belong
      // to the pool again, whether or not anything has deleted them yet.
      const claims = paused ? [] : await anty.from("wl_outreach").select(CLAIM_COLUMNS)
        .eq("account_id", account.id).eq("status", CLAIM_STATUS)
        .gte("created_at", claimCutoff())
        .order("created_at", { ascending: true }).rows();
      const owners = await claimOwners(runningFor(await loadCampaigns(), account.id), claims);

      const base = {
        success: true,
        account: {
          id: account.id,
          label: account.label,
          login: account.login,
          profileRemoteId: account.profile_remote_id,
          // `restricted` is what the warning wrote; once the pause is over the
          // account is warming again, whether or not a lease has written that
          // back yet, and an agent that gates on this must not see a stall.
          status: account.status === "restricted" && run && !paused ? "warming" : account.status,
          health: account.health
        },
        queue: claims.map((row) => describeClaim(row, owners.get(row.id) ?? null)),
        session: session ? { id: session.id, startedAt: session.started_at } : null,
        // Where the agent stops reading. Answered by the portal rather than
        // kept in a file beside the agent, because a Mac that gets replaced or
        // a portal that gets re-pointed would otherwise re-read a year of
        // history — slow, and a pattern somebody notices.
        //
        // `due` is whether to read it at all this session: once a day, every
        // day the account has a plan, and never while a pause holds. True
        // until `inbox.done` writes today's mark — the same rule the scheduler
        // wakes the account by, so a session opened for the read is told to do it.
        inbox: {
          lastSyncedAt: await lastSyncedAt(account.id),
          maxThreads: paused ? 0 : MAX_THREADS_PER_RUN,
          due: upkeep.inbox
        },
        // Replies written on the Inbox screen that this account is to send in
        // this session — the oldest few, never past the day's limit, and none at
        // all where the account would not be opened anyway. The agent still asks
        // `outbox.prepare` before typing each one, because a person may take a
        // reply back in the hours between this answer and its turn.
        outbox: !run || paused || account.status === "excluded" || account.health !== "ok"
          ? { toSend: [], waiting: 0, sentToday: 0, perDay: null }
          : await outboxPlan(account.id),
        // The invitation work, ready to act on. `toSend` is already cut to what
        // today's allowance permits, so the agent is not handed a request the
        // server would refuse a moment later; `toCheck` is bounded because a
        // check costs no quota and would otherwise grow into a crawl of every
        // person this account ever wrote to.
        invites: await inviteWorkFor(account, readCampaigns()),
        // What is owed that is not the day's quota. A run may be handed an
        // account with an empty plan and one of these set.
        upkeep,
        // The agent asks rather than carrying its own copy, so moving the
        // window on screen moves it for today's run too.
        window: { ...SESSION_WINDOW, label: windowLabel(), open: insideWindow() }
      };

      if (account.status === "excluded") {
        sendJson(response, 200, { ...base, runnable: false, reason: "Excluded from warm-up", plan: [] });
        return true;
      }
      if (!run) {
        sendJson(response, 200, { ...base, runnable: false, reason: "No warm-up in progress", plan: [] });
        return true;
      }
      if (paused) {
        sendJson(response, 200, {
          ...base, runnable: false, reason: `Paused until ${run.paused_until}`, plan: [], pausedUntil: run.paused_until
        });
        return true;
      }

      const snapshot = run.strategy_snapshot;
      const day = dayOfRun(run);
      const dayPlan = planForDay(snapshot, account.id, day);
      // Past the last phase is working mode and falls through to the plan
      // below like any other day. Only a snapshot with nothing to fall back on
      // is finished.
      if (dayPlan.finished) {
        // `runnable` answers "is it worth opening the browser", not "is there
        // warming left". An account past its last day still holds invitations
        // nobody has looked at and replies nobody has read, and a flat `false`
        // here is exactly the answer that sent the agent home and left them
        // unwatched for good.
        sendJson(response, 200, {
          ...base,
          runnable: upkeep.any,
          reason: upkeep.any ? "Warm-up is finished — upkeep only" : "Warm-up is finished",
          plan: [],
          day
        });
        return true;
      }

      const doneByKind = await doneToday(run);
      const weekly = await weeklyConnectAllowance(account.id);
      dayPlan.quotas.connect = connectCeiling(dayPlan.quotas.connect, doneByKind.get("connect") ?? 0, weekly.done);

      // On a day with more requests than one run carries, and people for
      // them, the first session leaves two views for the session that sends
      // the rest, so that one does not open on a Connect. The scheduler counts
      // the same way (`viewsHeldBack`), so an account is never woken for views
      // this plan would not hand out.
      const heldBack = await heldBackViews(account, run, readCampaigns(), {
        day, viewsDone: doneByKind.get("profile_view") ?? 0, doneByKind
      });
      const plan = ACTION_KINDS
        .map((kind) => {
          const quota = dayPlan.quotas[kind];
          const done = doneByKind.get(kind) ?? 0;
          const held = kind === "profile_view" ? heldBack : 0;
          return { kind, label: ACTION_LABEL[kind], quota, done, remaining: Math.max(0, quota - held - done), heldBack: held };
        })
        // A kind with no quota today is forbidden, not merely finished — the
        // agent never sees it, so it cannot decide to do "just one".
        .filter((row) => row.quota > 0);

      sendJson(response, 200, {
        ...base,
        runnable: true,
        runId: run.id,
        day,
        // "working" past the last phase: the same plan shape, at the
        // working-mode rate, with no end day.
        mode: dayPlan.working ? "working" : "warmup",
        phase: dayPlan.phase?.label ?? null,
        rules: dayPlan.rules,
        connectionNote: dayPlan.connectionNote,
        weeklyConnections: weekly,
        plan
      });
      return true;
    }

    if (method === "POST" && path === "/agent") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Account not found");
      const action = String(body.action || "");

      // Idempotent on purpose: an agent that crashed after opening and is run
      // again should continue the session it left, not stack a second one on an
      // account that only has room for one open at a time.
      if (action === "session.open") {
        const existing = await openSession(account.id);
        if (existing) {
          sendJson(response, 200, { success: true, sessionId: existing.id, startedAt: existing.started_at, resumed: true });
          return true;
        }

        const startedAt = new Date().toISOString();
        let created;
        try {
          created = await anty.from("wl_sessions").insert({
            account_id: account.id,
            profile_remote_id: account.profile_remote_id,
            started_at: startedAt,
            running_on: String(body.host || "").trim() || "agent",
            source: "agent"
          }).select("id").single();
        } catch {
          return fail(response, sendJson, 409, "Could not open a session — one may already be open");
        }

        await logEvent({
          accountId: account.id, type: "session.opened", message: "Agent opened the profile",
          meta: { source: "agent", startedAt, host: body.host ?? null }
        });
        sendJson(response, 200, { success: true, sessionId: created.id, startedAt, resumed: false });
        return true;
      }

      if (action === "session.close") {
        const existing = await openSession(account.id);
        if (!existing) { sendJson(response, 200, { success: true, closed: false }); return true; }

        const endedAt = new Date().toISOString();
        const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
        const ended = await anty.from("wl_sessions").update({ ended_at: endedAt, note })
          .eq("id", existing.id).isNull("ended_at").select("id").rows();
        if (!ended.length) { sendJson(response, 200, { success: true, closed: false }); return true; }

        const minutes = durationMin(existing.started_at, endedAt);
        const did = Object.entries(existing.actions || {})
          .map(([kind, count]) => `${ACTION_LABEL[kind] ?? kind}: ${count}`)
          .join(", ");
        await logEvent({
          accountId: account.id,
          level: body.failed ? "error" : "info",
          type: "session.closed",
          message: `Agent finished after ${minutes} min${did ? ` — ${did}` : " — nothing done"}`,
          meta: { sessionId: existing.id, durationMin: minutes, actions: existing.actions || {}, note }
        });
        sendJson(response, 200, { success: true, closed: true, durationMin: minutes });
        return true;
      }

      // The other half of /agent/due: the lease comes back, and with it the one
      // thing only the worker knows — whether the session actually happened.
      //
      // An unknown or expired lease is accepted rather than refused. A run that
      // overran its lease is still a run, and its failure is still worth a
      // cool-off; refusing the report would throw away the only account of it
      // anybody has.
      if (action === "run.finished") {
        const run = await activeRun(account.id);
        const outcome = await finishRun({
          account,
          run,
          leaseId: typeof body.leaseId === "string" ? body.leaseId : null,
          ok: body.ok !== false,
          note: typeof body.note === "string" ? body.note.slice(0, 300) : null
        });
        sendJson(response, 200, {
          success: true,
          nextInSeconds: outcome.nextInSeconds,
          released: outcome.released
        });
        return true;
      }

      // Checked here rather than trusted from the agent, so the strategy on
      // screen is the strategy that runs even when the agent is an older build.
      if (action === "record") {
        return await withAccountQuota(account.id, async () => {
        const run = await activeRun(account.id);
        if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

        const kind = String(body.kind || "");
        if (!ACTION_KINDS.includes(kind)) return fail(response, sendJson, 400, "Unknown action");
        const step = Number.isInteger(body.count) ? Math.max(1, Number(body.count)) : 1;
        const detail = typeof body.detail === "string" ? body.detail.slice(0, 200) : null;

        const outcome = await checkQuota(account, run, kind, step);
        if (!outcome.ok) return refusal(response, sendJson, outcome);
        // A view is never refused for the two kept back — they are the day's
        // own — but `remaining` says what the plan does: the session handed
        // quota − 2 is told it is done after its last one, not that two are
        // left. Decided on the views before this one, as `GET /agent` would
        // have answered just before it: decided on the views after it, the
        // session's last view released the two and answered "2 left".
        //
        // Read before the view is counted, not after: these are reads of the
        // queue and the folder, and one that failed after the commit answered
        // an error for a view already on the day's counter — counted twice by
        // an agent that retried it, and the session's views cut short by one
        // that stopped. Nothing the commit writes moves the answer: it is the
        // views before this one and the day's connects.
        const heldBack = kind === "profile_view"
          ? await heldBackViews(account, run, readCampaigns(), {
            day: outcome.day, viewsDone: outcome.done - outcome.step, doneByKind: await doneToday(run)
          })
          : 0;
        await commitAction(account, run, kind, outcome, detail);
        sendJson(response, 200, {
          success: true, done: outcome.done, quota: outcome.quota,
          remaining: Math.max(0, outcome.quota - heldBack - outcome.done), heldBack
        });
        return true;
        });
      }

      // Anything that is not a quota action but still belongs in the account's
      // history: which IP the proxy handed us, who we turned out to be signed in
      // as, and every failure. This is the half of the log that explains the other.
      if (action === "log") {
        const type = String(body.type || "agent.note");
        const message = String(body.message || "").slice(0, 500);
        if (!message) return fail(response, sendJson, 400, "An empty log line says nothing");
        const level = body.level === "warn" || body.level === "error" ? body.level : "info";
        const run = await activeRun(account.id);
        await logEvent({ accountId: account.id, runId: run?.id ?? null, level, type, message, meta: body.meta ?? undefined });
        sendJson(response, 200, { success: true });
        return true;
      }

      // The agent is the only thing that ever sees a checkpoint or a sign-out at
      // the moment it happens, so it is the only thing that can set this honestly.
      /**
       * The answer to a link somebody opened in the group. Health itself is
       * reported by the `health` action, like any other look at an account —
       * this only closes the request, so the page can stop refreshing and
       * show a verdict instead of a promise.
       */
      if (action === "login.recheck") {
        const nonce = String(body.nonce || "").trim();
        if (!nonce) return fail(response, sendJson, 400, "Which request?");
        const { requested, done } = await recheckState(nonce);
        if (!requested) return fail(response, sendJson, 404, "No such login check");
        if (requested.account_id !== account.id) return fail(response, sendJson, 409, "That login check belongs to another account");
        // Answered already: say so rather than writing a second verdict, so a
        // retried report reads the same as the first.
        if (done) {
          sendJson(response, 200, { success: true, already: true, signedIn: done.meta?.signedIn === true });
          return true;
        }
        const signedIn = body.signedIn === true;
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "";
        await logEvent({
          accountId: account.id,
          level: signedIn ? "info" : "warn",
          type: RECHECK_DONE,
          message: signedIn
            ? `Вхід підтверджено за посиланням із групи — ${account.label}`
            : `За посиланням із групи входу не видно (${reason || "без причини"}) — ${account.label}`,
          meta: { nonce, signedIn, reason }
        });
        sendJson(response, 200, { success: true, signedIn });
        return true;
      }

      if (action === "health") {
        if (!isHealth(body.health)) return fail(response, sendJson, 400, "Unknown health value");
        const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;
        const now = new Date().toISOString();
        await anty.from("wl_accounts").update({
          health: body.health, health_note: note, health_changed_at: now, updated_at: now
        }).eq("id", account.id).rows();
        await logEvent({
          accountId: account.id,
          level: body.health === "ok" ? "info" : "warn",
          type: "account.health",
          message: note ? `Agent: ${body.health} — ${note}` : `Agent: ${body.health}`,
          meta: { health: body.health, note }
        });
        sendJson(response, 200, { success: true });
        return true;
      }

      // LinkedIn said this account is being watched: a warning banner, a
      // restriction notice, a "you have been sending too many". The same
      // two-day pause the operator's button starts, from the only thing that
      // is looking at the screen when it appears.
      //
      // Deliberately not `health`. A captcha or a sign-out needs a person
      // before anything can run, and says nothing about how long to leave the
      // account alone; a warning needs nobody, and says exactly that. Health
      // keeps meaning what it meant.
      if (action === "warning") {
        const run = await activeRun(account.id);
        if (!run) return fail(response, sendJson, 409, "No warm-up in progress");
        const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;
        const pause = await pauseForWarning({ account, run, source: "agent", note });
        sendJson(response, 200, {
          success: true,
          paused: true,
          pausedUntil: pause.pausedUntil,
          // Everything, not only the sending: close the session and report
          // `run.finished`. Nothing is handed out again until the pause ends.
          stopSending: true
        });
        return true;
      }

      // ── the inbox, as the agent found it ──────────────────────────────
      //
      // Upserting, not appending: a message already stored for this account is
      // skipped rather than duplicated, and the suppression is a read before a
      // write because there is no unique index to lean on. See `inbox.mjs`.
      if (action === "inbox.thread") {
        const input = normalizeThreadInput(body);
        if (input.error) return fail(response, sendJson, 400, input.error);
        sendJson(response, 200, { success: true, ...await storeThread({ account, input, folderIds: runningFolderIds() }) });
        return true;
      }

      // The sync finished. Written even when it saw nothing, which is the point
      // of it: without this mark an empty inbox cannot tell "no new messages"
      // from "the agent never looked". It is also what `inbox.due` is read
      // from, so today's read is done once this is written.
      //
      // Then whatever an earlier sync could not copy to the CRM is copied now —
      // after the mark, so a CRM that is down cannot cost the account the one
      // row that says it was read today.
      if (action === "inbox.done") {
        const seen = Number(body.threadsSeen);
        const threadsSeen = Number.isFinite(seen) ? Math.max(0, Math.trunc(seen)) : 0;
        const syncedAt = await markSynced(account.id, threadsSeen);
        const crmRetried = await retryCrmCopies(account, { folderIds: runningFolderIds() });
        // Then the people this account talks to and the CRM has no record of:
        // the conversations stored before they were added on arrival.
        const crmAdded = await adoptWaitingThreads(account, { folderIds: runningFolderIds() });
        sendJson(response, 200, { success: true, threadsSeen, syncedAt, crmRetried, crmAdded });
        return true;
      }

      // ── replies written on the screen ─────────────────────────────────
      //
      // Asked right before each one is typed: has it been taken back since the
      // plan was cut, is the day's limit already used, did a warning arrive?
      // The text comes only with a yes — an agent that is told no has nothing
      // to type.
      if (action === "outbox.prepare") {
        const replyId = String(body.replyId || "");
        if (!replyId) return fail(response, sendJson, 400, "Яку відповідь?");
        const run = await activeRun(account.id);
        const stopAll = !run || pausedOn(run, today()) || account.health !== "ok" || account.status === "excluded";
        const prepared = stopAll
          ? { allowed: false, reply: null, reason: "stopped" }
          : await prepareReply(account.id, replyId, { todayIso: today() });
        sendJson(response, 200, {
          success: true, allowed: prepared.allowed, reason: prepared.reason, stopAll,
          reply: prepared.allowed ? { id: prepared.reply.id, threadKey: prepared.reply.threadKey, text: prepared.reply.body } : null
        });
        return true;
      }

      // After LinkedIn showed the message in the conversation, never before.
      if (action === "outbox.sent") {
        const replyId = String(body.replyId || "");
        if (!replyId) return fail(response, sendJson, 400, "Яку відповідь?");
        const marked = await markReplySent(account.id, replyId);
        if (!marked.ok) return fail(response, sendJson, marked.status, marked.error);
        sendJson(response, 200, { success: true, repeated: Boolean(marked.repeated) });
        return true;
      }

      // It did not go, or nobody can say whether it did. The reason is shown on
      // the conversation, so it is written for the person and not the log.
      if (action === "outbox.failed") {
        const replyId = String(body.replyId || "");
        if (!replyId) return fail(response, sendJson, 400, "Яку відповідь?");
        const marked = await markReplyFailed(account.id, replyId, body.reason);
        if (!marked.ok) return fail(response, sendJson, marked.status, marked.error);
        sendJson(response, 200, { success: true, repeated: Boolean(marked.repeated) });
        return true;
      }

      /**
       * One invitation, reported after LinkedIn confirmed it — never before.
       *
       * The allowance moves here and only here, which is why `already_pending`
       * spends nothing: it is the reconciliation for a previous run that
       * clicked and died before it could say so, and charging for it would
       * bill the account twice for one request. Reading the button state
       * before clicking is what makes that outcome reachable at all, and it is
       * the reconciliation itself rather than an optimisation.
       */
      if (action === "invite.prepare") {
        const outreachId = String(body.outreachId || "");
        if (!outreachId) return fail(response, sendJson, 400, "Which invitation?");
        const work = await inviteWorkFor(account, readCampaigns());
        const invite = work.toSend.find((row) => row.outreachId === outreachId);
        const run = await activeRun(account.id);
        const paused = pausedOn(run, today());
        sendJson(response, 200, {
          success: true, allowed: Boolean(invite), invite: invite ?? null,
          connectsLeft: work.connectsLeft, weekly: work.weekly,
          stopSending: !invite, duringPause: paused,
          stopAll: paused || account.health !== "ok" || account.status === "excluded" || !run
        });
        return true;
      }

      if (action === "invite.sent") {
        return await withAccountQuota(account.id, async () => {
        const outreachId = String(body.outreachId || "");
        if (!outreachId) return fail(response, sendJson, 400, "Which invitation?");
        // A vocabulary, checked the way `record` checks its kind. Unvalidated,
        // any unknown string — a capitalised "Sent", a "rate_limited" from a
        // newer agent build — fell through to "treat as already pending":
        // the row moved as though the request had gone out and the allowance
        // was never spent, so the account quietly sent one more than its day
        // allowed and nothing anywhere said so.
        const outcome = String(body.outcome || "");
        if (!INVITE_OUTCOMES.includes(outcome)) {
          return fail(response, sendJson, 400, `Unknown outcome. One of: ${INVITE_OUTCOMES.join(", ")}`);
        }

        // Nothing went out. The session a report came from is what tells its
        // retry from a new attempt: the agent's `leaseId` when it sends one,
        // else the lease this account holds here.
        if (INVITE_HELD_OUTCOMES.includes(outcome)) {
          const lease = activeLease();
          const leaseId = (typeof body.leaseId === "string" && body.leaseId)
            || (lease?.accountId === account.id ? lease.leaseId : null);
          const held = await oneHeldReportAtATime(outreachId, () => reportHeld({ account, outreachId, outcome, leaseId }));
          if (held.refused) return fail(response, sendJson, held.refused, held.error);
          sendJson(response, 200, { success: true, ...held });
          return true;
        }

        const outreach = await anty.from("wl_outreach").select(OUTREACH_COLUMNS).eq("id", outreachId).maybeSingle();
        if (!outreach) {
          // A seller cancelled between the agent being handed this row and the
          // browser clicking Connect. The person is back in the pool, but the
          // invitation is on their LinkedIn — so the orphan goes on the record
          // rather than vanishing with the row.
          await logEvent({
            accountId: account.id, level: "warn", type: "invite.failed",
            message: "Agent reported a request for an invitation that no longer exists — it was cancelled mid-send",
            meta: { outreachId, outcome: "row_gone", reported: outcome }
          });
          return fail(response, sendJson, 404, "That invitation is gone");
        }
        if (outreach.account_id !== account.id) return fail(response, sendJson, 409, "That invitation belongs to another account");

        const run = await activeRun(account.id);
        if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

        // `already_connected` skips `pending` entirely: they are in the
        // contacts, whatever we thought we were about to do.
        const target = outcome === "already_connected" ? ACCEPTED_STATUS : "pending";
        const spends = outcome === "sent";

        // The agent reports only after LinkedIn's own card has changed to
        // Pending, so by the time this runs the invitation exists. Refusing it
        // for want of allowance would not un-send it — it would throw away the
        // record of a request that is already on somebody's screen, and hand
        // the person back to the next campaign that asks. The same rule the
        // seller's "I sent it myself" already follows: quota governs what we
        // cause, not what we observe.
        let allowance = null;
        let overQuota = false;
        // A request that went out after a warning had paused the account —
        // an agent that carried on after the `blocked` answer, or a pause
        // pressed mid-run. It is on LinkedIn, so it is recorded; it is not
        // counted, because a paused account's day allows nothing; and it is
        // not called an overshoot, which is a different thing to go and fix.
        const duringPause = spends && pausedOn(run, today());
        if (spends) {
          allowance = await checkQuota(account, run, "connect");
          overQuota = !allowance.ok && !duringPause;
        }

        const moved = await moveStatus({ outreachId, to: target });
        if (!moved.moved) {
          sendJson(response, 200, { success: true, status: outreach.status, moved: false, reason: moved.reason });
          return true;
        }

        // What the request carried: the note the hand-off let through today,
        // decided by the same rule — the agent was told to send exactly that.
        // Only for `sent`; an `already_pending` went out on an earlier run.
        // The day is the one the account was on when it was handed out:
        // `runDay` holds still through a pause, whereas the count behind
        // `currentDay` drops by the paused dates the moment a warning lands,
        // and a day-12 note recorded under the day-10 rule read as "sent bare".
        const sentNote = spends
          ? noteUnderRule(moved.row.note, noteRuleOn(run.strategy_snapshot, runDay(run)))
          : null;

        const counts = spends && allowance.ok;
        if (counts) await commitAction(account, run, "connect", allowance, `invite to ${outreach.person_name || "a contact"}`);
        await recordSent({
          account, run, outreach: moved.row, by: "agent", overQuota, duringPause, allowance: counts ? allowance : null, sentNote
        });

        sendJson(response, 200, {
          success: true,
          status: moved.row.status,
          moved: true,
          // Kept true after a pause as well: an agent built before
          // `duringPause` stops on `overQuota`, and a paused account's day
          // allows nothing — so for that agent it is the true answer.
          overQuota: overQuota || duringPause,
          duringPause,
          // The agent stops sending for the day on this, rather than on a 409
          // it would have to interpret. What it already sent is recorded.
          stopSending: overQuota || duringPause,
          connectsLeft: counts ? Math.max(0, allowance.quota - allowance.done) : 0
        });
        return true;
        });
      }

      /** What the sent-invitations page said today. Written even when nothing changed. */
      if (action === "invites.checked") {
        const results = Array.isArray(body.results) ? body.results.slice(0, MAX_INVITE_CHECKS_PER_RUN) : [];
        const run = await activeRun(account.id);
        // Scoped inside `recordCheck`, the way `invite.sent` above refuses a
        // row it does not own. Unscoped, a stale or misattributed results
        // array moved another account's rows to a terminal status they can
        // never leave, filed the event under the wrong account, and dropped
        // the person out of every query that would have surfaced them again.
        sendJson(response, 200, { success: true, ...(await recordCheck({ account, run, results })) });
        return true;
      }

      return fail(response, sendJson, 400, "Unknown action");
    }

    return false;
  } catch (error) {
    if (error instanceof RestError) {
      return fail(response, sendJson, error.status >= 400 && error.status < 600 ? error.status : 502, error.message);
    }
    return fail(response, sendJson, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reconcile Anty with the sessions table.
 *
 * Anty knows whether a profile is open right now and nothing about history;
 * this app wants the history. Rather than a webhook Anty does not have, the
 * screen polls this: a profile running with no open session starts one, an open
 * session on a profile that is not running ends. Run it twice and the second
 * pass finds nothing to do — that, not a lock, is what keeps two tabs polling
 * from double-counting.
 */
async function syncSessions() {
  const linked = await anty.from("wl_accounts")
    .select("id,profile_remote_id,wl_sessions(ended_at)")
    .notNull("profile_remote_id")
    .order("ended_at", { ascending: false, nullsFirst: false, foreignTable: "wl_sessions" })
    .limit(1, { foreignTable: "wl_sessions" })
    .rows();

  const profileIds = linked.map((account) => account.profile_remote_id);
  const profiles = profileIds.length
    ? await anty.from("anty_browser_profiles").select("id,status,running_on,last_launched_at,is_deleted").in("id", profileIds).rows()
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  // Open sessions for every account, not only the linked ones: an account whose
  // profile was unlinked mid-session has nothing left to keep it open.
  const openRows = await anty.from("wl_sessions").select("id,account_id,started_at,source").isNull("ended_at").rows();
  const openByAccount = new Map(openRows.map((session) => [session.account_id, session]));

  const running = new Map();
  for (const account of linked) {
    const profile = profileById.get(account.profile_remote_id);
    // A deleted profile can still carry the status it had when it went; it is
    // not running anywhere a session could describe.
    if (!profile || profile.status !== "running" || profile.is_deleted) continue;
    running.set(account.id, { profile, lastEndedAt: account.wl_sessions?.[0]?.ended_at ?? null });
  }

  const now = new Date().toISOString();
  let opened = 0;
  let closed = 0;

  for (const [accountId, { profile, lastEndedAt }] of running) {
    if (openByAccount.has(accountId)) continue;

    // Anty's launch stamp, so a session opened by the first poll after launch is
    // not a minute short. A stamp older than this account's last close belongs
    // to an earlier session, though, and now is the honest answer then.
    const launched = antyTimestampToIso(profile.last_launched_at);
    const stale = launched && lastEndedAt && Date.parse(launched) <= Date.parse(lastEndedAt);
    const startedAt = launched && !stale ? launched : now;
    const runningOn = profile.running_on?.trim() || null;

    try {
      await anty.from("wl_sessions").insert({
        account_id: accountId,
        profile_remote_id: profile.id,
        started_at: startedAt,
        running_on: runningOn,
        source: "anty"
      }).rows();
    } catch (error) {
      // 23505 is the one-open-session index: another poll got here first, which
      // is the outcome we wanted, not an error.
      if (!(error instanceof RestError) || error.code !== "23505") {
        console.error("[warmup] could not open a session:", error.message);
      }
      continue;
    }
    opened += 1;
    await logEvent({
      accountId,
      type: "session.opened",
      message: runningOn ? `Profile opened on ${runningOn}` : "Profile opened",
      meta: { profileId: profile.id, runningOn, startedAt }
    });
  }

  for (const [accountId, session] of openByAccount) {
    if (running.has(accountId)) continue;
    // An agent session ends when the agent says so, not when Anty fails to see a
    // profile it never launched. Only a stuck one is closed here.
    const stuckAgent = Date.now() - Date.parse(session.started_at) > AGENT_SESSION_MAX_MS;
    if (session.source !== "anty" && !stuckAgent) continue;

    // Guarded on ended_at so a concurrent poll closes it once, and only the poll
    // that did gets to count it and write the event.
    const ended = await anty.from("wl_sessions").update({ ended_at: now })
      .eq("id", session.id).isNull("ended_at").select("id").rows();
    if (!ended.length) continue;

    closed += 1;
    const minutes = durationMin(session.started_at, now);
    const abandoned = session.source !== "anty";
    await logEvent({
      accountId,
      level: abandoned ? "warn" : "info",
      type: "session.closed",
      message: abandoned
        ? `Agent session closed after ${minutes} min without the agent reporting back`
        : `Profile closed after ${minutes} min`,
      meta: { sessionId: session.id, durationMin: minutes, source: session.source }
    });
  }

  return { success: true, opened, closed };
}
