import { createHash } from "node:crypto";

import { anty, CONTACT_ID_BATCH, leadsByLinkedin } from "./db.mjs";
import { linkedinSlug } from "./outreach.mjs";
import { REQUEST_EVENT_TYPES, moveStatus, requestLine } from "./invites.mjs";
import {
  CRM_COPIED, CRM_FAILED, accountName, clampContent, copyToCrm, crmStamp, oneCopyAtATime, outstandingCopies, sourceEvents
} from "./activities.mjs";
import { OUTBOX_AUDIT_HIDDEN } from "./outbox.mjs";
import { adoptable, adoptionEnabled, createContact, hasProfileWords, once } from "./people.mjs";

/**
 * The inbox: threads, messages, what has been read, and when an account was
 * last looked at.
 *
 * **Everything here is a compromise and it is written down as one.** Threads
 * and messages want their own tables; they cannot have them, because there is
 * no Postgres password for the Anty database and no `exec_sql` RPC, so no
 * migration can run. Both were verified, not assumed. So a message is a
 * `wl_events` row of type `message.in` or `message.out` with its structure in
 * `meta`.
 *
 * What that costs:
 *
 * - No unique index on the external id, so duplicate suppression is a read
 *   before a write rather than a constraint (see `storedExternalIds`).
 * - No index on the thread key, so listing threads reads message events and
 *   groups them in memory. Fine at a few thousand, wrong at a hundred thousand.
 * - The audit log and the message log share a table, so a reader of either has
 *   to filter by type.
 *
 * **This module is the containment.** Every read and write of a message, a
 * thread, a read mark or a sync mark happens here and nowhere else — no caller
 * names `wl_events` for this purpose. When a password arrives, moving to real
 * tables is this file and no call sites.
 */

export const MESSAGE_IN = "message.in";
export const MESSAGE_OUT = "message.out";
export const MESSAGE_TYPES = [MESSAGE_IN, MESSAGE_OUT];
export const SYNCED_TYPE = "inbox.synced";
export const READ_TYPE = "inbox.read";

/**
 * A thread tied to a CRM contact after the fact: written when somebody who was
 * only a name on stored messages is added to the CRM (or found there), so the
 * thread can open that contact. Rows are never rewritten, so the tie is its own
 * row, like a read mark — and the newest tie for a thread is the one that counts.
 */
export const CONTACT_TYPE = "inbox.contact";

/**
 * What the agent writes as the body of something it read in a conversation that
 * had no text and no attachment: an avatar, a profile card, a notice. It is not
 * a message, and every message that carries it is left out of the inbox — it
 * does not make a conversation, does not make one unread, is not the last thing
 * said, and is not copied to the CRM. (An attachment is `[attachment]` and is a
 * message.)
 *
 * Left out when read, not deleted: rows are not rewritten here, and the ones
 * stored before the agent stopped sending them are still in the table, which
 * is what filling the inbox with «Переглянути профіль …» was.
 */
export const SERVICE_CARD_BODY = "[no text]";

/**
 * Whether this stored or arriving message is a card and not something said.
 *
 * Two shapes, both written by the agent as it was. A row with neither text nor
 * media is `[no text]`. But the agent also counted any picture as media, so an
 * avatar-only row — the same card — was stored as `[attachment]`, and nothing in
 * its body tells it from a file. What does is who it is attributed to: a real
 * file is stored under its sender's name, and a picture of somebody's avatar
 * under the sentence LinkedIn writes about the avatar («Переглянути профіль
 * Sinan», `hasProfileWords`). `participant` is that name, and without it an
 * `[attachment]` is taken for what it says.
 *
 * The two ways it can be wrong, both small and both from old data: an avatar row
 * inside a conversation whose participant has a real name stays an
 * `[attachment]` (nothing distinguishes it from a file), and a real file in a
 * conversation whose participant the agent read as that sentence — a card came
 * first — is left out with the cards. New reads cannot do either: the agent no
 * longer sends cards, and names the person, not the sentence.
 */
export function isServiceCard(body, participant = null) {
  if (typeof body !== "string") return false;
  const text = body.trim().toLowerCase();
  if (text === SERVICE_CARD_BODY) return true;
  return text === "[attachment]" && hasProfileWords(participant?.name);
}

/**
 * What the audit log must not show, named here so no other file has to know
 * which event types are really messages.
 *
 * The two share a table, so a reader of either has to filter — and the audit
 * log is the reader with something to lose. A message row carries somebody's
 * private reply in `meta.body`, and eight "Reply from Jane" lines would push
 * the day's actual history off a panel that only shows eight. `inbox.read` is
 * pure screen state with nothing to audit, and `crm.copied` is bookkeeping —
 * one per synced thread, every morning. Its failure, `inbox.crm_failed`, stays
 * visible: that one somebody may need to act on.
 *
 * `inbox.synced` deliberately stays visible: a run of zeros is the one signal
 * that the agent's selectors have rotted, and hiding it would hide exactly the
 * failure this phase is most likely to have.
 */
export const AUDIT_HIDDEN_TYPES = [MESSAGE_IN, MESSAGE_OUT, READ_TYPE, CRM_COPIED, CONTACT_TYPE, ...OUTBOX_AUDIT_HIDDEN];

/**
 * Which of these accounts has already been read today.
 *
 * Here rather than in the scheduler because `inbox.synced` is this module's
 * row, and the scheduler has no business knowing which type string means "the
 * inbox was looked at".
 */
export async function syncedTodayAccounts(accountIds = [], todayIso) {
  const seen = new Set();
  if (!accountIds.length || !todayIso) return seen;
  const rows = await anty.from("wl_events").select("account_id")
    .in("account_id", accountIds).eq("type", SYNCED_TYPE)
    .gte("created_at", `${todayIso}T00:00:00.000Z`).rows();
  for (const row of rows) seen.add(row.account_id);
  return seen;
}

/** A body is kept to this many characters, marker included. */
export const BODY_LIMIT = 4000;
export const TRUNCATION_MARKER = "… [truncated]";

/**
 * How many message events one listing reads.
 *
 * Grouping happens in memory because there is no index to group by, so this is
 * the ceiling that keeps a panel painting. It is a limit on events rather than
 * on threads: twenty busy conversations can outweigh two hundred quiet ones.
 */
export const LISTING_LIMIT = 4000;

/**
 * How many conversations the agent should read in one run.
 *
 * Published by the portal rather than compiled into the agent, so the ceiling
 * has one home. Reading a whole history every day is slow, and — more to the
 * point — it is a pattern: an account that opens two hundred conversations at
 * 09:00 every morning is not behaving like a person.
 */
export const MAX_THREADS_PER_RUN = 20;

/**
 * A thread is identified by its account and its key together. LinkedIn's
 * conversation id is stable per account, not across them, so the account has to
 * be part of the identity or two logins talking to the same person collapse
 * into one conversation.
 */
function threadId(accountId, threadKey) {
  return JSON.stringify([accountId, threadKey]);
}

// -- shaping what arrives ---------------------------------------------------

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * A body, kept whole up to the limit and truncated with a marker past it.
 *
 * Truncated rather than rejected: a long message is still worth having, and a
 * 400 on the tenth message of a thread loses the other nine as well.
 */
export function clampBody(value) {
  const body = typeof value === "string" ? value : "";
  if (body.length <= BODY_LIMIT) return { body, truncated: false };
  return { body: body.slice(0, BODY_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER, truncated: true };
}

// The slug key lives with the outreach row it is compared against, so the
// folder walk and the invitations can use it without importing the inbox.
export { linkedinSlug };

/**
 * What LinkedIn prints where a name should be when it will not tell you the
 * name: a restricted or out-of-network profile renders "LinkedIn Member", and a
 * deleted one renders some variant of the same idea.
 *
 * These are not names and must not be stored as though they were. Folded into
 * the one sentinel — `UNNAMED` — so there is a single value a screen has to
 * know how to render and a single value the matcher has to refuse. Ten threads
 * all called "LinkedIn Member" are ten different people, and treating that
 * string as a name would file every one of them against the same outreach row.
 */
const NON_NAMES = new Set(["unknown", "linkedin member", "linkedin user", "deleted member", "deleted user", "member"]);

export const UNNAMED = "Unknown";

/**
 * A name with its whitespace collapsed to single spaces.
 *
 * The agent reads names out of a DOM, and a name split across two elements
 * arrives carrying the newline and the indentation between them — so
 * `"LinkedIn\n      Member"` is a likelier sight in production than the tidy
 * `"LinkedIn Member"`. Trimming the ends is not enough: the ragged form would
 * skip the placeholder fold below, stay a "name", and go back into
 * `matchOutreachRow` as an exact-name candidate — the collision that fold
 * exists to prevent, walked around by a line break.
 *
 * Collapsing cannot swallow a real person, because every comparison downstream
 * is still whole-string: "Linda  Memberly" becomes "Linda Memberly" and is
 * still nobody's placeholder.
 */
function cleanName(value, max = 200) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * The person on the other side. A missing slug or headline is normal and is
 * stored as null: a group thread has no `/in/` link, and a headline is a thing
 * LinkedIn sometimes simply does not render.
 *
 * The name and the headline are stored collapsed. A body is not — newlines are
 * the message there, whereas in a name they are only ever an artefact of how
 * the page was built.
 *
 * `memberProfile` keeps what the slug alone forgets: whether the link was a
 * member's `/in/` profile — or a bare slug, which is how the agent hands one
 * over. `/pub/jane-doe/1a/2b/3c` becomes the slug "3c", and only this says it
 * never named anybody (`matchOutreachRow`). A participant stored before the
 * flag has only its slug, and reads as it did then.
 */
export function normalizeParticipant(raw) {
  const name = cleanName(raw?.name);
  const slug = linkedinSlug(raw?.slug) || null;
  return {
    name: !name || NON_NAMES.has(name.toLowerCase()) ? UNNAMED : name,
    slug,
    headline: cleanName(raw?.headline, 300) || null,
    memberProfile: Boolean(slug) && raw?.memberProfile !== false && memberLink(raw.slug)
  };
}

/** An `/in/` link, or a bare slug: the shapes that name a member's profile. */
function memberLink(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return Boolean(raw) && (!raw.includes("/") || /(?:^|\/)in\//i.test(raw));
}

/**
 * A stable id for a message LinkedIn gave no id to.
 *
 * The DOM exposes no per-message id, so the agent hashes what it can see. That
 * is done here as well as there, over the values as they were *sent* — a
 * message posted twice hashes the same both times, which is the whole reason
 * duplicate suppression suppresses anything.
 */
export function externalIdFor({ threadKey, direction, body, sentAt }) {
  return createHash("sha1")
    .update(`${threadKey}|${direction}|${sentAt || ""}|${String(body || "").slice(0, 200)}`)
    .digest("hex");
}

/** No LinkedIn message is older than LinkedIn. */
const LINKEDIN_LAUNCH_MS = Date.parse("2003-05-01T00:00:00.000Z");

/**
 * Whether a parsed time is a reading of a clock rather than an accident of
 * the parser.
 *
 * `Date.parse` accepts LinkedIn's "Sep 20" and answers the year 2001. Taken as
 * given, that put a message from last week twenty-five years back — first in
 * its thread, and on the contact's CRM timeline with a date nobody could
 * explain. A label with no year is a label, so it is treated like "2h": the
 * time we learned of it, with the label kept. A day ahead of the moment it
 * arrived is allowed for clocks and zones; more than that is the same accident
 * the other way round.
 */
export function plausibleSentAt(parsedMs, receivedAt) {
  if (!Number.isFinite(parsedMs) || parsedMs < LINKEDIN_LAUNCH_MS) return false;
  const received = Date.parse(receivedAt || "");
  return !Number.isFinite(received) || parsedMs <= received + 86_400_000;
}

/**
 * One message as it will be stored, or null when there is nothing to store.
 *
 * Lenient by design, and the leniency is the contract the agent codes against:
 * a body it cannot read is the only fatal thing. A time it cannot parse — and
 * LinkedIn renders "2h" far more often than a datetime — becomes the time we
 * learned of the message, with the original kept beside it so nobody later
 * mistakes a substitute for a reading.
 */
export function normalizeMessage(raw, { threadKey, receivedAt }) {
  const { body, truncated } = clampBody(raw?.body);
  if (!body.trim()) return null;

  const direction = raw?.direction === "out" ? "out" : raw?.direction === "in" ? "in" : null;
  if (!direction) return null;

  const sentAtRaw = text(raw?.sentAt, 80);
  const parsed = sentAtRaw ? Date.parse(sentAtRaw) : NaN;
  const dated = plausibleSentAt(parsed, receivedAt);
  const sentAt = dated ? new Date(parsed).toISOString() : receivedAt;

  const externalId = text(raw?.externalId, 200) || externalIdFor({ threadKey, direction, body, sentAt: sentAtRaw });

  return {
    externalId,
    direction,
    body,
    sentAt,
    truncated,
    // Said out loud rather than left to be inferred from a timestamp that looks
    // like the sync: a screen showing "sent 14:02" when nobody read a clock is
    // lying, and the raw label is what a person would have to check against.
    sentAtGiven: dated,
    sentAtRaw: dated ? null : sentAtRaw || null,
    // Whether this time may put the thread in order (`conversationOrder`):
    // only an ISO datetime, as `<time datetime>` carries it.
    sentAtIso: dated && ISO_DATETIME.test(sentAtRaw)
  };
}

/**
 * An ISO-8601 datetime — a date and a time of day — which is what a real
 * reading of LinkedIn's clock looks like on the wire. Anything else the parser
 * takes is a label, a year in it or not: "12/9/2025" is 12 September in a
 * day-first locale and 9 December to `Date.parse`, and "Sep 20, 2025" is
 * whatever the agent's page happened to print.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * The whole `inbox.thread` payload, checked once so the route does not have to.
 *
 * An empty `messages` is accepted, not refused: a conversation the agent opened
 * and could not read is a fact worth reporting, and turning it into a 400 would
 * fail a run over a thread that was merely awkward.
 */
export function normalizeThreadInput(body) {
  const threadKey = text(body?.threadKey, 200);
  if (!threadKey) return { error: "A thread needs a threadKey" };
  if (body?.messages !== undefined && !Array.isArray(body.messages)) {
    return { error: "messages must be an array" };
  }

  const receivedAt = new Date().toISOString();
  const incoming = Array.isArray(body?.messages) ? body.messages : [];
  const messages = [];
  let invalid = 0;
  let undated = 0;
  let cards = 0;

  for (const raw of incoming) {
    // A card an older agent still sends: not a message, and not invalid either.
    if (isServiceCard(raw?.body, body?.participant)) { cards += 1; continue; }
    const message = normalizeMessage(raw, { threadKey, receivedAt });
    // One unreadable message must not cost the nineteen around it.
    if (!message) { invalid += 1; continue; }
    if (!message.sentAtGiven) undated += 1;
    messages.push(message);
  }

  return {
    threadKey,
    participant: normalizeParticipant(body?.participant),
    messages: conversationOrder(messages),
    invalid,
    undated,
    cards,
    receivedAt
  };
}

/**
 * The messages of one thread in the order they were posted, each with its
 * place in it.
 *
 * The CRM keeps the conversation in the order its lines arrive, so the order
 * they are written in is the only order it has — and most messages carry only
 * a label, which is stored as the time we read them: every one of them the
 * same moment. The agent is asked to post a thread as LinkedIn shows it,
 * oldest first, and the order it posts is taken as the truth.
 *
 * Only real times can overrule it — ISO datetimes (`sentAtIso`), nothing
 * else: a payload whose ISO times run backwards more often than forwards was
 * posted newest first and is turned round, and when every message has one
 * they are sorted by it. A label never turns a thread, a year in it or not.
 * "3:00 PM" then "10:00 AM" is yesterday afternoon and this morning as often
 * as it is the wrong way round, "12/9/2025" then "3/10/2025" is September then
 * October to one locale and December then March to `Date.parse`, and nothing
 * in a label says which — guessing reversed threads the agent had posted
 * correctly.
 *
 * `position` is kept on the stored row: a later copy of an older line has to
 * know where it stood among the rows stored with it.
 */
export function conversationOrder(messages) {
  let forwards = 0;
  let backwards = 0;
  let previous = NaN;
  for (const message of messages) {
    if (!message.sentAtIso) continue;
    const at = Date.parse(message.sentAt);
    if (!Number.isFinite(at)) continue;
    if (Number.isFinite(previous) && at > previous) forwards += 1;
    if (Number.isFinite(previous) && at < previous) backwards += 1;
    previous = at;
  }
  const ordered = backwards > forwards ? messages.slice().reverse() : messages.slice();
  if (ordered.length && ordered.every((message) => message.sentAtIso)) {
    ordered.sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
  }
  return ordered.map((message, position) => ({ ...message, position }));
}

// -- duplicate suppression --------------------------------------------------

/** How many external ids one duplicate check asks about: each can be a 200-character URN. */
const EXTERNAL_ID_BATCH = 40;

/**
 * Which of these external ids this account has already stored.
 *
 * **There is no unique index on the external id and there cannot be one** — no
 * migration can run against this database. Nobody reading this later should
 * assume a constraint is catching what this function misses: the suppression is
 * this read and only this read. It is safe today because one agent syncs one
 * account at a time; two agents on one account would race it, and the fix for
 * that is real tables, not a bigger read.
 *
 * Scoped to the account rather than the thread, because a message already
 * stored for this account is a duplicate however it arrives — a conversation
 * that comes back under a new key is still the same conversation.
 */
export async function storedExternalIds(accountId, externalIds) {
  const wanted = [...new Set(externalIds)];
  const found = new Set();
  // LinkedIn's own ids are URNs — `urn:li:msg_message:(urn:li:fsd_profile:…,2-…)`
  // — with a comma and brackets in them; `in` quotes them (`listValue`). They
  // are long, too, so a thread's worth goes in batches rather than one URL.
  for (let start = 0; start < wanted.length; start += EXTERNAL_ID_BATCH) {
    const rows = await anty.from("wl_events").select("meta")
      .eq("account_id", accountId).in("type", MESSAGE_TYPES)
      .in("meta->>externalId", wanted.slice(start, start + EXTERNAL_ID_BATCH))
      .rows();
    for (const row of rows) if (row.meta?.externalId) found.add(row.meta.externalId);
  }
  return found;
}

/** Split what arrived into what is new and what has been seen before. */
export function splitStored(messages, seen) {
  const fresh = [];
  const skipped = [];
  // A payload repeating an id inside itself is deduplicated too: the agent
  // posting one message twice in one array is the same mistake as twice in two
  // runs, and the read above cannot see the second copy.
  const taken = new Set(seen);
  for (const message of messages) {
    if (taken.has(message.externalId)) { skipped.push(message); continue; }
    taken.add(message.externalId);
    fresh.push(message);
  }
  return { fresh, skipped };
}

/**
 * What this account has stored in one thread, oldest first: the rows a repeat
 * is looked for among, and the ones still waiting to learn who they were to.
 */
export async function storedInThread(accountId, threadKey) {
  const rows = await anty.from("wl_events").select("id,type,meta,created_at")
    .eq("account_id", accountId).in("type", MESSAGE_TYPES).eq("meta->>threadKey", threadKey)
    .order("created_at", { ascending: true }).limit(LISTING_LIMIT).rows();
  return rows.filter((row) => row.meta);
}

/**
 * The same message, come back under a new id.
 *
 * The suppression above is only as stable as the id, and an id the DOM does
 * not give has to be made from what is on screen — where the time is a label
 * that ages: "10:42" today, "Sep 25" tomorrow. A thread is read again whenever
 * somebody writes in it, and every older message in it then arrives with a new
 * hash: stored twice and, now that every message goes onto the person's CRM
 * contact, written there twice — the whole conversation again each time they
 * answer.
 *
 * So a message is also a repeat of a row this thread already holds when it
 * went the same way with the same words and the two times cannot tell them
 * apart: equal, or at least one of them a label rather than a clock reading.
 * One for one: a stored row answers for one arriving message only, and a row
 * whose own id was found among what arrived (`answered`, the ids the check by
 * id matched) has answered already. Two "Дякую" in one thread stay two as long
 * as both are in what the agent read.
 *
 * A stored time is a label when it says so, and also when it cannot be a
 * reading of a clock (`plausibleSentAt` against when the row was stored,
 * `storedAt`): rows stored before that check existed took "Sep 20" as given
 * and hold the year 2001, and the same message read again as "Sep 20, 2026"
 * would otherwise be a new one — stored twice and copied to the CRM twice.
 *
 * What this cannot tell apart it keeps once: an agent that posts only the
 * newest messages, with no times, and a word-for-word repeat among them. That
 * second "ok" is the price; the alternative was a duplicate of every message
 * every time a thread was read again.
 */
export function splitRepeats(messages, stored = [], answered = new Set()) {
  const available = stored.filter((meta) => meta && !answered.has(meta.externalId));
  const label = (meta) => meta.sentAtGiven === false || !plausibleSentAt(Date.parse(meta.sentAt || ""), meta.storedAt);
  const fresh = [];
  const repeats = [];
  for (const message of messages) {
    const index = available.findIndex((meta) => meta.direction === message.direction
      && meta.body === message.body
      && (label(meta) || !message.sentAtGiven || meta.sentAt === message.sentAt));
    if (index === -1) {
      fresh.push(message);
      continue;
    }
    available.splice(index, 1);
    repeats.push(message);
  }
  return { fresh, repeats };
}

// -- matching a reply to an approach ----------------------------------------

/**
 * The outreach row this person is, if any.
 *
 * By slug first, because a LinkedIn link is the same string on both sides; by
 * exact name second, because plenty of the CRM's contacts carry no link at all.
 * No match is the ordinary case, not a failure: people write to an account
 * without having been approached by it.
 *
 * Name matching is exact after trimming and case-folding. Fuzzy was rejected —
 * the cost of a wrong match is a reply filed against a stranger and a status
 * moved on somebody who never answered.
 */
export function matchOutreachRow(rows, participant) {
  const slug = linkedinSlug(participant?.slug);
  // Collapsed on both sides of every comparison below, so a participant that
  // skipped the normalizer and a CRM row with a stray double space still meet.
  const name = cleanName(participant?.name).toLowerCase();

  // Newest first, so a person approached twice is credited to the live attempt.
  const ordered = rows.slice().sort((left, right) =>
    Date.parse(right.created_at || 0) - Date.parse(left.created_at || 0));

  if (slug) {
    const bySlug = ordered.find((row) => linkedinSlug(row.person_linkedin) === slug);
    if (bySlug) return bySlug;
  }
  // A participant LinkedIn would not name is not a person we can identify, and
  // matching on the placeholder would file every unnameable thread against
  // whichever row happens to carry the same string. Checked against the same
  // set the normalizer uses, so a participant that skipped it is still safe.
  if (!name || NON_NAMES.has(name)) return null;
  // Normalized, the slug no longer says what shape of link it came from; the
  // participant's `memberProfile` does.
  const profile = participant?.memberProfile === false ? "" : profileSlug(participant?.slug);
  return ordered.find((row) => {
    const person = cleanName(row.person_name).toLowerCase();
    // And a CRM row carrying the placeholder as its name matches nobody either.
    if (person !== name || NON_NAMES.has(person)) return false;
    // Two profiles that are both known and differ are two people, however alike
    // their names: a namesake writing in would otherwise have their whole
    // conversation copied onto the approached person's CRM contact.
    const theirs = profileSlug(row.person_linkedin);
    return !(profile && theirs && profile !== theirs);
  }) || null;
}

/**
 * The member profile a LinkedIn link or slug names, as a comparable slug, or
 * "" when it cannot be compared with another person's.
 *
 * Only an `/in/` link — or a bare slug, which is what the agent hands over —
 * names a member. A company, school or showcase page in the CRM's LinkedIn
 * column (plenty of contacts carry one) is not the person, and neither is a
 * link of any other shape: nothing in it says who somebody is not, so it never
 * rules a name match out. Nor does a member id — `/in/ACoAAB…` in messaging —
 * which is not the vanity slug the CRM row holds: the same person, spelled
 * differently.
 */
function profileSlug(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!memberLink(raw)) return "";
  const slug = linkedinSlug(raw);
  return !slug || slug.includes(":") || /^ac[ow]aa/.test(slug) ? "" : slug;
}

/**
 * The CRM contact this participant is, when no approach of this account's is.
 *
 * A person in a campaign's folder can write to a login that never approached
 * them, or answer one that did from before this portal kept rows. Their
 * contact still carries their LinkedIn link, and the slug in it is the same
 * string the agent read off the conversation — so the conversation still
 * lands on them. Slug only, never the name: a name is a guess, and a wrong
 * guess here files somebody's private message against a stranger in a
 * system the whole sales team reads.
 *
 * Two contacts with one profile are one person entered twice, and the line
 * goes to the record this workspace is working: the one an approach of any
 * account's names (`wl_outreach`), else the one sitting in a running
 * campaign's folder (`folderIds`), else the oldest. Oldest alone split one
 * person in two — a login that approached the newer record had their answers
 * there, and any other login they wrote to sent theirs to the older one, off
 * the card the seller was looking at.
 * A company or school page is not a person and matches nobody.
 *
 * Asked for the link that ends where the slug does first, and only then for
 * any link that merely starts with it: the second is a prefix search, and a
 * short slug ("anna") can be the start of more contacts than one page of
 * candidates holds, with the real one behind them.
 */
export async function contactBySlug(slug, { folderIds = [] } = {}) {
  const wanted = linkedinSlug(slug);
  if (!wanted || wanted.includes(":")) return null;
  const same = (rows) => rows.filter((row) => linkedinSlug(row.linkedin) === wanted);
  let found = same(await leadsByLinkedin(wanted));
  if (!found.length) found = same(await leadsByLinkedin(wanted, { prefix: true }));
  if (found.length < 2) return found[0]?.id ?? null;

  const approached = new Set((await anty.from("wl_outreach").select("crm_contact_id")
    .in("crm_contact_id", found.map((row) => row.id).slice(0, CONTACT_ID_BATCH)).rows())
    .map((row) => String(row.crm_contact_id)));
  const working = new Set(folderIds.filter(Boolean).map(String));
  // `found` is oldest first, so each preference keeps the oldest of its kind.
  return (found.find((row) => approached.has(String(row.id)))
    ?? found.find((row) => row.folder_id && working.has(String(row.folder_id)))
    ?? found[0]).id;
}

/**
 * The CRM contact for somebody nobody has put there: the one carrying their
 * profile link if somebody did in the meantime, else a new one in the folder
 * made for people who wrote in. `created` says which of the two it was.
 *
 * One person at a time (`once`), so two logins reading the same stranger in the
 * same minute make one contact — the second finds the first's.
 */
async function tieToContact(participant, { folderIds = [], account = null } = {}) {
  return once(`profile:${linkedinSlug(participant.slug)}`, async () => {
    const existing = await contactBySlug(participant.slug, { folderIds });
    if (existing) return { contactId: existing, created: false };
    const contactId = await createContact({ participant, accountName: account ? accountName(account) : "" });
    return { contactId, created: true };
  });
}

/** A thread belongs to this contact: its own row, because rows are not rewritten (`CONTACT_TYPE`). */
async function markContact(accountId, threadKey, crmContactId) {
  await anty.from("wl_events").insert({
    account_id: accountId,
    level: "info",
    type: CONTACT_TYPE,
    message: "Thread tied to a CRM contact",
    meta: { threadKey, crmContactId }
  }).rows();
}

/**
 * How many people one sync may add. The first sync after this shipped meets
 * every conversation the inbox ever held, and one request from the agent must
 * not carry all of them; what is left is taken on the next sync.
 */
export const ADOPT_PER_SYNC = 25;

/**
 * Add to the CRM the people this account has conversations with and nobody has
 * a record for — the ones read before this existed, and any that were missed.
 *
 * A person who writes to an account is added the moment their thread is read
 * (`storeThread`); this is for the threads already stored, which are not read
 * again until somebody writes in them. Each one is tied to its contact (the
 * thread then opens that contact) and what was said in it so far goes on the
 * contact's timeline, once — the copy ledger sees to "once".
 *
 * Stops at the first refusal: a CRM that will not take a contact will not take
 * the next either, and is asked again on the next sync. Never throws.
 */
export async function adoptWaitingThreads(account, { now = new Date(), folderIds = [], limit = ADOPT_PER_SYNC } = {}) {
  const result = { waiting: 0, added: 0, linked: 0, failed: 0 };
  if (!adoptionEnabled()) return result;
  try {
    await oneCopyAtATime(account.id, async () => {
      const [events, marked, approaches] = await Promise.all([
        messageEvents({ accountId: account.id }), marks(account.id), outreachRowsOf([account.id])
      ]);
      const waiting = deriveThreads(events, { contactMarks: marked.contacts })
        .filter((thread) => !thread.crmContactId && adoptable(thread.participant) && !matchOutreachRow(approaches, thread.participant));
      result.waiting = waiting.length;

      const name = accountName(account);
      for (const thread of waiting.slice(0, limit)) {
        try {
          const { contactId, created } = await tieToContact(thread.participant, { folderIds, account });
          await markContact(account.id, thread.threadKey, contactId);
          const rows = await storedInThread(account.id, thread.threadKey);
          const entries = oncePerRow(rows.map((row) => lineEntry(row, name))).sort(byConversation);
          await copyToCrm({ accountId: account.id, contactId, entries, now });
          if (created) result.added += 1;
          else result.linked += 1;
        } catch (error) {
          result.failed += 1;
          console.error("[warmup] could not add a person to the CRM:", error.message);
          break;
        }
      }
    });
  } catch (error) {
    console.error("[warmup] adding people to the CRM failed:", error.message);
  }
  return result;
}

/**
 * The line one message becomes on the contact's CRM timeline: which way it
 * went, on which login, when, and the words.
 *
 * The time is in the text because the CRM has no column known to hold it
 * (`activities.mjs`); the row's own timestamp is the moment we copied it. A
 * time LinkedIn only gave as "2h" is said to be one — with the label and when
 * it was read — rather than dressed up as a reading of a clock.
 */
export function messageLine(message, name) {
  const when = message?.sentAtGiven === false
    ? `${message.sentAtRaw ? `у LinkedIn «${message.sentAtRaw}», ` : ""}прочитано ${crmStamp(message.sentAt)}`
    : crmStamp(message?.sentAt);
  const head = message?.direction === "in"
    ? `LinkedIn · Відповідь на акаунт ${name} · ${when}`
    : `LinkedIn · Ми написали з акаунта ${name} · ${when}`;
  return clampContent(`${head}\n${message?.body || ""}`);
}

/** The line any copied row becomes: a message, or a request that went out. */
function activityLineOf(row, name) {
  // A card the agent once stored as a message says nothing to the sales team.
  if (MESSAGE_TYPES.includes(row?.type)) return isServiceCard(row.meta?.body, row.meta?.participant) ? null : messageLine(row.meta, name);
  if (REQUEST_EVENT_TYPES.includes(row?.type)) return requestLine(row, name);
  return null;
}

/**
 * One stored row as a line owed to the CRM, or null when it makes none.
 *
 * Carries what orders it (`byConversation`) and when its row was written,
 * which bounds the look for a copy already made (`copyToCrm`).
 */
function lineEntry(row, name, since = undefined) {
  const content = row ? activityLineOf(row, name) : null;
  if (!content) return null;
  return { eventId: String(row.id), content, since, storedAt: row.created_at, position: Number(row.meta?.position) || 0 };
}

/**
 * The order a contact's lines are written in, which is the only order the CRM
 * shows them in: the order their rows were stored, and inside one store the
 * place each message had in its thread (`conversationOrder`).
 *
 * Not the message's own time. Most messages carry only a label, stored as the
 * moment it was read, so every one of a thread's first read was the same
 * moment; and a label next to a real time would sort after it even when it was
 * sent before. What was stored earlier was sent earlier — that is what
 * "stored" means for a thread read oldest first — so a line owed since
 * yesterday goes before today's new one, not after it.
 */
function byConversation(left, right) {
  return String(left.storedAt || "").localeCompare(String(right.storedAt || ""))
    || left.position - right.position
    || left.eventId.localeCompare(right.eventId);
}

/** Each row once; the first entry for a row wins, so pass the owed ones first — they know since when. */
function oncePerRow(entries) {
  const found = new Map();
  for (const entry of entries) if (entry && !found.has(entry.eventId)) found.set(entry.eventId, entry);
  return [...found.values()];
}

// -- writing ----------------------------------------------------------------

/**
 * The only place a message becomes a row. Hands the rows back: each one's id
 * is the key its CRM copy is made under.
 */
async function insertMessages(accountId, threadKey, participant, messages, crmContactId = null) {
  if (!messages.length) return [];
  return anty.from("wl_events").insert(messages.map((message) => ({
    account_id: accountId,
    level: "info",
    type: message.direction === "in" ? MESSAGE_IN : MESSAGE_OUT,
    // The audit log and the message log share this table, so the human-readable
    // column still has to read as a log line to anyone scrolling past it.
    message: `${message.direction === "in" ? "Reply from" : "Sent to"} ${participant.name}`,
    meta: {
      threadKey,
      // Who this is, written down rather than worked out again on every read.
      // Without it a person's history is a name match repeated at read time,
      // and somebody who renames their LinkedIn profile drops out of their own
      // history. Null when the thread matched nobody we approached and no CRM
      // contact carries this profile.
      crmContactId,
      // Stored before anybody knew who this is: its CRM copy waits for the
      // thread to be matched (`earlierLines`). Said on the row because rows
      // from before the copy existed hold a null too, and those are not
      // copied — their newest replies went out under the old rule already.
      awaitsContact: !crmContactId,
      // Its place in the thread as read, oldest first (`conversationOrder`):
      // rows stored together share one timestamp.
      position: Number.isInteger(message.position) ? message.position : null,
      externalId: message.externalId,
      direction: message.direction,
      body: message.body,
      sentAt: message.sentAt,
      sentAtGiven: message.sentAtGiven,
      sentAtRaw: message.sentAtRaw,
      // A real reading of LinkedIn's clock, which is all that may reorder
      // what was stored (`threadOrder`): "12/9/2025" is stored as a time as
      // well, and is still only a label.
      sentAtIso: message.sentAtIso === true,
      truncated: message.truncated,
      participant
    }
  }))).select("id,type,meta,created_at").rows();
}

/**
 * Move a matched approach to `connected` and stamp when they answered.
 *
 * Which statuses may become `connected` is not decided here. It is decided by
 * the transition table in `invites.mjs`, and this goes through it like every
 * other automatic writer — a row still `queued` or `waiting` is a person nobody
 * has written to, and `connected`, `declined` and `withdrawn` are answers a
 * human already gave that a sync must not overwrite every morning.
 *
 * It used to hold its own copy of that rule. The copy happened to agree with
 * the table, but it agreed by coincidence rather than by construction, and the
 * daily invitation check is a third writer arriving on the same column.
 */
async function markReplied(row, sentAt) {
  const outcome = await moveStatus({
    outreachId: row.id,
    to: "connected",
    patch: { responded_at: sentAt }
  });
  return outcome.moved;
}

/** The columns a reply is matched to an approach by. */
const OUTREACH_MATCH_COLUMNS = "id,account_id,crm_contact_id,person_name,person_linkedin,status,created_at";

/** One page of outreach rows. Supabase answers at most a thousand rows to a request, whatever is asked. */
const OUTREACH_PAGE = 1000;

/**
 * Every approach these accounts made, newest first, read page by page.
 *
 * Read whole because the match is made here (`matchOutreachRow`), on slugs and
 * names the database cannot compare the way that does. It used to be one
 * request, which the server cuts at a thousand rows — out of reach while
 * sending stopped at day 14, a few months away once working mode sends every
 * day — and a reply from anybody past the cut matched nothing: no status
 * moved, no `responded_at`, no reply in the campaign's count. Paged until a
 * page comes back empty rather than short, so a server that cuts lower than
 * this asks is still read to the end.
 */
async function outreachRowsOf(accountIds) {
  const found = [];
  if (!accountIds.length) return found;
  for (let offset = 0; ;) {
    const page = await anty.from("wl_outreach").select(OUTREACH_MATCH_COLUMNS).in("account_id", accountIds)
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .offset(offset).limit(OUTREACH_PAGE).rows();
    if (!page.length) return found;
    found.push(...page);
    offset += page.length;
  }
}

/**
 * What else this contact is owed on this account, now that the thread is
 * known to be theirs: every line an earlier copy failed on — so it goes before
 * what just arrived, not after it — and the messages of this thread stored
 * while nobody knew who it was with.
 *
 * The second are the rows marked `awaitsContact` stored after the thread was
 * last tied to anybody: the ones before that were copied (or owed) when it
 * was. A row owed to another contact is left to the copy that owes it.
 */
async function earlierLines({ accountId, contactId, threadKey, threadRows, name, now }) {
  const lines = [];
  const elsewhere = new Set();
  let owed = [];
  let sources = new Map();
  try {
    owed = await outstandingCopies(accountId, now);
    sources = new Map((owed.length ? await sourceEvents(owed.map((item) => item.eventId)) : [])
      .map((row) => [String(row.id), row]));
  } catch (error) {
    // What is owed stays owed, for `inbox.done` to retry; the new lines go.
    console.error("[warmup] could not read what the CRM is owed:", error.message);
    owed = [];
  }
  for (const item of owed) {
    const row = sources.get(item.eventId);
    if (!row) continue;
    const to = item.contactId || row.meta?.crmContactId || null;
    const here = to
      ? String(to) === String(contactId)
      // Owed with nobody to go to: the lookup failed. In this thread, it is them.
      : MESSAGE_TYPES.includes(row.type) && row.meta?.threadKey === threadKey;
    if (here) lines.push(lineEntry(row, name, item.since));
    else elsewhere.add(item.eventId);
  }

  const lastTied = threadRows.filter((row) => row.meta?.crmContactId).map((row) => String(row.created_at)).sort().pop() || "";
  for (const row of threadRows) {
    if (!row.meta?.awaitsContact || row.meta.crmContactId || elsewhere.has(String(row.id))) continue;
    if (String(row.created_at) <= lastTied) continue;
    lines.push(lineEntry(row, name));
  }
  return lines;
}

/**
 * One conversation as the agent found it: store what is new, move the approach
 * on if they answered, and copy every new message — ours and theirs — to the
 * person's CRM contact. Each step is skipped silently when it does not apply.
 *
 * `folderIds` are the running campaigns' folders, which settle a person the
 * CRM holds twice (`contactBySlug`).
 */
export async function storeThread({ account, input, folderIds = [], now = new Date() }) {
  const { threadKey, participant, messages, invalid, undated, cards = 0 } = input;

  const seen = await storedExternalIds(account.id, messages.map((message) => message.externalId));
  const byId = splitStored(messages, seen);
  // New ids are not always new messages: see `splitRepeats`. Asked only when
  // something is new by id, which on an ordinary re-read is nothing.
  const threadRows = byId.fresh.length ? await storedInThread(account.id, threadKey) : [];
  const { fresh, repeats } = byId.fresh.length
    ? splitRepeats(byId.fresh, threadRows.map((row) => ({ ...row.meta, storedAt: row.created_at })), seen)
    : { fresh: [], repeats: [] };
  const skipped = [...byId.skipped, ...repeats];

  // Who this thread is, resolved before anything is written rather than after.
  // It used to be worked out only when something inbound arrived, which meant
  // a thread of our own messages was stored with nothing saying who they were
  // to. Done for every thread that has anything new in it, so the person key
  // goes onto outbound messages as well.
  const rows = fresh.length ? await outreachRowsOf([account.id]) : [];
  const match = fresh.length ? matchOutreachRow(rows, participant) : null;

  // Nobody this account approached: the CRM contact whose LinkedIn is this
  // profile, if there is one. A CRM that cannot be asked right now is not a
  // reason to lose the messages — they are stored unlinked, and their copy is
  // owed to the next sync, which asks again.
  let contactId = match?.crm_contact_id ?? null;
  let lookupError = null;
  if (fresh.length && !contactId && participant.slug) {
    try {
      contactId = await contactBySlug(participant.slug, { folderIds });
    } catch (error) {
      lookupError = error;
    }
  }

  // Nobody in the CRM at all: a person who wrote to this login and is on nobody's
  // list. They are added to the contact base, in the folder made for them, so
  // that the conversation has a record to land on and the sales team a card to
  // open. A CRM that refuses costs the message nothing — it is stored, and its
  // copy is owed, as when the CRM cannot be asked who somebody is.
  let adopted = false;
  if (fresh.length && !contactId && !lookupError && adoptionEnabled() && adoptable(participant)) {
    try {
      ({ contactId, created: adopted } = await tieToContact(participant, { folderIds, account }));
    } catch (error) {
      lookupError = error;
    }
  }

  const stored = await insertMessages(account.id, threadKey, participant, fresh, contactId);

  const inbound = fresh.filter((message) => message.direction === "in");
  const outcome = {
    matchedOutreachId: match?.id ?? null,
    crmContactId: contactId,
    // How the person was found: their approach on this account, only their
    // LinkedIn link in the CRM — which moves no status, because there is no
    // approach of this account's to move — or not at all, and added now.
    matchedBy: match ? "outreach" : contactId ? (adopted ? "added" : "linkedin") : null,
    added: adopted,
    statusMoved: false,
    crm: "skipped",
    crmWritten: 0
  };

  if (inbound.length && match) {
    // The newest inbound message is the one that proves they answered.
    const newest = inbound.reduce((latest, message) => (message.sentAt > latest.sentAt ? message : latest));
    outcome.statusMoved = await markReplied(match, newest.sentAt);
  }

  // Every new message, both ways, in the conversation's order — after
  // whatever this contact was already owed. What we wrote is half the
  // conversation; a CRM that only ever showed their answers showed nobody
  // what they were answering.
  if (stored.length && (contactId || lookupError)) {
    const copy = await oneCopyAtATime(account.id, async () => {
      const name = accountName(account);
      const earlier = contactId
        ? await earlierLines({ accountId: account.id, contactId, threadKey, threadRows, name, now })
        : [];
      const entries = oncePerRow([...earlier, ...stored.map((row) => lineEntry(row, name))]).sort(byConversation);
      return copyToCrm({ accountId: account.id, contactId, entries, error: lookupError, now });
    });
    outcome.crm = copy.failed ? "failed" : "written";
    outcome.crmWritten = copy.written;
  }

  // `repeated` is the part of `skipped` that came back under a new id. Zero on
  // an agent whose ids are stable; a count every morning says they are not.
  return { stored: fresh.length, skipped: skipped.length, repeated: repeats.length, invalid, undated, cards, threadKey, ...outcome };
}

/**
 * Give the CRM what it was owed: every copy that failed on an earlier sync of
 * this account, made again from the stored row and sent to its contact.
 *
 * Run once a sync, when the agent says it is done (`inbox.done`), rather than
 * per thread: a thread nobody wrote in since is not read again, and the copy it
 * owes would otherwise wait for a message that may never come. A request's
 * copy is owed here too — the account's daily sync is the next time anything
 * talks to the CRM on its behalf.
 *
 * One at a time per account (`oneCopyAtATime`): a second `inbox.done` sent
 * while this one is still writing waits, and then finds nothing owed.
 *
 * Never throws. What still cannot be written is owed again, from its first
 * failure, until `CRM_RETRY_DAYS` have passed.
 */
export async function retryCrmCopies(account, { now = new Date(), folderIds = [] } = {}) {
  const result = { owed: 0, written: 0, failed: 0 };
  try {
    await oneCopyAtATime(account.id, async () => {
      const owed = await outstandingCopies(account.id, now);
      result.owed = owed.length;
      if (!owed.length) return;

      const byId = new Map((await sourceEvents(owed.map((item) => item.eventId))).map((row) => [String(row.id), row]));
      const name = accountName(account);
      const groups = new Map();
      for (const item of owed) {
        const row = byId.get(item.eventId);
        // A source row that is gone has nothing left to copy.
        const entry = lineEntry(row, name, item.since);
        if (!entry) continue;

        let contactId = item.contactId || row.meta?.crmContactId || null;
        let error = null;
        if (!contactId && row.meta?.participant?.slug) {
          try {
            contactId = await contactBySlug(row.meta.participant.slug, { folderIds });
          } catch (caught) {
            error = caught;
          }
        }
        // Asked and answered "nobody": there is no contact to owe it to.
        if (!contactId && !error) continue;

        const key = contactId ? `contact:${contactId}` : "unresolved";
        const group = groups.get(key) ?? { contactId, error, entries: [] };
        group.entries.push(entry);
        groups.set(key, group);
      }

      for (const group of groups.values()) {
        const copy = await copyToCrm({
          accountId: account.id, contactId: group.contactId, entries: group.entries.sort(byConversation), error: group.error, now
        });
        result.written += copy.written;
        result.failed += copy.failed;
      }
    });
  } catch (error) {
    console.error("[warmup] CRM retry failed:", error.message);
  }
  return result;
}

/**
 * Every message stored for one person, newest first.
 *
 * Two ways of belonging, and both are needed for a while. Messages stored from
 * this phase on carry `meta.crmContactId` and are simply filtered — on every
 * account, because a person can write to any login: the one that approached
 * them, or one that found them only by the LinkedIn link on their contact.
 * Everything stored before the key existed has no person key at all, so those
 * are matched the old way, on the one account that approached them — on the
 * LinkedIn slug, then the name — which is the matching that breaks when
 * somebody renames their profile. **Older messages are not backfilled**, so a
 * person's history is exact from here on and best-effort behind.
 *
 * And a third: a message stored before anybody knew who it was with carries
 * no key, and never will — rows are not rewritten here. When it is later
 * copied to this contact, or owed to them, the `crm.copied` or
 * `inbox.crm_failed` marker names the contact and the row, and that is how it
 * is found (`rowIdsNamedFor`). Without it the CRM showed a line the person's own
 * card in the portal did not.
 */
export async function messagesForContact({ accountId, crmContactId, personName, personLinkedin }, limit = 200) {
  if (!accountId && !crmContactId) return [];
  const columns = "id,account_id,type,meta,created_at";
  const [keyed, legacy, markedIds] = await Promise.all([
    crmContactId
      ? anty.from("wl_events").select(columns).in("type", MESSAGE_TYPES)
        .eq("meta->>crmContactId", String(crmContactId))
        .order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows()
      : [],
    accountId
      ? anty.from("wl_events").select(columns).eq("account_id", accountId).in("type", MESSAGE_TYPES)
        .order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows()
      : [],
    crmContactId ? rowIdsNamedFor(crmContactId) : []
  ]);
  // Rows the key already found are not read a second time.
  const keyedIds = new Set(keyed.map((row) => String(row.id)));
  const unread = markedIds.filter((id) => !keyedIds.has(id));
  const named = (unread.length ? await sourceEvents(unread) : [])
    .filter((row) => MESSAGE_TYPES.includes(row.type) && !row.meta?.crmContactId);
  const namedIds = new Set(named.map((row) => String(row.id)));

  const wantedSlug = linkedinSlug(personLinkedin);
  const wantedName = cleanName(personName).toLowerCase();
  const theirs = (row) => {
    const meta = row.meta || {};
    if (namedIds.has(String(row.id))) return true;
    if (meta.crmContactId) return String(meta.crmContactId) === String(crmContactId);
    const participant = meta.participant || {};
    if (wantedSlug && linkedinSlug(participant.slug) === wantedSlug) return true;
    const name = cleanName(participant.name).toLowerCase();
    return Boolean(wantedName) && !NON_NAMES.has(wantedName) && name === wantedName;
  };

  const seen = new Set();
  return [...keyed, ...named, ...legacy]
    .filter((row) => {
      if (seen.has(row.id) || isServiceCard(row.meta?.body, row.meta?.participant) || !theirs(row)) return false;
      seen.add(row.id);
      return true;
    })
    .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      kind: "message",
      direction: row.type === MESSAGE_IN ? "in" : "out",
      at: row.meta?.sentAt || row.created_at,
      storedAt: row.created_at,
      body: row.meta?.body || "",
      threadKey: row.meta?.threadKey || "",
      // Which login the conversation is on — with more than one possible, the
      // screen has to be able to say.
      accountId: row.account_id ?? null,
      truncated: Boolean(row.meta?.truncated),
      // How this message was recognised as theirs — worth showing, because the
      // name-or-slug way is a guess that a rename can break.
      matchedBy: row.meta?.crmContactId || namedIds.has(String(row.id)) ? "contact_id" : "name_or_slug"
    }));
}

/**
 * The rows a CRM marker ties to this contact: copied to them (`crm.copied`)
 * or owed to them (`inbox.crm_failed`), on any account. Messages among them
 * with no person key of their own are the ones only this can find.
 */
async function rowIdsNamedFor(crmContactId) {
  const markers = await anty.from("wl_events").select("meta").in("type", [CRM_COPIED, CRM_FAILED])
    .eq("meta->>contactId", String(crmContactId))
    .order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows();
  const ids = new Set();
  for (const { meta } of markers) {
    for (const id of Array.isArray(meta?.eventIds) ? meta.eventIds : []) ids.add(String(id));
    for (const entry of Array.isArray(meta?.owed) ? meta.owed : []) if (entry?.eventId) ids.add(String(entry.eventId));
  }
  return [...ids];
}

/**
 * The sync finished. Without this an empty inbox cannot say which it is —
 * nothing has arrived, or the agent never looked — and those two need different
 * people to do different things.
 */
export async function markSynced(accountId, threadsSeen) {
  const at = new Date().toISOString();
  await anty.from("wl_events").insert({
    account_id: accountId,
    level: "info",
    type: SYNCED_TYPE,
    message: `Inbox synced — ${threadsSeen} conversation${threadsSeen === 1 ? "" : "s"} seen`,
    meta: { threadsSeen, syncedAt: at }
  }).rows();
  return at;
}

/** A thread has been looked at. Unread is derived from these marks. */
export async function markRead(accountId, threadKey) {
  const at = new Date().toISOString();
  await anty.from("wl_events").insert({
    account_id: accountId,
    level: "info",
    type: READ_TYPE,
    message: "Thread opened",
    meta: { threadKey, readAt: at }
  }).rows();
  return at;
}

// -- reading ----------------------------------------------------------------

function toMessage(event) {
  return {
    externalId: event.meta?.externalId ?? null,
    direction: event.type === MESSAGE_IN ? "in" : "out",
    body: typeof event.meta?.body === "string" ? event.meta.body : "",
    sentAt: event.meta?.sentAt || event.created_at,
    // When we learned of it, which is not when it was sent, and is the value
    // unread is derived from — see `deriveThreads`.
    storedAt: event.created_at,
    // Its place in the thread as read, and whether its time is a real one —
    // what the thread is ordered by (`threadOrder`). Rows stored before
    // either was written carry neither.
    position: Number.isInteger(event.meta?.position) ? event.meta.position : null,
    sentAtIso: event.meta?.sentAtIso === true
  };
}

/**
 * One thread's messages oldest first: the order the thread screen shows them
 * in and the one its last message is picked by — the order the CRM writes
 * them in (`byConversation`). When each was stored, then its place in the
 * store it came in (`position`).
 *
 * A message's own time reorders only messages that both carry a real one
 * (`sentAtIso`): those are sorted by it among the places the stored order
 * gives them, and every other message keeps its place — a later read that
 * found an older message further up puts it where it was sent. A label never
 * moves anything, a year in it or not: "12/9/2025" then "3/10/2025", posted
 * oldest first, is September then October on the page it came from and
 * December then March to `Date.parse`. Ordered by the parsed times, the
 * screen showed the answer before the message it answered, while the CRM had
 * them the right way round.
 *
 * Rows stored before `sentAtIso` and `position` were written keep the order
 * they were stored in, and inside one store their times — what the screen
 * ordered them by before.
 */
function threadOrder(messages) {
  const stored = messages.slice().sort((left, right) =>
    String(left.storedAt || "").localeCompare(String(right.storedAt || ""))
    || (left.position ?? 0) - (right.position ?? 0)
    || String(left.sentAt || "").localeCompare(String(right.sentAt || "")));
  const timed = stored.filter((message) => message.sentAtIso)
    .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
  let next = 0;
  return stored.map((message) => (message.sentAtIso ? timed[next++] : message));
}

/**
 * Message events grouped into threads, with unread derived against the read
 * marks.
 *
 * Unread is "we stored an inbound message after you last opened this", not "an
 * inbound message is dated later than your last open". The difference is the
 * ordinary case: somebody writes at 10:00, you open the thread at 11:00, the
 * agent syncs at 12:00 and stores the 10:00 message. By `sentAt` that message
 * is already read and you never see it; by when we stored it, it is new to you
 * — which it is.
 */
export function deriveThreads(events, { readMarks = new Map(), syncedAt = new Map(), contactMarks = new Map() } = {}) {
  const threads = new Map();

  for (const event of events) {
    const threadKey = event.meta?.threadKey;
    if (!threadKey || !event.account_id) continue;
    // A card stored as a message is not one (`SERVICE_CARD_BODY`): it makes no
    // thread, no unread, no preview and no participant.
    if (isServiceCard(event.meta?.body, event.meta?.participant)) continue;
    const key = threadId(event.account_id, threadKey);
    const message = toMessage(event);

    let thread = threads.get(key);
    if (!thread) {
      thread = {
        threadKey,
        accountId: event.account_id,
        participant: normalizeParticipant(event.meta?.participant),
        participantSeenAt: event.created_at,
        messages: [],
        newestInboundStoredAt: null,
        contact: null
      };
      threads.set(key, thread);
    }

    thread.messages.push(message);
    // The person this thread is with, when a message was stored knowing it.
    if (event.meta?.crmContactId && (!thread.contact || event.created_at > thread.contact.at)) {
      thread.contact = { crmContactId: String(event.meta.crmContactId), at: event.created_at };
    }
    // The newest event carrying a participant wins: a headline that changed, or
    // a name the agent could only resolve on the second run, should be current.
    if (event.meta?.participant && event.created_at >= thread.participantSeenAt) {
      thread.participant = normalizeParticipant(event.meta.participant);
      thread.participantSeenAt = event.created_at;
    }
    if (message.direction === "in" && (!thread.newestInboundStoredAt || message.storedAt > thread.newestInboundStoredAt)) {
      thread.newestInboundStoredAt = message.storedAt;
    }
  }

  return [...threads.values()].map((thread) => {
    const readAt = readMarks.get(threadId(thread.accountId, thread.threadKey)) || null;
    // The last in the order the thread screen shows (`threadOrder`), so the
    // list's preview is the message the thread ends on there.
    const lastMessage = threadOrder(thread.messages).at(-1) ?? null;
    // Who the thread is with: the newest of what a message was stored knowing
    // and a later tie (`CONTACT_TYPE`). An approach of this account's, which
    // the caller knows about and this does not, comes before both.
    const tied = contactMarks.get(threadId(thread.accountId, thread.threadKey));
    const contact = tied && (!thread.contact || tied.at > thread.contact.at) ? tied : thread.contact;
    return {
      threadKey: thread.threadKey,
      accountId: thread.accountId,
      crmContactId: contact?.crmContactId ?? null,
      participant: thread.participant,
      lastMessage: lastMessage && {
        direction: lastMessage.direction,
        body: lastMessage.body,
        sentAt: lastMessage.sentAt
      },
      messageCount: thread.messages.length,
      unread: Boolean(thread.newestInboundStoredAt) && (!readAt || thread.newestInboundStoredAt > readAt),
      readAt,
      lastSyncedAt: syncedAt.get(thread.accountId) || null
    };
  }).sort(byUnreadThenNewest);
}

/** Unread first, then newest: a reply outranks a plan, and a new one an old one. */
export function byUnreadThenNewest(left, right) {
  if (left.unread !== right.unread) return left.unread ? -1 : 1;
  return String(right.lastMessage?.sentAt || "").localeCompare(String(left.lastMessage?.sentAt || ""));
}

async function messageEvents({ accountId = null, threadKey = null } = {}) {
  let query = anty.from("wl_events").select("account_id,type,meta,created_at").in("type", MESSAGE_TYPES);
  if (accountId) query = query.eq("account_id", accountId);
  if (threadKey) query = query.eq("meta->>threadKey", threadKey);
  return query.order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows();
}

/** The newest read mark per thread, the newest sync per account, and the newest contact each thread was tied to. */
async function marks(accountId = null) {
  const read = new Map();
  const synced = new Map();
  const contacts = new Map();

  let readQuery = anty.from("wl_events").select("account_id,meta,created_at").eq("type", READ_TYPE);
  let syncQuery = anty.from("wl_events").select("account_id,meta,created_at").eq("type", SYNCED_TYPE);
  let contactQuery = anty.from("wl_events").select("account_id,meta,created_at").eq("type", CONTACT_TYPE);
  if (accountId) {
    readQuery = readQuery.eq("account_id", accountId);
    syncQuery = syncQuery.eq("account_id", accountId);
    contactQuery = contactQuery.eq("account_id", accountId);
  }

  const [readRows, syncRows, contactRows] = await Promise.all([
    readQuery.order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows(),
    syncQuery.order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows(),
    contactQuery.order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows()
  ]);

  // Newest first, so the first mark seen for a key is the one that counts.
  for (const row of readRows) {
    if (!row.account_id || !row.meta?.threadKey) continue;
    const key = threadId(row.account_id, row.meta.threadKey);
    if (!read.has(key)) read.set(key, row.created_at);
  }
  for (const row of syncRows) {
    if (row.account_id && !synced.has(row.account_id)) synced.set(row.account_id, row.created_at);
  }
  for (const row of contactRows) {
    if (!row.account_id || !row.meta?.threadKey || !row.meta?.crmContactId) continue;
    const key = threadId(row.account_id, row.meta.threadKey);
    if (!contacts.has(key)) contacts.set(key, { crmContactId: String(row.meta.crmContactId), at: row.created_at });
  }

  return { read, synced, contacts };
}

/**
 * Every account's last sync, and how many have ever had one.
 *
 * Top level on the inbox response rather than only per thread, because the one
 * case the value decides — an empty inbox — is the case with no thread to carry
 * it. "Nothing has arrived" and "the agent has never run" look identical
 * otherwise, and only one of them needs somebody to go and fix something.
 */
export async function syncSummary(accountIds) {
  const { synced } = await marks();
  const times = accountIds.map((id) => synced.get(id)).filter(Boolean);
  return {
    accountsTotal: accountIds.length,
    accountsSynced: times.length,
    lastSyncedAt: times.sort().pop() || null,
    // Each account's own, because the screen opens one account at a time and
    // «читали 6 год тому» about somebody else's login is not an answer.
    byAccount: Object.fromEntries(accountIds.filter((id) => synced.has(id)).map((id) => [id, synced.get(id)]))
  };
}

/** Threads across every account, or one account, unread first then newest. */
export async function listThreads({ accountId = null, unreadOnly = false } = {}) {
  const [events, { read, synced, contacts }] = await Promise.all([messageEvents({ accountId }), marks(accountId)]);
  const threads = deriveThreads(events, { readMarks: read, syncedAt: synced, contactMarks: contacts });
  return unreadOnly ? threads.filter((thread) => thread.unread) : threads;
}

/** One conversation, oldest first — the shape the thread screen renders. */
export async function readThread({ accountId, threadKey }) {
  const [events, { read, synced, contacts }] = await Promise.all([
    messageEvents({ accountId, threadKey }),
    marks(accountId)
  ]);
  const [thread] = deriveThreads(events, { readMarks: read, syncedAt: synced, contactMarks: contacts });
  if (!thread) return null;

  const messages = threadOrder(events.filter((event) => !isServiceCard(event.meta?.body, event.meta?.participant)).map(toMessage))
    .map((message) => ({
      direction: message.direction,
      body: message.body,
      sentAt: message.sentAt,
      externalId: message.externalId
    }));

  return { thread, messages };
}

/** How many threads are waiting, for the nav badge. */
export async function unreadCount() {
  return (await listThreads({ unreadOnly: true })).length;
}

/** When this account was last swept, so the agent knows where to stop reading. */
export async function lastSyncedAt(accountId) {
  const row = await anty.from("wl_events").select("created_at")
    .eq("account_id", accountId).eq("type", SYNCED_TYPE)
    .order("created_at", { ascending: false }).maybeSingle();
  return row?.created_at || null;
}

/**
 * The outreach status behind each thread, matched by the same rule the write
 * path uses — a list that disagreed with what a reply actually did to a row
 * would be worse than a list with no status at all.
 */
export async function outreachFor(threads) {
  const accountIds = [...new Set(threads.map((thread) => thread.accountId))];
  const found = new Map();
  if (!accountIds.length) return found;

  // Paged, like the write path's read, for the same thousand-row cut.
  const rows = await outreachRowsOf(accountIds);

  const byAccount = new Map(accountIds.map((id) => [id, []]));
  for (const row of rows) byAccount.get(row.account_id)?.push(row);

  for (const thread of threads) {
    const match = matchOutreachRow(byAccount.get(thread.accountId) || [], thread.participant);
    found.set(threadId(thread.accountId, thread.threadKey), match
      ? { crmContactId: match.crm_contact_id ?? null, outreachStatus: match.status ?? null }
      : { crmContactId: null, outreachStatus: null });
  }
  return found;
}

/** The key `outreachFor` files its answers under, for callers joining the two. */
export function threadKeyOf(thread) {
  return threadId(thread.accountId, thread.threadKey);
}

/**
 * The same threads, counted per account.
 *
 * A reply belongs to the login it arrived on, and until this existed the screen
 * could only say so one row at a time — a line of small print under a stranger's
 * name. Which account is waiting on somebody is a question about the account,
 * so it gets an answer shaped like an account: how many threads it holds, how
 * many are unread, and when the newest of them was written.
 *
 * Ordered by what needs a person: unread first, then the freshest.
 */
export function summarizeAccounts(threads) {
  const found = new Map();

  for (const thread of threads) {
    if (!thread?.accountId) continue;
    let account = found.get(thread.accountId);
    if (!account) {
      account = { accountId: thread.accountId, threads: 0, unread: 0, newestAt: null };
      found.set(thread.accountId, account);
    }
    account.threads += 1;
    if (thread.unread) account.unread += 1;
    const sentAt = thread.lastMessage?.sentAt || null;
    if (sentAt && (!account.newestAt || sentAt > account.newestAt)) account.newestAt = sentAt;
  }

  return [...found.values()].sort((left, right) => {
    if (Boolean(left.unread) !== Boolean(right.unread)) return left.unread ? -1 : 1;
    if (left.unread !== right.unread) return right.unread - left.unread;
    return String(right.newestAt || "").localeCompare(String(left.newestAt || ""));
  });
}
