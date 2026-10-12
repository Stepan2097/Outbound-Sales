import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { espRouteRight, handleEspApi } from "../esp/api.mjs";
import { campaignStore } from "../esp/campaigns.mjs";
import { erasePerson } from "../esp/erasure.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { leadPage, leadStore, verificationTone } from "../esp/leads.mjs";

/**
 * ESP-UI 5 — lead lists (Snov «Leads», screen 07) and a person's card with
 * the timeline (screen 01): lists kept apart from campaigns, rows pasted from
 * a sheet, people sent to a campaign through the same pre-send checks.
 */

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "esp-leads-"));
  useJournal(join(dir, "esp-journal.jsonl"));
});
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function memoryStore() {
  const state = { lists: [], leads: [] };
  return {
    state,
    store: leadStore({
      readLists: () => state.lists, writeLists: async (value) => { state.lists = value; },
      readLeads: () => state.leads, writeLeads: async (value) => { state.leads = value; }
    })
  };
}

const SHEET = "email,name,company,position,country,source,source_date,verification,verified_at\nolga@acme.co.uk,Olga Shevchenko,Acme,CMO,UK,Apollo,2026-10-01,valid,2026-10-05\nivan@beta.com,Ivan Petrov,Beta,CEO,UK,Clay,2026-10-02,risky,2026-10-05\nbad line without address";

test("списки: створити, перейменувати, без дублів назв; видалити — разом із людьми списку", async () => {
  const { store, state } = memoryStore();
  const list = await store.createList("  Consulting  SW ", "stepan@x.co");
  assert.equal(list.name, "Consulting SW");
  await assert.rejects(() => store.createList("consulting sw"), /уже є/);
  await assert.rejects(() => store.createList("  "), /назву/);
  await store.renameList(list.id, "Consulting-SW");
  assert.equal(store.findList(list.id).name, "Consulting-SW");
  await store.addFromText(list.id, SHEET);
  const other = await store.createList("Affiliate managers");
  await store.addFromText(other.id, "olga@acme.co.uk");
  const { removed } = await store.deleteList(list.id);
  assert.equal(removed, 2);
  assert.deepEqual(state.leads.map((row) => row.email), ["olga@acme.co.uk"], "інший список не чіпається");
});

test("вставка з таблиці: заголовок за назвами колонок, рядок без адреси — у відхилені; повтор у списку доповнює, а не дублює", async () => {
  const { store, state } = memoryStore();
  const list = await store.createList("UK");
  const first = await store.addFromText(list.id, SHEET, "stepan@x.co");
  assert.deepEqual([first.added, first.updated, first.rejected.length], [2, 0, 1]);
  const olga = state.leads.find((row) => row.email === "olga@acme.co.uk");
  assert.deepEqual([olga.name, olga.position, olga.source, olga.verification, olga.addedBy], ["Olga Shevchenko", "CMO", "Apollo", "valid", "stepan@x.co"]);
  const again = await store.addFromText(list.id, "email,timezone\nOLGA@acme.co.uk,Europe/London");
  assert.deepEqual([again.added, again.updated], [0, 1]);
  assert.equal(state.leads.filter((row) => row.email === "olga@acme.co.uk").length, 1);
  assert.equal(state.leads.find((row) => row.email === "olga@acme.co.uk").timezone, "Europe/London");
  await assert.rejects(() => store.addFromText("nope", SHEET), /Такого списку немає/);
});

test("таблиця списку: пошук, сторінки, крапка верифікації, кампанії людини й виключення", async () => {
  const { store } = memoryStore();
  const list = await store.createList("UK");
  await store.addFromText(list.id, SHEET);
  const page = leadPage(store, {
    listId: list.id,
    enrollments: [{ email: "olga@acme.co.uk", campaignId: "c1", status: "active", step: 1 }],
    campaigns: new Map([["c1", "UK operators"]]),
    excluded: new Map([["@beta.com", { category: "client" }]])
  });
  assert.equal(page.total, 2);
  assert.deepEqual(page.verification, { valid: 1, risky: 1, invalid: 0, unknown: 0, none: 0 });
  const olga = page.rows.find((row) => row.email === "olga@acme.co.uk");
  assert.deepEqual(olga.campaigns, [{ campaignId: "c1", name: "UK operators", status: "active", step: 1 }]);
  assert.equal(page.rows.find((row) => row.email === "ivan@beta.com").excluded.category, "client", "виключений увесь домен");
  assert.deepEqual(leadPage(store, { q: "petrov" }).rows.map((row) => row.email), ["ivan@beta.com"]);
  assert.deepEqual([verificationTone("Catch-all"), verificationTone("catch_all"), verificationTone("undeliverable"), verificationTone("")], ["risky", "risky", "invalid", "none"], "catch_all — так пише перевірка адрес CRM");
});

test("ESP 17: людину, яку забули, прибрано з усіх списків", async () => {
  const { store, state } = memoryStore();
  const a = await store.createList("A");
  const b = await store.createList("B");
  await store.addFromText(a.id, SHEET);
  await store.addFromText(b.id, "olga@acme.co.uk");
  await append({ type: "contact.note", contact: "olga@acme.co.uk", data: { text: "called" } });
  const result = await erasePerson("olga@acme.co.uk", { campaigns: null, leads: store, actor: "admin@x.co" });
  assert.equal(result.listRows, 2);
  assert.deepEqual(state.leads.map((row) => row.email), ["ivan@beta.com"]);
});

test("маршрути: читати — команді; списки й відправка в кампанію — праву кампаній, через перевірки ESP 6; нотатка — в хронологію", async () => {
  const { store } = memoryStore();
  const campaignState = { campaigns: [], enrollments: [] };
  const campaigns = campaignStore({
    read: () => campaignState.campaigns, write: async (value) => { campaignState.campaigns = value; },
    readEnrollments: () => campaignState.enrollments, writeEnrollments: async (value) => { campaignState.enrollments = value; },
    templates: () => [{ id: "t1", name: "First", subject: "Hi {{first_name}}", body: "Hello" }]
  });
  const campaign = await campaigns.create({ name: "UK operators", steps: [{ templateId: "t1", delayDays: 0 }], senders: ["anna@send.com"] });
  const filters = { context: async () => ({}), check: async (lead) => (lead.email === "ivan@beta.com" ? { ok: false, reason: "unsubscribed", permanent: true } : { ok: true }) };
  const esp = { leads: store, campaigns, filters };
  const call = async (method, path, body = {}, role = "seller") => {
    let captured = null;
    await handleEspApi({
      request: { method, auth: { profile: { email: `${role}@x.com`, role } } }, response: {}, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_r, status, payload) => { captured = { status, payload }; }, readJson: async () => body, esp
    });
    return captured;
  };
  assert.deepEqual(["GET /leads", "GET /leads/lists", "GET /leads/card", "POST /leads/lists", "POST /leads/add", "POST /leads/to-campaign", "POST /leads/note"].map((route) => espRouteRight(...route.split(" "))),
    ["replies.read", "replies.read", "replies.read", "campaigns.launch", "campaigns.launch", "campaigns.launch", "replies.write"]);
  assert.equal((await call("POST", "/leads/lists", { name: "UK" })).status, 403, "продавець за замовчуванням списків не міняє");
  const created = await call("POST", "/leads/lists", { name: "UK" }, "admin");
  assert.equal(created.status, 201);
  const listId = created.payload.list.id;
  assert.equal((await call("POST", "/leads/add", { listId, text: SHEET }, "admin")).payload.added, 2);
  const lists = await call("GET", "/leads/lists");
  assert.deepEqual([lists.payload.lists[0].count, lists.payload.total, lists.payload.campaigns[0].name], [2, 2, "UK operators"]);
  const page = await call("GET", `/leads?list=${listId}`);
  assert.equal(page.payload.rows.length, 2);
  const ids = page.payload.rows.map((row) => row.id);
  const sent = await call("POST", "/leads/to-campaign", { ids, campaignId: campaign.id }, "admin");
  assert.equal(sent.payload.added, 1);
  assert.deepEqual(sent.payload.skipped.map((row) => row.email), ["ivan@beta.com"], "відписаний не потрапляє в кампанію");
  assert.equal(campaignState.enrollments[0].lead.position, "CMO", "у кампанію йде все, що відомо про людину");
  const card = await call("GET", "/leads/card?email=olga@acme.co.uk");
  assert.deepEqual([card.payload.lead.name, card.payload.lists[0].name, card.payload.campaigns[0].name], ["Olga Shevchenko", "UK", "UK operators"]);
  assert.equal((await call("GET", "/leads/card?email=nobody@x.com")).status, 404);
  assert.equal((await call("POST", "/leads/note", { email: "olga@acme.co.uk", text: "Дзвінок у вівторок" }, "admin")).status, 201);
  const note = (await allEntries()).find((entry) => entry.type === "contact.note");
  assert.deepEqual([note.contact, note.actor, note.data.text], ["olga@acme.co.uk", "admin@x.com", "Дзвінок у вівторок"]);
  const removed = await call("POST", "/leads/remove", { ids: [ids[0]] }, "admin");
  assert.equal(removed.payload.removed, 1);
  assert.equal((await call("POST", "/leads/lists/delete", { id: listId }, "admin")).payload.removed, 1);
  assert.ok((await allEntries()).some((entry) => entry.type === "admin.lead_list_deleted"));
});
