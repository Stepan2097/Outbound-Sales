import { anty, crm, CONTACT_ID_BATCH } from "./db.mjs";
import { logEvent } from "./store.mjs";

/**
 * A person's LinkedIn conversation, copied onto their CRM contact.
 *
 * The sales team works in the CRM. A reply that exists only in this portal is a
 * reply half the company cannot see, and a timeline that shows their answer
 * without what we wrote to them is half a conversation. So every message of a
 * synced thread — ours and theirs — and every connection request that went out
 * becomes one line on the contact's `activities` timeline.
 *
 * **Once each, and the key is kept on our side.** The CRM contract asks the CRM
 * for an `external_id` with a unique index and an `occurred_at` (see "Add or
 * confirm" in CRM_API_CONTRACT.md); neither has been confirmed, and a column
 * the table does not have fails the insert outright. So a line carries nothing
 * the bridge in `server.mjs` does not already send — `contact_id`, `type`,
 * `content` — the real time goes into the text, and the key is the `wl_events`
 * row the line was made from: a stored message, which the inbox's duplicate
 * suppression already stores exactly once, or the event that recorded a
 * request. A copy that landed leaves a `crm.copied` marker naming those rows;
 * one that did not leaves an `inbox.crm_failed` naming them, and the next sync
 * tries again (`outstandingCopies`). When the CRM confirms `external_id`, the
 * marker becomes that column and this file is the only one that changes.
 *
 * Best-effort, like the single write it replaced: the message is stored before
 * any of this runs, so a CRM that is down costs a copy, never the fact.
 *
 * **Every write to the CRM's `activities` from the warm-up happens here.**
 */

export const CRM_COPIED = "crm.copied";
export const CRM_FAILED = "inbox.crm_failed";

/**
 * How long a failed copy keeps being tried. A week of daily syncs outlasts any
 * outage worth waiting for; without an end, a contact deleted from the CRM
 * would be retried, and logged as failing, every morning for good.
 */
export const CRM_RETRY_DAYS = 7;

/** How many marker rows one look back reads. A week of one account's syncs is far below it. */
const LOG_LIMIT = 2000;

/** A line is kept to this many characters, marker included. */
export const CONTENT_LIMIT = 2000;
const CONTENT_MARKER = "… [обрізано]";

/**
 * Which login a line is about. The sales team reading it in the CRM has no
 * other way to know which of five accounts the person was talking to.
 */
export function accountName(account) {
  return account?.login?.trim() || account?.label || "акаунт без імені";
}

/**
 * A time the way a line in somebody else's system can carry it: absolute, in
 * UTC, and saying so. The app's screens let the browser format a time; nothing
 * formats it for the CRM, and "10:42" there would be read in whatever zone the
 * reader happens to be in.
 */
export function crmStamp(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return "час невідомий";
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function clampContent(text) {
  const value = String(text ?? "");
  if (value.length <= CONTENT_LIMIT) return value;
  return value.slice(0, CONTENT_LIMIT - CONTENT_MARKER.length) + CONTENT_MARKER;
}

/**
 * Write these lines to one contact, in the order given, and say which landed.
 *
 * One insert per line rather than one for all: the CRM stamps each row with
 * the moment it arrived, and a batch arrives as a single moment, read back in
 * whatever order the table likes — a conversation back to front. The first
 * failure stops the rest; a CRM that refused one line will not take the next a
 * millisecond later, and every line not written is owed all the same.
 *
 * `entries` are `{ eventId, content, since?, storedAt? }`: the row the line is
 * made from, the line, — on a retry — when it first failed, so the retry window
 * runs from the first failure rather than starting again on every attempt, and
 * when that row was written, which bounds the look for a copy already made.
 *
 * Each line is looked up among the `crm.copied` markers right before its
 * insert, not once for the batch: what the caller read as owed may have been
 * copied since by somebody else — a second server during a deploy, or a sync
 * reported twice — and the CRM has no key of ours to refuse a second copy with.
 * A line found there is passed over, neither written nor owed. A look that
 * fails is a failure like the insert's: nothing is written unchecked.
 *
 * `error` is for a copy that cannot even be tried: the CRM could not be asked
 * who the person is. The lines are owed exactly as though the insert had
 * failed, and the next sync asks again.
 */
export async function copyToCrm({ accountId, contactId, entries, error = null, now = new Date() }) {
  if (!entries?.length) return { written: 0, failed: 0 };

  const written = [];
  let stoppedAt = entries.length;
  let failure = error || (contactId ? null : new Error("no CRM contact to write to"));
  if (failure) stoppedAt = 0;
  const copied = failure ? null : copiedLedger(accountId, entries, now);
  if (!failure) {
    for (const [index, entry] of entries.entries()) {
      try {
        if (await copied.has(entry.eventId)) continue;
        await crm.from("activities").insert({
          contact_id: contactId,
          type: "linkedin",
          content: clampContent(entry.content)
          // `user_id` is left to the column's own default, which a service-role
          // insert resolves to null. That is right: nobody on the sales team
          // wrote this, and attributing it to whoever holds the key would be a
          // lie in a column people filter by.
        }).rows();
        written.push(String(entry.eventId));
      } catch (caught) {
        failure = caught;
        stoppedAt = index;
        break;
      }
    }
  }

  if (written.length) {
    const marker = await logEvent({
      accountId,
      type: CRM_COPIED,
      message: `${written.length} line${written.length === 1 ? "" : "s"} copied to the CRM contact`,
      meta: { contactId, eventIds: written }
    }, { returning: true });
    // The lines are in the CRM and nothing here says so: the next sync will
    // write them again. Said with the rows it concerns, so somebody can tell.
    if (!marker) console.error(`[warmup] CRM lines written but not recorded as copied (account ${accountId}): ${written.join(", ")}`);
  }

  const owed = entries.slice(stoppedAt);
  if (owed.length) {
    const at = now.toISOString();
    // Logged at warn rather than swallowed: a CRM that has been refusing for a
    // week is the thing nobody notices. No message text in here — this row is
    // shown in the account's log, and the text is somebody's private message.
    await logEvent({
      accountId,
      level: "warn",
      type: CRM_FAILED,
      message: `Stored, but the CRM did not take ${owed.length} line${owed.length === 1 ? "" : "s"} — tried again on the next sync: ${failure?.message || "unknown error"}`,
      meta: { contactId: contactId ?? null, owed: owed.map((entry) => ({ eventId: String(entry.eventId), since: entry.since || at })) }
    });
  }

  return { written: written.length, failed: owed.length };
}

/**
 * Which rows already have a copy, asked afresh each time: a reader of the
 * `crm.copied` markers that picks up where its last look ended.
 *
 * Bounded below by the oldest row among the entries — a marker for a row is
 * written after the row, and both times are the database's own — or, for an
 * entry that does not say when its row was written, by the retry window.
 */
function copiedLedger(accountId, entries, now) {
  const retryFloor = new Date(now.getTime() - CRM_RETRY_DAYS * 86_400_000).toISOString();
  const floors = entries.map((entry) => entry.storedAt || retryFloor).sort();
  let cursor = floors[0];
  const known = new Set();
  return {
    async has(eventId) {
      // Paged by time: a thread first read months ago and matched only now
      // can have more markers behind it than one read holds.
      for (;;) {
        const rows = await anty.from("wl_events").select("meta,created_at")
          .eq("account_id", accountId).eq("type", CRM_COPIED).gte("created_at", cursor)
          .order("created_at", { ascending: true }).limit(LOG_LIMIT).rows();
        let next = cursor;
        for (const row of rows) {
          for (const id of Array.isArray(row.meta?.eventIds) ? row.meta.eventIds : []) known.add(String(id));
          if (String(row.created_at) > next) next = String(row.created_at);
        }
        const advanced = next !== cursor;
        cursor = next;
        if (rows.length < LOG_LIMIT || !advanced) break;
      }
      return known.has(String(eventId));
    }
  };
}

/**
 * CRM copies for one account, one at a time.
 *
 * A copy reads what is owed, writes it, and only then records it — so two
 * that overlap both find the same lines owed and both write them. They did:
 * an `inbox.done` resent while the first was still retrying a backlog put
 * every owed line on the contact twice. The server is one process, so a queue
 * per account in memory is the whole lock; the second waits, then finds
 * nothing left to do.
 */
const copyQueues = new Map();

export function oneCopyAtATime(accountId, work) {
  const key = String(accountId);
  const run = (copyQueues.get(key) || Promise.resolve()).then(() => work());
  const settled = run.then(() => {}, () => {});
  copyQueues.set(key, settled);
  settled.then(() => { if (copyQueues.get(key) === settled) copyQueues.delete(key); });
  return run;
}

/**
 * What this account still owes the CRM: every row a copy failed for within
 * `CRM_RETRY_DAYS`, less every row a later copy landed.
 *
 * Both halves are read from the log because the log is the only place either
 * can live. Nothing in this codebase updates `wl_events` with any confidence
 * (see `probeEventWriteAccess`), so "done" is a second row rather than an edit
 * of the first. A row that failed twice is owed once, from its first failure.
 *
 * `inbox.crm_failed` rows written before this file existed name no rows, only
 * a contact, and are passed over: there is nothing in them to copy again.
 */
export async function outstandingCopies(accountId, now = new Date()) {
  const since = new Date(now.getTime() - CRM_RETRY_DAYS * 86_400_000).toISOString();
  const failures = await anty.from("wl_events").select("meta,created_at")
    .eq("account_id", accountId).eq("type", CRM_FAILED).gte("created_at", since)
    .order("created_at", { ascending: true }).limit(LOG_LIMIT).rows();

  const owed = new Map();
  for (const row of failures) {
    for (const entry of Array.isArray(row.meta?.owed) ? row.meta.owed : []) {
      if (!entry?.eventId) continue;
      const eventId = String(entry.eventId);
      const first = entry.since || row.created_at;
      if (String(first) < since) continue;
      const known = owed.get(eventId);
      owed.set(eventId, {
        eventId,
        // A later failure may know the contact an earlier one could not look up.
        contactId: known?.contactId || row.meta?.contactId || null,
        since: known && known.since < first ? known.since : first
      });
    }
  }
  if (!owed.size) return [];

  const copied = await anty.from("wl_events").select("meta")
    .eq("account_id", accountId).eq("type", CRM_COPIED).gte("created_at", since)
    .limit(LOG_LIMIT).rows();
  for (const row of copied) {
    for (const eventId of Array.isArray(row.meta?.eventIds) ? row.meta.eventIds : []) owed.delete(String(eventId));
  }
  return [...owed.values()];
}

/** The rows these copies were made from, so a retry can make the same line again. */
export async function sourceEvents(eventIds = []) {
  const ids = [...new Set(eventIds.filter(Boolean).map(String))];
  const found = [];
  for (let start = 0; start < ids.length; start += CONTACT_ID_BATCH) {
    found.push(...await anty.from("wl_events").select("id,account_id,type,meta,created_at")
      .in("id", ids.slice(start, start + CONTACT_ID_BATCH)).rows());
  }
  return found;
}
