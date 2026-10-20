import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cleanNewContactPolicy, handleTodayApi, newContactsUsedToday, policyGate, setNewContactPolicyStore
} from "../triage/today.mjs";

/**
 * Скільки нових контактів лідген бере, коли в нього є живі розмови (Марко 19.10, таск
 * 2f86eb9e): «правило не змінюємо, можемо лише додати в налаштуваннях опцію вручну для
 * Богдана або іншого лідгена зняти обмеження, або дозволити обмежену кількість».
 */

test("without a setting the rule stays: new contacts only when replies and overdue are done", () => {
  assert.deepEqual(policyGate({ policy: undefined, replies: 3, overdue: 0 }), { allowed: false, busy: true, mode: "gate", limit: null, used: 0 });
  assert.equal(policyGate({ policy: undefined, replies: 0, overdue: 0 }).allowed, true);
  assert.equal(policyGate({ policy: { mode: "nonsense" }, replies: 1 }).allowed, false, "невідоме — як завжди");
});

test("«До N на день»: open while fewer than N were taken today, closed at N", () => {
  const policy = { mode: "limit", limit: 5 };
  assert.equal(policyGate({ policy, replies: 85, overdue: 36, used: 2 }).allowed, true);
  assert.equal(policyGate({ policy, replies: 85, overdue: 36, used: 5 }).allowed, false);
  assert.equal(policyGate({ policy, replies: 0, overdue: 0, used: 9 }).allowed, true, "без розмов норма не потрібна");
});

test("«Без обмеження»: always open", () => {
  assert.equal(policyGate({ policy: { mode: "open" }, replies: 85, overdue: 36, used: 40 }).allowed, true);
});

test("the setting is cleaned: the limit is a whole number from 1 to 100", () => {
  assert.deepEqual(cleanNewContactPolicy({ mode: "limit", limit: "7.4" }), { mode: "limit", limit: 7 });
  assert.deepEqual(cleanNewContactPolicy({ mode: "limit", limit: 0 }), { mode: "limit", limit: 5 });
  assert.deepEqual(cleanNewContactPolicy({ mode: "limit", limit: 1000 }), { mode: "limit", limit: 100 });
  assert.deepEqual(cleanNewContactPolicy({ mode: "open", limit: 3 }), { mode: "open" });
});

test("today's new contacts: people taken from the conveyor by this person today, each once", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const row = (over) => ({ at: "2026-10-19T09:00:00Z", user: "bohdan@x.co", action: "invited", source: "triage", contactId: "1", ...over });
  const entries = [
    row({}),
    row({ action: "wrote", channel: "email", contactId: "1" }), // та сама людина — раз
    row({ action: "wrote", contactId: "2" }),
    row({ contactId: "3", source: null }), // не з конвеєра (перше повідомлення з «До роботи»)
    row({ contactId: "4", user: "someone@x.co" }),
    row({ contactId: "5", at: "2026-10-18T09:00:00Z" }),
    row({ contactId: "6", action: "skipped" })
  ];
  assert.equal(newContactsUsedToday(entries, { email: "bohdan@x.co", now }), 2);
});

async function call(method, viewer, body) {
  let answer = null;
  await handleTodayApi({
    request: { method }, response: {}, url: new URL("http://x/api/today/new-contact-policy"),
    sendJson: (_, status, payload) => { answer = { status, payload }; },
    readJson: async () => body, viewer
  });
  return answer;
}

test("only an admin reads or changes the setting; a seller gets 403", async () => {
  let saved = {};
  setNewContactPolicyStore({ read: () => saved, write: async (value) => { saved = value; } });
  const seller = { id: "s", role: "seller", email: "bohdan@x.co" };
  assert.equal((await call("POST", seller, { email: "bohdan@x.co", mode: "open" })).status, 403);
  assert.equal((await call("GET", seller)).status, 403);
  assert.deepEqual(saved, {});

  const admin = { id: "a", role: "admin", email: "stepan@x.co" };
  const set = await call("POST", admin, { email: "Bohdan@X.co", mode: "limit", limit: 5 });
  assert.equal(set.status, 200);
  assert.equal(saved["bohdan@x.co"].mode, "limit");
  assert.equal(saved["bohdan@x.co"].limit, 5);
  await call("POST", admin, { email: "bohdan@x.co", mode: "gate" });
  assert.equal("bohdan@x.co" in saved, false, "«як завжди» — без запису");
});

test("the conveyor's sends say where they come from, and WorkSpace rechecks the gate after them", () => {
  const triage = readFileSync(new URL("../app/screens/home-triage.js", import.meta.url), "utf8");
  for (const route of ["/api/warmup/first-messages/send", "/api/esp/send-one", "/api/warmup/invites"]) {
    const at = triage.indexOf(`api("${route}"`);
    assert.ok(at > -1 && triage.slice(at, at + 400).includes('source: "triage"'), `${route}: source triage`);
  }
  const workspace = readFileSync(new URL("../app/screens/new-contacts.js", import.meta.url), "utf8");
  assert.match(workspace, /addEventListener\("triage:outreach"/);
  assert.match(workspace, /Нових сьогодні: <b>\$\{data\.used\} з \$\{data\.limit\}<\/b>/);
});
