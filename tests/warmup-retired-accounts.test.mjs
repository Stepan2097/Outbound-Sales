import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { retiredAccount } from "../warmup/api.mjs";

/**
 * 12.10, власник: «оскільки він заблокований, то мені вже не треба всюди пихати
 * жовтою плашкою». Заблокований у LinkedIn або виключений з прогріву акаунт
 * прибрано людиною: його розмови читаються, але він нічого не просить.
 */

test("blocked or excluded is put away; needing a login or a captcha is not", () => {
  assert.equal(retiredAccount({ health: "blocked", status: "active" }), true);
  assert.equal(retiredAccount({ health: "ok", status: "excluded" }), true);
  assert.equal(retiredAccount({ health: "needs_login", status: "active" }), false, "a login to fix still asks for somebody");
  assert.equal(retiredAccount({ health: "ok", status: "active" }), false);
  assert.equal(retiredAccount(null), false);
});

test("the screens keep a put-away account quiet: no yellow note, no red row, one button to put it away", () => {
  const inbox = readFileSync(new URL("../app/screens/inbox.js", import.meta.url), "utf8");
  const home = readFileSync(new URL("../app/screens/home.js", import.meta.url), "utf8");
  const card = readFileSync(new URL("../app/screens/warmup-accounts.js", import.meta.url), "utf8");
  const api = readFileSync(new URL("../warmup/api.mjs", import.meta.url), "utf8");
  assert.match(inbox, /warmupInboxRetired\(openId\)\s*\?\s*`<div class="warmup-inbox-note is-calm">/, "the open retired account gets a calm note, not «агент зупинився»");
  assert.match(inbox, /data-warmup-retired-toggle/, "retired accounts sit in their own folded group");
  assert.match(home, /retiredLineHtml/, "Головна names them once, quietly");
  assert.match(card, /data-warmup-block="blocked"/);
  assert.match(card, /data-warmup-block="ok"/);
  assert.match(api, /const live = described\.filter\(\(account\) => !retiredAccount\(account\)\)/, "not in «who sends» or «attention»");
  assert.match(api, /unreadReplies = await liveUnreadCount\(\)/, "the menu badge does not count them");
});
