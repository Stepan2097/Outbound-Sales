import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleEspApi } from "../esp/api.mjs";
import { campaignStore } from "../esp/campaigns.mjs";
import { useJournal } from "../esp/journal.mjs";
import { addDomain, addSender, setDomainStatus } from "../esp/registry.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP-UI 1 і 3, коло 2 (суддя 12.10): у списку видно, чия кампанія; перегляд
 * листа з порожньою змінною показує сам лист і підсвічує діру, а не лише
 * помилку; «Надіслати тест» іде собі на пошту через шлюз — а поки справжня
 * відправка вимкнена, каже це прямо.
 */

const ADMIN = { email: "Stepan@Advantage-Agency.co", role: "admin" };

async function setup(t, { liveSend = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "esp-ui2-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: "anna@advantage-mail.com", rampStage: 35 }, "test");
  let templates = [];
  let campaigns = [];
  let enrollments = [];
  const sent = [];
  const tstore = templateStore({ read: () => templates, write: async (value) => { templates = value; } });
  const esp = {
    templates: tstore,
    signature: { read: () => ({ name: "Anna", company: "ADvantage" }) },
    unsubscribe: { secret: "test-unsubscribe-secret-0123456789", base: null },
    connector: { liveSend },
    halt: { read: () => ({ on: false }) },
    gate: { send: async (mailbox, raw) => { sent.push({ mailbox, raw }); return { id: "m-1" }; } },
    campaigns: campaignStore({
      read: () => campaigns, write: async (value) => { campaigns = value; },
      readEnrollments: () => enrollments, writeEnrollments: async (value) => { enrollments = value; }, templates: () => templates
    })
  };
  const call = async (method, path, body = {}) => {
    let captured = null;
    await handleEspApi({
      request: { method, auth: { profile: ADMIN } }, response: {}, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_response, status, payload) => { captured = { status, payload }; }, readJson: async () => body, esp
    });
    return captured;
  };
  return { call, sent, esp };
}

test("the list says whose campaign it is: the person who created it", async (t) => {
  const { call } = await setup(t);
  const created = await call("POST", "/campaigns", { name: "Northwind pilot" });
  assert.equal(created.status, 201);
  assert.equal(created.payload.campaign.createdBy, "stepan@advantage-agency.co");
  const list = await call("GET", "/campaigns");
  assert.equal(list.payload.campaigns[0].owner, "stepan@advantage-agency.co");
});

test("a preview with an empty variable shows the letter with the hole marked, not only an error", async (t) => {
  const { call } = await setup(t);
  const answer = await call("POST", "/preview", { subject: "Question for {{company}}", body: "Hi {{first_name}}, a question about {{company|your team}}.", lead: { email: "lead@example.com", company: "Northwind" } });
  assert.equal(answer.payload.ok, false, "it still would not go");
  assert.deepEqual(answer.payload.variables, ["first_name"]);
  assert.equal(answer.payload.draft.subject, "Question for Northwind");
  assert.equal(answer.payload.draft.body, "Hi ⟦first_name⟧, a question about Northwind.");
});

test("«Надіслати тест» is refused in words while real sending is off, and nothing is sent", async (t) => {
  const { call, sent } = await setup(t, { liveSend: false });
  const answer = await call("POST", "/test-send", { subject: "Hello", body: "Hi {{first_name|there}}", mailbox: "anna@advantage-mail.com" });
  assert.equal(answer.status, 409);
  assert.equal(answer.payload.code, "sending_locked");
  assert.match(answer.payload.error, /ESP_LIVE_SEND/);
  assert.equal(sent.length, 0);
  assert.equal((await call("GET", "/halt")).payload.liveSend, false, "the screen knows to grey the button out");
});

test("with real sending on, the test goes to the person's own mailbox through the gate", async (t) => {
  const { call, sent } = await setup(t, { liveSend: true });
  const answer = await call("POST", "/test-send", { subject: "Hello", body: "Hi {{first_name|there}}, a question.", mailbox: "anna@advantage-mail.com", lead: { name: "Olena Koval" } });
  assert.equal(answer.payload.ok, true);
  assert.equal(answer.payload.to, "stepan@advantage-agency.co");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mailbox, "anna@advantage-mail.com");
  assert.match(sent[0].raw, /^To: .*stepan@advantage-agency\.co/m);
  assert.match(sent[0].raw, /Hi Olena, a question\./);
  const unknown = await call("POST", "/test-send", { subject: "Hello", body: "Hi", mailbox: "nobody@elsewhere.com" });
  assert.equal(unknown.status, 409, "only a registered mailbox sends");
});

test("Головна: one letter to one lead is locked while real sending is off, and goes through the pre-send checks when it is on", async (t) => {
  const locked = await setup(t, { liveSend: false });
  const refused = await locked.call("POST", "/send-one", { lead: { email: "olena@northwind.com" }, mailbox: "anna@advantage-mail.com", subject: "Hello", body: "Hi" });
  assert.equal(refused.status, 409);
  assert.equal(refused.payload.code, "sending_locked");
  assert.equal(locked.sent.length, 0);
});

test("Головна: an unverified lead does not get the letter, and is told why", async (t) => {
  const live = await setup(t, { liveSend: true });
  live.esp.filters = { context: async () => ({}), check: async () => ({ ok: false, reason: "not_verified", detail: "" }) };
  const refused = await live.call("POST", "/send-one", { lead: { email: "olena@northwind.com" }, mailbox: "anna@advantage-mail.com", subject: "Hello", body: "Hi" });
  assert.equal(refused.status, 409);
  assert.match(refused.payload.error, /Не піде/);
  assert.equal(live.sent.length, 0);
});
