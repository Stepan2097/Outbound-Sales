import assert from "node:assert/strict";
import test from "node:test";

import { inboxLabeler, labelBasis, labelKey, needsInboxLabel } from "../warmup/inbox-labels.mjs";

// «Вхідні», розібрані AI (власник 20.10): мітка кожної розмови, де людина писала;
// людську мітку AI не переписує; нова відповідь — AI дивиться знову.

const thread = (key, extra = {}) => ({ accountId: "acc", threadKey: key, answered: true, inCount: 1, lastInboundStoredAt: "2026-10-20T08:00:00Z", participant: { name: key }, ...extra });

test("кому потрібна мітка: людина писала, мітки немає або AI ставив до її нової відповіді; людську — ніколи", () => {
  assert.equal(needsInboxLabel(thread("a", { answered: false }), null), false);
  assert.equal(needsInboxLabel(thread("a"), null), true);
  const t = thread("a");
  assert.equal(needsInboxLabel(t, { label: "other", by: "ai", basis: labelBasis(t) }), false);
  assert.equal(needsInboxLabel(thread("a", { inCount: 2, lastInboundStoredAt: "2026-10-20T09:00:00Z" }), { label: "other", by: "ai", basis: labelBasis(t) }), true);
  assert.equal(needsInboxLabel(thread("a", { inCount: 2 }), { label: "refusal", by: "human", basis: null }), false);
});

test("прохід: AI ставить мітки, невідома відповідь моделі — збій, людська мітка під час роботи лишається", async () => {
  let saved = { [labelKey("acc", "c")]: { label: "refusal", by: "human" } };
  const store = { read: () => saved, write: async (value) => { saved = value; } };
  const answers = { a: "qualified", b: "nonsense" };
  const labeler = inboxLabeler({
    store,
    listThreads: async () => [thread("a"), thread("b"), thread("c"), thread("d", { answered: false })],
    readThread: async () => ({ messages: [{ direction: "in", body: "hi" }] }),
    classify: async ({ person }) => ({ label: answers[person.name] })
  });
  const job = await labeler.run();
  await new Promise((resolve) => { const wait = () => (labeler.status().running ? setTimeout(wait, 5) : resolve()); wait(); });
  assert.equal(job.total, 2, "c — людська, d — ніхто не писав");
  assert.equal(saved[labelKey("acc", "a")].label, "qualified");
  assert.equal(saved[labelKey("acc", "a")].by, "ai");
  assert.equal(saved[labelKey("acc", "b")], undefined);
  assert.equal(labeler.status().failed, 1);
  assert.equal(saved[labelKey("acc", "c")].label, "refusal");
  await assert.rejects(() => labeler.set("acc", "a", "bogus"), /Невідома мітка/);
  assert.equal((await labeler.set("acc", "a", "not_icp")).by, "human");
});

test("модель не відповідає — прохід зупиняється після п'яти відмов поспіль, а розмова відпочиває 2 год (24.11: 14 000 відмов 402 за добу)", async () => {
  const { STOP_AFTER_FAILURES, LABEL_REST_MS } = await import("../warmup/inbox-labels.mjs");
  let clock = 1_000_000;
  let asked = 0;
  const threads = Array.from({ length: 20 }, (_, index) => ({ accountId: "a", threadKey: `t${index}`, answered: true, participant: { name: "X" }, lastMessage: { direction: "in", body: "hi" } }));
  const labeler = inboxLabeler({
    store: { read: () => ({}), write: async () => {} },
    listThreads: async () => threads,
    readThread: async () => ({ messages: [] }),
    classify: async () => { asked += 1; throw new Error("OpenRouter chat HTTP 402"); },
    concurrency: 1,
    clock: () => clock
  });
  const warn = console.warn; console.warn = () => {};
  try {
    await labeler.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asked, STOP_AFTER_FAILURES);
    await labeler.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asked, STOP_AFTER_FAILURES * 2, "наступний прохід бере інші розмови — ті відпочивають");
    clock += LABEL_REST_MS + 1;
    asked = 0;
    await labeler.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asked, STOP_AFTER_FAILURES, "після відпочинку — знову, але не більше п'яти відмов за прохід");
  } finally { console.warn = warn; }
});

test("з ключем Anthropic усе йде через нього; AI_PROVIDER=openrouter повертає старий поділ (власник 24.11)", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /function usesAnthropicForTask\(taskType\) \{\n  if \(!anthropicEnrichKey\(\)\) return false;\n  if \(String\(process\.env\.AI_PROVIDER \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "openrouter"\) return ANTHROPIC_ENRICH_TASKS\.has\(taskType\);\n  return true;\n\}/);
  assert.match(server, /const model = anthropicModelFor\(taskType\);/);
  assert.doesNotMatch(server, /state\.vault && state\.providerHealth\.status === "healthy" \?|!state\.vault \|\| state\.providerHealth\.status !== "healthy"/);
});
