import { crm } from "./db.mjs";
import { linkedinSlug } from "./outreach.mjs";

/**
 * People who wrote to a warm-up account and are in nobody's CRM yet.
 *
 * The CRM is somebody else's system of record, and until now the warm-up only
 * ever added a line to a contact's timeline (`activities.mjs`). This is the
 * second write, and it exists because the owner asked for it: every person who
 * appears in a conversation is added to the contact base, in a folder of their
 * own, so a reply never comes from somebody the sales team cannot open.
 *
 * It is deliberately narrow, and it is the only place a contact is created:
 *
 * - **Only a person with a LinkedIn profile and a name.** A thread LinkedIn
 *   would not name, a group thread with no `/in/` link, and LinkedIn's own
 *   notices are not people, and a contact made from them would be a row nobody
 *   could ever match again.
 * - **Never a second copy.** The caller looks the profile up first
 *   (`contactBySlug` in `inbox.mjs`); here it is only created when that found
 *   nobody, and two accounts reading the same person at once make one contact
 *   (`once`).
 * - **A folder of its own**, found by name or made — never one of the team's
 *   working folders, so nothing here can add a person to a campaign's queue.
 * - **A switch**: `INBOX_ADOPT_CONTACTS=0` turns the whole thing off, and a CRM
 *   that refuses the write costs the message nothing — it is stored and its
 *   copy is owed, exactly as when the CRM cannot be asked who somebody is.
 */

export const ADOPT_FOLDER_DEFAULT = "Вхідні розмови LinkedIn";

/** Said on the contact, so the team can tell who was added by hand and who by a conversation. */
export const ADOPT_SOURCE = "linkedin_inbox";

export function adoptionEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.INBOX_ADOPT_CONTACTS ?? "1").trim());
}

export function adoptionFolderName(env = process.env) {
  return String(env.INBOX_CONTACTS_FOLDER || "").trim() || ADOPT_FOLDER_DEFAULT;
}

/**
 * The words LinkedIn puts in front of a name for screen readers: a profile card
 * is labelled "Переглянути профіль Sinan", and the agent stores that label as
 * the name. The person is Sinan.
 */
const NAME_NOISE = /^(?:переглянути\s+профіль|view\s+profile\s+of|view\s+profile)(?:\s+|$)/i;

/** Who writes on LinkedIn's behalf, and the placeholders for nobody. None of them is a person to call. */
const NOT_PEOPLE = new Set([
  "unknown", "member", "linkedin member", "linkedin user", "deleted member", "deleted user",
  "linkedin", "linkedin team", "the linkedin team", "linkedin corporation", "linkedin news",
  "linkedin premium", "linkedin talent solutions", "linkedin learning", "linkedin jobs", "sponsored"
]);

/**
 * Whether a name is really a sentence about a picture: "Переглянути профіль
 * Sinan", "View profile of Sinan", "View Sinan's profile". LinkedIn writes these
 * for screen readers on an avatar; read as a name they mean that what was read
 * was the avatar and not the person — which is how a picture-only row is told
 * from a message even when it was stored as an attachment.
 */
export function hasProfileWords(name) {
  const text = String(name ?? "").replace(/\s+/g, " ").trim();
  return NAME_NOISE.test(text) || /^view\s+.+['’]s\s+profile/i.test(text);
}

/** The person's name as it should stand in the CRM, or "" when there is none. */
export function personName(participant) {
  return String(participant?.name || "").replace(/\s+/g, " ").trim().replace(NAME_NOISE, "").trim();
}

/** A member's profile slug, or "" for anything that is not one (a company page, a school, nothing). */
function memberSlug(participant) {
  if (participant?.memberProfile === false) return "";
  const slug = linkedinSlug(participant?.slug);
  return slug && !slug.includes(":") ? slug : "";
}

/** Whether this participant is somebody who can be put in the CRM at all. */
export function adoptable(participant) {
  const name = personName(participant);
  if (!name || NOT_PEOPLE.has(name.toLowerCase())) return false;
  return Boolean(memberSlug(participant));
}

/** The profile link the contact is stored with — the same one `contactBySlug` finds it by next time. */
export function profileLink(participant) {
  return `https://www.linkedin.com/in/${encodeURIComponent(memberSlug(participant))}`;
}

// -- the folder -------------------------------------------------------------

let folderLookup = null;
let folderLookupName = "";

/** For tests, which change the folder name and the database between cases. */
export function forgetAdoptionFolder() {
  folderLookup = null;
  folderLookupName = "";
}

/**
 * The folder the people go into: the live one with this name, or a new one.
 *
 * Remembered for the life of the process — it is asked once, not once a thread —
 * and forgotten again when it failed, so a CRM that was down when the first
 * person arrived is asked afresh for the second. An archived folder of the same
 * name is not used: somebody put it away on purpose.
 */
export async function adoptionFolderId() {
  const name = adoptionFolderName();
  if (folderLookup && folderLookupName === name) return folderLookup;
  folderLookupName = name;
  folderLookup = (async () => {
    const found = await crm.from("contact_folders").select("id,is_archived").eq("name", name).rows();
    const live = found.find((row) => !row.is_archived);
    if (live) return live.id;
    const owner = crm.config().ownerId;
    const [made] = await crm.from("contact_folders").insert({ name, ...(owner ? { owner_id: owner } : {}) }).select("id").rows();
    if (!made?.id) throw new Error(`The CRM did not say which folder «${name}» is`);
    return made.id;
  })();
  folderLookup.catch(() => {
    folderLookup = null;
  });
  return folderLookup;
}

// -- the contact ------------------------------------------------------------

const inFlight = new Map();

/**
 * One person at a time: two logins reading the same stranger in the same
 * minute would each find nobody and each make a contact. The second waits for
 * the first and then runs, finds the first's contact, and makes none.
 */
export function once(key, work) {
  const run = (inFlight.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  inFlight.set(key, run);
  const forget = () => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  };
  run.then(forget, forget);
  return run;
}

/**
 * Make the contact. Only what is known goes in: a name, the profile link, the
 * headline as the position, the folder, and a note saying where the person came
 * from. Nothing the CRM may have its own opinion about — status, stage, owner
 * unless the workspace names one — is invented here.
 */
export async function createContact({ participant, accountName = "" }) {
  const folderId = await adoptionFolderId();
  const owner = crm.config().ownerId;
  const row = {
    name: personName(participant),
    linkedin: profileLink(participant),
    ...(participant.headline ? { position: String(participant.headline).slice(0, 300) } : {}),
    folder_id: folderId,
    ...(owner ? { owner_id: owner } : {}),
    description: `Додано автоматично: ${accountName ? `написав(ла) на акаунт ${accountName}` : "з'явився(лась) у розмові LinkedIn"}.`,
    custom_fields: { source: ADOPT_SOURCE }
  };
  const [made] = await crm.from("contacts").insert(row).select("id").rows();
  if (!made?.id) throw new Error("The CRM did not say which contact it made");
  return made.id;
}
