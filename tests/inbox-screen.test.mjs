import assert from "node:assert/strict";
import test from "node:test";

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
  "closeWarmupThread", "showWarmupInboxAccount"
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

function screen({ threads = threeThreads(), accounts = [], sync = null, api, extra = {}, statements = [] } = {}) {
  const els = {
    warmupInboxTitle: element(), warmupInboxSubtitle: element(), warmupInboxPill: element(),
    warmupInboxBody: element(), warmupNavBadge: element()
  };
  const clicks = [];
  const listeners = {};
  els.warmupInboxBody.addEventListener = (type, fn) => { listeners[type] = fn; };
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
  return { els, warmupState, clicks, calls, listeners, main, get: main.get };
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
  assert.match(els.warmupInboxBody.innerHTML, /Тільки відповіді, що надійшли на <strong>Profile 7<\/strong>/);
  assert.match(els.warmupInboxBody.innerHTML, /data-warmup-inbox-allaccounts/);
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

test("клік по кнопці в розмові веде в картку контакту, клік по рядку відкриває розмову, «усі акаунти» знімає звуження", async () => {
  const contacts = [];
  const { listeners, calls, get, main } = screen({
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

  // «Показати всі акаунти» знімає звуження, поставлене бейджем з «Прогріву».
  get("showWarmupInboxAccount")("acc-b");
  assert.equal(main.get("inboxAccountFilter"), "acc-b");
  click({ "[data-warmup-inbox-allaccounts]": {} });
  assert.equal(main.get("inboxAccountFilter"), null, "«Показати всі акаунти» не зняло звуження");
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
