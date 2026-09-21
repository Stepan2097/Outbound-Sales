import { anty } from "./db.mjs";
import { logEvent } from "./store.mjs";
import { CLAIM_STATUS, OUTREACH_COLUMNS, personSnapshot, sentBy } from "./outreach.mjs";

/**
 * Connection requests asked for from the lead workspace: who asked, with what
 * note, what the agent did about it and what it saw when it looked again.
 *
 * **Everything here is a compromise and it is written down as one.** An
 * invitation wants its own table; it cannot have one, for the same reason
 * messages cannot — no Postgres password for the Anty database and no
 * `exec_sql` RPC, so no migration can run. So an invitation is two things: a
 * `wl_outreach` row holding the person (the unique index there is what stops
 * two accounts approaching the same human), and `wl_events` rows of type
 * `invite.*` holding everything about it that is not a status.
 *
 * What that costs:
 *
 * - No index on `meta->>crmContactId`, so a person's invite history is a scan
 *   with a filter. Fine at a few thousand, wrong at a hundred thousand.
 * - No foreign key to `wl_outreach`, so an event can outlive the row it
 *   describes. That is deliberate for `invite.cancelled` — the row is gone and
 *   the fact that somebody cancelled it is the only thing left.
 *
 * **This module is the containment.** Every read and write of an `invite.*`
 * event happens here and nowhere else, and so does every status move made by
 * something other than a person: the inbox sync's `markReplied` and, from the
 * next phase, the agent's two reports. A seller pressing a button in the panel
 * still writes through the routes — those moves have a human behind them who
 * can be asked what they meant. When a password arrives, moving to real tables
 * is this file and no call sites.
 */

export const INVITE_REQUESTED = "invite.requested";
export const INVITE_SENT = "invite.sent";
export const INVITE_CHECKED = "invite.checked";
export const INVITE_CANCELLED = "invite.cancelled";
export const INVITE_REASSIGNED = "invite.reassigned";
export const INVITE_FAILED = "invite.failed";

export const INVITE_TYPES = [
  INVITE_REQUESTED, INVITE_SENT, INVITE_CHECKED, INVITE_CANCELLED, INVITE_REASSIGNED, INVITE_FAILED
];

/**
 * A person held for an invitation nobody has sent yet.
 *
 * Deliberately not `queued`: that status is a campaign claim, and
 * `releaseExpiredClaims()` **deletes** every one of them older than
 * `CLAIM_TTL_HOURS` (20) from any Claim or Release click in the workspace. An
 * invitation waiting for tomorrow's quota would be gone by 06:00, three hours
 * before the session window opens. Every DELETE in this codebase is guarded
 * `.eq("status", CLAIM_STATUS)`, so a status that is not `queued` is immune to
 * the sweep by construction — which is the whole reason for a new value rather
 * than a longer TTL.
 *
 * The price is the mirror image: nothing releases a `waiting` row on its own.
 * A person waits until an account sends to them or a seller cancels, and the
 * screen has to show the age so that "waiting" cannot quietly become "lost".
 */
export const WAITING_STATUS = "waiting";

/**
 * Accepted, and silent.
 *
 * `connected` already means "they wrote to us" — `markReplied` is its only
 * automatic writer and it sets `responded_at` from an inbound message. Writing
 * it when an invitation is accepted would destroy the portal's only signal
 * that a human actually replied, so acceptance gets its own value between the
 * two.
 */
export const ACCEPTED_STATUS = "accepted";

/**
 * Which status may follow which, and nothing else.
 *
 * The bug this exists to prevent is ordinary and would have shipped: a person
 * accepts an invitation and writes the same day. Within one agent run the
 * inbox sync sets `connected`, and then the daily invitation check — which
 * sees them in the contact list — sets `accepted` over it. Nothing orders the
 * two reports. The seller is then told "they accepted, go write to them" about
 * somebody who already wrote to them, and `responded_at` has been erased.
 *
 * So every automatic move goes forward or not at all, and it is one table here
 * rather than a condition at each call site. Note what is absent: nothing may
 * leave `accepted` except for `connected`. Somebody who accepted and later
 * removed the connection does not become `withdrawn` — the acceptance
 * happened, and history is not edited to match the present.
 *
 * A human correcting a record by hand through `PATCH /api/warmup/outreach` is
 * not bound by this. This is about writers that cannot be argued with.
 */
const ALLOWED_MOVES = {
  [WAITING_STATUS]: ["pending", ACCEPTED_STATUS, "declined", "withdrawn"],
  [CLAIM_STATUS]: ["pending", ACCEPTED_STATUS, "declined", "withdrawn"],
  pending: [ACCEPTED_STATUS, "connected", "declined", "withdrawn"],
  [ACCEPTED_STATUS]: ["connected"],
  connected: [],
  declined: [],
  withdrawn: []
};

export function canMove(from, to) {
  return (ALLOWED_MOVES[from] || []).includes(to);
}

/**
 * Move one row forward, or report honestly that it did not move.
 *
 * The guard is applied twice on purpose: once here against the status we read,
 * and once as `.eq("status", from)` inside the update, so two reports arriving
 * a millisecond apart leave one move and one `{ moved: false }` rather than
 * two moves and a lost `responded_at`. `markReplied` already defends itself
 * this way; this is the same defence, spelled once.
 */
export async function moveStatus({ outreachId, to, patch = {} }) {
  const current = await anty.from("wl_outreach").select("id,status").eq("id", outreachId).maybeSingle();
  if (!current) return { moved: false, reason: "gone", row: null };
  if (current.status === to) return { moved: false, reason: "already", row: null };
  if (!canMove(current.status, to)) return { moved: false, reason: "refused", from: current.status, row: null };

  const updated = await anty.from("wl_outreach")
    .update({ ...patch, status: to })
    .eq("id", outreachId).eq("status", current.status)
    .select(OUTREACH_COLUMNS).rows();

  // Lost the race: somebody moved this row between the read and the write.
  if (!updated.length) return { moved: false, reason: "raced", from: current.status, row: null };
  return { moved: true, from: current.status, row: updated[0] };
}

/** The row holding this person, whatever state it is in. */
export async function outreachForContact(crmContactId) {
  if (!crmContactId) return null;
  return anty.from("wl_outreach").select(OUTREACH_COLUMNS).eq("crm_contact_id", String(crmContactId)).maybeSingle();
}

/**
 * Hold this person for an invitation, and write down who asked for it.
 *
 * The quota is deliberately not consulted. What is being recorded is an
 * intention, and the thing worth counting is the request that actually leaves
 * the account — which the agent reports when it happens. A seller may queue an
 * invitation on an account with nothing left today; it goes out tomorrow, and
 * the screen says so.
 *
 * A 23505 from `wl_outreach_person_once` is left to the caller: it is not an
 * error, it is the answer "somebody already has this person", and the caller
 * is the one that can say who.
 */
export async function requestInvite({ account, lead, note = "", requestedBy = "" }) {
  const row = await anty.from("wl_outreach").insert({
    account_id: account.id,
    ...personSnapshot(lead),
    sent_by: sentBy(account),
    status: WAITING_STATUS,
    note: note.trim() || null
  }).select(OUTREACH_COLUMNS).single();

  await logEvent({
    accountId: account.id,
    type: INVITE_REQUESTED,
    message: `Invitation queued for ${lead.name || "a contact"}${lead.company ? ` (${lead.company})` : ""} on ${sentBy(account)}`,
    meta: { outreachId: row.id, crmContactId: lead.id, accountId: account.id, note: note.trim() || null, requestedBy }
  });
  return row;
}

/**
 * Give up on a waiting invitation and release the person.
 *
 * Only a waiting row can be cancelled. A request that has gone out cannot be
 * unsent from here, and deleting its row would release a person LinkedIn still
 * shows a pending invitation to — the worst of both.
 */
export async function cancelInvite({ outreachId, cancelledBy = "" }) {
  const gone = await anty.from("wl_outreach")
    .eq("id", outreachId).eq("status", WAITING_STATUS)
    .remove().select("id,account_id,crm_contact_id,person_name").rows();
  if (!gone.length) return null;

  const row = gone[0];
  await logEvent({
    accountId: row.account_id,
    type: INVITE_CANCELLED,
    message: `Invitation to ${row.person_name || "a contact"} cancelled before it was sent`,
    meta: { outreachId: row.id, crmContactId: row.crm_contact_id, cancelledBy }
  });
  return row;
}

/**
 * Point a waiting invitation at a different account.
 *
 * The account an invitation waits on can stop warming — excluded, unhealthy,
 * or simply finished — and then the row waits forever on a login that will
 * never open a browser. Without this the only exit is cancelling, which throws
 * away the seller's work and hands the person back to the pool. Changing
 * `account_id` on a waiting row touches nothing the unique index cares about:
 * that index is on `crm_contact_id` alone.
 */
export async function reassignInvite({ outreachId, account, movedBy = "" }) {
  const updated = await anty.from("wl_outreach")
    .update({ account_id: account.id, sent_by: sentBy(account) })
    .eq("id", outreachId).eq("status", WAITING_STATUS)
    .select(OUTREACH_COLUMNS).rows();
  if (!updated.length) return null;

  await logEvent({
    accountId: account.id,
    type: INVITE_REASSIGNED,
    message: `Invitation to ${updated[0].person_name || "a contact"} moved to ${sentBy(account)}`,
    meta: { outreachId, crmContactId: updated[0].crm_contact_id, accountId: account.id, movedBy }
  });
  return updated[0];
}

/**
 * Write down that an invitation went out.
 *
 * `by` is "agent" when the browser did it and "seller" when a human did it in
 * their own browser and came here to record it. `overQuota` is the honest flag
 * for the second case: a request a human already sent is a fact, and a fact
 * that does not fit today's allowance is still a fact. It is logged at `warn`
 * so it shows up as one.
 */
export async function recordSent({ account, run = null, outreach, by, overQuota = false, allowance = null }) {
  await logEvent({
    accountId: account.id,
    runId: run?.id ?? null,
    level: overQuota ? "warn" : "info",
    type: INVITE_SENT,
    message: overQuota
      ? `Connection request to ${outreach.person_name || "a contact"} recorded beyond today's allowance`
      : `Connection request to ${outreach.person_name || "a contact"} sent from ${outreach.sent_by}`,
    meta: {
      outreachId: outreach.id,
      crmContactId: outreach.crm_contact_id,
      accountId: account.id,
      by,
      overQuota,
      ...(allowance ? { day: allowance.day, done: allowance.done, quota: allowance.quota } : {})
    }
  });
}

/**
 * How much invitation work one run may do.
 *
 * The send is bounded by the day's quota anyway; this is the second bound, on
 * the thing quota does not cover — the check is a read, costs no allowance, and
 * would otherwise grow into a crawl of every person the account ever wrote to.
 * Twenty is the inbox's number for the same reason, kept the same so an
 * operator watching a run sees one shape of behaviour rather than two.
 */
export const MAX_INVITES_PER_RUN = 10;
export const MAX_INVITE_CHECKS_PER_RUN = 20;

/** Waiting invitations for this account, oldest first — the ones queued longest go first. */
export async function invitesToSend(accountId, limit = MAX_INVITES_PER_RUN) {
  if (!accountId || limit <= 0) return [];
  const rows = await anty.from("wl_outreach").select(OUTREACH_COLUMNS)
    .eq("account_id", accountId).eq("status", WAITING_STATUS)
    .order("created_at", { ascending: true }).limit(limit).rows();
  return rows.map((row) => ({
    outreachId: row.id,
    crmContactId: row.crm_contact_id,
    name: row.person_name,
    company: row.person_company,
    position: row.person_position,
    linkedin: row.person_linkedin,
    note: row.note || ""
  }));
}

/** Sent invitations still waiting for an answer, oldest first. */
export async function invitesToCheck(accountId, limit = MAX_INVITE_CHECKS_PER_RUN) {
  if (!accountId || limit <= 0) return [];
  const rows = await anty.from("wl_outreach").select(OUTREACH_COLUMNS)
    .eq("account_id", accountId).eq("status", "pending")
    .order("created_at", { ascending: true }).limit(limit).rows();
  return rows.map((row) => ({
    outreachId: row.id,
    crmContactId: row.crm_contact_id,
    name: row.person_name,
    linkedin: row.person_linkedin,
    heldAt: row.created_at
  }));
}

/** How many people this account is holding for an invitation nobody has sent. */
export async function waitingCounts(accountIds = []) {
  const counts = new Map();
  if (!accountIds.length) return counts;
  const rows = await anty.from("wl_outreach").select("account_id")
    .in("account_id", accountIds).eq("status", WAITING_STATUS).rows();
  for (const row of rows) counts.set(row.account_id, (counts.get(row.account_id) || 0) + 1);
  return counts;
}

/**
 * The statuses a reply could still arrive from.
 *
 * `connected` is here as well as the two unanswered ones: a conversation that
 * is already going does not stop being worth reading. `declined` and
 * `withdrawn` are not — nobody is going to write from those — and neither is
 * `waiting`, where nothing has been sent yet.
 */
export const REPLIABLE_FROM = ["pending", ACCEPTED_STATUS, "connected"];

/**
 * How many people each account has an open conversation with.
 *
 * This is the evidence behind reading the inbox. "We have not read it today"
 * is a statement about us, not about there being anything to read: an account
 * that finished warming without ever approaching anybody has no threads and no
 * invitations, and waking it every morning to open an empty inbox is the
 * machine doing what a person never would.
 */
export async function openConversationCounts(accountIds = []) {
  const counts = new Map();
  if (!accountIds.length) return counts;
  const rows = await anty.from("wl_outreach").select("account_id")
    .in("account_id", accountIds).in("status", REPLIABLE_FROM).rows();
  for (const row of rows) counts.set(row.account_id, (counts.get(row.account_id) || 0) + 1);
  return counts;
}

/** How many sent invitations each of these accounts is still waiting on. */
export async function pendingCounts(accountIds = []) {
  const counts = new Map();
  if (!accountIds.length) return counts;
  const rows = await anty.from("wl_outreach").select("account_id")
    .in("account_id", accountIds).eq("status", "pending").rows();
  for (const row of rows) counts.set(row.account_id, (counts.get(row.account_id) || 0) + 1);
  return counts;
}

/**
 * Which of these accounts has already had its invitations looked at today.
 *
 * One query for all of them rather than one `lastCheckedAt` per account: this
 * runs on every worker poll, and a poll that costs one request per account is
 * a poll nobody can afford to make often.
 */
export async function checkedTodayAccounts(accountIds = [], todayIso) {
  const seen = new Set();
  if (!accountIds.length || !todayIso) return seen;
  const rows = await anty.from("wl_events").select("account_id")
    .in("account_id", accountIds).eq("type", INVITE_CHECKED)
    .gte("created_at", `${todayIso}T00:00:00.000Z`).rows();
  for (const row of rows) seen.add(row.account_id);
  return seen;
}

/** When this account's invitations were last looked at, whatever was seen. */
export async function lastCheckedAt(accountId) {
  if (!accountId) return null;
  const row = await anty.from("wl_events").select("created_at")
    .eq("account_id", accountId).eq("type", INVITE_CHECKED)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return row?.created_at ?? null;
}

/**
 * What the agent saw when it looked at the sent invitations.
 *
 * The event is written **every time**, including when nothing moved. A run of
 * zeros is the one signal that the sent-invitations page changed its markup,
 * and without the row "nobody is accepting" and "the agent stopped looking"
 * are the same empty screen. `inbox.synced` earned its place the same way.
 */
export async function recordCheck({ account, run = null, results = [] }) {
  let accepted = 0;
  let withdrawn = 0;
  const refused = [];

  for (const result of results) {
    if (!result?.outreachId) continue;
    if (result.state === "accepted") {
      const moved = await moveStatus({ outreachId: String(result.outreachId), to: ACCEPTED_STATUS });
      if (moved.moved) accepted += 1;
      else if (moved.reason === "refused") refused.push({ outreachId: result.outreachId, from: moved.from, to: ACCEPTED_STATUS });
    } else if (result.state === "gone") {
      const moved = await moveStatus({ outreachId: String(result.outreachId), to: "withdrawn" });
      if (moved.moved) withdrawn += 1;
      else if (moved.reason === "refused") refused.push({ outreachId: result.outreachId, from: moved.from, to: "withdrawn" });
    }
  }

  await logEvent({
    accountId: account.id,
    runId: run?.id ?? null,
    type: INVITE_CHECKED,
    message: `Checked ${results.length} sent invitation${results.length === 1 ? "" : "s"}: ${accepted} accepted, ${withdrawn} gone`,
    // `refused` is the interesting column when something looks wrong: it means
    // the check tried to move a row the table would not let it move, which is
    // either a stale report or a rule somebody should look at.
    meta: { checked: results.length, accepted, withdrawn, ...(refused.length ? { refused } : {}) }
  });

  return { checked: results.length, accepted, withdrawn, refused };
}

/** An invitation the browser could not send, and why — the row stays waiting. */
export async function recordFailed({ account, outreach, outcome }) {
  await logEvent({
    accountId: account.id,
    level: "warn",
    type: INVITE_FAILED,
    message: `Could not invite ${outreach.person_name || "a contact"}: ${outcome}`,
    meta: { outreachId: outreach.id, crmContactId: outreach.crm_contact_id, outcome }
  });
}

/** Every invite event for one person, oldest first — the invitation's own story. */
export async function inviteEvents(crmContactId, limit = 50) {
  if (!crmContactId) return [];
  const rows = await anty.from("wl_events")
    .select("id,account_id,type,message,meta,level,created_at")
    .in("type", INVITE_TYPES)
    .eq("meta->>crmContactId", String(crmContactId))
    .order("created_at", { ascending: true })
    .limit(limit)
    .rows();
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    at: row.created_at,
    level: row.level,
    message: row.message,
    meta: row.meta || {}
  }));
}

/**
 * One invitation as every screen sees it: the row, when it was really sent,
 * and who asked for it.
 *
 * `sentAt` comes from the `invite.sent` event rather than from `created_at`,
 * which is the moment the person was held — hours or a day earlier. A timeline
 * ordered by `created_at` puts the invitation before things that happened
 * before it.
 */
export function describeInvite(row, events = []) {
  if (!row) return null;
  const requested = events.find((event) => event.type === INVITE_REQUESTED);
  const sent = events.filter((event) => event.type === INVITE_SENT).at(-1);
  const checked = events.filter((event) => event.type === INVITE_CHECKED).at(-1);
  return {
    outreachId: row.id,
    accountId: row.account_id,
    crmContactId: row.crm_contact_id,
    name: row.person_name,
    company: row.person_company,
    linkedin: row.person_linkedin,
    sentBy: row.sent_by,
    status: row.status,
    note: row.note,
    heldAt: row.created_at,
    requestedBy: requested?.meta?.requestedBy || "",
    sentAt: sent?.at || null,
    sentByWhom: sent?.meta?.by || "",
    overQuota: Boolean(sent?.meta?.overQuota),
    lastCheckedAt: checked?.at || null,
    respondedAt: row.responded_at,
    waitingDays: row.status === WAITING_STATUS ? daysSince(row.created_at) : 0
  };
}

function daysSince(iso) {
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 86_400_000));
}
