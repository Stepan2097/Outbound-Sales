import { createRestClient, likeLiteral } from "./rest.mjs";

/**
 * The two databases the warm-up talks to.
 *
 * `anty` is the Supabase that Anty syncs into — it holds both the browser
 * profiles and this feature's own wl_* tables, which is why an account and the
 * browser it runs in stay one object rather than two systems kept in step.
 *
 * `crm` is a different Supabase project holding the lead queue. Its contacts
 * are read-only from here: the CRM is somebody else's system of record, and
 * what we did with a contact belongs in wl_outreach where it can be undone
 * without touching it. The one write is append-only — a line on a contact's
 * activity timeline for each message and each connection request, so the
 * sales team sees the conversation where they already work — and it happens in
 * `activities.mjs` and nowhere else.
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
 * What a contact's LinkedIn column has to hold for anybody to be sent a
 * request: a profile link. A blank column, a company page or a Sales Navigator
 * link is nowhere the agent can click Connect, and `toSend[].linkedin` is the
 * only thing it opens — so a contact without one is not in the queue at all,
 * rather than in it and then held forever as `profile_gone`.
 */
export const PROFILE_LINK_PATTERN = "*linkedin.com/in/*";

/**
 * The queue, defined in exactly one place. Every caller — the list, the total
 * under it, the forecast, the re-read before a request is sent — has to mean
 * the same set of people, or the total says one thing and the list another.
 *
 * A blank filter is everyone, not nobody: the four inputs narrow the folder,
 * and an empty box has to mean the box is not in use. The profile link is not
 * one of the four: it is not a choice, it is what a LinkedIn queue is made of.
 */
export function queueQuery(columns, targeting) {
  const { country, position, leadStatus, ownerId } = targeting.filters;
  let query = crm.from("contacts").select(columns).eq("folder_id", targeting.folderId)
    .ilike("linkedin", PROFILE_LINK_PATTERN);
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

/**
 * One page of the queue's ids and profile links, newest added first.
 *
 * Paged by the server rather than fetched and sliced: slicing carried every
 * earlier page again to reach the next one. `id` breaks the ties, because a
 * folder imported in one statement shares one `created_at`, and OFFSET over
 * ties is free to hand the same person to two pages and skip somebody else.
 * The link comes along because one person entered twice is two ids and one
 * profile, and the walk steps over the second by the profile.
 */
export async function queuePage({ targeting, offset = 0, limit }) {
  return queueQuery("id,linkedin", targeting)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .offset(offset)
    .limit(limit)
    .rows();
}

/** These contacts in full, in the order asked for, if they are still in the queue. */
export async function queueLeads(targeting, ids) {
  if (!ids.length) return [];
  const rows = await queueQuery(LEAD_COLUMNS, targeting).in("id", ids).rows();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * One contact by id, without the queue filter — this is the re-read before a
 * connection request is recorded, and a contact whose status changed while the
 * panel was open should still produce an honest snapshot of who was approached.
 */
export async function leadById(id) {
  return crm.from("contacts").select(LEAD_COLUMNS).eq("id", id).maybeSingle();
}

/** How many candidates one profile slug may bring back before the exact check. */
const SLUG_CANDIDATES = 50;

/**
 * How a profile link can end once the slug is over: nothing, a path, a query.
 * Every way a seller pastes one — with or without the trailing slash, with a
 * `?trk=` — and never a longer slug that happens to start with this one.
 */
const SLUG_ENDINGS = ["", "/*", "?*"];

/**
 * The two spellings a profile slug is asked for in, each made literal for an
 * `ilike` pattern: as read, and percent-encoded, because a CRM column holds
 * whatever a seller pasted and a Cyrillic profile link arrives spelled both
 * ways. The encoded one is nothing but `%` signs, which is why the escaping
 * matters (`likeLiteral`).
 */
export function slugLikeForms(slug) {
  return [...new Set([slug, encodeURIComponent(slug)])].map(likeLiteral);
}

/**
 * The contacts whose LinkedIn column could be this profile, oldest first.
 *
 * Candidates, not an answer: `ilike` ignores case, and only the caller's slug
 * comparison (`linkedinSlug` in `inbox.mjs`) can say which of them is the same
 * person. That comparison stays in one place rather than being copied here,
 * where a second spelling of it would drift. The slug itself goes in literal,
 * so each page of candidates holds links that really carry it.
 *
 * By default only links that end where the slug ends. `prefix` asks for any
 * link that starts with it — `marta` then also finds `marta-kovalenko` — which
 * catches the spellings the endings do not (a fragment, a trailing space), and
 * is the caller's second question, not its first: a short slug can start more
 * contacts than one page of candidates holds.
 *
 * Asked in both spellings of `slugLikeForms` when the slug is not plain ASCII.
 */
export async function leadsByLinkedin(slug, { prefix = false } = {}) {
  if (!slug) return [];
  const patterns = [];
  for (const form of slugLikeForms(slug)) {
    for (const ending of prefix ? ["*"] : SLUG_ENDINGS) patterns.push(`*linkedin.com/in/${form}${ending}`);
  }
  // The folder comes along so a person held twice can be settled on the
  // contact a running campaign is working (`contactBySlug`).
  const pages = await Promise.all(patterns.map((pattern) => crm.from("contacts").select("id,linkedin,folder_id,created_at")
    .ilike("linkedin", pattern)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(SLUG_CANDIDATES)
    .rows()));
  const found = new Map();
  for (const row of pages.flat()) if (!found.has(row.id)) found.set(row.id, row);
  return [...found.values()].sort((left, right) =>
    String(left.created_at || "").localeCompare(String(right.created_at || "")) || String(left.id).localeCompare(String(right.id)));
}

export function crmError(error) {
  const message = error instanceof Error ? error.message : "";
  // `fetch failed` is all Node says when the host is not there at all, and on a
  // screen it reads as a bug in this app rather than as a CRM nobody can reach.
  return !message || message === "fetch failed" ? "CRM не відповіла" : message;
}
