import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { digestDue, digestText, freshReplies, leadgenTelegram, replyText } from "../triage/leadgen-notify.mjs";

/**
 * Сповіщення лідгенам у Telegram (таск 15.10): відповідь ліда — одразу; о 09:00
 * за Києвом у робочі дні — що чекає сьогодні. Лише надсилання, оновлень бота
 * не читаємо.
 */

test("без токена чи чату — нічого не шле і не падає; чат — свій або група входів", async () => {
  assert.equal(leadgenTelegram({}).configured, false);
  assert.equal(await leadgenTelegram({ TELEGRAM_BOT_TOKEN: "t" }).send("x"), false);
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  await leadgenTelegram({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_LOGIN_CHAT_ID: "-100" }, { fetch }).send("hi");
  await leadgenTelegram({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_LOGIN_CHAT_ID: "-100", OUTBOUND_TELEGRAM_CHAT_ID: "-200" }, { fetch }).send("hi");
  assert.deepEqual(calls.map((call) => call.body.chat_id), ["-100", "-200"]);
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.doesNotMatch(calls[0].url, /getUpdates/);
});

test("відповідь: хто, через який акаунт, що написав, де відповісти; ім'я без «Переглянути профіль»", () => {
  const text = replyText({ name: "Переглянути профіль Luke", headline: "CMO at Betano", account: "gulajpole", messages: [{ body: "Sure, let's talk next week" }], url: "https://x/#inbox" });
  assert.match(text, /^💬 Відповів Luke — CMO at Betano/);
  assert.match(text, /через gulajpole/);
  assert.match(text, /«Sure, let's talk next week»/);
  assert.match(text, /Відповісти: https:\/\/x\/#inbox/);
});

test("стара історія при першому читанні акаунта — не новина; за один раз не більше п'яти", () => {
  const now = new Date("2026-10-15T10:00:00Z");
  const old = { body: "old", sentAt: "2026-09-01T10:00:00Z", sentAtIso: true };
  const fresh = { body: "new", sentAt: "2026-10-15T09:00:00Z", sentAtIso: true };
  const undated = { body: "?", sentAt: "Mon", sentAtIso: false };
  assert.deepEqual(freshReplies([old, fresh, undated], { now }).map((row) => row.body), ["new", "?"]);
  assert.equal(freshReplies(Array.from({ length: 9 }, () => fresh), { now }).length, 5);
});

test("ранковий рядок: лише те, що чекає, з числами; порожній день — так і сказано", () => {
  const full = digestText({ unread: [{ name: "Ana" }, { name: "Bo" }], planned: { total: 16, carried: 7 }, accepted: 21, yesterday: { written: 10, replies: 3 }, url: "https://x" });
  assert.match(full, /Чекають відповіді: 2 — Ana, Bo/);
  assert.match(full, /Написати повторно: 16 \(з них перенесено з минулих днів: 7\)/);
  assert.match(full, /чекають першого повідомлення: 21/);
  assert.match(full, /Вчора написали 10 людям, відповідей прийшло: 3/);
  const empty = digestText({ yesterday: { written: 1, replies: 0 } });
  assert.match(empty, /Нічого не чекає/);
  assert.match(empty, /написали 1 людині/);
});

test("коли слати: робочий день, 09:00–12:00 за Києвом, раз на день", () => {
  assert.equal(digestDue(new Date("2026-10-15T06:10:00Z"), "").due, true, "чт 09:10 Київ (UTC+3)");
  assert.equal(digestDue(new Date("2026-10-15T05:50:00Z"), "").due, false, "08:50 — ще рано");
  assert.equal(digestDue(new Date("2026-10-15T10:00:00Z"), "").due, false, "13:00 — запізно");
  assert.equal(digestDue(new Date("2026-10-15T06:10:00Z"), "2026-10-15").due, false, "уже надіслано");
  assert.equal(digestDue(new Date("2026-10-17T07:00:00Z"), "").due, false, "субота");
  assert.equal(digestDue(new Date("2026-10-26T07:30:00Z"), "").due, true, "пн після переходу на зимовий (UTC+2): 09:30");
});

test("проводка: агентове inbox.thread кличе сповіщення; відповідь агенту — без тексту повідомлень; ранковий цикл з вимикачем", async () => {
  const api = await readFile(new URL("../warmup/api.mjs", import.meta.url), "utf8");
  assert.match(api, /if \(onReply && result\.inbound\?\.length\)/);
  assert.match(api, /const \{ inbound: _inbound, \.\.\.answer \} = result;/);
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /onReply: announceReply,/);
  assert.match(server, /process\.env\.LEADGEN_TELEGRAM !== "off"/);
  assert.match(server, /state\.leadgenDigestSentOn = today;\n  await writePersistentWorkspaceState\(\);\n  await leadgenBot\.send/);
});
