import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The interface is four screens, and this is what keeps it four.
 *
 * On 08.10.2026 the owner asked for everything superfluous to go (87001c96):
 * the lead workspace («Панель») with its enrichment, scoring, drafts and
 * follow-ups, the AI operator, «Продукти», and six hidden screens of an
 * OpenRouter gateway. None of it was in use — the lead workspace had not
 * changed since 02.10 and the model had been called once, ever. What lives is
 * the warm-up, its replies and the CRM contacts.
 *
 * Removed once before, it came back: the merge f20ee6d on 02.10 brought the
 * screens of a long-lived branch back with it, and nobody noticed for days.
 * A merge like that now turns this test red instead of quietly undoing the
 * work. If a screen really has to return, change this test in the same commit
 * and say why — that is a decision, not an accident.
 */

const APP = new URL("../app/", import.meta.url);
const html = readFileSync(new URL("index.html", APP), "utf8");

function sources(dir = APP.pathname) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(m?js|html|css)$/.test(name) ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

const SCREENS = [["warmup", "Прогрів"], ["inbox", "Вхідні"], ["contacts", "Контакти"], ["account", "Налаштування"]];

const REMOVED_VIEWS = ["prospects", "ai", "products", "overview", "models", "routing", "budgets", "privacy", "evaluation"];

// One function or element per removed screen is enough to notice it coming
// back; these are the ones a merge would carry along with it.
const REMOVED_CODE = [
  "renderProspects", "renderSelectedProspect", "renderPanelSource", "renderInvite", "researchAndPrepareSelected",
  "renderAssistant", "renderAgents", "runAssistantTask",
  "renderProductWorkspace", "renderKnowledgeEditor",
  "renderOverview", "drawTrafficChart", "renderModels", "renderRouting", "renderBudgets", "renderPrivacy", "renderEvaluation",
  'id="runDialog"', 'id="quickPrepareBtn"', 'id="productSelect"'
];

test("the menu is exactly the four screens, in this order", () => {
  const nav = [...html.matchAll(/<button class="nav-item[^"]*" data-view="([a-z-]+)"[^>]*>.*?<span>([^<]+)<\/span>/g)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(nav, SCREENS);
  const views = [...html.matchAll(/<section class="view[^"]*" id="view-([a-z-]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(views, SCREENS.map(([view]) => view).sort(), "a screen for every menu item and no other");
});

test("no removed screen is back in the page", () => {
  for (const view of REMOVED_VIEWS) {
    assert.equal(html.includes(`id="view-${view}"`), false, `view-${view} is back in app/index.html`);
    assert.equal(html.includes(`data-view="${view}"`), false, `a menu item for ${view} is back`);
  }
});

test("no removed screen's code is back anywhere under app/", () => {
  for (const { path, text } of sources()) {
    for (const name of REMOVED_CODE) {
      assert.equal(text.includes(name), false, `${name} is back in ${path.replace(APP.pathname, "app/")}`);
    }
  }
});

test("the workspace opens on the warm-up", () => {
  const all = sources().map(({ text }) => text).join("\n");
  assert.match(all, /setView\(saved \|\| "warmup"\)/, "a first visit lands on Прогрів");
  assert.match(html, /<button class="nav-item active" data-view="warmup"/);
});
