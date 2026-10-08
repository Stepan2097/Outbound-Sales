import assert from "node:assert/strict";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * «Налаштування» після спрощення (985e5a7b): хто в команді, створення акаунта,
 * свій пароль. Код екрана береться з app/screens/settings.js і запускається
 * проти заглушок DOM.
 *
 * Головне, що тут тримається: форми «Свій пароль» і «Створити користувача»
 * падали на `event.currentTarget.reset()` після `await` — у браузері
 * currentTarget стає null, щойно обробник вперше віддав керування, тож форма,
 * що ЩОЙНО змінила пароль, кидала TypeError замість «Пароль змінено». Заглушка
 * події нижче поводиться так само, як браузер: currentTarget живе лише до
 * першого await.
 */

const NAMES = [
  "ROLE_LABEL", "personDisplayName", "renderAccount", "teamRowHtml", "loadTeamDirectory",
  "loadSettingsScreen", "removeTeamUser"
];

const LISTENERS = [
  'document.getElementById("teamUserList")?.addEventListener("click"',
  'document.getElementById("teamUserList")?.addEventListener("change"',
  'document.getElementById("accountPasswordForm").addEventListener("submit"',
  'document.getElementById("teamUserForm").addEventListener("submit"'
];

function element(extra = {}) {
  return { textContent: "", innerHTML: "", hidden: false, value: "", dataset: {}, ...extra };
}

function dispatch(handler, form, extra = {}) {
  let dispatching = true;
  const event = {
    preventDefault() {},
    target: form,
    get currentTarget() { return dispatching ? form : null; },
    ...extra
  };
  const done = handler(event);
  dispatching = false;
  return done;
}

function screen({ user = { id: "u-1", email: "stepan@example.com", name: "Stepan", role: "admin" }, api, confirm = () => true } = {}) {
  const ids = {};
  const handlers = {};
  const byId = (id) => {
    if (!ids[id]) {
      ids[id] = element({
        addEventListener: (type, fn) => { handlers[`${id}:${type}`] = fn; },
        reset() { this.wasReset = true; }
      });
    }
    return ids[id];
  };
  ids.accountPasswordInput = element({ value: "correct-horse-1" });
  ids.accountPasswordConfirmInput = element({ value: "correct-horse-1" });
  ids.teamUserNameInput = element({ value: "Ira" });
  ids.teamUserEmailInput = element({ value: "ira@example.com" });
  ids.teamUserPasswordInput = element({ value: "temporary-pass-1" });
  ids.teamUserRoleInput = element({ value: "seller" });
  const calls = [];
  const notices = [];
  const setText = (id, value) => { byId(id).textContent = value; };
  const globals = {
    document: { getElementById: byId },
    window: { confirm: (message) => { calls.push({ confirm: message }); return confirm(message); } },
    authState: { user },
    api: async (path, options) => {
      calls.push({ path, method: options?.method || "GET", body: options?.body ? JSON.parse(options.body) : null });
      return api(path, options);
    },
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])),
    escapeAttr: (value) => String(value ?? "").replace(/"/g, "&quot;"),
    uaPlural: (count, one, few, many) => (count % 10 === 1 && count % 100 !== 11 ? one : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? few : many),
    relativeTime: () => "вчора",
    refreshIcons: () => {},
    setText,
    setHtml: (id, html) => { byId(id).innerHTML = html; },
    setUiNotice: (text) => { notices.push(text); },
    renderTopbar: () => calls.push("renderTopbar"),
    render: () => calls.push("render"),
    setAuthState: (value) => calls.push({ setAuthState: value })
  };
  const main = loadMain(NAMES, globals, LISTENERS);
  return { ids, byId, handlers, calls, notices, main, get: main.get };
}

const directory = (people) => ({ people, canSignIn: people.filter((person) => !person.blocked).length, adminApi: true });

const PEOPLE = [
  { id: "u-1", email: "stepan@example.com", name: "Stepan", role: "admin", signedInHere: true, lastSignInAt: "2026-10-08T10:00:00Z" },
  { id: "u-2", email: "ira@example.com", name: "Ira Koval", role: "seller", signedInHere: true, lastSignInAt: null }
];

test("адмін бачить команду, продавець — лише себе й свій пароль", () => {
  const admin = screen();
  admin.get("renderAccount")();
  assert.equal(admin.ids.teamPanel.hidden, false);
  assert.equal(admin.ids.profileName.textContent, "Stepan");
  assert.equal(admin.ids.profileEmail.textContent, "stepan@example.com");
  assert.equal(admin.ids.accountRolePill.textContent, "Адміністратор");

  const seller = screen({ user: { id: "u-3", email: "ira@example.com", name: "", role: "seller" } });
  seller.get("renderAccount")();
  assert.equal(seller.ids.teamPanel.hidden, true, "продавцю показано команду");
  // Без імені пошта — заголовок, і вдруге під ним не повторюється.
  assert.equal(seller.ids.profileName.textContent, "ira@example.com");
  assert.equal(seller.ids.profileEmail.hidden, true);
  assert.equal(seller.ids.accountRolePill.textContent, "Продавець");
});

test("продавець не питає в сервера список команди", async () => {
  const seller = screen({ user: { id: "u-3", email: "ira@example.com", role: "seller" }, api: async () => { throw new Error("мав не питати"); } });
  await seller.get("loadSettingsScreen")();
  assert.deepEqual(seller.calls, []);
});

test("рядок команди: своєї ролі й свого акаунта не зачепити, чужі — змінити й прибрати", () => {
  const { get } = screen();
  const html = (person) => get("teamRowHtml")(person, "stepan@example.com");

  const self = html(PEOPLE[0]);
  assert.match(self, /це ти/);
  assert.match(self, /<select class="team-access"[^>]*disabled/);
  assert.doesNotMatch(self, /data-remove-user/, "себе прибрати не можна");

  const other = html(PEOPLE[1]);
  assert.doesNotMatch(other, /disabled/);
  assert.match(other, /data-remove-user="u-2"/);
  assert.match(other, /Ira Koval/);
  assert.match(other, /ira@example\.com/);
  // Рядок не клікабельний: картки людини вже нема, куди ходити.
  assert.doesNotMatch(other, /data-team-user|tabindex|role="button"/);
  // І ніяких кредитів, запитів і моделі.
  assert.doesNotMatch(other, /team-stat|team-model|запит|\$/);
});

test("команда: список і підсумок з тим, скільки може увійти", async () => {
  const { ids, get } = screen({ api: async () => directory([...PEOPLE, { id: "u-4", email: "outside@example.com", name: "", role: "seller", blocked: "CRM не пускає" }]) });
  await get("loadTeamDirectory")();
  assert.equal((ids.teamUserList.innerHTML.match(/<article/g) || []).length, 3);
  assert.match(ids.teamUserNote.textContent, /3 користувачі · 2 можуть увійти, решту тримає CRM/);
  assert.doesNotMatch(ids.teamUserNote.textContent, /кредити/);
});

test("команда, яку не вдалося прочитати, каже це і не лишає старого списку", async () => {
  const { ids, get } = screen({ api: async () => { throw new Error("Supabase не відповів"); } });
  ids.teamUserList = element({ innerHTML: "<article>старий</article>" });
  await get("loadTeamDirectory")();
  assert.equal(ids.teamUserList.innerHTML, "");
  assert.match(ids.teamUserNote.textContent, /Список команди зараз недоступний: Supabase не відповів/);
});

test("зміна пароля: форма скидається й каже «Пароль змінено» — currentTarget береться до await", async () => {
  const s = screen({ api: async () => ({ ok: true }) });
  const form = s.byId("accountPasswordForm");
  await dispatch(s.handlers["accountPasswordForm:submit"], form);

  const post = s.calls.find((call) => call.path === "/api/account/password");
  assert.deepEqual(post.body, { password: "correct-horse-1" });
  assert.equal(form.wasReset, true, "форму не скинуто після успішної зміни");
  assert.deepEqual(s.notices, ["Пароль змінено."]);
});

test("паролі, що не збігаються, нічого не відправляють", async () => {
  const s = screen({ api: async () => { throw new Error("мав не питати"); } });
  s.ids.accountPasswordConfirmInput.value = "other-pass-123";
  await dispatch(s.handlers["accountPasswordForm:submit"], s.byId("accountPasswordForm"));
  assert.deepEqual(s.notices, ["Паролі не збігаються."]);
  assert.equal(s.calls.some((call) => call.path), false);
  assert.ok(!s.byId("accountPasswordForm").wasReset);
});

test("пароль, який сервер не прийняв, не стирає того, що людина ввела", async () => {
  const s = screen({ api: async () => { throw new Error("Пароль закороткий"); } });
  const form = s.byId("accountPasswordForm");
  await dispatch(s.handlers["accountPasswordForm:submit"], form);
  assert.deepEqual(s.notices, ["Пароль закороткий"]);
  assert.ok(!form.wasReset, "форму скинуто попри помилку");
});

test("новий користувач: форма скидається, сесія перечитується, список оновлюється одразу", async () => {
  const s = screen({
    api: async (path) => {
      if (path === "/api/account/users") return { existingAccount: false };
      if (path === "/api/auth/status") return { authenticated: true };
      if (path === "/api/account/directory") return directory(PEOPLE);
      throw new Error(`невідомий маршрут ${path}`);
    }
  });
  const form = s.byId("teamUserForm");
  await dispatch(s.handlers["teamUserForm:submit"], form);

  const create = s.calls.find((call) => call.path === "/api/account/users");
  assert.deepEqual(create.body, { name: "Ira", email: "ira@example.com", password: "temporary-pass-1", role: "seller" });
  assert.equal(form.wasReset, true);
  assert.deepEqual(s.notices, ["Акаунт продавця створено."]);
  assert.ok(s.calls.some((call) => call.path === "/api/auth/status"));
  assert.ok(s.calls.some((call) => call.path === "/api/account/directory"), "новий користувач не з'явився в списку одразу");
});

test("новий користувач, якого сервер відхилив, лишає форму як була й каже чому", async () => {
  const s = screen({ api: async () => { throw new Error("Такий email уже є"); } });
  const form = s.byId("teamUserForm");
  await dispatch(s.handlers["teamUserForm:submit"], form);
  assert.deepEqual(s.notices, ["Такий email уже є"]);
  assert.ok(!form.wasReset);
});

test("роль міняється запитом, кошик питає адресою й прибирає лише після «так»", async () => {
  const s = screen({
    api: async (path) => {
      if (path === "/api/account/directory") return directory(PEOPLE);
      return { email: "ira@example.com", crmProfileRemains: true };
    }
  });
  const select = { closest: () => select, dataset: { email: "ira@example.com" }, value: "admin", disabled: false };
  await s.handlers["teamUserList:change"]({ target: select });
  assert.deepEqual(s.calls.find((call) => call.path === "/api/account/role").body, { email: "ira@example.com", role: "admin" });

  const button = { dataset: { removeUser: "u-2", removeEmail: "ira@example.com" }, disabled: false };
  const clickOn = () => s.handlers["teamUserList:click"]({ target: { closest: (selector) => (selector === "[data-remove-user]" ? button : null) } });

  // «Ні» — нічого не відправлено.
  const declined = screen({ confirm: () => false });
  declined.handlers["teamUserList:click"]({ target: { closest: () => button } });
  assert.equal(declined.calls.filter((call) => call.path).length, 0);
  assert.match(declined.calls[0].confirm, /Прибрати акаунт ira@example\.com назовсім/);

  // «Так» — прибрано, список перечитано, і про рядок у CRM сказано.
  clickOn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const removal = s.calls.find((call) => call.path === "/api/account/users/remove");
  assert.deepEqual(removal.body, { userId: "u-2", email: "ira@example.com" });
  assert.match(s.ids.teamUserNote.textContent, /Акаунт ira@example\.com прибрано\. Рядок у CRM лишився/);
});
