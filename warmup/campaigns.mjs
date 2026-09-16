import { randomUUID } from "node:crypto";

import { normalizeFilters, normalizeTargeting } from "./targeting.mjs";

/**
 * A campaign: a folder, narrowed by filters, worked by some accounts, under a
 * name and a state.
 *
 * This replaces targeting rather than sitting beside it. Targeting was one
 * folder and one set of accounts; a campaign is the same thing with a name, so
 * keeping both would leave two places answering "which folder is this account
 * working" — and the day somebody edited one, they would disagree.
 *
 * **A campaign proposes; the warm-up disposes.** A campaign has no pace of its
 * own. It says who is next; whether anything may be sent today is answered by
 * `checkQuota` exactly as it is for an action recorded by hand. That is what
 * makes a campaign safe to point at a folder of twenty thousand people: it
 * cannot make an account do more than its warm-up day allows.
 */

export const CAMPAIGN_STATES = ["draft", "running", "paused", "done"];

/**
 * How long a claim stands before it is released.
 *
 * Longer than any working session and shorter than a day, so a crash costs one
 * day of one account's allocation at most — and never burns a contact
 * permanently, which is what a claim that outlived its session would do.
 */
export function claimTtlHours() {
  const hours = Number(process.env.CLAIM_TTL_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : 20;
}

/** The instant before which a `queued` row is stale and gets released. */
export function claimCutoff(now = Date.now()) {
  return new Date(now - claimTtlHours() * 3600000).toISOString();
}

function text(value, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function accountIds(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((id) => text(id)).filter(Boolean))];
}

/**
 * What a campaign narrows by before anybody has touched the filters: the lead
 * status the queue has always meant, and the owner an old deployment was pinned
 * to. The same starting point Phase 1 gave a targeting nobody had saved.
 */
export function defaultFilters() {
  return normalizeTargeting(null).filters;
}

export function isCampaignState(value) {
  return typeof value === "string" && CAMPAIGN_STATES.includes(value);
}

export function normalizeCampaign(raw, index = 0) {
  const now = new Date().toISOString();
  return {
    id: text(raw?.id, 60) || randomUUID(),
    name: text(raw?.name, 120) || "Untitled campaign",
    folderId: text(raw?.folderId),
    folderName: text(raw?.folderName, 200) || null,
    filters: normalizeFilters(raw?.filters),
    accountIds: accountIds(raw?.accountIds),
    productId: text(raw?.productId, 80) || null,
    state: isCampaignState(raw?.state) ? raw.state : "draft",
    order: Number.isFinite(raw?.order) ? Number(raw.order) : index,
    createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : now
  };
}

export function byOrder(left, right) {
  return left.order - right.order || Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

export function nextOrder(campaigns) {
  return campaigns.reduce((max, campaign) => Math.max(max, campaign.order + 1), 0);
}

/** Number an already-ordered list 0..n-1, touching only what has to change. */
function number(ordered) {
  return ordered.map((campaign, index) => (campaign.order === index ? campaign : { ...campaign, order: index }));
}

/**
 * The list as positions: sorted, then numbered 0..n-1 with no gaps and no ties.
 *
 * Run on every write, so a delete closes its gap and `order` always means the
 * place a campaign is in rather than a number it happens to carry.
 */
export function renumber(campaigns) {
  return number(campaigns.slice().sort(byOrder));
}

/**
 * Move a campaign to a position, and renumber the rest around it.
 *
 * `order` is a position, not a label. Writing one campaign's number and leaving
 * its siblings alone leaves two campaigns claiming the same place, and the
 * tie-break by age then quietly keeps the older one in front — so "put this one
 * first" would not put it first, which is the whole point of the control. The
 * claiming rule leans on this: an account's quota goes to the first campaign in
 * order, and a seller who cannot reorder cannot choose which one that is.
 */
export function moveTo(campaigns, id, position) {
  const ordered = campaigns.slice().sort(byOrder);
  const from = ordered.findIndex((campaign) => campaign.id === id);
  if (from < 0) return number(ordered);

  const [moved] = ordered.splice(from, 1);
  // Past either end is that end: a control that overshoots should land, not fail.
  const to = Math.max(0, Math.min(Math.trunc(position), ordered.length));
  ordered.splice(to, 0, moved);
  return number(ordered);
}

/**
 * The saved list, or the Phase 1 selection turned into one campaign.
 *
 * Migration reads the old key and never writes it, so a rollback to Phase 1
 * finds its targeting exactly as it left it. The campaign is named after the
 * folder and starts `running`, because the folder it names is the one the
 * warm-up was already working — a migration that quietly stopped the work
 * would be a migration nobody noticed until a week of sending was missing.
 */
export function migrateCampaigns(savedCampaigns, savedTargeting) {
  if (Array.isArray(savedCampaigns)) {
    return { campaigns: savedCampaigns.map(normalizeCampaign).sort(byOrder), migrated: false };
  }

  // `normalizeTargeting` also answers with the folder an old deployment was
  // pinned to by environment, so an installation that never pressed Save still
  // opens on the folder it has been running.
  const targeting = normalizeTargeting(savedTargeting);
  if (!targeting.folderId) return { campaigns: [], migrated: false };

  const stamp = targeting.updatedAt || new Date().toISOString();
  return {
    campaigns: [normalizeCampaign({
      // Derived from the folder rather than drawn fresh, so two reads racing at
      // startup migrate to the same campaign instead of two identical ones with
      // different ids — one of which a panel would already be holding.
      id: `targeting-${targeting.folderId}`,
      name: targeting.folderName || "Warm-up",
      folderId: targeting.folderId,
      folderName: targeting.folderName || null,
      filters: targeting.filters,
      accountIds: targeting.accountIds,
      state: "running",
      order: 0,
      createdAt: stamp,
      updatedAt: stamp
    })],
    migrated: true
  };
}

/**
 * The shape the folder queries take. `queueQuery`, the forecast and the lead
 * queue were all written against targeting and mean exactly this much of a
 * campaign — so a campaign is handed to them as one rather than each of them
 * learning what a campaign is.
 */
export function targetingOf(campaign) {
  return {
    folderId: campaign.folderId,
    folderName: campaign.folderName,
    filters: { ...campaign.filters },
    accountIds: [...campaign.accountIds],
    updatedAt: campaign.updatedAt
  };
}

export function describeCampaign(campaign, folderName = null) {
  return {
    id: campaign.id,
    name: campaign.name,
    folderId: campaign.folderId || null,
    folderName: folderName || campaign.folderName || null,
    filters: { ...campaign.filters },
    accountIds: [...campaign.accountIds],
    productId: campaign.productId,
    state: campaign.state,
    order: campaign.order,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt
  };
}

/**
 * The campaigns this account works, in the order a seller put them in.
 *
 * First campaign with work takes the quota. Round-robin was rejected: putting
 * a campaign first is a statement, and splitting an account three ways produces
 * three campaigns that all crawl.
 */
export function runningFor(campaigns, accountId) {
  return campaigns
    .filter((campaign) => campaign.state === "running" && campaign.accountIds.includes(accountId) && campaign.folderId)
    .sort(byOrder);
}

/**
 * How many people may be claimed right now.
 *
 * What is already queued counts against the allowance even though it has spent
 * nothing: a claim is an allocation, and allocating ten to an account that can
 * send five is how a queue becomes a list of people nobody will reach today.
 */
export function claimCapacity({ quota, spent, queued, limit = 0 }) {
  const room = Math.max(0, quota - spent - queued);
  return limit > 0 ? Math.min(room, limit) : room;
}

/**
 * Why nothing can be claimed, in a sentence a seller can act on.
 *
 * Every account is on day 1–3 for its first three days and the standard
 * strategy forbids requests until day 4 — so "nothing today" is the ordinary
 * answer for a new account, not a fault, and it has to read like one.
 */
export function allowanceReason({ day, totalDays, quota, spent, queued, startsDay = null }) {
  if (day > totalDays) return `The warm-up is finished — day ${day} of ${totalDays}`;
  if (quota <= 0) {
    return startsDay
      ? `Day ${day} of ${totalDays} — connection requests start on day ${startsDay}`
      : `Day ${day} of ${totalDays} — no connection requests are planned for today`;
  }
  if (spent >= quota) return `Day ${day} of ${totalDays} — today's ${quota} connection requests are already spent`;
  if (queued >= quota - spent) return `${queued} already claimed and today allows ${quota} — work through the queue first`;
  return null;
}

export function emptyProgress() {
  return { queued: 0, sent: 0, replied: 0, claimedToday: 0, sentToday: 0 };
}

/**
 * A campaign's progress, from outreach rows already narrowed to its accounts
 * and its folder.
 *
 * `sentToday` is not counted from these rows: a row claimed yesterday and sent
 * this morning still carries yesterday's `created_at`, and there is no column
 * to record the send in without a migration. It comes from the warm-up's own
 * day counter instead — the same number the quota is checked against, which is
 * the only one that cannot drift from what was actually sent.
 */
export function progressFrom(rows, { todayIso, sentToday = 0 }) {
  const progress = { ...emptyProgress(), sentToday };
  for (const row of rows) {
    if (row.status === "queued") {
      progress.queued += 1;
      if (typeof row.created_at === "string" && row.created_at.slice(0, 10) === todayIso) progress.claimedToday += 1;
      continue;
    }
    progress.sent += 1;
    if (row.status === "connected") progress.replied += 1;
  }
  return progress;
}

/**
 * Whether this campaign's progress over-counts.
 *
 * An outreach row carries no campaign id — it cannot, without a migration — so
 * a campaign's rows are its accounts' rows for contacts inside its folder.
 * Where two campaigns share an account and a folder, each counts the other's
 * work. That is said out loud rather than papered over.
 */
export function progressApproximate(campaign, campaigns) {
  return campaigns.some((other) =>
    other.id !== campaign.id
    && other.folderId === campaign.folderId
    && other.accountIds.some((id) => campaign.accountIds.includes(id)));
}
