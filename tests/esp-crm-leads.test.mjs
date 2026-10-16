import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleEspApi } from "../esp/api.mjs";
import { campaignStore } from "../esp/campaigns.mjs";
import { crmLeadSource, leadFromContact } from "../esp/crm-leads.mjs";
import { useJournal } from "../esp/journal.mjs";
import { leadStore } from "../esp/leads.mjs";

/**
 * «Ліди» show the CRM's folders — every one of them, and in each only the
 * people who have an email address. Read from the CRM, never copied; sent to a
 * campaign through the same checks as anybody else.
 */

const FOLDER_A = "11111111-1111-4111-8111-111111111111";
const FOLDER_B = "22222222-2222-4222-8222-222222222222";
const contact = (id, folder, email, extra = {}) => ({ id, folder_id: folder, email, name: `Person ${id}`, company: "Acme", position: "CMO", country: "UK", linkedin: "", created_at: `2026-10-0${id.slice(-1)}T10:00:00Z`, ...extra });
const ROWS = [
  contact("aaaaaaaa-0000-4000-8000-000000000001", FOLDER_A, "one@acme.com"),
  contact("aaaaaaaa-0000-4000-8000-000000000002", FOLDER_A, null),
  contact("aaaaaaaa-0000-4000-8000-000000000003", FOLDER_A, ""),
  contact("aaaaaaaa-0000-4000-8000-000000000004", FOLDER_A, "Four@Beta.com", { name: "Olga Four" }),
  contact("aaaaaaaa-0000-4000-8000-000000000005", FOLDER_B, null)
];

/** Just enough of the CRM's REST client: the filters «Ліди» use, applied in memory. */
function fakeCrm({ timeoutsFirst = 0 } = {}) {
  let timeouts = timeoutsFirst;
  const asked = [];
  const query = () => {
    const filters = [];
    let order = null;
    let size = Infinity;
    let from = 0;
    const self = {
      select: () => self,
      // A folder is a membership: `m.folder_id` is any of the contact's folders.
      eq: (column, value) => { filters.push((row) => (column === "m.folder_id" ? (row.folders || [row.folder_id]).includes(value) : String(row[column]) === String(value))); return self; },
      gt: (column, value) => { filters.push((row) => String(row[column]) > String(value)); return self; },
      neq: (column, value) => { filters.push((row) => row[column] !== value); return self; },
      notNull: (column) => { filters.push((row) => row[column] !== null && row[column] !== undefined); return self; },
      in: (column, values) => { filters.push((row) => values.includes(row[column])); return self; },
      ilike: (column, pattern) => { filters.push((row) => String(row[column] || "").toLowerCase() === pattern.replace(/\\(.)/g, "$1").toLowerCase()); return self; },
      or: (clause) => { const term = clause.match(/\*(.+?)\*/)[1].toLowerCase(); filters.push((row) => ["name", "company", "position", "email"].some((key) => String(row[key] || "").toLowerCase().includes(term))); return self; },
      order: (column, { ascending = true } = {}) => { order ??= { column, ascending }; return self; },
      limit: (count) => { size = count; return self; },
      offset: (count) => { from = count; return self; },
      async rows() {
        asked.push("rows");
        if (timeouts > 0) { timeouts -= 1; throw new Error("canceling statement due to statement timeout"); }
        let list = ROWS.filter((row) => filters.every((filter) => filter(row)));
        if (order) list = list.sort((left, right) => String(left[order.column]).localeCompare(String(right[order.column])) * (order.ascending ? 1 : -1));
        return list.slice(from, from + size);
      },
      async count() { asked.push("count"); return ROWS.filter((row) => filters.every((filter) => filter(row))).length; }
    };
    return self;
  };
  return { configured: () => true, from: () => query(), asked };
}

const FOLDERS = async () => [{ id: FOLDER_A, name: "UK operators", contactCount: 4 }, { id: FOLDER_B, name: "Telegram", contactCount: 1 }];

test("усі папки CRM — з лічильником людей, що мають пошту; у таблиці папки — лише вони, новіші зверху", async () => {
  const source = crmLeadSource({ crm: fakeCrm(), listFolders: FOLDERS });
  assert.deepEqual((await source.folders()).map((row) => [row.name, row.contacts, row.withEmail]), [["UK operators", 4, 2], ["Telegram", 1, 0]], "папку без жодної пошти теж видно");
  const page = await source.page({ folderId: FOLDER_A });
  assert.deepEqual(page.rows.map((row) => row.email), ["four@beta.com", "one@acme.com"]);
  assert.equal(page.total, 2);
  const olga = page.rows[0];
  assert.deepEqual([olga.id, olga.source, olga.sourceDate, olga.verification], ["crm:aaaaaaaa-0000-4000-8000-000000000004", "CRM: UK operators", "2026-10-04", ""]);
  assert.deepEqual((await source.page({ folderId: FOLDER_A, q: "olga" })).rows.map((row) => row.email), ["four@beta.com"]);
  await assert.rejects(() => source.page({ folderId: "not-a-folder" }), /Такої папки CRM немає/);
});

test("холодне читання великої папки, яке CRM скасувала на тайм-ауті, питається ще раз; лічильник папки не рахується вдруге", async () => {
  const crm = fakeCrm();
  const source = crmLeadSource({ crm, listFolders: FOLDERS });
  await source.folders();
  crm.asked.length = 0;
  const slow = crmLeadSource({ crm: fakeCrm({ timeoutsFirst: 1 }), listFolders: FOLDERS });
  assert.equal((await slow.page({ folderId: FOLDER_A })).rows.length, 2);
  await source.page({ folderId: FOLDER_A });
  assert.deepEqual(crm.asked, ["rows"], "без пошуку загальна кількість — з лічильника папки");
});

test("маршрути: папки CRM у списках, сторінка папки, картка за адресою, «Надіслати в кампанію» — через перевірки ESP 6", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "esp-crm-leads-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  const state = { lists: [], leads: [], campaigns: [], enrollments: [] };
  const leads = leadStore({ readLists: () => state.lists, writeLists: async (value) => { state.lists = value; }, readLeads: () => state.leads, writeLeads: async (value) => { state.leads = value; } });
  const campaigns = campaignStore({
    read: () => state.campaigns, write: async (value) => { state.campaigns = value; },
    readEnrollments: () => state.enrollments, writeEnrollments: async (value) => { state.enrollments = value; },
    templates: () => [{ id: "t1", name: "First", subject: "Hi", body: "Hello" }]
  });
  const campaign = await campaigns.create({ name: "UK", steps: [{ templateId: "t1", delayDays: 0 }], senders: ["anna@send.com"] });
  const esp = { leads, campaigns, crmLeads: crmLeadSource({ crm: fakeCrm(), listFolders: FOLDERS }), filters: { context: async () => ({}), check: async () => ({ ok: true }) } };
  const call = async (method, path, body = {}, role = "admin") => {
    let captured = null;
    await handleEspApi({
      request: { method, auth: { profile: { email: `${role}@x.com`, role } } }, response: {}, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_r, status, payload) => { captured = { status, payload }; }, readJson: async () => body, esp
    });
    return captured;
  };
  const lists = await call("GET", "/leads/lists", {}, "seller");
  assert.deepEqual(lists.payload.crmFolders.map((row) => [row.name, row.withEmail]), [["UK operators", 2], ["Telegram", 0]]);
  const page = await call("GET", `/leads?crm=${FOLDER_A}`, {}, "seller");
  assert.deepEqual([page.status, page.payload.total, page.payload.folder.name], [200, 2, "UK operators"]);
  const card = await call("GET", "/leads/card?email=FOUR@beta.com", {}, "seller");
  assert.deepEqual([card.status, card.payload.lead.name, card.payload.lists[0].name], [200, "Olga Four", "CRM · UK operators"]);
  const sent = await call("POST", "/leads/to-campaign", { ids: page.payload.rows.map((row) => row.id), campaignId: campaign.id });
  assert.equal(sent.payload.added, 2);
  assert.deepEqual(state.enrollments.map((row) => [row.email, row.lead.source]).sort(), [["four@beta.com", "CRM: UK operators"], ["one@acme.com", "CRM: UK operators"]]);
  assert.equal(state.enrollments.some((row) => "crmId" in row.lead), false, "у кампанію — лише поля ліда");
  assert.equal(leadFromContact({ id: "x", email: " A@B.co " }).email, "a@b.co");
});
