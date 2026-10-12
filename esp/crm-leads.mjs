/**
 * Ліди з CRM: папки CRM — ті самі, що бачать «Контакти», — як списки на сторінці
 * «Ліди», і в кожній лише люди з адресою пошти: холодний лист без пошти не
 * напишеш. Нічого не копіюється: сторінка читає CRM, а в кампанію людина йде
 * звичайним шляхом (ESP 6 перевіряє її перед кожним листом).
 *
 * `crm` — клієнт CRM (warmup/db.mjs), `listFolders` — папки з warmup/targeting.mjs;
 * сервер передає їх сюди, тож тести обходяться без мережі.
 */

const COLUMNS = "id,name,company,position,country,email,linkedin,folder_id,created_at";
const COUNT_TTL = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One CRM contact as a lead row of the page — and as a lead for a campaign. */
export function leadFromContact(contact, folderName = "") {
  const email = String(contact.email || "").trim().toLowerCase();
  return {
    id: `crm:${contact.id}`,
    crmId: contact.id,
    folderId: contact.folder_id || null,
    email,
    name: String(contact.name || "").trim(),
    company: String(contact.company || "").trim(),
    position: String(contact.position || "").trim(),
    country: String(contact.country || "").trim(),
    linkedin: contact.linkedin || "",
    // Where the address came from and when, for ESP 6: the CRM folder and the
    // day the contact was put there. The verifier's word the CRM does not have.
    source: folderName ? `CRM: ${folderName}` : "CRM",
    sourceDate: String(contact.created_at || "").slice(0, 10),
    verification: "",
    verifiedAt: "",
    addedAt: contact.created_at || null
  };
}

/**
 * A CRM read asked again once when the CRM cancelled it on its statement
 * timeout: a big folder's first read after a quiet hour is a cold one, and the
 * same query a second later answers in a fraction of a second.
 */
async function twice(read) {
  try {
    return await read();
  } catch (error) {
    if (!/statement timeout|57014/i.test(`${error.message} ${error.code || ""}`)) throw error;
    return read();
  }
}

export function crmLeadSource({ crm, listFolders, now = () => Date.now() }) {
  let counts = null;
  const withEmail = (query) => query.notNull("email").neq("email", "");

  async function folders() {
    const list = await listFolders();
    if (!counts || now() - counts.at > COUNT_TTL) {
      const pairs = await Promise.all(list.map(async (folder) => [folder.id, await withEmail(crm.from("contacts").select("id").eq("folder_id", folder.id)).count().catch(() => null)]));
      counts = { at: now(), map: new Map(pairs) };
    }
    return list.map((folder) => ({ id: folder.id, name: folder.name, color: folder.color || null, contacts: folder.contactCount ?? null, withEmail: counts.map.get(folder.id) ?? null }));
  }

  return {
    configured: () => crm.configured(),
    folders,

    /** A page of one folder: only people with an address; search by name, company, position, address. */
    async page({ folderId, q = "", offset = 0, limit = 50 }) {
      if (!UUID.test(String(folderId))) throw Object.assign(new Error("Такої папки CRM немає."), { status: 404 });
      const name = (await listFolders()).find((folder) => folder.id === folderId)?.name || "";
      const term = String(q || "").trim().replace(/[(),*]/g, " ").trim();
      const build = (columns) => {
        let query = withEmail(crm.from("contacts").select(columns).eq("folder_id", folderId));
        if (term) query = query.or(`name.ilike.*${term}*,company.ilike.*${term}*,position.ilike.*${term}*,email.ilike.*${term}*`);
        return query;
      };
      const size = Math.max(1, Math.min(100, Number(limit) || 50));
      const from = Math.max(0, Number(offset) || 0);
      // Without a search the folder's count is the one the side column already
      // has; with one, the CRM counts the matches.
      const known = !term ? counts?.map.get(folderId) : null;
      const [rows, total] = await Promise.all([
        twice(() => build(COLUMNS).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(size).offset(from).rows()),
        known ?? twice(() => build("id").count())
      ]);
      return { folder: { id: folderId, name }, total, offset: from, limit: size, rows: rows.map((row) => leadFromContact(row, name)) };
    },

    /** The contacts picked on the page, for «Надіслати в кампанію» — only those with an address. */
    async byIds(ids) {
      const clean = [...new Set(ids.filter((id) => UUID.test(String(id))))].slice(0, 500);
      if (!clean.length) return [];
      const names = new Map((await listFolders()).map((folder) => [folder.id, folder.name]));
      const rows = await withEmail(crm.from("contacts").select(COLUMNS).in("id", clean)).rows();
      return rows.map((row) => leadFromContact(row, names.get(row.folder_id) || ""));
    },

    /** The person behind an address, for the lead's card. */
    async byEmail(email) {
      const key = String(email || "").trim().toLowerCase();
      if (!key) return [];
      const literal = key.replace(/[\\%_]/g, "\\$&");
      const names = new Map((await listFolders()).map((folder) => [folder.id, folder.name]));
      const rows = await crm.from("contacts").select(COLUMNS).ilike("email", literal).limit(10).rows();
      return rows.map((row) => leadFromContact(row, names.get(row.folder_id) || ""));
    }
  };
}
