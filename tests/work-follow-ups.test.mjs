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

const thread = (over = {}) => ({
  accountId: "acc", threadKey: "t1", crmContactId: null, participant: { name: "Anna", headline: "CMO" },
  lastMessage: { direction: "out", body: "Hi Anna", at: "2026-10-13T09:00:00Z" }, trailingOut: 1, ...over
});

test("написали вчора, мовчить — сьогодні в плані; написали сьогодні — ще ні", () => {
  const [item] = followUpsDue([thread()], { today: "2026-10-14", accounts: new Map([["acc", "Chloe"]]) });
  assert.equal(item.name, "Anna");
  assert.equal(item.accountName, "Chloe");
  assert.equal(item.carriedDays, 0);
  assert.equal(item.key, "thread:acc:t1");
  assert.deepEqual(followUpsDue([thread({ lastMessage: { direction: "out", at: "2026-10-14T06:00:00Z" } })], { today: "2026-10-14" }), []);
});

test("не встигли — переноситься: чекає днів, старіші вгорі", () => {
  const due = followUpsDue([
    thread({ threadKey: "new" }),
    thread({ threadKey: "old", participant: { name: "Boris" }, lastMessage: { direction: "out", at: "2026-10-10T09:00:00Z" } })
  ], { today: "2026-10-14" });
  assert.deepEqual(due.map((item) => [item.threadKey, item.carriedDays]), [["old", 3], ["new", 0]]);
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
  ], { today });
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
