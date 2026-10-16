import assert from "node:assert/strict";
import test from "node:test";

import { platformOf, userTags, withUserTags } from "../warmup/platform.mjs";

// Теги профілю Anty в таблиці акаунтів (власник 16.10): видно й редагуються;
// тег платформи (linkedin) — не їхній, його ні показ, ні редагування не чіпає.

test("показуються власні теги профілю, як їх написали в Anty, без тегу платформи", () => {
  assert.deepEqual(userTags(["живий", "linkedin", "Ban", { name: "BM" }, "ban", " "]), ["живий", "Ban", "BM"]);
  assert.deepEqual(userTags(null), []);
});

test("редагування міняє лише власні теги: тег платформи лишається, повтори й порожні — ні, наявний тег — у своїй формі", () => {
  const before = [{ name: "Ban", color: "red" }, "linkedin"];
  const next = withUserTags(before, ["ban", "  живий  ", "Живий", "", "LinkedIn", "x".repeat(60)]);
  assert.deepEqual(next, [{ name: "Ban", color: "red" }, "живий", "x".repeat(40), "linkedin"]);
  assert.equal(platformOf({ tags: next }), "linkedin");
  assert.deepEqual(withUserTags(before, []), ["linkedin"], "усі власні теги можна прибрати");
});
