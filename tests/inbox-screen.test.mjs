import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { loadMain, mainSource, declaration } from "./app-main-excerpt.mjs";

/**
 * «Вхідні» — відповіді всіх акаунтів прогріву на одному екрані (282569c2).
 *
 * Що має бути видно й що має працювати, без браузера: код екрана береться з
 * app/screens/inbox.js і запускається проти заглушок DOM. Сервер тут не
 * потрібен — API вхідних не змінювався, а решта цього екрана — те, як
 * відповідь лягає на сторінку.
 */

const NAMES = [
  "escapeHtml", "escapeAttr", "uaPlural", "warmupCount",
  "WARMUP_OUTREACH_LABEL", "WARMUP_OUTREACH_TONE",
  "WARMUP_SYNC_STALE_HOURS", "inboxAccountFilter",
  "warmupAgo", "warmupStamp", "warmupHoursSince", "warmupBodyHtml", "warmupPreviewHtml", "warmupProfileUrl",
  "WARMUP_UNNAMED", "warmupParticipantUnnamed", "warmupParticipantName", "warmupParticipantNameAttr",
  "warmupThreadAccount", "warmupAccountTitle", "warmupInboxSync", "warmupInboxNoteHtml", "warmupInboxEmptyHtml",
  "warmupInboxRows", "warmupThreadRowHtml", "warmupInboxAccountName", "warmupInboxUnreadFor", "warmupInboxFilterHtml",
  "warmupMessageHtml", "warmupThreadViewHtml", "renderWarmupInbox", "renderWarmupNavBadge", "setWarmupUnread",
  "refreshWarmupBadge", "stopWarmupBadgePoll", "warmupThreadIsOpen", "markWarmupThreadRead", "openWarmupThread",
  "closeWarmupThread", "showWarmupInboxAccount", "loadWarmupInbox",
  "inboxSearch", "inboxSearchTerms", "warmupInboxMatches", "warmupInboxAccountOptions", "renderWarmupInboxTools", "warmupNextUnread", "warmupInboxListOnScreen"
];

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

function element() {
  return { textContent: "", innerHTML: "", hidden: false, className: "", title: "", attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } };
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

/** Три розмови двох акаунтів: прочитана свіжа, непрочитана давня, непрочитана вчорашня-годинна. */
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

function screen({ threads = threeThreads(), accounts = [], sync = null, api, extra = {}, statements = [], active = true } = {}) {
  const els = {
    warmupInboxTitle: element(), warmupInboxSubtitle: element(), warmupInboxPill: element(),
    warmupInboxBody: element(), warmupNavBadge: element(),
    // Інструменти над списком і сам екран: пошук, вибір акаунта, чи видно список.
    warmupInboxTools: element(), warmupInboxAccountPick: element(),
    warmupInboxAccountSelect: { ...element(), value: "" }, warmupInboxSearch: { ...element(), value: "" },
    "view-inbox": { classList: { contains: (name) => name === "active" && active } }
  };
  const clicks = [];
  const listeners = {};
  els.warmupInboxBody.addEventListener = (type, fn) => { listeners[type] = fn; };
  els.warmupInboxAccountSelect.addEventListener = (type, fn) => { listeners[`select:${type}`] = fn; };
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
  const main = loadMain(NAMES, globals, statements);
  // Змінна модуля, яку людина змінила б на екрані (пошук, звуження), — без самого екрана.
  const set = (name, value) => { main.context.__v = value; vm.runInContext(`${name} = __v`, main.context); };
  return { els, warmupState, clicks, calls, listeners, main, get: main.get, set };
}

const orderOf = (html) => [...html.matchAll(/data-warmup-thread="([^"]+)"/g)].map((match) => match[1]);

test("відповіді всіх акаунтів — одним списком: непрочитані зверху, всередині — найновіші першими", () => {
  const { els, get } = screen();
  get("renderWarmupInbox")();
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-new-unread", "t-old-unread", "t-read"]);
  // Один список, а не по блоку на акаунт: заголовків акаунтів нема.
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /warmup-thread-group/);
  assert.equal(els.warmupInboxPill.textContent, "2 непрочитані");
});

test("рядок каже, від кого, з якого акаунта і що саме написали, коли", () => {
  const { els, get } = screen();
  get("renderWarmupInbox")();
  const row = els.warmupInboxBody.innerHTML.split('<button class="warmup-thread').find((part) => part.includes('data-warmup-thread="t-new-unread"'));
  assert.match(row, /Taras Bondar/);
  assert.match(row, /UA lead/);
  assert.match(row, /Anna Kovalenko/, "акаунт, на який надійшло, не названо");
  assert.match(row, /«Коли можна поговорити\?»/);
  assert.match(row, /Написали нам/);
  assert.match(row, /1 год тому/);
  assert.match(row, /is-unread/);
  // Акаунт без особи називається за міткою профілю, і це видно з підказки.
  const second = els.warmupInboxBody.innerHTML.split('<button class="warmup-thread').find((part) => part.includes('data-warmup-thread="t-old-unread"'));
  assert.match(second, /Profile 3/);
  assert.match(second, /Назва профілю в Anty/);
});

test("безіменна людина не підписується чужим іменем", () => {
  const { els, get } = screen({ threads: [thread({ threadKey: "x", participant: { name: "LinkedIn\n   Member" } })] });
  get("renderWarmupInbox")();
  assert.match(els.warmupInboxBody.innerHTML, /Без імені/);
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /LinkedIn\s+Member/);
});

test("перехід із бейджа акаунта у «Прогріві» відкриває «Вхідні», звужені до цього акаунта, з дорогою назад", () => {
  const { els, clicks, get, warmupState } = screen({ accounts: [{ accountId: "acc-a", identity: "Anna Kovalenko", unread: 1 }, { accountId: "acc-b", label: "Profile 7", unread: 1 }] });
  get("showWarmupInboxAccount")("acc-b");
  assert.deepEqual(clicks, ['.nav-item[data-view="inbox"]'], "екран «Вхідні» не відкрито через меню");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-old-unread"]);
  // Звуження видно у списку акаунтів над відповідями, а під ним — скільки розмов лишилось і як скинути.
  assert.match(els.warmupInboxAccountSelect.innerHTML, /<option value="acc-b" selected>Profile 7 \(1, непрочитаних 1\)<\/option>/);
  assert.equal(els.warmupInboxAccountSelect.value, "acc-b");
  assert.match(els.warmupInboxBody.innerHTML, /Розмов: <strong>1<\/strong> з 3/);
  assert.match(els.warmupInboxBody.innerHTML, /data-warmup-inbox-reset/);
  // Номер на рядку акаунта в «Прогріві» лишається тим самим числом.
  assert.equal(get("warmupInboxUnreadFor")("acc-a"), 1);
  assert.equal(get("warmupInboxUnreadFor")("acc-z"), 0);
  assert.equal(warmupState.inbox.threads.length, 3, "звуження не повинно нічого викидати зі стану");
});

test("акаунт без відповідей кажe це, а не показує порожнечу", () => {
  const { els, get } = screen({ threads: [thread({ threadKey: "only", accountId: "acc-a" })] });
  get("showWarmupInboxAccount")("acc-b");
  assert.match(els.warmupInboxBody.innerHTML, /Від цього акаунта відповідей немає/);
});

test("про читання вхідних скаже одне — найгірше", () => {
  // Час читання екран бере і з відповіді сервера, і з самих розмов — найновіший,
  // тож розмови в кожному наборі несуть той час, який набір має означати.
  const syncedAt = (when) => threeThreads().map((row) => ({ ...row, lastSyncedAt: when }));

  const never = screen({ threads: [], sync: { lastSyncedAt: null } });
  never.get("renderWarmupInbox")();
  assert.match(never.els.warmupInboxBody.innerHTML, /ще жодного разу не читали/);
  assert.match(never.els.warmupInboxBody.innerHTML, /is-bad/);

  const stale = screen({ threads: syncedAt(minutesAgo(60 * 50)), sync: { lastSyncedAt: minutesAgo(60 * 50) } });
  stale.get("renderWarmupInbox")();
  assert.match(stale.els.warmupInboxBody.innerHTML, /схоже, агент зупинився/);
  assert.equal((stale.els.warmupInboxBody.innerHTML.match(/warmup-inbox-note/g) || []).length, 1, "більше однієї примітки про читання");

  const partial = screen({ threads: syncedAt(minutesAgo(30)), sync: { lastSyncedAt: minutesAgo(30), accountsTotal: 3, accountsSynced: 2 } });
  partial.get("renderWarmupInbox")();
  assert.match(partial.els.warmupInboxBody.innerHTML, /1 з 3 акаунтів ще не читали/);

  const calm = screen({ threads: syncedAt(minutesAgo(30)), sync: { lastSyncedAt: minutesAgo(30), accountsTotal: 3, accountsSynced: 3 } });
  calm.get("renderWarmupInbox")();
  assert.doesNotMatch(calm.els.warmupInboxBody.innerHTML, /warmup-inbox-note/);
  assert.match(calm.els.warmupInboxSubtitle.textContent, /читали 30 хв тому/);
});

test("порожня вхідна каже, читали її чи ні", () => {
  const read = screen({ threads: [], sync: { lastSyncedAt: minutesAgo(30) } });
  read.get("renderWarmupInbox")();
  assert.match(read.els.warmupInboxBody.innerHTML, /Відповідей поки немає/);
  assert.match(read.els.warmupInboxBody.innerHTML, /Читали 30 хв тому/);

  const unknown = screen({ threads: [], sync: null });
  unknown.get("renderWarmupInbox")();
  assert.match(unknown.els.warmupInboxBody.innerHTML, /невідомо, коли вхідні читали востаннє/);
});

test("розмова: з неї є хід до картки контакту, коли контакт відомий, і чесне «не знайдено», коли ні", () => {
  const withContact = screen();
  withContact.warmupState.inbox.open = { thread: thread({ crmContactId: 4412, outreachStatus: "accepted" }), messages: [{ direction: "in", body: "Привіт", sentAt: minutesAgo(5) }] };
  const html = withContact.get("warmupThreadViewHtml")();
  assert.match(html, /data-warmup-contact="4412"/);
  assert.match(html, /Картка контакту/);
  assert.match(html, /їхній LinkedIn/);
  assert.match(html, /надійшло на Anna Kovalenko/);

  const without = screen();
  without.warmupState.inbox.open = { thread: thread({ crmContactId: null }), messages: [{ direction: "in", body: "Привіт", sentAt: minutesAgo(5) }] };
  const bare = without.get("warmupThreadViewHtml")();
  assert.doesNotMatch(bare, /data-warmup-contact/);
  assert.match(bare, /у CRM цієї людини не знайдено/);
});

test("клік по кнопці в розмові веде в картку контакту, клік по рядку відкриває розмову, «скинути фільтр» знімає звуження й пошук", async () => {
  const contacts = [];
  const { listeners, calls, get, main, set } = screen({
    api: async () => ({ thread: thread({ threadKey: "t-1" }), messages: [] }),
    extra: { showContactCard: (id) => contacts.push(id) },
    statements: ['document.getElementById("warmupInboxBody")?.addEventListener("click"']
  });
  const click = (map) => listeners.click({ target: { closest: (selector) => map[selector] || null } });

  click({ "[data-warmup-contact]": { dataset: { warmupContact: "4412" } } });
  assert.deepEqual(contacts, ["4412"]);

  click({ "[data-warmup-thread]": { dataset: { warmupThreadAccount: "acc-a", warmupThread: "t-1" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call.path === "/inbox/thread?threadKey=t-1&accountId=acc-a"), "клік по рядку не відкрив розмову");

  // Посилання всередині рядка — це посилання, а не рядок.
  const before = calls.length;
  click({ a: {}, "[data-warmup-thread]": { dataset: { warmupThreadAccount: "acc-a", warmupThread: "t-2" } } });
  assert.equal(calls.length, before);

  // «Скинути фільтр» знімає і звуження, поставлене бейджем з «Прогріву», і пошук.
  get("showWarmupInboxAccount")("acc-b");
  set("inboxSearch", "iryna");
  assert.equal(main.get("inboxAccountFilter"), "acc-b");
  click({ "[data-warmup-inbox-reset]": {} });
  assert.equal(main.get("inboxAccountFilter"), null, "«Скинути фільтр» не зняло звуження");
  assert.equal(main.get("inboxSearch"), "", "«Скинути фільтр» не зняло пошук");
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

// ── Знайти потрібну відповідь, перейти до наступної, не оновлювати руками ────

const SEARCH_STATEMENTS = [
  'document.getElementById("warmupInboxAccountSelect")?.addEventListener("change"',
  'document.getElementById("warmupInboxSearch")?.addEventListener("input"',
  'document.getElementById("warmupInboxBody")?.addEventListener("click"',
  'document.addEventListener("visibilitychange"'
];

const typeSearch = (listeners, value) => listeners["search:input"]({ target: { value } });

test("пошук знаходить за іменем, посадою, акаунтом і текстом відповіді; усі слова мають збігтися, регістр не важить", () => {
  const { els, listeners, get } = screen({ statements: SEARCH_STATEMENTS });
  get("renderWarmupInbox")();
  for (const [query, expected] of [
    ["taras", ["t-new-unread"]],
    ["TARAS", ["t-new-unread"]],
    ["ua lead", ["t-new-unread"]],
    ["anna", ["t-new-unread", "t-read"]],
    ["дякую", ["t-read"]],
    ["taras поговорити", ["t-new-unread"]],
    ["taras дякую", []],
    ["  taras   ", ["t-new-unread"]]
  ]) {
    typeSearch(listeners, query);
    assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), expected, `запит «${query}»`);
  }
  typeSearch(listeners, "");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-new-unread", "t-old-unread", "t-read"], "порожній пошук має повернути все");
});

test("самі пробіли в пошуку — не фільтр: рядка з лічильником нема, список повний", () => {
  const { els, listeners, get } = screen({ statements: SEARCH_STATEMENTS });
  get("renderWarmupInbox")();
  typeSearch(listeners, "   ");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-new-unread", "t-old-unread", "t-read"]);
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /warmup-inbox-filter/);
});

test("під пошуком сказано, скільки розмов лишилось із скількох, а порожній результат — що шукали і як скинути", () => {
  const { els, warmupState, listeners, get } = screen({ statements: SEARCH_STATEMENTS });
  get("renderWarmupInbox")();
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /warmup-inbox-filter/, "без фільтра рядка з лічильником нема");

  typeSearch(listeners, "taras");
  assert.match(els.warmupInboxBody.innerHTML, /Розмов: <strong>1<\/strong> з 3/);
  assert.match(els.warmupInboxBody.innerHTML, /data-warmup-inbox-reset/);

  typeSearch(listeners, "такого немає");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), []);
  assert.match(els.warmupInboxBody.innerHTML, /За цим запитом нічого не знайшлось/);
  assert.match(els.warmupInboxBody.innerHTML, /Розмов: <strong>0<\/strong> з 3/);
  assert.match(els.warmupInboxBody.innerHTML, /data-warmup-inbox-reset/);
  assert.equal(warmupState.inbox.threads.length, 3, "пошук нічого не викидає зі стану");
});

test("пошук і вибір акаунта працюють разом", () => {
  const { els, listeners, get } = screen({ statements: SEARCH_STATEMENTS });
  get("renderWarmupInbox")();
  listeners["select:change"]({ target: { value: "acc-a" } });
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-new-unread", "t-read"]);
  typeSearch(listeners, "дякую");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-read"]);
  typeSearch(listeners, "iryna");
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), [], "розмова Ірини на іншому акаунті");
  listeners["select:change"]({ target: { value: "" } });
  assert.deepEqual(orderOf(els.warmupInboxBody.innerHTML), ["t-old-unread"]);
});

test("інструменти над списком: показані, коли є що шукати; акаунтів не питаємо, коли він один; у розмові їх нема", () => {
  const { els, warmupState, get } = screen();
  get("renderWarmupInbox")();
  assert.equal(els.warmupInboxTools.hidden, false);
  assert.equal(els.warmupInboxAccountPick.hidden, false);
  assert.match(els.warmupInboxAccountSelect.innerHTML, /<option value="">Усі акаунти \(3\)<\/option>/);
  assert.match(els.warmupInboxAccountSelect.innerHTML, /Anna Kovalenko \(2, непрочитаних 1\)/);

  // Лише один акаунт — вибирати нема з чого.
  warmupState.inbox.threads = warmupState.inbox.threads.filter((row) => row.accountId === "acc-a");
  get("renderWarmupInbox")();
  assert.equal(els.warmupInboxTools.hidden, false);
  assert.equal(els.warmupInboxAccountPick.hidden, true);

  // Порожньо — шукати нема в чому, і не показано.
  warmupState.inbox.threads = [];
  get("renderWarmupInbox")();
  assert.equal(els.warmupInboxTools.hidden, true);

  // Розмова відкрита: інструменти ховаються.
  warmupState.inbox.threads = threeThreads();
  get("renderWarmupInbox")();
  assert.equal(els.warmupInboxTools.hidden, false);
  warmupState.inbox.openThreadKey = "t-read";
  warmupState.inbox.openAccountId = "acc-a";
  get("renderWarmupInbox")();
  assert.equal(els.warmupInboxTools.hidden, true);

  // Помилка вхідних — теж без інструментів.
  warmupState.inbox.openThreadKey = null;
  warmupState.inbox.error = "Сервер мовчить";
  get("renderWarmupInbox")();
  assert.equal(els.warmupInboxTools.hidden, true);
});

test("акаунт, до якого звужено, лишається в списку акаунтів, навіть коли розмов на ньому нема", () => {
  const { els, get } = screen({ threads: [thread({ threadKey: "only", accountId: "acc-a" })], accounts: [{ accountId: "acc-b", label: "Profile 7", unread: 0 }] });
  get("showWarmupInboxAccount")("acc-b");
  assert.match(els.warmupInboxAccountSelect.innerHTML, /<option value="acc-b" selected>Profile 7 \(0\)<\/option>/);
  assert.equal(els.warmupInboxAccountPick.hidden, false);
});

test("поле пошуку не перезаписується, поки в ньому вже те саме: людина не втрачає курсор посеред слова", () => {
  const { els, listeners, get, set } = screen({ statements: SEARCH_STATEMENTS });
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

test("в кінці розмови є кнопка до наступної непрочитаної, і вона називає, до кого веде", async () => {
  const opened = [];
  const { els, warmupState, listeners, get, calls } = screen({
    api: async (path) => {
      if (path.startsWith("/inbox/thread")) return { thread: thread({ threadKey: "t-new-unread", participant: { name: "Taras Bondar", headline: "", slug: "" } }), messages: [{ direction: "in", body: "Коли можна поговорити?", sentAt: minutesAgo(60) }] };
      if (path === "/inbox/read") return { success: true, unread: 1 };
      throw new Error(`невідомий маршрут ${path}`);
    },
    extra: { scrollTo: (x, y) => opened.push(["scroll", x, y]) },
    statements: SEARCH_STATEMENTS
  });
  // Відкрито Тараса; непрочитаною лишилась Ірина.
  await get("openWarmupThread")("acc-a", "t-new-unread");
  const html = els.warmupInboxBody.innerHTML;
  assert.match(html, /data-warmup-inbox-next/);
  assert.match(html, /Наступна непрочитана: Iryna Shevchenko/);
  assert.equal((html.match(/data-warmup-inbox-next/g) || []).length, 1);

  // Клік відкриває саме її і піднімає сторінку нагору.
  listeners.click({ target: { closest: (selector) => (selector === "[data-warmup-inbox-next]" ? {} : null) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call.path === "/inbox/thread?threadKey=t-old-unread&accountId=acc-b"), "відкрито не ту розмову");
  assert.deepEqual(opened, [["scroll", 0, 0]]);
  assert.equal(warmupState.inbox.openThreadKey, "t-old-unread");
});

test("наступна непрочитана береться з того, що видно: з урахуванням акаунта й пошуку, а коли її нема — кнопки теж нема", async () => {
  const { els, warmupState, listeners, get, set } = screen({
    api: async (path) => {
      if (path.startsWith("/inbox/thread")) return { thread: thread({ threadKey: "t-new-unread" }), messages: [{ direction: "in", body: "Привіт", sentAt: minutesAgo(1) }] };
      if (path === "/inbox/read") return { success: true, unread: 1 };
      throw new Error(`невідомий маршрут ${path}`);
    },
    statements: SEARCH_STATEMENTS
  });
  // Звужено до акаунта, на якому інших непрочитаних нема: далі йти нікуди.
  set("inboxAccountFilter", "acc-a");
  await get("openWarmupThread")("acc-a", "t-new-unread");
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /data-warmup-inbox-next/);

  // Звужено пошуком до Ірини: наступна — вона, а не будь-яка непрочитана.
  set("inboxAccountFilter", null);
  set("inboxSearch", "iryna");
  get("renderWarmupInbox")();
  assert.equal(get("warmupNextUnread")().threadKey, "t-old-unread");
  set("inboxSearch", "nobody");
  assert.equal(get("warmupNextUnread")(), null);

  // Тільки прочитані: кнопки нема.
  set("inboxSearch", "");
  for (const row of warmupState.inbox.threads) row.unread = false;
  get("renderWarmupInbox")();
  assert.doesNotMatch(els.warmupInboxBody.innerHTML, /data-warmup-inbox-next/);
  // Помилка читання розмови: кнопки до наступної теж нема.
  warmupState.inbox.openError = "Не вдалося";
  assert.doesNotMatch(get("warmupThreadViewHtml")(), /data-warmup-inbox-next/);
  void listeners;
});

test("новий лічильник, поки відкритий список, перечитує список; розмову, яку читають, не чіпає", async () => {
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
  await new Promise((resolve) => setImmediate(resolve));
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

  // Відкрита розмова: список не перемальовується з-під очей.
  requested.length = 0;
  s = make();
  s.warmupState.unreadReplies = 2;
  s.warmupState.inbox.openThreadKey = "t-read";
  s.warmupState.inbox.openAccountId = "acc-a";
  await s.get("refreshWarmupBadge")();
  assert.deepEqual(requested, ["/config"]);

  // Інший екран на видноті: вхідні не читаються даремно, лічильник усе одно оновився.
  requested.length = 0;
  s = make({ active: false });
  s.warmupState.unreadReplies = 2;
  await s.get("refreshWarmupBadge")();
  assert.deepEqual(requested, ["/config"]);
  assert.equal(s.warmupState.unreadReplies, 4);
});

test("повернення на вкладку одразу бере лічильник, прихована вкладка його не питає", async () => {
  const s = screen({
    api: async () => ({ configured: true, unreadReplies: 1 }),
    statements: SEARCH_STATEMENTS
  });
  s.main.context.document.visibilityState = "hidden";
  await s.listeners["document:visibilitychange"]();
  assert.equal(s.calls.length, 0, "прихована вкладка спитала лічильник");
  s.main.context.document.visibilityState = "visible";
  await s.listeners["document:visibilitychange"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.calls.map((call) => call.path), ["/config"]);
});
