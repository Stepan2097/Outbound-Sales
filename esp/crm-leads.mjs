/**
 * Ліди з CRM: папки CRM — ті самі, що бачать «Контакти», — як списки на сторінці
 * «Ліди», і в кожній лише люди з адресою пошти: холодний лист без пошти не
 * напишеш. Нічого не копіюється: сторінка читає CRM, а в кампанію людина йде
 * звичайним шляхом (ESP 6 перевіряє її перед кожним листом).
 *
 * `crm` — клієнт CRM (warmup/db.mjs), `listFolders` — папки з warmup/targeting.mjs;
 * сервер передає їх сюди, тож тести обходяться без мережі.
 */

const COLUMNS = "id,name,company,position,country,email,linkedin,folder_id,created_at,custom_fields";
const COUNT_TTL = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function verificationOf(contact, email) {
  const check = contact?.custom_fields?.email_check?.[email];
  const status = ["valid", "invalid", "catch_all", "unknown"].includes(check?.status) ? check.status : "";
  return { verification: status, verifiedAt: status ? String(check.checkedAt || "") : "" };
}

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
    // day the contact was put there.
    source: folderName ? `CRM: ${folderName}` : "CRM",
    sourceDate: String(contact.created_at || "").slice(0, 10),
    // The mail server's word on the address (Головна → contacts/email-check.mjs
    // and the folder check, esp/folder-check.mjs, write it into
    // custom_fields.email_check): `valid`, `invalid`, `catch_all`, `unknown`,
    // or nothing when it was never checked.
    ...verificationOf(contact, email),
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

// A contact sits in a folder through `contact_folder_memberships` — one
// contact may be in several (a folder made here from another folder's people
// keeps them in the old one too). `contacts.folder_id` is only the first one.
const IN_FOLDER = "m:contact_folder_memberships!inner(folder_id)";
const MEMBERSHIP_BATCH = 500;

export function crmLeadSource({ crm, listFolders, now = () => Date.now() }) {
  let counts = null;
  const withEmail = (query) => query.notNull("email").neq("email", "");
  const inFolder = (columns, folderId) => withEmail(crm.from("contacts").select(`${columns},${IN_FOLDER}`).eq("m.folder_id", folderId));
  const searched = (query, q) => {
    const term = String(q || "").trim().replace(/[(),*]/g, " ").trim();
    return term ? query.or(`name.ilike.*${term}*,company.ilike.*${term}*,position.ilike.*${term}*,email.ilike.*${term}*`) : query;
  };
  const mustFolder = (folderId) => {
    if (!UUID.test(String(folderId))) throw Object.assign(new Error("Такої папки CRM немає."), { status: 404 });
  };

  async function folders() {
    const list = await listFolders();
    if (!counts || now() - counts.at > COUNT_TTL) {
      const pairs = await Promise.all(list.map(async (folder) => [folder.id, await inFolder("id", folder.id).count().catch(() => null)]));
      counts = { at: now(), map: new Map(pairs) };
    }
    return list.map((folder) => ({ id: folder.id, name: folder.name, color: folder.color || null, contacts: folder.contactCount ?? null, withEmail: counts.map.get(folder.id) ?? null }));
  }

  return {
    configured: () => crm.configured(),
    folders,

    /** A page of one folder: only people with an address; search by name, company, position, address. */
    async page({ folderId, q = "", offset = 0, limit = 50 }) {
      mustFolder(folderId);
      const name = (await listFolders()).find((folder) => folder.id === folderId)?.name || "";
      const term = String(q || "").trim();
      const build = (columns) => searched(inFolder(columns, folderId), term);
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

    /**
     * Every contact with an address in a folder (optionally only those a search
     * finds), id by id — for «вся папка» on the page. Read in id order, a
     * thousand at a time, so a folder of twenty thousand is twenty-two reads.
     */
    async idsInFolder(folderId, q = "") {
      mustFolder(folderId);
      const ids = [];
      let after = "";
      for (;;) {
        let query = searched(inFolder("id", folderId), q);
        if (after) query = query.gt("id", after);
        const rows = await twice(() => query.order("id").limit(1000).rows());
        ids.push(...rows.map((row) => row.id));
        if (rows.length < 1000) return ids;
        after = rows.at(-1).id;
      }
    },

    /**
     * People into a CRM folder: an existing one (`folderId`) or a new one made
     * here (`name`, owned by whoever owns the folder they came from). They stay
     * where they were — a folder is a membership, not a move.
     */
    async addToFolder({ ids, folderId = "", name = "", fromFolderId = "" }) {
      const clean = [...new Set((ids || []).map(String).filter((id) => UUID.test(id)))];
      if (!clean.length) throw Object.assign(new Error("Виберіть людей."), { status: 400 });
      let target = null;
      const title = String(name || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (folderId) {
        mustFolder(folderId);
        target = (await listFolders()).find((folder) => folder.id === folderId) || null;
        if (!target) throw Object.assign(new Error("Такої папки CRM немає."), { status: 404 });
      } else if (title) {
        const taken = await crm.from("contact_folders").select("id").eq("name", title).rows();
        if (taken.length) throw Object.assign(new Error(`Папка «${title}» у CRM уже є — виберіть її зі списку.`), { status: 400 });
        const source = UUID.test(String(fromFolderId)) ? await crm.from("contact_folders").select("owner_id").eq("id", fromFolderId).maybeSingle() : null;
        const owner = source?.owner_id || (await crm.from("contact_folders").select("owner_id").limit(1).maybeSingle())?.owner_id;
        const [made] = await crm.from("contact_folders").insert({ name: title, ...(owner ? { owner_id: owner } : {}) }).select("id,name").rows();
        target = made;
      } else {
        throw Object.assign(new Error("Дайте новій папці назву або виберіть наявну."), { status: 400 });
      }
      for (let at = 0; at < clean.length; at += MEMBERSHIP_BATCH) {
        const rows = clean.slice(at, at + MEMBERSHIP_BATCH).map((contact_id) => ({ contact_id, folder_id: target.id }));
        const insert = crm.from("contact_folder_memberships").insert(rows);
        insert.headers = { ...insert.headers, Prefer: "resolution=ignore-duplicates,return=minimal" };
        await insert.rows();
      }
      counts = null;
      return { folder: { id: target.id, name: target.name }, added: clean.length };
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
