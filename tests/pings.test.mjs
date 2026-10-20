import assert from "node:assert/strict";
import test from "node:test";

import {
  SILENT_LIMIT, addWorkingDays, blockOf, dayIn, desiredPing, manualDueDay, markSuperseded, newContactsAllowed,
  parseTaskMarks, planPingChanges, stripMarks, taskDescription, taskMarks, zonedIso
} from "../triage/pings.mjs";

// Пінги (етап 1/6, таск 5f5343cb): правила без баз — що є наступним кроком
// діалогу і як задачі CRM до нього вирівнюються.

const NOW = new Date("2026-10-16T12:00:00Z"); // п'ятниця

const thread = (over = {}) => ({
  accountId: "acc-1", threadKey: "t1", trailingOut: 0, trailingOutBodies: [],
  lastStoredAt: "2026-10-16T08:00:00Z", lastInboundStoredAt: "2026-10-16T08:00:00Z",
  lastMessage: { direction: "in", at: "2026-10-16T07:59:00Z" }, ...over
});

const task = (over = {}) => ({ id: over.id || "task-1", completed: false, created_at: "2026-10-16T08:01:00Z", description: "", ...over });

test("дні — у поясі команди, робочі дні пропускають вихідні, задача — на 09:00 за Києвом", () => {
  assert.equal(dayIn("2026-10-16T22:30:00Z"), "2026-10-17", "о 01:30 за Києвом уже наступний день");
  assert.equal(addWorkingDays("2026-10-16", 3), "2026-10-21", "з п'ятниці +3 робочі — середа");
  assert.equal(addWorkingDays("2026-10-13", 3), "2026-10-16");
  assert.equal(zonedIso("2026-10-21"), "2026-10-21T06:00:00.000Z", "жовтень — літній час, UTC+3");
  assert.equal(zonedIso("2026-11-03"), "2026-11-03T07:00:00.000Z", "листопад — зимовий, UTC+2");
});

test("лід відповів, ми ні → «Відповісти» на день його відповіді", () => {
  const next = desiredPing("c1", { threads: [thread()] }, { now: NOW });
  assert.equal(next.reason, "reply");
  assert.equal(next.key, "reply:c1:2026-10-16T08:00:00Z");
  assert.equal(next.due, "2026-10-16");
});

test("ми відповіли (у черзі) → «Нагадати» через 3 робочі дні, і ключ той самий, коли повідомлення з'явиться в треді", () => {
  const queued = desiredPing("c1", { threads: [thread()], pending: [{ threadKey: "t1", queuedAt: "2026-10-16T09:00:00Z" }] }, { now: NOW });
  assert.equal(queued.reason, "silent");
  assert.equal(queued.due, "2026-10-21");
  const synced = desiredPing("c1", {
    threads: [thread({ trailingOut: 1, lastStoredAt: "2026-10-16T09:20:00Z", lastMessage: { direction: "out", at: "2026-10-16T09:05:00Z" } })]
  }, { now: NOW });
  assert.equal(synced.key, queued.key, "черга → тред не плодить нову задачу");
});

test("п'ять наших повідомлень поспіль без відповіді → пінгу більше немає", () => {
  assert.equal(SILENT_LIMIT, 5, "власник 20.10: «перевели на 5 пінгів»");
  const next = desiredPing("c1", {
    threads: [thread({ trailingOut: SILENT_LIMIT, lastStoredAt: "2026-10-15T09:00:00Z", lastMessage: { direction: "out", at: "2026-10-15T09:00:00Z" } })]
  }, { now: NOW });
  assert.equal(next.key, null);
});

test("прийняв запит і мовчимо → «Перше повідомлення»; «Пропустити» → нічого; перше в черзі → «Нагадати»", () => {
  const accepted = { outreachId: "o1", accountId: "acc-1", acceptedAt: "2026-10-15T10:00:00Z", dismissed: false };
  const first = desiredPing("c1", { accepted }, { now: NOW });
  assert.equal(first.reason, "first");
  assert.equal(first.due, "2026-10-15");
  assert.equal(desiredPing("c1", { accepted: { ...accepted, dismissed: true } }, { now: NOW }), null);
  const queued = desiredPing("c1", { accepted, pending: [{ threadKey: "first:o1", queuedAt: "2026-10-16T09:00:00Z" }] }, { now: NOW });
  assert.equal(queued.reason, "silent");
  assert.equal(queued.key, "silent:c1:none:1");
});

test("давніше за 14 днів — не цей етап (імпорт етапу 2), задачі не чіпаємо", () => {
  const old = desiredPing("c1", { threads: [thread({ lastStoredAt: "2026-09-20T08:00:00Z", lastInboundStoredAt: "2026-09-20T08:00:00Z" })] }, { now: NOW });
  assert.equal(old, null);
  assert.deepEqual(planPingChanges(old, [task()]), []);
});

test("план: немає задачі → створити; є відкрита з тим самим ключем → нічого", () => {
  const next = desiredPing("c1", { threads: [thread()] }, { now: NOW });
  assert.deepEqual(planPingChanges(next, []).map((action) => action.op), ["create"]);
  assert.deepEqual(planPingChanges(next, [task({ ping_key: next.key })]), [], "дата, перенесена людиною, лишається");
});

test("план: нова подія закриває стару системну задачу як «замінену» і ставить нову", () => {
  const replyKey = "reply:c1:2026-10-16T08:00:00Z";
  const silent = desiredPing("c1", { threads: [thread()], pending: [{ threadKey: "t1", queuedAt: "2026-10-16T09:00:00Z" }] }, { now: NOW });
  const actions = planPingChanges(silent, [task({ ping_key: replyKey })]);
  assert.deepEqual(actions.map((action) => action.op), ["supersede", "create"]);
});

test("план: скасоване повідомлення повертає попередній крок — його «замінена» задача відкривається, а не губиться", () => {
  const replyKey = "reply:c1:2026-10-16T08:00:00Z";
  const reply = desiredPing("c1", { threads: [thread()] }, { now: NOW });
  const tasks = [
    task({ id: "old", completed: true, ping_key: replyKey, ping_superseded: true }),
    task({ id: "silent", created_at: "2026-10-16T09:01:00Z", ping_key: "silent:c1:2026-10-16T08:00:00Z:1" })
  ];
  assert.deepEqual(planPingChanges(reply, tasks).map((action) => [action.op, action.task?.id]), [["supersede", "silent"], ["reopen", "old"]]);
});

test("план: задачу, яку людина закрила сама, система не відкриває", () => {
  const reply = desiredPing("c1", { threads: [thread()] }, { now: NOW });
  assert.deepEqual(planPingChanges(reply, [task({ completed: true, ping_key: reply.key })]), []);
});

test("план: ручний пінг після події — і є наступний крок; новіша подія його замінює", () => {
  const reply = desiredPing("c1", { threads: [thread()] }, { now: NOW });
  const manual = task({ id: "m", created_at: "2026-10-16T10:00:00Z", ping_key: "manual:2026-10-16T10:00:00Z" });
  assert.deepEqual(planPingChanges(reply, [manual]), [], "поставлений після відповіді — лишається, нової задачі немає");
  const later = desiredPing("c1", { threads: [thread({ lastStoredAt: "2026-10-16T11:00:00Z", lastInboundStoredAt: "2026-10-16T11:00:00Z" })] }, { now: NOW });
  assert.deepEqual(planPingChanges(later, [manual]).map((action) => action.op), ["supersede", "create"]);
});

test("план: пінгу бути не повинно → системні задачі закриваються", () => {
  const stop = { key: null, basisAt: "2026-10-16T09:00:00Z" };
  assert.deepEqual(planPingChanges(stop, [task({ ping_key: "silent:c1:none:2" })]).map((action) => action.op), ["supersede"]);
});

test("опис задачі несе ключ і позначку «замінено»", () => {
  // Стара задача — ключ ще в описі; нова — у колонках, опис для людини.
  const legacy = "Outbound Sales · лід відповів — відповісти\n⟦ob:reply:c1:x⟧\n⟦ob:superseded⟧";
  assert.deepEqual(taskMarks({ description: legacy }), { key: "reply:c1:x", superseded: true });
  assert.deepEqual(taskMarks({ description: "задача з CRM" }), { key: null, superseded: false });
  assert.deepEqual(taskMarks({ description: taskDescription("reply"), ping_key: "reply:c1:y", ping_superseded: false }), { key: "reply:c1:y", superseded: false });
  assert.equal(stripMarks(legacy), "Outbound Sales · лід відповів — відповісти");
  assert.doesNotMatch(taskDescription("silent", "нотатка"), /⟦ob:/, "новий опис — без службового рядка");
});

test("блоки «Сьогодні»: відповіді вище за прострочені, нові контакти — лише коли обидва порожні", () => {
  const today = "2026-10-16";
  assert.equal(blockOf({ reason: "reply", dueDay: "2026-10-14", awaitingUs: true }, today), "replies");
  assert.equal(blockOf({ reason: "silent", dueDay: "2026-10-15" }, today), "overdue");
  assert.equal(blockOf({ reason: "silent", dueDay: today }, today), "today");
  assert.equal(blockOf({ reason: "first", dueDay: today }, today), "first");
  assert.equal(blockOf({ reason: "first", dueDay: "2026-10-15" }, today), "overdue", "минуле перше повідомлення — прострочене, стримує нові контакти");
  assert.equal(blockOf({ reason: "manual", dueDay: today }, today), "today");
  assert.equal(blockOf({ reason: "reply", dueDay: "2026-10-17", awaitingUs: true }, today), "later", "перенесена людиною відповідь — на свій день");
  assert.equal(newContactsAllowed({ replies: [], overdue: [], today: [1], first: [1] }), true);
  assert.equal(newContactsAllowed({ replies: [1], overdue: [] }), false);
  assert.equal(newContactsAllowed({ replies: [], overdue: [1] }), false);
});

test("ручний пінг: +1, +3, тиждень або день", () => {
  assert.equal(manualDueDay("+1", "2026-10-16"), "2026-10-17");
  assert.equal(manualDueDay("+7", "2026-10-16"), "2026-10-23");
  assert.equal(manualDueDay("2026-11-04", "2026-10-16"), "2026-11-04");
  assert.equal(manualDueDay("завтра", "2026-10-16"), "");
});

// Етап 2/6: відкриті діалоги з 01.08.
import { isTheirs, pickOpenDialogs, ruleVerdict, spreadDates } from "../triage/open-dialogs.mjs";
import { reasonOfKey } from "../triage/pings.mjs";

test("відкритий діалог: лід відповів після 01.08 (зокрема наш рядок відповіді, записаний як outgoing) і статус відкритий; з пінгом — ні", () => {
  const activities = [
    { contact_id: "a", created_at: "2026-09-01T10:00:00Z", direction: "outgoing", content: "LinkedIn · Ми написали з акаунта X · …" },
    { contact_id: "a", created_at: "2026-09-02T10:00:00Z", direction: "outgoing", content: "LinkedIn · Відповідь на акаунт X · …\nцікаво" },
    { contact_id: "b", created_at: "2026-09-03T10:00:00Z", direction: "outgoing", content: "LinkedIn · Ми написали…" },
    { contact_id: "c", created_at: "2026-09-04T10:00:00Z", direction: "incoming", content: "так" },
    { contact_id: "d", created_at: "2026-09-05T10:00:00Z", direction: "incoming", content: "так" }
  ];
  const contacts = [
    { id: "a", name: "A", lead_status: "in_progress" }, { id: "b", name: "B", lead_status: "responded" },
    { id: "c", name: "C", lead_status: "bad_timing" }, { id: "d", name: "D", lead_status: "responded" }, { id: "e", name: "E", lead_status: "booked_call" }
  ];
  const statusChanges = [{ contact_id: "b", new_status: "responded" }];
  const picked = pickOpenDialogs({ activities, statusChanges, contacts, openPingContacts: new Set(["d"]) });
  assert.deepEqual(picked.map((item) => item.contactId).sort(), ["a", "b"], "c закритий, d має пінг, e без дотику й переходу");
  const onlyOurs = pickOpenDialogs({
    activities: [{ contact_id: "f", created_at: "2026-09-06T10:00:00Z", direction: "outgoing", content: "LinkedIn · Ми написали…" }, { contact_id: "g", created_at: "2026-09-06T10:00:00Z", direction: "outgoing", content: "hi" }],
    statusChanges: [], contacts: [{ id: "f", name: "F", lead_status: "responded" }, { id: "g", name: "G", lead_status: "in_progress" }], openPingContacts: new Set()
  });
  assert.deepEqual(onlyOurs.map((item) => item.contactId), ["f"], "responded з нашим дотиком — живий; in_progress лише з нашими — ні");
  // «Кваліфікацію» прибрано з CRM 19.10: такого статусу немає, а перехід у неї в історії — і далі ознака відповіді.
  const legacy = pickOpenDialogs({
    activities: [{ contact_id: "h", created_at: "2026-09-06T10:00:00Z", direction: "outgoing", content: "hi" }, { contact_id: "q", created_at: "2026-09-06T10:00:00Z", direction: "outgoing", content: "hi" }],
    statusChanges: [{ contact_id: "h", new_status: "qualification" }],
    contacts: [{ id: "h", name: "H", lead_status: "in_progress" }, { id: "q", name: "Q", lead_status: "qualification" }], openPingContacts: new Set()
  });
  assert.deepEqual(legacy.map((item) => item.contactId), ["h"], "статус qualification більше не відкритий; перехід у нього в історії — так");
  assert.equal(picked.find((item) => item.contactId === "a").lastBy, "them");
  assert.equal(isTheirs({ direction: "outgoing", content: "LinkedIn · Відповідь на акаунт Y" }), true);
});

test("крок за правилом і дати: важливіші раніше, не більше межі на робочий день, із суботи — з понеділка", () => {
  const timeline = [{ by: "us", type: "linkedin", text: "…" }];
  assert.equal(ruleVerdict({ status: "responded", lastBy: "them", timeline }).reason, "reply");
  assert.equal(ruleVerdict({ status: "booked_call", lastBy: "us", timeline }).reason, "call");
  assert.equal(ruleVerdict({ status: "responded", lastBy: "us", timeline }).reason, "silent");
  assert.match(ruleVerdict({ status: "responded", lastBy: null, timeline: [] }).why, /Дотиків з 01\.08 у CRM немає/);
  const items = Array.from({ length: 5 }, (_, index) => ({ contactId: `c${index}`, priority: index === 4 ? "high" : "normal", reason: "silent", lastAt: `2026-09-0${index + 1}` }));
  const spread = spreadDates(items, { today: "2026-10-16", perDay: 2 });
  assert.equal(spread[0].contactId, "c4", "високий пріоритет першим");
  assert.deepEqual(spread.map((item) => item.due), ["2026-10-16", "2026-10-16", "2026-10-19", "2026-10-19", "2026-10-20"]);
  assert.equal(spreadDates(items, { today: "2026-10-17", perDay: 10 })[0].due, "2026-10-19");
});

test("ключ імпорту дає крок для блоків «Сьогодні»", () => {
  assert.equal(reasonOfKey("import:reply:c1"), "reply");
  assert.equal(reasonOfKey("import:silent:c1"), "silent");
  assert.equal(reasonOfKey("import:bogus:c1"), "manual");
});

import { allRows } from "../triage/open-dialogs.mjs";

test("дотики читаються сторінками: CRM віддає до 1000 рядків за запит, решта не губиться", async () => {
  const data = Array.from({ length: 2345 }, (_, index) => ({ id: index }));
  const seen = [];
  const makeQuery = () => {
    const query = { size: 0, from: 0 };
    query.limit = (size) => { query.size = Math.min(size, 1000); return query; };
    query.offset = (from) => { query.from = from; seen.push(from); return query; };
    query.rows = async () => data.slice(query.from, query.from + query.size);
    return query;
  };
  const rows = await allRows(makeQuery);
  assert.equal(rows.length, 2345);
  assert.deepEqual(seen, [0, 1000, 2000]);
});

// Етап 5/6: статуси й причини виходу — спільні з CRM.
import { statusPatch } from "../triage/statuses.mjs";

test("статус і причина виходу: вихідний статус — з причиною із закритого списку; інший — причину знімає", () => {
  assert.deepEqual(statusPatch("booked_call").patch, { lead_status: "booked_call", exit_reason: null });
  assert.match(statusPatch("qualification").error, /Невідомий/, "«Кваліфікацію» прибрано з CRM 19.10");
  assert.deepEqual(statusPatch("not_interested", "traffic_only").patch, { lead_status: "not_interested", exit_reason: "traffic_only" });
  assert.deepEqual(statusPatch("not_icp").patch, { lead_status: "not_icp", exit_reason: "not_icp" }, "«Не ICP» має свою причину за замовчуванням");
  assert.match(statusPatch("not_interested").error, /причину/);
  assert.match(statusPatch("not_interested", "bogus").error, /причину/);
  assert.match(statusPatch("won").error, /Невідомий/);
});

// ── Статус «Відповів» (Марко 17.10) ─────────────────────────────────────────

import { repliedStatusDue } from "../triage/pings.mjs";

test("«Відповів»: лід писав — «Новий» і «В обробці» піднімаються; людські статуси не чіпаються", () => {
  const thread = (direction, at, answered = true) => ({ answered, inCount: answered ? 1 : 0, lastMessage: { direction, at } });
  const replied = { threads: [thread("out", "2026-10-16T10:00:00Z")] };
  for (const status of ["new", "in_progress", undefined, null]) assert.equal(repliedStatusDue(replied, status), true, String(status));
  for (const status of ["responded", "booked_call", "not_interested", "not_icp", "bad_timing"]) {
    assert.equal(repliedStatusDue(replied, status), false, `${status} ставить людина`);
  }
  assert.equal(repliedStatusDue({ threads: [thread("out", "2026-10-16T10:00:00Z", false)] }, "new"), false, "лід не писав — без змін");
  assert.equal(repliedStatusDue({ threads: [] }, "new"), false);
});

test("«Без відповіді» → «Відповів» лише коли останнім написав лід (повернувся після тиші)", () => {
  const thread = (direction, at) => ({ answered: true, inCount: 1, lastMessage: { direction, at } });
  assert.equal(repliedStatusDue({ threads: [thread("in", "2026-10-17T09:00:00Z")] }, "no_response"), true);
  assert.equal(repliedStatusDue({ threads: [thread("out", "2026-10-17T09:00:00Z")] }, "no_response"), false, "мовчить після нашого — лишається «Без відповіді»");
  assert.equal(repliedStatusDue({ threads: [thread("in", "2026-10-01T09:00:00Z"), thread("out", "2026-10-17T09:00:00Z")] }, "no_response"), false, "дивимось найсвіжішу розмову");
});

// Суддя 19.10: ввід дати з клавіатури («0002-10-19») не переносить пінг у минуле.
test("дата перенесення — лише повна, від сьогодні й до року вперед", () => {
  assert.equal(manualDueDay("0002-10-19", "2026-10-19"), "", "неповний рік з клавіатури");
  assert.equal(manualDueDay("2026-10-18", "2026-10-19"), "", "учора");
  assert.equal(manualDueDay("2026-10-19", "2026-10-19"), "2026-10-19");
  assert.equal(manualDueDay("2026-11-02", "2026-10-19"), "2026-11-02");
  assert.equal(manualDueDay("2028-01-01", "2026-10-19"), "", "далі року");
  assert.equal(manualDueDay("+3", "2026-10-19"), "2026-10-22");
});
