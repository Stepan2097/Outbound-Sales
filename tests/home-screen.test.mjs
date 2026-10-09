import assert from "node:assert/strict";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * «Головна» — конвеєр розсилки й перші повідомлення тим, хто прийняв.
 *
 * Код екрана береться з app/screens/home.js і запускається проти заглушок DOM:
 * що видно, що модель пише сама, що йде на сервер, коли людина натискає
 * «Надіслати», і що текст, який людина виправила, не губиться.
 */

const NAMES = [
  "escapeHtml", "escapeAttr", "warmupCount",
  "homeState", "HOME_CACHE", "HOME_DRAFT_PARALLEL", "loadHome", "draftMissing", "draftFor", "homePerson", "homeText",
  "sendFirst", "cancelFirst", "dismissFirst", "homeAgo", "homeGoesOut", "homePercent", "HOME_STEPS", "homeFunnelHtml",
  "homeAttentionHtml", "HOME_REPLY_STATE", "homeCardInnerHtml", "homeWriteHtml", "homeRepliesHtml", "HOME_ACCOUNT_STATE",
  "homeAccountsHtml", "renderHome", "renderHomeCard"
];

const LISTENERS = [
  'document.getElementById("homeRoot")?.addEventListener("click"',
  'document.getElementById("homeRoot")?.addEventListener("input"'
];

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

function person(id, extra = {}) {
  return {
    outreachId: id, accountId: "acc-1", accountName: "Mary Lindsay", crmContactId: `c-${id}`,
    name: `Person ${id}`, company: "Company", position: "Head of Growth", country: "United Kingdom",
    linkedin: `https://www.linkedin.com/in/person-${id}/`, invitedAt: minutesAgo(60 * 48),
    draft: null, reply: null, goesOut: null, ...extra
  };
}

function payload(extra = {}) {
  return {
    success: true, date: "2026-10-10",
    funnel: { queued: 40, invited: 120, accepted: 30, written: 12, replied: 6 },
    today: { invited: 9, replied: 2 },
    toWrite: [person("o-1", { draft: { text: "Hi Person, thanks for connecting.", model: "m" } }), person("o-2")],
    toWriteTotal: 2,
    replies: { unread: 1, latest: [{ accountId: "acc-1", accountName: "Mary Lindsay", threadKey: "t-1", participant: { name: "Luke" }, lastMessage: { body: "Mainly casino", sentAt: minutesAgo(30) } }] },
    accounts: [
      { id: "acc-1", name: "Mary Lindsay", state: "working", health: "ok", day: 20, totalDays: 14, connects: { done: 5, quota: 15 }, nextSession: new Date(Date.now() + 3600000).toISOString(), campaigns: ["iGaming UK"] },
      { id: "acc-2", name: "Chloe Stewart", state: "limit", health: "ok", pausedUntil: "2026-10-11", connects: { done: 0, quota: 0 }, nextSession: null, campaigns: [] }
    ],
    campaigns: [{ id: "camp-1", name: "iGaming UK", state: "running", accounts: 2 }],
    attention: [{ kind: "account", accountId: "acc-2", text: "Chloe Stewart: тижневий ліміт запрошень LinkedIn — до 2026-10-11" }],
    writer: { ready: true },
    window: "09:00–13:00",
    ...extra
  };
}

/** Картки людей як окремі елементи, щоб renderHomeCard мав що міняти. */
function screen({ api, data = null, active = null } = {}) {
  const root = { innerHTML: "", addEventListener: (type, fn) => { listeners[type] = fn; } };
  const cards = new Map();
  const listeners = {};
  const calls = [];
  const clicks = [];
  const globals = {
    document: {
      activeElement: active,
      getElementById: (id) => (id === "homeRoot" ? root : null),
      querySelector: (selector) => {
        const card = /data-home-card="([^"]+)"/.exec(selector);
        if (card) {
          if (!cards.has(card[1])) cards.set(card[1], { innerHTML: "", querySelector: () => null });
          return cards.get(card[1]);
        }
        return { click: () => clicks.push(selector) };
      }
    },
    CSS: { escape: (value) => value },
    refreshIcons: () => {},
    recallScreen: () => null,
    rememberScreen: () => {},
    showContactCard: (id) => clicks.push(`contact:${id}`),
    showWarmupInboxThread: (accountId, threadKey) => clicks.push(`thread:${accountId}/${threadKey}`),
    warmupApi: async (path, options) => {
      calls.push({ path, method: options?.method || "GET", body: options?.body ? JSON.parse(options.body) : null });
      if (!api) throw new Error("warmupApi не мав викликатись");
      return api(path, options);
    }
  };
  const main = loadMain(NAMES, globals, LISTENERS);
  const state = main.get("homeState");
  if (data) { state.data = data; state.ready = true; }
  return { root, cards, calls, clicks, listeners, state, get: main.get, globals };
}

const click = (view, attribute, value) => view.listeners.click({
  target: { closest: (selector) => (selector === `[${attribute}]` ? { dataset: { [toCamel(attribute.replace(/^data-/, ""))]: value } } : null) }
});
const toCamel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── що видно ──────────────────────────────────────────────────────────────

test("конвеєр: п'ять кроків від черги до відповіді, з числами й тим, що сталося сьогодні", () => {
  const view = screen({ data: payload() });
  view.get("renderHome")();
  const html = view.root.innerHTML;
  const steps = [...html.matchAll(/home-step-label">([^<]+)<\/span>\s*<strong class="home-step-value">([^<]+)</g)].map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(steps, ["У черзі 40", "Запрошено 120", "Прийняли 30", "Ми написали 12", "Відповіли 6"]);
  assert.match(html, /\+9 сьогодні/);
  assert.match(html, /25% запрошених/);
  assert.match(html, /\+2 сьогодні/);
  assert.match(html, /Сьогодні: 9 запрошень, 2 відповідей/);
});

test("що потребує людини — над усім, з ходом у «Прогрів»; людей, відповіді й акаунти видно", () => {
  const view = screen({ data: payload() });
  view.get("renderHome")();
  const html = view.root.innerHTML;
  assert.match(html, /тижневий ліміт запрошень LinkedIn/);
  assert.match(html, /data-home-go="warmup"/);
  assert.match(html, /Прийняли запрошення — напишіть першими/);
  assert.match(html, /2 людей чекають на перше повідомлення/);
  assert.match(html, /data-home-card="o-1"/);
  assert.match(html, /Hi Person, thanks for connecting\./);
  assert.match(html, /прийняв\(ла\) запрошення від <b>Mary Lindsay<\/b>/);
  assert.match(html, /data-home-contact="c-o-1"/);
  assert.match(html, /Mainly casino/);
  assert.match(html, /data-home-thread="t-1"/);
  assert.match(html, /Ліміт LinkedIn до 2026-10-11/);
  assert.match(html, /Запити сьогодні: <b>5\/15<\/b>/);
  assert.match(html, /Кампанія: iGaming UK/);
});

test("порожньо — каже, що буде, а не мовчить; помилка без даних — помилка", () => {
  const empty = screen({ data: payload({ toWrite: [], toWriteTotal: 0, accounts: [], replies: { unread: 0, latest: [] }, attention: [] }) });
  empty.get("renderHome")();
  assert.match(empty.root.innerHTML, /Поки ніхто не чекає на перше повідомлення/);
  assert.match(empty.root.innerHTML, /Додайте акаунти LinkedIn у «Прогріві»/);
  assert.match(empty.root.innerHTML, /Нових відповідей немає/);
  assert.doesNotMatch(empty.root.innerHTML, /home-attention/);

  const broken = screen();
  broken.state.ready = true;
  broken.state.error = "CRM не відповіла.";
  broken.get("renderHome")();
  assert.match(broken.root.innerHTML, /CRM не відповіла\./);
});

test("текст людини екранується, а шаблон без моделі позначено", () => {
  const view = screen({ data: payload({ toWrite: [person("o-9", { name: "<b>Eve</b>", draft: { text: "Hi <script>", model: "local-draft" } })], toWriteTotal: 1 }) });
  view.get("renderHome")();
  assert.match(view.root.innerHTML, /&lt;b&gt;Eve&lt;\/b&gt;/);
  assert.match(view.root.innerHTML, /Hi &lt;script&gt;/);
  assert.doesNotMatch(view.root.innerHTML, /<script>/);
  assert.doesNotMatch(view.root.innerHTML, /<b>Eve/, "ім'я ніде не стає розміткою");
  assert.match(view.root.innerHTML, /за шаблоном, без моделі/);
});

// ── модель пише сама ──────────────────────────────────────────────────────

test("щойно головну відкрили, модель пише всім, у кого ще немає повідомлення — і лише їм, не більше двох одночасно", async () => {
  let inFlight = 0;
  let most = 0;
  const data = payload({ toWrite: [person("o-1", { draft: { text: "Є" } }), person("o-2"), person("o-3"), person("o-4"), person("o-5", { reply: { id: "r", state: "waiting", body: "x" } })], toWriteTotal: 5 });
  const view = screen({
    api: async (path, options) => {
      if (path === "/home") return data;
      inFlight += 1; most = Math.max(most, inFlight);
      await tick();
      inFlight -= 1;
      const id = JSON.parse(options.body).outreachId;
      return { success: true, draft: { text: `Hi ${id}`, model: "m" } };
    }
  });
  await view.get("loadHome")();
  for (let at = 0; at < 10; at += 1) await tick();
  const drafted = view.calls.filter((call) => call.path === "/first-messages/draft").map((call) => call.body.outreachId);
  assert.deepEqual(drafted.sort(), ["o-2", "o-3", "o-4"], "ні тому, в кого вже є, ні тому, чиє вже в черзі");
  assert.ok(most <= 2, `одночасно ${most}`);
  assert.equal(view.state.data.toWrite.find((row) => row.outreachId === "o-3").draft.text, "Hi o-3");
  assert.match(view.cards.get("o-3").innerHTML, /Hi o-3/, "картку перемальовано з новим текстом");
});

test("модель не відповіла — під людиною причина, а не тиша", async () => {
  const view = screen({ data: payload(), api: async () => { throw new Error("Модель не написала повідомлення — спробуйте ще раз."); } });
  await view.get("draftFor")("o-2");
  assert.match(view.cards.get("o-2").innerHTML, /Модель не написала повідомлення/);
  assert.equal(view.state.drafting.has("o-2"), false);
});

// ── людина ────────────────────────────────────────────────────────────────

test("виправлений текст лишається виправленим після перемальовування і саме він іде на «Надіслати»", async () => {
  const view = screen({
    data: payload(),
    api: async (path, options) => ({ success: true, reply: { id: "r-1", state: "waiting", body: JSON.parse(options.body).text }, goesOutAt: new Date(Date.now() + 3600000).toISOString(), goesOutToday: true })
  });
  view.get("renderHome")();
  view.listeners.input({ target: { value: "Hi Person — my own words.", dataset: { homeText: "o-1" }, closest: () => null } });
  view.get("renderHome")();
  assert.match(view.root.innerHTML, /Hi Person — my own words\./);
  assert.doesNotMatch(view.root.innerHTML, /thanks for connecting/);

  click(view, "data-home-send", "o-1");
  await tick(); await tick();
  assert.deepEqual(view.calls.at(-1), { path: "/first-messages/send", method: "POST", body: { outreachId: "o-1", text: "Hi Person — my own words." } });
  const card = view.cards.get("o-1").innerHTML;
  assert.match(card, /чекає відправки — акаунт Mary Lindsay надішле сьогодні близько \d\d:\d\d/);
  assert.match(card, /data-home-cancel="o-1"/);
  assert.match(card, /<textarea[^>]* disabled>/, "поки чекає — не правиться");
});

test("порожнє не надсилається; поки пишеться модель — кнопка неактивна", () => {
  const view = screen({ data: payload() });
  view.state.drafting.add("o-2");
  const html = view.get("homeCardInnerHtml")(view.state.data.toWrite[1]);
  assert.match(html, /data-home-send="o-2" disabled/);
  assert.match(html, /Модель пише повідомлення/);
});

test("відмова порталу лишає текст і каже причину біля людини", async () => {
  const view = screen({ data: payload(), api: async () => { throw new Error("Акаунт на паузі до 2026-10-12 — поки вона триває, агент його не відкриває."); } });
  await view.get("sendFirst")("o-1");
  const card = view.cards.get("o-1").innerHTML;
  assert.match(card, /на паузі до 2026-10-12/);
  assert.match(card, /thanks for connecting/, "текст на місці");
  assert.match(card, /data-home-send="o-1"(?! disabled)/);
});

test("«Скасувати й виправити» повертає текст у поле; «Пропустити» прибирає людину; «Переписати» просить нову", async () => {
  const data = payload({ toWrite: [person("o-1", { reply: { id: "r-1", state: "waiting", body: "Queued words" } }), person("o-2", { draft: { text: "Draft two" } })], toWriteTotal: 2 });
  const view = screen({ data, api: async (path) => (path === "/first-messages/draft" ? { success: true, draft: { text: "Fresh draft", model: "m" } } : { success: true }) });

  await view.get("cancelFirst")("o-1");
  assert.deepEqual(view.calls.at(-1).body, { accountId: "acc-1", replyId: "r-1" });
  assert.equal(view.calls.at(-1).path, "/inbox/reply/cancel");
  assert.match(view.cards.get("o-1").innerHTML, />Queued words<\/textarea>/);
  assert.match(view.cards.get("o-1").innerHTML, /data-home-send="o-1"/);

  view.state.edits.set("o-2", "my edit");
  click(view, "data-home-redraft", "o-2");
  await tick(); await tick();
  assert.deepEqual(view.calls.at(-1).body, { outreachId: "o-2", force: true });
  assert.match(view.cards.get("o-2").innerHTML, /Fresh draft/, "переписане замінює й виправлене — так попросили");

  await view.get("dismissFirst")("o-2");
  assert.equal(view.calls.at(-1).path, "/first-messages/dismiss");
  assert.deepEqual(view.state.data.toWrite.map((row) => row.outreachId), ["o-1"]);
  assert.equal(view.state.data.toWriteTotal, 1);
});

test("кліки: відповідь відкриває розмову у «Вхідних», «У CRM» — картку, «До «Прогріву»» — екран", () => {
  const view = screen({ data: payload() });
  view.listeners.click({ target: { closest: (selector) => (selector === "[data-home-thread]" ? { dataset: { homeThread: "t-1", homeThreadAccount: "acc-1" } } : null) } });
  click(view, "data-home-contact", "c-o-1");
  click(view, "data-home-go", "warmup");
  assert.deepEqual(view.clicks, ["thread:acc-1/t-1", "contact:c-o-1", '.nav-item[data-view="warmup"]']);
});
