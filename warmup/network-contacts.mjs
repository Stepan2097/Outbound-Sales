import { accountName } from "./activities.mjs";
import { crm } from "./db.mjs";
import { contactBySlug } from "./inbox.mjs";
import { adoptable, adoptionEnabled, once, personName, profileLink } from "./people.mjs";

/**
 * Друзі LinkedIn-акаунтів — у базу (власник 16.10: «на лінкедин акаунтах є купа
 * друзів які ще не в базі даних створи нову папку в базі даних і туди їх всіх
 * додай»).
 *
 * After each read of an account's friends (warmup/network.mjs, `network.done`)
 * every friend the CRM has no contact for — matched by profile link, the same
 * way a person who wrote in is (`contactBySlug`) — becomes a contact in a
 * folder of its own. Somebody already in the CRM is left where they are.
 * One person at a time (`once`, shared with people.mjs), so a friend of two
 * accounts, or one who also wrote in, is one contact.
 *
 * Off with the same switch as the inbox's adoption, INBOX_ADOPT_CONTACTS=0;
 * the folder is NETWORK_CONTACTS_FOLDER, else «Друзі LinkedIn-акаунтів».
 */

export const NETWORK_FOLDER_DEFAULT = "Друзі LinkedIn-акаунтів";
export const NETWORK_SOURCE = "linkedin_network";

export function networkFolderName(env = process.env) {
  return String(env.NETWORK_CONTACTS_FOLDER || "").trim() || NETWORK_FOLDER_DEFAULT;
}

let folderLookup = null;

/** The folder: the live one with this name, or a new one (owned as the inbox's folder is). */
export async function networkFolderId() {
  if (folderLookup) return folderLookup;
  const name = networkFolderName();
  folderLookup = (async () => {
    const found = await crm.from("contact_folders").select("id,is_archived").eq("name", name).rows();
    const live = found.find((row) => !row.is_archived);
    if (live) return live.id;
    let owner = crm.config().ownerId;
    if (!owner) owner = (await crm.from("contact_folders").select("owner_id").limit(1).maybeSingle())?.owner_id || "";
    const [made] = await crm.from("contact_folders").insert({ name, ...(owner ? { owner_id: owner } : {}) }).select("id").rows();
    if (!made?.id) throw new Error(`The CRM did not say which folder «${name}» is`);
    return made.id;
  })();
  folderLookup.catch(() => { folderLookup = null; });
  return folderLookup;
}

/** For tests. */
export function forgetNetworkFolder() {
  folderLookup = null;
}

async function createFriend(person, accountLabel, folderId) {
  const owner = crm.config().ownerId;
  const row = {
    name: personName(person),
    linkedin: profileLink(person),
    ...(person.headline ? { position: String(person.headline).slice(0, 300) } : {}),
    folder_id: folderId,
    ...(owner ? { owner_id: owner } : {}),
    description: `Додано автоматично: у друзях LinkedIn акаунта ${accountLabel}${person.connectedAt ? ` з ${person.connectedAt}` : ""}.`,
    custom_fields: { source: NETWORK_SOURCE, linkedin_account: accountLabel, ...(person.connectedAt ? { connected_at: person.connectedAt } : {}) }
  };
  const [made] = await crm.from("contacts").insert(row).select("id").rows();
  if (!made?.id) throw new Error("The CRM did not say which contact it made");
  return made.id;
}

/**
 * One account's friends into the CRM. `people` — as warmup/network.mjs keeps
 * them ({ slug, name, headline, connectedAt }). Returns the counts.
 * `lookup` and `create` are for tests.
 */
export async function adoptNetwork({ account, people, lookup = contactBySlug, create = createFriend, folderId = networkFolderId, concurrency = 6, env = process.env }) {
  const result = { checked: 0, inCrm: 0, added: 0, skipped: 0, failed: 0, lastError: null };
  if (!adoptionEnabled(env)) return { ...result, off: true };
  const label = typeof account === "string" ? account : accountName(account);
  const list = (Array.isArray(people) ? people : []).filter((person) => {
    const ok = adoptable({ name: person?.name, slug: person?.slug });
    if (!ok) result.skipped += 1;
    return ok;
  });
  if (!list.length) return result;
  const folder = await folderId();
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const person = list[next++];
      try {
        const made = await once(`profile:${person.slug}`, async () => {
          if (await lookup(person.slug)) return false;
          await create(person, label, folder);
          return true;
        });
        made ? (result.added += 1) : (result.inCrm += 1);
      } catch (error) {
        result.failed += 1;
        result.lastError = error.message;
      }
      result.checked += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return result;
}
