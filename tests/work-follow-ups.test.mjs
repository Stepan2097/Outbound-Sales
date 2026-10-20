import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FOLLOW_UP_LIMIT, followUpsDue } from "../triage/work-log.mjs";
import { deriveThreads } from "../warmup/inbox.mjs";

/**
 * «Заплановані» (власник 14.10): написали людині, вона мовчить — наступного дня
 * написати знову; не встигли — переноситься на наступний день. Будується з
 * розмов LinkedIn, які читає агент.
 */

// «Наступного дня» — кроки [1, 1, 1, 1]; графік за замовчуванням з 20.10 — окремий тест нижче.
const NEXT_DAY = [1, 1, 1, 1];

const thread = (over = {}) => ({
  accountId: "acc", threadKey: "t1", crmContactId: null, participant: { name: "Anna", headline: "CMO" },
  lastMessage: { direction: "out", body: "Hi Anna", at: "2026-10-13T09:00:00Z" }, trailingOut: 1, ...over
});

test("написали вчора, мовчить — сьогодні в плані; написали сьогодні — ще ні", () => {
  const [item] = followUpsDue([thread()], { today: "2026-10-14", accounts: new Map([["acc", "Chloe"]]), steps: NEXT_DAY });
  assert.equal(item.name, "Anna");
  assert.equal(item.accountName, "Chloe");
  assert.equal(item.carriedDays, 0);
  assert.equal(item.key, "thread:acc:t1");
  assert.deepEqual(followUpsDue([thread({ lastMessage: { direction: "out", at: "2026-10-14T06:00:00Z" } })], { today: "2026-10-14", steps: NEXT_DAY }), []);
});

test("не встигли — переноситься: чекає днів, старіші вгорі", () => {
  const due = followUpsDue([
    thread({ threadKey: "new" }),
    thread({ threadKey: "old", participant: { name: "Boris" }, lastMessage: { direction: "out", at: "2026-10-10T09:00:00Z" } })
  ], { today: "2026-10-14", steps: NEXT_DAY });
  // Субота 10.10 + 1 робочий день — понеділок 12.10: до середи 14.10 чекає два дні.
  assert.deepEqual(due.map((item) => [item.threadKey, item.carriedDays]), [["old", 2], ["new", 0]]);
});

test("відповіла, забагато повідомлень поспіль, давно мовчить — не в плані", () => {
  const today = "2026-10-14";
  assert.deepEqual(followUpsDue([thread({ lastMessage: { direction: "in", at: "2026-10-13T09:00:00Z" }, trailingOut: 0 })], { today }), []);
  assert.deepEqual(followUpsDue([thread({ trailingOut: FOLLOW_UP_LIMIT })], { today }), []);
  assert.deepEqual(followUpsDue([thread({ lastMessage: { direction: "out", at: "2026-08-01T09:00:00Z" } })], { today }), []);
  // Київський день: 23:30 UTC 13.10 — це вже 14.10 у Києві.
  assert.deepEqual(followUpsDue([thread({ lastMessage: { direction: "out", at: "2026-10-13T23:30:00Z" } })], { today }), []);
});

test("розмова знає, скільки наших повідомлень у кінці без відповіді, і справжній час останнього", () => {
  const event = (id, type, at, extra = {}) => ({ id, account_id: "acc", type, created_at: at, meta: { threadKey: "t1", body: `m${id}`, participant: { name: "Anna" }, ...extra } });
  const [one] = deriveThreads([
    event(1, "message.out", "2026-10-10T10:00:00Z"),
    event(2, "message.in", "2026-10-11T10:00:00Z"),
    event(3, "message.out", "2026-10-12T10:00:00Z"),
    event(4, "message.out", "2026-10-13T10:00:00Z", { sentAt: "2026-10-13T08:00:00Z", sentAtIso: true })
  ]);
  assert.equal(one.trailingOut, 2);
  assert.equal(one.lastMessage.at, "2026-10-13T08:00:00Z");
});

test("заблокований акаунт пропускається, одна людина — один рядок, «Переглянути профіль» з імені прибрано", () => {
  const today = "2026-10-14";
  assert.deepEqual(followUpsDue([thread()], { today, skipAccounts: new Set(["acc"]) }), []);
  const due = followUpsDue([
    thread({ threadKey: "a", crmContactId: "c1", participant: { name: "Переглянути профіль Luke" } }),
    thread({ threadKey: "b", crmContactId: "c1", lastMessage: { direction: "out", at: "2026-10-12T09:00:00Z" } }),
    thread({ threadKey: "c", participant: { name: "Anna" } }),
    thread({ threadKey: "d", participant: { name: "anna" }, lastMessage: { direction: "out", at: "2026-10-13T10:00:00Z" } })
  ], { today, steps: NEXT_DAY });
  assert.deepEqual(due.map((item) => [item.threadKey, item.name]), [["a", "Luke"], ["d", "anna"]]);
  assert.deepEqual(followUpsDue([thread({ lastMessage: { direction: "out", at: "2026-09-16T09:00:00Z" } })], { today }), [], "понад 14 днів тиші");
});

test("сторінка: блок «Заплановані», кнопка «Написати» веде в розмову; сервер дає план лише на сьогодні", async () => {
  const page = await readFile(new URL("../app/screens/work.js", import.meta.url), "utf8");
  assert.match(page, /Заплановані на сьогодні/);
  assert.match(page, /showWarmupInboxThread\(write\.dataset\.workWrite, write\.dataset\.workThread\)/);
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /const planned = date === today \? await plannedFollowUps\(today\) : null;/);
});

test("графік з 20.10: перший раз через 2 робочі дні, другий — через 3, третій — через 5, четвертий — через 7; після п'ятого — зі списку (власник 20.10)", async () => {
  const { DEFAULT_PING_STEPS, usePingSteps } = await import("../triage/pings.mjs");
  usePingSteps(null);
  assert.deepEqual(DEFAULT_PING_STEPS, [2, 3, 5, 7]);
  const today = "2026-10-14"; // середа
  const sent = (at, trailingOut, key) => thread({ threadKey: key, crmContactId: key, trailingOut, lastMessage: { direction: "out", at } });
  const due = followUpsDue([
    sent("2026-10-12T09:00:00Z", 1, "first-due"),   // пн + 2 роб. — ср
    sent("2026-10-12T09:00:00Z", 2, "second-not-yet"), // пн + 3 роб. — чт
    sent("2026-10-05T09:00:00Z", 4, "fourth-due"),  // пн + 7 роб. — ср
    sent("2026-10-05T09:00:00Z", 5, "done")          // п'ять наших — досить
  ], { today });
  assert.deepEqual(due.map((item) => [item.threadKey, item.dueDay, item.carriedDays]).sort(), [["first-due", "2026-10-14", 0], ["fourth-due", "2026-10-14", 0]]);
  // Змінили кроки на «Сьогодні» — «По днях» іде за ними.
  usePingSteps([1, 1]);
  assert.deepEqual(followUpsDue([sent("2026-10-13T09:00:00Z", 1, "x"), sent("2026-10-13T09:00:00Z", 3, "y")], { today }).map((item) => item.threadKey), ["x"]);
  usePingSteps(null);
});
