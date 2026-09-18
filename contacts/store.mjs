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
  if (!id) return null;
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
