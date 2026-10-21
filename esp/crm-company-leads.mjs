/**
 * Папки компаній CRM у «Лідах» (власник 21.10: «тут чомусь немає папки casino
 * brands» — це папка компаній, 21 689 компаній; «так, додай»).
 *
 * У CRM компанія в папці — рядок company_category_assignments; контакт із
 * компанією не пов'язаний ключем, лише назвою (`contacts.company`). Тож люди
 * папки компаній — контакти з поштою, чия компанія називається так само, як
 * одна з компаній папки (без різниці великих і малих літер). Список збирається
 * раз і тримається 15 хвилин: для 21 тисячі компаній це кілька сотень запитів.
 *
 * Папка тут має id «c:<uuid папки компаній>», щоб її не сплутати з папкою
 * контактів; решта «Лідів» (пошук, фільтр провайдера, «Додати в папку»,
 * «Перевірити адреси») працює з нею так само.
 */

import { likeLiteral } from "../warmup/rest.mjs";

export const COMPANY_PREFIX = "c:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL = 15 * 60_000;
const NAME_BATCH = 60;
const PAGE = 1000;

export const isCompanyFolder = (id) => String(id || "").startsWith(COMPANY_PREFIX) && UUID.test(String(id).slice(COMPANY_PREFIX.length));

/** A name as an element of PostgREST's `ilike(any).{…}`: matched whole, quoted. */
function anyPattern(name) {
  return `"${likeLiteral(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function companyFolderSource({ crm, now = () => Date.now() }) {
  const cache = new Map(); // folder uuid → { at, people, pending }
  let folderList = null;

  async function listFolders() {
    if (folderList && now() - folderList.at < TTL) return folderList.rows;
    const rows = await crm.from("company_folders").select("id,name").rows();
    folderList = { at: now(), rows };
    return rows;
  }

  async function companyNames(uuid) {
    const names = [];
    let after = "";
    for (;;) {
      let query = crm.from("companies").select("id,name,a:company_category_assignments!inner(folder_id)").eq("a.folder_id", uuid);
      if (after) query = query.gt("id", after);
      const rows = await query.order("id").limit(PAGE).rows();
      for (const row of rows) if (String(row.name || "").trim()) names.push(String(row.name).trim());
      if (rows.length < PAGE) return [...new Set(names)];
      after = rows.at(-1).id;
    }
  }

  async function contactsOf(names) {
    const found = new Map();
    const batches = [];
    for (let at = 0; at < names.length; at += NAME_BATCH) batches.push(names.slice(at, at + NAME_BATCH));
    let next = 0;
    const lane = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        await readBatch(batch, found);
      }
    };
    // Four reads at a time: a folder of 21 thousand companies in under half a minute.
    await Promise.all([lane(), lane(), lane(), lane()]);
    return [...found.values()].sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")) || String(right.id).localeCompare(String(left.id)));
  }

  async function readBatch(batch, found) {
    {
      for (let offset = 0; ; offset += PAGE) {
        const query = crm.from("contacts").select("id,name,company,position,email,created_at,provider:custom_fields->email_meta->>provider").notNull("email").neq("email", "");
        query.params.append("company", `ilike(any).{${batch.map(anyPattern).join(",")}}`);
        const rows = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE).offset(offset).rows();
        for (const row of rows) found.set(row.id, row);
        if (rows.length < PAGE) break;
      }
    }
  }

  /** The folder's people, from the cache when fresh; one read at a time per folder. */
  function people(id) {
    const uuid = String(id).slice(COMPANY_PREFIX.length);
    const known = cache.get(uuid);
    if (known?.people && now() - known.at < TTL) return Promise.resolve(known.people);
    if (known?.pending) return known.pending;
    const pending = companyNames(uuid).then(contactsOf).then((rows) => {
      cache.set(uuid, { at: now(), people: rows, companies: null });
      return rows;
    }, (error) => {
      cache.delete(uuid);
      throw error;
    });
    cache.set(uuid, { ...(known || {}), pending });
    return pending;
  }

  const matches = (row, q, provider) => {
    const term = String(q || "").trim().toLowerCase();
    if (term && ![row.name, row.company, row.position, row.email].some((value) => String(value || "").toLowerCase().includes(term))) return false;
    const kind = String(provider || "").replace(/[^a-z_]/g, "");
    if (kind === "unchecked") return !row.provider;
    return !kind || row.provider === kind;
  };

  return {
    /** The company folders as «Лідів» folders: counted once their people are read (in the background). */
    async folders() {
      const rows = await listFolders();
      return rows.map((folder) => {
        const known = cache.get(folder.id);
        if (!known) void people(`${COMPANY_PREFIX}${folder.id}`).catch(() => {});
        return { id: `${COMPANY_PREFIX}${folder.id}`, name: folder.name, kind: "company", contacts: null, withEmail: known?.people ? known.people.length : null };
      });
    },
    /** Whether the folder's people are read; until then the page says so and asks again. */
    ready(id) {
      const known = cache.get(String(id).slice(COMPANY_PREFIX.length));
      if (!known?.people || now() - known.at >= TTL) { void people(id).catch(() => {}); return Boolean(known?.people); }
      return true;
    },
    async name(id) {
      return (await listFolders()).find((folder) => `${COMPANY_PREFIX}${folder.id}` === id)?.name || "";
    },
    /** Ids of the folder's people (a search and a provider narrow it), newest first. */
    async ids(id, q = "", provider = "") {
      return (await people(id)).filter((row) => matches(row, q, provider)).map((row) => row.id);
    },
    async total(id, q = "", provider = "") {
      return (await people(id)).filter((row) => matches(row, q, provider)).length;
    }
  };
}
