import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { ADOPT_FOLDER_DEFAULT, adoptable, forgetAdoptionFolder, hasProfileWords, personName, profileLink } from "../warmup/people.mjs";
import { ADOPT_PER_SYNC, CONTACT_TYPE, SERVICE_CARD_BODY, isServiceCard, normalizeThreadInput } from "../warmup/inbox.mjs";
import { DEFAULT_STRATEGY } from "../warmup/strategy.mjs";

/**
 * Everybody who appears in a conversation is in the CRM.
 *
 * Until now a person who wrote to a login and was on nobody's list was a name
 * on stored messages: no card to open, nowhere for the conversation to land.
 * They are now added to the contact base, in a folder of their own — and only
 * people: a profile and a name, never LinkedIn's own notices, never somebody
 * who is already there, never twice. These go through the routes the agent
 * calls, over a stub that plays both databases.
 */

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
    campaigns: { read: () => [], readTargeting: () => null, write: async () => {}, products: () => [] }
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
  delete process.env.INBOX_ADOPT_CONTACTS;
  delete process.env.INBOX_CONTACTS_FOLDER;
  delete process.env.WARMUP_CRM_LEADS_OWNER_ID;
  forgetAdoptionFolder();
  rows.wl_accounts = [
    { id: "acc-1", label: "Chloe Stewart", login: "chloe@example.com", profile_remote_id: "profile-1", status: "warming", health: "ok" },
    { id: "acc-2", label: "Mary Lindsay", login: "mary@example.com", profile_remote_id: "profile-2", status: "warming", health: "ok" }
  ];
  rows.wl_runs = [];
  rows.wl_day_actions = [];
  rows.wl_sessions = [];
  rows.wl_events = [];
  rows.wl_outreach = [{
    id: "o-1", account_id: "acc-1", crm_contact_id: "c-1", person_name: "Marta Kovalenko",
    person_linkedin: "https://www.linkedin.com/in/marta-kovalenko/", sent_by: "chloe@example.com", status: "pending",
    note: null, created_at: "2026-09-10T10:00:00.000Z", responded_at: null
  }];
  rows.contacts = [
    { id: "c-1", name: "Marta Kovalenko", company: "Fleetify", linkedin: "https://www.linkedin.com/in/marta-kovalenko/", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "c-9", name: "Olena Bondar", company: "Glovo", linkedin: "https://www.linkedin.com/in/olena-bondar/", created_at: "2026-01-03T00:00:00.000Z" }
  ];
  rows.contact_folders = [];
  rows.activities = [];
});

const events = (type) => rows.wl_events.filter((row) => row.type === type);
const added = () => rows.contacts.filter((row) => row.custom_fields?.source === "linkedin_inbox");

function thread(messages, participant, threadKey, accountId = "acc-1") {
  return call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.thread", accountId, threadKey, participant, messages } });
}

const done = (accountId = "acc-1") => call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.done", accountId, threadsSeen: 1 } });

const OURS = { externalId: "m-1", direction: "out", body: "Вітаю, Іване! Бачу, ви в Pixel Forge.", sentAt: "2026-09-20T09:00:00.000Z" };
const THEIRS = { externalId: "m-2", direction: "in", body: "Привіт! Розкажіть детальніше.", sentAt: "2026-09-20T11:30:00.000Z" };
const IVAN = { name: "Ivan Petrov", slug: "ivan-petrov", headline: "Head of UA, Pixel Forge" };

// ── Хто людина, а хто ні ──────────────────────────────────────────────────

test("людина — це ім'я й профіль LinkedIn; службові відправники, безіменні й сторінки компаній — ні", () => {
  assert.equal(adoptable(IVAN), true);
  assert.equal(adoptable({ name: "Ivan Petrov", slug: "https://www.linkedin.com/in/ivan-petrov/" }), true);
  assert.equal(adoptable({ name: "Ivan Petrov", slug: "ACoAABxyz123" }), true, "ідентифікатор учасника — теж профіль");
  for (const [label, participant] of [
    ["без профілю", { name: "Ivan Petrov", slug: null }],
    ["безіменний", { name: "Unknown", slug: "ivan-petrov" }],
    ["порожнє ім'я", { name: "", slug: "ivan-petrov" }],
    ["LinkedIn Team", { name: "The LinkedIn Team", slug: "linkedin-team" }],
    ["LinkedIn Member", { name: "LinkedIn Member", slug: "someone" }],
    ["лише службові слова", { name: "Переглянути профіль", slug: "someone" }],
    ["сторінка компанії", { name: "Pixel Forge", slug: "https://www.linkedin.com/company/pixel-forge/" }],
    ["не профіль учасника", { name: "Ivan Petrov", slug: "ivan-petrov", memberProfile: false }]
  ]) assert.equal(adoptable(participant), false, label);
});

test("ім'я в CRM — без службових слів LinkedIn, посилання — на профіль у тому вигляді, в якому його потім знайдуть", () => {
  assert.equal(personName({ name: "Переглянути профіль Sinan" }), "Sinan");
  assert.equal(personName({ name: "View profile of Anna Lee" }), "Anna Lee");
  assert.equal(personName({ name: "  Ivan   Petrov " }), "Ivan Petrov");
  assert.equal(profileLink({ slug: "ivan-petrov" }), "https://www.linkedin.com/in/ivan-petrov");
  assert.equal(profileLink({ slug: "https://www.linkedin.com/in/Ivan-Petrov/?trk=x" }), "https://www.linkedin.com/in/ivan-petrov".replace("ivan-petrov", profileLink({ slug: "https://www.linkedin.com/in/Ivan-Petrov/?trk=x" }).split("/in/")[1]));
});

// ── Нова людина в розмові ─────────────────────────────────────────────────

test("хто написав на акаунт і ніде не записаний, потрапляє в CRM у свою папку, а розмова лягає на їхній запис", async () => {
  const first = await thread([THEIRS, OURS], IVAN, "t-ivan");
  assert.equal(first.status, 200);
  assert.equal(first.payload.matchedBy, "added");
  assert.equal(first.payload.added, true);
  assert.equal(first.payload.crm, "written");
  assert.equal(first.payload.crmWritten, 2);

  // Папка з'явилась одна, з назвою за замовчуванням, і людина лежить саме в ній.
  assert.equal(rows.contact_folders.length, 1);
  assert.equal(rows.contact_folders[0].name, ADOPT_FOLDER_DEFAULT);
  const [person] = added();
  assert.equal(person.id, first.payload.crmContactId);
  assert.equal(person.folder_id, rows.contact_folders[0].id);
  assert.equal(person.name, "Ivan Petrov");
  assert.equal(person.linkedin, "https://www.linkedin.com/in/ivan-petrov");
  assert.equal(person.position, "Head of UA, Pixel Forge");
  assert.match(person.description, /chloe@example\.com/);
  assert.equal("lead_status" in person, false, "статус, який належить CRM, не вигадується");

  // Обидва боки розмови — на їхньому записі, по порядку.
  assert.equal(rows.activities.length, 2);
  assert.ok(rows.activities.every((row) => row.contact_id === person.id && row.type === "linkedin"));
  assert.match(rows.activities[0].content, /Ми написали з акаунта chloe@example\.com/);
  assert.match(rows.activities[1].content, /Відповідь на акаунт chloe@example\.com/);
  // І повідомлення збережені вже з ключем людини.
  assert.ok(rows.wl_events.filter((row) => row.type.startsWith("message.")).every((row) => row.meta.crmContactId === person.id));
});

test("та сама розмова вдруге нікого не додає: ні контакту, ні папки, ні рядків", async () => {
  await thread([THEIRS, OURS], IVAN, "t-ivan");
  const again = await thread([{ externalId: "m-3", direction: "in", body: "І ще: яка ціна?", sentAt: "2026-09-21T08:00:00.000Z" }, THEIRS, OURS], IVAN, "t-ivan");
  assert.equal(again.payload.added, false);
  assert.equal(again.payload.matchedBy, "linkedin", "тепер вони вже в CRM, і їх знайдено за посиланням");
  assert.equal(added().length, 1);
  assert.equal(rows.contact_folders.length, 1);
  assert.equal(rows.activities.length, 3);
});

test("папка з такою назвою вже є — нові люди йдуть у неї; закопана в архів не береться", async () => {
  rows.contact_folders = [{ id: "f-live", name: ADOPT_FOLDER_DEFAULT, is_archived: false }];
  await thread([THEIRS], IVAN, "t-ivan");
  assert.equal(rows.contact_folders.length, 1, "друга папка не з'явилась");
  assert.equal(added()[0].folder_id, "f-live");

  rows.contact_folders = [{ id: "f-old", name: "Вхідні 2", is_archived: true }];
  rows.contacts = rows.contacts.filter((row) => row.custom_fields?.source !== "linkedin_inbox");
  forgetAdoptionFolder();
  process.env.INBOX_CONTACTS_FOLDER = "Вхідні 2";
  await thread([{ ...THEIRS, externalId: "m-after-archive" }], IVAN, "t-ivan-2");
  assert.equal(rows.contact_folders.length, 2, "архівну папку не воскрешено — зроблено нову");
  assert.notEqual(added()[0].folder_id, "f-old");
});

test("назву папки й власника можна задати налаштуваннями", async () => {
  process.env.INBOX_CONTACTS_FOLDER = "Хто писав";
  process.env.WARMUP_CRM_LEADS_OWNER_ID = "owner-7";
  await thread([THEIRS], IVAN, "t-ivan");
  assert.equal(rows.contact_folders[0].name, "Хто писав");
  assert.equal(rows.contact_folders[0].owner_id, "owner-7");
  assert.equal(added()[0].owner_id, "owner-7");
});

test("хто вже є в CRM за посиланням на профіль, того не додають вдруге", async () => {
  const answer = await thread([THEIRS], { name: "Olena Bondar", slug: "olena-bondar" }, "t-olena");
  assert.equal(answer.payload.crmContactId, "c-9");
  assert.equal(answer.payload.added, false);
  assert.equal(answer.payload.matchedBy, "linkedin");
  assert.equal(added().length, 0);
  assert.equal(rows.contact_folders.length, 0, "і папку заради цього не створено");
});

test("«Переглянути профіль Sinan» потрапляє в CRM як Sinan", async () => {
  await thread([THEIRS], { name: "Переглянути профіль Sinan", slug: "sinan-arslan", headline: null }, "t-sinan");
  assert.equal(added()[0].name, "Sinan");
  assert.equal("position" in added()[0], false, "порожня посада не пишеться порожнім рядком");
});

test("не люди в CRM не потрапляють, а їхні повідомлення все одно збережені", async () => {
  for (const [key, participant] of [
    ["t-notice", { name: "The LinkedIn Team", slug: "linkedin-team" }],
    ["t-noname", { name: "LinkedIn Member", slug: null }],
    ["t-noslug", { name: "Ivan Petrov", slug: null }],
    ["t-company", { name: "Pixel Forge", slug: "https://www.linkedin.com/company/pixel-forge/" }]
  ]) {
    const answer = await thread([{ ...THEIRS, externalId: `m-${key}` }], participant, key);
    assert.equal(answer.payload.stored, 1, key);
    assert.equal(answer.payload.added, false, key);
    assert.equal(answer.payload.crmContactId, null, key);
  }
  assert.equal(added().length, 0);
  assert.equal(rows.contact_folders.length, 0);
  assert.equal(rows.wl_events.filter((row) => row.type === "message.in").length, 4);
});

test("двох акаунтів, що прочитали одного незнайомця одночасно, — один контакт", async () => {
  const [one, two] = await Promise.all([
    thread([THEIRS], IVAN, "t-ivan-1", "acc-1"),
    thread([{ ...THEIRS, externalId: "m-other" }], IVAN, "t-ivan-2", "acc-2")
  ]);
  assert.equal(added().length, 1, "хто швидший, той додав; другий знайшов його");
  assert.equal(one.payload.crmContactId, two.payload.crmContactId);
  assert.equal([one.payload.added, two.payload.added].filter(Boolean).length, 1);
  assert.equal(rows.contact_folders.length, 1);
});

// ── Коли CRM не відповідає або вимкнено ───────────────────────────────────

test("вимкнено INBOX_ADOPT_CONTACTS=0 — нікого не додають, ні при читанні, ні наприкінці", async () => {
  process.env.INBOX_ADOPT_CONTACTS = "0";
  const answer = await thread([THEIRS], IVAN, "t-ivan");
  assert.equal(answer.payload.added, false);
  assert.equal(answer.payload.crmContactId, null);
  assert.equal(answer.payload.stored, 1);
  const finished = await done();
  assert.deepEqual(finished.payload.crmAdded, { waiting: 0, added: 0, linked: 0, failed: 0 });
  assert.equal(added().length, 0);
  assert.equal(rows.contact_folders.length, 0);
});

test("CRM відмовила зробити контакт — повідомлення збережені, а людину додають наступного разу", async () => {
  refuse.contacts = { POST: 503 };
  const first = await thread([THEIRS, OURS], IVAN, "t-ivan");
  assert.equal(first.status, 200);
  assert.equal(first.payload.stored, 2, "повідомлення не втрачено");
  assert.equal(first.payload.crmContactId, null);
  assert.equal(first.payload.crm, "failed");
  assert.equal(added().length, 0);
  assert.equal(events("inbox.crm_failed").length > 0, true, "відмову видно в журналі");

  // CRM ожила, агент закінчив читання — людину додано, а розмова лягла на неї.
  delete refuse.contacts;
  const finished = await done();
  assert.equal(finished.payload.crmAdded.added, 1);
  assert.equal(added().length, 1);
  assert.equal(rows.activities.length, 2);
  assert.ok(rows.activities.every((row) => row.contact_id === added()[0].id));

  // І наступний день нічого не дублює.
  await done();
  assert.equal(added().length, 1);
  assert.equal(rows.activities.length, 2);
});

test("папку зробити не вдалося — це не вчить сервер пам'ятати невдачу: наступна людина пробує знову", async () => {
  refuse.contact_folders = { POST: 500 };
  const first = await thread([THEIRS], IVAN, "t-ivan");
  assert.equal(first.payload.crmContactId, null);
  assert.equal(first.payload.stored, 1);
  delete refuse.contact_folders;
  const second = await thread([{ ...THEIRS, externalId: "m-x" }], { name: "Oksana Hrytsenko", slug: "oksana-hrytsenko" }, "t-oksana");
  assert.equal(second.payload.added, true);
  assert.equal(rows.contact_folders.length, 1);
});

// ── Розмови, збережені раніше ─────────────────────────────────────────────

test("CRM, що відмовила одному, не питається про решту того ж читання", async () => {
  process.env.INBOX_ADOPT_CONTACTS = "0";
  for (let i = 0; i < 4; i += 1) {
    await thread([{ externalId: `m-${i}`, direction: "in", body: "Привіт", sentAt: "2026-09-20T11:30:00.000Z" }], { name: `Person Number${i}`, slug: `person-${i}` }, `t-${i}`);
  }
  process.env.INBOX_ADOPT_CONTACTS = "1";
  refuse.contacts = { POST: 503 };
  const first = await done();
  assert.equal(first.payload.crmAdded.failed, 1);
  assert.equal(hits["POST contacts"], 1, "після першої відмови решту не пробували");
  assert.equal(added().length, 0);
  delete refuse.contacts;
  const second = await done();
  assert.equal(second.payload.crmAdded.added, 4, "наступного разу — усіх");
});

test("розмови, що вже лежали без людини, наприкінці читання отримують контакт і відкриваються з вхідних", async () => {
  process.env.INBOX_ADOPT_CONTACTS = "0";
  await thread([THEIRS, OURS], IVAN, "t-ivan");
  await thread([{ ...THEIRS, externalId: "m-oksana" }], { name: "Oksana Hrytsenko", slug: "oksana-hrytsenko" }, "t-oksana");
  assert.equal(added().length, 0);
  assert.equal(rows.activities.length, 0);

  process.env.INBOX_ADOPT_CONTACTS = "1";
  const finished = await done();
  assert.equal(finished.payload.crmAdded.waiting, 2);
  assert.equal(finished.payload.crmAdded.added, 2);
  assert.equal(added().length, 2);
  assert.equal(rows.activities.length, 3, "що було сказано в обох розмовах, лягло на нових людей");

  // Список вхідних тепер знає, чия це розмова, — і кнопка «Відкрити в CRM» має куди вести.
  const list = await call({ method: "GET", path: "/api/warmup/inbox" });
  const byKey = new Map(list.payload.threads.map((row) => [row.threadKey, row]));
  assert.equal(byKey.get("t-ivan").crmContactId, added().find((row) => row.name === "Ivan Petrov").id);
  assert.equal(byKey.get("t-oksana").crmContactId, added().find((row) => row.name === "Oksana Hrytsenko").id);
  const one = await call({ method: "GET", path: "/api/warmup/inbox/thread?accountId=acc-1&threadKey=t-ivan" });
  assert.equal(one.payload.thread.crmContactId, byKey.get("t-ivan").crmContactId);

  // Прив'язка — окремий рядок, який не потрапляє в журнал акаунта.
  assert.equal(events(CONTACT_TYPE).length, 2);
  const log = await call({ method: "GET", path: "/api/warmup/events?accountId=acc-1" });
  assert.equal(log.payload.events.filter((row) => row.type === CONTACT_TYPE).length, 0);

  // Другий раз нічого не робить: ні контактів, ні рядків, ні прив'язок.
  const again = await done();
  assert.deepEqual(again.payload.crmAdded, { waiting: 0, added: 0, linked: 0, failed: 0 });
  assert.equal(added().length, 2);
  assert.equal(rows.activities.length, 3);
  assert.equal(events(CONTACT_TYPE).length, 2);
});

test("за одне читання додають не більше ніж ADOPT_PER_SYNC людей, решту — наступного", async () => {
  process.env.INBOX_ADOPT_CONTACTS = "0";
  const total = ADOPT_PER_SYNC + 3;
  for (let i = 0; i < total; i += 1) {
    await thread([{ externalId: `m-${i}`, direction: "in", body: `Привіт ${i}`, sentAt: "2026-09-20T11:30:00.000Z" }], { name: `Person Number${i}`, slug: `person-${i}` }, `t-${i}`);
  }
  process.env.INBOX_ADOPT_CONTACTS = "1";
  const first = await done();
  assert.equal(first.payload.crmAdded.waiting, total);
  assert.equal(first.payload.crmAdded.added, ADOPT_PER_SYNC);
  const second = await done();
  assert.equal(second.payload.crmAdded.added, 3);
  assert.equal(added().length, total);
});

test("розмова з людиною, яка вже є в CRM за посиланням, при зведенні лише прив'язується, а не дублюється", async () => {
  // Розмову збережено, коли в CRM цієї людини ще не було; потім її внесли самі.
  process.env.INBOX_ADOPT_CONTACTS = "0";
  const olena = rows.contacts.find((row) => row.id === "c-9");
  rows.contacts = rows.contacts.filter((row) => row.id !== "c-9");
  await thread([THEIRS], { name: "Olena Bondar", slug: "olena-bondar" }, "t-olena");
  rows.contacts.push(olena);
  process.env.INBOX_ADOPT_CONTACTS = "1";
  const finished = await done();
  assert.equal(finished.payload.crmAdded.linked, 1);
  assert.equal(finished.payload.crmAdded.added, 0);
  assert.equal(added().length, 0);
  const list = await call({ method: "GET", path: "/api/warmup/inbox" });
  assert.equal(list.payload.threads.find((row) => row.threadKey === "t-olena").crmContactId, "c-9");
});

test("і ті, кого цей акаунт сам запрошував, лишаються за своїм запитом, а не стають «новими»", async () => {
  const answer = await thread([THEIRS], { name: "Marta Kovalenko", slug: "marta-kovalenko" }, "t-marta");
  assert.equal(answer.payload.matchedBy, "outreach");
  assert.equal(answer.payload.added, false);
  assert.equal(added().length, 0);
  const finished = await done();
  assert.equal(finished.payload.crmAdded.waiting, 0);
});

// ── Службові картки ───────────────────────────────────────────────────────
//
// «Переглянути профіль Sinan» і «[no text]» у вхідних були не розмовами, а
// картинками: рядок без тексту й без вкладення, який агент зберігав як
// повідомлення. Нове від агента такого не шле, а те, що вже лежить у базі або
// ще прийде від старого агента, не стає розмовою, не робить розмову непрочитаною,
// не є останнім сказаним і не йде в CRM.

let legacyId = 0;

/** A message row as an older agent left it, written straight into the table. */
function stored({ threadKey, body, direction = "in", participant = { name: "Переглянути профіль Sinan", slug: "sinan-arslan-1" }, accountId = "acc-1", minutesAgo = 30, crmContactId = null }) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  rows.wl_events.push({
    id: `legacy-${++legacyId}`, account_id: accountId, level: "info", type: direction === "in" ? "message.in" : "message.out",
    message: "legacy", created_at: at,
    meta: { threadKey, crmContactId, awaitsContact: !crmContactId, externalId: `legacy-ext-${legacyId}`, direction, body, sentAt: at, sentAtGiven: true, participant }
  });
}

test("картка — це «[no text]» і аватарка, збережена як вкладення; справжнє вкладення й порожнє слово «text» — ні", () => {
  assert.equal(SERVICE_CARD_BODY, "[no text]");
  assert.equal(isServiceCard("[no text]"), true);
  assert.equal(isServiceCard("  [No Text] "), true);
  assert.equal(isServiceCard("[attachment]"), false, "вкладення саме по собі — повідомлення");
  assert.equal(isServiceCard("[attachment]", { name: "Ivan Petrov" }), false, "файл від людини з ім'ям — повідомлення");
  assert.equal(isServiceCard("[attachment]", { name: "Переглянути профіль Sinan" }), true, "аватарка, яку старий агент прочитав як вкладення");
  assert.equal(isServiceCard("[attachment]", { name: "View Sinan’s profile" }), true);
  assert.equal(isServiceCard("[attachment]", { name: "View profile of Anna Lee" }), true);
  assert.equal(isServiceCard("Привіт", { name: "Переглянути профіль Sinan" }), false, "слова — завжди слова");
  assert.equal(isServiceCard("no text"), false);
  assert.equal(isServiceCard("Привіт [no text] світ"), false);
  assert.equal(isServiceCard(undefined), false);
});

test("речення про аватарку — не ім'я: українською й англійською, а справжні імена ні", () => {
  for (const sentence of ["Переглянути профіль Sinan", "переглянути   профіль Edgar", "View profile of Anna Lee", "View profile Luke", "View Sinan’s profile", "View Sinan's profile"]) {
    assert.equal(hasProfileWords(sentence), true, sentence);
  }
  for (const name of ["Sinan Arslan", "Viewer Smith", "Oleh Petrenko", "", null, undefined]) assert.equal(hasProfileWords(name), false, String(name));
});

test("картки, які шле старий агент, відкидаються при вході й не вважаються некоректними", () => {
  const input = normalizeThreadInput({
    threadKey: "t-cards",
    participant: { name: "Sinan", slug: "sinan-arslan-1" },
    messages: [
      { externalId: "a", direction: "in", body: "[no text]", sentAt: "2026-09-20T09:00:00.000Z" },
      { externalId: "b", direction: "in", body: "Привіт!", sentAt: "2026-09-20T09:05:00.000Z" },
      { externalId: "c", direction: "out", body: "[no text]", sentAt: "2026-09-20T09:06:00.000Z" },
      { externalId: "d", direction: "in", body: "[attachment]", sentAt: "2026-09-20T09:07:00.000Z" },
      { externalId: "e", direction: "in", body: "   ", sentAt: "2026-09-20T09:08:00.000Z" }
    ]
  });
  assert.deepEqual(input.messages.map((m) => m.body), ["Привіт!", "[attachment]"]);
  assert.equal(input.cards, 2);
  assert.equal(input.invalid, 1, "порожнє тіло лишається некоректним, картка — ні");

  // Той самий старий агент надсилав аватарку як вкладення — під реченням про неї замість імені.
  const avatar = normalizeThreadInput({
    threadKey: "t-avatar",
    participant: { name: "Переглянути профіль Sinan", slug: "sinan-arslan-1" },
    messages: [{ externalId: "av-1", direction: "in", body: "[attachment]", sentAt: "2026-09-20T09:00:00.000Z" }]
  });
  assert.deepEqual(avatar.messages, []);
  assert.equal(avatar.cards, 1);
  // А файл від людини з ім'ям — це вкладення.
  const file = normalizeThreadInput({
    threadKey: "t-file",
    participant: { name: "Sinan Arslan", slug: "sinan-arslan-1" },
    messages: [{ externalId: "f-1", direction: "in", body: "[attachment]", sentAt: "2026-09-20T09:00:00.000Z" }]
  });
  assert.deepEqual(file.messages.map((m) => m.body), ["[attachment]"]);
  assert.equal(file.cards, 0);
});

test("розмова, у якій від старого агента прийшли самі картки, нічого не зберігає, нікого не додає й не рухає запрошення", async () => {
  const answer = await thread(
    [
      { externalId: "k-1", direction: "in", body: "[no text]", sentAt: "2026-09-20T09:00:00.000Z" },
      { externalId: "k-2", direction: "out", body: "[no text]", sentAt: "2026-09-20T09:01:00.000Z" }
    ],
    { name: "Marta Kovalenko", slug: "marta-kovalenko" },
    "t-marta"
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.stored, 0);
  assert.equal(answer.payload.cards, 2);
  assert.equal(answer.payload.statusMoved, false, "картка — не відповідь, тож «прийняв» запрошення від неї не стає");
  assert.equal(rows.wl_outreach[0].status, "pending");
  assert.equal(rows.wl_events.filter((row) => row.type.startsWith("message.")).length, 0);
  assert.equal(rows.activities.length, 0);

  const stranger = await thread([{ externalId: "k-3", direction: "in", body: "[no text]", sentAt: "2026-09-20T09:00:00.000Z" }], IVAN, "t-ivan-card");
  assert.equal(stranger.payload.added, false, "заради картки людину в CRM не додають");
  assert.equal(added().length, 0);
});

test("картки, що вже лежать у базі, не стають розмовами і не роблять непрочитаного", async () => {
  // Одна «розмова» з самих карток (як на проді) і одна справжня з карткою всередині.
  stored({ threadKey: "t-card-only", body: "[no text]", minutesAgo: 60 });
  stored({ threadKey: "t-card-only", body: "[no text]", direction: "out", minutesAgo: 59 });
  stored({ threadKey: "t-real", body: "Привіт! Цікаво.", participant: { name: "Ivan Petrov", slug: "ivan-petrov" }, minutesAgo: 20 });
  stored({ threadKey: "t-real", body: "[no text]", participant: { name: "Переглянути профіль Ivan", slug: "ivan-petrov" }, minutesAgo: 5 });

  const list = await call({ method: "GET", path: "/api/warmup/inbox" });
  assert.deepEqual(list.payload.threads.map((row) => row.threadKey), ["t-real"], "розмови з самих карток немає");
  const real = list.payload.threads[0];
  assert.equal(real.lastMessage.body, "Привіт! Цікаво.", "останнє сказане — слова, а не картка");
  assert.equal(real.messageCount, 1);
  assert.equal(real.participant.name, "Ivan Petrov", "ім'я не з картки");
  assert.equal(real.unread, true);
  assert.equal(list.payload.unread, 1, "непрочитаних рівно стільки, скільки живих розмов");

  const config = await call({ method: "GET", path: "/api/warmup/config" });
  assert.equal(config.payload.unreadReplies, 1, "число на пункті меню — теж без карток");

  const opened = await call({ method: "GET", path: "/api/warmup/inbox/thread?accountId=acc-1&threadKey=t-real" });
  assert.deepEqual(opened.payload.messages.map((m) => m.body), ["Привіт! Цікаво."]);
  const gone = await call({ method: "GET", path: "/api/warmup/inbox/thread?accountId=acc-1&threadKey=t-card-only" });
  assert.equal(gone.status, 404, "картка не відкривається як розмова");
});

test("аватарки, які старий агент зберіг як «[attachment]», теж не стають розмовами, а справжні файли лишаються", async () => {
  const sentence = { name: "Переглянути профіль Sinan", slug: "sinan-arslan-1" };
  // Дві розмови з самих аватарок (за фікстурою картки старий агент читав їх саме так)
  stored({ threadKey: "t-avatars", body: "[attachment]", participant: sentence, minutesAgo: 50 });
  stored({ threadKey: "t-avatars", body: "[attachment]", direction: "out", participant: sentence, minutesAgo: 49 });
  stored({ threadKey: "t-avatars-en", body: "[attachment]", participant: { name: "View Edgar’s profile", slug: "edgar-1" }, minutesAgo: 48 });
  // Справжній файл від людини, підписаної своїм ім'ям, і справжній текст
  stored({ threadKey: "t-file", body: "[attachment]", participant: { name: "Ivan Petrov", slug: "ivan-petrov" }, minutesAgo: 10 });

  const list = await call({ method: "GET", path: "/api/warmup/inbox" });
  assert.deepEqual(list.payload.threads.map((row) => row.threadKey), ["t-file"], "розмови лишилась лише з файлом від людини");
  assert.equal(list.payload.threads[0].lastMessage.body, "[attachment]");
  assert.equal(list.payload.unread, 1, "лічильник рахує лише справжню розмову");
  const config = await call({ method: "GET", path: "/api/warmup/config" });
  assert.equal(config.payload.unreadReplies, 1);
  const avatar = await call({ method: "GET", path: "/api/warmup/inbox/thread?accountId=acc-1&threadKey=t-avatars" });
  assert.equal(avatar.status, 404);

  // І в CRM такі рядки не йдуть: додається лише справжня людина, одним рядком.
  const finished = await done();
  assert.equal(finished.payload.crmAdded.waiting, 1);
  assert.equal(added().map((row) => row.name).join(), "Ivan Petrov");
  assert.equal(rows.activities.length, 1);
});

test("лише картка у відповідь не робить розмову непрочитаною", async () => {
  // Прочитана розмова, і після прочитання прийшла картка — це не нова відповідь.
  stored({ threadKey: "t-read", body: "Дякую!", participant: { name: "Ivan Petrov", slug: "ivan-petrov" }, minutesAgo: 120 });
  await call({ method: "POST", path: "/api/warmup/inbox/read", body: { accountId: "acc-1", threadKey: "t-read" } });
  // Збережена після того, як прочитали (хвилина «у майбутньому» відносно позначки).
  stored({ threadKey: "t-read", body: "[no text]", participant: { name: "Переглянути профіль Ivan", slug: "ivan-petrov" }, minutesAgo: -1 });
  const list = await call({ method: "GET", path: "/api/warmup/inbox" });
  assert.equal(list.payload.threads[0].unread, false);
  assert.equal(list.payload.unread, 0);
});

test("картки, що вже лежать у базі, не йдуть у CRM ні при додаванні людини, ні в історії контакту", async () => {
  stored({ threadKey: "t-ivan", body: "Привіт! Цікаво.", participant: IVAN, minutesAgo: 40 });
  stored({ threadKey: "t-ivan", body: "[no text]", participant: { name: "Переглянути профіль Ivan", slug: "ivan-petrov" }, minutesAgo: 39 });
  const finished = await done();
  assert.equal(finished.payload.crmAdded.added, 1);
  assert.equal(rows.activities.length, 1, "лише справжнє повідомлення");
  assert.doesNotMatch(rows.activities[0].content, /\[no text\]/);

  // І на картці контакту в самому застосунку.
  stored({ threadKey: "t-olena", body: "Дякую!", participant: { name: "Olena Bondar", slug: "olena-bondar" }, crmContactId: "c-9", minutesAgo: 30 });
  stored({ threadKey: "t-olena", body: "[no text]", participant: { name: "Olena Bondar", slug: "olena-bondar" }, crmContactId: "c-9", minutesAgo: 29 });
  const history = await call({ method: "GET", path: "/api/warmup/history?crmContactId=c-9" });
  const bodies = (history.payload.entries || []).filter((entry) => entry.kind === "message").map((entry) => entry.body);
  assert.deepEqual(bodies, ["Дякую!"]);
});
