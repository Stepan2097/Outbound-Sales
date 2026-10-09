import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * 09.10.2026, the owner: «перероби сторінку Прогрів LinkedIn, щоб воно
 * кешувалося а не кожен раз так довго завантажувалося». The screen read eight
 * things one after another — the config, a sync, the day's numbers, the inbox,
 * the schedule, the campaigns, the accounts, the card — and drew nothing until
 * each had answered. Now it draws what the tab remembers at once and reads
 * everything side by side behind it.
 */

const NAMES = [
  "WARMUP_REMEMBERED", "WARMUP_INBOX_REMEMBERED", "rememberWarmup", "rememberWarmupInbox",
  "warmupRecalled", "warmupInboxRecalled", "recallWarmup", "recallWarmupInbox", "renderWarmupRefreshing", "loadWarmup"
];

function harness({ screens = new Map(), answers = {} } = {}) {
  const drawn = [];
  const asked = [];
  const gates = new Map();
  const warmupState = {
    config: null, dashboard: null, profiles: [], strategy: null, folders: [], foldersReady: false,
    campaigns: [], campaignsReady: false, campaignsError: "", selectedCampaignId: null, unreadReplies: null,
    selectedAccountId: null, busy: false, error: "",
    inbox: { threads: [], accounts: [], unread: 0, sync: null, ready: false, available: true, error: "" }
  };
  // Every read waits for the test to let it through, so "what is on screen
  // before anything answered" is something a test can look at.
  const gate = (name) => new Promise((resolve) => gates.set(name, resolve));
  const read = async (name, value) => { asked.push(name); await gate(name); return value; };
  const button = { disabled: false, classList: { toggle: () => {} }, querySelector: () => ({ textContent: "" }) };
  const main = loadMain(NAMES, {
    warmupState,
    document: { getElementById: (id) => (id === "warmupRefreshBtn" ? button : null) },
    recallScreen: (key) => (screens.has(key) ? { at: 0, value: screens.get(key) } : null),
    rememberScreen: (key, value) => { screens.set(key, JSON.parse(JSON.stringify(value))); },
    setWarmupUnread: () => {},
    warmupEditsInProgress: () => ({ form: false, strategy: false }),
    warmupApi: (path) => read(path, answers[path] ?? { success: true }),
    loadWarmupInbox: async () => { await read("inbox"); Object.assign(warmupState.inbox, { ready: true, unread: 1, threads: [{ threadKey: "t" }] }); },
    loadWarmupStrategy: async (options) => { await read(`strategy:${JSON.stringify(options)}`); warmupState.strategy = { id: "s" }; },
    loadWarmupCampaigns: async () => { await read("campaigns"); warmupState.campaigns = [{ id: "fresh" }]; warmupState.campaignsReady = true; },
    loadWarmupProfiles: async () => { await read("profiles"); warmupState.profiles = [{ id: "p-fresh" }]; drawn.push("profiles:p-fresh"); },
    loadWarmupAccountDetail: async () => {},
    renderWarmupConfigNote: () => drawn.push("config"),
    renderWarmupStats: () => drawn.push("stats"),
    renderWarmupStrategy: () => drawn.push("strategy"),
    renderWarmupCampaigns: () => drawn.push("campaigns"),
    renderWarmupProfiles: () => drawn.push(`profiles:${warmupState.profiles.map((row) => row.id).join(",")}`),
    refreshIcons: () => {}
  });
  const release = async () => {
    for (let round = 0; round < 20; round += 1) {
      for (const [name, open] of [...gates]) { gates.delete(name); open(); }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { warmupState, drawn, asked, screens, main, release };
}

test("after a reload the accounts the tab remembers are drawn before the server has said anything", async () => {
  const screens = new Map([["warmup", { config: { configured: true }, profiles: [{ id: "p-old" }], campaigns: [{ id: "old" }], campaignsReady: true }]]);
  const { drawn, main, release } = harness({ screens, answers: { "/config": { configured: true } } });
  const loading = main.get("loadWarmup")();
  assert.ok(drawn.includes("profiles:p-old"), "nothing was drawn from memory");
  await release();
  await loading;
  assert.ok(drawn.indexOf("profiles:p-fresh") > drawn.indexOf("profiles:p-old"), "the fresh read replaced it");
});

test("every read goes out at once — none waits for the config, the sync or another read", async () => {
  const { asked, main, release, screens, warmupState } = harness({ answers: { "/config": { configured: true } } });
  const loading = main.get("loadWarmup")();
  await new Promise((resolve) => setImmediate(resolve));
  // Nothing has answered yet, and all of them have been asked.
  for (const name of ["/sync", "/config", "/dashboard", "inbox", 'strategy:{"keepDraft":true}', "campaigns", "profiles"]) {
    assert.ok(asked.includes(name), `${name} waited for something before it was asked`);
  }
  await release();
  await loading;
  assert.equal(warmupState.busy, false);
  assert.deepEqual(screens.get("warmup").profiles, [{ id: "p-fresh" }], "the fresh answer is what the next open draws");
  assert.equal(screens.get("inbox").unread, 1, "the inbox is remembered under its own key");
  assert.equal("inbox" in screens.get("warmup"), false, "and not inside the warm-up's, where one screen's save would overwrite the other's");
});

test("nothing that was being edited, nor any selection, is remembered — only the answers", () => {
  const source = readFileSync(new URL("../app/screens/warmup-accounts.js", import.meta.url), "utf8");
  const kept = /const WARMUP_REMEMBERED = \[([^\]]+)\]/.exec(source)[1];
  for (const name of ["strategyDraft", "formOpen", "formCampaignId", "selectedAccountId", "selectedProfileId", "detail", "open"]) {
    assert.equal(kept.includes(`"${name}"`), false, `${name} is kept across reloads`);
  }
});

test("signing out (or a lapsed session) forgets every screen the tab remembered", () => {
  const core = readFileSync(new URL("../app/core.js", import.meta.url), "utf8");
  const gate = core.slice(core.indexOf("function showAuthGate()"), core.indexOf("async function enterWorkspace()"));
  assert.match(gate, /forgetScreens\(\)/);
  const cache = readFileSync(new URL("../app/cache.js", import.meta.url), "utf8");
  assert.match(cache, /sessionStorage/, "the tab's memory, not the browser's: it goes when the tab does");
  assert.doesNotMatch(cache, /localStorage/);
});

test("the warm-up screen opens on the campaign, and the account card is not there until an account is picked", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const view = html.slice(html.indexOf('id="view-warmup"'), html.indexOf('id="view-contacts"'));
  const campaign = view.indexOf('id="warmupCampaignPanel"');
  const accounts = view.indexOf("warmup-list-panel");
  const card = view.indexOf('id="warmupDetailPanel"');
  assert.ok(campaign > 0 && campaign < accounts && accounts < card, "campaign, then accounts, then the card");
  assert.match(view, /id="warmupDetailPanel" hidden/);
  assert.doesNotMatch(view, /Вибери акаунт у таблиці/);
});

test("a failed inbox read is not remembered — the next open would greet somebody with an old error", () => {
  const screens = new Map();
  const { main, warmupState } = harness({ screens });
  Object.assign(warmupState.inbox, { ready: true, error: "Вхідні не вдалося прочитати." });
  main.get("rememberWarmupInbox")();
  assert.equal(screens.has("inbox"), false);
  Object.assign(warmupState.inbox, { error: "" });
  main.get("rememberWarmupInbox")();
  assert.equal(screens.has("inbox"), true);
});
