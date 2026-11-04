import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COLD_SILENT_LIMIT, DEFAULT_COLD_PING_STEPS, DEFAULT_PING_STEPS, SILENT_LIMIT, currentPingSteps, desiredPing, ownCampaignSteps,
  planPingChanges, usePingSteps
} from "../triage/pings.mjs";

// Таск fca90a3a (аудит 03.11): хто ще не відповідав — до 3 наших повідомлень;
// хто відповідав — до 5. Обидва набори редагує адмін; свої кроки кампанії лишаються.

const NOW = new Date("2026-11-04T12:00:00Z"); // середа
const cold = (trailingOut, at = "2026-11-02T09:00:00Z") => ({
  accountId: "acc-1", threadKey: "t1", trailingOut, lastStoredAt: at, lastInboundStoredAt: null, lastMessage: { direction: "out", at }
});
const warm = (trailingOut, at = "2026-11-02T09:00:00Z") => ({ ...cold(trailingOut, at), lastInboundStoredAt: "2026-10-20T08:00:00Z" });

test.beforeEach(() => usePingSteps(null));

test("за замовчуванням: холодним 2, 3 (три повідомлення), теплим 2, 3, 5, 7 (п'ять)", () => {
  assert.deepEqual(DEFAULT_COLD_PING_STEPS, [2, 3]);
  assert.deepEqual(DEFAULT_PING_STEPS, [2, 3, 5, 7]);
  assert.equal(COLD_SILENT_LIMIT, 3);
  assert.equal(SILENT_LIMIT, 5);
  assert.deepEqual(currentPingSteps(), { cold: [2, 3], warm: [2, 3, 5, 7] });
});

test("лід ще не відповідав і отримав 3 наші → пінгу «мовчить» немає; після 2-х — ще є", () => {
  assert.equal(desiredPing("c1", { threads: [cold(3)] }, { now: NOW }).key, null);
  assert.equal(desiredPing("c1", { threads: [cold(4)] }, { now: NOW }).key, null);
  const second = desiredPing("c1", { threads: [cold(2)] }, { now: NOW });
  assert.equal(second.key, "silent:c1:none:2");
  assert.equal(second.due, "2026-11-05", "пн 02.11 + 3 робочі дні");
});

test("лід відповів раз, потім замовк → кроки теплих, до 5 повідомлень", () => {
  const third = desiredPing("c1", { threads: [warm(3)] }, { now: NOW });
  assert.equal(third.reason, "silent");
  assert.equal(third.due, "2026-11-09", "пн 02.11 + 5 робочих днів");
  assert.equal(desiredPing("c1", { threads: [warm(4)] }, { now: NOW }).due, "2026-11-11", "+7");
  assert.equal(desiredPing("c1", { threads: [warm(5)] }, { now: NOW }).key, null);
});

test("давній холодний пінг (наше 3-тє — поза вікном 14 днів) теж закривається на звірці", () => {
  const old = desiredPing("c1", { threads: [cold(3, "2026-10-01T09:00:00Z")] }, { now: NOW });
  assert.equal(old.key, null, "не null-«не чіпати», а «пінгу не має бути»");
  const open = { id: "p1", completed: false, created_at: "2026-10-08T07:00:00Z", description: "", ping_key: "silent:c1:none:3" };
  assert.deepEqual(planPingChanges(old, [open]).map((action) => [action.op, action.task.id]), [["supersede", "p1"]]);
  assert.equal(desiredPing("c1", { threads: [cold(2, "2026-10-01T09:00:00Z")] }, { now: NOW }), null, "живий крок поза вікном — як і було, не чіпаємо");
});

test("прийняв запит, наше перше в черзі → холодні кроки", () => {
  const accepted = { outreachId: "o1", accountId: "acc-1", acceptedAt: "2026-11-02T08:00:00Z" };
  const next = desiredPing("c1", { accepted, pending: [{ threadKey: "first:o1", queuedAt: "2026-11-02T09:00:00Z" }] }, { now: NOW });
  assert.equal(next.due, "2026-11-04", "+2");
});

test("свої кроки кампанії не змінюються («Зміна ролі»: 5 і 10); кроки за замовчуванням — загальні холодні/теплі", () => {
  assert.deepEqual(ownCampaignSteps([5, 10]), [5, 10]);
  assert.equal(ownCampaignSteps([2, 3, 5, 7]), null);
  assert.equal(ownCampaignSteps(undefined), null);
  const roleChange = desiredPing("c1", { threads: [cold(2)], steps: [5, 10] }, { now: NOW });
  assert.equal(roleChange.due, "2026-11-16", "другий крок кампанії — 10 робочих днів, і холодному теж");
  assert.equal(desiredPing("c1", { threads: [cold(3)], steps: [5, 10] }, { now: NOW }).key, null, "у кампанії два кроки — три повідомлення");
});

test("відповіді й перші повідомлення — як були", () => {
  const replied = desiredPing("c1", { threads: [{ ...warm(0), lastMessage: { direction: "in", at: "2026-11-03T08:00:00Z" }, lastInboundStoredAt: "2026-11-03T08:00:00Z" }] }, { now: NOW });
  assert.equal(replied.reason, "reply");
  const first = desiredPing("c1", { accepted: { outreachId: "o1", accountId: "acc-1", acceptedAt: "2026-11-03T08:00:00Z" } }, { now: NOW });
  assert.equal(first.reason, "first");
});

test("адмін змінює обидва набори; старе збереження — один список — це теплі", () => {
  usePingSteps({ cold: [3], warm: [2, 4, 6] });
  assert.equal(desiredPing("c1", { threads: [cold(2)] }, { now: NOW }).key, null, "холодним тепер два повідомлення");
  assert.equal(desiredPing("c1", { threads: [warm(3)] }, { now: NOW }).due, "2026-11-10", "+6");
  assert.deepEqual(usePingSteps([2, 3, 5, 7, 9]), { cold: [2, 3], warm: [2, 3, 5, 7, 9] });
  assert.deepEqual(usePingSteps({ cold: [0], warm: "x" }), { cold: [2, 3], warm: [2, 3, 5, 7] }, "зіпсоване — за замовчуванням");
});

test("налаштування: API віддає й приймає обидва набори, екран показує два блоки; кампанії зі своїми кроками — за ними", () => {
  const today = readFileSync(new URL("../triage/today.mjs", import.meta.url), "utf8");
  const screen = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");
  assert.match(today, /steps: steps\.warm, coldSteps: steps\.cold, defaults: DEFAULT_PING_STEPS, coldDefaults: DEFAULT_COLD_PING_STEPS/);
  assert.match(today, /if \(!isAdmin\) throw refuse\("Коли нагадувати, вирішує адміністратор\.", 403\);/);
  assert.match(today, /await pingStepsStore\.write\(\{ cold: coldSteps, warm: steps \}\);/);
  assert.match(today, /state\.steps = ownCampaignSteps\(campaign\.silentSteps\);/);
  assert.match(screen, /kind: "cold", title: "Ще не відповідав"/);
  assert.match(screen, /kind: "warm", title: "Відповідав"/);
  assert.match(screen, /body: JSON\.stringify\(\{ steps: warm, coldSteps: cold \}\)/);
});

test("давній вичерпаний діалог лише втрачає пінг: статус «Не відповідає» не ставиться (як і до таска)", () => {
  assert.equal(desiredPing("c1", { threads: [cold(3, "2026-10-01T09:00:00Z")], campaignId: "k1" }, { now: NOW }).noReplyDue, null);
  assert.ok(desiredPing("c1", { threads: [cold(3)], campaignId: "k1" }, { now: NOW }).noReplyDue, "свіжий — як було");
});
