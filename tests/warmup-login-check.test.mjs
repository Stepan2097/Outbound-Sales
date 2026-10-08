import assert from "node:assert/strict";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { MAX_AGE_MS, issueLoginCheck, loginCheckUrl, readLoginCheck } from "../warmup/login-check.mjs";

/**
 * The link in the warm-up's Telegram group: «вже залогінився — продовжити».
 *
 * It is the one address in this application that is opened with no session at
 * all — from a phone, out of a group chat — so its signature *is* its
 * authorisation, and that is what this file is about. The inline callback
 * button it replaces could not be used: a callback needs `getUpdates` on the
 * bot, that reading is exclusive, and on 08.10.2026 it swallowed the owner's
 * replies meant for another chat on the same bot.
 */

const TOKEN = "агентський-токен-для-тестів";
// The route reads the key from the environment, like it does on the server.
// Set here so the file is green on its own, not only inside a suite that
// happens to have it.
process.env.WARMUP_AGENT_TOKEN = TOKEN;
const ACCOUNT = "1ce29111-2766-49f6-847a-fef45e915c40";
const NOW = Date.parse("2026-10-08T09:00:00Z");

test("підписане посилання читається назад — і тільки тим самим ключем", () => {
  const value = issueLoginCheck(ACCOUNT, { token: TOKEN, now: NOW, nonce: "nnn" });
  assert.deepEqual(readLoginCheck(value, { token: TOKEN, now: NOW }), {
    ok: true, accountId: ACCOUNT, issuedAt: NOW, nonce: "nnn"
  });
  // Інший токен — інший ключ: посилання з іншого середовища тут не працює.
  assert.deepEqual(readLoginCheck(value, { token: "інший-токен", now: NOW }), { ok: false, why: "bad_signature" });
});

test("підмінений акаунт не проходить: підпис накриває весь вміст", () => {
  const value = issueLoginCheck(ACCOUNT, { token: TOKEN, now: NOW });
  const [payload, signature] = value.split(".");
  const swapped = Buffer.from(JSON.stringify({ a: "чужий-акаунт", t: NOW, n: "nnn" }))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.deepEqual(readLoginCheck(`${swapped}.${signature}`, { token: TOKEN, now: NOW }), { ok: false, why: "bad_signature" });
  // І обрізаний підпис — теж відмова, а не падіння.
  assert.deepEqual(readLoginCheck(`${payload}.${signature.slice(0, -4)}`, { token: TOKEN, now: NOW }), { ok: false, why: "bad_signature" });
});

test("посилання не живе вічно — у груповому чаті воно лежить довше, ніж має діяти", () => {
  const value = issueLoginCheck(ACCOUNT, { token: TOKEN, now: NOW });
  assert.equal(readLoginCheck(value, { token: TOKEN, now: NOW + MAX_AGE_MS - 1000 }).ok, true);
  assert.deepEqual(readLoginCheck(value, { token: TOKEN, now: NOW + MAX_AGE_MS + 1000 }), { ok: false, why: "expired" });
  // Посилання, штамповане в майбутньому, теж відмовляється: інакше «коли
  // видано» перестає щось означати для перевірки віку.
  const ahead = issueLoginCheck(ACCOUNT, { token: TOKEN, now: NOW + 10 * 60_000 });
  assert.deepEqual(readLoginCheck(ahead, { token: TOKEN, now: NOW }), { ok: false, why: "malformed" });
});

test("сміття, порожнє й несервіруваний ключ — три різні відмови, і жодного винятку", () => {
  assert.deepEqual(readLoginCheck("", { token: TOKEN, now: NOW }), { ok: false, why: "malformed" });
  assert.deepEqual(readLoginCheck("не.посилання", { token: TOKEN, now: NOW }), { ok: false, why: "bad_signature" });
  assert.deepEqual(readLoginCheck("щось", { token: TOKEN, now: NOW }), { ok: false, why: "malformed" });
  assert.deepEqual(readLoginCheck("a.b", { token: "", now: NOW }), { ok: false, why: "not_configured" });
  assert.throws(() => issueLoginCheck(ACCOUNT, { token: "" }), /WARMUP_AGENT_TOKEN/);
});

test("кожне видане посилання — одноразове: два поспіль мають різні nonce", () => {
  const first = readLoginCheck(issueLoginCheck(ACCOUNT, { token: TOKEN, now: NOW }), { token: TOKEN, now: NOW });
  const second = readLoginCheck(issueLoginCheck(ACCOUNT, { token: TOKEN, now: NOW }), { token: TOKEN, now: NOW });
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.nonce, second.nonce, "інакше вчорашнє посилання з чату відповідало б на сьогоднішнє питання");
});

test("адреса для кнопки збирається від кореня порталу, без подвійних слешів", () => {
  const url = loginCheckUrl("https://outbound.example/", ACCOUNT, { token: TOKEN, now: NOW, nonce: "n" });
  assert.match(url, /^https:\/\/outbound\.example\/api\/warmup\/login-check\?t=/);
  const value = decodeURIComponent(new URL(url).searchParams.get("t"));
  assert.equal(readLoginCheck(value, { token: TOKEN, now: NOW }).accountId, ACCOUNT);
});

/**
 * Відмови сторінки перевіряються без жодної бази: підпис читається до того, як
 * маршрут щось питає в Anty, і саме тому його відмова мусить бути сторінкою, а
 * не п'ятисоткою.
 */
test("сторінка відмовляє на чуже посилання людською мовою і не чіпає базу", async () => {
  for (const [value, status, expected] of [
    ["", 400, /неповне/i],
    ["підроблене.посилання", 400, /не наше/i]
  ]) {
    const written = { status: 0, body: "", headers: null };
    const response = {
      writeHead(code, headers) { written.status = code; written.headers = headers; },
      end(body) { written.body = String(body ?? ""); }
    };
    const handled = await handleWarmupApi({
      request: { method: "GET", headers: {} },
      response,
      url: new URL(`https://outbound.example/api/warmup/login-check?t=${encodeURIComponent(value)}`),
      sendJson: () => { throw new Error("сторінка мусить бути HTML, а не JSON"); },
      readJson: async () => null,
      campaigns: { read: () => [], readTargeting: () => null, write: async () => {} }
    });
    assert.equal(handled, true);
    assert.equal(written.status, status);
    assert.match(written.headers["Content-Type"], /text\/html/);
    assert.match(written.body, expected);
  }
});
