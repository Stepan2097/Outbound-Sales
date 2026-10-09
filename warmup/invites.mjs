import { anty, CONTACT_ID_BATCH, today } from "./db.mjs";
import { logEvent } from "./store.mjs";
import { accountName, clampContent, copyToCrm, crmStamp } from "./activities.mjs";
import { CLAIM_STATUS, OUTREACH_COLUMNS, linkedinSlug, personSnapshot, sentBy } from "./outreach.mjs";
import { noteUnderRule } from "./strategy.mjs";
import { DEFAULT_FROM_DAY } from "./campaigns.mjs";

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

/**
 * Everything the agent may report about one attempt, and nothing else.
 *
 * A closed list because the route derives two decisions from it — which status
 * to move to, and whether the day's allowance is spent — and an unknown string
 * silently answered "pending, and free".
 */
export const INVITE_OUTCOMES = [
  "sent", "already_pending", "already_connected",
  "no_button", "cannot_connect", "no_note", "profile_gone", "blocked"
];

/**
 * The outcomes that leave the person held and the row untouched.
 *
 * `no_note` is here and it is the one worth explaining. LinkedIn does not
 * always offer a note — it depends on the account and sometimes on the profile
 * — and it caps the length. The browser is then one click away from sending a
 * bare connection request, which is a different object: it arrives with no
 * reason why anybody wants to connect, and the text a seller wrote and
 * approved never reaches them. `wl_outreach_person_once` makes that the only
 * approach this person will ever get from anybody here, so a blank request
 * does not cost a retry — it costs the person. Better to stop and leave it to
 * a human, who can shorten the note, use an account that can attach one, or
 * decide a bare request is fine this once.
 *
 * Only a note the portal handed over can be missing. An empty note is the
 * phase's rule saying "no note today" (`invitesToSend`), and a bare request is
 * then what the plan asked for — there is nothing for `no_note` to report.
 *
 * Held means held for a *person*. A row nobody picked — the folder added it —
 * has no person to wait for, so it is let go instead (`releaseFedInvite`), and
 * whether the folder may offer the person again depends on what the report
 * says about *them*:
 *
 * - `cannot_connect`, `profile_gone` — about the profile: never again.
 * - `no_button` — about *us*: the browser never found the card to look at.
 *   Back to the pool unmarked, so a page LinkedIn redesigned cannot empty the
 *   folder (08.10.2026 it emptied eleven people out of one).
 * - `blocked` — never again as well, and deliberately. The page may have been
 *   about the account (a rate limit) rather than the person, but it may have
 *   been about the person, and offering them again risks a second two-day
 *   pause of the account. One lead is cheaper than that.
 * - `no_note` on a request handed over bare — about the agent, which is out of
 *   date (`invite.agent_mismatch`), not about the person. Back to the pool
 *   with no marker: skipping them would let an old agent empty the folder, a
 *   day's cap at a time, of people nobody ever tried to reach.
 * - Anything reported while the account was already paused — the agent went
 *   on after an earlier block page or a warning — is about the account. Back
 *   to the pool with no marker too, or an agent that does not stop on
 *   `blocked` would write off everybody left in its `toSend`.
 *
 * A row a seller picked stays `waiting`: it rests until tomorrow, and a
 * `blocked` one is parked at once (`waitingFacts`) — unless the account was
 * already paused when it came.
 */
export const INVITE_HELD_OUTCOMES = ["no_button", "cannot_connect", "no_note", "profile_gone", "blocked"];

export const INVITE_TYPES = [
  INVITE_REQUESTED, INVITE_SENT, INVITE_CHECKED, INVITE_CANCELLED, INVITE_REASSIGNED, INVITE_FAILED
];

/**
 * The folder's "not this person again": written when a person the folder added
 * is let go — the browser could not send to them for a reason about them
 * (`releaseFedInvite`; see `INVITE_HELD_OUTCOMES` for which) or a seller
 * cancelled them (`cancelInvite`) — and read by the walk, which steps over them
 * from then on (`skippedAmong`).
 *
 * Without it, letting a folder-fed person go only put them back at the head of
 * the folder, and the very next top-up queued them again: a broken profile
 * link came back every session, and a person a seller removed was sent anyway.
 * It is a marker and not a status because the row has to go — a `waiting` row
 * nobody will send holds a slot of the account's day for good — and
 * `wl_outreach` has nowhere else to keep it. It binds the automatic feed only:
 * a seller can still queue the person by hand from the lead workspace.
 */
/**
 * Which held outcomes say something about the *person*, and so earn the
 * folder's "not this one again".
 *
 * `profile_gone` is LinkedIn's own answer about them. `blocked` is a page we
 * must not walk into twice, whoever it was really about. `no_note` is theirs
 * too when the note was real: a Connect that will not carry an approved
 * sentence is this person's Connect — and when the note was never there, the
 * `mismatch` branch already keeps the row unmarked.
 *
 * `cannot_connect` is theirs as well, and it is the half of the old
 * `no_button` that LinkedIn really answered: the card was on screen, it was
 * the right person's, and there was no Connect in the header, none under
 * «More», or the dialog demanded their email. Tomorrow it will say the same,
 * so the folder is told not to offer them again.
 *
 * `no_button` is what is left, and it is about **us**: the browser never
 * found the card to look at. On 08.10.2026 that cost eleven people out of a
 * folder in one morning — a profile page moved the name out of its `h1`, ten
 * requests in a visit came back `no_button`, and each was written off as if
 * LinkedIn had refused them. Such a row still goes back to the pool (it has
 * no seller to wait for, and waiting it would hold a slot of the day's
 * allowance); it is simply not marked, so the folder may offer them again
 * once the browser works. What keeps a broken agent from walking the whole
 * folder is the daily cap in `folderRoom`, not a write-off.
 *
 * The split matters in both directions: before it, every unreachable profile
 * came back every single day and ate a slot of the account's allowance, and
 * every redesign wrote people off. An agent built before the split reports
 * `no_button` for both, and nothing is written off — the cautious half.
 */
// `cannot_connect` is NOT here any more. On 09.10.2026 every request of the
// morning — six people on three accounts — came back `cannot_connect`, and
// each was written off for good. Six people with no Connect anywhere is not
// LinkedIn answering about them; it is the agent not finding the control on a
// page that changed. «The card was found» turned out not to prove that the
// selectors work. Until the agent can tell the two apart from evidence, a
// person is never written off for it: they rest until tomorrow
// (`RESTING_OUTCOMES` in feed.mjs), like `no_button`.
export const INVITE_PERSON_OUTCOMES = ["no_note", "profile_gone", "blocked"];

export const FEED_SKIPPED = "campaign.skipped";

/** What a person's history is read from: their invitation, and the folder letting them go. */
const PERSON_EVENT_TYPES = [...INVITE_TYPES, FEED_SKIPPED];

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
 * The price is the mirror image: nothing releases a `waiting` row a seller
 * picked on its own. That person waits until an account sends to them or a
 * seller cancels, and the screen has to show the age so that "waiting" cannot
 * quietly become "lost". The one exception is a row the folder added and the
 * browser could not send to (`releaseFedInvite`): nobody picked it, so there is
 * nobody to wait for.
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

/** `meta.source` on an `invite.requested` a campaign's folder wrote rather than a person. */
export const FOLDER_SOURCE = "campaign";

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
 *
 * `campaign` is set when nobody picked this person: the campaign's folder
 * topped the account up to its allowance. It is the same row and the same
 * event as a seller's — so the person's history shows it like any other — and
 * the event says where it came from, because that is the only place it can:
 * `wl_outreach` has no column for it and no migration can add one.
 */
export async function requestInvite({ account, lead, note = "", requestedBy = "", campaign = null }) {
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
    message: `Invitation queued for ${lead.name || "a contact"}${lead.company ? ` (${lead.company})` : ""} on ${sentBy(account)}`
      + (campaign ? ` from the folder of campaign "${campaign.name}"` : ""),
    meta: {
      outreachId: row.id, crmContactId: lead.id, accountId: account.id, note: note.trim() || null, requestedBy,
      ...(campaign ? { source: FOLDER_SOURCE, campaignId: campaign.id, campaignName: campaign.name } : {})
    }
  });
  return row;
}

/**
 * Which of these waiting invitations the folder added, and from which
 * campaign. Read from their `invite.requested` events, which is where
 * `requestInvite` wrote it down.
 */
export async function fedInvites(outreachIds = []) {
  const fed = new Map();
  const ids = [...new Set(outreachIds.filter(Boolean).map(String))];
  for (let start = 0; start < ids.length; start += CONTACT_ID_BATCH) {
    const rows = await anty.from("wl_events").select("meta")
      .eq("type", INVITE_REQUESTED).eq("meta->>source", FOLDER_SOURCE)
      .in("meta->>outreachId", ids.slice(start, start + CONTACT_ID_BATCH)).rows();
    for (const row of rows) {
      if (!row.meta?.outreachId) continue;
      fed.set(String(row.meta.outreachId), { campaignId: row.meta.campaignId ?? null, campaignName: row.meta.campaignName ?? null });
    }
  }
  return fed;
}

/**
 * Write the folder's "not this person again" for one row — see `FEED_SKIPPED`.
 *
 * A plain insert rather than `logEvent`, which swallows a failed write: this
 * row is the only thing between the person and the next walk of the folder,
 * and a skip that quietly did not happen is the person queued again an hour
 * later. Both callers write it *before* the row goes, so a failure leaves the
 * person held where a human can see them rather than back in the pool.
 *
 * The slug goes in as well as the contact: the walk steps over the same
 * profile entered twice in the CRM (`nextCandidateIds`), and a person let go
 * under one contact id must not come back under the other.
 */
async function markSkipped({ accountId, row, fed = null, reason, outcome = null, cancelledBy = "" }) {
  const name = row.person_name || "a contact";
  await anty.from("wl_events").insert({
    account_id: accountId,
    level: reason === "cancelled" ? "info" : "warn",
    type: FEED_SKIPPED,
    message: reason === "cancelled"
      ? `Invitation to ${name} cancelled — the folder will not offer them again`
      : `${name} let go after ${outcome} — the folder will not offer them again`,
    meta: {
      outreachId: row.id,
      crmContactId: row.crm_contact_id,
      slug: linkedinSlug(row.person_linkedin) || null,
      reason,
      outcome,
      campaignId: fed?.campaignId ?? null,
      campaignName: fed?.campaignName ?? null,
      cancelledBy
    }
  }).rows();
}

/**
 * Give up on a waiting invitation and release the person.
 *
 * Only a waiting row can be cancelled. A request that has gone out cannot be
 * unsent from here, and deleting its row would release a person LinkedIn still
 * shows a pending invitation to — the worst of both.
 *
 * A person the folder added is released from the folder as well: they are
 * back in the pool for a seller, but the automatic feed never takes them
 * again. Otherwise the next top-up queued the person a seller had just
 * removed, and the only way to keep somebody out of a running campaign was to
 * edit the CRM folder. A person picked by hand goes back to the pool as before.
 */
export async function cancelInvite({ outreachId, cancelledBy = "" }) {
  const fed = (await fedInvites([outreachId])).get(String(outreachId)) ?? null;
  if (fed) {
    const held = await anty.from("wl_outreach").select(OUTREACH_COLUMNS)
      .eq("id", outreachId).eq("status", WAITING_STATUS).maybeSingle();
    if (held) await markSkipped({ accountId: held.account_id, row: held, fed, reason: "cancelled", cancelledBy });
  }

  const gone = await anty.from("wl_outreach")
    .eq("id", outreachId).eq("status", WAITING_STATUS)
    .remove().select("id,account_id,crm_contact_id,person_name").rows();
  if (!gone.length) return null;

  const row = gone[0];
  await logEvent({
    accountId: row.account_id,
    type: INVITE_CANCELLED,
    message: `Invitation to ${row.person_name || "a contact"} cancelled before it was sent`,
    meta: { outreachId: row.id, crmContactId: row.crm_contact_id, cancelledBy, ...(fed ? { skipped: true } : {}) }
  });
  return { ...row, skipped: Boolean(fed) };
}

/**
 * Let go of a person the folder added and the browser could not send to —
 * `no_button`, `profile_gone`, `no_note` or `blocked` — and, when `skip`, keep
 * the folder from offering them again (see `INVITE_HELD_OUTCOMES` for which).
 *
 * A row a seller picked stays `waiting` for that seller to decide about. One
 * the folder picked has nobody to decide: left waiting, it was tried again
 * every morning ahead of the day's new people, and it held a slot of the
 * account's allowance for as long as nobody looked. So it goes, and the
 * folder fills its place today — up to the daily cap in `folderRoom`, which is
 * what keeps a broken agent from walking the whole folder into "skipped".
 *
 * Answers whether the row was actually removed: `false` when it had already
 * moved (sent by hand, cancelled) between the report and here.
 */
export async function releaseFedInvite({ account, outreach, fed, outcome, skip = true }) {
  if (skip) await markSkipped({ accountId: account.id, row: outreach, fed, reason: "held", outcome });
  const gone = await anty.from("wl_outreach")
    .eq("id", outreach.id).eq("status", WAITING_STATUS)
    .remove().select("id").rows();
  return gone.length > 0;
}

/**
 * Which of these contacts, and which of these profile slugs, the folder has
 * let go (`FEED_SKIPPED`) — what the walk steps over besides `wl_outreach`.
 *
 * Batched with `in` only where a value cannot cut the list: a contact id is a
 * uuid, and a slug made only of letters, digits, `-`, `_` and `~` has no comma
 * in it. Anything else is asked on its own with `eq`, which carries any value.
 */
export async function skippedAmong({ contactIds = [], slugs = [] } = {}) {
  const found = { ids: new Set(), slugs: new Set() };
  const ids = [...new Set(contactIds.filter(Boolean).map(String))];
  const wantedSlugs = [...new Set(slugs.filter(Boolean))];
  const plain = wantedSlugs.filter(isPlainSlug);
  const odd = wantedSlugs.filter((slug) => !isPlainSlug(slug));

  for (let start = 0; start < ids.length; start += CONTACT_ID_BATCH) {
    const rows = await anty.from("wl_events").select("type,meta")
      .eq("type", FEED_SKIPPED).in("meta->>crmContactId", ids.slice(start, start + CONTACT_ID_BATCH)).rows();
    for (const row of rows) if (row.type === FEED_SKIPPED && row.meta?.crmContactId) found.ids.add(String(row.meta.crmContactId));
  }
  const bySlug = async (query) => {
    for (const row of await query.rows()) if (row.type === FEED_SKIPPED && row.meta?.slug) found.slugs.add(row.meta.slug);
  };
  for (let start = 0; start < plain.length; start += CONTACT_ID_BATCH) {
    await bySlug(anty.from("wl_events").select("type,meta")
      .eq("type", FEED_SKIPPED).in("meta->>slug", plain.slice(start, start + CONTACT_ID_BATCH)));
  }
  for (const slug of odd) {
    await bySlug(anty.from("wl_events").select("type,meta").eq("type", FEED_SKIPPED).eq("meta->>slug", slug));
  }
  return found;
}

/** A slug that can sit inside `in.(…)` or `or=(…)` without cutting it: see `skippedAmong`. */
export function isPlainSlug(slug) {
  return /^[\p{L}\p{N}_~-]+$/u.test(slug);
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
 *
 * `sentNote`, when given, is what the request actually carried — the output of
 * `noteUnderRule` for the day it went out. The queued note lives on
 * `invite.requested`; without this the person's history showed it beside a
 * request that went bare, and nobody could tell the note had been dropped.
 *
 * The same event then goes onto the person's CRM timeline (`copyRequestToCrm`),
 * so the conversation there starts where it really started.
 */
export async function recordSent({ account, run = null, outreach, by, overQuota = false, duringPause = false, allowance = null, sentNote = null }) {
  const name = outreach.person_name || "a contact";
  const event = await logEvent({
    accountId: account.id,
    runId: run?.id ?? null,
    level: overQuota || duringPause ? "warn" : "info",
    type: INVITE_SENT,
    // `duringPause` is its own sentence: a request that went out after a
    // warning had already paused the account is not an allowance overshoot,
    // and an operator reading "beyond today's allowance" could not tell that
    // the agent kept clicking Connect after LinkedIn's block page.
    message: duringPause
      ? `Connection request to ${name} sent after a warning paused the account — recorded, not counted toward the day`
      : overQuota
        ? `Connection request to ${name} recorded beyond today's allowance`
        : `Connection request to ${name} sent from ${outreach.sent_by}`,
    meta: {
      outreachId: outreach.id,
      crmContactId: outreach.crm_contact_id,
      accountId: account.id,
      by,
      overQuota,
      ...(duringPause ? { duringPause: true } : {}),
      ...(allowance ? { day: allowance.day, done: allowance.done, quota: allowance.quota } : {}),
      ...(sentNote ? { note: sentNote.note, noteDropped: sentNote.dropped } : {})
    }
  }, { returning: true });
  await copyRequestToCrm({ account, outreach, event });
}

/**
 * The other event a sent request is recorded under: a claim a person sent from
 * their own browser (`POST /leads/take`). Named here so the CRM copy below and
 * its retry read both the same way.
 */
export const OUTREACH_SENT = "outreach.sent";
export const REQUEST_EVENT_TYPES = [INVITE_SENT, OUTREACH_SENT];

/**
 * The line a sent request becomes on the contact's CRM timeline.
 *
 * The note is said when it is known — what the hand-off let through that day,
 * `meta.note` on the event, including "none" — and left out when it is not: a
 * request somebody sent by hand, or one an earlier run sent and died before
 * reporting, went with a note nobody here saw. "Without a note" would be a
 * guess written down as a fact.
 */
export function requestLine(event, name) {
  const meta = event?.meta || {};
  const by = event?.type === OUTREACH_SENT || meta.by === "seller" ? "вручну" : meta.by === "agent" ? "агентом" : "";
  const head = `LinkedIn · Запит на контакт надіслано з акаунта ${name}${by ? ` (${by})` : ""} · ${crmStamp(event?.created_at)}`;
  if (!Object.prototype.hasOwnProperty.call(meta, "note")) return clampContent(head);
  return clampContent(meta.note ? `${head}\nЗаписка: ${meta.note}` : `${head}\nБез записки.`);
}

/**
 * Put a sent request on the person's CRM timeline, once.
 *
 * Only a request that is actually out: `pending` is what both the agent's
 * `sent`/`already_pending` and a seller's own send leave behind, whereas
 * `already_connected` sent nothing at all. Keyed by the event that recorded
 * it, so a failure is owed to the next sync like any message; an event that
 * could not be written leaves nothing to key by, and the copy is skipped
 * rather than made un-retryable and un-deduplicable.
 */
export async function copyRequestToCrm({ account, outreach, event }) {
  if (!outreach?.crm_contact_id || outreach.status !== "pending" || !event?.id) return { written: 0, failed: 0 };
  return copyToCrm({
    accountId: account.id,
    contactId: outreach.crm_contact_id,
    entries: [{ eventId: event.id, content: requestLine(event, accountName(account)), storedAt: event.created_at }]
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

/**
 * How many waiting rows `invitesToSend` reads before it orders them. Far above
 * what an account holds: the folder never tops up past a day's allowance.
 */
const WAITING_READ_LIMIT = 200;

/**
 * Waiting invitations for this account, the ones a person picked first and
 * then the ones the folder added — each oldest first — each with the note
 * today's rule lets it carry.
 *
 * Picked first because the folder only fills what is left: a seller who
 * chooses somebody by hand on a day the folder already topped the account up
 * has chosen them over a stranger, and oldest-first alone would send
 * yesterday's leftover stranger ahead of them.
 *
 * Left out altogether: what `sendableToday` says is not today's — tried and
 * held today, parked after a block page, or from a folder whose campaign
 * starts on a later day.
 *
 * `noteRule` is the phase's `connectionNote` for the day they go out, and the
 * note is decided here, at the hand-off, rather than when the seller queued
 * it: see `noteUnderRule`. A note the rule does not allow is not sent and the
 * request goes bare — never held back, never shortened. The default is
 * "no notes", so a caller that forgets to ask for the rule sends nothing a
 * rule did not clear. `noteDropped` says why, for the agent's log.
 *
 * "No note" goes out as `""`, not `null`. The agent in the field was built
 * when `note` was always a string, and it was told the string is the text to
 * type; `null` would reach a `.trim()` or a text box as whatever that agent
 * makes of it. An empty string was already a value it could be handed.
 */
export async function invitesToSend(accountId, limit = MAX_INVITES_PER_RUN, {
  noteRule = false, notesAllowed = true, todayIso = today(), day = null, fromDayOf
} = {}) {
  if (!accountId || limit <= 0) return [];
  const waiting = await anty.from("wl_outreach").select(OUTREACH_COLUMNS)
    .eq("account_id", accountId).eq("status", WAITING_STATUS)
    .order("created_at", { ascending: true }).limit(WAITING_READ_LIMIT).rows();
  const facts = await waitingFacts(waiting, todayIso);
  const sendable = waiting.filter((row) => (notesAllowed || !row.note) && sendableToday(row, facts, { day, fromDayOf }));
  const fed = (row) => facts.fed.has(String(row.id));
  const rows = [...sendable.filter((row) => !fed(row)), ...sendable.filter(fed)].slice(0, limit);
  return rows.map((row) => {
    const { note, dropped } = noteUnderRule(row.note, noteRule);
    return {
      outreachId: row.id,
      crmContactId: row.crm_contact_id,
      name: row.person_name,
      company: row.person_company,
      position: row.person_position,
      linkedin: row.person_linkedin,
      note: note ?? "",
      noteDropped: dropped,
      noteExpected: Boolean(note)
    };
  });
}

/**
 * Sent invitations still waiting for an answer — the ones looked at longest ago.
 *
 * Oldest-first alone does not work. A `pending` row only leaves this set when
 * somebody accepts or the request disappears, so the twenty oldest are the
 * twenty least likely to move: with twenty-five outstanding, the same twenty
 * are re-read every day and the last five are never checked at all. So the
 * previous run's `seen` list is stepped over first, and the window fills from
 * the oldest only when there is room left. Everybody is looked at inside
 * ceil(n / 20) days instead of never.
 */
export async function invitesToCheck(accountId, limit = MAX_INVITE_CHECKS_PER_RUN) {
  if (!accountId || limit <= 0) return [];
  const all = await anty.from("wl_outreach").select(OUTREACH_COLUMNS)
    .eq("account_id", accountId).eq("status", "pending")
    .order("created_at", { ascending: true }).limit(500).rows();
  if (!all.length) return [];

  const lastCheck = await anty.from("wl_events").select("meta")
    .eq("account_id", accountId).eq("type", INVITE_CHECKED)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const seen = new Set(Array.isArray(lastCheck?.meta?.seen) ? lastCheck.meta.seen : []);

  const unseen = all.filter((row) => !seen.has(row.id));
  const rows = [...unseen, ...all.filter((row) => seen.has(row.id))].slice(0, limit);

  return rows.map((row) => ({
    outreachId: row.id,
    crmContactId: row.crm_contact_id,
    name: row.person_name,
    linkedin: row.person_linkedin,
    heldAt: row.created_at
  }));
}

/**
 * The most rows one read of an invitation's events asks for. Supabase answers
 * a thousand rows at most, whatever is asked, and drops the rest without a
 * word — so a read that could be longer asks for less and pages until a page
 * comes back short.
 */
const EVENT_PAGE = 500;

/**
 * Every event of these types that names one of these invitations, newest
 * first, all of it — paged, so no cap cuts it short. `since` and `outcome`
 * narrow the read to what the question needs; they are checked again here, so
 * an answer carrying more than was asked cannot decide anything.
 *
 * Newest first because that is the end the answers live at, and because a
 * page boundary that moves while the read runs — an event written in between
 * — then shows a row twice rather than skipping one.
 */
async function eventsNaming(ids, types, { since = null, outcome = null } = {}) {
  const found = [];
  const wanted = new Set(ids);
  for (let start = 0; start < ids.length; start += CONTACT_ID_BATCH) {
    const batch = ids.slice(start, start + CONTACT_ID_BATCH);
    for (let offset = 0; ; offset += EVENT_PAGE) {
      let query = anty.from("wl_events").select("type,meta,created_at")
        .in("type", types).in("meta->>outreachId", batch);
      if (outcome) query = query.eq("meta->>outcome", outcome);
      if (since) query = query.gte("created_at", since);
      const page = await query.order("created_at", { ascending: false }).order("id", { ascending: false })
        .offset(offset).limit(EVENT_PAGE).rows();
      found.push(...page);
      // Short: the end. Longer than asked: a server that ignored the limit
      // already sent everything.
      if (page.length !== EVENT_PAGE) break;
    }
  }
  return found.filter((event) => types.includes(event.type)
    && wanted.has(String(event.meta?.outreachId ?? ""))
    && (!outcome || event.meta?.outcome === outcome)
    && (!since || String(event.created_at || "") >= since));
}

/** Each row's newest event among these: `id → { type, at }`. */
function newestByRow(events) {
  const newest = new Map();
  for (const event of events) {
    const id = String(event.meta.outreachId);
    const at = String(event.created_at || "");
    if (!newest.has(id) || at > newest.get(id).at) newest.set(id, { type: event.type, at });
  }
  return newest;
}

/**
 * What decides whether each of these waiting invitations goes out today, read
 * from their own events:
 *
 * - `fed` — which campaign's folder added it (`fedInvites`);
 * - `resting` — the agent already tried it today and reported a held outcome.
 *   It stays held, as `INVITE_HELD_OUTCOMES` promises, but rests until
 *   tomorrow: counted as work the same day, one broken profile link kept its
 *   account due all morning — handed out every few minutes, failing, spending
 *   nothing, so the allowance that would have ended it never ran out;
 * - `parked` — LinkedIn answered it with a block page. `blocked` pauses the
 *   whole account (`pauseForWarning`), and if the page belonged to that
 *   profile — an email check on Connect, say — handing it out again pauses
 *   the account again, alone in the queue or not. So the first block parks it:
 *   never handed out, not counted as work, and shown to a person as needing
 *   them («Потребує уваги»). A block page reported while the account was
 *   already paused (`meta.duringPause`) parks nobody: it was about the account.
 *
 * Both since the row was last moved (`invite.reassigned`): a person moved to
 * a login LinkedIn has not flagged is a fresh attempt, and moving is how a
 * seller answers "needs attention". Queued again after a cancel, it is a new
 * row with no history at all.
 *
 * Each question reads only what it needs — today's failures and moves; block
 * pages, and then the moves of the rows that had one — never a row's whole
 * history. A row a seller picked that no profile will ever take fails once a
 * day for as long as it waits, and one unpaged read of everything was cut off
 * at Supabase's thousand rows with today's events the ones missing.
 */
export async function waitingFacts(rows = [], todayIso = today()) {
  const facts = { fed: new Map(), resting: new Set(), parked: new Set() };
  const ids = [...new Set(rows.map((row) => String(row.id)))];
  if (!ids.length) return facts;
  facts.fed = await fedInvites(ids);

  // Resting: today's newest failure-or-move is a failure. A move after it is
  // the fresh attempt; a move before it, or yesterday, changes nothing.
  const todays = await eventsNaming(ids, [INVITE_FAILED, INVITE_REASSIGNED], { since: `${todayIso}T00:00:00.000Z` });
  for (const [id, newest] of newestByRow(todays)) {
    if (newest.type === INVITE_FAILED) facts.resting.add(id);
  }

  // Parked: the newest block page is newer than the newest move. Not one
  // that came while the account was already paused: that page was about the
  // account (`reportHeld`).
  const blocks = newestByRow((await eventsNaming(ids, [INVITE_FAILED], { outcome: "blocked" }))
    .filter((event) => !event.meta?.duringPause));
  if (blocks.size) {
    const moves = newestByRow(await eventsNaming([...blocks.keys()], [INVITE_REASSIGNED]));
    for (const [id, block] of blocks) {
      if (!(moves.get(id)?.at >= block.at)) facts.parked.add(id);
    }
  }
  return facts;
}

/**
 * Whether one waiting invitation is today's to send — the one rule the
 * hand-off (`invitesToSend`), the scheduler and the folder's top-up
 * (`heldCounts`) all count by, so that an account is never woken for a row it
 * will not be handed, and a row nobody will send never takes the folder's room.
 *
 * Not today's: tried and held today (`resting`); parked after a block page
 * (`parked`); or fed by a campaign whose `fromDay` is still ahead of the
 * account's `day`. `fromDay` used to decide only when the folder *adds*
 * people, so a run stopped and started again sent the folder's leftovers on
 * days 4–6, which are for the account's own team.
 */
export function sendableToday(row, facts, { day = null, fromDayOf = () => DEFAULT_FROM_DAY } = {}) {
  const id = String(row.id);
  if (facts.resting.has(id)) return false;
  if (facts.parked.has(id)) return false;
  const fed = facts.fed.get(id);
  if (fed && Number.isFinite(day) && day < fromDayOf(fed.campaignId)) return false;
  return true;
}

/**
 * What each of these accounts is holding that nothing has sent yet: waiting
 * invitations, and campaign claims a person took to send by hand.
 *
 * One query for both, because the scheduler asks it on every poll and the
 * folder top-up asks it before every fill — and both have to count the same
 * two things, or the one wakes an account the other then gives nothing to.
 * Claims older than `claimsSince` are not counted: they belong to the pool
 * again, whether or not anything has deleted them yet. Nor are the waiting
 * invitations `sendableToday` says are not today's: `dayOf` is each account's
 * warm-up day, and `fromDayOf` the day each campaign starts feeding.
 */
export async function heldCounts(accountIds = [], { claimsSince = null, todayIso = today(), dayOf = new Map(), notesAllowedOf = new Map(), fromDayOf } = {}) {
  const waiting = new Map();
  const claimed = new Map();
  if (!accountIds.length) return { waiting, claimed };
  const rows = await anty.from("wl_outreach").select("id,account_id,status,created_at,note")
    .in("account_id", accountIds).in("status", [WAITING_STATUS, CLAIM_STATUS]).rows();
  const facts = await waitingFacts(rows.filter((row) => row.status === WAITING_STATUS), todayIso);
  for (const row of rows) {
    if (row.status === WAITING_STATUS) {
      if (row.note && notesAllowedOf.get(row.account_id) === false) continue;
      if (!sendableToday(row, facts, { day: dayOf.get(row.account_id), fromDayOf })) continue;
      waiting.set(row.account_id, (waiting.get(row.account_id) || 0) + 1);
    } else if (row.status === CLAIM_STATUS && (!claimsSince || String(row.created_at || "") >= claimsSince)) {
      claimed.set(row.account_id, (claimed.get(row.account_id) || 0) + 1);
    }
  }
  return { waiting, claimed };
}

/**
 * How many people the folder added to each of these accounts today — the
 * other half of the daily cap in `folderRoom`. Counted from the
 * `invite.requested` events the top-up writes, one per person, so a row the
 * folder added and then let go still counts: that is the whole point of it.
 */
export async function folderAddedToday(accountIds = [], todayIso = today()) {
  const added = new Map();
  if (!accountIds.length) return added;
  const rows = await anty.from("wl_events").select("account_id")
    .in("account_id", accountIds).eq("type", INVITE_REQUESTED).eq("meta->>source", FOLDER_SOURCE)
    .gte("created_at", `${todayIso}T00:00:00.000Z`).rows();
  for (const row of rows) added.set(row.account_id, (added.get(row.account_id) || 0) + 1);
  return added;
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
  const foreign = [];

  // Which of the reported rows this account actually holds. Without it a stale
  // or misattributed results array moved somebody else's rows — to `withdrawn`,
  // which has no exit — filed the event under the wrong account's log, and
  // dropped that person out of every query that would have surfaced them again.
  const ids = [...new Set(results.map((result) => String(result?.outreachId || "")).filter(Boolean))];
  const ours = new Set(ids.length
    ? (await anty.from("wl_outreach").select("id").eq("account_id", account.id).in("id", ids).rows()).map((row) => row.id)
    : []);

  for (const result of results) {
    if (!result?.outreachId) continue;
    if (!ours.has(String(result.outreachId))) {
      foreign.push(String(result.outreachId));
      continue;
    }
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
    // `refused` and `foreign` are the interesting columns when something looks
    // wrong: the first means the check tried a move the table would not make —
    // usually the inbox already recorded a real reply — and the second means
    // the agent reported rows this account does not hold, which is a bug in
    // whatever built that list and should be visible rather than swallowed.
    meta: {
      checked: results.length, accepted, withdrawn,
      // The rows this check actually looked at, so the next one can move past
      // them: without it the same twenty oldest are re-checked every day and
      // the twenty-first person is never looked at again.
      seen: [...ours],
      ...(refused.length ? { refused } : {}),
      ...(foreign.length ? { foreign } : {})
    }
  });

  return { checked: results.length, accepted, withdrawn, refused, foreign };
}

/**
 * An invitation the browser could not send, and why, with the answer the
 * report was given.
 *
 * This one event is four things, which is why it is a plain insert that
 * throws rather than `logEvent`, which swallows a failed write: the reason on
 * the person's history; the rest until tomorrow (`waitingFacts`); for a
 * `blocked` row a seller picked, the park — a park that quietly did not happen
 * is the same profile opening the account's next session; and the answer a
 * retried report gets back (`heldRetryAnswer`). `leaseId` is the session it
 * came from, which is what tells a retry from a new attempt. `duringPause`
 * marks a report that came while the account was already paused: about the
 * account, so it parks nobody (`waitingFacts`).
 */
export async function recordFailed({ account, run = null, outreach, outcome, leaseId = null, answer = null, duringPause = false }) {
  const rows = await anty.from("wl_events").insert({
    account_id: account.id,
    run_id: run?.id ?? null,
    level: "warn",
    type: INVITE_FAILED,
    message: duringPause
      ? `Could not invite ${outreach.person_name || "a contact"}: ${outcome}, after a warning had paused the account — not held against them`
      : `Could not invite ${outreach.person_name || "a contact"}: ${outcome}`,
    meta: {
      outreachId: outreach.id, crmContactId: outreach.crm_contact_id, outcome, leaseId, answer,
      ...(duringPause ? { duringPause: true } : {})
    }
  }).select("id,type,meta,created_at").rows();
  return rows[0] ?? null;
}

/**
 * How long a held report counts as the same report when there is no session
 * to tell by. The agent retries a report twice, three seconds apart; ten
 * minutes covers that with room. The next session of the account does not
 * always come later than that — after a lease that ran out with no report it
 * can start at once — but it is not handed this row again today: a row
 * reported held rests until tomorrow, is parked, or was let go.
 */
export const HELD_RETRY_MINUTES = 10;

/**
 * The answer to give a held report that has been given already, or null when
 * this one is new.
 *
 * The agent retries a report whose answer it did not get — a dropped socket
 * after the server had done everything. Handled again, a retry wrote a second
 * `invite.failed`, and for a row the first report had let go it found nothing
 * and answered 404 with a false "cancelled mid-send" on the log. So:
 *
 * - The row is still there: the same outcome, from the same account, in the
 *   same lease — or within `HELD_RETRY_MINUTES` when either report has no
 *   lease to tell by — is the same report.
 * - The row is gone (`gone`): a held report released it (`answer.released`),
 *   so any held report about it now is that report again. No clock: nothing
 *   else could be asking about a row that no longer exists.
 *
 * Read newest first and only a few: this invitation's last reports are all
 * the question needs.
 */
export async function heldRetryAnswer({ accountId, outreachId, outcome, leaseId = null, gone = false, nowMs = Date.now() }) {
  const reports = (await anty.from("wl_events").select("account_id,type,meta,created_at")
    .eq("type", INVITE_FAILED).eq("meta->>outreachId", String(outreachId))
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(10).rows())
    .filter((event) => event.type === INVITE_FAILED && event.account_id === accountId && event.meta?.answer)
    .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
  if (gone) return reports.find((event) => event.meta.answer.released === true)?.meta.answer ?? null;

  const last = reports[0];
  if (!last || last.meta.outcome !== outcome) return null;
  if (last.meta.leaseId && leaseId) return last.meta.leaseId === leaseId ? last.meta.answer : null;
  const at = Date.parse(last.created_at);
  return Number.isFinite(at) && nowMs - at <= HELD_RETRY_MINUTES * 60_000 ? last.meta.answer : null;
}

/**
 * Every invite event for one person, oldest first — the invitation's own
 * story, and the folder letting them go (`FEED_SKIPPED`), which is the line
 * that explains why a person the folder once queued is not queued any more.
 */
export async function inviteEvents(crmContactId, limit = 50) {
  if (!crmContactId) return [];
  const rows = await anty.from("wl_events")
    .select("id,account_id,type,message,meta,level,created_at")
    .in("type", PERSON_EVENT_TYPES)
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
 *
 * `parked` is passed in, from `waitingFacts` — the same reads the hand-off
 * decides by. `events` is a person's history, oldest first and capped, and a
 * block page after the fiftieth event was not in it.
 */
export function describeInvite(row, events = [], { checkedAt = null, parked = false } = {}) {
  if (!row) return null;
  // This row's own request, not the person's first: a person the folder queued
  // and let go, and a seller queued again by hand, has two — and the first
  // one said "from the folder" about an invitation nobody's folder picked.
  const mine = events.filter((event) => String(event.meta?.outreachId ?? "") === String(row.id));
  // An event that names no row at all can only be this one's; one that names
  // another row belongs to an invitation that is gone.
  const requested = mine.filter((event) => event.type === INVITE_REQUESTED).at(-1)
    ?? events.find((event) => event.type === INVITE_REQUESTED && !event.meta?.outreachId) ?? null;
  const sent = events.filter((event) => event.type === INVITE_SENT).at(-1);
  const fromFolder = requested?.meta?.source === FOLDER_SOURCE;
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
    // Nobody picked this person: a campaign's folder filled the allowance.
    fromCampaign: fromFolder ? { id: requested.meta.campaignId ?? null, name: requested.meta.campaignName ?? null } : null,
    sentAt: sent?.at || null,
    sentByWhom: sent?.meta?.by || "",
    overQuota: Boolean(sent?.meta?.overQuota),
    // Sent after a warning had already paused the account: on LinkedIn, and
    // not in the day's count.
    duringPause: Boolean(sent?.meta?.duringPause),
    // LinkedIn put a block page in front of this request since it was last
    // moved: not handed to the agent again until a person moves it to
    // another account or cancels it.
    parked: row.status === WAITING_STATUS && Boolean(parked),
    // Set when the phase's rule sent it bare: `note` above is what was queued,
    // and without this a screen showed it as though it had gone.
    noteDropped: sent?.meta?.noteDropped || null,
    // Passed in rather than found among this person's events: a check is one
    // pass over an account's whole board, so its event carries no contact and
    // could never match here. Read from the events, this was null forever and
    // the line on the card never rendered.
    lastCheckedAt: checkedAt,
    respondedAt: row.responded_at,
    waitingDays: row.status === WAITING_STATUS ? daysSince(row.created_at) : 0
  };
}

function daysSince(iso) {
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 86_400_000));
}
