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

export const crm = createRestClient({
  label: "The CRM",
  resolve() {
    const url = (process.env.WARMUP_CRM_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
    const key = process.env.WARMUP_CRM_SERVICE_ROLE_KEY || process.env.SUPABASE_API_KEY || "";
    const folderId = process.env.WARMUP_CRM_LEADS_FOLDER_ID || "";
    const ownerId = process.env.WARMUP_CRM_LEADS_OWNER_ID || "";
    return {
      url,
      key,
      folderId,
      ownerId,
      missing: required({
        WARMUP_CRM_SUPABASE_URL: url,
        WARMUP_CRM_SERVICE_ROLE_KEY: key,
        WARMUP_CRM_LEADS_FOLDER_ID: folderId,
        WARMUP_CRM_LEADS_OWNER_ID: ownerId
      })
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

const LEAD_COLUMNS = "id,name,company,position,linkedin,country,email,phone,created_at,description";

/**
 * The queue, defined in exactly one place. Every caller — the list, the count,
 * the re-read before a request is sent — has to mean the same set of people, or
 * the total says one thing and the list another.
 */
function queueQuery(columns) {
  const config = crm.config();
  return crm.from("contacts").select(columns).eq("folder_id", config.folderId).eq("lead_status", "new").eq("owner_id", config.ownerId);
}

/** One page of candidates, newest added first. */
export async function leadQueue({ limit, offset = 0 }) {
  const rows = await queueQuery(LEAD_COLUMNS)
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
  return error instanceof Error ? error.message : "The CRM did not answer";
}
