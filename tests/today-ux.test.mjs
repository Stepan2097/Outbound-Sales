import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Аудит UX 16.10 (таск 57bc1f99): «Сьогодні» — чіпи блоків фільтрують чергу, статус
// зберігається при виборі, адмін у «Мої» бачить шлях до пінгів команди, у робочому
// місці — кампанія ліда.

const TODAY = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");
const API = readFileSync(new URL("../triage/today.mjs", import.meta.url), "utf8");

test("лічильники блоків — кнопки-фільтри, а не текст", () => {
  assert.match(TODAY, /data-today="block" data-block="\$\{escapeAttr\(key\)\}"/);
  assert.match(TODAY, /if \(act === "block"\)/);
  assert.match(TODAY, /today\.blockFilter && today\.blockFilter !== key/, "черга показує лише вибраний блок");
});

test("статус у CRM зберігається при виборі; кнопки «Зберегти статус» немає", () => {
  assert.doesNotMatch(TODAY, />Зберегти статус</, "кнопки в розмітці немає");
  assert.doesNotMatch(TODAY, /status-save/);
  assert.match(TODAY, /if \(changed && \(!closing \|\| draft\.exitReason\)\) return void saveStatus\(\)/);
  assert.match(API, /defaultExit: DEFAULT_EXIT/, "клієнт знає причину за замовчуванням для «Не ICP» і «Без відповіді»");
});

test("адмін у «Мої» з порожнім списком бачить кнопку до пінгів команди", () => {
  assert.match(TODAY, /data\.canSeeAll && today\.scope === "mine"/);
  assert.match(TODAY, /Показати пінги команди/);
});

test("робоче місце називає кампанію ліда", () => {
  assert.match(API, /campaign: campaignOf\(state\?\.campaignId\)/);
  // 19.10 (В1): кампанія — у шапці розмови, поруч з акаунтом.
  assert.match(TODAY, /item\.campaign \? `<span class="warmup-subtle">\$\{escapeHtml\(item\.campaign\.name/);
});

test("вибір дати переносить лише повну дату від сьогодні; Головна пише чернетки про продукт «Смислів»", () => {
  assert.match(TODAY, /value < first/, "минула чи неповна дата з клавіатури ігнорується");
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const prep = server.slice(server.indexOf("function prepareTriageContact"), server.indexOf("function prepareTriageContact") + 400);
  assert.match(prep, /const product = draftProduct\(options\.productId \|\| ""\)/);
  assert.doesNotMatch(prep, /state\.products\.find/);
});
