import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * ESP-UI 1–3 (власник 12.10): «Кампанії» — справжня сторінка, не блоки в
 * Налаштуваннях: список, створення, конструктор у чотири кроки, редактор
 * листа. Тут — те, що ламається тихо: кнопка без обробника, сторінка, що
 * випала з меню, повернені старі панелі «Листів», метрика відкриттів.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const html = read("app/index.html");
const page = read("app/screens/mail-campaigns.js");

test("the page is in the menu, mounted, wired and styled", () => {
  assert.match(html, /data-view="campaigns"[^>]*><i[^>]*><\/i><span>Кампанії<\/span>/);
  assert.match(html, /<section class="view" id="view-campaigns">[\s\S]*?id="mailCampaignsRoot"/);
  assert.match(html, /href="\/styles\/mail-campaigns\.css"/);
  assert.match(read("app/screens/esp.js"), /import "\.\/mail-campaigns\.js";/);
  assert.match(page, /onScreen\("campaigns"/);
});

test("every button the page draws has a handler", () => {
  const drawn = new Set([...page.matchAll(/data-mc="([a-z-]+)"/g)].map((match) => match[1]));
  const handled = new Set([...page.matchAll(/case "([a-z-]+)":/g)].map((match) => match[1]));
  for (const action of drawn) assert.ok(handled.has(action), `data-mc="${action}" has no case in onClick`);
  // Keyed buttons (data-mc-open, data-mc-step, …) are read by their dataset name.
  const notButtons = new Set(["input", "editor", "form", "select", "delay", "menu-tool"]);
  const keyed = new Set([...page.matchAll(/data-mc-([a-z-]+)=/g)].map((match) => match[1]).filter((name) => !notButtons.has(name)));
  const camel = (name) => `mc${name.replace(/(^|-)([a-z])/g, (_, __, letter) => letter.toUpperCase())}`;
  for (const name of keyed) assert.ok(page.includes(`dataset.${camel(name)}`), `data-mc-${name} is drawn but never read`);
});

test("the old «Листи» panels are gone, and nothing counts opens or clicks", () => {
  for (const id of ["espCampaignsBody", "espTemplatesBody", "espEditorBody", "espLimitsBody", "espSignatureBody", "espAlertsBody", "view-email"]) {
    assert.equal(html.includes(`id="${id}"`), false, `${id} is back in app/index.html`);
  }
  assert.doesNotMatch(page, /<th>[^<]*(відкритт|клік|open|click)/i, "a column for opens or clicks");
  assert.doesNotMatch(page, /contenteditable|innerHTML\s*=\s*editor/i, "the letter editor is plain text");
});
