import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { reconcilePings, setManualPing, todayItem, todayList } from "../triage/today.mjs";
import { addWorkingDays, dayIn, parseTaskMarks } from "../triage/pings.mjs";

// «Сьогодні» і пінги в CRM (етап 1/6, таск 5f5343cb) — через звірку, на заглушці,
// що грає обидві бази: прогрів (wl_*) і CRM (contacts, tasks, profiles).

const rows = {};
let stub;
let previousEnv;
let nextId = 0;

function columnValue(row, column) {
  if (!column.includes("->>")) return row[column];
  const [outer, key] = column.split("->>");
  const value = row[outer]?.[key];
  return value === null || value === undefined ? value : String(value);
}

function listValues(list) {
  return list.replace(/^\(|\)$/g, "").split(",").map((value) => value.replace(/^"|"$/g, ""));
}

function matches(row, params) {
  for (const [column, expression] of params.entries()) {
    if (["select", "limit", "offset", "order"].includes(column)) continue;
    const value = columnValue(row, column);
    if (expression.startsWith("eq.") && String(value) !== expression.slice(3)) return false;
    if (expression.startsWith("in.(") && !listValues(expression.slice(3)).includes(String(value))) return false;
  }
  return true;
}

function ordered(found, params) {
  const [column, direction] = (params.get("order") || "").split(".");
  const sorted = column ? found.slice().sort((a, b) => String(a[column] ?? "").localeCompare(String(b[column] ?? "")) * (direction === "desc" ? -1 : 1)) : found;
  return sorted.slice(0, params.has("limit") ? Number(params.get("limit")) : Infinity);
}

test.before(async () => {
  stub = createServer((request, response) => {
    const [route, query] = request.url.split("?");
    const table = route.replace("/rest/v1/", "");
    const params = new URLSearchParams(query || "");
    const found = (rows[table] ?? []).filter((row) => matches(row, params));
    const answer = (payload, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET") return answer(ordered(found, params));
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
  previousEnv = { ...process.env };
  const address = `http://127.0.0.1:${stub.address().port}`;
  Object.assign(process.env, {
    ANTY_SUPABASE_URL: address, ANTY_SERVICE_ROLE_KEY: "stub", WARMUP_CRM_SUPABASE_URL: address, WARMUP_CRM_SERVICE_ROLE_KEY: "stub"
  });
});

test.after(async () => {
  for (const name of ["ANTY_SUPABASE_URL", "ANTY_SERVICE_ROLE_KEY", "WARMUP_CRM_SUPABASE_URL", "WARMUP_CRM_SERVICE_ROLE_KEY"]) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  await new Promise((resolve) => stub.close(resolve));
});

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const BOHDAN = { id: "u-bohdan", role: "seller" };

function message(direction, body, minutesAgo, contactId = "c1", threadKey = "t1") {
  return {
    id: `m-${++nextId}`, account_id: "acc-1", type: direction === "in" ? "message.in" : "message.out", created_at: ago(minutesAgo),
    meta: { threadKey, crmContactId: contactId, body, sentAt: ago(minutesAgo + 1), participant: { name: "Lead One", slug: "lead-one" } }
  };
}

const outboxQueued = (body, minutesAgo) => ({
  id: `q-${++nextId}`, account_id: "acc-1", type: "outbox.queued", created_at: ago(minutesAgo), meta: { threadKey: "t1", body, participantName: "Lead One" }
});

const tasksOf = (contactId) => (rows.tasks || []).filter((row) => row.contact_id === contactId);
const openOf = (contactId) => tasksOf(contactId).filter((row) => !row.completed);

test.beforeEach(() => {
  for (const table of Object.keys(rows)) delete rows[table];
  rows.wl_accounts = [{ id: "acc-1", label: "Chloe Stewart", login: "chloe@example.com", status: "warming", health: "ok" }];
  rows.wl_events = [message("in", "Hi, tell me more", 60)];
  rows.wl_outreach = [];
  rows.contacts = [
    { id: "c1", name: "Lead One", position: "Head of UA", company: "Casino One", owner_id: "u-bohdan" },
    { id: "c2", name: "Lead Two", position: "CMO", company: "Casino Two", owner_id: null }
  ];
  rows.profiles = [{ id: "u-bohdan", email: "bohdan@example.com", role: "user" }, { id: "u-admin", email: "admin@example.com", role: "admin" }];
  rows.tasks = [];
});

test("лід відповів → у CRM задача «Відповісти» на власника контакту, і він першим у «Відповідях»", async () => {
  await reconcilePings();
  const [ping] = openOf("c1");
  assert.ok(ping, "задача створена");
  assert.equal(ping.queue, "Outbound");
  assert.equal(ping.assigned_to, "u-bohdan");
  assert.equal(ping.title, "Відповісти: Lead One");
  assert.equal(dayIn(ping.due_date), dayIn(new Date()));
  assert.match(parseTaskMarks(ping.description).key, /^reply:c1:/);

  const list = await todayList({ viewerId: "u-bohdan" });
  assert.equal(list.blocks.replies[0]?.contactId, "c1");
  assert.equal(list.blocks.replies[0].accountName, "chloe@example.com");
  assert.equal(list.newContactsAllowed, false, "поки є відповіді — нових контактів немає");

  const detail = await todayItem({ pingId: ping.id, viewer: BOHDAN });
  assert.deepEqual(detail.messages.map((entry) => entry.body), ["Hi, tell me more"]);

  await reconcilePings();
  assert.equal(tasksOf("c1").length, 1, "повторна звірка не дублює задачу");
});

test("відповідь поставлена в чергу → пінг закрито, новий «Нагадати» на +3 робочі дні; скасували → «Відповісти» повертається", async () => {
  await reconcilePings();
  const [reply] = openOf("c1");

  const queued = outboxQueued("Sure — what GEO do you run?", 5);
  rows.wl_events.push(queued);
  await reconcilePings();
  assert.equal(rows.tasks.find((row) => row.id === reply.id).completed, true, "пінг відповіді закрито");
  const [silent] = openOf("c1");
  assert.equal(silent.title, "Нагадати: Lead One");
  assert.equal(dayIn(silent.due_date), addWorkingDays(dayIn(new Date()), 3));
  const list = await todayList({ viewerId: "u-bohdan" });
  assert.equal(list.blocks.replies.length, 0);
  assert.equal(list.later[0]?.contactId, "c1", "наступний пінг — далі за планом");

  rows.wl_events.push({ id: `x-${++nextId}`, account_id: "acc-1", type: "outbox.cancelled", created_at: ago(1), meta: { replyId: queued.id } });
  await reconcilePings();
  const open = openOf("c1");
  assert.deepEqual(open.map((row) => row.id), [reply.id], "та сама задача «Відповісти» відкрита знову, «Нагадати» закрито");
});

test("людина перенесла пінг на завтра — звірка дату не чіпає; чужий лідген перенести не може", async () => {
  await reconcilePings();
  const [ping] = openOf("c1");
  await assert.rejects(setManualPing({ pingId: ping.id, when: "+1", viewer: { id: "u-other", role: "seller" } }), /іншого лідгена/);
  const result = await setManualPing({ pingId: ping.id, when: "+1", viewer: BOHDAN });
  await reconcilePings();
  assert.equal(dayIn(rows.tasks.find((row) => row.id === ping.id).due_date), result.dueDay);
  assert.equal(openOf("c1").length, 1);
  const list = await todayList({ viewerId: "u-bohdan" });
  assert.equal(list.blocks.replies.length, 0, "перенесена відповідь — на свій день");
  assert.equal(list.newContactsAllowed, true, "відповідей і прострочених немає — нові контакти можна");
});

test("прийняв запит і ми мовчимо → «Перше повідомлення»; контакт без власника — на того, хто веде більшість", async () => {
  rows.wl_outreach = [{ id: "o2", account_id: "acc-1", crm_contact_id: "c2", person_name: "Lead Two", status: "accepted", created_at: ago(3000) }];
  rows.wl_events.push({ id: `a-${++nextId}`, account_id: "acc-1", type: "invite.accepted", created_at: ago(120), meta: { outreachId: "o2", crmContactId: "c2" } });
  await reconcilePings();
  const [first] = openOf("c2");
  assert.equal(first.title, "Перше повідомлення: Lead Two");
  assert.equal(first.assigned_to, "u-bohdan");
  const list = await todayList({ viewerId: "u-bohdan" });
  assert.equal(list.blocks.first[0]?.contactId, "c2");
});

test("три наших повідомлення поспіль без відповіді → пінг закрито, нового немає", async () => {
  rows.wl_events = [message("in", "ok", 600), message("out", "one", 500), message("out", "two", 400)];
  await reconcilePings();
  assert.equal(openOf("c1")[0]?.title, "Нагадати: Lead One");
  rows.wl_events.push(message("out", "three", 300));
  await reconcilePings();
  assert.equal(openOf("c1").length, 0);
});

test("адміністратор бачить усі пінги, продавець — свої", async () => {
  await reconcilePings();
  assert.equal((await todayList({ viewerId: "u-admin" })).blocks.replies.length, 0);
  assert.equal((await todayList({ viewerId: "u-admin", scope: "all" })).blocks.replies.length, 1);
});
