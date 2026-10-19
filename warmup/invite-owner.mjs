import { crm } from "./db.mjs";

/**
 * Who answers for a person once a LinkedIn account has asked them to connect
 * (власник 19.10: «всі акаунти які додаєш в друзі позначай на б.найборовського»).
 * The CRM contact's owner becomes this user the moment the request goes out —
 * by the agent or recorded by hand. WARMUP_INVITED_OWNER_EMAIL changes who;
 * «off» leaves owners as they are.
 */
export const INVITED_OWNER_DEFAULT = "b.naiborovskyi@gmail.com";

export function invitedOwnerEmail(env = process.env) {
  const value = String(env.WARMUP_INVITED_OWNER_EMAIL ?? "").trim();
  if (/^(0|off|false|no)$/i.test(value)) return "";
  return (value || INVITED_OWNER_DEFAULT).toLowerCase();
}

let lookup = null;

/** The CRM user's id for that email, asked once and remembered; null when there is none. */
export async function invitedOwnerId(env = process.env) {
  const email = invitedOwnerEmail(env);
  if (!email) return null;
  if (lookup?.email !== email) {
    const promise = crm.from("profiles").select("id").ilike("email", email).limit(1).rows().then((rows) => rows[0]?.id ?? null);
    lookup = { email, promise };
    promise.catch(() => { if (lookup?.promise === promise) lookup = null; });
  }
  return lookup.promise;
}

/** For tests. */
export function forgetInvitedOwner() {
  lookup = null;
}

/** The contact is this user's now. A CRM that refuses costs the invitation nothing — it is said in the log. */
export async function assignInvitedOwner(crmContactId, { env = process.env, log = console } = {}) {
  if (!crmContactId) return false;
  try {
    const owner = await invitedOwnerId(env);
    if (!owner) return false;
    await crm.from("contacts").update({ owner_id: owner }).eq("id", crmContactId).rows();
    return true;
  } catch (error) {
    log.warn?.(`[warmup] invited contact owner (${crmContactId}): ${error.message}`);
    return false;
  }
}
