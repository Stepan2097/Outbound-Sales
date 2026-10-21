import assert from "node:assert/strict";
import test from "node:test";

import { companyFolderSource, isCompanyFolder } from "../esp/crm-company-leads.mjs";

// «Casino brands» — папка компаній CRM (власник 21.10): у «Лідах» її люди — контакти
// з поштою, чия компанія (без різниці регістру) серед компаній папки.

const FOLDER = "d128ef4e-2e9c-472a-8feb-540bd0d48b77";

function fakeCrm() {
  const companies = [
    { id: "c1", name: "Bet Casino", folder: FOLDER },
    { id: "c2", name: "Lucky, Inc.", folder: FOLDER },
    { id: "c3", name: "Other Co", folder: "x" }
  ];
  const contacts = [
    { id: "p1", name: "Ann", company: "bet casino", email: "ann@bet.com", created_at: "2026-10-02", provider: "google" },
    { id: "p2", name: "Bob", company: "Lucky, Inc.", email: "bob@lucky.com", created_at: "2026-10-03", provider: null },
    { id: "p3", name: "Cid", company: "Bet Casino", email: "", created_at: "2026-10-04" },
    { id: "p4", name: "Dan", company: "Other Co", email: "dan@o.com", created_at: "2026-10-05" }
  ];
  const from = (table) => {
    const filters = [];
    const self = {
      params: { append: (column, value) => {
        const names = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\\\/g, "\\").replace(/\\(.)/g, "$1").toLowerCase());
        filters.push((row) => names.includes(String(row[column]).toLowerCase()));
      } },
      select: () => self,
      eq: (column, value) => { filters.push((row) => (column === "a.folder_id" ? row.folder === value : row[column] === value)); return self; },
      notNull: (column) => { filters.push((row) => row[column] != null); return self; },
      neq: (column, value) => { filters.push((row) => row[column] !== value); return self; },
      gt: () => self, order: () => self, limit: () => self, offset: (n) => { if (n) filters.push(() => false); return self; },
      async rows() { return (table === "company_folders" ? [{ id: FOLDER, name: "Casino brands" }] : table === "companies" ? companies : contacts).filter((row) => filters.every((f) => f(row))); }
    };
    return self;
  };
  return { from, configured: () => true };
}

test("папка компаній: її люди — контакти з поштою компаній папки, без різниці регістру; пошук і провайдер звужують", async () => {
  const source = companyFolderSource({ crm: fakeCrm() });
  const [folder] = await source.folders();
  assert.deepEqual([folder.id, folder.name, folder.kind], [`c:${FOLDER}`, "Casino brands", "company"]);
  assert.equal(isCompanyFolder(folder.id), true);
  assert.equal(isCompanyFolder(FOLDER), false);
  assert.deepEqual(await source.ids(folder.id), ["p2", "p1"], "новіші зверху; без пошти й чужа компанія — ні");
  assert.deepEqual(await source.ids(folder.id, "ann"), ["p1"]);
  assert.deepEqual(await source.ids(folder.id, "", "google"), ["p1"]);
  assert.deepEqual(await source.ids(folder.id, "", "unchecked"), ["p2"]);
  assert.equal(source.ready(folder.id), true);
});
