import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { describeCampaign, normalizeCampaign, parseScenario } from "../warmup/campaigns.mjs";
import { DEFAULT_SPINE, MAX_STEPS, SCENARIO_TEMPLATES, cleanPlan, cleanSpine, handleScenarioApi, scenarioForPrompt } from "../warmup/scenarios.mjs";

// Сценарій кампанії як в артефакті «Кампанії лідгену» (таск f78ffd9a, 16.10):
// сигнал, гіпотеза, ціль, флоу з шаблонами, розгалуження, де персоналізувати; хребет — один.

test("чотири кампанії з артефакту — готові шаблони з повним сценарієм", () => {
  assert.deepEqual(SCENARIO_TEMPLATES.map((template) => template.name), [
    "Оператори, що вже ллють Meta", "Вигоріли на банах Meta → In-App / Unity", "Зміна ролі — найсильніший сигнал часу", "Консультант / агенція → партнер"
  ]);
  for (const template of SCENARIO_TEMPLATES) {
    const plan = cleanPlan(template.plan);
    assert.ok(plan.signal && plan.hypothesis && plan.goal && plan.branches && plan.personalize, `${template.name}: усі поля`);
    assert.ok(plan.steps.length >= 3, `${template.name}: флоу з кроків`);
    assert.match(plan.steps[0].label, /Опенер/, `${template.name}: починається з опенера`);
    assert.deepEqual(plan, cleanPlan(plan), "шаблон уже чистий — збережеться як є");
  }
  assert.equal(SCENARIO_TEMPLATES[0].productId, "fb-training");
  assert.equal(SCENARIO_TEMPLATES[1].productId, "inapp-unity");
});

test("сценарій кампанії чиститься, зберігається з кампанією й віддається клієнту", () => {
  const raw = { signal: "  CMO  ", steps: [...Array(20)].map((_, index) => ({ label: `Крок ${index}`, text: "x" })).concat([{ label: "", text: "" }]), junk: "drop me", branches: "a\n\n\n\nb" };
  const plan = cleanPlan(raw);
  assert.equal(plan.signal, "CMO");
  assert.equal(plan.steps.length, MAX_STEPS);
  assert.equal(plan.branches, "a\n\nb");
  assert.equal("junk" in plan, false);

  const parsed = parseScenario({ plan: raw });
  assert.equal(parsed.value.plan.steps.length, MAX_STEPS);
  assert.equal("plan" in parseScenario({ approach: "x" }).value, false, "PATCH без сценарію не стирає збережений");

  const campaign = normalizeCampaign({ id: "c-1", name: "A", folderId: "f", plan: SCENARIO_TEMPLATES[0].plan });
  assert.equal(describeCampaign(campaign).plan.steps.length, SCENARIO_TEMPLATES[0].plan.steps.length);
  assert.deepEqual(normalizeCampaign({ id: "old", name: "Warm-up", folderId: "f" }).plan.steps, [], "стара кампанія — без сценарію, не ламається");
});

test("модель отримує флоу кампанії й хребет; хребет за замовчуванням — з артефакту", () => {
  const campaign = normalizeCampaign({ id: "c-1", name: "Meta ops", folderId: "f", approach: "SiGMA Rome", plan: SCENARIO_TEMPLATES[0].plan });
  const prompt = scenarioForPrompt(campaign, null);
  assert.equal(prompt.campaign.approach, "SiGMA Rome");
  assert.equal(prompt.campaign.flow.length, 5);
  assert.match(prompt.campaign.branches, /не перформить/);
  assert.equal(prompt.spine.rules, DEFAULT_SPINE.rules);
  assert.match(prompt.howToUse, /never invent/);

  const edited = scenarioForPrompt(campaign, { ladder: "Свій крок", routes: "", rules: "Без смайлів" });
  assert.equal(edited.spine.qualificationLadder, "Свій крок");
  assert.equal(edited.spine.rules, "Без смайлів");
  assert.equal(cleanSpine({}).ladder, DEFAULT_SPINE.ladder, "частина без правки — як в артефакті");
});

test("хребет змінює лише адміністратор; читають усі", async () => {
  let saved = null;
  const run = async (method, path, profile, body) => {
    let answer = null;
    await handleScenarioApi({
      request: { method }, response: {}, url: new URL(`http://x${path}`), profile,
      sendJson: (_, status, payload) => { answer = { status, payload }; },
      readJson: async () => body,
      spineStore: { read: () => saved, write: async (value) => { saved = value; } }
    });
    return answer;
  };
  const read = await run("GET", "/api/scenarios", { role: "seller" });
  assert.equal(read.status, 200);
  assert.equal(read.payload.templates.length, 4);
  assert.equal(read.payload.canEditSpine, false);
  assert.equal((await run("PUT", "/api/scenarios/spine", { role: "seller" }, { rules: "x" })).status, 403);
  assert.equal(saved, null);
  const put = await run("PUT", "/api/scenarios/spine", { role: "admin" }, { rules: "Нове правило" });
  assert.equal(put.status, 200);
  assert.equal(saved.rules, "Нове правило");
  assert.equal(saved.ladder, DEFAULT_SPINE.ladder);
});

test("відповідь у «Сьогодні» пишеться за сценарієм кампанії й хребтом", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const today = server.slice(server.indexOf("async function writeTodayDraft"), server.indexOf("/** The workspace lead that came from this CRM contact"));
  assert.match(today, /scenario: scenarioForPrompt\(campaign, state\.campaignSpine\)/);
  assert.match(today, /follow scenario\.howToUse/);
});
