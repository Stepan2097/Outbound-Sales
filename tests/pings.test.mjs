import assert from "node:assert/strict";
import test from "node:test";

import {
  SILENT_LIMIT, addWorkingDays, blockOf, dayIn, desiredPing, manualDueDay, markSuperseded, newContactsAllowed,
  parseTaskMarks, planPingChanges, taskDescription, zonedIso
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

test("три наших повідомлення поспіль без відповіді → пінгу більше немає", () => {
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
  assert.deepEqual(planPingChanges(next, [task({ description: taskDescription("reply", next.key) })]), [], "дата, перенесена людиною, лишається");
});

test("план: нова подія закриває стару системну задачу як «замінену» і ставить нову", () => {
  const replyKey = "reply:c1:2026-10-16T08:00:00Z";
  const silent = desiredPing("c1", { threads: [thread()], pending: [{ threadKey: "t1", queuedAt: "2026-10-16T09:00:00Z" }] }, { now: NOW });
  const actions = planPingChanges(silent, [task({ description: taskDescription("reply", replyKey) })]);
  assert.deepEqual(actions.map((action) => action.op), ["supersede", "create"]);
});

test("план: скасоване повідомлення повертає попередній крок — його «замінена» задача відкривається, а не губиться", () => {
  const replyKey = "reply:c1:2026-10-16T08:00:00Z";
  const reply = desiredPing("c1", { threads: [thread()] }, { now: NOW });
  const tasks = [
    task({ id: "old", completed: true, description: markSuperseded(taskDescription("reply", replyKey)) }),
    task({ id: "silent", created_at: "2026-10-16T09:01:00Z", description: taskDescription("silent", "silent:c1:2026-10-16T08:00:00Z:1") })
  ];
  assert.deepEqual(planPingChanges(reply, tasks).map((action) => [action.op, action.task?.id]), [["supersede", "silent"], ["reopen", "old"]]);
});

test("план: задачу, яку людина закрила сама, система не відкриває", () => {
  const reply = desiredPing("c1", { threads: [thread()] }, { now: NOW });
  assert.deepEqual(planPingChanges(reply, [task({ completed: true, description: taskDescription("reply", reply.key) })]), []);
});

test("план: ручний пінг після події — і є наступний крок; новіша подія його замінює", () => {
  const reply = desiredPing("c1", { threads: [thread()] }, { now: NOW });
  const manual = task({ id: "m", created_at: "2026-10-16T10:00:00Z", description: taskDescription("manual", "manual:2026-10-16T10:00:00Z") });
  assert.deepEqual(planPingChanges(reply, [manual]), [], "поставлений після відповіді — лишається, нової задачі немає");
  const later = desiredPing("c1", { threads: [thread({ lastStoredAt: "2026-10-16T11:00:00Z", lastInboundStoredAt: "2026-10-16T11:00:00Z" })] }, { now: NOW });
  assert.deepEqual(planPingChanges(later, [manual]).map((action) => action.op), ["supersede", "create"]);
});

test("план: пінгу бути не повинно → системні задачі закриваються", () => {
  const stop = { key: null, basisAt: "2026-10-16T09:00:00Z" };
  assert.deepEqual(planPingChanges(stop, [task({ description: taskDescription("silent", "silent:c1:none:2") })]).map((action) => action.op), ["supersede"]);
});

test("опис задачі несе ключ і позначку «замінено»", () => {
  const description = markSuperseded(taskDescription("reply", "reply:c1:x"));
  assert.deepEqual(parseTaskMarks(description), { key: "reply:c1:x", superseded: true });
  assert.deepEqual(parseTaskMarks("задача з CRM"), { key: null, superseded: false });
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
    { id: "c", name: "C", lead_status: "bad_timing" }, { id: "d", name: "D", lead_status: "responded" }, { id: "e", name: "E", lead_status: "qualification" }
  ];
  const statusChanges = [{ contact_id: "b", new_status: "responded" }];
  const picked = pickOpenDialogs({ activities, statusChanges, contacts, openPingContacts: new Set(["d"]) });
  assert.deepEqual(picked.map((item) => item.contactId).sort(), ["a", "b"], "c закритий, d має пінг, e без дотику й переходу");
  const onlyOurs = pickOpenDialogs({
    activities: [{ contact_id: "f", created_at: "2026-09-06T10:00:00Z", direction: "outgoing", content: "LinkedIn · Ми написали…" }, { contact_id: "g", created_at: "2026-09-06T10:00:00Z", direction: "outgoing", content: "hi" }],
    statusChanges: [], contacts: [{ id: "f", name: "F", lead_status: "qualification" }, { id: "g", name: "G", lead_status: "in_progress" }], openPingContacts: new Set()
  });
  assert.deepEqual(onlyOurs.map((item) => item.contactId), ["f"], "qualification з нашим дотиком — живий; in_progress лише з нашими — ні");
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
