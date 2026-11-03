import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CAPACITY, addWorkingDays, dayIn, desiredPing, isSystemSender, levelPings, loadAhead, workday, zonedIso } from "../triage/pings.mjs";

// Таск cdfe0440: денна ємність лідгена, згладжування пінгів, без вихідних, системні відправники LinkedIn.

const TODAY = "2026-11-03"; // вівторок
let id = 0;
const ping = (key, day, extra = {}) => ({ id: `p${++id}`, ping_key: key, due_date: zonedIso(day), completed: false, task_type: "To-do", created_at: `2026-10-01T00:00:${String(id % 60).padStart(2, "0")}Z`, ...extra });
const weekend = (day) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

/** Дати після вирівнювання: змінені — нові, решта — як були. */
function after(tasks, changes) {
  const moved = new Map(changes.map((change) => [change.task.id, change.due]));
  return tasks.map((task) => ({ task, day: moved.get(task.id) || dayIn(task.due_date) }));
}

function perDay(placed) {
  const counts = new Map();
  for (const { day } of placed) if (day >= TODAY) counts.set(day, (counts.get(day) || 0) + 1);
  return counts;
}

test("235 пінгів на один день розкладаються так, що жоден робочий день не перевищує ємність", () => {
  const tasks = [
    ...Array.from({ length: 20 }, (_, index) => ping(`reply:r${index}:2026-11-02`, TODAY)),
    ...Array.from({ length: 5 }, (_, index) => ping(`silent:k${index}:none:1`, TODAY, { task_type: "Call" })),
    ...Array.from({ length: 60 }, (_, index) => ping(`first:f${index}:o${index}`, TODAY)),
    ...Array.from({ length: 150 }, (_, index) => ping(`silent:s${index}:none:${index % 3 + 1}`, TODAY))
  ];
  assert.equal(tasks.length, 235);
  const changes = levelPings(tasks, { today: TODAY, capacity: DEFAULT_CAPACITY });
  const placed = after(tasks, changes);
  for (const [day, count] of perDay(placed)) {
    assert.ok(count <= DEFAULT_CAPACITY, `${day}: ${count}`);
    assert.ok(!weekend(day), `${day} — вихідний`);
  }
  // Відповіді й дзвінки не переносяться.
  for (const { task, day } of placed) if (task.ping_key.startsWith("reply:") || task.task_type === "Call") assert.equal(day, TODAY);
  // Спершу перші повідомлення, далі «мовчить»: жоден «мовчить» не раніше за останнє перше.
  const lastFirst = placed.filter(({ task }) => task.ping_key.startsWith("first:")).map(({ day }) => day).sort().at(-1);
  const firstSilent = placed.filter(({ task }) => task.ping_key.startsWith("silent:") && task.task_type !== "Call").map(({ day }) => day).sort()[0];
  assert.ok(firstSilent >= lastFirst, `${firstSilent} < ${lastFirst}`);
  assert.equal(perDay(placed).get(TODAY), DEFAULT_CAPACITY, "сьогодні — рівно ємність");
});

test("прострочені рухомі стають у чергу від сьогодні, майбутні не стають раніше своєї дати", () => {
  const tasks = [
    ...Array.from({ length: 40 }, (_, index) => ping(`silent:o${index}:none:1`, "2026-10-20")),
    ping("silent:future:none:1", "2026-11-12")
  ];
  const placed = after(tasks, levelPings(tasks, { today: TODAY, capacity: 30 }));
  assert.equal(placed.filter(({ day }) => day === TODAY).length, 30);
  assert.equal(placed.filter(({ day }) => day === addWorkingDays(TODAY, 1)).length, 10);
  assert.equal(placed.find(({ task }) => task.ping_key === "silent:future:none:1").day, "2026-11-12");
  assert.ok(placed.every(({ day }) => day >= TODAY));
});

test("відповіді, дзвінки й ручні пінги з вихідного — на понеділок; прострочені нерухомі не займають сьогодні", () => {
  const tasks = [
    ping("reply:a:2026-11-07", "2026-11-07"),
    ping("manual:2026-11-01T00:00:00Z", "2026-11-08"),
    ping("silent:b:none:1", "2026-11-08"),
    ...Array.from({ length: 50 }, (_, index) => ping(`reply:old${index}:2026-10-20`, "2026-10-20")),
    ...Array.from({ length: 30 }, (_, index) => ping(`silent:t${index}:none:1`, TODAY))
  ];
  const placed = after(tasks, levelPings(tasks, { today: TODAY, capacity: 30 }));
  const dayOf = (key) => placed.find(({ task }) => task.ping_key === key).day;
  assert.equal(dayOf("reply:a:2026-11-07"), "2026-11-09");
  assert.equal(dayOf("manual:2026-11-01T00:00:00Z"), "2026-11-09");
  assert.equal(dayOf("silent:b:none:1"), "2026-11-09");
  assert.equal(dayOf("reply:old0:2026-10-20"), "2026-10-20", "бекліг відповідей не рухається — його розбирають окремо");
  const oldWeekend = [ping("reply:sat:2026-10-24", "2026-10-24")];
  assert.equal(after(oldWeekend, levelPings(oldWeekend, { today: TODAY })).at(0).day, "2026-10-26", "стара відповідь із суботи — на понеділок, лишається в беклозі");
  assert.equal(placed.filter(({ day }) => day === TODAY).length, 30, "старі відповіді не витісняють сьогоднішні нагадування");
  assert.ok(placed.every(({ day }) => day < TODAY || !weekend(day)));
});

test("ємність — від 5 до 200, без значення — 30; повторне вирівнювання нічого не міняє", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ping(`first:x${index}:o`, TODAY));
  const changes = levelPings(tasks, { today: TODAY, capacity: 1 });
  assert.equal(after(tasks, changes).filter(({ day }) => day === TODAY).length, 5, "менше за 5 не буває");
  const settled = tasks.map((task) => ({ ...task, due_date: zonedIso(after(tasks, changes).find((row) => row.task.id === task.id).day) }));
  assert.deepEqual(levelPings(settled, { today: TODAY, capacity: 5 }), [], "стабільно: звірка кожні 2 хв не смикає дати");
  assert.equal(levelPings(tasks, { today: TODAY }).length, 0, "12 < 30 — нічого не рухається");
});

test("навантаження на 5 робочих днів: вихідні не показуються, дати з вихідних — на понеділок", () => {
  const load = loadAhead(["2026-11-03", "2026-11-03", "2026-11-07", "2026-11-10", "2026-12-01"], { today: TODAY });
  assert.deepEqual(load.map((row) => row.day), ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"]);
  assert.deepEqual(load.map((row) => row.count), [2, 0, 0, 0, 1]);
  assert.equal(workday("2026-11-08"), "2026-11-09");
  assert.equal(workday("2026-11-04"), "2026-11-04");
});

test("системні відправники LinkedIn — не розмова: ні пінгу «Відповісти», ні чернетки", () => {
  assert.equal(isSystemSender({ name: "LinkedIn", slug: null, memberProfile: false }), true);
  assert.equal(isSystemSender({ name: "LinkedIn Team", slug: null, memberProfile: false }), true);
  assert.equal(isSystemSender({ name: "Команда LinkedIn", slug: null, memberProfile: false }), true);
  assert.equal(isSystemSender({ name: "Acme Casino", slug: "https://www.linkedin.com/company/acme/", memberProfile: false }), true);
  assert.equal(isSystemSender({ name: "Jane Doe", slug: "jane-doe", memberProfile: true }), false);
  assert.equal(isSystemSender({ name: "Учасник LinkedIn", slug: "ACoAAB", memberProfile: true }), false, "людина з профілем лишається людиною");
  assert.equal(isSystemSender({ name: "Unnamed", slug: null, memberProfile: false }), false, "ім'я, яке агент не прочитав, — не причина губити відповідь");

  const now = new Date("2026-11-03T10:00:00Z");
  const welcome = { accountId: "a", threadKey: "t-li", participant: { name: "LinkedIn Team", slug: null, memberProfile: false }, lastStoredAt: "2026-11-03T09:00:00Z", lastInboundStoredAt: "2026-11-03T09:00:00Z", lastMessage: { direction: "in", at: "2026-11-03T09:00:00Z" } };
  const closed = desiredPing("c1", { threads: [welcome], pending: [], accepted: null }, { now });
  assert.equal(closed.key, null, "лише системний тред — пінгу немає, старий закриється");
  const real = { ...welcome, threadKey: "t-1", participant: { name: "Jane Doe", slug: "jane-doe", memberProfile: true }, lastStoredAt: "2026-11-02T09:00:00Z", lastInboundStoredAt: "2026-11-02T09:00:00Z" };
  assert.equal(desiredPing("c1", { threads: [welcome, real], pending: [], accepted: null }, { now }).threadKey, "t-1", "розмова з людиною — та, на яку відповідаємо");
});
