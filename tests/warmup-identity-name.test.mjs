import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NOT_A_NAME } from "../warmup/store.mjs";

// 20.10: акаунт Chloe Stewart у «Вхідних» звався «Переглянути зображення» — підпис
// картинки з поста, прочитаний агентом як ім'я того, хто залогінений.

test("слова LinkedIn на картинці — не ім'я; справжні імена — так", () => {
  for (const text of ["Переглянути зображення", "View image", "Фото профілю", "Profile photo of Chloe", "Зображення обкладинки"]) assert.equal(NOT_A_NAME.test(text), true, text);
  for (const text of ["Chloe Stewart", "Gener Antonio Lara Uicab", "Lourdes Abigail Duran Garibay", "Victoria Imagen", "Tom Showalter"]) assert.equal(NOT_A_NAME.test(text), false, text);
});

test("агент не бере підпис картинки за ім'я акаунта", () => {
  const run = readFileSync(new URL("../agent/run-account.mjs", import.meta.url), "utf8");
  const filter = new RegExp(run.match(/!\/(linkedin\|logo[^/]+)\/i\.test\(text\)/)[1], "i");
  for (const text of ["Переглянути зображення", "View image", "Фото профілю"]) assert.equal(filter.test(text), true, text);
  for (const text of ["Chloe Stewart", "Victoria Imagen", "Tom Showalter"]) assert.equal(filter.test(text), false, text);
});
