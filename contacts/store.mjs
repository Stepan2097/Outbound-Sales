import { crm } from "../warmup/db.mjs";
import { listFolders } from "../warmup/targeting.mjs";
import { createHash } from "node:crypto";
import { createReadCache } from "./read-cache.mjs";

/**
 * The CRM's contacts, read for the Contacts screen.
 *
 * The CRM is somebody else's system of record, so everything here is a read.
 * It is the same Supabase project and the same client the warm-up already talks
 * to — one place that knows where the contacts live, rather than a second
 * connection with its own idea of the schema.
 */

// Everything the CRM keeps about a person, minus the two columns that are not
// for reading: `fts` is a search vector and `deleted_owner_email` is a tombstone.
const CONTACT_COLUMNS = [
  "id", "created_at", "name", "email", "phone", "lifecycle_stage", "owner_id", "lead_status",
  "linkedin", "facebook", "instagram", "twitter", "telegram", "folder_id", "company", "position",
  "category", "website", "description", "country", "custom_fields"
].join(",");

// The list needs less than the card does, and a folder of twenty-two thousand
// is a good reason not to carry custom_fields through a page of rows.
const LIST_COLUMNS = "id,name,company,position,country,email,phone,linkedin,telegram,lead_status,created_at";

export const MAX_PAGE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reads = createReadCache();
// Temporary compatibility path for installations without CRM migration rights.
// It is not the indexed implementation and must stay disabled after migration.
const legacyIndexes = createReadCache({ maxEntries: 4, maxBytes: 32 * 1024 * 1024, cloneValues: false });
const MINUTE = 60000;

// The authenticated caller supplies the user/workspace scope. Call sites that
// do not have one deliberately bypass caching, including pre-write checks.
function cacheKey(cacheScope, kind, ...parts) {
  if (!cacheScope) return null;
  const { url, key } = crm.config();
  const database = createHash("sha256").update(`${url}\0${key}`).digest("hex");
  return JSON.stringify([database, cacheScope, kind, ...parts]);
}

export function invalidateContactCaches({ contactId, folderId } = {}) {
  if (!contactId && !folderId) { reads.invalidate(); legacyIndexes.invalidate(); return; }
  // Search results and folder counts can contain the changed contact even if
  // the caller does not know its old folder (for example after a CRM move).
  reads.invalidate(["folders", "search", "pages", "counts", ...(contactId ? [`contact:${contactId}`] : []), ...(folderId ? [`folder:${folderId}`] : [])]);
  legacyIndexes.invalidate(["search"]);
}

function contactCount({ cacheScope, folderId, term = "", fresh = false }, load) {
  return reads.read(cacheKey(cacheScope, "count", folderId, term), { ttl: MINUTE, fresh, tags: ["counts", `folder:${folderId}`] }, load);
}

/**
 * Never ask the CRM for a uuid we have not looked at.
 *
 * Postgres answers a malformed one with `invalid input syntax for type uuid:
 * "queue"`, which travels all the way to a seller's screen as a database error
 * about a folder they picked from a list. Worse, that sentence is identical
 * whichever field was wrong — the contact id from a path or the folder id from
 * a body — so it says nothing about where to look. Checked here, the answer
 * names the field and the value instead.
 */
function badUuid(field, value) {
  const error = new Error(`${field} має бути ідентифікатором, а прийшло «${String(value).slice(0, 40)}». Вибери папку зі списку заново.`);
  error.statusCode = 400;
  return error;
}

export function contactsConfigured() {
  return crm.configured();
}

export function contactsMissingConfig() {
  return crm.missing();
}

export async function listContactFolders({ cacheScope, fresh = false } = {}) {
  return reads.read(cacheKey(cacheScope, "folders"), { ttl: MINUTE, fresh, tags: ["folders"] }, () => listFolders());
}

/**
 * Which key this workspace is reading the CRM with.
 *
 * It matters because the wrong one fails silently: a publishable/anon key is
 * accepted, answers 200, and returns nothing at all under row-level security —
 * which on screen is indistinguishable from a CRM with no folders in it. The
 * claim is read out of the JWT without verifying it; this is a hint for a
 * sentence on a screen, not a security decision.
 */
/**
 * What kind of Supabase key this is, read from the key itself.
 *
 * Exported separately from `crmKeyKind` because there is more than one key in
 * play — the CRM client's and the one Auth signs in with — and they are
 * configured apart. One definition of "what can this key see" keeps the two
 * from drifting into two different ideas of the same question.
 *
 * The claim is read without verifying the signature: this decides what to say
 * on a screen, never what somebody may do.
 */
export function supabaseKeyKind(keyValue) {
  const key = String(keyValue || "");
  if (!key) return "missing";
  if (key.startsWith("sb_secret_")) return "service_role";
  if (key.startsWith("sb_publishable_")) return "anon";
  try {
    const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64").toString("utf8"));
    return claims.role === "service_role" ? "service_role" : claims.role === "anon" ? "anon" : "unknown";
  } catch {
    return "unknown";
  }
}

export function crmKeyKind() {
  try {
    return supabaseKeyKind(crm.config().key);
  } catch {
    return "missing";
  }
}

/**
 * One page of a folder, newest first, with the total beside it.
 *
 * The search covers the four things somebody actually types — a name, a
 * company, a title, an address — and is deliberately not the CRM's full-text
 * column: `fts` is built by the CRM for its own screens, and a search that
 * behaves differently here than there is worse than a simpler one.
 */
export async function listFolderContacts({ folderId = "", search = "", limit = 25, offset = 0, queueOrder = false, cacheScope, fresh = false } = {}) {
  // A folder is required, and not out of tidiness: without one this is a page
  // of every contact in the CRM plus an exact count of the whole table, and on
  // a real base that query comes back as a statement timeout.
  if (!folderId) {
    const error = new Error("Спочатку обери папку — без неї запит іде по всій базі CRM.");
    error.statusCode = 400;
    throw error;
  }
  if (!UUID.test(folderId)) throw badUuid("Папка", folderId);
  const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE);
  const from = Math.max(Number(offset) || 0, 0);
  const term = String(search || "").trim().replace(/[(),*]/g, " ").trim();

  const build = (columns) => {
    let query = crm.from("contacts").select(columns).eq("folder_id", folderId);
    if (term) {
      query = query.or(`name.ilike.*${term}*,company.ilike.*${term}*,position.ilike.*${term}*,email.ilike.*${term}*`);
    }
    return query;
  };

  return reads.read(cacheKey(cacheScope, "page", folderId, term, size, from, Boolean(queueOrder)),
    { ttl: MINUTE, fresh, tags: ["pages", `folder:${folderId}`] }, async () => {
      const [contacts, total] = await Promise.all([
        build(LIST_COLUMNS).order("created_at", { ascending: queueOrder }).order("id", { ascending: queueOrder }).limit(size).offset(from).rows(),
        // Rows and total share the page's lifetime. Reusing a nearly expired
        // standalone count here would keep that old total for another minute.
        build("id").count()
      ]);
      return { contacts, total, limit: size, offset: from };
    });
}

/** One contact, with everything the CRM knows about them. */
export async function readContact(id, { cacheScope, fresh = false } = {}) {
  // A malformed id is nobody we have — answered as "not found" rather than
  // handed to Postgres, which would reply with a type error about a table the
  // person reading it has never heard of.
  if (!id || !UUID.test(id)) return null;
  return reads.read(cacheKey(cacheScope, "contact", id), { ttl: 30000, fresh, tags: [`contact:${id}`] },
    () => crm.from("contacts").select(CONTACT_COLUMNS).eq("id", id).maybeSingle());
}

/**
 * The CRM row as this workspace's own lead shape, for the moment somebody takes
 * a contact into the queue. The CRM id travels with it, so the same person
 * imported twice stays one lead.
 */
export function contactAsProspect(contact = {}) {
  return {
    name: contact.name || "",
    title: contact.position || "",
    company: contact.company || "",
    location: contact.country || "",
    website: contact.website || "",
    linkedin: contact.linkedin || "",
    email: contact.email || "",
    phone: contact.phone || "",
    telegram: contact.telegram || "",
    notes: contact.description || "",
    source: "crm_contacts",
    crmSource: {
      contact_id: contact.id,
      folder_id: contact.folder_id,
      lead_status: contact.lead_status,
      lifecycle_stage: contact.lifecycle_stage,
      owner_id: contact.owner_id
    }
  };
}

/**
 * The contact standing at one position in a folder, and how many there are.
 *
 * The Панель works a folder from the top down instead of letting somebody
 * browse it, so what it asks for is not a page — it is "number thirty-seven"
 * and "of how many". The order is the folder's own history, oldest first, with
 * the id as a tie-break: without a second, stable key two contacts created in
 * the same millisecond can swap places between two requests, and then the
 * position a seller stopped at points at a different person tomorrow.
 */
export async function folderContactAt({ folderId = "", index = 0, search = "", contactId = "", cacheScope } = {}) {
  if (!folderId) {
    const error = new Error("Спочатку обери папку — без неї запит іде по всій базі CRM.");
    error.statusCode = 400;
    throw error;
  }
  if (!UUID.test(folderId)) throw badUuid("Папка", folderId);
  if (contactId) {
    const contact = await readContact(contactId, { cacheScope });
    if (!contact || contact.folder_id !== folderId) {
      const error = new Error("Контакт більше не знаходиться в цій папці.");
      error.statusCode = 404;
      throw error;
    }
    const [total, position] = await Promise.all([
      contactCount({ cacheScope, folderId }, () => crm.from("contacts").select("id").eq("folder_id", folderId).count()),
      crm.from("contacts").select("id").eq("folder_id", folderId)
        .or(`created_at.lt.${contact.created_at},and(created_at.eq.${contact.created_at},id.lt.${contact.id})`).count()
    ]);
    return { contact, total, index: position };
  }
  const position = Math.max(Math.trunc(Number(index) || 0), 0);
  const term = String(search || "").trim().replace(/[(),*]/g, " ").trim();
  const build = (columns) => {
    const query = crm.from("contacts").select(columns).eq("folder_id", folderId);
    return term ? query.or(`name.ilike.*${term}*,company.ilike.*${term}*,position.ilike.*${term}*,email.ilike.*${term}*`) : query;
  };
  const [rows, total] = await Promise.all([
    build(CONTACT_COLUMNS)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .offset(position)
      .rows(),
    contactCount({ cacheScope, folderId, term }, () => build("id").count())
  ]);
  return { contact: rows[0] || null, total, index: position };
}

const searchText = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
async function legacyFolderSearchIndex(folderId, cacheScope, fresh) {
  return legacyIndexes.read(cacheKey(cacheScope, "legacy-index", folderId), { ttl: MINUTE, fresh, tags: ["search"] }, async () => {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await crm.from("contacts").select(LIST_COLUMNS).eq("folder_id", folderId).order("id").limit(1000).offset(offset).rows();
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return rows;
  });
}
function wordSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length < 3 || right.length < 3) return 0;
  const grams = (word) => { const set = new Set(); for (let i = 0; i < word.length - 1; i++) set.add(word.slice(i, i + 2)); return set; };
  const a = grams(left), b = grams(right);
  let common = 0;
  for (const gram of a) if (b.has(gram)) common++;
  return 2 * common / (a.size + b.size);
}
export function rankContactMatches(contacts, search) {
  const term = searchText(search).slice(0, 120);
  if (!term) return [];
  const tokens = term.split(/\s+/);
  const best = [];
  const compare = (a, b) => b.score - a.score || String(a.contact.id).localeCompare(String(b.contact.id));
  const keep = (contact, score) => {
    if (!score) return;
    const match = { contact, score };
    if (best.length === 5 && compare(match, best[4]) >= 0) return;
    best.push(match);
    best.sort(compare);
    if (best.length > 5) best.pop();
  };
  const directScore = (field) => field === term ? 100 : field.startsWith(term) ? 90 : field.includes(term) ? 80 : 0;
  const fieldsByContact = contacts.map((contact) => ({
    contact, fields: [contact.name, contact.company, contact.email, contact.position].map(searchText)
  }));
  for (const { contact, fields } of fieldsByContact) keep(contact, Math.max(...fields.map(directScore)));
  // Exact/prefix/substring results always outrank a fuzzy score (at most60).
  // Most keystrokes stop here, avoiding word-gram work across the whole folder.
  if (best.length === 5) return best.map((item) => item.contact);
  for (const { contact, fields } of fieldsByContact) {
    if (fields.some((field) => directScore(field))) continue;
    const scores = fields.map((field) => {
      const words = field.split(/[\s@._-]+/);
      const matches = tokens.map((token) => Math.max(0, ...words.map((word) => word.includes(token) ? 1 : wordSimilarity(token, word))));
      if (matches.some((score) => score < 0.5)) return 0;
      return 60 * matches.reduce((sum, score) => sum + score, 0) / tokens.length;
    });
    keep(contact, Math.max(...scores));
  }
  return best.map((item) => item.contact);
}

export async function searchFolderContacts({ folderId = "", search = "", cacheScope, fresh = false } = {}) {
  if (!UUID.test(folderId)) throw badUuid("Папка", folderId);
  const term = searchText(search).slice(0, 120);
  if (!term) return { contacts: [] };
  const indexed = process.env.CONTACTS_INDEXED_SEARCH === "1";
  return reads.read(cacheKey(cacheScope, "search", folderId, term, indexed), { ttl: MINUTE, fresh, tags: ["search", `folder:${folderId}`] }, async () => {
    if (!indexed) return { contacts: rankContactMatches(await legacyFolderSearchIndex(folderId, cacheScope, fresh), term) };
    try {
      const contacts = await crm.rpc("outbound_search_contacts", { p_folder_id: folderId, p_search: term }).select(LIST_COLUMNS).rows();
      return { contacts: contacts.slice(0, 5) };
    } catch (error) {
      if (error.code === "PGRST202" || error.code === "42883") {
        const unavailable = new Error("Пошук CRM ще не оновлено: потрібна міграція outbound_search_contacts.");
        unavailable.statusCode = 503;
        throw unavailable;
      }
      throw error;
    }
  });
}
