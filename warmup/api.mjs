import { anty, crm, CONTACT_ID_BATCH, antyTeamId, crmError, leadById, leadQueue, queueTotal, today } from "./db.mjs";
import { RestError } from "./rest.mjs";
import { ACTION_KINDS, ACTION_LABEL, currentDay, planForDay, totalDays, validateStrategy } from "./strategy.mjs";
import { SESSION_WINDOW, insideWindow, nextSession, windowLabel } from "./schedule.mjs";
import { HEALTH_LABEL, HEALTH_VALUES, deriveStatus, isHealth } from "./status.mjs";
import { PLATFORMS, parseProxy, platformOf, proxyString, retag } from "./platform.mjs";
import { CLAIM_STATUS, OUTREACH_COLUMNS, OUTREACH_STATUSES, describeClaim, describeOutreach, personSnapshot, sentBy } from "./outreach.mjs";
import {
  ACCEPTED_STATUS, MAX_INVITES_PER_RUN, MAX_INVITE_CHECKS_PER_RUN, WAITING_STATUS, cancelInvite,
  describeInvite, inviteEvents, invitesToCheck, invitesToSend, lastCheckedAt as invitesLastCheckedAt,
  checkedTodayAccounts, moveStatus, openConversationCounts, outreachForContact, pendingCounts,
  reassignInvite, recordCheck, recordFailed, recordSent, requestInvite
} from "./invites.mjs";
import { antyTimestampToIso, describeSession, durationMin } from "./sessions.mjs";
import { encryptSecret, secretsConfigured } from "./secretbox.mjs";
import {
  activeRun, checkQuota, commitAction, connectQuotaToday, describeAccount, ensureDefaultStrategy,
  logEvent, loadAccount, loginIdentities, newestRun, openSession, probeEventWriteAccess, recordAction,
  toStrategy
} from "./store.mjs";
import {
  describeTargeting, folderNameOf, forecastFor, listFolders, normalizeFilters
} from "./targeting.mjs";
import {
  AUDIT_HIDDEN_TYPES, MAX_THREADS_PER_RUN, lastSyncedAt, listThreads, markRead, markSynced, normalizeThreadInput,
  outreachFor, readThread, storeThread, syncSummary, syncedTodayAccounts, threadKeyOf, unreadCount
} from "./inbox.mjs";
import { decideNext, finishRun, leaseAccount } from "./scheduler.mjs";
import {
  allowanceReason, claimCapacity, claimCutoff, defaultFilters, describeCampaign, isCampaignState,
  migrateCampaigns, moveTo, nextOrder, normalizeCampaign, progressApproximate, progressFrom, renumber,
  runningFor, targetingOf
} from "./campaigns.mjs";

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
  const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
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
  if (run.paused_until && run.paused_until >= today()) return { blocked: `Paused until ${run.paused_until}` };

  const allowance = await checkQuota(account, run, "connect", 1);
  return {
    run,
    day: currentDay(new Date(run.started_at), run.paused_days ?? 0),
    totalDays: totalDays(run.strategy_snapshot),
    // A refusal for a day with no requests planned carries no quota, because
    // there is none: zero is the whole answer, not a missing one.
    quota: allowance.quota ?? 0,
    spent: allowance.ok ? allowance.done - allowance.step : allowance.done ?? 0,
    startsDay: connectStartsDay(run)
  };
}

/**
 * What this account owes that is not the day's quota.
 *
 * The same rule the scheduler decides by, asked per account: invitations are
 * checked on any day once a day, and the inbox becomes a reason of its own only
 * past the last day of the plan — inside it, tomorrow's quota opens the browser
 * anyway and the inbox is read while it is there.
 */
async function upkeepWorkFor(account, run) {
  if (!run) return { checks: 0, inbox: false, any: false };
  const todayIso = today();
  const [pending, conversations, checked, synced] = await Promise.all([
    pendingCounts([account.id]),
    openConversationCounts([account.id]),
    checkedTodayAccounts([account.id], todayIso),
    syncedTodayAccounts([account.id], todayIso)
  ]);
  const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
  const inPlan = day <= totalDays(run.strategy_snapshot);
  const checks = checked.has(account.id) ? 0 : Math.min(pending.get(account.id) ?? 0, MAX_INVITE_CHECKS_PER_RUN);
  // Somebody who could still write, and nobody has looked today.
  const inbox = !inPlan && (conversations.get(account.id) ?? 0) > 0 && !synced.has(account.id);
  return { checks, inbox, any: checks > 0 || inbox };
}

/**
 * The invitation work this account may actually do right now.
 *
 * `toSend` is cut to today's remaining allowance before it leaves the portal.
 * The refusal on `invite.sent` is a real answer and stays, but it should be the
 * rare case rather than the way the agent finds out.
 */
async function inviteWorkFor(account) {
  const allowance = await connectAllowance(account);
  const left = allowance.blocked ? 0 : Math.max(0, (allowance.quota || 0) - (allowance.spent || 0));
  return {
    toSend: await invitesToSend(account.id, Math.min(left, MAX_INVITES_PER_RUN)),
    toCheck: await invitesToCheck(account.id, MAX_INVITE_CHECKS_PER_RUN),
    lastCheckedAt: await invitesLastCheckedAt(account.id),
    connectsLeft: left
  };
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
    crmContactId: found.crmContactId,
    outreachStatus: found.outreachStatus,
    lastSyncedAt: thread.lastSyncedAt
  };
}

export async function handleWarmupApi({ request, response, url, sendJson, readJson, campaigns: campaignStore }) {
  const path = url.pathname.replace(/^\/api\/warmup/, "") || "/";
  const method = request.method;

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

      const totals = { total: accounts.length, warming: 0, paused: 0, completed: 0, idle: 0 };
      let plannedToday = 0;
      let doneToday = 0;
      const attention = [];

      for (const account of accounts) {
        const warmup = account.warmup;
        if (!warmup) { totals.idle += 1; continue; }
        if (warmup.state === "paused") {
          totals.paused += 1;
          attention.push({ id: account.id, label: account.label, reason: `Paused after a warning until ${warmup.pausedUntil}` });
          continue;
        }
        if (warmup.finished) {
          totals.completed += 1;
          attention.push({ id: account.id, label: account.label, reason: "Warm-up finished — ready for working mode" });
          continue;
        }
        totals.warming += 1;
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

      const byProfile = new Map(linked.map((account) => [account.profile_remote_id, account]));

      const describe = (row) => {
        const account = byProfile.get(row.id) || null;
        const run = account ? runByAccount.get(account.id) || null : null;
        const last = account?.wl_sessions?.[0] || null;
        const status = deriveStatus(account, run, todayIso);
        // The day the account is on, so the list's Day column has something to
        // put there. Read from the run's own snapshot, which is what the detail
        // panel reads too — two ways of counting the day is two answers.
        const day = run && run.state !== "stopped"
          ? { day: currentDay(new Date(run.started_at), run.paused_days ?? 0), totalDays: totalDays(run.strategy_snapshot) }
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
          day: day && day.day <= day.totalDays ? `${day.day}/${day.totalDays}` : null,
          health: account?.health ?? "ok",
          healthNote: account?.health_note ?? null,
          status,
          isRunningNow: row.status === "running",
          connections: {
            ...(connectionsByAccount.get(account?.id ?? "") || { today: 0, total: 0 }),
            quota: connectQuotaToday(account, run, todayIso),
            startsDay: connectStartsDay(run)
          },
          outreachTotal: outreachByAccount.get(account?.id ?? "") ?? 0,
          lastSession: last
            ? { startedAt: last.started_at, endedAt: last.ended_at, durationMin: durationMin(last.started_at, last.ended_at) }
            : null,
          // Only an account that is warming and not already open has a next
          // session: promising "next at 14:20" for one that is off or blocked
          // would be a commitment nobody is going to keep.
          nextSession: account && status === "warming" && row.status !== "running"
            ? nextSession(account.id, {
                // No day row yet means today has not been started at all, which
                // is the most outstanding a day can be.
                outstanding: outstandingByAccount.get(account.id) ?? !hasDayRow.has(account.id)
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
          // part-way through was working to.
          strategy_snapshot: { name: strategy.name, phases: strategy.phases, pauseDays: strategy.pauseDays }
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

      if (action === "warning") {
        const pauseDays = run.strategy_snapshot?.pauseDays ?? 2;
        const until = new Date();
        until.setUTCDate(until.getUTCDate() + pauseDays);

        await anty.from("wl_runs").update({
          paused_until: until.toISOString().slice(0, 10),
          // Added to paused_days so the schedule does not advance through the pause.
          paused_days: (run.paused_days ?? 0) + pauseDays,
          state: "paused"
        }).eq("id", run.id).rows();
        await setAccountStatus(account.id, "restricted");

        await logEvent({
          accountId: account.id, runId: run.id, level: "warn", type: "run.warning",
          message: `LinkedIn warning — all actions stopped for ${pauseDays} days`,
          meta: { until: until.toISOString().slice(0, 10), note: body.note ?? null }
        });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "resume") {
        await anty.from("wl_runs").update({ paused_until: null, state: "running" }).eq("id", run.id).rows();
        await setAccountStatus(account.id, "warming");
        await logEvent({ accountId: account.id, runId: run.id, type: "run.resumed", message: "Warm-up resumed" });
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
    if (method === "GET" && path === "/strategies") {
      await ensureDefaultStrategy();
      const rows = await anty.from("wl_strategies").select("*").eq("is_archived", false)
        .order("is_default", { ascending: false }).order("created_at").rows();
      sendJson(response, 200, { success: true, strategies: rows.map(toStrategy) });
      return true;
    }

    if (method === "POST" && path === "/strategies") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
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
      patch.responded_at = status === "pending" ? null : existing.responded_at ?? new Date().toISOString();

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
        state: "draft",
        order: nextOrder(campaigns)
      });

      const next = [...campaigns, created];
      await saveCampaigns(next);
      await logEvent({
        type: "campaign.created",
        message: `Campaign "${created.name}" on "${checked.folderName}"${accountIds.length ? ` worked by ${accountIds.length} account${accountIds.length > 1 ? "s" : ""}` : " with no account chosen"}`,
        meta: { campaignId: created.id, folderId, accountIds, productId }
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

      const queued = await anty.from("wl_outreach").select(CLAIM_COLUMNS)
        .eq("account_id", account.id).eq("status", CLAIM_STATUS)
        .order("created_at", { ascending: true }).rows();

      const remainingQuota = Math.max(0, allowance.quota - allowance.spent);
      const capacity = claimCapacity({ ...allowance, queued: queued.length, limit });
      const empty = (reason) => {
        sendJson(response, 200, { success: true, claimed: [], remainingQuota, reason, released });
        return true;
      };

      if (capacity === 0) return empty(allowanceReason({ ...allowance, queued: queued.length }));

      const campaigns = await loadCampaigns();
      const working = runningFor(campaigns, account.id);
      if (!working.length) return empty("No running campaign works this account");

      const claimed = [];
      let taken = 0;
      for (const campaign of working) {
        if (claimed.length >= capacity) break;
        let candidates;
        try {
          candidates = await nextCandidates(capacity - claimed.length, targetingOf(campaign));
        } catch (error) {
          return fail(response, sendJson, 502, crmError(error));
        }

        for (const lead of candidates) {
          if (claimed.length >= capacity) break;
          try {
            const row = await anty.from("wl_outreach").insert({
              account_id: account.id,
              ...personSnapshot(lead),
              sent_by: sentBy(account),
              status: CLAIM_STATUS
            }).select(CLAIM_COLUMNS).single();
            claimed.push(describeClaim(row, campaign));
          } catch (error) {
            // wl_outreach_person_once: somebody else claimed this person a
            // moment ago. That is the index doing its job, not a failed batch.
            if (error instanceof RestError && error.code === "23505") {
              taken += 1;
              continue;
            }
            throw error;
          }
        }
      }

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

      const campaigns = runningFor(await loadCampaigns(), account.id);
      const byFolder = await claimOwners(campaigns, rows);

      let reason = null;
      if (!rows.length) {
        const allowance = await connectAllowance(account);
        reason = allowance.blocked
          ?? allowanceReason({ ...allowance, queued: 0 })
          ?? (campaigns.length ? "Nothing is claimed to this account right now" : "No running campaign works this account");
      }

      sendJson(response, 200, {
        success: true,
        accountId: account.id,
        queue: rows.map((row) => describeClaim(row, byFolder.get(row.id) ?? null)),
        reason
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

    if (method === "GET" && path === "/invites") {
      const crmContactId = url.searchParams.get("crmContactId");
      if (!crmContactId) return fail(response, sendJson, 400, "Який контакт?");
      const row = await outreachForContact(crmContactId);
      const events = row ? await inviteEvents(crmContactId) : [];
      sendJson(response, 200, { success: true, invite: describeInvite(row, events), events });
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
            existing: describeInvite(existing, existing ? await inviteEvents(lead.id) : [])
          });
          return true;
        }
        throw error;
      }

      const allowance = await connectAllowance(account);
      sendJson(response, 200, {
        success: true,
        invite: describeInvite(row, await inviteEvents(lead.id)),
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
      sendJson(response, 200, { success: true, released: gone.crm_contact_id });
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
      sendJson(response, 200, { success: true, invite: describeInvite(moved, await inviteEvents(moved.crm_contact_id)) });
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
        invite: describeInvite(outreach, await inviteEvents(lead.id)),
        overQuota
      });
      return true;
    }

    if (method === "POST" && path === "/leads/take") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Некоректне тіло JSON");
      if (!body.crmContactId) return fail(response, sendJson, 400, "Який контакт?");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Акаунт не знайдено");

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

      await logEvent({
        accountId: account.id, runId: run.id, type: "outreach.sent",
        message: `Connection request to ${lead.name ?? "a contact"}${lead.company ? ` (${lead.company})` : ""}`,
        meta: {
          outreachId: outreach.id, crmContactId: lead.id, claimed: Boolean(claim),
          day: allowance.day, done: allowance.done, quota: allowance.quota
        }
      });

      sendJson(response, 200, {
        success: true,
        outreach: describeOutreach(outreach),
        account: await describeAccount(await loadAccount(account.id))
      });
      return true;
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
      const threads = await listThreads({ accountId, unreadOnly: url.searchParams.get("unread") === "1" });

      const accounts = await anty.from("wl_accounts").select("id,label").rows();
      const [identities, outreach] = await Promise.all([loginIdentities(), outreachFor(threads)]);
      const labels = new Map(accounts.map((account) => [account.id, account.label]));

      sendJson(response, 200, {
        success: true,
        unread: threads.filter((thread) => thread.unread).length,
        // Top level as well as per thread: the one case this value decides —
        // an empty inbox — is the case with no thread to carry it, and
        // "nothing arrived" and "the agent never ran" need different people to
        // do different things.
        sync: await syncSummary(accounts.map((account) => account.id)),
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

      sendJson(response, 200, {
        success: true,
        thread: describeThread(found.thread, {
          labels: new Map(account ? [[account.id, account.label]] : []),
          identities,
          outreach
        }),
        messages: found.messages
      });
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
    if (method === "GET" && path === "/agent/accounts") {
      const rows = await anty.from("wl_accounts").select("id,label,login,profile_remote_id,status,health").rows();
      sendJson(response, 200, {
        success: true,
        accounts: rows.map((row) => ({
          id: row.id,
          label: row.label,
          login: row.login,
          profileRemoteId: row.profile_remote_id,
          status: row.status,
          health: row.health
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
      sendJson(response, 200, await decideNext());
      return true;
    }

    // Taking it. Separate from the question on purpose — see `leaseAccount` —
    // and the only place a lease is ever granted.
    if (method === "POST" && path === "/agent/lease") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");
      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Account not found");

      const outcome = await leaseAccount({ accountId: account.id });
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
      // Warming ends; looking after what it sent does not. Computed here, where
      // the run is already in hand, so the "finished" answer below can say
      // "nothing to warm, but something to check" instead of a flat no.
      const upkeep = await upkeepWorkFor(account, run);

      // What is already claimed to this account, so a run does not need a
      // second call to find its work. Expired claims are left out: they belong
      // to the pool again, whether or not anything has deleted them yet.
      const claims = await anty.from("wl_outreach").select(CLAIM_COLUMNS)
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
          status: account.status,
          health: account.health
        },
        queue: claims.map((row) => describeClaim(row, owners.get(row.id) ?? null)),
        session: session ? { id: session.id, startedAt: session.started_at } : null,
        // Where the agent stops reading. Answered by the portal rather than
        // kept in a file beside the agent, because a Mac that gets replaced or
        // a portal that gets re-pointed would otherwise re-read a year of
        // history — slow, and a pattern somebody notices.
        inbox: { lastSyncedAt: await lastSyncedAt(account.id), maxThreads: MAX_THREADS_PER_RUN },
        // The invitation work, ready to act on. `toSend` is already cut to what
        // today's allowance permits, so the agent is not handed a request the
        // server would refuse a moment later; `toCheck` is bounded because a
        // check costs no quota and would otherwise grow into a crawl of every
        // person this account ever wrote to.
        invites: await inviteWorkFor(account),
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
      if (run.paused_until && run.paused_until >= today()) {
        sendJson(response, 200, { ...base, runnable: false, reason: `Paused until ${run.paused_until}`, plan: [] });
        return true;
      }

      const snapshot = run.strategy_snapshot;
      const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
      if (day > totalDays(snapshot)) {
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

      const dayPlan = planForDay(snapshot, account.id, day);
      const doneRows = await anty.from("wl_day_actions").select("kind,done").eq("run_id", run.id).eq("on_date", today()).rows();
      const doneByKind = new Map(doneRows.map((row) => [row.kind, Number(row.done) || 0]));

      const plan = ACTION_KINDS
        .map((kind) => {
          const quota = dayPlan.quotas[kind];
          const done = doneByKind.get(kind) ?? 0;
          return { kind, label: ACTION_LABEL[kind], quota, done, remaining: Math.max(0, quota - done) };
        })
        // A kind with no quota today is forbidden, not merely finished — the
        // agent never sees it, so it cannot decide to do "just one".
        .filter((row) => row.quota > 0);

      sendJson(response, 200, {
        ...base,
        runnable: true,
        runId: run.id,
        day,
        phase: dayPlan.phase?.label ?? null,
        rules: dayPlan.rules,
        connectionNote: dayPlan.connectionNote,
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
        const run = await activeRun(account.id);
        if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

        const kind = String(body.kind || "");
        if (!ACTION_KINDS.includes(kind)) return fail(response, sendJson, 400, "Unknown action");
        const step = Number.isInteger(body.count) ? Math.max(1, Number(body.count)) : 1;
        const detail = typeof body.detail === "string" ? body.detail.slice(0, 200) : null;

        const outcome = await checkQuota(account, run, kind, step);
        if (!outcome.ok) return refusal(response, sendJson, outcome);
        await commitAction(account, run, kind, outcome, detail);
        sendJson(response, 200, { success: true, done: outcome.done, quota: outcome.quota, remaining: outcome.quota - outcome.done });
        return true;
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

      // ── the inbox, as the agent found it ──────────────────────────────
      //
      // Upserting, not appending: a message already stored for this account is
      // skipped rather than duplicated, and the suppression is a read before a
      // write because there is no unique index to lean on. See `inbox.mjs`.
      if (action === "inbox.thread") {
        const input = normalizeThreadInput(body);
        if (input.error) return fail(response, sendJson, 400, input.error);
        sendJson(response, 200, { success: true, ...await storeThread({ account, input }) });
        return true;
      }

      // The sync finished. Written even when it saw nothing, which is the point
      // of it: without this mark an empty inbox cannot tell "no new messages"
      // from "the agent never looked".
      if (action === "inbox.done") {
        const seen = Number(body.threadsSeen);
        const threadsSeen = Number.isFinite(seen) ? Math.max(0, Math.trunc(seen)) : 0;
        sendJson(response, 200, { success: true, threadsSeen, syncedAt: await markSynced(account.id, threadsSeen) });
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
      if (action === "invite.sent") {
        const outreachId = String(body.outreachId || "");
        if (!outreachId) return fail(response, sendJson, 400, "Which invitation?");
        const outcome = String(body.outcome || "sent");

        const outreach = await anty.from("wl_outreach").select(OUTREACH_COLUMNS).eq("id", outreachId).maybeSingle();
        if (!outreach) return fail(response, sendJson, 404, "That invitation is gone");
        if (outreach.account_id !== account.id) return fail(response, sendJson, 409, "That invitation belongs to another account");

        if (["no_button", "profile_gone", "blocked"].includes(outcome)) {
          // The row stays waiting: the person is still held, the reason is on
          // the record, and a human decides whether to cancel or move it.
          await recordFailed({ account, outreach, outcome });
          sendJson(response, 200, { success: true, status: outreach.status, moved: false, recorded: outcome });
          return true;
        }

        const run = await activeRun(account.id);
        if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

        // `already_connected` skips `pending` entirely: they are in the
        // contacts, whatever we thought we were about to do.
        const target = outcome === "already_connected" ? ACCEPTED_STATUS : "pending";
        const spends = outcome === "sent";

        let allowance = null;
        if (spends) {
          allowance = await checkQuota(account, run, "connect");
          // A refusal is an ordinary answer: the agent stops sending for today
          // and the rest of the queue keeps waiting for tomorrow.
          if (!allowance.ok) return refusal(response, sendJson, allowance);
        }

        const moved = await moveStatus({ outreachId, to: target });
        if (!moved.moved) {
          sendJson(response, 200, { success: true, status: outreach.status, moved: false, reason: moved.reason });
          return true;
        }

        if (spends) await commitAction(account, run, "connect", allowance, `invite to ${outreach.person_name || "a contact"}`);
        await recordSent({ account, run, outreach: moved.row, by: "agent", allowance });

        sendJson(response, 200, {
          success: true,
          status: moved.row.status,
          moved: true,
          connectsLeft: spends ? Math.max(0, allowance.quota - allowance.done) : null
        });
        return true;
      }

      /** What the sent-invitations page said today. Written even when nothing changed. */
      if (action === "invites.checked") {
        const results = Array.isArray(body.results) ? body.results.slice(0, MAX_INVITE_CHECKS_PER_RUN) : [];
        const run = await activeRun(account.id);
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
 * How much of the queue to read per round trip, as a multiple of what is asked
 * for. People already approached are filtered out after the CRM has answered,
 * so a page the size of `limit` would come back short as soon as anyone had
 * been taken. MAX_PAGES is the hard stop: the exclusion list only grows, and a
 * queue whose head is entirely spoken for would otherwise walk thousands of
 * rows a page at a time while somebody waits for a panel to paint.
 */
const OVERFETCH = 4;
const MAX_PAGES = 5;

/**
 * The next people to approach. The account asking does not narrow it:
 * wl_outreach_person_once means one person is approached once across every
 * account, so the candidate list is the same whoever is asking.
 */
async function nextCandidates(limit, targeting) {
  const pageSize = Math.max(limit * OVERFETCH, 40);
  const candidates = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES && candidates.length < limit; page += 1) {
    const batch = await leadQueue({ limit: pageSize + offset, offset, targeting });
    if (batch.length === 0) break;
    offset += batch.length;

    // Asked per page rather than "every contact ever approached": the list only
    // has to be long enough to answer this page.
    const taken = await anty.from("wl_outreach").select("crm_contact_id")
      .in("crm_contact_id", batch.map((lead) => lead.id)).rows();
    const approached = new Set(taken.map((row) => row.crm_contact_id));

    for (const lead of batch) {
      if (candidates.length >= limit) break;
      if (!approached.has(lead.id)) candidates.push(lead);
    }

    // A short page is the end of the queue, not a reason to ask again.
    if (batch.length < pageSize) break;
  }

  return candidates;
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
