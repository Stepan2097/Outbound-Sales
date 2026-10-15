import assert from "node:assert/strict";
import test from "node:test";
import { loadMain } from "./app-main-excerpt.mjs";

function element(initial) {
  let content = initial;
  return {
    hidden: false,
    get innerHTML() { return content; }, set innerHTML(value) { content = value; },
    get textContent() { return content; }, set textContent(value) { content = value; }
  };
}

test("auth reset erases Warmup rendered content synchronously, before new screen reads", () => {
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, element("Previous user's private content"));
    return elements.get(id);
  };
  const resets = [];
  const main = loadMain([
    "warmupState", "WARMUP_INITIAL", "warmupRecalled", "warmupInboxRecalled", "resetWarmupScreen"
  ], { document: { getElementById }, onCacheReset: (reset) => { resets.push(reset); } }, [
    "onCacheReset(resetWarmupScreen);"
  ]);
  main.get("warmupState").profiles = [{ name: "Private profile" }];
  for (const reset of resets) reset();
  assert.equal(main.get("warmupState").profiles.length, 0);
  // The campaign panel keeps its markup and listeners; what carried the last
  // person's campaigns is cleared (12.10: an empty frame stayed for the session).
  for (const id of ["warmupCampaignList", "warmupCampaignDetail", "warmupProfileTableBody", "warmupDetailBody", "warmupDetailSubtitle", "warmupSummary", "warmupConfigNote"]) {
    assert.equal(getElementById(id).innerHTML, "", id);
  }
  assert.equal(getElementById("warmupCampaignPanel").innerHTML === "", false, "the panel itself is not wiped");
  assert.equal(getElementById("warmupDetailPanel").hidden, true);
  assert.equal(getElementById("warmupDetailTitle").textContent, "Акаунт");
});
