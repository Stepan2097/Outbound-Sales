import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { archivePitchProduct, loadPitchBook, pitchCardForPrompt, pitchCatalogForPrompt, pitchFallbackBrief, pitchProductList } from "../knowledge/pitch.mjs";
import { pitchProductOptions } from "../app/pitch-options.js";

// Продукти LinkedIn-кампаній і AI-чернеток — картки «Смислів» (таск f78ffd9a, 16.10).
// Старі продукти AI-чернеток (advantage-course = Black Affiliate white-label apps, AdAction)
// у вибір не потрапляють: через них чернетка в «Сьогодні» пітчила не той продукт.

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

test("вибір продукту кампанії — поточні картки «Смислів», архівних і старих продуктів AI немає", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "outbound-pitch-products-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await loadPitchBook(join(dir, "state.json"));

  assert.deepEqual(pitchProductList().map((product) => product.id), ["fb-training", "fb-audit", "inapp-unity", "google-playbook", "platform", "traffic"]);
  const options = pitchProductOptions(pitchProductList(), "", esc, esc);
  assert.match(options, /^<option value="" selected>Без продукту — AI підбере з каталогу<\/option>/);
  assert.match(options, /FB навчання — Black Affiliate · пріоритет/);
  assert.doesNotMatch(options, /advantage-course|AdAction|black-affiliate|adaction/i);

  await archivePitchProduct("traffic", "test");
  assert.equal(pitchProductList().some((product) => product.id === "traffic"), false, "архівний продукт зникає з вибору");
  assert.match(pitchProductOptions(pitchProductList(), "traffic", esc, esc), /traffic · немає в «Смислах»/, "кампанія, що на нього вказує, бачить це, а не порожнє поле");
});

test("чернетка бере картку «Смислів»: пітч, розділи, що слати; без продукту — каталог «кому й коли»", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "outbound-pitch-products-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await loadPitchBook(join(dir, "state.json"));

  const card = pitchCardForPrompt("fb-training");
  assert.equal(card.name, "FB навчання — Black Affiliate");
  assert.ok(card.pitch && card.dmOneLiner);
  assert.ok(card.sections.some((section) => section.title === "Не обіцяти"), "і те, чого не обіцяти");
  assert.ok(card.sendInDm.length > 0);
  assert.equal(pitchCardForPrompt("black-affiliate"), null, "старий продукт AI — не картка");

  const catalog = pitchCatalogForPrompt();
  assert.equal(catalog.length, 6);
  assert.ok(catalog.every((item) => item.name && item.pitch && (item.whom || item.when)), "кожен продукт каталогу каже, кому він або коли його пропонувати");
  assert.ok(pitchFallbackBrief("fb-training").offer, "чернетка без моделі теж має з чого писати");
});

test("сервер віддає кампаніям і чернеткам продукти «Смислів», а не state.products", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /products: \(\) => pitchProductList\(\)/, "кампанії перевіряють productId за «Смислами»");
  const writers = server.match(/const product = draftProduct\(/g) || [];
  assert.ok(writers.length >= 3, "перше повідомлення, чернетки картки й відповідь у «Сьогодні» — через draftProduct");
  assert.doesNotMatch(server.slice(server.indexOf("async function writeTodayDraft")), /^\s*const product = state\.products\.find/m);
});
