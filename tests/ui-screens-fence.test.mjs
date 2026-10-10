import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The interface is five screens, and this is what keeps it five.
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
 *
 * It was four until 10.10.2026, when the owner asked for a home page built
 * around what the software is for — sending runs by itself and the model writes
 * the messages. «Головна» is that: the conveyor from a folder to a reply, and the
 * first messages to people who accepted, written by the model, to approve. It is
 * not the removed «overview» (an OpenRouter traffic dashboard): nothing of that
 * comes back with it.
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

const SCREENS = [["home", "Головна"], ["warmup", "Прогрів"], ["email", "Листи"], ["inbox", "Вхідні"], ["contacts", "Контакти"], ["account", "Налаштування"]];

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

test("the menu is exactly the five screens, in this order", () => {
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

test("the workspace opens on «Головна»", () => {
  const all = sources().map(({ text }) => text).join("\n");
  assert.match(all, /setView\(saved \|\| "home"\)/, "a first visit lands on Головна");
  assert.match(html, /<button class="nav-item active" data-view="home"/);
});

/**
 * One file per screen, so that two people — or two chats — can change two
 * screens at once without editing the same file. The shell in `core.js` knows
 * the screens only by name; each screen module registers itself (`onScreen`)
 * and `main.js` does nothing but load them and start.
 */
const SCREEN_FILES = {
  home: ["screens/home.js"],
  warmup: ["screens/warmup-accounts.js", "screens/warmup-campaign.js"],
  inbox: ["screens/inbox.js"],
  contacts: ["screens/contacts.js"],
  account: ["screens/settings.js"]
};

test("each screen has its own module and stylesheet, and registers itself", () => {
  for (const [view, files] of Object.entries(SCREEN_FILES)) {
    const code = files.map((file) => readFileSync(new URL(file, APP), "utf8")).join("\n");
    assert.match(code, new RegExp(`onScreen\\("${view}"`), `${view} registers itself`);
    for (const file of files) {
      const sheet = file.replace(/^screens\//, "styles/").replace(/\.js$/, ".css");
      assert.ok(html.includes(`href="/${sheet}"`), `${sheet} is linked from index.html`);
    }
  }
  assert.ok(html.includes('href="/styles/base.css"'), "the shared styles come first");
  const core = readFileSync(new URL("core.js", APP), "utf8");
  assert.equal(/from "\.\/screens\//.test(core), false, "the shell imports no screen");
});

test("main.js only loads the screens and starts", () => {
  const entry = readFileSync(new URL("main.js", APP), "utf8");
  const code = entry.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//"));
  // Imports and the two start calls. Twelve since the mail panels (ESP 1 and
  // ESP 9) became modules of their own on «Налаштування»: one line each.
  assert.ok(code.length <= 12, `main.js grew to ${code.length} lines of code — screen code belongs in screens/`);
  assert.equal(/function /.test(entry), false, "no functions in the entry");
});

/**
 * Every name a page module imports is exported by the module it names. A
 * missing export is a SyntaxError in the browser before anything runs — the
 * page shows the sign-in form and nothing else — and node never loads these
 * files, so nothing else here would notice. It happened once while the page
 * was being split into screens.
 */
test("every import in the page's modules is exported by its target", () => {
  const exportsOf = (url) => {
    const text = readFileSync(url, "utf8");
    return new Set([...text.matchAll(/^export (?:async )?(?:function|let|const|class) ([A-Za-z0-9_$]+)/gm)].map((match) => match[1]));
  };
  const modules = sources().filter(({ path }) => path.endsWith(".js"));
  assert.ok(modules.length >= 7, "the shell, the entry and the screens are all read");
  for (const { path, text } of modules) {
    for (const match of text.matchAll(/import \{([^}]*)\} from "([^"]+)";/g)) {
      const target = new URL(match[2], `file://${path}`);
      const exported = exportsOf(target);
      for (const name of match[1].split(",").map((part) => part.trim()).filter(Boolean)) {
        assert.ok(exported.has(name), `${path.replace(APP.pathname, "app/")} imports ${name}, which ${match[2]} does not export`);
      }
    }
  }
});
