import { createHash } from "node:crypto";

import { anty, crm } from "./db.mjs";
import { logEvent } from "./store.mjs";
import { moveStatus } from "./invites.mjs";

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
 * What the audit log must not show, named here so no other file has to know
 * which event types are really messages.
 *
 * The two share a table, so a reader of either has to filter — and the audit
 * log is the reader with something to lose. A message row carries somebody's
 * private reply in `meta.body`, and eight "Reply from Jane" lines would push
 * the day's actual history off a panel that only shows eight. `inbox.read` is
 * pure screen state with nothing to audit.
 *
 * `inbox.synced` deliberately stays visible: a run of zeros is the one signal
 * that the agent's selectors have rotted, and hiding it would hide exactly the
 * failure this phase is most likely to have.
 */
export const AUDIT_HIDDEN_TYPES = [MESSAGE_IN, MESSAGE_OUT, READ_TYPE];

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

function segment(value) {
  try {
    return decodeURIComponent(value).trim().toLowerCase();
  } catch {
    // A stray percent in a pasted URL is not worth losing the match over.
    return value.trim().toLowerCase();
  }
}

/**
 * A comparable key out of whatever form a LinkedIn link takes: a full URL, an
 * `/in/` path, or the slug on its own. Lower-cased and stripped of the query
 * and the trailing slash, because the same person arrives spelled three ways —
 * the agent reads a href, the CRM holds whatever a seller once pasted.
 *
 * A company, school or showcase page keeps its kind in the key. Plenty of the
 * CRM's contacts carry `/company/...` in the column meant for the person, and
 * without the prefix `linkedin.com/company/acme` and `linkedin.com/in/acme`
 * reduce to the same string — which would file somebody's reply against a row
 * belonging to a different person entirely.
 *
 * A bare slug with no path is read as a person: that is what the agent hands
 * us, because what it reads is an `/in/` href.
 */
export function linkedinSlug(value) {
  const raw = text(value, 300);
  if (!raw) return "";
  const person = /\/in\/([^/?#]+)/i.exec(raw);
  if (person) return segment(person[1]);

  const page = /\/(company|school|showcase)\/([^/?#]+)/i.exec(raw);
  if (page) return `${page[1].toLowerCase()}:${segment(page[2])}`;

  return segment(raw.split(/[/?#]/).filter(Boolean).pop() || "");
}

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
 */
export function normalizeParticipant(raw) {
  const name = cleanName(raw?.name);
  return {
    name: !name || NON_NAMES.has(name.toLowerCase()) ? UNNAMED : name,
    slug: linkedinSlug(raw?.slug) || null,
    headline: cleanName(raw?.headline, 300) || null
  };
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
  const dated = Number.isFinite(parsed);
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
    sentAtRaw: dated ? null : sentAtRaw || null
  };
}

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

  for (const raw of incoming) {
    const message = normalizeMessage(raw, { threadKey, receivedAt });
    // One unreadable message must not cost the nineteen around it.
    if (!message) { invalid += 1; continue; }
    if (!message.sentAtGiven) undated += 1;
    messages.push(message);
  }

  return {
    threadKey,
    participant: normalizeParticipant(body?.participant),
    messages,
    invalid,
    undated,
    receivedAt
  };
}

// -- duplicate suppression --------------------------------------------------

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
  if (!wanted.length) return new Set();

  const rows = await anty.from("wl_events").select("meta")
    .eq("account_id", accountId).in("type", MESSAGE_TYPES)
    // The ids are hex hashes or LinkedIn's own ids; neither can hold the comma
    // that separates an `in.(...)` list, so they go in as they are.
    .in("meta->>externalId", wanted)
    .rows();

  return new Set(rows.map((row) => row.meta?.externalId).filter(Boolean));
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
  return ordered.find((row) => {
    const person = cleanName(row.person_name).toLowerCase();
    // And a CRM row carrying the placeholder as its name matches nobody either.
    return person === name && !NON_NAMES.has(person);
  }) || null;
}

/**
 * The line the CRM gets. It names the account the reply arrived on, because the
 * sales team reading it there has no other way to know which of five logins the
 * person answered.
 */
export function crmContent(accountName, body) {
  return `LinkedIn reply to ${accountName}: ${body}`.slice(0, 2000);
}

// -- writing ----------------------------------------------------------------

/** The only place a message becomes a row. */
async function insertMessages(accountId, threadKey, participant, messages, crmContactId = null) {
  if (!messages.length) return;
  await anty.from("wl_events").insert(messages.map((message) => ({
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
      // history. Null when the thread matched nobody we approached.
      crmContactId,
      externalId: message.externalId,
      direction: message.direction,
      body: message.body,
      sentAt: message.sentAt,
      sentAtGiven: message.sentAtGiven,
      sentAtRaw: message.sentAtRaw,
      truncated: message.truncated,
      participant
    }
  }))).rows();
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

/**
 * The CRM copy, best-effort on purpose.
 *
 * A CRM that is down must never lose a message: the reply is already stored by
 * the time this runs, so a failure costs a copy, not the fact. It is logged at
 * warn rather than swallowed, because a CRM that has been failing silently for
 * a week is the thing nobody notices.
 */
async function writeCrmActivity({ accountId, contactId, accountName, body }) {
  try {
    await crm.from("activities").insert({
      contact_id: contactId,
      type: "linkedin",
      content: crmContent(accountName, body)
      // `user_id` is left to the column's own default, which a service-role
      // insert resolves to null. That is right: nobody on the sales team wrote
      // this, and attributing it to whoever holds the key would be a lie in a
      // column people filter by.
    }).rows();
    return "written";
  } catch (error) {
    await logEvent({
      accountId, level: "warn", type: "inbox.crm_failed",
      message: `Reply stored, but the CRM did not take it: ${error.message}`,
      meta: { contactId }
    });
    return "failed";
  }
}

/**
 * One conversation as the agent found it: store what is new, then — for inbound
 * messages only — match it to an approach, move the status, and copy it to the
 * CRM. Each of the three is skipped silently when it does not apply.
 */
export async function storeThread({ account, input }) {
  const { threadKey, participant, messages, invalid, undated } = input;

  const seen = await storedExternalIds(account.id, messages.map((message) => message.externalId));
  const { fresh, skipped } = splitStored(messages, seen);

  // Who this thread is, resolved before anything is written rather than after.
  // It used to be worked out only when something inbound arrived, which meant
  // a thread of our own messages was stored with nothing saying who they were
  // to. Done for every thread that has anything new in it, so the person key
  // goes onto outbound messages as well.
  const rows = fresh.length
    ? await anty.from("wl_outreach")
      .select("id,account_id,crm_contact_id,person_name,person_linkedin,status,created_at")
      .eq("account_id", account.id).rows()
    : [];
  const match = fresh.length ? matchOutreachRow(rows, participant) : null;

  await insertMessages(account.id, threadKey, participant, fresh, match?.crm_contact_id ?? null);

  const inbound = fresh.filter((message) => message.direction === "in");
  const outcome = { matchedOutreachId: match?.id ?? null, statusMoved: false, crm: "skipped" };

  if (inbound.length && match) {
    // The newest inbound message is the one that proves they answered.
    const newest = inbound.reduce((latest, message) => (message.sentAt > latest.sentAt ? message : latest));
    outcome.statusMoved = await markReplied(match, newest.sentAt);
    if (match.crm_contact_id) {
      outcome.crm = await writeCrmActivity({
        accountId: account.id,
        contactId: match.crm_contact_id,
        accountName: account.login?.trim() || account.label,
        body: newest.body
      });
    }
  }

  return { stored: fresh.length, skipped: skipped.length, invalid, undated, threadKey, ...outcome };
}

/**
 * Every message stored for one person, newest first.
 *
 * Two ways of belonging, and both are needed for a while. Messages stored from
 * this phase on carry `meta.crmContactId` and are simply filtered. Everything
 * stored before it has no person key at all, so those are matched the old way —
 * on the LinkedIn slug, then the name — which is the matching that breaks when
 * somebody renames their profile. **Older messages are not backfilled**, so a
 * person's history is exact from here on and best-effort behind.
 */
export async function messagesForContact({ accountId, crmContactId, personName, personLinkedin }, limit = 200) {
  if (!accountId) return [];
  const rows = await anty.from("wl_events").select("id,account_id,type,meta,created_at")
    .eq("account_id", accountId).in("type", MESSAGE_TYPES)
    .order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows();

  const wantedSlug = linkedinSlug(personLinkedin);
  const wantedName = cleanName(personName).toLowerCase();

  return rows
    .filter((row) => {
      const meta = row.meta || {};
      if (meta.crmContactId) return String(meta.crmContactId) === String(crmContactId);
      const participant = meta.participant || {};
      if (wantedSlug && linkedinSlug(participant.slug) === wantedSlug) return true;
      const name = cleanName(participant.name).toLowerCase();
      return Boolean(wantedName) && !NON_NAMES.has(wantedName) && name === wantedName;
    })
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      kind: "message",
      direction: row.type === MESSAGE_IN ? "in" : "out",
      at: row.meta?.sentAt || row.created_at,
      storedAt: row.created_at,
      body: row.meta?.body || "",
      threadKey: row.meta?.threadKey || "",
      truncated: Boolean(row.meta?.truncated),
      // How this message was recognised as theirs — worth showing, because the
      // second way is a guess that a rename can break.
      matchedBy: row.meta?.crmContactId ? "contact_id" : "name_or_slug"
    }));
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
    storedAt: event.created_at
  };
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
export function deriveThreads(events, { readMarks = new Map(), syncedAt = new Map() } = {}) {
  const threads = new Map();

  for (const event of events) {
    const threadKey = event.meta?.threadKey;
    if (!threadKey || !event.account_id) continue;
    const key = threadId(event.account_id, threadKey);
    const message = toMessage(event);

    let thread = threads.get(key);
    if (!thread) {
      thread = {
        threadKey,
        accountId: event.account_id,
        participant: normalizeParticipant(event.meta?.participant),
        participantSeenAt: event.created_at,
        lastMessage: null,
        messageCount: 0,
        newestInboundStoredAt: null
      };
      threads.set(key, thread);
    }

    thread.messageCount += 1;
    // The newest event carrying a participant wins: a headline that changed, or
    // a name the agent could only resolve on the second run, should be current.
    if (event.meta?.participant && event.created_at >= thread.participantSeenAt) {
      thread.participant = normalizeParticipant(event.meta.participant);
      thread.participantSeenAt = event.created_at;
    }
    if (!thread.lastMessage
      || message.sentAt > thread.lastMessage.sentAt
      || (message.sentAt === thread.lastMessage.sentAt && message.storedAt > thread.lastMessage.storedAt)) {
      thread.lastMessage = message;
    }
    if (message.direction === "in" && (!thread.newestInboundStoredAt || message.storedAt > thread.newestInboundStoredAt)) {
      thread.newestInboundStoredAt = message.storedAt;
    }
  }

  return [...threads.values()].map((thread) => {
    const readAt = readMarks.get(threadId(thread.accountId, thread.threadKey)) || null;
    return {
      threadKey: thread.threadKey,
      accountId: thread.accountId,
      participant: thread.participant,
      lastMessage: thread.lastMessage && {
        direction: thread.lastMessage.direction,
        body: thread.lastMessage.body,
        sentAt: thread.lastMessage.sentAt
      },
      messageCount: thread.messageCount,
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

/** The newest read mark per thread, and the newest sync per account. */
async function marks(accountId = null) {
  const read = new Map();
  const synced = new Map();

  let readQuery = anty.from("wl_events").select("account_id,meta,created_at").eq("type", READ_TYPE);
  let syncQuery = anty.from("wl_events").select("account_id,meta,created_at").eq("type", SYNCED_TYPE);
  if (accountId) {
    readQuery = readQuery.eq("account_id", accountId);
    syncQuery = syncQuery.eq("account_id", accountId);
  }

  const [readRows, syncRows] = await Promise.all([
    readQuery.order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows(),
    syncQuery.order("created_at", { ascending: false }).limit(LISTING_LIMIT).rows()
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

  return { read, synced };
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
    lastSyncedAt: times.sort().pop() || null
  };
}

/** Threads across every account, or one account, unread first then newest. */
export async function listThreads({ accountId = null, unreadOnly = false } = {}) {
  const [events, { read, synced }] = await Promise.all([messageEvents({ accountId }), marks(accountId)]);
  const threads = deriveThreads(events, { readMarks: read, syncedAt: synced });
  return unreadOnly ? threads.filter((thread) => thread.unread) : threads;
}

/** One conversation, oldest first — the shape the thread screen renders. */
export async function readThread({ accountId, threadKey }) {
  const [events, { read, synced }] = await Promise.all([
    messageEvents({ accountId, threadKey }),
    marks(accountId)
  ]);
  const [thread] = deriveThreads(events, { readMarks: read, syncedAt: synced });
  if (!thread) return null;

  const messages = events.map(toMessage)
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt) || left.storedAt.localeCompare(right.storedAt))
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

  const rows = await anty.from("wl_outreach")
    .select("id,account_id,crm_contact_id,person_name,person_linkedin,status,created_at")
    .in("account_id", accountIds).rows();

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
