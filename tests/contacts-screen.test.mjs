import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * «Контакти» після спрощення (985e5a7b): папка → список → картка з історією
 * LinkedIn і статусом запиту. Код екрана береться з app/screens/contacts.js і
 * запускається проти заглушок DOM.
 *
 * Окрема панель чернеток (три чернетки під три канали з вибором продукту й мови)
 * не давала нічого: за весь час жодної не було згенеровано. Вона прибрана, а
 * стан «уже в лідах» на картці замінила відповідь прогріву: де ця людина в
 * запрошеннях LinkedIn. Допомога моделі з написанням лишилась — як одна дія,
 * «Згенерувати», на самій картці: власник сказав, що це частина суті (08.10).
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
  "loadContactHistory", "openContactsScreen",
  "contactDrafts", "contactDraftsBusy", "contactDraftsError", "contactDraftLanguage", "CONTACT_DRAFT_LANGUAGE_LABEL",
  "wordCountLabel", "contactDraftHtml", "contactMessagesHtml", "generateContactMessages"
];

const LISTENERS = [
  'document.getElementById("contactFolderSelect").addEventListener("change"',
  'document.getElementById("contactCardBody").addEventListener("click"'
];

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
    window: { clearTimeout: () => {}, setTimeout: (fn) => { calls.push({ timer: fn }); return 0; } },
    URLSearchParams,
    navigator: { clipboard: { writeText: async (text) => { calls.push({ copied: text }); } } },
    WARMUP_OUTREACH_LABEL: { pending: "запит надіслано", accepted: "прийняв(ла)", declined: "не прийняв(ла)" },
    WARMUP_OUTREACH_TONE: { pending: "tone-muted", accepted: "tone-live", declined: "tone-bad" }
  };
  const main = loadMain(NAMES.filter((name) => !["WARMUP_OUTREACH_LABEL", "WARMUP_OUTREACH_TONE"].includes(name)), globals, LISTENERS);
  return { ids, byId, handlers, calls, main, get: main.get, set: (name, value) => main.context && vm_set(main, name, value) };
}

/** Картка людини з готовими полями; решта стану — як у тесті. */
function openCard(s, contact = {}) {
  s.set("selectedContactId", "7");
  s.set("contactRecord", { id: 7, name: "Taras Bondar", position: "UA lead", company: "Northwind", country: "Poland", telegram: "@taras", ...contact });
  s.set("contactHistoryFor", "7");
  s.set("contactHistory", []);
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

// ── «Згенерувати»: одна дія на картці ───────────────────────────────────────

const DRAFTS = {
  language: "en",
  provider: "openrouter",
  modelUsed: "anthropic/claude-sonnet-5",
  generatedAt: "2026-10-08T10:00:00Z",
  email: { subject: "Quick question about Northwind", body: "Hi Taras, saw your launch. Worth a short call?" },
  telegram: { body: "Hi Taras! Short note about your launch." },
  linkedin: { invite: "Hi Taras, would love to connect.", body: "Thanks for connecting, Taras." },
  verifyBeforeSending: ["Перевір, що запуск справді був минулого тижня"]
};

test("на картці є одна кнопка «Згенерувати», і без неї текстів нема; вибору продукту, мови й інструкції нема", () => {
  const s = screen();
  openCard(s);
  s.get("renderContactCard")();
  const body = s.ids.contactCardBody.innerHTML;
  assert.match(body, /<button class="primary-button" type="button" data-contact-generate><i data-lucide="sparkles"><\/i><span>Згенерувати<\/span>/);
  assert.match(body, /Модель прочитає цю картку/);
  assert.equal((body.match(/data-contact-generate/g) || []).length, 1, "кнопка одна");
  assert.doesNotMatch(body, /<select|<input|contactLanguageSelect|contactProductSelect|contactInstructionInput/);
  assert.doesNotMatch(body, /class="contact-draft"/);
});

test("«Згенерувати» просить у сервера тексти українською для контакту з України, англійською для решти", async () => {
  for (const [country, language] of [["Ukraine", "uk"], ["UA", "uk"], ["Україна", "uk"], ["Poland", "en"], ["", "en"], [undefined, "en"]]) {
    const requests = [];
    const s = screen({ api: async (path) => { requests.push(path); return { drafts: { ...DRAFTS, language } }; } });
    s.set("contactRecord", null);
    openCard(s, { country });
    const sent = [];
    s.main.context.api = async (path, options) => { sent.push({ path, body: JSON.parse(options.body) }); return { drafts: { ...DRAFTS, language } }; };
    await s.get("generateContactMessages")();
    assert.deepEqual(sent, [{ path: "/api/contacts/7/messages", body: { language } }], `країна «${country}»`);
  }
});

test("поки модель пише, кнопка каже «Пишемо...» і заблокована; після відповіді — чотири тексти з копіюванням", async () => {
  let release;
  const s = screen({ api: () => new Promise((resolve) => { release = () => resolve({ drafts: DRAFTS }); }) });
  openCard(s);
  const pending = s.get("generateContactMessages")();
  const during = s.ids.contactCardBody.innerHTML;
  assert.match(during, /data-contact-generate disabled/);
  assert.match(during, /Пишемо\.\.\./);

  release();
  await pending;
  const after = s.ids.contactCardBody.innerHTML;
  assert.equal((after.match(/class="contact-draft"/g) || []).length, 4);
  for (const title of ["Пошта", "Telegram", "LinkedIn · запрошення", "LinkedIn · перше повідомлення"]) assert.match(after, new RegExp(title));
  assert.match(after, /Hi Taras, saw your launch/);
  assert.match(after, /data-copy-text="Тема: Quick question about Northwind&#10;|data-copy-text="Тема: Quick question about Northwind/);
  assert.match(after, /@taras/, "юзернейм Telegram стоїть у підписі блоку");
  assert.match(after, /Перевір перед відправкою/);
  assert.match(after, /English · anthropic\/claude-sonnet-5/);
  assert.doesNotMatch(after, /data-contact-generate disabled/);
});

test("текст, складений без моделі, так і підписаний, а не видає себе за модельний", () => {
  const s = screen();
  openCard(s);
  s.set("contactDrafts", { ...DRAFTS, provider: "local", modelUsed: "local-draft" });
  s.get("renderContactCard")();
  assert.match(s.ids.contactCardBody.innerHTML, /складено без моделі, за описом продукту/);
  assert.doesNotMatch(s.ids.contactCardBody.innerHTML, /local-draft/);
});

test("тексти, що вже є на людині, чекають на картці одразу, а не лише після нової генерації", async () => {
  const s = screen({
    api: async () => ({ contact: { id: 7, name: "Taras Bondar" }, drafts: DRAFTS }),
    warmupApi: async () => ({ entries: [], outreach: null })
  });
  await s.get("openContact")("7");
  assert.equal((s.ids.contactCardBody.innerHTML.match(/class="contact-draft"/g) || []).length, 4);
  // Інша людина — чужих текстів нема.
  const other = screen({
    api: async () => ({ contact: { id: 8, name: "Iryna" }, drafts: null }),
    warmupApi: async () => ({ entries: [], outreach: null })
  });
  other.set("contactDrafts", DRAFTS);
  await other.get("openContact")("8");
  assert.doesNotMatch(other.ids.contactCardBody.innerHTML, /class="contact-draft"/);
});

test("людину перемкнули, поки модель писала: тексти не лягають на чужу картку", async () => {
  let release;
  const s = screen({ api: () => new Promise((resolve) => { release = () => resolve({ drafts: DRAFTS }); }) });
  openCard(s);
  const pending = s.get("generateContactMessages")();
  // Поки чекаємо, відкрили іншу людину.
  s.set("selectedContactId", "8");
  s.set("contactRecord", { id: 8, name: "Iryna Shevchenko" });
  s.set("contactDrafts", null);
  release();
  await pending;
  assert.equal(s.get("contactDrafts"), null, "чужі тексти потрапили на іншу картку");
});

test("помилка моделі показана на картці, а кнопка знову доступна", async () => {
  const s = screen({ api: async () => { throw new Error("Модель не відповіла"); } });
  openCard(s);
  await s.get("generateContactMessages")();
  const body = s.ids.contactCardBody.innerHTML;
  assert.match(body, /Модель не відповіла/);
  assert.doesNotMatch(body, /data-contact-generate disabled/);
  assert.doesNotMatch(body, /class="contact-draft"/);
});

test("«Копіювати» кладе текст у буфер і на мить каже «Скопійовано»", async () => {
  const s = screen();
  openCard(s);
  s.set("contactDrafts", DRAFTS);
  const label = { textContent: "Копіювати" };
  const button = { dataset: { copyText: "Hi Taras!" }, querySelector: () => label };
  await s.handlers["contactCardBody:click"]({ target: { closest: (selector) => (selector === "[data-copy-text]" ? button : null) } });
  assert.deepEqual(s.calls.find((call) => call.copied !== undefined), { copied: "Hi Taras!" });
  assert.equal(label.textContent, "Скопійовано");
  s.calls.find((call) => call.timer).timer();
  assert.equal(label.textContent, "Копіювати");
});

test("клік по «Згенерувати» на картці запускає генерацію, клік повз кнопки — ні", async () => {
  const sent = [];
  const s = screen({ api: async (path) => { sent.push(path); return { drafts: DRAFTS }; } });
  openCard(s);
  await s.handlers["contactCardBody:click"]({ target: { closest: () => null } });
  assert.deepEqual(sent, []);
  await s.handlers["contactCardBody:click"]({ target: { closest: (selector) => (selector === "[data-contact-generate]" ? {} : null) } });
  assert.deepEqual(sent, ["/api/contacts/7/messages"]);
});
