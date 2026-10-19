import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { reconcilePings, setLeadgenStore, setManualPing, todayItem, todayList } from "../triage/today.mjs";
import { addWorkingDays, dayIn, taskMarks } from "../triage/pings.mjs";

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
    if (expression.startsWith("gte.") && !(String(value) >= expression.slice(4))) return false;
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
  assert.match(taskMarks(ping).key, /^reply:c1:/);
  assert.doesNotMatch(ping.description, /⟦ob:/, "опис у CRM — без службового рядка");

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

test("стара задача з ключем лише в описі: заміна й повторне відкриття переносять ключ у ping_key, дублів немає", async () => {
  await reconcilePings();
  const [reply] = openOf("c1");
  const key = reply.ping_key;
  // Так задачу записував код до 16.10: ключ — рядком в описі, колонки порожні.
  Object.assign(rows.tasks.find((row) => row.id === reply.id), { ping_key: null, ping_superseded: null, description: `${reply.description}\n⟦ob:${key}⟧` });

  const queued = outboxQueued("Sure — what GEO do you run?", 5);
  rows.wl_events.push(queued);
  await reconcilePings();
  const closed = rows.tasks.find((row) => row.id === reply.id);
  assert.equal(closed.completed, true);
  assert.equal(closed.ping_superseded, true);
  assert.equal(closed.ping_key, key, "ключ перейшов з опису в колонку");
  assert.doesNotMatch(closed.description, /⟦ob:/);

  rows.wl_events.push({ id: `x-${++nextId}`, account_id: "acc-1", type: "outbox.cancelled", created_at: ago(1), meta: { replyId: queued.id } });
  await reconcilePings();
  const open = openOf("c1");
  assert.deepEqual(open.map((row) => row.id), [reply.id], "відкрита знову та сама задача, нової не створено");
  assert.equal(open[0].ping_key, key);
  assert.equal(open[0].ping_superseded, false);
  await reconcilePings();
  assert.equal(openOf("c1").length, 1, "повторна звірка не дублює");
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

test("акаунт веде лідген → пінги його діалогів у нього, і вже відкриті переходять за позначкою", async () => {
  let leadgens = {};
  setLeadgenStore({ read: () => leadgens, write: async (value) => { leadgens = value; } });
  try {
    await reconcilePings();
    assert.equal(openOf("c1")[0].assigned_to, "u-bohdan", "без позначки — власник контакту");
    leadgens = { "acc-1": "u-leadgen" };
    await reconcilePings();
    assert.equal(openOf("c1")[0].assigned_to, "u-leadgen", "відкритий пінг перейшов за позначкою");
    rows.wl_events.push(outboxQueued("Sure", 1));
    await reconcilePings();
    assert.equal(openOf("c1")[0].assigned_to, "u-leadgen", "новий пінг — одразу лідгенові акаунта");
  } finally {
    setLeadgenStore({ read: () => ({}), write: async () => {} });
  }
});

import { acceptOpenDialogs, openDialogs } from "../triage/open-dialogs.mjs";

test("відкриті діалоги з 01.08: пропозиції → прийняти пачкою → 0 без пінга; повторне прийняття не дублює", async () => {
  rows.contacts.push({ id: "c9", name: "Old Lead", company: "OldBet", lead_status: "responded", owner_id: "u-stepan" });
  rows.activities = [
    { id: "a1", contact_id: "c9", created_at: "2026-09-10T10:00:00Z", direction: "outgoing", content: "LinkedIn · Ми написали з акаунта chloe · …\nHi" },
    { id: "a2", contact_id: "c9", created_at: "2026-09-11T10:00:00Z", direction: "outgoing", content: "LinkedIn · Відповідь на акаунт chloe · …\nInteresting, send details" }
  ];
  rows.contact_status_history = [];
  const before = await openDialogs({ today: dayIn(new Date()) });
  assert.deepEqual(before.items.map((item) => item.contactId), ["c9"]);
  assert.equal(before.items[0].reason, "reply");
  const items = before.items.map(({ contactId, reason, due, why }) => ({ contactId, reason, due, why }));
  assert.deepEqual(await acceptOpenDialogs({ items, assignee: "u-bohdan" }), { created: 1, skipped: 0 });
  const [ping] = openOf("c9");
  assert.equal(ping.title, "Відповісти: Old Lead");
  assert.equal(ping.assigned_to, "u-bohdan");
  assert.equal((await openDialogs({ today: dayIn(new Date()) })).items.length, 0, "жодного відкритого діалогу без пінга");
  assert.deepEqual(await acceptOpenDialogs({ items, assignee: "u-bohdan" }), { created: 0, skipped: 1 });
  assert.equal(tasksOf("c9").length, 1);
  const list = await todayList({ viewerId: "u-bohdan" });
  // У вихідний імпорт ставить пінг на найближчий робочий день — тоді він «Далі за планом» (тест падав у суботу 17.10).
  const imported = [...list.blocks.replies, ...list.later].find((item) => item.contactId === "c9");
  assert.ok(imported, "імпортована відповідь — у «Сьогодні»");
  assert.equal(imported.reason, "reply");
});

test("перенесене «Перше повідомлення» стає ручним пінгом: на свій день — «На сьогодні», після — «Прострочені», і стримує нові контакти", async () => {
  rows.wl_events = [];
  rows.contacts.find((row) => row.id === "c2").owner_id = "u-bohdan";
  rows.wl_outreach = [{ id: "o2", account_id: "acc-1", crm_contact_id: "c2", person_name: "Lead Two", status: "accepted", created_at: ago(3000) }];
  rows.wl_events.push({ id: `a-${++nextId}`, account_id: "acc-1", type: "invite.accepted", created_at: ago(120), meta: { outreachId: "o2", crmContactId: "c2" } });
  await reconcilePings();
  const [first] = openOf("c2");
  await setManualPing({ pingId: first.id, when: "+0", viewer: BOHDAN });
  await reconcilePings();
  assert.equal(openOf("c2").length, 1, "звірка не ставить другий пінг поряд з перенесеним");
  let list = await todayList({ viewerId: "u-bohdan" });
  assert.equal(list.blocks.today[0]?.contactId, "c2", "на свій день — «На сьогодні»");
  assert.equal(list.blocks.today[0].reasonTitle, "Перше повідомлення");
  rows.tasks.find((row) => row.id === first.id).due_date = ago(60 * 48);
  list = await todayList({ viewerId: "u-bohdan" });
  assert.equal(list.blocks.overdue[0]?.contactId, "c2", "після дати — «Прострочені»");
  assert.equal(list.newContactsAllowed, false, "прострочений пінг стримує нові контакти");
});

import { setLeadCampaignStore } from "../triage/lead-campaigns.mjs";

// Кампанія лідгена — за папкою CRM (WorkSpace, «варіант А», 16.10), не за автозапитами прогріву.
test("кампанія: нагадування за її кроками; після останнього кроку й тиші — статус CRM «Не відповідає»; лід відповів — гілка зупиняється", async () => {
  setLeadCampaignStore({ read: () => [{ id: "camp-1", name: "SiGMA", folderIds: ["f-1"], state: "active", silentSteps: [1] }], write: async () => {} });
  try {
    rows.contact_folder_memberships = [{ contact_id: "c1", folder_id: "f-1" }];
    rows.contacts.find((row) => row.id === "c1").lead_status = "in_progress";
    rows.wl_events = [
      message("out", "first", 60 * 24 * 6)
    ];
    await reconcilePings();
    const [ping] = openOf("c1");
    assert.equal(ping.title, "Нагадати: Lead One");
    assert.equal(dayIn(ping.due_date), addWorkingDays(dayIn(new Date(Date.now() - 6 * 86400000 - 60000)), 1), "крок кампанії — 1 робочий день");

    rows.wl_events.push(message("out", "follow-up", 60 * 24 * 5));
    await reconcilePings();
    assert.equal(openOf("c1").length, 0, "кроки скінчились — пінгу немає");
    assert.equal(rows.contacts.find((row) => row.id === "c1").lead_status, "no_response", "тиша після останнього кроку — «Не відповідає»");

    rows.contacts.find((row) => row.id === "c1").lead_status = "in_progress";
    rows.wl_events.push(message("in", "Sorry for the delay — tell me more", 10));
    await reconcilePings();
    assert.equal(openOf("c1")[0]?.title, "Відповісти: Lead One", "відповів — «Відповісти», нагадувань більше немає");
    assert.equal(rows.contacts.find((row) => row.id === "c1").lead_status, "responded", "лід відповів — статус CRM «Відповів» (Марко 17.10)");
    const list = await todayList({ viewerId: "u-bohdan" });
    assert.equal(list.blocks.replies[0]?.campaign?.name, "SiGMA", "у «Сьогодні» видно кампанію людини");
  } finally {
    setLeadCampaignStore({ read: () => [], write: async () => {} });
  }
});

test("перепризначений після бану: пінг лишається, на картці «перепризначено з X на Y», відповісти зі старого акаунта не пропонується", async () => {
  await reconcilePings();
  const [ping] = openOf("c1");
  rows.wl_accounts.push({ id: "acc-2", label: "Mary", login: "mary@example.com", status: "warming", health: "ok" });
  rows.wl_events.push({ id: `rs-${++nextId}`, account_id: "acc-2", type: "invite.reassigned", created_at: ago(1), meta: { reason: "account_blocked", crmContactId: "c1", fromAccountId: "acc-1", fromAccount: "chloe@example.com", toAccount: "mary@example.com", accountId: "acc-2" } });
  await reconcilePings();
  assert.deepEqual(openOf("c1").map((row) => row.id), [ping.id], "пінг той самий, не закритий і не задубльований");
  const detail = await todayItem({ pingId: ping.id, viewer: BOHDAN });
  assert.equal(detail.item.channel, "moved");
  assert.deepEqual(detail.item.reassigned && [detail.item.reassigned.from, detail.item.reassigned.to], ["chloe@example.com", "mary@example.com"]);
  assert.deepEqual(detail.messages.map((message) => message.body), ["Hi, tell me more"], "переписка лишається історією");
  assert.notEqual(detail.item.block, "replies", "відповісти зі старого акаунта нема куди — пінг за датою");
});

import { setContactStatus } from "../triage/today.mjs";

test("статус із «Сьогодні» — у CRM: вихід закриває пінги й ставить причину; «Дзвінок» — одна угода з міткою Outbound; пінг, закритий у CRM, зникає з «Сьогодні»", async () => {
  rows.deals = [];
  rows.deal_contacts = [];
  await reconcilePings();
  const [ping] = openOf("c1");
  assert.equal(ping.origin, "outbound", "пінг у CRM — з міткою джерела");

  const call = await setContactStatus({ contactId: "c1", status: "booked_call", viewer: BOHDAN });
  assert.equal(rows.contacts.find((row) => row.id === "c1").lead_status, "booked_call");
  assert.ok(call.dealId);
  assert.equal(rows.deals[0].origin, "outbound");
  assert.deepEqual(rows.deal_contacts.map((row) => row.contact_id), ["c1"]);
  await setContactStatus({ contactId: "c1", status: "booked_call", viewer: BOHDAN });
  assert.equal(rows.deals.length, 1, "друга угода не створюється");

  await assert.rejects(setContactStatus({ contactId: "c1", status: "not_interested", exitReason: "other", viewer: { id: "u-other", role: "seller" } }), /іншого лідгена/);
  const out = await setContactStatus({ contactId: "c1", status: "not_interested", exitReason: "traffic_only", viewer: BOHDAN });
  assert.equal(out.closedPings, 1);
  const contact = rows.contacts.find((row) => row.id === "c1");
  assert.deepEqual([contact.lead_status, contact.exit_reason], ["not_interested", "traffic_only"]);
  assert.equal(openOf("c1").length, 0);

  // Закрито в самій CRM — у «Сьогодні» зникає (Outbound читає задачі CRM наживо).
  rows.contacts.find((row) => row.id === "c1").lead_status = "in_progress";
  rows.wl_events.push(message("in", "Actually, let's talk", 1));
  await reconcilePings();
  const [fresh] = openOf("c1");
  assert.ok((await todayList({ viewerId: "u-bohdan" })).blocks.replies.some((item) => item.pingId === fresh.id));
  fresh.completed = true;
  assert.equal((await todayList({ viewerId: "u-bohdan" })).blocks.replies.some((item) => item.pingId === fresh.id), false);
});

test("звірка: лід відповів — «Новий» стає «Відповів» одним записом; «Дзвінок» лишається", async () => {
  rows.contacts.find((row) => row.id === "c1").lead_status = "new";
  rows.contacts.push({ id: "c3", name: "Lead Three", company: "Casino Three", owner_id: "u-bohdan", lead_status: "booked_call" });
  rows.wl_events.push(message("in", "Sounds good", 30, "c3", "t3"));
  await reconcilePings();
  assert.equal(rows.contacts.find((row) => row.id === "c1").lead_status, "responded");
  assert.equal(rows.contacts.find((row) => row.id === "c3").lead_status, "booked_call", "людський статус не чіпається");
  const statusBefore = rows.contacts.find((row) => row.id === "c1").lead_status;
  await reconcilePings();
  assert.equal(rows.contacts.find((row) => row.id === "c1").lead_status, statusBefore, "повторна звірка нічого не змінює");
});
