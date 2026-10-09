import { anty } from "./db.mjs";
import { linkedinSlug } from "./outreach.mjs";
import { ACCEPTED_STATUS } from "./invites.mjs";
import { MESSAGE_TYPES } from "./inbox.mjs";
import { cleanReply, firstThreadKey, repliesOf } from "./outbox.mjs";

/**
 * The first message to somebody who accepted.
 *
 * This is the gap the whole product exists to close. Until now the warm-up sent
 * bare invitations and stopped: a person who accepted became `accepted` — "go
 * write to them" — and nobody did, because writing meant opening a contact card,
 * pressing «Згенерувати», copying the text and opening LinkedIn by hand, one
 * person at a time.
 *
 * Now the model writes it, the Home screen shows it under the person, and one
 * press puts it in the account's queue (`outbox.mjs`, kind `first`), which the
 * account sends in its own next session from the person's profile. A person
 * approves every first message: what goes out under somebody's name to a
 * stranger is not something the model decides alone.
 *
 * Who is waiting for one: an `accepted` row (accepted and silent — `connected`
 * already means they wrote) that has no first message sent or waiting, was not
 * put aside («Пропустити»), and with whom the account has no stored conversation
 * at all — somebody already talking does not need an opening line.
 *
 * Drafts and put-asides are `wl_events` rows, never rewritten, newest first.
 */

export const FIRST_DRAFT = "first.draft";
export const FIRST_DISMISSED = "first.dismissed";
export const FIRST_TYPES = [FIRST_DRAFT, FIRST_DISMISSED];

/** A draft is somebody's private words to a stranger; the audit log does not list it. */
export const FIRST_AUDIT_HIDDEN = [FIRST_DRAFT];

/** How many people the Home screen lists at once. More is a backlog, said as a number. */
export const TO_WRITE_LIMIT = 30;

/** What a first message may be: the LinkedIn channel's own rule for it is 40–90 words. */
export const FIRST_LIMIT = 1200;

const ROW_COLUMNS = "id,account_id,crm_contact_id,person_name,person_company,person_position,person_linkedin,person_country,status,created_at";

/** Accepted and silent, on these accounts (or every account), newest invitation first. */
export async function acceptedRows(accountIds = null) {
  let query = anty.from("wl_outreach").select(ROW_COLUMNS).eq("status", ACCEPTED_STATUS);
  if (accountIds) {
    if (!accountIds.length) return [];
    query = query.in("account_id", accountIds);
  }
  return query.order("created_at", { ascending: false }).limit(2000).rows();
}

/** The newest draft for each of these rows, and which were put aside. */
export async function firstMarks(outreachIds) {
  const drafts = new Map();
  const dismissed = new Set();
  if (!outreachIds.length) return { drafts, dismissed };
  const rows = await anty.from("wl_events").select("account_id,type,meta,created_at")
    .in("type", FIRST_TYPES).in("meta->>outreachId", outreachIds)
    .order("created_at", { ascending: false }).limit(4000).rows();
  for (const row of rows) {
    const id = String(row.meta?.outreachId ?? "");
    if (!id) continue;
    if (row.type === FIRST_DISMISSED) dismissed.add(id);
    else if (!drafts.has(id)) {
      drafts.set(id, {
        text: String(row.meta?.text ?? ""),
        productId: row.meta?.productId ?? null,
        productName: row.meta?.productName ?? null,
        language: row.meta?.language ?? null,
        model: row.meta?.model ?? null,
        generatedAt: row.created_at
      });
    }
  }
  return { drafts, dismissed };
}

/**
 * The people each account already has a conversation with, as `account|slug`.
 * Somebody who wrote, or whom we wrote to by hand in LinkedIn, is talking
 * already; an opening line to them would read as a bot that did not look.
 */
export async function talkingTo(accountIds) {
  const seen = new Set();
  if (!accountIds.length) return seen;
  const rows = await anty.from("wl_events").select("account_id,meta")
    .in("type", MESSAGE_TYPES).in("account_id", accountIds)
    .order("created_at", { ascending: false }).limit(4000).rows();
  for (const row of rows) {
    const slug = linkedinSlug(row.meta?.participant?.slug);
    if (slug) seen.add(`${row.account_id}|${slug}`);
  }
  return seen;
}

/** The first messages already asked of each account, by outreach id: the newest one decides. */
async function queuedFirsts(accountIds) {
  const found = new Map();
  for (const accountId of accountIds) {
    for (const reply of await repliesOf(accountId)) {
      if (reply.kind !== "first" || !reply.outreachId || reply.state === "cancelled") continue;
      const held = found.get(reply.outreachId);
      if (!held || String(reply.queuedAt) > String(held.queuedAt)) found.set(reply.outreachId, reply);
    }
  }
  return found;
}

/** A row as the screen shows it: who, where from, through which account. */
export function personOf(row) {
  return {
    outreachId: String(row.id),
    accountId: row.account_id,
    crmContactId: row.crm_contact_id ? String(row.crm_contact_id) : null,
    name: row.person_name || "",
    company: row.person_company || "",
    position: row.person_position || "",
    country: row.person_country || "",
    linkedin: row.person_linkedin || "",
    invitedAt: row.created_at
  };
}

/**
 * Who is waiting for a first message, and where each one stands.
 *
 * `toWrite` — accepted, silent, nothing sent: each with its draft (or `null`,
 * not written yet) and, when one is queued or did not go, that reply. People
 * whose first message went out leave the list; they are counted in `written`.
 */
export async function firstMessageBoard(accountIds) {
  const rows = await acceptedRows(accountIds);
  const ids = [...new Set(rows.map((row) => row.account_id))];
  const [{ drafts, dismissed }, talking, queued] = await Promise.all([
    firstMarks(rows.map((row) => String(row.id))),
    talkingTo(ids),
    queuedFirsts(accountIds ?? ids)
  ]);

  const waiting = [];
  let written = 0;
  for (const row of rows) {
    const id = String(row.id);
    const reply = queued.get(id) ?? null;
    if (reply?.state === "sent") { written += 1; continue; }
    if (dismissed.has(id)) continue;
    const slug = linkedinSlug(row.person_linkedin);
    if (!reply && slug && talking.has(`${row.account_id}|${slug}`)) continue;
    waiting.push({ ...personOf(row), draft: drafts.get(id) ?? null, reply });
  }
  // Sent firsts on rows that have since become `connected` (they answered) are
  // counted too: that is the message that worked.
  for (const reply of queued.values()) {
    if (reply.state === "sent" && !rows.some((row) => String(row.id) === reply.outreachId)) written += 1;
  }
  return { toWrite: waiting.slice(0, TO_WRITE_LIMIT), total: waiting.length, written };
}

/** One accepted row of this workspace, or null — anything else is not somebody to write a first message to. */
export async function acceptedRow(outreachId) {
  const row = await anty.from("wl_outreach").select(ROW_COLUMNS).eq("id", String(outreachId)).maybeSingle();
  return row && row.status === ACCEPTED_STATUS ? row : null;
}

export async function saveDraft(row, draft) {
  const text = cleanReply(draft.text);
  await anty.from("wl_events").insert({
    account_id: row.account_id,
    level: "info",
    type: FIRST_DRAFT,
    message: "First message drafted",
    meta: {
      outreachId: String(row.id), text,
      productId: draft.productId ?? null, productName: draft.productName ?? null,
      language: draft.language ?? null, model: draft.model ?? null
    }
  }).rows();
  return { text, productId: draft.productId ?? null, productName: draft.productName ?? null,
    language: draft.language ?? null, model: draft.model ?? null, generatedAt: new Date().toISOString() };
}

export async function dismissFirst(row) {
  await anty.from("wl_events").insert({
    account_id: row.account_id, level: "info", type: FIRST_DISMISSED,
    message: `First message put aside — ${row.person_name || "a contact"}`,
    meta: { outreachId: String(row.id) }
  }).rows();
}

export { firstThreadKey };
