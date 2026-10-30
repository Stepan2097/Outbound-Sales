import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { diagnoseScreen, parseDiagnosis } from "../warmup/diagnose.mjs";

/**
 * Власник 30.10: сповіщення писало «LinkedIn просить увійти» на все, що не стрічка. Тепер знімок
 * екрана, на якому агент зупинився, читає модель, і в сповіщенні — те, що показав LinkedIn.
 */

test("відповідь моделі: JSON з видом і реченням; невідомий вид — other; без речення — нічого", () => {
  assert.deepEqual(parseDiagnosis('```json\n{"kind":"restricted","sentence":"LinkedIn тимчасово обмежив акаунт."}\n```'),
    { kind: "restricted", sentence: "LinkedIn тимчасово обмежив акаунт." });
  assert.equal(parseDiagnosis('{"kind":"weird","sentence":"Щось"}').kind, "other");
  assert.equal(parseDiagnosis('{"kind":"login"}'), null);
  assert.equal(parseDiagnosis("not json"), null);
});

test("знімок іде моделі картинкою разом з текстом сторінки; без ключа чи знімка — нічого не питає", async () => {
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: '{"kind":"password","sentence":"LinkedIn просить пароль для Mary Lindsay."}' }] }) };
  };
  const seen = await diagnoseScreen({ shot: "/9j/AAAA", text: "З поверненням! Mary Lindsay Пароль", url: "https://www.linkedin.com/login/" }, { key: "k", fetchImpl });
  assert.deepEqual(seen, { kind: "password", sentence: "LinkedIn просить пароль для Mary Lindsay." });
  const [image, text] = sent.messages[0].content;
  assert.equal(image.source.media_type, "image/jpeg");
  assert.match(text.text, /З поверненням! Mary Lindsay/);
  assert.equal(await diagnoseScreen({ shot: "/9j/AAAA" }, { key: "", fetchImpl }), null);
  assert.equal(await diagnoseScreen({ shot: "" }, { key: "k", fetchImpl }), null);
  assert.equal(await diagnoseScreen({ shot: "/9j/" }, { key: "k", fetchImpl: async () => { throw new Error("down"); }, onFail: () => {} }), null);
});

test("агент шле знімок з health, портал пише прочитане в примітку, сповіщення показує її замість «просить увійти»", () => {
  const agent = readFileSync(new URL("../agent/run-account.mjs", import.meta.url), "utf8");
  const api = readFileSync(new URL("../warmup/api.mjs", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/screens/account-alerts.js", import.meta.url), "utf8");
  assert.match(agent, /portal\.health\(reason === 'checkpoint' \? 'captcha' : 'needs_login', `LinkedIn: \$\{reason\} at \$\{url\}`, screen\.shot \? screen : null\)/);
  assert.match(api, /diagnoseScreen\(\{ shot: body\.shot, text: body\.text, url: body\.url \}\)/);
  assert.match(api, /\.eq\("health_changed_at", now\)/);
  assert.match(ui, /const what = read \|\| /);
});
