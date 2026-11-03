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

test("пояснення збою: модель отримує помилку, хід сесії, що вже зроблено, і знімок — повертає причину й що далі", async () => {
  const { explainFailure, parseExplanation } = await import("../warmup/diagnose.mjs");
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: '{"cause":"Сервер Outbound завис на пів хвилини, поки агент надсилав запити.","next":"Агент спробує знову сам за кілька хвилин."}' }] }) };
  };
  const said = await explainFailure({ label: "Profile 42", error: "портал Outbound не відповів за 30 с", record: "зроблено: invite — Antoine", done: "закрив браузер" }, { key: "k", fetchImpl });
  assert.deepEqual(said, { cause: "Сервер Outbound завис на пів хвилини, поки агент надсилав запити.", next: "Агент спробує знову сам за кілька хвилин." });
  const [text] = sent.messages[0].content;
  assert.match(text.text, /Помилка: портал Outbound не відповів за 30 с/);
  assert.match(text.text, /Що система вже зробила: закрив браузер/);
  assert.equal(parseExplanation('{"next":"x"}'), null);
  // Знімок читається окремим запитом, а пояснення отримує його словами — без картинки (03.11: картинка входу + «чому збій» = відмова).
  const bodies = [];
  const twoStep = async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    const text = body.messages[0].content[0].type === "image" ? '{"kind":"password","sentence":"LinkedIn просить пароль."}' : '{"cause":"Сесію LinkedIn завершено.","next":"Увійти в профілі."}';
    return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
  };
  assert.deepEqual(await explainFailure({ shot: "/9j/AAAA", error: "e" }, { key: "k", fetchImpl: twoStep }), { cause: "Сесію LinkedIn завершено.", next: "Увійти в профілі." });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages[0].content.length, 1);
  assert.match(bodies[1].messages[0].content[0].text, /На знімку екрана: LinkedIn просить пароль\./);
});
