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
