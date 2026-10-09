import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { loadMain, mainSource, declaration } from "./app-main-excerpt.mjs";

/**
 * «Вхідні» — відповіді всіх акаунтів прогріву, розкладені як у месенджері:
 * акаунти кнопками зверху, зліва розмови, справа уся розмова з людиною.
 *
 * Що має бути видно й що має працювати, без браузера: код екрана береться з
 * app/screens/inbox.js і запускається проти заглушок DOM. Сервер тут не
 * потрібен — API вхідних не змінювався, а решта цього екрана — те, як
 * відповідь лягає на сторінку.
 */

const NAMES = [
  "escapeHtml", "escapeAttr", "uaPlural", "warmupCount",
  "WARMUP_OUTREACH_LABEL", "WARMUP_OUTREACH_TONE",
  "WARMUP_SYNC_STALE_HOURS", "inboxAccountFilter", "inboxSearch", "inboxSearchTerms", "inboxPaneKey",
  "warmupAgo", "warmupStamp", "warmupHoursSince", "WARMUP_PLACEHOLDERS", "warmupPlaceholder", "warmupBodyHtml",
  "warmupPreviewHtml", "warmupProfileUrl",
  "WARMUP_UNNAMED", "WARMUP_NAME_NOISE", "warmupCleanName", "warmupParticipantUnnamed", "warmupParticipantName",
  "warmupParticipantNameAttr", "warmupThreadAccount", "warmupAccountTitle", "warmupInboxSync", "warmupInboxNoteHtml",
  "warmupInboxEmptyHtml", "warmupInboxRows", "warmupInboxMatches", "warmupThreadRowHtml", "warmupInboxAccountName",
  "warmupInboxUnreadFor", "warmupInboxFilterHtml", "warmupInboxAccountOptions", "warmupInboxAccountId",
  "openWarmupInboxAccount", "warmupInboxChipsHtml",
  "warmupThreadPlaceholderHtml", "warmupNextUnread", "warmupMessageHtml", "warmupThreadViewHtml",
  "renderWarmupInbox", "renderWarmupNavBadge", "setWarmupUnread", "refreshWarmupBadge", "stopWarmupBadgePoll",
  "warmupInboxListOnScreen", "loadWarmupInbox", "warmupThreadIsOpen", "markWarmupThreadRead", "openWarmupThread",
  "closeWarmupThread", "showWarmupInboxAccount"
];

/** Слухачі екрана: те, що людина робить руками. Беруться з коду як є. */
const LISTENERS = [
  'document.getElementById("warmupInboxRefreshBtn")?.addEventListener("click"',
  'document.getElementById("warmupInboxAccounts")?.addEventListener("click"',
  'document.getElementById("warmupInboxLayout")?.addEventListener("click"',
  'document.getElementById("warmupInboxSearch")?.addEventListener("input"',
  'document.addEventListener("visibilitychange"'
];

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

function element() {
  const classes = new Set();
  return {
    textContent: "", innerHTML: "", hidden: false, className: "", title: "", value: "", scrollTop: 0, attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) }
  };
}

function thread(extra) {
  return {
    threadKey: "t", accountId: "acc-a", accountIdentity: "Anna Kovalenko", accountLabel: "Profile 3",
    participant: { name: "Oleh Petrenko", headline: "Head of Growth", slug: "oleh-petrenko" },
    lastMessage: { direction: "in", body: "Так, цікаво. Надішліть деталі.", sentAt: minutesAgo(5) },
    unread: false, crmContactId: null, outreachStatus: null, lastSyncedAt: minutesAgo(10),
    ...extra
  };
}

/** Три розмови двох акаунтів: прочитана свіжа, непрочитана давня, непрочитана годинна. */
function threeThreads() {
  return [
    thread({ threadKey: "t-read", unread: false, crmContactId: "c1", lastMessage: { direction: "in", body: "Дякую, я вже бачив.", sentAt: minutesAgo(5) } }),
    thread({
      threadKey: "t-old-unread", unread: true, accountId: "acc-b", accountIdentity: null,
      participant: { name: "Iryna Shevchenko", headline: "", slug: "" },
      lastMessage: { direction: "in", body: "Привіт! Розкажіть детальніше.", sentAt: minutesAgo(60 * 48) }
    }),
    thread({
      threadKey: "t-new-unread", unread: true,
      participant: { name: "Taras Bondar", headline: "UA lead", slug: "taras-bondar" },
      lastMessage: { direction: "in", body: "Коли можна поговорити?", sentAt: minutesAgo(60) }
    })
  ];
}

function screen({ threads = threeThreads(), accounts = [], sync = null, api, extra = {}, active = true } = {}) {
  const ids = [
    "warmupInboxTitle", "warmupInboxSubtitle", "warmupInboxPill", "warmupInboxBody", "warmupInboxNotice",
    "warmupInboxAccounts", "warmupInboxLayout", "warmupInboxThread", "warmupInboxSearch", "warmupNavBadge",
    "warmupInboxRefreshBtn"
  ];
  const els = Object.fromEntries(ids.map((id) => [id, element()]));
  // Сам екран: видно чи ні, і чи на ньому відкрита розмова (на телефоні вона забирає весь екран).
  const viewClasses = new Set(active ? ["active"] : []);
  els["view-inbox"] = { classList: { contains: (name) => viewClasses.has(name), toggle: (name, on) => { if (on) viewClasses.add(name); else viewClasses.delete(name); } } };

  const clicks = [];
  const listeners = {};
  els.warmupInboxRefreshBtn.addEventListener = (type, fn) => { listeners[`refresh:${type}`] = fn; };
  els.warmupInboxAccounts.addEventListener = (type, fn) => { listeners[`chips:${type}`] = fn; };
  els.warmupInboxLayout.addEventListener = (type, fn) => { listeners[`layout:${type}`] = fn; };
  els.warmupInboxSearch.addEventListener = (type, fn) => { listeners[`search:${type}`] = fn; };

  const warmupState = {
    unreadReplies: null,
    profiles: [],
    inbox: {
      threads, accounts, unread: threads.filter((row) => row.unread).length, sync, ready: true, available: true, error: "",
      openAccountId: null, openThreadKey: null, open: null, openError: "", openBusy: false
    }
  };
  const calls = [];
  const globals = {
    warmupState,
    document: {
      visibilityState: "visible",
      addEventListener: (type, fn) => { listeners[`document:${type}`] = fn; },
      getElementById: (id) => els[id] || null,
      querySelector: (selector) => ({ click: () => clicks.push(selector) })
    },
    authState: { authenticated: true },
    renderWarmupProfiles: () => calls.push("renderWarmupProfiles"),
    warmupApi: async (path, options) => {
      calls.push({ path, method: options?.method || "GET", body: options?.body ? JSON.parse(options.body) : null });
      if (!api) throw new Error("warmupApi не мав викликатись");
      return api(path, options);
    },
    clearInterval: () => {},
    refreshIcons: () => {},
    ...extra
  };
  const main = loadMain(NAMES, globals, LISTENERS);
  // Змінна модуля, яку людина змінила б на екрані (пошук, звуження), — без самого екрана.
  const set = (name, value) => { main.context.__v = value; vm.runInContext(`${name} = __v`, main.context); };
  return { els, warmupState, clicks, calls, listeners, main, get: main.get, set };
}

const orderOf = (html) => [...html.matchAll(/data-warmup-thread="([^"]+)"/g)].map((match) => match[1]);
const rowOf = (html, key) => html.split('<button class="warmup-thread').find((part) => part.includes(`data-warmup-thread="${key}"`));
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── Список ────────────────────────────────────────────────────────────────

test("відкрито один акаунт — найсвіжіший, — і розмови йдуть лише за датою: непрочитана давня не піднімається над прочитаною свіжою", () => {
  const { els, get } = screen();
  get("renderWarmupInbox")();
  // acc-a має найсвіжішу відповідь (5 хв), тож відкритий він; acc-b із давньою відповіддю не показаний.
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-read", "t-new-unread"], "прочитана свіжа вища за непрочитану годинну");
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /t-old-unread/);
  // Непрочитане лише позначене, а не переставлене.
  assert.match(rowOf(els.warmupInboxBody.innerHTML, "t-new-unread"), /is-unread/);
  assert.doesNotMatch(rowOf(els.warmupInboxBody.innerHTML, "t-read"), /is-unread/);
  assert.equal(els.warmupInboxPill.textContent, "2 непрочитані", "число над списком — усі непрочитані, а не одного акаунта");
  assert.equal(els.warmupInboxTitle.textContent, "Вхідні");
});

test("рядок каже, від кого, яка посада, що саме написали і коли; акаунта на ньому нема — він уже вибраний зверху", () => {
  const { els, get } = screen();
  get("renderWarmupInbox")();
  const row = rowOf(els.warmupInboxBody.innerHTML, "t-new-unread");
  assert.match(row, /Taras Bondar/);
  assert.match(row, /UA lead/);
  assert.match(row, /Коли можна поговорити\?/);
  assert.match(row, /1 год тому/);
  assert.match(row, /is-unread/);
  assert.doesNotMatch(row, /Ви:/, "це написали нам, а не ми");
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /warmup-identity|Anna Kovalenko/, "акаунт названо на рядку, хоча він один і вибраний");
});

test("останнє слово за нами — «Ви:», а мітки агента читаються як мітки, не як текст людини", () => {
  const threads = [
    thread({ threadKey: "ours", lastMessage: { direction: "out", body: "Дякую, напишу завтра.", sentAt: minutesAgo(10) } }),
    thread({ threadKey: "none", lastMessage: { direction: "in", body: "[no text]", sentAt: minutesAgo(20) } }),
    thread({ threadKey: "file", lastMessage: { direction: "in", body: "[attachment]", sentAt: minutesAgo(30) } })
  ];
  const { els, get } = screen({ threads });
  get("renderWarmupInbox")();
  const html = els.warmupInboxBody.innerHTML;
  assert.match(rowOf(html, "ours"), /warmup-thread-from">Ви:<\/span> Дякую, напишу завтра\./);
  assert.match(rowOf(html, "none"), /<em class="warmup-subtle">\(без тексту\)<\/em>/);
  assert.match(rowOf(html, "file"), /<em class="warmup-subtle">\(вкладення без тексту\)<\/em>/);
  assert.doesNotMatch(html, /\[no text\]|\[attachment\]/);
  // У самій розмові — те саме.
  assert.match(get("warmupBodyHtml")("[no text]"), /\(без тексту\)/);
  assert.equal(get("warmupBodyHtml")("Привіт <b>"), "Привіт &lt;b&gt;", "справжній текст лишається текстом, екранованим");
});

test("«Переглянути профіль Sinan» — це Sinan: службові слова LinkedIn перед іменем не показуються", () => {
  const get = screen().get;
  const name = (value) => get("warmupParticipantName")({ name: value });
  assert.equal(name("Переглянути профіль Sinan"), "Sinan");
  assert.equal(name("переглянути   профіль   Edgar Lopez"), "Edgar Lopez");
  assert.equal(name("View profile of Anna Lee"), "Anna Lee");
  assert.equal(name("View Profile Luke"), "Luke");
  // Справжні імена не чіпаємо.
  assert.equal(name("Viewer Smith"), "Viewer Smith");
  assert.equal(name("Oleh Petrenko"), "Oleh Petrenko");
  // Лишились самі службові слова — імені нема.
  assert.equal(name("Переглянути профіль"), "Без імені");
});

test("безіменна людина не підписується чужим іменем", () => {
  const { els, get } = screen({ threads: [thread({ threadKey: "x", participant: { name: "LinkedIn\n   Member" } })] });
  get("renderWarmupInbox")();
  assert.match(els.warmupInboxBody.innerHTML, /Без імені/);
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /LinkedIn\s+Member/);
});

// ── Акаунти зверху ────────────────────────────────────────────────────────

/**
 * Три акаунти: у Оксани відповіді найсвіжіші, в Анни — трохи давніші, в Profile 3 — давні,
 * але непрочитаних там більше, ніж в Анни, — щоб порядок за свіжістю відрізнявся від порядку за непрочитаними.
 */
function accountsThreads() {
  return [
    thread({ threadKey: "c1", accountId: "acc-c", accountIdentity: "Oksana Melnyk", unread: true, lastMessage: { direction: "in", body: "Привіт", sentAt: minutesAgo(1) } }),
    thread({ threadKey: "c2", accountId: "acc-c", accountIdentity: "Oksana Melnyk", unread: true, lastMessage: { direction: "in", body: "Ще раз привіт", sentAt: minutesAgo(2) } }),
    ...threeThreads(),
    thread({ threadKey: "b2", accountId: "acc-b", accountIdentity: null, unread: true, participant: { name: "Pavlo Marchuk", headline: "", slug: "" }, lastMessage: { direction: "in", body: "Добрий день", sentAt: minutesAgo(60 * 72) } })
  ];
}

test("зверху — кнопки лише акаунтів, без «Усі»; найсвіжіший першим, з числом відповідей, що чекають", () => {
  const { els, get } = screen({ threads: accountsThreads() });
  get("renderWarmupInbox")();
  const html = els.warmupInboxAccounts.innerHTML;
  assert.equal(els.warmupInboxAccounts.hidden, false);
  const names = [...html.matchAll(/inbox-chip-name">([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(names, ["Oksana Melnyk", "Anna Kovalenko", "Profile 3"], "за свіжістю відповіді, а не за кількістю непрочитаних");
  const counts = [...html.matchAll(/inbox-chip-count" aria-label="непрочитаних: (\d+)"/g)].map((match) => match[1]);
  assert.deepEqual(counts, ["2", "1", "2"], "у Profile 3 непрочитаних більше, ніж в Анни, але відповіді давніші — тож він останній");
  assert.doesNotMatch(html, /Усі акаунти|data-warmup-account=""/);
  assert.match(html, /is-active[^>]*data-warmup-account="acc-c"[^>]*aria-pressed="true"/, "відкритий — найсвіжіший");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["c1", "c2"], "у списку — лише розмови відкритого акаунта");
});

test("один дотик по акаунту відкриває його і тільки його; пошук іншого акаунта не лишається", () => {
  const { els, listeners, get, main, set } = screen({ threads: accountsThreads() });
  get("renderWarmupInbox")();
  const press = (accountId) => listeners["chips:click"]({ target: { closest: (selector) => (selector === "[data-warmup-account]" ? { dataset: { warmupAccount: accountId } } : null) } });
  set("inboxSearch", "привіт");
  press("acc-b");
  assert.equal(main.get("inboxAccountFilter"), "acc-b");
  assert.equal(main.get("inboxSearch"), "", "пошук по іншому акаунту лишився");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-old-unread", "b2"]);
  assert.match(els.warmupInboxAccounts.innerHTML, /is-active[^>]*data-warmup-account="acc-b"/);
  press("acc-a");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-read", "t-new-unread"]);
  // Дотик повз кнопку або по порожній кнопці нічого не міняє.
  listeners["chips:click"]({ target: { closest: () => null } });
  listeners["chips:click"]({ target: { closest: () => ({ dataset: {} }) } });
  assert.equal(main.get("inboxAccountFilter"), "acc-a");
});

test("відкрита розмова зникає, коли відкривають інший акаунт, і лишається, коли той самий", () => {
  const { els, listeners, warmupState, get } = screen({ threads: accountsThreads() });
  const press = (accountId) => listeners["chips:click"]({ target: { closest: () => ({ dataset: { warmupAccount: accountId } }) } });
  get("renderWarmupInbox")();
  warmupState.inbox.openAccountId = "acc-a";
  warmupState.inbox.openThreadKey = "t-read";
  warmupState.inbox.open = { thread: thread({ threadKey: "t-read" }), messages: [{ direction: "in", body: "Привіт", sentAt: minutesAgo(5) }] };
  press("acc-a");
  assert.equal(warmupState.inbox.openThreadKey, "t-read", "розмова того самого акаунта закрилась");
  press("acc-b");
  assert.equal(warmupState.inbox.openThreadKey, null, "розмова іншого акаунта лишилась поруч зі списком, якому не належить");
  assert.match(els.warmupInboxThread.innerHTML, /Оберіть розмову зі списку/);
});

test("з одним акаунтом кнопка теж є — видно, чий це список; обраний акаунт, якого вже нема, змінюється на найсвіжіший", () => {
  const { els, get, set } = screen({ threads: threeThreads().filter((row) => row.accountId === "acc-a") });
  get("renderWarmupInbox")();
  assert.equal(els.warmupInboxAccounts.hidden, false);
  assert.equal((els.warmupInboxAccounts.innerHTML.match(/inbox-chip /g) || []).length, 1);
  assert.match(els.warmupInboxAccounts.innerHTML, /is-active/);

  set("inboxAccountFilter", "acc-gone");
  assert.equal(get("warmupInboxAccountId")(), "acc-gone", "акаунт, що відкрили явно, лишається відкритим, навіть коли розмов на ньому нема");
  const other = screen({ threads: threeThreads() });
  other.set("inboxAccountFilter", null);
  assert.equal(other.get("warmupInboxAccountId")(), "acc-a", "нічого не вибрано — відкрито найсвіжіший");
});

test("перехід із бейджа акаунта у «Прогріві» відкриває «Вхідні» з цим акаунтом і закриває відкриту розмову", () => {
  const { els, clicks, get, warmupState, main } = screen({ accounts: [{ accountId: "acc-a", identity: "Anna Kovalenko", unread: 1 }, { accountId: "acc-b", label: "Profile 7", unread: 1 }] });
  warmupState.inbox.openAccountId = "acc-a";
  warmupState.inbox.openThreadKey = "t-read";
  get("showWarmupInboxAccount")("acc-b");
  assert.deepEqual(clicks, ['.nav-item[data-view="inbox"]'], "екран «Вхідні» не відкрито через меню");
  assert.equal(main.get("inboxAccountFilter"), "acc-b");
  assert.equal(warmupState.inbox.openThreadKey, null, "розмова іншого акаунта лишилась відкритою");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-old-unread"]);
  assert.match(els.warmupInboxAccounts.innerHTML, /is-active[^>]*data-warmup-account="acc-b"/);
  assert.match(els.warmupInboxAccounts.innerHTML, /Profile 7/);
  // Номер на рядку акаунта в «Прогріві» лишається тим самим числом.
  assert.equal(get("warmupInboxUnreadFor")("acc-a"), 1);
  assert.equal(get("warmupInboxUnreadFor")("acc-z"), 0);
  assert.equal(warmupState.inbox.threads.length, 3, "вибір акаунта не повинен нічого викидати зі стану");
});

test("акаунт без відповідей кажe це, а не показує порожнечу, і лишається серед кнопок", () => {
  const { els, get } = screen({ threads: [thread({ threadKey: "only", accountId: "acc-a" })] });
  get("showWarmupInboxAccount")("acc-b");
  assert.match(els.warmupInboxBody.innerHTML, /Від цього акаунта відповідей немає/);
  assert.match(els.warmupInboxAccounts.innerHTML, /is-active[^>]*data-warmup-account="acc-b"/);
  assert.equal(els.warmupInboxAccounts.hidden, false);
});

// ── Про читання вхідних і порожні стани ───────────────────────────────────

test("про читання вхідних скаже одне — найгірше", () => {
  // Час читання екран бере і з відповіді сервера, і з самих розмов — найновіший,
  // тож розмови в кожному наборі несуть той час, який набір має означати.
  const syncedAt = (when) => threeThreads().map((row) => ({ ...row, lastSyncedAt: when }));
  const noteOf = (s) => { s.get("renderWarmupInbox")(); return s.els.warmupInboxNotice; };

  const stale = screen({ threads: syncedAt(minutesAgo(60 * 50)), sync: { lastSyncedAt: minutesAgo(60 * 50) } });
  assert.match(noteOf(stale).innerHTML, /схоже, агент зупинився/);
  assert.equal((stale.els.warmupInboxNotice.innerHTML.match(/warmup-inbox-note/g) || []).length, 1, "більше однієї примітки про читання");
  assert.equal(stale.els.warmupInboxNotice.hidden, false);
  assert.equal(stale.els.warmupInboxLayout.hidden, false, "розмови поруч із приміткою мають лишитись");

  // «N з M акаунтів ще не читали» більше не говориться: M рахував усі акаунти, які знає сервер,
  // а не ті, що на прогріві, — і казав п'ять там, де на прогріві три.
  const partial = screen({ threads: syncedAt(minutesAgo(30)), sync: { lastSyncedAt: minutesAgo(30), accountsTotal: 5, accountsSynced: 4 } });
  assert.equal(noteOf(partial).innerHTML, "");
  assert.equal(partial.els.warmupInboxNotice.hidden, true);
  assert.doesNotMatch(partial.els.warmupInboxNotice.innerHTML, /акаунт/);

  const calm = screen({ threads: syncedAt(minutesAgo(30)), sync: { lastSyncedAt: minutesAgo(30) } });
  assert.equal(noteOf(calm).innerHTML, "");
  assert.equal(calm.els.warmupInboxNotice.hidden, true);
  assert.match(calm.els.warmupInboxSubtitle.textContent, /читали 30 хв тому/);
});

test("порожня вхідна каже, читали її чи ні, і не малює ні акаунтів, ні порожніх панелей", () => {
  const never = screen({ threads: [], sync: { lastSyncedAt: null } });
  never.get("renderWarmupInbox")();
  assert.match(never.els.warmupInboxNotice.innerHTML, /ще жодного разу не читали/);
  assert.match(never.els.warmupInboxNotice.innerHTML, /is-bad/);

  const read = screen({ threads: [], sync: { lastSyncedAt: minutesAgo(30) } });
  read.get("renderWarmupInbox")();
  assert.match(read.els.warmupInboxNotice.innerHTML, /Відповідей поки немає/);
  assert.match(read.els.warmupInboxNotice.innerHTML, /Читали 30 хв тому/);
  assert.equal(read.els.warmupInboxLayout.hidden, true);
  assert.equal(read.els.warmupInboxAccounts.hidden, true);
  assert.equal(read.els.warmupInboxPill.textContent, "поки нічого");

  const unknown = screen({ threads: [], sync: null });
  unknown.get("renderWarmupInbox")();
  assert.match(unknown.els.warmupInboxNotice.innerHTML, /невідомо, коли вхідні читали востаннє/);
});

test("сервер без вхідних, помилка читання і завантаження кажуть це одним повідомленням на всю панель", () => {
  const off = screen();
  off.warmupState.inbox.available = false;
  off.get("renderWarmupInbox")();
  assert.match(off.els.warmupInboxNotice.innerHTML, /немає ендпоїнта вхідних/);
  assert.equal(off.els.warmupInboxLayout.hidden, true);
  assert.equal(off.els.warmupInboxPill.textContent, "немає на цьому сервері");

  const broken = screen();
  broken.warmupState.inbox.error = "Сервер мовчить";
  broken.get("renderWarmupInbox")();
  assert.match(broken.els.warmupInboxNotice.innerHTML, /Сервер мовчить/);
  assert.equal(broken.els.warmupInboxLayout.hidden, true);
  assert.equal(broken.els.warmupInboxAccounts.hidden, true);
  assert.equal(broken.els.warmupInboxPill.textContent, "недоступно");

  const loading = screen();
  loading.warmupState.inbox.ready = false;
  loading.get("renderWarmupInbox")();
  assert.match(loading.els.warmupInboxNotice.innerHTML, /Завантажуємо вхідні/);
  assert.equal(loading.els.warmupInboxLayout.hidden, true);
});

// ── Дві сторони: список і розмова ─────────────────────────────────────────

test("поки розмову не обрано, праворуч підказка і найкоротший шлях почати: перша непрочитана", () => {
  const { els, get } = screen();
  get("renderWarmupInbox")();
  assert.match(els.warmupInboxThread.innerHTML, /Оберіть розмову зі списку/);
  assert.match(els.warmupInboxThread.innerHTML, /data-warmup-inbox-next/);
  assert.match(els.warmupInboxThread.innerHTML, /Почати з непрочитаної: Taras Bondar/);
  assert.equal(els.warmupInboxLayout.classList.contains("has-thread"), false);
  assert.equal(els["view-inbox"].classList.contains("inbox-has-thread"), false);

  // Усе прочитано — починати нема з чого, лишається підказка.
  const calm = screen({ threads: threeThreads().map((row) => ({ ...row, unread: false })) });
  calm.get("renderWarmupInbox")();
  assert.match(calm.els.warmupInboxThread.innerHTML, /Оберіть розмову зі списку/);
  assert.doesNotMatch(calm.els.warmupInboxThread.innerHTML, /data-warmup-inbox-next/);
});

test("відкрита розмова стоїть праворуч, а її рядок у списку позначений; список лишається на місці", () => {
  const { els, warmupState, get } = screen();
  warmupState.inbox.openAccountId = "acc-a";
  warmupState.inbox.openThreadKey = "t-read";
  warmupState.inbox.open = { thread: thread({ threadKey: "t-read", crmContactId: "c1" }), messages: [{ direction: "in", body: "Дякую, я вже бачив.", sentAt: minutesAgo(5) }] };
  get("renderWarmupInbox")();
  assert.equal(els.warmupInboxLayout.classList.contains("has-thread"), true, "на телефоні має показатись розмова, а не список");
  assert.equal(els["view-inbox"].classList.contains("inbox-has-thread"), true, "над розмовою на телефоні лишились примітка й акаунти");
  assert.match(els.warmupInboxThread.innerHTML, /Oleh Petrenko/);
  assert.match(els.warmupInboxThread.innerHTML, /Дякую, я вже бачив\./);
  assert.match(els.warmupInboxThread.innerHTML, /data-warmup-inbox-back/);
  assert.match(els.warmupInboxThread.innerHTML, /Назад до списку/);
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-read", "t-new-unread"], "список не зник");
  assert.match(rowOf(els.warmupInboxBody.innerHTML, "t-read"), /is-open[\s\S]*aria-current="true"/);
  assert.doesNotMatch(rowOf(els.warmupInboxBody.innerHTML, "t-new-unread"), /aria-current/);
  assert.equal(els.warmupInboxTitle.textContent, "Вхідні", "заголовок не міняється на ім'я людини");
});

test("розмова: з неї є хід в CRM, коли контакт відомий, і чесне «не знайдено», коли ні", () => {
  const withContact = screen();
  withContact.warmupState.inbox.open = { thread: thread({ crmContactId: 4412, outreachStatus: "accepted" }), messages: [{ direction: "in", body: "Привіт", sentAt: minutesAgo(5) }] };
  const html = withContact.get("warmupThreadViewHtml")();
  assert.match(html, /data-warmup-contact="4412"/);
  assert.match(html, /Відкрити в CRM/);
  assert.doesNotMatch(html, /Картка контакту/);
  assert.match(html, /їхній LinkedIn/);
  assert.match(html, /надійшло на Anna Kovalenko/);

  const without = screen();
  without.warmupState.inbox.open = { thread: thread({ crmContactId: null }), messages: [{ direction: "in", body: "Привіт", sentAt: minutesAgo(5) }] };
  const bare = without.get("warmupThreadViewHtml")();
  assert.doesNotMatch(bare, /data-warmup-contact/);
  assert.match(bare, /у CRM цієї людини не знайдено/);
});

test("клік: по кнопці в розмові — CRM, по рядку — розмова, «Назад» і «Скинути пошук» — як сказано", async () => {
  const contacts = [];
  const { listeners, calls, get, main, set, warmupState } = screen({
    api: async () => ({ thread: thread({ threadKey: "t-1" }), messages: [] }),
    extra: { showContactCard: (id) => contacts.push(id) }
  });
  const click = (map) => listeners["layout:click"]({ target: { closest: (selector) => map[selector] || null } });

  click({ "[data-warmup-contact]": { dataset: { warmupContact: "4412" } } });
  assert.deepEqual(contacts, ["4412"]);

  click({ "[data-warmup-thread]": { dataset: { warmupThreadAccount: "acc-a", warmupThread: "t-1" } } });
  await tick();
  assert.ok(calls.some((call) => call.path === "/inbox/thread?threadKey=t-1&accountId=acc-a"), "клік по рядку не відкрив розмову");

  // Посилання всередині рядка — це посилання, а не рядок.
  const before = calls.length;
  click({ a: {}, "[data-warmup-thread]": { dataset: { warmupThreadAccount: "acc-a", warmupThread: "t-2" } } });
  assert.equal(calls.length, before);

  // «Назад до списку» закриває розмову.
  assert.equal(warmupState.inbox.openThreadKey, "t-1");
  click({ "[data-warmup-inbox-back]": {} });
  assert.equal(warmupState.inbox.openThreadKey, null);

  // «Скинути пошук» знімає пошук, а відкритий акаунт лишає: акаунтів «усіх» нема, повертатись нікуди.
  get("showWarmupInboxAccount")("acc-b");
  set("inboxSearch", "iryna");
  assert.equal(main.get("inboxAccountFilter"), "acc-b");
  click({ "[data-warmup-inbox-reset]": {} });
  assert.equal(main.get("inboxSearch"), "", "«Скинути пошук» не зняло пошук");
  assert.equal(main.get("inboxAccountFilter"), "acc-b", "«Скинути пошук» заодно змінило акаунт");
});

test("відкриття непрочитаної розмови позначає її прочитаною і бере лічильник у сервера", async () => {
  const { warmupState, calls, els, get } = screen({
    api: async (path) => {
      if (path.startsWith("/inbox/thread")) return { thread: thread({ threadKey: "t-new-unread", crmContactId: 7 }), messages: [{ direction: "in", body: "Коли можна поговорити?", sentAt: minutesAgo(60) }] };
      if (path === "/inbox/read") return { success: true, unread: 5 };
      throw new Error(`невідомий маршрут ${path}`);
    }
  });
  await get("openWarmupThread")("acc-a", "t-new-unread");

  const read = calls.filter((call) => call.path === "/inbox/read");
  assert.equal(read.length, 1);
  assert.deepEqual(read[0].body, { threadKey: "t-new-unread", accountId: "acc-a" });
  assert.equal(warmupState.inbox.threads.find((row) => row.threadKey === "t-new-unread").unread, false);
  // Число на пункті меню — відповідь сервера, а не арифметика екрана.
  assert.equal(warmupState.unreadReplies, 5);
  assert.equal(els.warmupNavBadge.textContent, "5");
  assert.equal(els.warmupNavBadge.hidden, false);

  // Уже прочитану розмову вдруге не позначають.
  await get("openWarmupThread")("acc-a", "t-new-unread");
  assert.equal(calls.filter((call) => call.path === "/inbox/read").length, 1);
});

test("розмова перемальовується, лише коли вона змінилась, і з того ж місця, а інша розмова — зверху", () => {
  const { els, warmupState, get } = screen();
  warmupState.inbox.openAccountId = "acc-a";
  warmupState.inbox.openThreadKey = "t-read";
  warmupState.inbox.open = { thread: thread({ threadKey: "t-read" }), messages: [{ direction: "in", body: "Привіт", sentAt: minutesAgo(5) }] };
  let writes = 0;
  let html = "";
  Object.defineProperty(els.warmupInboxThread, "innerHTML", { get: () => html, set: (value) => { writes += 1; html = value; } });

  get("renderWarmupInbox")();
  assert.equal(writes, 1);
  els.warmupInboxThread.scrollTop = 120;

  // Список перечитали, а розмова та сама: праворуч нічого не мінялось.
  get("renderWarmupInbox")();
  assert.equal(writes, 1, "розмову перемалювали без потреби");
  assert.equal(els.warmupInboxThread.scrollTop, 120);

  // Змінився вміст (немає більше непрочитаних, зникла кнопка) — перемальовано, але на тому ж місці.
  for (const row of warmupState.inbox.threads) row.unread = false;
  get("renderWarmupInbox")();
  assert.equal(writes, 2);
  assert.equal(els.warmupInboxThread.scrollTop, 120, "читача кинуло нагору, хоч розмова та сама");

  // Інша розмова — з початку.
  warmupState.inbox.openThreadKey = "t-new-unread";
  warmupState.inbox.open = { thread: thread({ threadKey: "t-new-unread" }), messages: [{ direction: "in", body: "Інше", sentAt: minutesAgo(1) }] };
  get("renderWarmupInbox")();
  assert.equal(writes, 3);
  assert.equal(els.warmupInboxThread.scrollTop, 0);
});

// ── Лічильник на пункті меню ──────────────────────────────────────────────

test("лічильник на пункті меню береться при вході в застосунок, а не лише коли відкрито «Вхідні»", async () => {
  const source = mainSource();
  // Ядро кличе зареєстровані хуки одразу після входу, на яку б вкладку людина не потрапила…
  assert.match(declaration(source, "enterWorkspace"), /for \(const hook of enterHooks\)/);
  // …а екран «Вхідні» просить у нього саме лічильник.
  assert.match(source, /^onWorkspaceEnter\(\(\) => refreshWarmupBadge\(\)\);$/m, "екран Вхідні не просить лічильник при вході");

  const { els, warmupState, get } = screen({
    api: async (path) => {
      assert.equal(path, "/config");
      return { configured: true, unreadReplies: 3 };
    }
  });
  assert.equal(warmupState.unreadReplies, null);
  await get("refreshWarmupBadge")();
  assert.equal(warmupState.unreadReplies, 3);
  assert.equal(els.warmupNavBadge.hidden, false);
  assert.equal(els.warmupNavBadge.textContent, "3");
});

test("сервер без прогріву не лякає лічильником і більше не опитується", async () => {
  const { els, warmupState, get } = screen({ api: async () => ({ configured: false }) });
  await get("refreshWarmupBadge")();
  assert.equal(warmupState.unreadReplies, 0);
  assert.equal(els.warmupNavBadge.hidden, true);
});

// ── Пошук ─────────────────────────────────────────────────────────────────

const typeSearch = (listeners, value) => listeners["search:input"]({ target: { value } });

test("пошук знаходить за іменем, посадою, акаунтом і текстом відповіді; усі слова мають збігтися, регістр не важить", () => {
  const { els, listeners, get } = screen();
  get("renderWarmupInbox")();
  for (const [query, expected] of [
    ["taras", ["t-new-unread"]],
    ["TARAS", ["t-new-unread"]],
    ["ua lead", ["t-new-unread"]],
    ["anna", []],
    ["дякую", ["t-read"]],
    ["taras поговорити", ["t-new-unread"]],
    ["taras дякую", []],
    ["  taras   ", ["t-new-unread"]]
  ]) {
    typeSearch(listeners, query);
    assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), expected, `запит «${query}»`);
  }
  typeSearch(listeners, "");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-read", "t-new-unread"], "порожній пошук має повернути все з відкритого акаунта");
});

test("пошук не шукає в мітках агента: «text» не знаходить повідомлення без тексту", () => {
  const { els, listeners, get } = screen({ threads: [thread({ threadKey: "none", participant: { name: "Zed" }, lastMessage: { direction: "in", body: "[no text]", sentAt: minutesAgo(5) } })] });
  get("renderWarmupInbox")();
  typeSearch(listeners, "text");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), []);
  typeSearch(listeners, "zed");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["none"]);
});

test("самі пробіли в пошуку — не фільтр: рядка з лічильником нема, список повний", () => {
  const { els, listeners, get } = screen();
  get("renderWarmupInbox")();
  typeSearch(listeners, "   ");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-read", "t-new-unread"]);
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /warmup-inbox-filter/);
});

test("під пошуком сказано, скільки розмов лишилось із скількох, а порожній результат — що шукали і як скинути", () => {
  const { els, warmupState, listeners, get } = screen();
  get("renderWarmupInbox")();
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /warmup-inbox-filter/, "без пошуку рядка з лічильником нема");

  typeSearch(listeners, "taras");
  assert.match(els.warmupInboxBody.innerHTML, /Знайдено: <strong>1<\/strong> з 2/, "«з» — розмови відкритого акаунта, а не всіх");
  assert.match(els.warmupInboxBody.innerHTML, /Скинути пошук/);
  assert.match(els.warmupInboxBody.innerHTML, /data-warmup-inbox-reset/);

  typeSearch(listeners, "такого немає");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), []);
  assert.match(els.warmupInboxBody.innerHTML, /За цим запитом нічого не знайшлось/);
  assert.match(els.warmupInboxBody.innerHTML, /Знайдено: <strong>0<\/strong> з 2/);
  assert.match(els.warmupInboxBody.innerHTML, /data-warmup-inbox-reset/);
  assert.equal(warmupState.inbox.threads.length, 3, "пошук нічого не викидає зі стану");
});

test("пошук шукає лише в відкритому акаунті, а перемикання акаунта його скидає", () => {
  const { els, listeners, get } = screen();
  get("renderWarmupInbox")();
  const press = (accountId) => listeners["chips:click"]({ target: { closest: () => ({ dataset: { warmupAccount: accountId } }) } });
  typeSearch(listeners, "дякую");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-read"]);
  typeSearch(listeners, "iryna");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), [], "розмова Ірини на іншому акаунті");
  press("acc-b");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-old-unread"], "акаунт відкрито, Ірина в ньому знайшлась");
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /warmup-inbox-filter/);
  press("acc-a");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-read", "t-new-unread"]);
});

test("поле пошуку не перезаписується, поки в ньому вже те саме: людина не втрачає курсор посеред слова", () => {
  const { els, listeners, get, set } = screen();
  const writes = [];
  let stored = "";
  Object.defineProperty(els.warmupInboxSearch, "value", { get: () => stored, set: (value) => { writes.push(value); stored = value; } });
  get("renderWarmupInbox")();
  // З пробілом наприкінці: людина щойно його набрала й ще пише друге слово.
  stored = "tar ";
  writes.length = 0;
  typeSearch(listeners, "tar ");
  get("renderWarmupInbox")();
  assert.deepEqual(writes, [], "поле перезаписали тим самим значенням (пробіл наприкінці загубився б)");
  // А коли фільтр скинуто кнопкою, поле очищається.
  set("inboxSearch", "");
  get("renderWarmupInbox")();
  assert.deepEqual(writes, [""]);
});

// ── Наступна непрочитана ──────────────────────────────────────────────────

/** Відкритий акаунт з трьома розмовами, двоє з них непрочитані: Тарас (годину тому) і Марта (вчора). */
function accountWithTwoUnread() {
  return [
    thread({ threadKey: "t-read", unread: false, lastMessage: { direction: "in", body: "Дякую, я вже бачив.", sentAt: minutesAgo(5) } }),
    thread({ threadKey: "t-new-unread", unread: true, participant: { name: "Taras Bondar", headline: "UA lead", slug: "taras-bondar" }, lastMessage: { direction: "in", body: "Коли можна поговорити?", sentAt: minutesAgo(60) } }),
    thread({ threadKey: "t-marta", unread: true, participant: { name: "Marta Kovalenko", headline: "CMO", slug: "marta" }, lastMessage: { direction: "in", body: "Надішліть кейси.", sentAt: minutesAgo(60 * 24) } }),
    thread({ threadKey: "t-other-account", unread: true, accountId: "acc-b", accountIdentity: null, participant: { name: "Iryna Shevchenko", headline: "", slug: "" }, lastMessage: { direction: "in", body: "Привіт!", sentAt: minutesAgo(60 * 48) } })
  ];
}

test("в кінці розмови є кнопка до наступної непрочитаної, і вона називає, до кого веде", async () => {
  const opened = [];
  const { els, warmupState, listeners, get, calls } = screen({
    threads: accountWithTwoUnread(),
    api: async (path) => {
      if (path.startsWith("/inbox/thread")) return { thread: thread({ threadKey: "t-new-unread", participant: { name: "Taras Bondar", headline: "", slug: "" } }), messages: [{ direction: "in", body: "Коли можна поговорити?", sentAt: minutesAgo(60) }] };
      if (path === "/inbox/read") return { success: true, unread: 2 };
      throw new Error(`невідомий маршрут ${path}`);
    },
    extra: { scrollTo: (x, y) => opened.push(["scroll", x, y]) }
  });
  // Відкрито Тараса; непрочитаною в цьому ж акаунті лишилась Марта. Ірина на іншому акаунті — не наступна.
  await get("openWarmupThread")("acc-a", "t-new-unread");
  const html = els.warmupInboxThread.innerHTML;
  assert.match(html, /data-warmup-inbox-next/);
  assert.match(html, /Наступна непрочитана: Marta Kovalenko/);
  assert.equal((html.match(/data-warmup-inbox-next/g) || []).length, 1);

  // Клік відкриває саме її і піднімає сторінку нагору.
  listeners["layout:click"]({ target: { closest: (selector) => (selector === "[data-warmup-inbox-next]" ? {} : null) } });
  await tick();
  assert.ok(calls.some((call) => call.path === "/inbox/thread?threadKey=t-marta&accountId=acc-a"), "відкрито не ту розмову");
  assert.deepEqual(opened, [["scroll", 0, 0]]);
  assert.equal(warmupState.inbox.openThreadKey, "t-marta");
});

test("наступна непрочитана береться з відкритого акаунта й пошуку, а коли її нема — кнопки теж нема", async () => {
  const { els, warmupState, get, set } = screen({
    threads: accountWithTwoUnread(),
    api: async (path) => {
      if (path.startsWith("/inbox/thread")) return { thread: thread({ threadKey: "t-marta" }), messages: [{ direction: "in", body: "Привіт", sentAt: minutesAgo(1) }] };
      if (path === "/inbox/read") return { success: true, unread: 1 };
      throw new Error(`невідомий маршрут ${path}`);
    }
  });
  // Відкрито Марту — останню непрочитану цього акаунта; Ірина на іншому, тож далі йти нікуди.
  warmupState.inbox.threads.find((row) => row.threadKey === "t-new-unread").unread = false;
  await get("openWarmupThread")("acc-a", "t-marta");
  assert.doesNotMatch(els.warmupInboxThread.innerHTML, /data-warmup-inbox-next/);

  // Звужено пошуком до Тараса: наступна — він, а не будь-яка непрочитана.
  warmupState.inbox.threads.find((row) => row.threadKey === "t-new-unread").unread = true;
  set("inboxSearch", "taras");
  get("renderWarmupInbox")();
  assert.equal(get("warmupNextUnread")().threadKey, "t-new-unread");
  set("inboxSearch", "nobody");
  assert.equal(get("warmupNextUnread")(), null);

  // Тільки прочитані: кнопки нема.
  set("inboxSearch", "");
  for (const row of warmupState.inbox.threads) row.unread = false;
  get("renderWarmupInbox")();
  assert.doesNotMatch(els.warmupInboxThread.innerHTML, /data-warmup-inbox-next/);
  // Помилка читання розмови: кнопки до наступної теж нема.
  warmupState.inbox.openError = "Не вдалося";
  assert.doesNotMatch(get("warmupThreadViewHtml")(), /data-warmup-inbox-next/);
});

// ── Оновлення ─────────────────────────────────────────────────────────────

test("новий лічильник, поки на екрані «Вхідні», перечитує список — навіть коли відкрита розмова: вона стоїть окремо", async () => {
  const requested = [];
  const make = (options = {}) => screen({
    ...options,
    api: async (path) => {
      requested.push(path);
      if (path === "/config") return { configured: true, unreadReplies: 4 };
      if (path === "/inbox") return { success: true, unread: 4, threads: [], accounts: [], sync: null };
      throw new Error(`невідомий маршрут ${path}`);
    }
  });

  // Список на екрані, число змінилось (2 → 4): список перечитано.
  let s = make();
  s.warmupState.unreadReplies = 2;
  await s.get("refreshWarmupBadge")();
  await tick();
  assert.deepEqual(requested, ["/config", "/inbox"]);

  // Те саме число — нічого не перечитується.
  requested.length = 0;
  s = make();
  s.warmupState.unreadReplies = 4;
  await s.get("refreshWarmupBadge")();
  assert.deepEqual(requested, ["/config"]);

  // Перше число за сесію — це не «зміна»: список відкриється сам і сам себе прочитає.
  requested.length = 0;
  s = make();
  await s.get("refreshWarmupBadge")();
  assert.deepEqual(requested, ["/config"]);

  // Розмова відкрита: список усе одно оновлюється, бо розмова поруч, а не замість нього.
  requested.length = 0;
  s = make();
  s.warmupState.unreadReplies = 2;
  s.warmupState.inbox.openThreadKey = "t-read";
  s.warmupState.inbox.openAccountId = "acc-a";
  await s.get("refreshWarmupBadge")();
  await tick();
  assert.deepEqual(requested, ["/config", "/inbox"]);

  // Інший екран на видноті: вхідні не читаються даремно, лічильник усе одно оновився.
  requested.length = 0;
  s = make({ active: false });
  s.warmupState.unreadReplies = 2;
  await s.get("refreshWarmupBadge")();
  assert.deepEqual(requested, ["/config"]);
  assert.equal(s.warmupState.unreadReplies, 4);
});

test("повернення на вкладку одразу бере лічильник, прихована вкладка його не питає", async () => {
  const s = screen({ api: async () => ({ configured: true, unreadReplies: 1 }) });
  s.main.context.document.visibilityState = "hidden";
  await s.listeners["document:visibilitychange"]();
  assert.equal(s.calls.length, 0, "прихована вкладка спитала лічильник");
  s.main.context.document.visibilityState = "visible";
  await s.listeners["document:visibilitychange"]();
  await tick();
  assert.deepEqual(s.calls.map((call) => call.path), ["/config"]);
});

test("«Оновити» перечитує список і відкриту розмову, а розмова при цьому не блимає порожнім екраном", async () => {
  const { warmupState, listeners, get, calls } = screen({
    api: async (path) => {
      if (path === "/inbox") return { success: true, unread: 2, threads: threeThreads(), accounts: [], sync: null };
      if (path.startsWith("/inbox/thread")) return { thread: thread({ threadKey: "t-read" }), messages: [{ direction: "in", body: "Нове", sentAt: minutesAgo(1) }] };
      throw new Error(`невідомий маршрут ${path}`);
    }
  });
  warmupState.inbox.openAccountId = "acc-a";
  warmupState.inbox.openThreadKey = "t-read";
  const shown = { thread: thread({ threadKey: "t-read" }), messages: [{ direction: "in", body: "Старе", sentAt: minutesAgo(9) }] };
  warmupState.inbox.open = shown;

  // Перечитування розмови, що вже відкрита, лишає її на екрані, поки йде відповідь…
  const pending = get("openWarmupThread")("acc-a", "t-read", { refresh: true });
  assert.equal(warmupState.inbox.open, shown, "розмова зникла, поки йшло оновлення");
  await pending;
  assert.equal(warmupState.inbox.open.messages[0].body, "Нове");

  // …а відкриття розмови з нуля, навпаки, ховає попередню.
  const fresh = get("openWarmupThread")("acc-a", "t-new-unread");
  assert.equal(warmupState.inbox.open, null);
  await fresh;

  // Кнопка робить і те, і те.
  calls.length = 0;
  warmupState.inbox.openAccountId = "acc-a";
  warmupState.inbox.openThreadKey = "t-read";
  await listeners["refresh:click"]();
  await tick();
  assert.deepEqual(calls.map((call) => call.path).filter((path) => path !== "/inbox/read"), ["/inbox", "/inbox/thread?threadKey=t-read&accountId=acc-a"]);

  // Без відкритої розмови — лише список.
  calls.length = 0;
  warmupState.inbox.openAccountId = null;
  warmupState.inbox.openThreadKey = null;
  await listeners["refresh:click"]();
  await tick();
  assert.deepEqual(calls.map((call) => call.path), ["/inbox"]);
});
