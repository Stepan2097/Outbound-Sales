import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NEEDS_PERSON, alertsFor } from "../triage/account-alerts.mjs";

/**
 * Сповіщення у верхньому куті (Марко 23.10, таск 4e97fa87): лідген бачить свої акаунти, що чекають
 * людину (потрібен вхід, капча), з кроками й «Перевірити вхід»; адмін — усі такі акаунти.
 */

const accounts = [
  { id: "gulaj", status: "warming", health: "needs_login" },
  { id: "chloe", status: "warming", health: "ok" },
  { id: "p47", status: "idle", health: "blocked" },
  { id: "cap", status: "warming", health: "captcha" },
  { id: "gone", status: "excluded", health: "needs_login" }
];
const leadgens = { gulaj: "bogdan", chloe: "bogdan", cap: "lilia" };

test("лідген бачить лише свої акаунти, що чекають людину; заблоковані й виключені — ні", () => {
  assert.deepEqual(NEEDS_PERSON, ["needs_login", "captcha"]);
  assert.deepEqual(alertsFor(accounts, { leadgens, viewerId: "bogdan" }).map((row) => row.id), ["gulaj"]);
  assert.deepEqual(alertsFor(accounts, { leadgens, viewerId: "lilia" }).map((row) => row.id), ["cap"]);
  assert.deepEqual(alertsFor(accounts, { leadgens, viewerId: "nobody" }), []);
});

test("адмін бачить усі акаунти, що чекають людину", () => {
  assert.deepEqual(alertsFor(accounts, { leadgens, viewerId: "admin-1", admin: true }).map((row) => row.id), ["gulaj", "cap"]);
});

test("значок на кожному екрані, кроки для лідгена, «Перевірити вхід» — той самий запит, що посилання з групи", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/screens/account-alerts.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../triage/account-alerts.mjs", import.meta.url), "utf8");
  assert.match(html, /<div class="account-alerts" id="accountAlerts" hidden><\/div>/);
  assert.match(html, /href="\/styles\/account-alerts\.css"/);
  assert.match(ui, /Відкрий в AnyBrowser профіль/);
  assert.match(ui, /Закрий профіль — так AnyBrowser збереже вхід — і натисни «Перевірити вхід»/);
  assert.match(ui, /напиши в чат розробки \(Павлу\)/);
  assert.match(ui, /api\("\/api\/account-alerts\/recheck", \{ method: "POST"/);
  assert.match(server, /type: RECHECK_REQUESTED,/);
  assert.match(server, /meta: \{ nonce, issuedAt: Date\.now\(\), source: "portal" \}/);
});
