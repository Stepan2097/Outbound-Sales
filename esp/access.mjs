import { allEntries, append, contactKey, entries } from "./journal.mjs";

/**
 * Who may do what on the cold-email side, and the log of what administrators did.
 *
 * Built on what the workspace already has (the owner, 09.10: roles and secrets
 * in Outbound's own mechanisms): the two roles from «Налаштування» — admin and
 * seller — give the defaults, and an administrator may grant a person one more
 * right, or take one of the seller's defaults away. Grants are journal lines
 * (`access.granted` / `access.revoked`), so "who allowed this, when" is never a
 * guess, and they are folded the same way the registry is.
 *
 * An administrator has every right and cannot lose one: a workspace where the
 * last admin revoked their own `access.manage` could not be repaired from the
 * screen. `access.manage` itself is never granted to a seller — making somebody
 * an administrator is the role, set in «Команда», and that is logged too.
 *
 * The rights the checklist names (ESP 10: «хто може запускати кампанії, міняти
 * ліміти, бачити відповіді») plus the ones the rest of the ESP needs. ESP 4/5
 * check theirs with `can(profile, "campaigns.launch")` and friends.
 */

export const ESP_PERMISSIONS = {
  "campaigns.launch": "Запускати, ставити на паузу й зупиняти кампанії",
  "limits.change": "Міняти ліміти: етап рампи, стан доменів і скриньок",
  "replies.read": "Бачити відповіді й точні тексти листів",
  // ESP 14: the team's inbox — a quick reply from the lead's sender, a corrected label.
  "replies.write": "Відповідати людям зі спільної вхідної й виправляти мітки відповідей",
  "registry.change": "Додавати й виводити домени та скриньки",
  "templates.edit": "Редагувати шаблони листів і підпис",
  "stop.all": "Натискати «стоп усе»",
  "journal.read": "Читати весь журнал і журнал дій адміністраторів",
  "access.manage": "Видавати й забирати доступи, бачити стан секретів"
};

export const ROLE_DEFAULTS = {
  admin: Object.keys(ESP_PERMISSIONS),
  seller: ["replies.read"]
};

/** Never handed to a seller: being able to hand out rights is being an administrator. */
const ADMIN_ONLY = new Set(["access.manage"]);

/** What counts as an administrator's action in the log: the registry, the rights, the country list, and `admin.*`. */
export const ADMIN_EVENT_PREFIXES = ["domain.", "sender.", "access.", "admin.", "filters."];

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/** Each person's grants and revocations, from the journal. */
export async function grants() {
  const found = new Map();
  for (const entry of await allEntries()) {
    if (entry.type !== "access.granted" && entry.type !== "access.revoked") continue;
    const { email, permission } = entry.data || {};
    if (!found.has(email)) found.set(email, { granted: new Set(), revoked: new Set(), history: [] });
    const person = found.get(email);
    if (entry.type === "access.granted") { person.granted.add(permission); person.revoked.delete(permission); }
    else { person.revoked.add(permission); person.granted.delete(permission); }
    person.history.push({ seq: entry.seq, at: entry.at, actor: entry.actor, type: entry.type, permission });
  }
  return found;
}

/** The rights this person has right now. */
export async function permissionsOf(profile, held = null) {
  const role = profile?.role === "admin" ? "admin" : "seller";
  if (role === "admin") return new Set(ROLE_DEFAULTS.admin);
  const email = contactKey(profile?.email);
  const person = email ? (held ?? await grants()).get(email) : null;
  const rights = new Set(ROLE_DEFAULTS.seller);
  for (const permission of person?.granted ?? []) if (!ADMIN_ONLY.has(permission)) rights.add(permission);
  for (const permission of person?.revoked ?? []) rights.delete(permission);
  return rights;
}

export async function can(profile, permission) {
  return (await permissionsOf(profile)).has(permission);
}

/** Give a seller one more right, or take one away. Only with `access.manage`. */
export async function changeAccess({ email, permission, grant }, actor) {
  if (!(await can(actor, "access.manage"))) throw fail("Доступи видає лише адміністратор.", 403);
  const key = contactKey(email);
  if (!key) throw fail("Це не адреса пошти.");
  if (!ESP_PERMISSIONS[permission]) throw fail("Такого права немає.");
  if (ADMIN_ONLY.has(permission)) throw fail("Це право — роль адміністратора; її міняють у «Команді».", 409);
  const actorEmail = contactKey(actor?.email) || String(actor?.email || "");
  // Already so — nothing to write. Judged on the seller's rights: an admin has
  // everything anyway, and a grant matters the day they are a seller again.
  const rights = await permissionsOf({ email: key, role: "seller" });
  if (grant ? rights.has(permission) : !rights.has(permission)) return null;
  return append({
    type: grant ? "access.granted" : "access.revoked", actor: actorEmail,
    data: { email: key, permission, label: ESP_PERMISSIONS[permission] }
  });
}

/**
 * An administrator did something outside the ESP's own registry — changed a
 * role, added or removed a person, picked a model for somebody, set a key,
 * edited a template, lifted a mailbox pause. One line each, with who and what;
 * never the secret itself.
 */
export async function logAdminAction(action, actor, data = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(action)) throw fail(`Невідома дія: ${action}`);
  const clean = Object.fromEntries(Object.entries(data || {}).filter(([key]) => !/key|secret|token|password/i.test(key)));
  // The same person under one name, however their sign-in spelled the address.
  return append({ type: `admin.${action}`, actor: contactKey(actor) || String(actor || "system"), data: clean });
}

/** The administrators' log: registry changes, grants and `admin.*`, newest first. */
export async function adminLog({ limit = 100, before = null } = {}) {
  const found = [];
  for (const prefix of ADMIN_EVENT_PREFIXES) {
    found.push(...await entries({ type: prefix.slice(0, -1), limit: 2000, before }));
  }
  return found.sort((left, right) => right.seq - left.seq).slice(0, limit);
}

/** The whole picture for the screen: the matrix, each person's changes, and the caller's own rights. */
export async function accessView(profile) {
  const held = await grants();
  return {
    permissions: ESP_PERMISSIONS,
    roles: ROLE_DEFAULTS,
    mine: [...await permissionsOf(profile, held)],
    people: await Promise.all([...held.entries()].map(async ([email, person]) => ({
      email,
      granted: [...person.granted],
      revoked: [...person.revoked],
      rights: [...await permissionsOf({ email, role: "seller" }, held)],
      history: person.history
    })))
  };
}
