import assert from "node:assert/strict";
import test from "node:test";

import { crmLeadSource } from "../esp/crm-leads.mjs";
import { domainChecker, folderChecker, millionVerifier, quickCheck } from "../esp/folder-check.mjs";

/**
 * «Ліди» → папка CRM (власник 16.10): вибрати всю папку, а не 50 рядків
 * сторінки; додати вибраних в окрему папку CRM (вони лишаються й у старій);
 * у папці — «Перевірити адреси», як MillionVerifier: домен тут, скринька — через
 * їхній API, відповідь — у custom_fields.email_check контакту.
 */

const FROM = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** An in-memory CRM: contacts, folders, memberships — the filters these features use. */
function memoryCrm(contacts) {
  const tables = {
    contacts,
    contact_folders: [{ id: FROM, name: "Rewarded-CPE", owner_id: "owner-1" }, { id: OTHER, name: "Інша", owner_id: "owner-2" }],
    contact_folder_memberships: contacts.flatMap((row) => (row.folders || []).map((folder) => ({ contact_id: row.id, folder_id: folder })))
  };
  const writes = [];
  const from = (table) => {
    const filters = [];
    let size = Infinity;
    let skip = 0;
    let method = "GET";
    let payload = null;
    const matches = () => tables[table].filter((row) => filters.every((filter) => filter(row)));
    const self = {
      headers: {},
      select: () => self,
      eq: (column, value) => { filters.push((row) => (column === "m.folder_id" ? tables.contact_folder_memberships.some((m) => m.contact_id === row.id && m.folder_id === value) : String(row[column]) === String(value))); return self; },
      neq: (column, value) => { filters.push((row) => row[column] !== value); return self; },
      notNull: (column) => { filters.push((row) => row[column] != null); return self; },
      gt: (column, value) => { filters.push((row) => String(row[column]) > String(value)); return self; },
      or: (clause) => { const term = clause.match(/\*(.+?)\*/)[1].toLowerCase(); filters.push((row) => ["name", "email"].some((key) => String(row[key] || "").toLowerCase().includes(term))); return self; },
      order: () => self,
      limit: (count) => { size = count; return self; },
      offset: (count) => { skip = count; return self; },
      insert: (values) => { method = "POST"; payload = values; return self; },
      update: (patch) => { method = "PATCH"; payload = patch; return self; },
      async rows() {
        if (method === "POST") {
          const list = (Array.isArray(payload) ? payload : [payload]).map((row) => (table === "contact_folders" ? { id: "33333333-3333-4333-8333-333333333333", ...row } : row));
          for (const row of list) {
            if (table === "contact_folder_memberships" && tables[table].some((m) => m.contact_id === row.contact_id && m.folder_id === row.folder_id)) continue;
            tables[table].push(row);
          }
          writes.push({ table, rows: list });
          return list;
        }
        if (method === "PATCH") {
          for (const row of matches()) Object.assign(row, payload);
          writes.push({ table, patch: payload });
          return [];
        }
        return [...matches()].sort((left, right) => String(left.id).localeCompare(String(right.id))).slice(skip, skip + size);
      },
      async maybeSingle() { return (await self.rows())[0] ?? null; },
      async count() { return matches().length; }
    };
    return self;
  };
  return { configured: () => true, from, tables, writes };
}

const FOLDERS = async () => [{ id: FROM, name: "Rewarded-CPE", contactCount: 3 }, { id: OTHER, name: "Інша", contactCount: 0 }];

test("вся папка (або все, що знайшов пошук) — в нову папку CRM: власник — той, чия папка-джерело; у старій люди лишаються", async () => {
  const contacts = Array.from({ length: 1205 }, (_, n) => ({ id: id(n + 1), email: n === 3 ? "" : `p${n}@acme.com`, name: n < 2 ? `Olga ${n}` : `P ${n}`, folders: [FROM] }));
  const crm = memoryCrm(contacts);
  const source = crmLeadSource({ crm, listFolders: FOLDERS });
  const all = await source.idsInFolder(FROM);
  assert.equal(all.length, 1204, "читає далі першої тисячі; без пошти — ні");
  assert.deepEqual((await source.idsInFolder(FROM, "olga")).length, 2);

  const result = await source.addToFolder({ ids: all, name: "  Перевірити  ", fromFolderId: FROM });
  assert.deepEqual(result, { folder: { id: "33333333-3333-4333-8333-333333333333", name: "Перевірити" }, added: 1204 });
  assert.equal(crm.tables.contact_folders.at(-1).owner_id, "owner-1");
  const memberships = crm.tables.contact_folder_memberships;
  assert.equal(memberships.filter((m) => m.folder_id === result.folder.id).length, 1204);
  assert.equal(memberships.filter((m) => m.folder_id === FROM).length, 1205, "стара папка не змінилась");
  assert.equal(crm.writes.filter((w) => w.table === "contact_folder_memberships").length, 3, "пачками по 500");

  // The new folder pages like any other.
  assert.equal((await source.page({ folderId: result.folder.id })).total, 1204);
  // Into an existing folder; somebody already there is not added twice.
  await source.addToFolder({ ids: [id(1), id(2)], folderId: OTHER });
  await source.addToFolder({ ids: [id(1)], folderId: OTHER });
  assert.equal(memberships.filter((m) => m.folder_id === OTHER).length, 2);
  await assert.rejects(() => source.addToFolder({ ids: [id(1)], name: "Інша" }), /уже є/);
  await assert.rejects(() => source.addToFolder({ ids: [id(1)] }), /назву/);
});

const dns = (table) => domainChecker({
  mx: async (domain) => {
    const answer = table[domain];
    if (answer === "nxdomain") throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    if (answer === "timeout") throw Object.assign(new Error("t"), { code: "ETIMEOUT" });
    if (answer === "nomx" || answer === "a-only") throw Object.assign(new Error("nodata"), { code: "ENODATA" });
    if (answer === "null") return [{ exchange: "", priority: 0 }];
    return [{ exchange: `mx.${domain}`, priority: 10 }];
  },
  a: async (domain) => { if (table[domain] === "a-only") return ["1.2.3.4"]; throw Object.assign(new Error("nodata"), { code: "ENODATA" }); },
  aaaa: async () => { throw Object.assign(new Error("nodata"), { code: "ENODATA" }); }
});

test("швидка перевірка: формат, одноразові, немає домену, null MX, немає пошти; лише A-запис і мовчання DNS — не «ні»", async () => {
  const domainOf = dns({ "gone.com": "nxdomain", "parked.com": "null", "nomail.com": "nomx", "old.com": "a-only", "slow.com": "timeout" });
  const code = async (email) => { const r = await quickCheck(email, domainOf); return r.code || r.status; };
  assert.equal(await code("k.cahill@high"), "syntax");
  assert.equal(await code("a@b.com, c@d.com"), "syntax");
  assert.equal(await code("x@mailinator.com"), "disposable");
  assert.equal(await code("x@gone.com"), "no_domain");
  assert.equal(await code("x@parked.com"), "null_mx");
  assert.equal(await code("x@nomail.com"), "no_mail");
  assert.equal(await code("x@old.com"), "pass");
  assert.equal(await code("x@slow.com"), "pass");
  assert.equal((await quickCheck("info@acme.com", domainOf)).role, true);
});

test("MillionVerifier: ok / catch_all / invalid / disposable / unknown — у наші статуси; без ключа його немає; кінчились кредити — зупинка", async () => {
  assert.equal(millionVerifier({ key: "" }), null);
  const answers = { "a@x.com": { result: "ok", credits: 99 }, "b@x.com": { result: "catch_all" }, "c@x.com": { result: "invalid" }, "d@x.com": { result: "disposable" }, "e@x.com": { result: "unknown" }, "f@x.com": { error: "Insufficient credits" } };
  const asked = [];
  const mv = millionVerifier({ key: "K", fetchImpl: async (url) => { asked.push(url); const email = new URL(url).searchParams.get("email"); return { ok: true, json: async () => answers[email] }; } });
  assert.deepEqual([(await mv("a@x.com")).status, (await mv("b@x.com")).status, (await mv("c@x.com")).status, (await mv("d@x.com")).status, (await mv("e@x.com")).status], ["valid", "catch_all", "invalid", "invalid", "unknown"]);
  assert.equal((await mv("a@x.com")).credits, 99);
  assert.match(asked[0], /^https:\/\/api\.millionverifier\.com\/api\/v3\/\?api=K&email=a%40x\.com/);
  await assert.rejects(() => mv("f@x.com"), (error) => error.stop && /Insufficient credits/.test(error.message));
});

test("перевірка папки: пише відповідь у email_check контакту; свіже «так/ні» не питає вдруге; без ключа — лише домен", async () => {
  const now = new Date("2026-10-16T10:00:00Z");
  const contacts = [
    { id: id(1), email: "Ok@Live.com", folders: [FROM], custom_fields: { note: "keep" } },
    { id: id(2), email: "x@gone.com", folders: [FROM] },
    { id: id(3), email: "known@live.com", folders: [FROM], custom_fields: { email_check: { "known@live.com": { status: "valid", checkedAt: "2026-10-10T00:00:00Z" } } } },
    { id: id(4), email: "stale@live.com", folders: [FROM], custom_fields: { email_check: { "stale@live.com": { status: "valid", checkedAt: "2026-08-01T00:00:00Z" } } } },
    { id: id(5), email: "other@live.com", folders: [OTHER] }
  ];
  const crm = memoryCrm(contacts);
  const domainOf = dns({ "gone.com": "nxdomain" });

  // No key: only what this server can tell.
  const shallow = folderChecker({ crm, deep: () => null, domainOf, now: () => now });
  assert.equal(shallow.start(FROM).state, "running");
  await shallow.finished(FROM);
  const first = shallow.status(FROM);
  assert.equal(first.state, "done");
  assert.equal(first.total, 4);
  assert.deepEqual([first.counts.invalid, first.counts.domainOk, first.counts.earlier, first.counts.valid], [1, 2, 1, 1]);
  assert.equal(contacts[1].custom_fields.email_check["x@gone.com"].status, "invalid");
  assert.equal(contacts[1].custom_fields.email_check["x@gone.com"].reason, "домену не існує");
  assert.equal(contacts[0].custom_fields.email_check, undefined, "домен живий — без ключа нічого не пишемо");

  // With MillionVerifier.
  const asked = [];
  const deep = folderChecker({ crm, deep: () => async (email) => { asked.push(email); return { status: email.startsWith("ok") ? "valid" : "catch_all", reason: "MV", credits: 10 }; }, domainOf, now: () => now });
  deep.start(FROM);
  await deep.finished(FROM);
  const second = deep.status(FROM);
  assert.deepEqual(asked.sort(), ["ok@live.com", "stale@live.com"], "свіжі визначені відповіді не питаються; стара (>30 дн) — так");
  assert.equal(contacts[0].custom_fields.note, "keep", "інші поля контакту цілі");
  assert.equal(contacts[0].custom_fields.email_check["ok@live.com"].status, "valid");
  assert.equal(contacts[0].custom_fields.email_check["ok@live.com"].by, "millionverifier");
  assert.equal(second.credits, 10);
  assert.equal(contacts[4].custom_fields, undefined, "людина з іншої папки не чіпається");
});

test("перевірка зупиняється сама, коли MillionVerifier каже «кредитів немає»", async () => {
  const contacts = Array.from({ length: 20 }, (_, n) => ({ id: id(n + 1), email: `p${n}@live.com`, folders: [FROM] }));
  const crm = memoryCrm(contacts);
  const checker = folderChecker({ crm, deep: () => async () => { throw Object.assign(new Error("MillionVerifier: Insufficient credits"), { stop: true }); }, domainOf: dns({}), concurrency: 2 });
  checker.start(FROM);
  await checker.finished(FROM);
  const run = checker.status(FROM);
  assert.equal(run.state, "stopped");
  assert.match(run.error, /Insufficient credits/);
  assert.ok(run.done < 20);
});
