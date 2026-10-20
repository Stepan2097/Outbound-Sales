import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { newContactsGate } from "../triage/today.mjs";

/**
 * Конвеєр нових контактів живе у WorkSpace → «Нові контакти» (Марко 19.10, таск 328da367),
 * а не на Головній. Правило без змін: спершу свої відповіді й прострочені пінги.
 */

const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/screens/new-contacts.js", import.meta.url), "utf8");
const today = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");

function viewOf(id) {
  const start = html.indexOf(`id="view-${id}"`);
  const end = html.indexOf('<section class="view"', start + 10);
  return html.slice(start, end === -1 ? undefined : end);
}

// З 20.10 (Марко, таск f50d24e9) конвеєр — у Вхідні → «Нові», з правилом «спершу розмови».
test("the conveyor's root sits in Вхідні → «Нові», not in WorkSpace and not on Головна", () => {
  assert.match(viewOf("inbox"), /data-inbox-tab="new"[^>]*>Нові</);
  assert.match(viewOf("inbox"), /<div data-inbox-pane="new" hidden>\s*<div id="triageGate"><\/div>\s*<div class="triage-page" id="triageRoot"><\/div>/);
  assert.doesNotMatch(viewOf("workspace"), /triageRoot|data-ws-tab/);
  assert.doesNotMatch(viewOf("home"), /triageRoot/);
});

test("«Нові» open the conveyor only through the gate, and the queue itself never does", () => {
  assert.match(workspace, /import \{ openTriage \} from "\.\/home-triage\.js"/);
  assert.match(workspace, /api\("\/api\/today\/gate"\)/);
  assert.match(workspace, /if \(allowed && !\(recheck && wasAllowed\)\) await openTriage\(\)/);
  assert.doesNotMatch(today, /openTriage|home-triage/);
});

test("the campaigns, the comparison and the spine stay in WorkSpace", () => {
  for (const id of ["leadCampaignPanel", "campaignReportRoot", "workspaceSpinePanel"]) assert.match(viewOf("workspace"), new RegExp(`id="${id}"`));
});

test("without pings configured the gate never closes the conveyor", async () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (/^(WARMUP_CRM|ANTY|SUPABASE)/.test(key)) delete process.env[key];
    const gate = await newContactsGate({ viewerId: "someone" });
    assert.equal(gate.allowed, true);
  } finally {
    Object.assign(process.env, saved);
  }
});
