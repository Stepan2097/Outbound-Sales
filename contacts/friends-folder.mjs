// «Усі друзі LinkedIn-акаунтів» — папка, якої в CRM немає (власник 16.10:
// «папка … зі всіма контактами які є в друзях лінкедин акаунтів» — «але ж їх не
// 349»).
//
// The CRM folder «Друзі LinkedIn-акаунтів» holds only the friends who were not
// in the base yet (349 of 1 088 on 16.10): a contact has one folder_id, and the
// other ~740 already sit in the folders the team works — moving them there
// would take them out of those folders and their campaigns. So this one is the
// workspace's own: every friend of every account (warmup/network.mjs) matched
// to their CRM contact by profile link, listed like a folder, nothing moved.
//
// Matching a thousand profiles is a few thousand CRM reads, so it is done in
// the background and remembered in a file beside the state: a friend found
// once is not looked up again, one not found is asked again after a day (the
// adoption may have just made them). Until a pass is over the folder shows the
// ones matched so far and says how many are left.

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { writeFileAtomic } from "../state/atomic-write.mjs";
import { CONTACT_ID_BATCH, crm } from "../warmup/db.mjs";

export const FRIENDS_FOLDER = "linkedin-friends";
export const FRIENDS_FOLDER_NAME = "Усі друзі LinkedIn-акаунтів";

const DAY = 86_400_000;
const ROWS_TTL = 60_000;
const LIST_COLUMNS = "id,name,company,position,country,email,phone,linkedin,telegram,lead_status,created_at";

async function contactRows(ids) {
  const rows = [];
  for (let start = 0; start < ids.length; start += CONTACT_ID_BATCH) {
    rows.push(...await crm.from("contacts").select(LIST_COLUMNS).in("id", ids.slice(start, start + CONTACT_ID_BATCH)).rows());
  }
  return rows;
}

const searchable = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export function friendsFolder({ network, path = null, lookup, fetchRows = contactRows, concurrency = 6, now = () => Date.now(), log = console } = {}) {
  let matches = null;
  let resolving = null;
  let rows = null;
  let rowsAt = 0;
  let rowsKey = "";

  async function load() {
    if (matches) return matches;
    matches = {};
    if (path && existsSync(path)) {
      try { matches = JSON.parse(await readFile(path, "utf8")).matches || {}; } catch { matches = {}; }
    }
    return matches;
  }
  async function save() {
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, JSON.stringify({ matches }));
  }

  const stale = (entry) => !entry || (!entry.id && now() - Date.parse(entry.at || 0) >= DAY);

  /** Look up every friend not matched yet. One pass at a time; a second call joins it. */
  function resolve() {
    if (resolving) return resolving;
    resolving = (async () => {
      const known = await load();
      const todo = (await network.everyone()).filter((person) => stale(known[person.slug]));
      let next = 0;
      let since = 0;
      const worker = async () => {
        while (next < todo.length) {
          const person = todo[next++];
          try {
            known[person.slug] = { id: (await lookup(person.slug)) || null, at: new Date(now()).toISOString() };
          } catch (error) {
            log.warn?.(`[contacts] friend ${person.slug}: ${error.message}`);
          }
          if (++since >= 50) { since = 0; await save(); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
      if (todo.length) await save();
      rows = null;
      return { checked: todo.length };
    })().finally(() => { resolving = null; });
    return resolving;
  }

  /** The matched contacts, newest friend first, each once; and how many friends wait to be looked up. */
  async function members() {
    const known = await load();
    const people = (await network.everyone())
      .sort((left, right) => String(right.connectedAt || "").localeCompare(String(left.connectedAt || "")));
    const ids = [];
    const seen = new Set();
    let pending = 0;
    for (const person of people) {
      const entry = known[person.slug];
      if (!entry) { pending += 1; continue; }
      if (entry.id && !seen.has(entry.id)) { seen.add(entry.id); ids.push(entry.id); }
    }
    return { ids, pending, friends: people.length };
  }

  async function contacts() {
    const { ids } = await members();
    const key = ids.join(",");
    if (rows && key === rowsKey && now() - rowsAt < ROWS_TTL) return rows;
    const byId = new Map((await fetchRows(ids)).map((row) => [String(row.id), row]));
    rows = ids.map((id) => byId.get(String(id))).filter(Boolean);
    rowsKey = key;
    rowsAt = now();
    return rows;
  }

  function kick() {
    resolve().catch((error) => log.warn?.(`[contacts] friends folder: ${error.message}`));
  }

  return {
    resolve,
    kick,
    /** The folder as the folder list shows it. Starts a lookup pass when friends wait for one. */
    async folder() {
      const { ids, pending, friends } = await members();
      if (pending && !resolving) kick();
      return { id: FRIENDS_FOLDER, name: FRIENDS_FOLDER_NAME, contactCount: ids.length, system: "friends-all", pending, friends };
    },
    /** One page, as /api/contacts answers for a CRM folder. */
    async page({ search = "", limit = 25, offset = 0 } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), 100);
      const from = Math.max(Number(offset) || 0, 0);
      const terms = searchable(search).split(/\s+/).filter(Boolean);
      const all = await contacts();
      const shown = terms.length
        ? all.filter((row) => {
          const text = searchable([row.name, row.company, row.position, row.email].join(" "));
          return terms.every((term) => text.includes(term));
        })
        : all;
      return { contacts: shown.slice(from, from + size), total: shown.length, limit: size, offset: from };
    }
  };
}
