import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * «Контакти» після спрощення (985e5a7b): папка → список → картка з історією
 * LinkedIn і статусом запиту, без панелі чернеток. Код екрана береться з
 * app/screens/contacts.js і запускається проти заглушок DOM.
 *
 * Панель чернеток (три чернетки під три канали) не давала нічого: за весь час
 * жодної чернетки не було згенеровано. Вона прибрана разом із вибором продукту
 * й мови, а стан «уже в лідах» на картці замінила відповідь прогріву: де ця
 * людина в запрошеннях LinkedIn.
 */

const INDEX = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");

const NAMES = [
  "escapeHtml", "escapeAttr", "uaPlural",
  "WARMUP_OUTREACH_LABEL", "WARMUP_OUTREACH_TONE", "CONTACTS_STALE_MS", "CONTACT_PAGE_SIZE",
  "contactFolders", "contactFoldersLoaded", "contactFolderId", "crmContactRows", "contactTotal", "contactOffset",
  "contactSearch", "selectedContactId", "contactRecord", "contactHistory", "contactHistoryFor",
  "contactHistoryNotice", "contactOutreach", "contactsLoadedAt", "contactsLoading", "contactsError",
  "contactChannelHint", "contactFieldLabels", "contactLinkedInLink", "historyEntryHtml",
  "contactRequestPill", "renderContactPill", "renderContactCard", "renderContacts", "contactConversationHtml",
  "fetchContactFolders", "loadContactFolders", "loadContactPage", "selectContactFolder", "openContact",
  "loadContactHistory", "openContactsScreen"
];

const LISTENERS = ['document.getElementById("contactFolderSelect").addEventListener("change"'];

function element() {
  return { textContent: "", innerHTML: "", hidden: false, disabled: false, className: "", title: "", value: "" };
}

function screen({ api, warmupApi } = {}) {
  const ids = {};
  const handlers = {};
  const byId = (id) => {
    if (!ids[id]) ids[id] = { ...element(), addEventListener: (type, fn) => { handlers[`${id}:${type}`] = fn; } };
    return ids[id];
  };
  const calls = [];
  const globals = {
    document: { getElementById: byId },
    api: async (path) => { calls.push(path); return api(path); },
    warmupApi: async (path) => { calls.push(`warmup:${path}`); return (warmupApi || (async () => { throw new Error("мав не питати"); }))(path); },
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])),
    escapeAttr: (value) => String(value ?? "").replace(/"/g, "&quot;"),
    uaPlural: (count, one, few, many) => (count % 10 === 1 && count % 100 !== 11 ? one : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? few : many),
    setText: (id, value) => { byId(id).textContent = value; },
    setHtml: (id, html) => { byId(id).innerHTML = html; },
    relativeTime: () => "вчора",
    linkIfUrl: (value) => value,
    refreshIcons: () => {},
    HISTORY_EVENT_LABEL: { "invite.sent": "Запит надіслано" },
    INVITE_NOTE_DROPPED: {},
    window: { clearTimeout: () => {}, setTimeout: () => 0 },
    URLSearchParams,
    WARMUP_OUTREACH_LABEL: { pending: "запит надіслано", accepted: "прийняв(ла)", declined: "не прийняв(ла)" },
    WARMUP_OUTREACH_TONE: { pending: "tone-muted", accepted: "tone-live", declined: "tone-bad" }
  };
  const main = loadMain(NAMES.filter((name) => !["WARMUP_OUTREACH_LABEL", "WARMUP_OUTREACH_TONE"].includes(name)), globals, LISTENERS);
  return { ids, byId, handlers, calls, main, get: main.get, set: (name, value) => main.context && vm_set(main, name, value) };
}

import vm from "node:vm";
function vm_set(main, name, value) {
  main.context.__v = value;
  vm.runInContext(`${name} = __v`, main.context);
}

const FOLDERS = [{ id: "f-1", name: "ліди з linkedin2", contactCount: 240 }, { id: "f-2", name: "Підписники", contactCount: 1 }];

test("папка — випадаючий список із кількістю людей, а не панель зі списком і кнопкою «Оновити»", () => {
  const s = screen();
  s.set("contactFolders", FOLDERS);
  s.set("contactFolderId", "f-2");
  s.get("renderContacts")();
  const select = s.ids.contactFolderSelect;
  assert.match(select.innerHTML, /ліди з linkedin2 · 240 контактів/);
  assert.match(select.innerHTML, /<option value="f-2" selected>Підписники · 1 контакт</);
  assert.equal(select.disabled, false);
  for (const gone of ["contactFolderList", "contactFoldersRefreshBtn", "Папки CRM", "contact-drafts-panel", "contactDraftForm", "Згенерувати"]) {
    assert.equal(INDEX.includes(gone), false, `«${gone}» повернулось у розмітку`);
  }
  assert.ok(INDEX.includes('id="contactFolderSelect"'));
});

test("поки CRM мовчить, у списку папок — підказка, а помилка CRM стоїть у списку людей", () => {
  const s = screen();
  s.set("contactsLoading", true);
  s.get("renderContacts")();
  assert.match(s.ids.contactFolderSelect.innerHTML, /Читаємо CRM/);
  assert.equal(s.ids.contactFolderSelect.disabled, true);

  s.set("contactsLoading", false);
  s.set("contactsError", "CRM не налаштована: не задано SUPABASE_URL");
  s.get("renderContacts")();
  assert.match(s.ids.contactFolderSelect.innerHTML, /Папок не знайдено/);
  assert.match(s.ids.crmContactList.innerHTML, /CRM не налаштована: не задано SUPABASE_URL/);
});

test("рядок списку: ім'я, посада й компанія, країна, статус і чим людину можна дістати", () => {
  const s = screen();
  s.set("contactFolders", FOLDERS);
  s.set("contactFolderId", "f-1");
  s.set("crmContactRows", [{ id: 7, name: "Taras Bondar", position: "UA lead", company: "Northwind", country: "PL", lead_status: "new", email: "t@x.example", linkedin: "https://linkedin.com/in/t" }]);
  s.set("contactTotal", 1);
  s.get("renderContacts")();
  const row = s.ids.crmContactList.innerHTML;
  assert.match(row, /Taras Bondar/);
  assert.match(row, /UA lead · Northwind/);
  assert.match(row, /PL · new · пошта, LinkedIn/);
  assert.match(s.ids.contactListSubtitle.textContent, /^1 контакт$/);
});

test("вибір папки в списку відкриває її: людей читають з CRM з потрібною папкою", async () => {
  const s = screen({ api: async () => ({ contacts: [{ id: 1, name: "A" }], total: 1 }) });
  s.set("contactFolders", FOLDERS);
  s.set("contactFolderId", "f-1");
  await s.handlers["contactFolderSelect:change"]({ target: { value: "f-2" } });
  assert.equal(s.get("contactFolderId"), "f-2");
  assert.ok(s.calls.some((path) => path.startsWith("/api/contacts?folderId=f-2")), "людей з нової папки не прочитано");

  // Та сама папка або порожній вибір — нічого не читають.
  const before = s.calls.length;
  await s.handlers["contactFolderSelect:change"]({ target: { value: "f-2" } });
  await s.handlers["contactFolderSelect:change"]({ target: { value: "" } });
  assert.equal(s.calls.length, before);
});

test("статус запиту на картці — відповідь прогріву: чекаємо, мовчить, не було, або де саме", () => {
  const card = (set) => {
    const s = screen();
    s.set("contactRecord", { id: 7, name: "Taras Bondar", position: "UA lead", company: "Northwind" });
    s.set("contactHistoryFor", "7");
    set(s);
    s.get("renderContactCard")();
    return s.ids.contactCardPill;
  };

  const loading = card((s) => { s.set("contactHistory", null); });
  assert.equal(loading.textContent, "…");

  const silent = card((s) => { s.set("contactHistoryNotice", "Прогрів не відповів"); });
  assert.equal(silent.textContent, "—");
  assert.match(silent.title, /нічого не відомо/);

  const none = card((s) => { s.set("contactHistory", []); s.set("contactOutreach", null); });
  assert.equal(none.textContent, "запиту не було");
  assert.match(none.className, /tone-muted/);

  const accepted = card((s) => { s.set("contactHistory", []); s.set("contactOutreach", { status: "accepted" }); });
  assert.equal(accepted.textContent, "прийняв(ла)");
  assert.match(accepted.className, /tone-live/);

  const declined = card((s) => { s.set("contactHistory", []); s.set("contactOutreach", { status: "declined" }); });
  assert.match(declined.className, /tone-bad/);

  // Статус, якого цей екран не знає, показується як є, а не мовчки зникає.
  const odd = card((s) => { s.set("contactHistory", []); s.set("contactOutreach", { status: "mystery" }); });
  assert.equal(odd.textContent, "mystery");
});

test("картка людини: поля CRM, листування LinkedIn і жодних чернеток чи «в лідах»", () => {
  const s = screen();
  s.set("contactRecord", { id: 7, name: "Taras Bondar", position: "UA lead", company: "Northwind", email: "t@x.example", linkedin: "https://www.linkedin.com/in/t", description: "Зустрілись на конфі" });
  s.set("contactHistoryFor", "7");
  s.set("contactHistory", [{ kind: "invite", event: "invite.sent", at: "2026-10-01T10:00:00Z", meta: { by: "agent" } }, { kind: "message", direction: "in", body: "Привіт!", at: "2026-10-02T10:00:00Z" }]);
  s.set("contactOutreach", { status: "pending" });
  s.get("renderContactCard")();
  const body = s.ids.contactCardBody.innerHTML;
  assert.equal(s.ids.contactCardTitle.textContent, "Taras Bondar");
  assert.equal(s.ids.contactCardSubtitle.textContent, "UA lead · Northwind");
  assert.match(body, /Компанія/);
  assert.match(body, /Нотатка з CRM/);
  assert.match(body, /Листування в LinkedIn/);
  assert.match(body, /Запит надіслано/);
  assert.match(body, /Прийшло у відповідь/);
  assert.match(body, /надіслав агент/);
  assert.equal(s.ids.contactCardPill.textContent, "запит надіслано");
  assert.doesNotMatch(body + s.ids.contactCardPill.textContent, /уже в лідах|тільки в CRM|чернетк/i);
});

test("історію й статус запиту картка бере з одного запиту до прогріву, і чужа відповідь не затирає свою", async () => {
  const s = screen({
    api: async () => ({ contact: { id: 7, name: "Taras Bondar" } }),
    warmupApi: async (path) => ({ entries: [{ kind: "message", direction: "in", body: "Привіт", at: "2026-10-02T10:00:00Z" }], outreach: { status: "accepted" } })
  });
  await s.get("openContact")("7");
  // Історія вантажиться окремо від картки; дочекатися її.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.calls.filter((call) => call.startsWith("warmup:")), ["warmup:/history?crmContactId=7"]);
  assert.deepEqual(s.get("contactOutreach"), { status: "accepted" });
  assert.equal(s.ids.contactCardPill.textContent, "прийняв(ла)");
  // Картка більше не просить у сервера чернеток і лідів.
  assert.deepEqual(s.calls.filter((call) => !call.startsWith("warmup:")), ["/api/contacts/7"]);
});

test("повернення на екран перечитує CRM не частіше за раз на хвилину — кнопки «Оновити» нема", async () => {
  const fresh = screen({ api: async (path) => (path === "/api/contacts/folders" ? { folders: FOLDERS } : { contacts: [], total: 0 }) });
  fresh.set("contactFoldersLoaded", true);
  fresh.set("contactFolders", FOLDERS);
  fresh.set("contactFolderId", "f-1");
  fresh.set("contactsLoadedAt", Date.now() - 5_000);
  await fresh.get("openContactsScreen")();
  assert.equal(fresh.calls.includes("/api/contacts/folders"), false, "свіжий список перечитано без потреби");

  const stale = screen({ api: async (path) => (path === "/api/contacts/folders" ? { folders: FOLDERS } : { contacts: [], total: 0 }) });
  stale.set("contactFoldersLoaded", true);
  stale.set("contactFolders", FOLDERS);
  stale.set("contactFolderId", "f-1");
  stale.set("contactsLoadedAt", Date.now() - 5 * 60_000);
  await stale.get("openContactsScreen")();
  assert.ok(stale.calls.includes("/api/contacts/folders"), "застарілий список не перечитано");
  assert.ok(stale.calls.some((path) => path.startsWith("/api/contacts?folderId=f-1")), "людей у вибраній папці не перечитано");
});

test("CRM, що не відповіла при поверненні на екран, не валить екран", async () => {
  const s = screen({ api: async () => { throw new Error("CRM не відповіла"); } });
  s.set("contactsLoadedAt", 0);
  await s.get("openContactsScreen")();
  assert.match(s.ids.crmContactList.innerHTML, /CRM не відповіла/);
});
