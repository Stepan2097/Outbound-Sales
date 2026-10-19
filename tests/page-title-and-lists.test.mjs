import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Марко 19.10 (таск 02cb2276): «назву сторінки зверху можна забрати, це звільнить місце»
 * і «деякі списки дуже розтягуються донизу, замість робочого скролу».
 */

const grammar = readFileSync(new URL("../app/styles/grammar.css", import.meta.url), "utf8");
const work = readFileSync(new URL("../app/screens/work.js", import.meta.url), "utf8");
const leads = readFileSync(new URL("../app/screens/mail-leads.js", import.meta.url), "utf8");

test("the page title is gone on a computer; the bar shows only when there is a status line", () => {
  assert.match(grammar, /@media \(min-width: 721px\) \{\n  \.topbar h1 \{ display: none; \}\n  \.topbar:has\(#workspaceMeta\[hidden\]\) \{ display: none; \}/);
});

test("long lists scroll inside their block instead of stretching the page", () => {
  const rule = grammar.slice(grammar.indexOf(".scroll-list,"), grammar.indexOf("}", grammar.indexOf(".scroll-list,")));
  for (const selector of [".work-plan-list", ".work-rows", ".warmup-list-panel .table-wrap", ".leads-table-wrap", ".unibox-list", ".pitch-list"]) assert.ok(rule.includes(selector), selector);
  assert.match(rule, /max-height: min\(560px, 62vh\);\n  overflow-y: auto;/);
  assert.match(work, /<ol class="work-plan-list scroll-list">/);
  assert.match(work, /<div class="work-rows scroll-list">/);
  assert.match(leads, /class="table-wrap leads-table-wrap"/);
});

// Суддя 19.10 (коло 1): позиція прокрутки не губиться після дій і автооновлення;
// на телефоні черга «До роботи» й список розмов теж гортаються всередині себе.
import { loadMain } from "./app-main-excerpt.mjs";

test("a list that is redrawn keeps where it was scrolled to", () => {
  const { get } = loadMain(["keepScroll"]);
  const elements = { ".work-rows": { scrollTop: 840 }, ".work-plan-list": { scrollTop: 0 } };
  const root = { querySelector: (selector) => elements[selector] || null };
  const restore = get("keepScroll")(root, [".work-rows", ".work-plan-list"]);
  // Перемальовано: нові елементи стартують з нуля.
  elements[".work-rows"] = { scrollTop: 0 };
  elements[".work-plan-list"] = { scrollTop: 0 };
  restore();
  assert.equal(elements[".work-rows"].scrollTop, 840);
  assert.equal(elements[".work-plan-list"].scrollTop, 0);
});

test("По днях, ліди пошти і черга «До роботи» перемальовуються з keepScroll; на телефоні списки мають свою висоту", () => {
  assert.match(work, /const restore = keepScroll\(root, \[".work-rows", ".work-plan-list"\]\);\n  root\.innerHTML = [^\n]+\n  restore\(\);/);
  assert.match(leads, /const restore = keepScroll\(main, \[".leads-table-wrap"\]\);/);
  const today = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");
  assert.match(today, /const restoreScroll = keepScroll\(host, \[".today-queue"\]\);/);
  const todayCss = readFileSync(new URL("../app/styles/today.css", import.meta.url), "utf8");
  const inboxCss = readFileSync(new URL("../app/styles/inbox.css", import.meta.url), "utf8");
  assert.match(todayCss, /@media \(max-width: 900px\) \{\n  \.today-queue \{ max-height: 60vh; overflow-y: auto; \}/);
  assert.match(inboxCss, /@media \(max-width: 900px\) \{\n  \.inbox-list \{ max-height: 65vh; overflow-y: auto; \}\n\}\s*$/);
});
