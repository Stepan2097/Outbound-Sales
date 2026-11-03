import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Таск 10b3bb63 (Марко 03.11): «Збагатити» непомітна; після натискання «нічого не відбулось»;
// поруч дрібно — скільки пішло.

const CARD = readFileSync(new URL("../app/screens/home-triage.js", import.meta.url), "utf8");
const SERVER = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("кнопка — основна, під час пошуку видно, що він іде, і скільки секунд", () => {
  assert.match(CARD, /class="primary-button triage-enrich-button" data-triage="enrich"/);
  assert.match(CARD, /<span data-enrich-seconds>\$\{seconds\}<\/span> с · публічний пошук → платні пошуковики → перевірка знайдених пошт/);
  assert.match(CARD, /clearInterval\(ticker\)/);
});

test("після пошуку — завжди явний підсумок: додано, вже є, або «нічого нового, шукали в …»", () => {
  assert.match(CARD, /Додано в базу:/);
  assert.match(CARD, /Знайдене вже є в базі — нового не додано\./);
  assert.match(CARD, /Нічого нового\$\{where\.length \? `, шукали в: /);
  assert.match(CARD, /Пошук не вдався: /);
  assert.match(CARD, /Сховано \$\{enrich\.hiddenEmails\.length\}/, "сховане — з причиною");
  assert.match(SERVER, /hiddenEmails,\n    searched: enrichSearchedView\(discovery, candidates\),\n    cost: enrichCostView\(discovery, signalsSpend\),/);
});

test("дрібно — токени й гроші цього пошуку", () => {
  assert.match(CARD, /<p class="triage-enrich-cost">\$\{ai\} · \$\{money\}/);
  assert.match(CARD, /токенів\$\{cost\.webSearches \? ` і \$\{cost\.webSearches\} вебпошуків` : ""\} на сигнали компанії/);
  assert.match(SERVER, /costUsd: actorRuns\.some\(\(run\) => run\.costUsd != null\)/);
  assert.match(SERVER, /Object\.defineProperty\(items, "run", \{ value: apifyRunView\(run\), enumerable: false \}\)/);
});

test("суддя 03.11: знайдене іншої компанії не показується як знайдене — окремо «Не записано … схоже, інша компанія» з причиною", () => {
  assert.match(SERVER, /crmPatch\(contact, \{ candidates, checks, company: prospect\.company \}\)/);
  assert.match(SERVER, /!skipped\.some\(\(row\) => row\.value\.toLowerCase\(\) === String\(item\.value\)\.trim\(\)\.toLowerCase\(\)\)\),\n    skipped,/);
  assert.match(CARD, /Не записано \$\{enrich\.skipped\.length\} — схоже, інша компанія/);
  assert.match(CARD, /Нового не додано: знайдене схоже на іншу компанію — нижче чому\./);
});

test("перейшли на іншу картку під час пошуку — «Шукаємо…» і лічильник знімаються, а не крутяться без кінця", () => {
  const body = CARD.slice(CARD.indexOf("const ticker = setInterval"), CARD.indexOf("function tookNewContact"));
  assert.ok(body.indexOf("clearInterval(ticker)") < body.indexOf("if (moved) return;"), "лічильник знято до виходу");
  assert.doesNotMatch(body.slice(0, body.indexOf("clearInterval(ticker)")), /\breturn;/);
});

test("суддя 03.11 (коло 2): сигнали, перешукані цим натисканням, — у ціні: токени Claude і запуски постів Apify", () => {
  assert.match(SERVER, /const signalsBefore = prospect\.publicAccountSignals;/);
  assert.match(SERVER, /prospect\.publicAccountSignals !== signalsBefore \? prospect\.publicAccountSignals\.spend \|\| null : null/);
  assert.match(SERVER, /cost: enrichCostView\(discovery, signalsSpend\),/);
  assert.match(SERVER, /tokens: Number\(signals\?\.tokens \|\| 0\),/);
  assert.match(SERVER, /runs: contactRuns \+ signalRuns,/);
  assert.match(SERVER, /costUsd: found\.costUsd,\n      spend: found\.spend/);
});
