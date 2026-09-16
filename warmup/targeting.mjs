import { anty, crm, CONTACT_ID_BATCH, queueQuery, queueTotal, today } from "./db.mjs";
import { DEFAULT_STRATEGY, dailyQuota, totalDays } from "./strategy.mjs";
import { connectQuotaToday } from "./store.mjs";

/**
 * Which folder the warm-up works, narrowed by which filters, worked by which
 * accounts — and what that actually comes to per day.
 *
 * Targeting is a choice somebody makes, not something that happened, so it is
 * kept in the workspace state this app already persists rather than in the Anty
 * database, which takes no migrations. The caller hands in a store; nothing
 * here knows where the file is.
 *
 * The forecast is not decoration. At peak the standard strategy allows five or
 * six connection requests per account per day, so four accounts are a ceiling
 * near twenty-two — and the largest folder in the CRM holds twenty-two thousand
 * people, which is a thousand days of work. A folder picker that does not say
 * so is a picker that reads as though a folder is a thing you can run.
 */

/** Contacts arrive as "new" and the queue has always meant that; keep it so. */
export const DEFAULT_LEAD_STATUS = "new";

const FILTER_KEYS = ["country", "position", "leadStatus", "ownerId"];

function cleanFilter(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export function normalizeFilters(input = {}) {
  const filters = {};
  for (const key of FILTER_KEYS) filters[key] = cleanFilter(input?.[key]);
  return filters;
}

function normalizeAccountIds(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((id) => cleanFilter(id)).filter(Boolean))];
}

/**
 * The saved selection with the environment's old pinned folder and owner
 * standing in for what nobody has chosen yet. That is the whole migration path
 * off `WARMUP_CRM_LEADS_FOLDER_ID`: an existing deployment opens on the folder
 * it was already running, and the first save moves it into the workspace state
 * for good.
 */
export function normalizeTargeting(saved) {
  const defaults = crm.configured() ? crm.config() : { folderId: "", ownerId: "" };
  const filters = normalizeFilters(saved?.filters);
  const hasSaved = saved && typeof saved === "object";

  return {
    folderId: cleanFilter(saved?.folderId) || (hasSaved ? "" : defaults.folderId) || "",
    folderName: cleanFilter(saved?.folderName),
    filters: {
      ...filters,
      leadStatus: hasSaved ? filters.leadStatus : DEFAULT_LEAD_STATUS,
      ownerId: hasSaved ? filters.ownerId : defaults.ownerId || ""
    },
    accountIds: normalizeAccountIds(saved?.accountIds),
    updatedAt: typeof saved?.updatedAt === "string" ? saved.updatedAt : null
  };
}

/** The response shape: a folder nobody has picked is null, not an empty string. */
export function describeTargeting(targeting, folderName = null) {
  return {
    folderId: targeting.folderId || null,
    folderName: folderName || targeting.folderName || null,
    filters: { ...targeting.filters },
    accountIds: [...targeting.accountIds],
    updatedAt: targeting.updatedAt
  };
}

// ── the CRM's folders ─────────────────────────────────────────────────────

/**
 * Folders with their counts, biggest first, joined in memory because the two
 * tables are read separately. A folder with no stats row counts zero rather
 * than disappearing: an empty folder somebody just made is still a folder they
 * should be able to pick.
 */
export async function listFolders({ includeArchived = false } = {}) {
  const [folders, stats] = await Promise.all([
    crm.from("contact_folders").select("id,name,color,owner_id,is_archived").rows(),
    crm.from("folder_stats").select("folder_id,contact_count").rows()
  ]);

  const countByFolder = new Map(stats.map((row) => [row.folder_id, row.contact_count ?? 0]));

  return folders
    .filter((folder) => includeArchived || !folder.is_archived)
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      color: folder.color,
      contactCount: countByFolder.get(folder.id) ?? 0,
      isArchived: Boolean(folder.is_archived)
    }))
    .sort((left, right) => right.contactCount - left.contactCount || left.name.localeCompare(right.name));
}

/**
 * The folder's current name, asked of the CRM rather than trusted from the
 * save: folders get renamed, and a panel still announcing last month's name is
 * a panel nobody believes. The saved copy is what answers when the CRM does not.
 */
export async function folderNameOf(folderId) {
  if (!folderId) return null;
  const folder = await crm.from("contact_folders").select("name").eq("id", folderId).maybeSingle();
  return folder?.name ?? null;
}

// ── what it comes to ──────────────────────────────────────────────────────

/**
 * The most connection requests this account will ever be allowed in a day.
 *
 * Drawn day by day through the same helper the live quota uses, so the peak is
 * a figure this account actually reaches rather than the top corner of a range
 * it may never be dealt.
 */
export function peakConnect(strategy, accountId) {
  let peak = 0;
  for (let day = 1; day <= totalDays(strategy); day += 1) {
    peak = Math.max(peak, dailyQuota(strategy, accountId, day, "connect"));
  }
  return peak;
}

/**
 * The arithmetic, kept away from every database so it can be argued with.
 *
 * `perDayNow` is what the chosen accounts are allowed today; `perDayAtPeak` is
 * what they will be allowed once all of them are warm. The gap between the two
 * is the honest answer to "when does this start moving", and a month is
 * capped at what is left because finishing early is not a faster month.
 */
export function buildForecast({ matching, alreadyApproached, perDayNow, perDayAtPeak, accountsChosen }) {
  const remaining = Math.max(0, matching - alreadyApproached);
  return {
    matching,
    alreadyApproached,
    remaining,
    perDayNow,
    perDayAtPeak,
    daysToFinish: perDayAtPeak > 0 ? Math.ceil(remaining / perDayAtPeak) : null,
    reachedThisMonth: Math.min(remaining, perDayAtPeak * 30),
    accountsChosen
  };
}

/**
 * How many of the targeted people have already been approached.
 *
 * The two facts live in different databases, so there is no join to make: the
 * outreach ids come from one and are counted against the folder in the other.
 */
async function approachedWithin(targeting) {
  const rows = await anty.from("wl_outreach").select("crm_contact_id").rows();
  const ids = [...new Set(rows.map((row) => row.crm_contact_id).filter(Boolean))];
  if (!ids.length) return 0;

  let total = 0;
  for (let start = 0; start < ids.length; start += CONTACT_ID_BATCH) {
    total += await queueQuery("id", targeting).in("id", ids.slice(start, start + CONTACT_ID_BATCH)).count();
  }
  return total;
}

/**
 * What the chosen accounts can send, today and at their best.
 *
 * An account that is paused, unhealthy or not warming yet contributes nothing
 * to today and still contributes its peak, because the screen has to be able to
 * show the difference between "today" and "when everything is warm" — that
 * difference is usually the reason a queue is not moving.
 */
async function accountCapacity(accountIds) {
  if (!accountIds.length) return { perDayNow: 0, perDayAtPeak: 0, accountsChosen: 0 };

  const [accounts, runs, strategies] = await Promise.all([
    anty.from("wl_accounts").select("id,status,strategy_id").in("id", accountIds).rows(),
    anty.from("wl_runs").select("account_id,state,started_at,paused_days,paused_until,strategy_snapshot")
      .in("account_id", accountIds)
      .in("state", ["running", "paused", "completed"])
      .order("started_at", { ascending: false })
      .rows(),
    anty.from("wl_strategies").select("id,name,phases,is_default,is_archived").rows()
  ]);

  const runByAccount = new Map();
  for (const run of runs) if (!runByAccount.has(run.account_id)) runByAccount.set(run.account_id, run);

  const strategyById = new Map(strategies.map((row) => [row.id, row]));
  const houseDefault = strategies.find((row) => row.is_default && !row.is_archived) || DEFAULT_STRATEGY;

  const todayIso = today();
  let perDayNow = 0;
  let perDayAtPeak = 0;

  for (const account of accounts) {
    const run = runByAccount.get(account.id) || null;
    perDayNow += connectQuotaToday(account, run, todayIso);
    // A run is worked to its own snapshot; an account with no run has not
    // frozen one yet, so the peak comes from the strategy it would start under.
    const strategy = run?.strategy_snapshot?.phases
      ? run.strategy_snapshot
      : strategyById.get(account.strategy_id) || houseDefault;
    perDayAtPeak += peakConnect(strategy, account.id);
  }

  return { perDayNow, perDayAtPeak, accountsChosen: accounts.length };
}

/** The forecast for one targeting, across both databases. */
export async function forecastFor(targeting) {
  const [matching, alreadyApproached, capacity] = await Promise.all([
    queueTotal(targeting),
    approachedWithin(targeting),
    accountCapacity(targeting.accountIds)
  ]);
  return buildForecast({ matching, alreadyApproached, ...capacity });
}
