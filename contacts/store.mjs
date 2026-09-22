import { crm } from "../warmup/db.mjs";
import { listFolders } from "../warmup/targeting.mjs";

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

export async function listContactFolders() {
  return listFolders();
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
export async function listFolderContacts({ folderId = "", search = "", limit = 25, offset = 0 } = {}) {
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

  const [contacts, total] = await Promise.all([
    build(LIST_COLUMNS).order("created_at", { ascending: false }).limit(size).offset(from).rows(),
    build("id").count()
  ]);

  return { contacts, total, limit: size, offset: from };
}

/** One contact, with everything the CRM knows about them. */
export async function readContact(id) {
  // A malformed id is nobody we have — answered as "not found" rather than
  // handed to Postgres, which would reply with a type error about a table the
  // person reading it has never heard of.
  if (!id || !UUID.test(id)) return null;
  return crm.from("contacts").select(CONTACT_COLUMNS).eq("id", id).maybeSingle();
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
export async function folderContactAt({ folderId = "", index = 0 } = {}) {
  if (!folderId) {
    const error = new Error("Спочатку обери папку — без неї запит іде по всій базі CRM.");
    error.statusCode = 400;
    throw error;
  }
  if (!UUID.test(folderId)) throw badUuid("Папка", folderId);
  const position = Math.max(Math.trunc(Number(index) || 0), 0);
  const [rows, total] = await Promise.all([
    crm.from("contacts").select(CONTACT_COLUMNS).eq("folder_id", folderId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .offset(position)
      .rows(),
    crm.from("contacts").select("id").eq("folder_id", folderId).count()
  ]);
  return { contact: rows[0] || null, total, index: position };
}
