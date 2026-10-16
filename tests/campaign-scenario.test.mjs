import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SILENT_STEPS, accountClash, normalizeCampaign, parseScenario, shareLeft } from "../warmup/campaigns.mjs";
import { desiredPing, noReplyDay, silentNext } from "../triage/pings.mjs";

// Сценарій кампанії LinkedIn (етап 3/6, таск 9a01a9f9): підхід, кроки «мовчить»,
// межа людей порівну між акаунтами, акаунт — в одній живій кампанії.

test("кампанія, збережена до сценарію, працює як була: без межі людей, кроки за замовчуванням", () => {
  const legacy = normalizeCampaign({ id: "c", name: "Warm-up", folderId: "f", accountIds: ["a1", "a2"], state: "running" });
  assert.equal(legacy.maxPeople, null);
  assert.deepEqual(legacy.silentSteps, DEFAULT_SILENT_STEPS);
  assert.equal(shareLeft(legacy, { total: 999, mine: 999 }), Infinity, "межі немає — годування не змінюється");
});

test("сценарій з форми: кроки 1–6 по 1–30 днів, людей 1–5000; погане — реченням", () => {
  assert.deepEqual(parseScenario({ approach: " SiGMA ", silentSteps: ["3", 4, 7], maxPeople: "200" }).value, { approach: "SiGMA", silentSteps: [3, 4, 7], maxPeople: 200 });
  assert.match(parseScenario({ silentSteps: [0] }).error, /Кроки/);
  assert.match(parseScenario({ silentSteps: [1, 2, 3, 4, 5, 6, 7] }).error, /Кроки/);
  assert.match(parseScenario({ maxPeople: 0 }).error, /Людей/);
});

test("200 людей на 2 акаунти — по 100 кожному, і не більше межі разом", () => {
  const campaign = { maxPeople: 200, accountIds: ["a1", "a2"] };
  assert.equal(shareLeft(campaign, { total: 0, mine: 0 }), 100);
  assert.equal(shareLeft(campaign, { total: 150, mine: 90 }), 10);
  assert.equal(shareLeft(campaign, { total: 150, mine: 100 }), 0, "своя частка набрана — інший акаунт добирає своє");
  assert.equal(shareLeft({ maxPeople: 5, accountIds: ["a1", "a2"] }, { total: 4, mine: 1 }), 1, "не більше, ніж лишилось до межі");
});

test("акаунт — в одній живій кампанії", () => {
  const campaigns = [{ id: "x", name: "SiGMA", state: "running", accountIds: ["a1"] }, { id: "y", name: "Old", state: "paused", accountIds: ["a2"] }];
  assert.equal(accountClash(campaigns, { id: "z", state: "running", accountIds: ["a1", "a3"] })?.campaign.name, "SiGMA");
  assert.equal(accountClash(campaigns, { id: "z", state: "running", accountIds: ["a2"] }), null, "на паузі — не заважає");
  assert.equal(accountClash(campaigns, { id: "z", state: "draft", accountIds: ["a1"] }), null, "чернетка — не заважає");
});

test("гілка «мовчить» за кроками кампанії: 2 → 5 днів, потім «Не відповідає» ще через 5", () => {
  const out = "2026-10-16T09:00:00Z"; // п'ятниця
  assert.equal(silentNext([2, 5], 1, out), "2026-10-20");
  assert.equal(silentNext([2, 5], 2, out), "2026-10-23");
  assert.equal(silentNext([2, 5], 3, out), null);
  assert.equal(noReplyDay([2, 5], out), "2026-10-23");
  const thread = { accountId: "a1", threadKey: "t", trailingOut: 3, lastStoredAt: out, lastInboundStoredAt: null, lastMessage: { direction: "out", at: out } };
  const stop = desiredPing("c1", { threads: [thread], steps: [2, 5] }, { now: new Date("2026-10-17T10:00:00Z") });
  assert.equal(stop.key, null);
  assert.equal(stop.noReplyDue, "2026-10-23");
});

import { planReassign } from "../warmup/reassign.mjs";

test("бан: люди розходяться порівну, першим — тому, у кого зараз найменше", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: `r${index}` }));
  const plan = planReassign(rows, ["a2", "a3"], new Map([["a2", 2], ["a3", 0]]));
  const count = (id) => plan.filter((item) => item.target === id).length;
  assert.equal(plan[0].target, "a3", "у a3 менше — перший туди");
  assert.deepEqual([count("a2"), count("a3")], [2, 3], "разом із тими, що вже були: 4 і 3 — різниця не більше одного");
});
