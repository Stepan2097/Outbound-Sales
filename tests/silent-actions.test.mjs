import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Марко 19.10 (таск e4a00a5b): «Кнопка "Розмітити нові відповіді" нічого не робить» і
 * «навіть якщо я виберу папку, продукт і мову, нічого не відбувається».
 */

const report = readFileSync(new URL("../app/screens/campaign-report.js", import.meta.url), "utf8");
const triage = readFileSync(new URL("../app/screens/home-triage.js", import.meta.url), "utf8");

test("the labelling button shows only when there are replies without a label, with their count", () => {
  assert.match(report, /const unlabeled = \(data\?\.campaigns \|\| \[\]\)\.reduce/);
  assert.match(report, /Розмітити нові відповіді \(\$\{unlabeled\}\)/);
  assert.match(report, /Усі відповіді розмічено · AI робить це сам кожні 10 хв/);
});

test("the conveyor says what it is, says it is searching, and rewrites the text when the product or language changes", () => {
  assert.match(triage, /Оберіть папку бази — і тут з\\'явиться перша людина/);
  assert.match(triage, /Шукаю \$\{triage\.cursor \? "наступну" : "першу"\} людину в папці/);
  assert.match(triage, /field === "product" \|\| field === "language"[\s\S]{0,400}if \(triage\.item\?\.contact\) \{[\s\S]{0,300}void draftTexts\(\);/);
});
