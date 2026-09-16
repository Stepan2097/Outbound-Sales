import { createRestClient } from "./rest.mjs";

/**
 * The two databases the warm-up talks to.
 *
 * `anty` is the Supabase that Anty syncs into — it holds both the browser
 * profiles and this feature's own wl_* tables, which is why an account and the
 * browser it runs in stay one object rather than two systems kept in step.
 *
 * `crm` is a different Supabase project holding the lead queue, read-only from
 * here: the CRM is somebody else's system of record, and what we did with a
 * contact belongs in wl_outreach where it can be undone without touching it.
 * It defaults to the workspace's existing Supabase, which is the same project.
 */

function required(pairs) {
  return Object.entries(pairs).filter(([, value]) => !value).map(([name]) => name);
}

export const anty = createRestClient({
  label: "The Anty database",
  resolve() {
    const url = (process.env.ANTY_SUPABASE_URL || "").replace(/\/+$/, "");
    const key = process.env.ANTY_SERVICE_ROLE_KEY || "";
    return { url, key, missing: required({ ANTY_SUPABASE_URL: url, ANTY_SERVICE_ROLE_KEY: key }) };
  }
});

/**
 * Only the address and the key are required. The folder and the owner used to
 * be as well, which pinned the queue to one of the CRM's twenty-six folders for
 * the life of the deployment; they are now the starting values for targeting a
 * person chooses in the app, and an installation that sets neither is
 * configured — it simply has nothing picked yet.
 */
export const crm = createRestClient({
  label: "The CRM",
  resolve() {
    const url = (process.env.WARMUP_CRM_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
    const key = process.env.WARMUP_CRM_SERVICE_ROLE_KEY || process.env.SUPABASE_API_KEY || "";
    return {
      url,
      key,
      folderId: process.env.WARMUP_CRM_LEADS_FOLDER_ID || "",
      ownerId: process.env.WARMUP_CRM_LEADS_OWNER_ID || "",
      missing: required({ WARMUP_CRM_SUPABASE_URL: url, WARMUP_CRM_SERVICE_ROLE_KEY: key })
    };
  }
});

/** The Anty team whose profiles this workspace warms. Empty means every team. */
export function antyTeamId() {
  return process.env.ANTY_TEAM_ID || "";
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * How many contact ids go into one `in.(...)`: PostgREST caps a URL long before
 * it caps a list, so every question asked of the CRM about a set of contacts is
 * asked in batches. The set is small by construction — a ceiling of twenty-two
 * approaches a day is what makes it so.
 */
export const CONTACT_ID_BATCH = 120;

const LEAD_COLUMNS = "id,name,company,position,linkedin,country,email,phone,created_at,description";

/**
 * The queue, defined in exactly one place. Every caller — the list, the total
 * under it, the forecast, the re-read before a request is sent — has to mean
 * the same set of people, or the total says one thing and the list another.
 *
 * A blank filter is everyone, not nobody: the four inputs narrow the folder,
 * and an empty box has to mean the box is not in use.
 */
export function queueQuery(columns, targeting) {
  const { country, position, leadStatus, ownerId } = targeting.filters;
  let query = crm.from("contacts").select(columns).eq("folder_id", targeting.folderId);
  if (leadStatus) query = query.eq("lead_status", leadStatus);
  if (ownerId) query = query.eq("owner_id", ownerId);
  if (country) query = query.ilike("country", country);
  if (position) query = query.ilike("position", `*${position}*`);
  return query;
}

/** How many people the folder and the filters come to. */
export async function queueTotal(targeting) {
  return queueQuery("id", targeting).count();
}

/** One page of candidates, newest added first. */
export async function leadQueue({ limit, offset = 0, targeting }) {
  const rows = await queueQuery(LEAD_COLUMNS, targeting)
    .order("created_at", { ascending: false })
    .limit(limit)
    .rows();
  // PostgREST pages with Range headers; an offset this small is cheaper to take
  // from the page than to negotiate, and the caller over-fetches anyway because
  // people already approached are filtered out afterwards.
  return offset ? rows.slice(offset) : rows;
}

/**
 * One contact by id, without the queue filter — this is the re-read before a
 * connection request is recorded, and a contact whose status changed while the
 * panel was open should still produce an honest snapshot of who was approached.
 */
export async function leadById(id) {
  return crm.from("contacts").select(LEAD_COLUMNS).eq("id", id).maybeSingle();
}

export function crmError(error) {
  const message = error instanceof Error ? error.message : "";
  // `fetch failed` is all Node says when the host is not there at all, and on a
  // screen it reads as a bug in this app rather than as a CRM nobody can reach.
  return !message || message === "fetch failed" ? "The CRM did not answer" : message;
}
