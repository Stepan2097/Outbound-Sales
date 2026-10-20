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

test("ім'я акаунта — останнє справжнє: один невдалий зчит його не перебиває", async () => {
  const { knownIdentity } = await import("../warmup/store.mjs");
  const login = (who, at) => ({ meta: { who }, created_at: at });
  const events = [login("Переглянути зображення", "2026-10-20T08:43:00Z"), login("Переглянути зображення", "2026-10-20T06:05:00Z"), login("Chloe Stewart", "2026-10-19T15:00:00Z")];
  assert.equal(knownIdentity(events).name, "Chloe Stewart");
  assert.equal(knownIdentity([login("Mary Lindsay", "2026-10-20T09:00:00Z"), login("Chloe Stewart", "2026-10-19T15:00:00Z")]).name, "Mary Lindsay", "новий справжній вхід — нове ім'я");
  assert.equal(knownIdentity([]), null);
});
