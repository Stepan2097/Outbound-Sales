import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const port = 43201;
const origin = `http://127.0.0.1:${port}`;

test("AdAction analysis persists a complete source-locked A-M strategy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-strategy-test-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), STATE_FILE_PATH: join(directory, "state.json"), AUTH_DEV_BYPASS: "1" },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));

  try {
    await waitForHealth();
    await post("/api/products/select", { productId: "adaction-value-exchange-ua" });
    const state = await post("/api/prospects/intelligence/analyze", { prospectId: "seed-maya-chen", useAi: false, force: true });
    const prospect = state.prospects.find((item) => item.id === "seed-maya-chen");
    const strategy = prospect.leadIntelligence.prospecting_strategy;

    assert.equal(strategy.methodology, "adaction-prospecting-strategy-copilot-v2");
    assert.ok(strategy.executive_assessment.summary);
    assert.ok(strategy.recent_signals.length);
    assert.ok(strategy.title_analysis.length);
    assert.ok(strategy.growth_hypotheses.length >= 2);
    assert.ok(strategy.stakeholder_map.length);
    assert.ok(strategy.recommended_first_touch.linkedin.body);
    assert.ok(strategy.conversation_tree.length >= 3);
    assert.equal(strategy.adaction_transition.commercial_framework, "Model -> Test -> Measure -> Scale");
    assert.ok(strategy.consultation_cta.ask);
    assert.ok(strategy.multi_thread_sequence.length);
    assert.ok(strategy.risks.length);
    assert.deepEqual(Object.keys(strategy.account_scores), ["fit", "timing", "potential_scale", "accessibility", "confidence"]);
    assert.ok(strategy.decision_summary.best_question);
    assert.match(strategy.recommended_first_touch.linkedin.body, /Outreach is blocked/);
    assert.doesNotMatch(strategy.recommended_first_touch.linkedin.body, /test for unknown title/i);
    assert.equal(strategy.internal_readiness_gate.outreach_allowed, false);

    const allowedSourceIds = new Set(prospect.leadIntelligence.sources.map((source) => source.source_id));
    for (const signal of strategy.recent_signals) {
      assert.ok(signal.source_ids.every((sourceId) => allowedSourceIds.has(sourceId)));
      if (signal.claim_type === "known_fact") assert.ok(signal.source_ids.length > 0);
    }

    const publishedAt = new Date(Date.now() - 12 * 86_400_000).toISOString();
    await post("/api/prospects/import", {
      prospects: [{
        id: "test-policy-sensitive-account",
        name: "Fardeen Ghulam",
        title: "SVP Growth",
        company: "Budge Studios",
        notes: "Children and family app publisher. App: Bluey: Let's Play. Public privacy policy says no IDFA or GAID for advertising and contextual advertising only.",
        linkedin: "https://www.linkedin.com/in/fardeen-ghulam/",
        appPortfolio: {
          apps: [{ title: "Bluey: Let's Play", os: "iOS and Android", geo: "Global", monetization: "Subscription", evidenceSourceIds: ["src-app-bluey"] }],
          evidence: [{ source_id: "src-app-bluey", url: "https://example.com/bluey", title: "Bluey public store listing", publisher: "Public app store", source_type: "app_store", evidence_excerpt: "Children and family subscription app", quality: "high", claim_type: "fact" }]
        },
        publicAccountSignals: {
          checkedAt: new Date().toISOString(),
          results: [{ source_id: "signal-budge-update", title: "Bluey app update", url: "https://example.com/bluey-update", publisher: "Public publisher", snippet: "Bluey received a significant product update.", signal_type: "product_or_title", published_at: publishedAt, retrieved_at: new Date().toISOString(), confidence: 74, claim_type: "public_source_claim" }]
        }
      }]
    });
    let policyState = await post("/api/prospects/intelligence/analyze", { prospectId: "test-policy-sensitive-account", useAi: false, force: true });
    let policyProspect = policyState.prospects.find((item) => item.id === "test-policy-sensitive-account");
    assert.equal(policyProspect.leadIntelligence.prospecting_strategy.internal_readiness_gate.status, "conditional_internal_review");
    assert.equal(policyProspect.leadIntelligence.prospecting_strategy.internal_readiness_gate.outreach_allowed, false);
    assert.ok(policyProspect.leadIntelligence.research_gaps.some((gap) => /internal policy, supply/i.test(gap.missing_field)));
    assert.ok(policyProspect.leadIntelligence.prospecting_strategy.recent_signals.some((signal) => signal.source_ids.includes("signal-budge-update")));

    await post("/api/prospects/policy-decision", { prospectId: "test-policy-sensitive-account", status: "approved_conditions", note: "Test-only approval." });
    policyState = await post("/api/prospects/intelligence/analyze", { prospectId: "test-policy-sensitive-account", useAi: false, force: true });
    policyProspect = policyState.prospects.find((item) => item.id === "test-policy-sensitive-account");
    assert.equal(policyProspect.leadIntelligence.prospecting_strategy.internal_readiness_gate.status, "approved_with_conditions");
    assert.equal(policyProspect.leadIntelligence.prospecting_strategy.internal_readiness_gate.outreach_allowed, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function post(path, body) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start.");
}
