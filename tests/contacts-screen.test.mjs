import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * «Контакти» після спрощення (985e5a7b): папка → список → картка з історією
 * LinkedIn і статусом запиту. Код екрана береться з app/screens/contacts.js і
 * запускається проти заглушок DOM.
 *
 * Стан «уже в лідах» на картці замінила відповідь прогріву: де ця людина в
 * запрошеннях LinkedIn. Допомога моделі з написанням — частина суті (власник,
 * 08.10), тож вона лишилась на самій картці, а не окремою панеллю: продукт, мова,
 * «що врахувати» і кнопка «Згенерувати три чернетки» (LinkedIn, лист, Telegram).
 * Спрощувати її можна, прибирати поля — ні (Outbound-Sales, 08.10): тому тут є
 * і вибір, і значення за замовчуванням, і те, що вже написано людині.
 */

const INDEX = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");

const NAMES = [
  "escapeHtml", "escapeAttr", "uaPlural",
  "WARMUP_OUTREACH_LABEL", "WARMUP_OUTREACH_TONE", "CONTACTS_STALE_MS", "CONTACT_PAGE_SIZE",
  "contactReads", "contactSearchTimer", "resetContacts", "contactFolders", "contactFoldersLoaded", "contactFolderId", "crmContactRows", "contactTotal", "contactOffset",
  "contactSearch", "selectedContactId", "contactRecord", "contactHistory", "contactHistoryFor",
  "contactHistoryNotice", "contactOutreach", "contactsLoadedAt", "contactsLoading", "contactsError",
  "contactChannelHint", "contactFieldLabels", "contactLinkedInLink", "historyEntryHtml",
  "contactRequestPill", "renderContactPill", "renderContactCard", "renderContacts", "contactConversationHtml",
  "contactMail", "contactMailFor", "contactMailNotice", "MAIL_EVENT_LABEL", "contactMailHtml", "loadContactMail",
  "fetchContactFolders", "loadContactFolders", "loadContactPage", "selectContactFolder", "openContact",
  "loadContactHistory", "openContactsScreen", "contactsRecalled", "rememberContacts", "recallContacts",
  "contactDrafts", "contactDraftsBusy", "contactDraftsError", "contactDraftLanguage", "CONTACT_DRAFT_LANGUAGE_LABEL",
  "contactDraftForm", "CONTACT_DRAFT_LANGUAGES", "contactDraftChoice", "renderKeepingFocus", "rememberContactDraftField",
  "CONTACT_PRODUCT_KEY", "rememberedContactProduct", "rememberContactProduct",
  "wordCountLabel", "contactDraftHtml", "contactMessagesHtml", "generateContactMessages"
];

const LISTENERS = [
  'document.getElementById("contactFolderSelect").addEventListener("change"',
  'document.getElementById("contactCardBody").addEventListener("submit"',
  'document.getElementById("contactCardBody").addEventListener("input"',
  'document.getElementById("contactCardBody").addEventListener("change"',
  'document.getElementById("contactCardBody").addEventListener("click"'
];

function element() {
  return { textContent: "", innerHTML: "", hidden: false, disabled: false, className: "", title: "", value: "" };
}

function screen({ api, warmupApi, screens = new Map() } = {}) {
  const ids = {};
  const handlers = {};
  const byId = (id) => {
    if (!ids[id]) ids[id] = { ...element(), addEventListener: (type, fn) => { handlers[`${id}:${type}`] = fn; } };
    return ids[id];
  };
  const calls = [];
  // Сховище браузера: пам'ять останнього вибраного продукту.
  const stored = new Map();
  const localStorage = { getItem: (key) => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => { stored.set(key, String(value)); } };
  const globals = {
    document: { getElementById: byId },
    // Як у core.js: робочий простір, поки його не прочитано, — null.
    state: null,
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
    window: { localStorage, clearTimeout: () => {}, setTimeout: (fn) => { calls.push({ timer: fn }); return 0; } },
    URLSearchParams, AbortController,
    cachedRead: (key, loader, options) => loader({ signal: options?.signal }),
    invalidateReads: () => {},
    navigator: { clipboard: { writeText: async (text) => { calls.push({ copied: text }); } } },
    WARMUP_OUTREACH_LABEL: { pending: "запит надіслано", accepted: "прийняв(ла)", declined: "не прийняв(ла)" },
    WARMUP_OUTREACH_TONE: { pending: "tone-muted", accepted: "tone-live", declined: "tone-bad" },
    // app/cache.js, as the tab's memory: what a screen left there last time.
    recallScreen: (key) => (screens.has(key) ? { at: 0, value: screens.get(key) } : null),
    rememberScreen: (key, value) => { screens.set(key, JSON.parse(JSON.stringify(value))); }
  };
  const main = loadMain(NAMES.filter((name) => !["WARMUP_OUTREACH_LABEL", "WARMUP_OUTREACH_TONE"].includes(name)), globals, LISTENERS);
  return { ids, byId, handlers, calls, stored, screens, main, get: main.get, set: (name, value) => main.context && vm_set(main, name, value) };
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

test("картка людини: поля CRM, листування LinkedIn і жодного «в лідах»", () => {
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
  assert.doesNotMatch(body + s.ids.contactCardPill.textContent, /уже в лідах|тільки в CRM/i);
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

/**
 * 09.10.2026, власник: сторінки щоразу довго вантажаться. Після перезавантаження
 * вкладки остання папка й сторінка списку стоять одразу, а CRM перечитується за
 * ними — і свіже лягає поверх.
 */
test("після перезавантаження остання папка й люди видно одразу, а CRM однаково перечитується", async () => {
  const screens = new Map([["contacts", {
    folders: FOLDERS, folderId: "f-2", rows: [{ id: "9", name: "Olena Hrytsenko" }], total: 1, offset: 0, search: "olena"
  }]]);
  let answer;
  const crm = new Promise((resolve) => { answer = resolve; });
  const s = screen({ screens, api: async (path) => { await crm; return path === "/api/contacts/folders" ? { folders: FOLDERS } : { contacts: [{ id: "10", name: "Olena Fresh" }], total: 1 }; } });
  const opening = s.get("openContactsScreen")();
  // CRM ще мовчить, а екран уже не порожній.
  assert.match(s.ids.crmContactList.innerHTML, /Olena Hrytsenko/);
  assert.match(s.ids.contactFolderSelect.innerHTML, /value="f-2" selected/);
  assert.equal(s.ids.contactSearchInput.value, "olena", "пошук, з яким читали сторінку, стоїть і в полі");
  answer();
  await opening;
  assert.ok(s.calls.includes("/api/contacts/folders"), "пам'ять вкладки не замінює читання CRM");
  assert.ok(s.calls.some((path) => String(path).startsWith("/api/contacts?folderId=f-2")), "та сама папка перечитана");
  assert.match(s.ids.crmContactList.innerHTML, /Olena Fresh/);
  assert.equal(screens.get("contacts").rows[0].name, "Olena Fresh", "свіже запам'ятовано для наступного разу");
});

test("папка, якої в CRM уже немає, не тримається з пам'яті вкладки — береться перша", async () => {
  const screens = new Map([["contacts", { folders: [{ id: "gone", name: "Стара", contactCount: 3 }], folderId: "gone", rows: [], total: 0, offset: 0, search: "" }]]);
  const s = screen({ screens, api: async (path) => (path === "/api/contacts/folders" ? { folders: FOLDERS } : { contacts: [], total: 0 }) });
  await s.get("openContactsScreen")();
  assert.equal(s.get("contactFolderId"), "f-1");
});

// ── «Згенерувати три чернетки»: форма на картці ─────────────────────────────

const DRAFTS = {
  language: "en",
  provider: "openrouter",
  modelUsed: "anthropic/claude-sonnet-5",
  productId: "p-course",
  productName: "advantage-course",
  instruction: "",
  generatedAt: "2026-10-08T10:00:00Z",
  email: { subject: "Quick question about Northwind", body: "Hi Taras, saw your launch. Worth a short call?" },
  telegram: { body: "Hi Taras! Short note about your launch." },
  linkedin: { invite: "Hi Taras, would love to connect.", body: "Thanks for connecting, Taras." },
  grounding: ["Компанія з картки CRM: Northwind"],
  verifyBeforeSending: ["Перевір, що запуск справді був минулого тижня"]
};

const PRODUCTS = [{ id: "p-ad", name: "AdAction" }, { id: "p-course", name: "advantage-course" }];

/** Картка з продуктами робочого простору: обрано другий. */
function openCardWithProducts(s, contact) {
  s.set("state", { products: PRODUCTS, selectedProductId: "p-course" });
  openCard(s, contact);
}

/** Людина змінила поле форми: так її бачить слухач на контейнері картки. */
async function edit(s, event, field, value) {
  const control = { dataset: { draftField: field }, value };
  await s.handlers[`contactCardBody:${event}`]({ target: { closest: (selector) => (selector === "[data-draft-field]" ? control : null) } });
}

test("на картці є форма: продукт, мова, «що врахувати» і кнопка «Згенерувати три чернетки»", () => {
  const s = screen();
  openCardWithProducts(s, { country: "Ukraine" });
  s.get("renderContactCard")();
  const body = s.ids.contactCardBody.innerHTML;
  assert.match(body, /<form class="contact-draft-form" id="contactDraftForm" data-contact-draft-form>/);
  assert.match(body, /<select id="contactProductSelect"[^>]*>.*<option value="p-ad">AdAction<\/option><option value="p-course" selected>advantage-course<\/option>/s, "продукт, обраний у просторі, вибраний і тут");
  assert.match(body, /<select id="contactLanguageSelect"[^>]*>.*<option value="en">English<\/option><option value="uk" selected>Українською<\/option><option value="ru">Русский<\/option>/s, "для контакту з України мова за замовчуванням українська");
  assert.match(body, /<input id="contactInstructionInput" type="text" data-draft-field="instruction" value=""/);
  assert.match(body, /Що врахувати \(необов'язково\)/);
  assert.match(body, /<button class="primary-button" type="submit" id="contactGenerateBtn"><i data-lucide="sparkles"><\/i><span>Згенерувати три чернетки<\/span>/);
  assert.equal((body.match(/type="submit"/g) || []).length, 1, "кнопка одна");
  assert.match(body, /Нічого не надсилається саме/);
  assert.doesNotMatch(body, /class="contact-draft"/, "поки не писали — текстів нема");
  assert.match(body, /id="contactDraftsPill">немає</);
});

test("форма живе в картці, а не повертається окремою панеллю в розмітці", () => {
  for (const gone of ["contact-drafts-panel", "contactDraftForm", "contactProductSelect", "contactInstructionInput"]) {
    assert.equal(INDEX.includes(gone), false, `«${gone}» у розмітці — форма малюється всередині картки`);
  }
});

test("мова за замовчуванням: українська для контакту з України, англійська для решти", async () => {
  for (const [country, language] of [["Ukraine", "uk"], ["UA", "uk"], ["Україна", "uk"], ["Poland", "en"], ["", "en"], [undefined, "en"]]) {
    const s = screen();
    openCardWithProducts(s, { country });
    const sent = [];
    s.main.context.api = async (path, options) => { sent.push({ path, body: JSON.parse(options.body) }); return { drafts: { ...DRAFTS, language } }; };
    await s.get("generateContactMessages")();
    assert.deepEqual(sent, [{ path: "/api/contacts/7/messages", body: { productId: "p-course", language, instruction: "" } }], `країна «${country}»`);
  }
});

test("у запит іде те, що вибрано у формі: продукт, мова й «що врахувати»", async () => {
  const s = screen();
  openCardWithProducts(s, { country: "Poland" });
  const sent = [];
  s.main.context.api = async (path, options) => { sent.push(JSON.parse(options.body)); return { drafts: DRAFTS }; };
  await edit(s, "change", "productId", "p-ad");
  await edit(s, "change", "language", "ru");
  await edit(s, "input", "instruction", "коротше, без ціни");
  await s.get("generateContactMessages")();
  assert.deepEqual(sent, [{ productId: "p-ad", language: "ru", instruction: "коротше, без ціни" }]);
});

test("вибране у формі переживає перемальовування картки, а чужий продукт у ній не з'являється", async () => {
  const s = screen();
  openCardWithProducts(s, { country: "Poland" });
  await edit(s, "change", "productId", "p-ad");
  await edit(s, "change", "language", "ru");
  await edit(s, "input", "instruction", `з "лапками" та <тегами>`);
  s.get("renderContactCard")();
  const body = s.ids.contactCardBody.innerHTML;
  assert.match(body, /<option value="p-ad" selected>AdAction</);
  assert.match(body, /<option value="ru" selected>Русский</);
  assert.match(body, /value="з &quot;лапками&quot; та &lt;тегами&gt;"/, "значення поля екрановане");
  assert.doesNotMatch(body, /<option value="uk" selected>/);

  // Продукт, якого вже нема в просторі, не лишається вибраним: береться обраний у просторі.
  s.set("state", { products: [PRODUCTS[1]], selectedProductId: "p-course" });
  assert.equal(s.get("contactDraftChoice")({ country: "Poland" }).productId, "p-course");
});

test("перемальовування не відбирає фокус у поля «що врахувати»: курсор лишається там, де був", () => {
  const s = screen();
  openCardWithProducts(s);
  const input = s.byId("contactInstructionInput");
  Object.assign(input, {
    id: "contactInstructionInput",
    selectionStart: 5,
    selectionEnd: 5,
    focus: () => s.calls.push("focus"),
    setSelectionRange: (from, to) => s.calls.push({ caret: [from, to] })
  });
  s.byId("contactCardBody").contains = (node) => node === input;
  s.main.context.document.activeElement = input;
  s.get("renderContactCard")();
  assert.ok(s.calls.includes("focus"), "фокус не повернувся");
  assert.deepEqual(s.calls.find((call) => call.caret), { caret: [5, 5] });

  // Фокус був деінде — нічого не чіпаємо.
  s.calls.length = 0;
  s.main.context.document.activeElement = { id: "somewhereElse" };
  s.get("renderContactCard")();
  assert.deepEqual(s.calls, []);
});

test("відправка форми запускає генерацію, а відправка чогось іншого на картці — ні", async () => {
  const sent = [];
  const s = screen({ api: async (path) => { sent.push(path); return { drafts: DRAFTS }; } });
  openCardWithProducts(s);
  const prevented = [];
  await s.handlers["contactCardBody:submit"]({ target: { closest: () => null }, preventDefault: () => prevented.push("other") });
  assert.deepEqual(sent, []);
  assert.deepEqual(prevented, [], "чужу форму не чіпаємо");
  await s.handlers["contactCardBody:submit"]({ target: { closest: (selector) => (selector === "[data-contact-draft-form]" ? {} : null) }, preventDefault: () => prevented.push("draft") });
  assert.deepEqual(sent, ["/api/contacts/7/messages"]);
  assert.deepEqual(prevented, ["draft"], "сторінка не перезавантажується від submit");
});

test("поки модель пише, кнопка каже «Пишемо...» і заблокована; після відповіді — чотири тексти з копіюванням", async () => {
  let release;
  const s = screen({ api: () => new Promise((resolve) => { release = () => resolve({ drafts: DRAFTS }); }) });
  openCardWithProducts(s);
  const pending = s.get("generateContactMessages")();
  const during = s.ids.contactCardBody.innerHTML;
  assert.match(during, /id="contactGenerateBtn" disabled/);
  assert.match(during, /Пишемо\.\.\./);

  release();
  await pending;
  const after = s.ids.contactCardBody.innerHTML;
  assert.equal((after.match(/class="contact-draft"/g) || []).length, 4);
  for (const title of ["Пошта", "Telegram", "LinkedIn · запрошення", "LinkedIn · перше повідомлення"]) assert.match(after, new RegExp(title));
  assert.match(after, /Hi Taras, saw your launch/);
  assert.match(after, /data-copy-text="Тема: Quick question about Northwind/);
  assert.match(after, /@taras/, "юзернейм Telegram стоїть у підписі блоку");
  assert.match(after, /Перевір перед відправкою/);
  assert.match(after, /На чому тримається/);
  assert.match(after, /advantage-course · English · anthropic\/claude-sonnet-5/);
  assert.match(after, /id="contactDraftsPill">AI</);
  assert.doesNotMatch(after, /id="contactGenerateBtn" disabled/);
  assert.match(after, /Згенерувати три чернетки/, "після відповіді кнопка знову пропонує згенерувати");
});

test("текст, складений без моделі, так і підписаний, а не видає себе за модельний", () => {
  const s = screen();
  openCardWithProducts(s);
  s.set("contactDrafts", { ...DRAFTS, provider: "local", modelUsed: "local-draft" });
  s.get("renderContactCard")();
  const body = s.ids.contactCardBody.innerHTML;
  assert.match(body, /складено без моделі, за описом продукту/);
  assert.match(body, /id="contactDraftsPill">чернетка з брифу</);
  assert.doesNotMatch(body, /local-draft/);
});

test("тексти, що вже є на людині, чекають на картці одразу, і форма стоїть так, як їх писали", async () => {
  const saved = { ...DRAFTS, productId: "p-ad", productName: "AdAction", language: "ru", instruction: "без згадки ціни" };
  const s = screen({
    api: async () => ({ contact: { id: 7, name: "Taras Bondar", country: "Poland" }, drafts: saved }),
    warmupApi: async () => ({ entries: [], outreach: null })
  });
  s.set("state", { products: PRODUCTS, selectedProductId: "p-course" });
  await s.get("openContact")("7");
  const body = s.ids.contactCardBody.innerHTML;
  assert.equal((body.match(/class="contact-draft"/g) || []).length, 4);
  assert.match(body, /<option value="p-ad" selected>AdAction</, "продукт — той, для якого писали, а не обраний у просторі");
  assert.match(body, /<option value="ru" selected>Русский</);
  assert.match(body, /value="без згадки ціни"/);

  // Інша людина — чужих текстів і чужих налаштувань нема.
  const other = screen({
    api: async () => ({ contact: { id: 8, name: "Iryna", country: "Ukraine" }, drafts: null }),
    warmupApi: async () => ({ entries: [], outreach: null })
  });
  other.set("state", { products: PRODUCTS, selectedProductId: "p-course" });
  other.set("contactDrafts", saved);
  other.set("contactDraftForm", { productId: "p-ad", language: "ru", instruction: "чуже" });
  await other.get("openContact")("8");
  const fresh = other.ids.contactCardBody.innerHTML;
  assert.doesNotMatch(fresh, /class="contact-draft"/);
  assert.match(fresh, /<option value="p-course" selected>/);
  assert.match(fresh, /<option value="uk" selected>/);
  assert.doesNotMatch(fresh, /чуже/);
});

test("відповідь CRM, що прийшла після перемикання на іншу людину, не лягає на чужу картку", async () => {
  let release;
  const s = screen({
    api: () => new Promise((resolve) => { release = () => resolve({ contact: { id: 7, name: "Taras" }, drafts: DRAFTS }); }),
    warmupApi: async () => ({ entries: [], outreach: null })
  });
  const opening = s.get("openContact")("7");
  s.set("selectedContactId", "8");
  release();
  await opening;
  assert.equal(s.get("contactRecord"), null, "картка Тараса лягла на Ірину");
  assert.equal(s.get("contactDrafts"), null);
});

test("людину перемкнули, поки модель писала: тексти не лягають на чужу картку", async () => {
  let release;
  const s = screen({ api: () => new Promise((resolve) => { release = () => resolve({ drafts: DRAFTS }); }) });
  openCardWithProducts(s);
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
  openCardWithProducts(s);
  await s.get("generateContactMessages")();
  const body = s.ids.contactCardBody.innerHTML;
  assert.match(body, /Модель не відповіла/);
  assert.doesNotMatch(body, /id="contactGenerateBtn" disabled/);
  assert.doesNotMatch(body, /class="contact-draft"/);
});

test("«Копіювати» кладе текст у буфер і на мить каже «Скопійовано»", async () => {
  const s = screen();
  openCardWithProducts(s);
  s.set("contactDrafts", DRAFTS);
  const label = { textContent: "Копіювати" };
  const button = { dataset: { copyText: "Hi Taras!" }, querySelector: () => label };
  await s.handlers["contactCardBody:click"]({ target: { closest: (selector) => (selector === "[data-copy-text]" ? button : null) } });
  assert.deepEqual(s.calls.find((call) => call.copied !== undefined), { copied: "Hi Taras!" });
  assert.equal(label.textContent, "Скопійовано");
  s.calls.find((call) => call.timer).timer();
  assert.equal(label.textContent, "Копіювати");
});

test("клік повз «Копіювати» нічого не копіює і нічого не генерує", async () => {
  const sent = [];
  const s = screen({ api: async (path) => { sent.push(path); return { drafts: DRAFTS }; } });
  openCardWithProducts(s);
  await s.handlers["contactCardBody:click"]({ target: { closest: () => null } });
  assert.deepEqual(sent, []);
  assert.equal(s.calls.some((call) => call.copied !== undefined), false);
});

// ── Продукт: пам'ять вибору й назва під чернетками ──────────────────────────

test("продукт за замовчуванням — той, що людина вибирала востаннє в цьому браузері, а не застиглий у просторі", () => {
  const s = screen();
  openCardWithProducts(s); // у просторі обрано p-course
  s.stored.set("outbound.contact.product", "p-ad");
  assert.equal(s.get("contactDraftChoice")({ country: "Poland" }).productId, "p-ad");
  s.get("renderContactCard")();
  assert.match(s.ids.contactCardBody.innerHTML, /<option value="p-ad" selected>AdAction</);

  // Запам'ятований продукт, якого вже нема в списку, не лишається вибраним.
  s.stored.set("outbound.contact.product", "p-gone");
  assert.equal(s.get("contactDraftChoice")({ country: "Poland" }).productId, "p-course");
  // А вибір, який уже зроблено у формі цієї картки, сильніший за пам'ять.
  s.stored.set("outbound.contact.product", "p-ad");
  s.set("contactDraftForm", { productId: "p-course", language: "", instruction: "" });
  assert.equal(s.get("contactDraftChoice")({ country: "Poland" }).productId, "p-course");
});

test("вибір продукту запам'ятовується, а вибір мови чи побажання — ні", async () => {
  const s = screen();
  openCardWithProducts(s);
  await edit(s, "change", "productId", "p-ad");
  assert.equal(s.stored.get("outbound.contact.product"), "p-ad");
  s.stored.clear();
  await edit(s, "change", "language", "ru");
  await edit(s, "input", "instruction", "коротше");
  assert.equal(s.stored.size, 0, "у пам'ять потрапив не продукт");
});

test("сховище браузера закрите — картка працює без пам'яті, а не падає", async () => {
  const s = screen();
  openCardWithProducts(s);
  const closed = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
  s.main.context.window.localStorage = closed;
  assert.equal(s.get("contactDraftChoice")({ country: "Poland" }).productId, "p-course");
  await edit(s, "change", "productId", "p-ad");
  assert.equal(s.get("contactDraftChoice")({ country: "Poland" }).productId, "p-ad", "вибір у формі діє й без сховища");
});

test("під чернетками названо продукт — і для старих чернеток, у яких назви не збережено", () => {
  const s = screen();
  openCardWithProducts(s);
  // Старі чернетки: є id продукту, назви нема.
  const { productName, ...old } = DRAFTS;
  s.set("contactDrafts", { ...old, productId: "p-ad" });
  s.get("renderContactCard")();
  assert.match(s.ids.contactCardBody.innerHTML, /<span>AdAction · English · anthropic\/claude-sonnet-5/);

  // Продукт, якого вже нема в списку, лишає назву, з якою чернетки писали.
  s.set("contactDrafts", { ...DRAFTS, productId: "p-gone", productName: "Старий продукт" });
  s.get("renderContactCard")();
  assert.match(s.ids.contactCardBody.innerHTML, /<span>Старий продукт · English/);

  // Назва зі списку сильніша за збережену: продукт могли перейменувати.
  s.set("contactDrafts", { ...DRAFTS, productId: "p-ad", productName: "AdAction (стара назва)" });
  s.get("renderContactCard")();
  assert.match(s.ids.contactCardBody.innerHTML, /<span>AdAction · English/);
});

test("запит несе вибраний productId, і без нього тест червоніє", async () => {
  const s = screen();
  openCardWithProducts(s);
  s.stored.set("outbound.contact.product", "p-ad");
  const sent = [];
  s.main.context.api = async (path, options) => { sent.push(JSON.parse(options.body)); return { drafts: { ...DRAFTS, productId: "p-ad" } }; };
  await s.get("generateContactMessages")();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].productId, "p-ad", "сервер інакше візьме застиглий state.selectedProductId");
});
