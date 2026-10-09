import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { forgetAdoptionFolder } from "../warmup/people.mjs";
import {
  EXPIRES_AFTER_MS, REPLIES_PER_SESSION, REPLY_LIMIT, WAITING_PER_ACCOUNT, cleanReply, deriveReplies, repliesPerDay, visibleReplies
} from "../warmup/outbox.mjs";
import { DEFAULT_STRATEGY } from "../warmup/strategy.mjs";

/**
 * Replies written on the Inbox screen, and what becomes of them.
 *
 * The portal owns no browser, so a reply is asked for here and sent by the
 * account in its own next session. These go through the routes the page and the
 * agent call, over a stub that plays both databases: what is refused and why,
 * what the agent is handed, and that nothing the agent is told is a yes after
 * the person took the reply back.
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
  delete process.env.INBOX_REPLIES_PER_DAY;
  forgetAdoptionFolder();
  rows.wl_accounts = [
    { id: "acc-1", label: "Chloe Stewart", login: "chloe@example.com", profile_remote_id: "profile-1", status: "warming", health: "ok" },
    { id: "acc-2", label: "Mary Lindsay", login: "mary@example.com", profile_remote_id: "profile-2", status: "warming", health: "ok" }
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
  rows.wl_outreach = [];
  rows.contacts = [];
  rows.contact_folders = [];
  rows.activities = [];
});

const IVAN = { name: "Ivan Petrov", slug: "ivan-petrov", headline: "Head of UA, Pixel Forge" };
const OURS = { externalId: "m-1", direction: "out", body: "Вітаю, Іване! Бачу, ви в Pixel Forge.", sentAt: "2026-09-20T09:00:00.000Z" };
const THEIRS = { externalId: "m-2", direction: "in", body: "Привіт! Розкажіть детальніше.", sentAt: "2026-09-20T11:30:00.000Z" };

const post = (body) => call({ method: "POST", path: "/api/warmup/agent", body });
const ask = (path, body) => call({ method: "POST", path: `/api/warmup/${path}`, body });
const store = (messages, participant = IVAN, threadKey = "t-ivan", accountId = "acc-1") =>
  post({ action: "inbox.thread", accountId, threadKey, participant, messages });
const reply = (text, overrides = {}) => ask("inbox/reply", { accountId: "acc-1", threadKey: "t-ivan", text, ...overrides });
const plan = async (accountId = "acc-1") =>
  (await call({ method: "GET", path: `/api/warmup/agent?accountId=${accountId}` })).payload;
const openThread = async (threadKey = "t-ivan", accountId = "acc-1") =>
  (await call({ method: "GET", path: `/api/warmup/inbox/thread?accountId=${accountId}&threadKey=${threadKey}` })).payload;
const events = (type) => rows.wl_events.filter((row) => row.type === type);

// ── Хто може відповісти і кому ────────────────────────────────────────────

test("відповісти можна тому, хто написав: відповідь стає в чергу акаунта, а не йде одразу", async () => {
  await store([OURS, THEIRS]);
  const answer = await reply("  Дякую за відповідь!  \n\n\n\nРозкажу детальніше.  ");
  assert.equal(answer.status, 201);
  assert.equal(answer.payload.success, true);
  assert.equal(answer.payload.reply.state, "waiting");
  assert.equal(answer.payload.reply.body, "Дякую за відповідь!\n\nРозкажу детальніше.", "кінцеві пробіли й зайві порожні рядки прибрано");
  assert.ok(answer.payload.goesOutAt, "сказано, коли вона піде");

  assert.equal(events("outbox.queued").length, 1);
  assert.equal(events("outbox.queued")[0].account_id, "acc-1");
  assert.equal(events("outbox.queued")[0].meta.threadKey, "t-ivan");
  // Ніщо не пішло в LinkedIn і не записане як сказане нами.
  assert.equal(events("message.out").length, 1, "повідомлень, окрім прочитаного агентом, не додалось");
});

test("тому, хто нічого не написав, відповісти не можна: це перше повідомлення, а не відповідь", async () => {
  await store([OURS]);
  const answer = await reply("Нагадую про себе");
  assert.equal(answer.status, 409);
  assert.match(answer.payload.error, /не відповідь/);
  assert.equal(events("outbox.queued").length, 0);
  assert.equal((await openThread()).reply.canWrite, false);
});

test("порожня й задовга відповіді відхиляються", async () => {
  await store([OURS, THEIRS]);
  assert.equal((await reply("   \n ")).status, 400);
  const long = await reply("а".repeat(REPLY_LIMIT + 1));
  assert.equal(long.status, 400);
  assert.match(long.payload.error, /задовга/);
  assert.equal((await reply("а".repeat(REPLY_LIMIT))).status, 201, "рівно по межі — можна");
});

test("тред, якого нема, і акаунт, якого нема, дають 404; акаунт чужого треду теж", async () => {
  await store([OURS, THEIRS]);
  assert.equal((await reply("Так", { threadKey: "t-none" })).status, 404);
  assert.equal((await reply("Так", { accountId: "acc-none" })).status, 404);
  assert.equal((await reply("Так", { accountId: "acc-2" })).status, 404, "тред лежить на іншому акаунті");
  assert.equal((await ask("inbox/reply", { accountId: "acc-1", text: "Так" })).status, 400);
});

test("акаунт, який агент не відкриє, відповіді не приймає — і каже чому", async () => {
  await store([OURS, THEIRS]);

  rows.wl_runs = [];
  let answer = await reply("Так");
  assert.equal(answer.status, 409);
  assert.match(answer.payload.error, /не запущено прогрів/);
  assert.equal((await openThread()).reply.canWrite, false);

  rows.wl_runs = [{ id: "run-p", account_id: "acc-1", state: "running", started_at: new Date(Date.now() - 5 * 864e5).toISOString(),
    paused_days: 0, paused_until: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), strategy_snapshot: DEFAULT_STRATEGY }];
  answer = await reply("Так");
  assert.equal(answer.status, 409);
  assert.match(answer.payload.error, /на паузі/);

  rows.wl_runs = [{ id: "run-ok", account_id: "acc-1", state: "running", started_at: new Date(Date.now() - 5 * 864e5).toISOString(),
    paused_days: 0, paused_until: null, strategy_snapshot: DEFAULT_STRATEGY }];
  rows.wl_accounts[0].health = "warning";
  assert.equal((await reply("Так")).status, 409);
  rows.wl_accounts[0].health = "ok";
  rows.wl_accounts[0].status = "excluded";
  assert.equal((await reply("Так")).status, 409);
  assert.equal(events("outbox.queued").length, 0, "жодна не потрапила в чергу");
});

// ── Скільки і як часто ────────────────────────────────────────────────────

test("та сама відповідь у той самий тред, поки перша чекає, — це вона сама, а не друга", async () => {
  await store([OURS, THEIRS]);
  const first = await reply("Так, звісно");
  const again = await reply("так,   звісно");
  assert.equal(again.status, 200);
  assert.equal(again.payload.duplicate, true);
  assert.equal(again.payload.reply.id, first.payload.reply.id);
  assert.equal(events("outbox.queued").length, 1, "подвійний клік не ставить у чергу двічі");
});

test("з одного акаунта в черзі не більше кількох: далі — відмова з поясненням", async () => {
  await store([OURS, THEIRS]);
  for (let at = 0; at < WAITING_PER_ACCOUNT; at += 1) assert.equal((await reply(`Відповідь ${at}`)).status, 201);
  const over = await reply("Ще одна");
  assert.equal(over.status, 429);
  assert.match(over.payload.error, /вже чекає/);
  assert.equal(events("outbox.queued").length, WAITING_PER_ACCOUNT);
  // Інший акаунт від цього не страждає.
  await store([OURS, THEIRS], IVAN, "t-other", "acc-2");
  assert.equal((await reply("Так", { accountId: "acc-2", threadKey: "t-other" })).status, 201);
});

test("денний ліміт рахує й надіслані, і ті, що чекають; його можна змінити налаштуванням", async () => {
  process.env.INBOX_REPLIES_PER_DAY = "2";
  assert.equal(repliesPerDay(), 2);
  await store([OURS, THEIRS]);
  const one = await reply("Перша");
  await reply("Друга");
  const third = await reply("Третя");
  assert.equal(third.status, 429);
  assert.match(third.payload.error, /Ліміт на добу — 2/);

  // Скасована звільняє місце: її ніхто не надсилав.
  await ask("inbox/reply/cancel", { accountId: "acc-1", replyId: one.payload.reply.id });
  assert.equal((await reply("Третя")).status, 201);
});

test("межа з налаштування, що не є числом, не діє: лишається 10", () => {
  for (const value of ["0", "-3", "abc", "1.5", "99", ""]) assert.equal(repliesPerDay({ INBOX_REPLIES_PER_DAY: value }), 10, value);
  assert.equal(repliesPerDay({ INBOX_REPLIES_PER_DAY: "25" }), 25);
});

// ── Що бачить розмова ─────────────────────────────────────────────────────

test("розмова показує, що відповідь чекає, коли вона піде і що відповісти можна", async () => {
  await store([OURS, THEIRS]);
  await reply("Так, цікаво");
  const opened = await openThread();
  assert.equal(opened.outbox.length, 1);
  assert.equal(opened.outbox[0].state, "waiting");
  assert.equal(opened.outbox[0].body, "Так, цікаво");
  assert.equal(opened.reply.canWrite, true);
  assert.equal(opened.reply.limit, REPLY_LIMIT);
  assert.ok(opened.reply.goesOutAt);
  assert.match(opened.reply.window, /^\d\d:00–\d\d:00$/);
  assert.equal(opened.reply.perDay, 10);
});

test("чужі відповіді в чужих тредах не потрапляють у цю розмову", async () => {
  await store([OURS, THEIRS]);
  await store([{ ...OURS, externalId: "o-1" }, { ...THEIRS, externalId: "o-2" }], { name: "Olena", slug: "olena" }, "t-olena");
  await reply("Іванові");
  await reply("Олені", { threadKey: "t-olena" });
  assert.deepEqual((await openThread()).outbox.map((row) => row.body), ["Іванові"]);
  assert.deepEqual((await openThread("t-olena")).outbox.map((row) => row.body), ["Олені"]);
});

test("скасована відповідь зникає з розмови, а надіслану скасувати не можна", async () => {
  await store([OURS, THEIRS]);
  const made = (await reply("Скасую")).payload.reply;
  assert.equal((await ask("inbox/reply/cancel", { accountId: "acc-1", replyId: made.id })).status, 200);
  assert.deepEqual((await openThread()).outbox, []);

  const sent = (await reply("Піде")).payload.reply;
  await post({ action: "outbox.sent", accountId: "acc-1", replyId: sent.id });
  const refused = await ask("inbox/reply/cancel", { accountId: "acc-1", replyId: sent.id });
  assert.equal(refused.status, 409);
  assert.match(refused.payload.error, /уже надіслана/);
  assert.equal((await ask("inbox/reply/cancel", { accountId: "acc-1", replyId: "nope" })).status, 404);
  assert.equal((await ask("inbox/reply/cancel", { accountId: "acc-2", replyId: sent.id })).status, 404, "чужого акаунта — теж нема");
});

test("тексти відповідей не потрапляють в журнал подій, а відмови потрапляють", async () => {
  await store([OURS, THEIRS]);
  const made = (await reply("Приватне")).payload.reply;
  await post({ action: "outbox.failed", accountId: "acc-1", replyId: made.id, reason: "поле не знайшлось" });
  const audit = await call({ method: "GET", path: "/api/warmup/events?limit=50" });
  const text = JSON.stringify(audit.payload);
  assert.doesNotMatch(text, /Приватне/);
  assert.match(text, /outbox\.failed/);
});

// ── Що отримує агент ──────────────────────────────────────────────────────

test("агент отримує в плані відповіді своєї сесії: найстаріші, по кілька, з текстом", async () => {
  await store([OURS, THEIRS]);
  for (let at = 0; at < 5; at += 1) await reply(`Відповідь ${at}`);
  const work = (await plan()).outbox;
  assert.equal(work.toSend.length, REPLIES_PER_SESSION);
  assert.deepEqual(work.toSend.map((row) => row.text), ["Відповідь 0", "Відповідь 1", "Відповідь 2"]);
  assert.equal(work.toSend[0].threadKey, "t-ivan");
  assert.equal(work.toSend[0].name, "Ivan Petrov");
  assert.equal(work.waiting, 5);
  // Чужому акаунту — нічого.
  assert.deepEqual((await plan("acc-2")).outbox.toSend, []);
});

test("на паузі, без прогріву чи з проблемним здоров'ям агентові нічого не віддають", async () => {
  await store([OURS, THEIRS]);
  await reply("Так");
  assert.equal((await plan()).outbox.toSend.length, 1);

  rows.wl_accounts[0].health = "warning";
  assert.deepEqual((await plan()).outbox.toSend, []);
  rows.wl_accounts[0].health = "ok";
  rows.wl_runs[0].paused_until = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  assert.deepEqual((await plan()).outbox.toSend, []);
  rows.wl_runs[0].paused_until = null;
  assert.equal((await plan()).outbox.toSend.length, 1);
});

test("відповідь, якій минуло три доби, не надсилається: розмова пішла далі", async () => {
  await store([OURS, THEIRS]);
  const made = (await reply("Запізно")).payload.reply;
  const old = new Date(Date.now() - EXPIRES_AFTER_MS - 60_000).toISOString();
  rows.wl_events.find((row) => row.type === "outbox.queued").created_at = old;
  assert.deepEqual((await plan()).outbox.toSend, []);
  const shown = (await openThread()).outbox;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].state, "expired");
  assert.equal(shown[0].id, made.id);
  const prepared = await post({ action: "outbox.prepare", accountId: "acc-1", replyId: made.id });
  assert.equal(prepared.payload.allowed, false);
  assert.equal(prepared.payload.reply, null, "тексту відмовленому не віддають");
});

test("перед набором агент питає ще раз: скасована за цей час відповідь більше не «так»", async () => {
  await store([OURS, THEIRS]);
  const made = (await reply("Передумав")).payload.reply;
  const taken = (await plan()).outbox.toSend;
  assert.equal(taken.length, 1, "у плані вона була");

  await ask("inbox/reply/cancel", { accountId: "acc-1", replyId: made.id });
  const prepared = await post({ action: "outbox.prepare", accountId: "acc-1", replyId: made.id });
  assert.equal(prepared.payload.allowed, false);
  assert.equal(prepared.payload.reason, "cancelled");
  assert.equal(prepared.payload.reply, null);
});

test("«так» перед набором дає текст; пауза посеред сесії — «ні» і «зупинись»", async () => {
  await store([OURS, THEIRS]);
  const made = (await reply("Піде")).payload.reply;
  const yes = await post({ action: "outbox.prepare", accountId: "acc-1", replyId: made.id });
  assert.equal(yes.payload.allowed, true);
  assert.equal(yes.payload.reply.text, "Піде");
  assert.equal(yes.payload.reply.threadKey, "t-ivan");
  assert.equal(yes.payload.stopAll, false);

  rows.wl_runs[0].paused_until = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const stopped = await post({ action: "outbox.prepare", accountId: "acc-1", replyId: made.id });
  assert.equal(stopped.payload.allowed, false);
  assert.equal(stopped.payload.stopAll, true);
  assert.equal(stopped.payload.reply, null);
  // Відповідь чужого акаунта — невідома.
  rows.wl_runs[0].paused_until = null;
  const foreign = await post({ action: "outbox.prepare", accountId: "acc-2", replyId: made.id });
  assert.equal(foreign.payload.allowed, false);
  assert.equal(foreign.payload.reason, "unknown");
});

test("денний ліміт діє й на агента: вичерпаний — «ні», навіть для тієї, що чекає", async () => {
  process.env.INBOX_REPLIES_PER_DAY = "2";
  await store([OURS, THEIRS]);
  const ids = [];
  for (const text of ["Один", "Два"]) ids.push((await reply(text)).payload.reply.id);
  for (const id of ids) await post({ action: "outbox.sent", accountId: "acc-1", replyId: id });
  // Місця для нових немає, тож дозволити «ще одну» нема чого: перевіряємо через ручний рядок.
  rows.wl_events.push({ id: "q-extra", account_id: "acc-1", type: "outbox.queued", created_at: new Date().toISOString(),
    meta: { threadKey: "t-ivan", body: "Зайва" } });
  const prepared = await post({ action: "outbox.prepare", accountId: "acc-1", replyId: "q-extra" });
  assert.equal(prepared.payload.allowed, false);
  assert.equal(prepared.payload.reason, "limit");
  assert.deepEqual((await plan()).outbox.toSend, []);
});

// ── Що агент повідомляє після ─────────────────────────────────────────────

test("надіслана відповідь перестає чекати, лишається в розмові, поки справжнє повідомлення не прочитане, і потім зникає", async () => {
  await store([OURS, THEIRS]);
  const made = (await reply("Дякую, Іване!")).payload.reply;
  assert.equal((await post({ action: "outbox.sent", accountId: "acc-1", replyId: made.id })).status, 200);

  assert.deepEqual((await plan()).outbox.toSend, [], "вдруге не віддається");
  let shown = (await openThread()).outbox;
  assert.equal(shown.length, 1, "поки агент не перечитав розмову, відповідь не зникає");
  assert.equal(shown[0].state, "sent");

  // Агент перечитав розмову після надсилання: повідомлення тепер справжнє.
  await store([OURS, THEIRS, { externalId: "m-3", direction: "out", body: "Дякую,  Іване!", sentAt: new Date().toISOString() }]);
  shown = (await openThread()).outbox;
  assert.deepEqual(shown, [], "справжнє повідомлення замінило її");
});

test("повтор «надіслано» нічого не псує, а відмова не перекреслює надісланого", async () => {
  await store([OURS, THEIRS]);
  const made = (await reply("Раз")).payload.reply;
  await post({ action: "outbox.sent", accountId: "acc-1", replyId: made.id });
  const again = await post({ action: "outbox.sent", accountId: "acc-1", replyId: made.id });
  assert.equal(again.payload.repeated, true);
  const failed = await post({ action: "outbox.failed", accountId: "acc-1", replyId: made.id, reason: "запізно" });
  assert.equal(failed.payload.repeated, true);
  assert.equal(events("outbox.sent").length, 1);
  assert.equal(events("outbox.failed").length, 0, "що пішло, те пішло");
  assert.equal((await post({ action: "outbox.sent", accountId: "acc-1", replyId: "nope" })).status, 404);
  assert.equal((await post({ action: "outbox.sent", accountId: "acc-1" })).status, 400);
});

test("невдала відповідь лишається на розмові з причиною, не йде вдруге і прибирається кнопкою", async () => {
  await store([OURS, THEIRS]);
  const made = (await reply("Не вийшло")).payload.reply;
  await post({ action: "outbox.failed", accountId: "acc-1", replyId: made.id, reason: "не дочекався, поки повідомлення з'явиться в розмові" });
  const shown = (await openThread()).outbox;
  assert.equal(shown[0].state, "failed");
  assert.match(shown[0].reason, /не дочекався/);
  assert.deepEqual((await plan()).outbox.toSend, [], "агент не повторює сам: не відомо, чи пішло");

  await ask("inbox/reply/cancel", { accountId: "acc-1", replyId: made.id });
  assert.deepEqual((await openThread()).outbox, []);
});

// ── Чисті функції ─────────────────────────────────────────────────────────

test("cleanReply і visibleReplies: пробіли, перенесення рядків і що ще показується", () => {
  assert.equal(cleanReply("a  \r\nb\r\n\r\n\r\n\r\nc  "), "a\nb\n\nc");
  const now = Date.parse("2026-10-10T12:00:00Z");
  const base = { accountId: "a", threadKey: "t", participantName: null, queuedAt: "2026-10-10T08:00:00.000Z", reason: null };
  const replies = [
    { ...base, id: "1", body: "чекає", state: "waiting", at: null },
    { ...base, id: "2", body: "стара невдача", state: "failed", at: "2026-10-07T08:00:00.000Z" },
    { ...base, id: "3", body: "скасована", state: "cancelled", at: "2026-10-10T09:00:00.000Z" },
    { ...base, id: "4", body: "надіслана", state: "sent", at: "2026-10-10T09:00:00.000Z" }
  ];
  assert.deepEqual(visibleReplies(replies, [], { nowMs: now }).map((row) => row.id), ["1", "4"]);
  assert.deepEqual(
    visibleReplies(replies, [{ direction: "out", body: "Надіслана", sentAt: "2026-10-10T09:01:00.000Z" }], { nowMs: now }).map((row) => row.id),
    ["1"], "справжнє повідомлення з тим самим текстом замінює надіслану");
  assert.deepEqual(
    visibleReplies(replies, [{ direction: "in", body: "надіслана", sentAt: "2026-10-10T09:01:00.000Z" }], { nowMs: now }).map((row) => row.id),
    ["1", "4"], "а таке саме слово від них — не вона");
  assert.deepEqual(
    visibleReplies(replies, [{ direction: "out", body: "надіслана", sentAt: "2026-09-01T09:01:00.000Z" }], { nowMs: now }).map((row) => row.id),
    ["1", "4"], "і давнє повідомлення з тими ж словами — не вона");
});

test("новіший вердикт переважує давніший", () => {
  const rowsIn = [
    { id: "q", type: "outbox.queued", account_id: "a", created_at: "2026-10-10T08:00:00.000Z", meta: { threadKey: "t", body: "x" } },
    { id: "v1", type: "outbox.failed", account_id: "a", created_at: "2026-10-10T09:00:00.000Z", meta: { replyId: "q", reason: "r" } },
    { id: "v2", type: "outbox.cancelled", account_id: "a", created_at: "2026-10-10T10:00:00.000Z", meta: { replyId: "q" } }
  ];
  assert.equal(deriveReplies(rowsIn, { nowMs: Date.parse("2026-10-10T11:00:00Z") })[0].state, "cancelled");
});
