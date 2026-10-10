import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The ESP's journal: everything the cold-email side does, written once and never
 * changed.
 *
 * One line per event in a JSON-lines file next to the workspace state
 * (`ESP_JOURNAL_PATH`, else `esp-journal.jsonl` beside `STATE_FILE_PATH`). It is
 * the record a dispute is settled from — what exactly went to whom, from which
 * sender, when, and who changed what — so three things are true of it:
 *
 * 1. **Only appended.** There is no update and no delete, in this module or in
 *    any route over it. A correction is a new event that says so. The file is
 *    opened for append only (`O_APPEND`), each line is written in one call and
 *    synced to disk before the caller is told it is recorded.
 * 2. **Tamper-evident.** Every line carries the hash of the one before it
 *    (`prev`) and its own (`hash`, SHA-256 over `prev` and its content). Editing
 *    or removing a line anywhere breaks the chain from there on, and `verify()`
 *    says where. It does not stop somebody with the disk from rewriting the
 *    whole file; it makes doing it quietly impossible.
 * 3. **Exact.** A sent message is recorded with the very text and headers that
 *    were handed to the provider (`recordSent` in `esp/messages.mjs`), not a
 *    template and its variables — the template may change tomorrow; what the
 *    person received may not.
 *
 * A line torn by a crash mid-write (no newline, not JSON) at the very end is
 * left where it is, reported by `verify()` and skipped: the chain continues
 * from the last whole line. Nothing is ever cut out of the file to "repair" it.
 *
 * Events: `{ seq, at, type, actor, contact, data, prev, hash }`. `contact` is a
 * lower-cased email address when the event is about one person — that is what
 * a contact's timeline is read by — and `null` otherwise.
 *
 * **One exception to «never changed»: a person's request to be forgotten**
 * (ESP 17, `eraseContact`). The law outranks the journal, so that person's
 * lines lose the address and every word about them — what stays is what the
 * counts need (which sender, which campaign, which step, a bounce code). Each
 * such line keeps its `prev` and its `hash` and is marked `redacted: <seq>`,
 * pointing at the `contact.erased` line appended in the same write, which
 * lists every line it touched. So the chain still proves nothing was removed
 * or reordered; only the redacted lines' own content can no longer be checked,
 * and `verify()` reports any redacted line no erasure accounts for.
 */

const GENESIS = "0".repeat(64);

let journalPath = null;
let loaded = null;
let tail = Promise.resolve();

export function defaultJournalPath(env = process.env) {
  if (env.ESP_JOURNAL_PATH) return env.ESP_JOURNAL_PATH;
  const state = env.STATE_FILE_PATH || ".data/outbound-state.json";
  return `${dirname(state)}/esp-journal.jsonl`;
}

/** Point the journal at a file. For the server once at start, and for tests between cases. */
export function useJournal(path) {
  journalPath = path;
  loaded = null;
  tail = Promise.resolve();
}

function currentPath() {
  if (!journalPath) journalPath = defaultJournalPath();
  return journalPath;
}

/** An email as the journal keys people: trimmed and lower-cased, or null when it is not one. */
export function contactKey(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The hash a line must carry: over the previous hash and everything else in it. */
export function hashOf(entry, prev) {
  const { seq, at, type, actor, contact, data } = entry;
  return createHash("sha256").update(prev).update("\n").update(canonical({ seq, at, type, actor, contact, data })).digest("hex");
}

async function load() {
  if (loaded) return loaded;
  const entries = [];
  const problems = [];
  let raw = "";
  try {
    raw = await readFile(currentPath(), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const lines = raw.split("\n");
  const endsWhole = raw === "" || raw.endsWith("\n");
  let prev = GENESIS;
  lines.forEach((line, index) => {
    if (!line) return;
    const last = index === lines.length - 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      problems.push({ line: index + 1, problem: last && !endsWhole ? "torn" : "not_json" });
      return;
    }
    if (entry.prev !== prev) problems.push({ line: index + 1, seq: entry.seq, problem: "chain_broken" });
    else if (!entry.redacted && hashOf(entry, entry.prev) !== entry.hash) problems.push({ line: index + 1, seq: entry.seq, problem: "hash_mismatch" });
    entries.push(entry);
    prev = entry.hash;
  });
  // A redacted line is only as good as the erasure that says it touched it.
  const erasures = new Map(entries.filter((entry) => entry.type === "contact.erased").map((entry) => [entry.seq, new Set(entry.data?.entries || [])]));
  for (const entry of entries) {
    if (entry.redacted && !erasures.get(entry.redacted)?.has(entry.seq)) problems.push({ seq: entry.seq, problem: "redaction_unaccounted" });
  }
  loaded = { entries, problems, endsWhole, byContact: indexByContact(entries) };
  return loaded;
}

function indexByContact(entries) {
  const index = new Map();
  for (const entry of entries) {
    if (!entry.contact) continue;
    if (!index.has(entry.contact)) index.set(entry.contact, []);
    index.get(entry.contact).push(entry);
  }
  return index;
}

/**
 * Write one event. Resolves with the event as recorded, once it is on disk.
 * One at a time: two writers must not both chain onto the same `prev`.
 */
export function append({ type, actor = "system", contact = null, data = {} }) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(String(type || ""))) {
    return Promise.reject(Object.assign(new Error(`Невідомий тип події журналу: ${type}`), { statusCode: 400 }));
  }
  const run = tail.catch(() => {}).then(async () => {
    const state = await load();
    const last = state.entries.at(-1);
    const entry = {
      seq: (last?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      type,
      actor: String(actor || "system").slice(0, 200),
      contact: contact ? contactKey(contact) : null,
      data: data && typeof data === "object" ? data : { value: data },
      prev: last?.hash ?? GENESIS
    };
    entry.hash = hashOf(entry, entry.prev);
    await mkdir(dirname(currentPath()), { recursive: true });
    const handle = await open(currentPath(), "a");
    try {
      // A torn last line from a crash is left alone, and this line starts on
      // its own: the torn one stays visible to `verify()`, nothing is lost.
      await handle.write(`${state.endsWhole ? "" : "\n"}${JSON.stringify(entry)}\n`);
      await handle.datasync();
    } finally {
      await handle.close();
    }
    state.endsWhole = true;
    state.entries.push(entry);
    if (entry.contact) {
      if (!state.byContact.has(entry.contact)) state.byContact.set(entry.contact, []);
      state.byContact.get(entry.contact).push(entry);
    }
    return entry;
  });
  tail = run;
  return run;
}

/**
 * What a forgotten person leaves in the exclusions: a hash of the address, so
 * the same address is refused again without the journal holding it.
 */
export function erasureKey(value) {
  const key = contactKey(value);
  return key ? `erased:${createHash("sha256").update("esp-erasure\n").update(key).digest("hex")}` : null;
}

// What a redacted line about the person keeps: enough for the counts (a
// sender's day, a domain's bounces, a campaign's steps, an A/B variant), no
// address, no name, no text, no subject, no ids that lead back to the letter.
const KEPT_WHEN_ERASED = ["from", "sender", "campaignId", "step", "sendingSeq", "code", "reason", "label", "kind", "via", "category", "variantIds", "needsRecheck"];

function keepCounts(data) {
  const kept = {};
  for (const name of KEPT_WHEN_ERASED) if (data && data[name] !== undefined) kept[name] = data[name];
  return kept;
}

function scrubAddress(value, address) {
  if (typeof value === "string") return value.replace(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[видалено]");
  if (Array.isArray(value)) return value.map((item) => scrubAddress(item, address));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrubAddress(item, address)]));
  return value;
}

/**
 * ESP 17: forget a person. Their lines keep only `KEPT_WHEN_ERASED` and lose
 * the address; any other line that names them gets «[видалено]» in its place;
 * a `contact.erased` line records the hash (`erasureKey`) and which lines were
 * touched. The file is rewritten once — to a temporary file, synced, renamed
 * over — in the same queue as `append`, so no line is written in between.
 *
 * Refused while the file has a problem `verify()` would report: rewriting it
 * would quietly drop a torn line, and nothing is ever cut out of the journal.
 */
export function eraseContact(contact, { actor = "system", note = "" } = {}) {
  const address = contactKey(contact);
  if (!address) return Promise.reject(Object.assign(new Error("Це не адреса пошти."), { statusCode: 400 }));
  const run = tail.catch(() => {}).then(async () => {
    const state = await load();
    if (state.problems.length || !state.endsWhole) {
      throw Object.assign(new Error("Журнал має пошкоджені рядки — спершу перевірка журналу, потім видалення."), { statusCode: 409 });
    }
    const last = state.entries.at(-1);
    const seq = (last?.seq ?? 0) + 1;
    const touched = [];
    const next = state.entries.map((entry) => {
      const own = entry.contact === address;
      if (!own && !JSON.stringify(entry.data ?? {}).toLowerCase().includes(address)) return entry;
      touched.push(entry.seq);
      return { ...entry, contact: own ? null : entry.contact, data: own ? keepCounts(entry.data) : scrubAddress(entry.data, address), redacted: seq };
    });
    const erased = {
      seq,
      at: new Date().toISOString(),
      type: "contact.erased",
      actor: String(actor || "system").slice(0, 200),
      contact: null,
      data: { key: erasureKey(address), entries: touched, note: String(note || "").slice(0, 300) },
      prev: last?.hash ?? GENESIS
    };
    erased.hash = hashOf(erased, erased.prev);
    const path = currentPath();
    const temporary = `${path}.erase-${process.pid}-${Date.now()}`;
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(temporary, "w");
    try {
      await handle.write([...next, erased].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      await handle.datasync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    await rename(temporary, path);
    state.entries = [...next, erased];
    state.byContact = indexByContact(state.entries);
    return erased;
  });
  tail = run;
  return run;
}

/** Events, newest first, filtered by type prefix and/or contact. */
export async function entries({ type = "", contact = "", limit = 200, before = null } = {}) {
  const state = await load();
  const key = contact ? contactKey(contact) : null;
  const source = key ? (state.byContact.get(key) ?? []) : state.entries;
  const found = [];
  for (let at = source.length - 1; at >= 0 && found.length < limit; at -= 1) {
    const entry = source[at];
    if (before && entry.seq >= before) continue;
    if (type && entry.type !== type && !entry.type.startsWith(`${type}.`)) continue;
    found.push(entry);
  }
  return found;
}

/** Every event about one person, oldest first — the contact card's timeline. */
export async function timeline(contact) {
  const state = await load();
  const key = contactKey(contact);
  return key ? [...(state.byContact.get(key) ?? [])] : [];
}

/** All events, oldest first — for the registry and anything else that folds the journal. */
export async function allEntries() {
  return [...(await load()).entries];
}

/** Whether the file is the chain it claims to be, and where it is not. */
export async function verify() {
  // Read from disk, not from memory — but only once nothing is half-written.
  await tail.catch(() => {});
  loaded = null;
  const state = await load();
  return {
    ok: state.problems.length === 0,
    count: state.entries.length,
    lastSeq: state.entries.at(-1)?.seq ?? 0,
    lastHash: state.entries.at(-1)?.hash ?? GENESIS,
    problems: state.problems
  };
}
