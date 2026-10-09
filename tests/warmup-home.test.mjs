import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { forgetAdoptionFolder } from "../warmup/people.mjs";
import { TO_WRITE_LIMIT } from "../warmup/first-messages.mjs";
import { DEFAULT_STRATEGY } from "../warmup/strategy.mjs";

/**
 * The Home screen and the first message to somebody who accepted.
 *
 * The product's whole point, end to end: a folder's people are invited, some
 * accept, the model writes each of them a first message, a person approves it,
 * and the account sends it in its next session. These go through the routes the
 * page and the agent call, over a stub that plays both databases, with a writer
 * that stands in for the model and remembers what it was asked.
 */

let campaignList = [];
let writer = null;
const asked = [];

function fakeWriter({ ready = true, text = (contact) => `Hi ${contact.name}, thanks for connecting. What does ${contact.company} focus on this quarter?` } = {}) {
  return {
    status: () => ({ ready }),
    async write(contact, choice) {
      asked.push({ contact, choice });
      return { text: typeof text === "function" ? text(contact) : text, productId: choice.productId || "p-default", productName: "Advantage", language: choice.language, model: "test-model" };
    }
  };
}

const rows = {};
const refuse = {};
// How many requests the stub was asked, as `METHOD table`.
const hits = {};
let stub;
let previousEnv;
let nextId = 0;

function columnValue(row, column) {
  if (!column.includes("->>")) return row[column];
  const [outer, key] = column.split("->>");
  const holder = row[outer];
  const value = holder && typeof holder === "object" ? holder[key] : undefined;
  return value === null || value === undefined ? value : String(value);
}

function ilike(value, pattern) {
  if (value === null || value === undefined) return false;
  const like = pattern.replaceAll("*", "%");
  const literal = (char) => char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let source = "";
  for (let at = 0; at < like.length; at += 1) {
    const char = like[at];
    if (char === "\\" && at + 1 < like.length) source += literal(like[++at]);
    else if (char === "%") source += ".*";
    else if (char === "_") source += ".";
    else source += literal(char);
  }
  return new RegExp(`^${source}$`, "is").test(String(value));
}

function listValues(list) {
  const values = [];
  let at = 1;
  while (at < list.length) {
    let value = "";
    if (list[at] === "\"") {
      at += 1;
      while (at < list.length && list[at] !== "\"") {
        if (list[at] === "\\") at += 1;
        value += list[at];
        at += 1;
      }
      at += 1;
    } else {
      while (at < list.length && list[at] !== "," && list[at] !== ")") value += list[at++];
    }
    values.push(value);
    if (list[at] === ")") break;
    at += 1;
  }
  return values;
}

function matches(row, params) {
  for (const [column, expression] of params.entries()) {
    if (["select", "limit", "offset", "order"].includes(column)) continue;
    const value = columnValue(row, column);
    if (expression === "is.null") {
      if (value !== null && value !== undefined) return false;
    } else if (expression === "not.is.null") {
      if (value === null || value === undefined) return false;
    } else if (expression.startsWith("eq.")) {
      if (String(value) !== expression.slice(3)) return false;
    } else if (expression.startsWith("neq.")) {
      if (String(value) === expression.slice(4)) return false;
    } else if (expression.startsWith("ilike.")) {
      if (!ilike(value, expression.slice(6))) return false;
    } else if (expression.startsWith("not.in.(")) {
      if (listValues(expression.slice(7)).includes(String(value))) return false;
    } else if (expression.startsWith("in.(")) {
      if (!listValues(expression.slice(3)).includes(String(value))) return false;
    } else if (expression.startsWith("lt.")) {
      if (value === null || value === undefined || !(String(value) < expression.slice(3))) return false;
    } else if (expression.startsWith("gte.")) {
      if (value === null || value === undefined || !(String(value) >= expression.slice(4))) return false;
    }
  }
  return true;
}

function ordered(found, params) {
  const terms = (params.get("order") || "").split(",").filter(Boolean).map((term) => {
    const [column, direction] = term.split(".");
    return { column, sign: direction === "desc" ? -1 : 1 };
  });
  const sorted = found.slice().sort((left, right) => {
    for (const { column, sign } of terms) {
      const a = String(left[column] ?? "");
      const b = String(right[column] ?? "");
      if (a !== b) return a < b ? -sign : sign;
    }
    return 0;
  });
  const offset = Number(params.get("offset")) || 0;
  const limit = params.has("limit") ? Number(params.get("limit")) : Infinity;
  return sorted.slice(offset, offset + limit);
}

async function call({ method, path, body = null }) {
  let captured = null;
  await handleWarmupApi({
    request: { method, headers: {}, auth: { profile: { email: "seller@example.com" } } },
    response: {},
    url: new URL(`http://127.0.0.1${path}`),
    sendJson: (_response, status, payload) => { captured = { status, payload }; },
    readJson: async () => body,
    campaigns: { read: () => campaignList, readTargeting: () => null, write: async () => {}, products: () => [] },
    writer
  });
  return captured;
}

test.before(async () => {
  stub = createServer((request, response) => {
    const [route, query] = request.url.split("?");
    const table = route.replace("/rest/v1/", "");
    const params = new URLSearchParams(query || "");
    const found = (rows[table] ?? []).filter((row) => matches(row, params));

    hits[`${request.method} ${table}`] = (hits[`${request.method} ${table}`] || 0) + 1;
    const refused = refuse[table]?.[request.method];
    const answer = (payload, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (refused) {
      request.resume();
      return answer({ message: "the CRM is not answering", code: "57014" }, refused);
    }
    if (request.method === "GET") return answer(ordered(found, params).slice(0, 1000));

    let payload = "";
    request.on("data", (chunk) => { payload += chunk; });
    request.on("end", () => {
      const sent = payload ? JSON.parse(payload) : null;
      if (request.method === "POST") {
        const at = new Date(Date.now() + ++nextId).toISOString();
        const made = (Array.isArray(sent) ? sent : [sent]).map((value) => ({ id: `row-${++nextId}`, created_at: at, ...value }));
        rows[table] = [...(rows[table] ?? []), ...made];
        return answer(made, 201);
      }
      return answer(found.map((row) => Object.assign(row, sent)));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));

  previousEnv = {
    url: process.env.ANTY_SUPABASE_URL, key: process.env.ANTY_SERVICE_ROLE_KEY,
    crmUrl: process.env.WARMUP_CRM_SUPABASE_URL, crmKey: process.env.WARMUP_CRM_SERVICE_ROLE_KEY,
    adopt: process.env.INBOX_ADOPT_CONTACTS, folder: process.env.INBOX_CONTACTS_FOLDER, owner: process.env.WARMUP_CRM_LEADS_OWNER_ID
  };
  const address = `http://127.0.0.1:${stub.address().port}`;
  process.env.ANTY_SUPABASE_URL = address;
  process.env.ANTY_SERVICE_ROLE_KEY = "stub-key";
  process.env.WARMUP_CRM_SUPABASE_URL = address;
  process.env.WARMUP_CRM_SERVICE_ROLE_KEY = "stub-key";
});

test.after(async () => {
  const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  restore("ANTY_SUPABASE_URL", previousEnv.url);
  restore("ANTY_SERVICE_ROLE_KEY", previousEnv.key);
  restore("WARMUP_CRM_SUPABASE_URL", previousEnv.crmUrl);
  restore("WARMUP_CRM_SERVICE_ROLE_KEY", previousEnv.crmKey);
  restore("INBOX_ADOPT_CONTACTS", previousEnv.adopt);
  restore("INBOX_CONTACTS_FOLDER", previousEnv.folder);
  restore("WARMUP_CRM_LEADS_OWNER_ID", previousEnv.owner);
  await new Promise((resolve) => stub.close(resolve));
});



test.beforeEach(() => {
  for (const table of Object.keys(refuse)) delete refuse[table];
  for (const key of Object.keys(hits)) delete hits[key];
  delete process.env.INBOX_REPLIES_PER_DAY;
  forgetAdoptionFolder();
  asked.length = 0;
  writer = fakeWriter();
  campaignList = [{
    id: "camp-1", name: "iGaming UK", folderId: "f-1", folderName: "UK operators", filters: {}, accountIds: ["acc-1", "acc-2"],
    productId: "p-igaming", fromDay: 7, state: "running", order: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
  }];
  rows.wl_accounts = [
    { id: "acc-1", label: "Profile 3", login: "mary@example.com", profile_remote_id: "profile-1", status: "warming", health: "ok" },
    { id: "acc-2", label: "Profile 4", login: "chloe@example.com", profile_remote_id: "profile-2", status: "warming", health: "ok" }
  ];
  const started = new Date();
  started.setUTCDate(started.getUTCDate() - 11);
  started.setUTCHours(0, 0, 0, 0);
  rows.wl_runs = ["acc-1", "acc-2"].map((accountId) => ({
    id: `run-${accountId}`, account_id: accountId, state: "running", started_at: started.toISOString(),
    paused_days: 0, paused_until: null, strategy_snapshot: DEFAULT_STRATEGY
  }));
  rows.wl_day_actions = [];
  rows.wl_sessions = [];
  rows.wl_events = [];
  const person = (id, accountId, status, extra = {}) => ({
    id, account_id: accountId, crm_contact_id: `c-${id}`, person_name: `Person ${id}`, person_company: `Company ${id}`,
    person_position: "Head of Growth", person_linkedin: `https://www.linkedin.com/in/person-${id}/`, person_country: "United Kingdom",
    sent_by: "mary@example.com", status, note: null, created_at: "2026-10-05T10:00:00.000Z", responded_at: null, ...extra
  });
  rows.wl_outreach = [
    person("o-1", "acc-1", "accepted"),
    person("o-2", "acc-1", "accepted", { person_country: "Україна", person_name: "Олена Бондар" }),
    person("o-3", "acc-2", "accepted"),
    person("o-4", "acc-1", "pending"),
    person("o-5", "acc-1", "connected", { responded_at: new Date().toISOString() }),
    person("o-6", "acc-2", "declined"),
    person("o-7", "acc-1", "waiting"),
    person("o-8", "acc-2", "queued")
  ];
  rows.contacts = [{ id: "c-o-1", name: "Person o-1", company: "Company o-1", position: "Head of Growth", description: "Runs UK casino acquisition", country: "United Kingdom" }];
  rows.contact_folders = [];
  rows.activities = [];
});

const ask = (path, body) => call({ method: "POST", path: `/api/warmup/${path}`, body });
const home = async () => (await call({ method: "GET", path: "/api/warmup/home" })).payload;
const post = (body) => call({ method: "POST", path: "/api/warmup/agent", body });
const events = (type) => rows.wl_events.filter((row) => row.type === type);

// ── Конвеєр ───────────────────────────────────────────────────────────────

test("головна рахує конвеєр: у черзі → запрошено → прийняли → ми написали → відповіли", async () => {
  const view = await home();
  assert.equal(view.success, true);
  assert.deepEqual(view.funnel, { queued: 2, invited: 6, accepted: 4, written: 0, replied: 1 });
  assert.equal(view.today.replied, 1, "відповідь сьогодні");
  assert.equal(view.writer.ready, true);
  assert.match(view.window, /^\d\d:00–\d\d:00$/);
});

test("виключений акаунт не рахується і не показується", async () => {
  rows.wl_accounts[1].status = "excluded";
  const view = await home();
  assert.deepEqual(view.accounts.map((row) => row.id), ["acc-1"]);
  assert.equal(view.funnel.invited, 4, "рядки виключеного акаунта не в конвеєрі");
  assert.deepEqual(view.toWrite.map((row) => row.outreachId).sort(), ["o-1", "o-2"]);
});

test("кому написати: прийняли й мовчать; хто вже розмовляє з акаунтом — ні", async () => {
  // З Person o-3 акаунт уже має розмову — їй вступне повідомлення не потрібне.
  rows.wl_events.push({ id: "m-1", account_id: "acc-2", type: "message.in", created_at: new Date().toISOString(),
    meta: { threadKey: "t-3", body: "Hi!", participant: { name: "Person o-3", slug: "person-o-3" } } });
  const view = await home();
  assert.deepEqual(view.toWrite.map((row) => row.outreachId).sort(), ["o-1", "o-2"]);
  const first = view.toWrite.find((row) => row.outreachId === "o-1");
  assert.equal(first.name, "Person o-1");
  assert.equal(first.accountName, "Profile 3");
  assert.equal(first.linkedin, "https://www.linkedin.com/in/person-o-1/");
  assert.equal(first.draft, null, "ще не написано");
  assert.equal(view.toWriteTotal, 2);
});

test("список кому написати обмежений, а загальне число каже, скільки їх усього", async () => {
  for (let at = 0; at < TO_WRITE_LIMIT + 5; at += 1) {
    rows.wl_outreach.push({ id: `x-${at}`, account_id: "acc-1", crm_contact_id: null, person_name: `X ${at}`, person_company: "", person_position: "",
      person_linkedin: `https://www.linkedin.com/in/x-${at}/`, person_country: "", status: "accepted", created_at: "2026-10-06T10:00:00.000Z" });
  }
  const view = await home();
  assert.equal(view.toWrite.length, TO_WRITE_LIMIT);
  assert.equal(view.toWriteTotal, TO_WRITE_LIMIT + 5 + 3);
});

test("що потребує людини: ліміт, пауза, проблемний акаунт, жодної кампанії, немає моделі", async () => {
  rows.wl_accounts[0].health = "needs_login";
  rows.wl_accounts[0].health_note = "Потрібен вхід у LinkedIn";
  campaignList = [];
  writer = fakeWriter({ ready: false });
  const view = await home();
  const text = view.attention.map((row) => row.text).join(" | ");
  assert.match(text, /Потрібен вхід у LinkedIn/);
  assert.match(text, /Жодна кампанія не запущена/);
  assert.match(text, /Модель для повідомлень не підключена/);
  assert.equal(view.writer.ready, false);
});

// ── Чернетка першого повідомлення ─────────────────────────────────────────

test("модель пише перше повідомлення з картки CRM; воно зберігається і вдруге не пишеться", async () => {
  const answer = await ask("first-messages/draft", { outreachId: "o-1" });
  assert.equal(answer.status, 200);
  assert.match(answer.payload.draft.text, /Hi Person o-1/);
  assert.equal(answer.payload.draft.model, "test-model");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].contact.description, "Runs UK casino acquisition", "запис CRM потрапив у те, з чого пише модель");
  assert.equal(asked[0].choice.productId, "p-igaming", "продукт — кампанії, яку веде акаунт");
  assert.equal(asked[0].choice.language, "en");

  const again = await ask("first-messages/draft", { outreachId: "o-1" });
  assert.equal(again.payload.reused, true);
  assert.equal(asked.length, 1, "друге відкриття сторінки не платить за ту саму чернетку");
  assert.match((await home()).toWrite.find((row) => row.outreachId === "o-1").draft.text, /Hi Person o-1/);

  const forced = await ask("first-messages/draft", { outreachId: "o-1", force: true, instruction: "коротше" });
  assert.equal(forced.status, 200);
  assert.equal(asked.length, 2, "«Переписати» — нова чернетка");
  assert.equal(asked[1].choice.instruction, "коротше");
});

test("людині з України — українською; без кампанії — продукт простору", async () => {
  campaignList = [];
  await ask("first-messages/draft", { outreachId: "o-2" });
  assert.equal(asked[0].choice.language, "uk");
  assert.equal(asked[0].choice.productId, "");
});

test("чернетку не пишуть тому, хто не «прийняв і мовчить», і без моделі сервер каже це", async () => {
  assert.equal((await ask("first-messages/draft", { outreachId: "o-4" })).status, 404, "ще не прийняв");
  assert.equal((await ask("first-messages/draft", { outreachId: "o-5" })).status, 404, "уже відповів");
  assert.equal((await ask("first-messages/draft", { outreachId: "nope" })).status, 404);
  writer = null;
  assert.equal((await ask("first-messages/draft", { outreachId: "o-1" })).status, 503);
  writer = fakeWriter({ text: "   " });
  assert.equal((await ask("first-messages/draft", { outreachId: "o-1" })).status, 502, "порожнє — не чернетка");
});

test("дві одночасні вимоги однієї чернетки — один виклик моделі", async () => {
  let release;
  writer = { status: () => ({ ready: true }), async write(contact, choice) { asked.push({ contact, choice }); await new Promise((r) => { release = r; }); return { text: "Hi", model: "m" }; } };
  const one = ask("first-messages/draft", { outreachId: "o-1" });
  const two = ask("first-messages/draft", { outreachId: "o-1" });
  await new Promise((r) => setTimeout(r, 50));
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(asked.length, 1);
});

// ── Надіслати ─────────────────────────────────────────────────────────────

test("«Надіслати» ставить перше повідомлення в чергу акаунта — і агент отримує його з профілем людини", async () => {
  const sent = await ask("first-messages/send", { outreachId: "o-1", text: "Hi Person, thanks for connecting!" });
  assert.equal(sent.status, 201);
  assert.equal(sent.payload.reply.kind, "first");
  assert.equal(sent.payload.reply.state, "waiting");
  assert.ok(sent.payload.goesOutAt);

  const plan = (await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" })).payload.outbox;
  assert.equal(plan.toSend.length, 1);
  assert.equal(plan.toSend[0].kind, "first");
  assert.equal(plan.toSend[0].linkedin, "https://www.linkedin.com/in/person-o-1/");
  assert.equal(plan.toSend[0].text, "Hi Person, thanks for connecting!");
  assert.equal(plan.toSend[0].name, "Person o-1");

  const prepared = await post({ action: "outbox.prepare", accountId: "acc-1", replyId: sent.payload.reply.id });
  assert.equal(prepared.payload.allowed, true);
  assert.equal(prepared.payload.reply.kind, "first");
  assert.equal(prepared.payload.reply.linkedin, "https://www.linkedin.com/in/person-o-1/");

  // На головній людина лишається з позначкою «чекає», доки не піде.
  const waiting = (await home()).toWrite.find((row) => row.outreachId === "o-1");
  assert.equal(waiting.reply.state, "waiting");
  assert.ok(waiting.goesOut?.at);
});

test("надіслане перше повідомлення прибирає людину зі списку й додається до «ми написали»", async () => {
  const sent = await ask("first-messages/send", { outreachId: "o-1", text: "Hi!" });
  await post({ action: "outbox.sent", accountId: "acc-1", replyId: sent.payload.reply.id });
  const view = await home();
  assert.equal(view.toWrite.some((row) => row.outreachId === "o-1"), false);
  assert.equal(view.funnel.written, 1);
});

test("друге інше перше повідомлення тій самій людині — відмова; те саме ще раз — те саме", async () => {
  const first = await ask("first-messages/send", { outreachId: "o-1", text: "Hi there" });
  const same = await ask("first-messages/send", { outreachId: "o-1", text: "hi   there" });
  assert.equal(same.status, 200);
  assert.equal(same.payload.reply.id, first.payload.reply.id);
  const other = await ask("first-messages/send", { outreachId: "o-1", text: "Something else" });
  assert.equal(other.status, 409);
  assert.match(other.payload.error, /вже чекає перше повідомлення/);
  // Скасоване звільняє місце.
  await ask("inbox/reply/cancel", { accountId: "acc-1", replyId: first.payload.reply.id });
  assert.equal((await ask("first-messages/send", { outreachId: "o-1", text: "Something else" })).status, 201);
});

test("невдале перше повідомлення лишає людину в списку з причиною", async () => {
  const sent = await ask("first-messages/send", { outreachId: "o-1", text: "Hi!" });
  await post({ action: "outbox.failed", accountId: "acc-1", replyId: sent.payload.reply.id, reason: "не знайшов кнопку «Повідомлення»" });
  const row = (await home()).toWrite.find((item) => item.outreachId === "o-1");
  assert.equal(row.reply.state, "failed");
  assert.match(row.reply.reason, /Повідомлення/);
});

test("надіслати не можна: акаунт на паузі, немає профілю, порожньо, задовго, не той статус", async () => {
  rows.wl_outreach[0].person_linkedin = "";
  assert.equal((await ask("first-messages/send", { outreachId: "o-1", text: "Hi" })).status, 409);
  rows.wl_runs[1].paused_until = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const paused = await ask("first-messages/send", { outreachId: "o-3", text: "Hi" });
  assert.equal(paused.status, 409);
  assert.match(paused.payload.error, /на паузі/);
  assert.equal((await ask("first-messages/send", { outreachId: "o-2", text: "  " })).status, 400);
  assert.equal((await ask("first-messages/send", { outreachId: "o-2", text: "a".repeat(1201) })).status, 400);
  assert.equal((await ask("first-messages/send", { outreachId: "o-4", text: "Hi" })).status, 404);
  assert.equal(events("outbox.queued").length, 0);
});

test("«Пропустити» прибирає людину зі списку, а журнал не показує текстів чернеток", async () => {
  await ask("first-messages/draft", { outreachId: "o-2" });
  assert.equal((await ask("first-messages/dismiss", { outreachId: "o-2" })).status, 200);
  assert.equal((await home()).toWrite.some((row) => row.outreachId === "o-2"), false);
  const audit = JSON.stringify((await call({ method: "GET", path: "/api/warmup/events?limit=50" })).payload);
  assert.doesNotMatch(audit, /Hi Олена Бондар/);
  assert.match(audit, /first\.dismissed/);
});
