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

test("auth reset erases Home and Warmup rendered content synchronously, before new screen reads", () => {
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, element("Previous user's private content"));
    return elements.get(id);
  };
  const resets = [];
  const main = loadMain([
    "homeState", "resetHomeScreen", "warmupState", "WARMUP_INITIAL", "warmupRecalled", "warmupInboxRecalled", "resetWarmupScreen"
  ], { document: { getElementById }, onCacheReset: (reset) => { resets.push(reset); } }, [
    "onCacheReset(resetHomeScreen);", "onCacheReset(resetWarmupScreen);"
  ]);
  main.get("homeState").data = { previousUser: true };
  main.get("warmupState").profiles = [{ name: "Private profile" }];
  for (const reset of resets) reset();
  assert.equal(main.get("homeState").data, null);
  assert.equal(main.get("warmupState").profiles.length, 0);
  for (const id of ["homeRoot", "warmupCampaignPanel", "warmupProfileTableBody", "warmupDetailBody", "warmupDetailSubtitle", "warmupSummary", "warmupConfigNote"]) {
    assert.equal(getElementById(id).innerHTML, "", id);
  }
  assert.equal(getElementById("warmupDetailPanel").hidden, true);
  assert.equal(getElementById("warmupDetailTitle").textContent, "Акаунт");
});

test("Home draws an empty loading state before awaiting the next authenticated user's response", async () => {
  const root = element("Previous user's cards");
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  const main = loadMain(["homeState", "HOME_CACHE", "loadHome", "renderHome"], {
    document: { getElementById: () => root },
    getCacheEpoch: () => 0, recallScreen: () => null, rememberScreen: () => {},
    warmupApi: () => pending, draftMissing: () => {}, refreshIcons: () => {}, escapeHtml: String
  });
  const opening = main.get("loadHome")();
  assert.match(root.innerHTML, /Завантажуємо головну/);
  assert.doesNotMatch(root.innerHTML, /Previous user's/);
  resolve(null);
  await opening;
});
