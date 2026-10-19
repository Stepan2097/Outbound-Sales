import { anty, crm, CONTACT_ID_BATCH } from "./db.mjs";
import { logEvent } from "./store.mjs";
import { CONTACT_TYPE, MESSAGE_TYPES, contactBySlug } from "./inbox.mjs";
import { ADOPT_SOURCE } from "./people.mjs";
import { isMemberId, linkedinSlug } from "./outreach.mjs";

/**
 * Contacts the inbox made from a conversation, set right (власник 19.10:
 * «іноді показує тільки імя людини без прізвища… ти додаєш не робочі
 * посилання… і через це ти робиш дублі»).
 *
 * The messenger gives a first name and LinkedIn's member id, so such a contact
 * had a link that opens nothing and matched nobody — a second copy of somebody
 * already in the base. The agent opens each one's conversation, then their
 * profile (agent/lib/profiles.mjs), and says what LinkedIn calls them and where
 * their profile really is. Here that becomes the contact's link and full name —
 * or, when somebody already holds that profile, the copy is folded into them:
 * its conversation lines, tasks and folders move over and the copy is deleted
 * (the same merge the owner approved for the 129 on 16.10).
 *
 * Only ever contacts this system made (`custom_fields.source`), never one a
 * person entered.
 */
export const RESOLVE_PER_SESSION = 8;
export const PROFILE_RESOLVED = "profile.resolved";
export const PROFILE_UNRESOLVED = "profile.unresolved";
const RETRY_AFTER_MS = 3 * 86_400_000;
// `_` is LIKE's one character: «acoaa» and «acwaa», any case.
const MEMBER_LINK = "*linkedin.com/in/ac_aa*";

/** The member-id contacts this account's conversations are tied to, a few at a time, with their thread. */
export async function profilesToResolve(accountId, { limit = RESOLVE_PER_SESSION, now = Date.now() } = {}) {
  const contacts = await crm.from("contacts").select("id,linkedin,custom_fields")
    .ilike("linkedin", MEMBER_LINK).eq("custom_fields->>source", ADOPT_SOURCE).limit(1000).rows();
  const ids = contacts.filter((row) => isMemberId(linkedinSlug(row.linkedin))).map((row) => String(row.id));
  if (!ids.length) return [];

  const since = new Date(now - RETRY_AFTER_MS).toISOString();
  const tried = new Set((await anty.from("wl_events").select("meta").eq("type", PROFILE_UNRESOLVED).gte("created_at", since).limit(1000).rows())
    .map((row) => String(row.meta?.contactId ?? "")));

  const threads = new Map();
  for (let at = 0; at < ids.length; at += CONTACT_ID_BATCH) {
    const rows = await anty.from("wl_events").select("meta,created_at").eq("account_id", accountId)
      .in("type", [...MESSAGE_TYPES, CONTACT_TYPE]).in("meta->>crmContactId", ids.slice(at, at + CONTACT_ID_BATCH))
      .order("created_at", { ascending: false }).limit(1000).rows();
    for (const row of rows) {
      const contactId = String(row.meta?.crmContactId ?? "");
      if (!contactId || !row.meta?.threadKey) continue;
      const held = threads.get(contactId) || { threadKey: row.meta.threadKey, memberId: null };
      // The member id as LinkedIn wrote it — stored since 401ae6c — opens the
      // profile straight away; lowercased, it opens nothing and the thread is the way.
      const slug = String(row.meta?.participant?.slug || "");
      if (!held.memberId && isMemberId(slug) && slug !== slug.toLowerCase()) held.memberId = slug;
      threads.set(contactId, held);
    }
  }
  return [...threads].filter(([contactId]) => !tried.has(contactId)).slice(0, limit)
    .map(([contactId, held]) => ({ contactId, threadKey: held.threadKey, ...(held.memberId ? { memberId: held.memberId } : {}) }));
}

const oneWord = (name) => !/\s/.test(String(name || "").trim());

const plain = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** «Dany» and «Dany (Dan) Cuello», «Alan Casper, #HIRING» and «Alan Casper», «C» and «C Taylor». */
export function sameFirstName(conversationName, profileName) {
  const first = plain(conversationName).split(" ")[0];
  return Boolean(first) && plain(profileName).startsWith(first);
}

/** Every conversation tied to `from`, tied to `to` — a new mark each, because rows are not rewritten. */
async function retieThreads(from, to) {
  const rows = await anty.from("wl_events").select("account_id,meta").in("type", [...MESSAGE_TYPES, CONTACT_TYPE])
    .eq("meta->>crmContactId", from).limit(1000).rows();
  const seen = new Map();
  for (const row of rows) if (row.meta?.threadKey) seen.set(`${row.account_id}|${row.meta.threadKey}`, { accountId: row.account_id, threadKey: row.meta.threadKey });
  const marks = [...seen.values()].map((thread) => ({
    account_id: thread.accountId, level: "info", type: CONTACT_TYPE, message: "Thread tied to a CRM contact",
    meta: { threadKey: thread.threadKey, crmContactId: to, reason: "member-id copy merged" }
  }));
  if (marks.length) await anty.from("wl_events").insert(marks).rows();
  return marks.length;
}

/** The copy folded into the person: lines, tasks, folders over; the copy gone. */
async function mergeInto(copy, keep, headline) {
  await crm.from("activities").update({ contact_id: keep }).eq("contact_id", copy.id).rows();
  await crm.from("tasks").update({ contact_id: keep }).eq("contact_id", copy.id).rows();
  const folders = await crm.from("contact_folder_memberships").select("folder_id").eq("contact_id", copy.id).rows();
  if (folders.length) {
    const insert = crm.from("contact_folder_memberships").insert(folders.map((row) => ({ contact_id: keep, folder_id: row.folder_id })));
    insert.headers = { ...insert.headers, Prefer: "resolution=ignore-duplicates,return=minimal" };
    await insert.rows();
  }
  if (headline) {
    const [person] = await crm.from("contacts").select("position").eq("id", keep).rows();
    if (person && !String(person.position || "").trim()) await crm.from("contacts").update({ position: headline.slice(0, 300) }).eq("id", keep).rows();
  }
  await anty.from("wl_outreach").update({ crm_contact_id: keep }).eq("crm_contact_id", copy.id).rows();
  const threads = await retieThreads(copy.id, keep);
  await crm.from("contacts").remove().eq("id", copy.id).rows();
  return threads;
}

/** What the agent saw for one contact, applied. */
export async function applyResolved({ accountId, contactId, memberId = null, vanity = null, name = null, headline = null, failed = null }) {
  const [copy] = await crm.from("contacts").select("id,name,linkedin,position,custom_fields").eq("id", String(contactId || "")).rows();
  if (!copy) return { ok: false, status: 404, error: "Контакту вже немає" };
  if (copy.custom_fields?.source !== ADOPT_SOURCE || !isMemberId(linkedinSlug(copy.linkedin))) {
    return { ok: false, status: 409, error: "Цей контакт не з розмови або вже виправлений" };
  }
  const slug = vanity ? linkedinSlug(`https://www.linkedin.com/in/${vanity}`) : "";
  if (failed || !slug || slug.includes(":") || isMemberId(slug)) {
    await logEvent({ accountId, level: "warn", type: PROFILE_UNRESOLVED, message: `Profile not resolved: ${failed || "no profile address"}`,
      meta: { contactId: copy.id, reason: failed || "no_profile_address", memberId } });
    return { ok: true, resolved: false };
  }

  const fullName = String(name || "").replace(/\s+/g, " ").trim();
  // The profile must be the person of the conversation: the name read there
  // starts the name LinkedIn shows on the profile. A link taken from the wrong
  // place on the page would file somebody's conversation under a stranger.
  if (fullName && !sameFirstName(copy.name, fullName)) {
    await logEvent({ accountId, level: "warn", type: PROFILE_UNRESOLVED, message: `Profile not resolved: «${fullName}» is not «${copy.name}»`,
      meta: { contactId: copy.id, reason: "name_mismatch", memberId, vanity: slug, seen: fullName } });
    return { ok: true, resolved: false, mismatch: true };
  }
  const keep = await contactBySlug(slug);
  if (keep && String(keep) !== String(copy.id)) {
    const threads = await mergeInto(copy, keep, headline);
    await logEvent({ accountId, level: "info", type: PROFILE_RESOLVED, message: `${fullName || copy.name}: already in the CRM — the copy merged into them`,
      meta: { contactId: copy.id, mergedInto: keep, vanity: slug, memberId, threads } });
    return { ok: true, resolved: true, merged: true, contactId: keep };
  }

  const patch = { linkedin: `https://www.linkedin.com/in/${encodeURIComponent(slug)}` };
  // The full name when the contact had only the first one (or nothing better).
  if (fullName && fullName.split(" ").length >= 2 && (oneWord(copy.name) || fullName.toLowerCase().startsWith(String(copy.name || "").toLowerCase()))) patch.name = fullName.slice(0, 200);
  if (headline && !String(copy.position || "").trim()) patch.position = String(headline).slice(0, 300);
  await crm.from("contacts").update(patch).eq("id", copy.id).rows();
  await logEvent({ accountId, level: "info", type: PROFILE_RESOLVED, message: `${patch.name || copy.name}: profile link and name set from LinkedIn`,
    meta: { contactId: copy.id, vanity: slug, memberId, name: patch.name ?? null } });
  return { ok: true, resolved: true, merged: false, contactId: copy.id };
}
