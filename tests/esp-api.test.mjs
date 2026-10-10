import assert from "node:assert/strict";
import test from "node:test";

import { handleEspApi } from "../esp/api.mjs";
import { MailboxError, StubGmailConnector } from "../esp/gmail.mjs";

async function call({ method = "GET", path, body = null, role = "admin", esp }) {
  let answer = null;
  const handled = await handleEspApi({
    request: { method, auth: { profile: { role } } },
    response: {},
    url: new URL(`http://x/api/esp${path}`),
    sendJson: (_response, status, payload) => { answer = { status, payload }; },
    readJson: async () => body,
    esp
  });
  return { handled, ...answer };
}

const stubbed = () => ({ connector: new StubGmailConnector({ domains: ["advantage-mail.com"] }), keyError: null });

test("only an administrator reaches the mailboxes", async () => {
  const seller = await call({ path: "/connection", role: "seller", esp: stubbed() });
  assert.equal(seller.status, 403);
});

test("the connection says which connector runs, that sending is locked, and why a given key is not used", async () => {
  const plain = await call({ path: "/connection", esp: stubbed() });
  assert.equal(plain.payload.mode, "stub");
  assert.equal(plain.payload.liveSend, false);
  assert.equal(plain.payload.keyError, null);
  const broken = await call({ path: "/connection", esp: { ...stubbed(), keyError: "Ключ сервісного акаунта — не JSON." } });
  assert.match(broken.payload.keyError, /не JSON/);
});

test("checking a mailbox: yes with what Google says, or no with the reason — never a failed request", async () => {
  const ok = await call({ method: "POST", path: "/mailboxes/check", body: { mailbox: "anna@advantage-mail.com" }, esp: stubbed() });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.ok, true);
  const refused = await call({ method: "POST", path: "/mailboxes/check", body: { mailbox: "anna@elsewhere.com" }, esp: stubbed() });
  assert.equal(refused.status, 200);
  assert.equal(refused.payload.ok, false);
  assert.equal(refused.payload.code, "mailbox_rejected");
  const delegation = { connector: { checkMailbox: async () => { throw new MailboxError("немає делегування", { code: "delegation_missing" }); }, describe: () => ({}) } };
  const missing = await call({ method: "POST", path: "/mailboxes/check", body: { mailbox: "a@b.com" }, esp: delegation });
  assert.equal(missing.payload.code, "delegation_missing");
  const bad = await call({ method: "POST", path: "/mailboxes/check", body: null, esp: stubbed() });
  assert.equal(bad.status, 400);
});

test("there is no route that sends — ESP 1 connects and checks, nothing more", async () => {
  const send = await call({ method: "POST", path: "/send", body: { mailbox: "anna@advantage-mail.com" }, esp: stubbed() });
  assert.equal(send.handled, false);
});

test("paused mailboxes are listed, and a person lifts one", async () => {
  const pauses = { "anna@advantage-mail.com": { code: "delegation_missing", reason: "немає делегування", at: "2026-10-10T08:00:00.000Z" } };
  const gate = {
    paused: async () => Object.entries(pauses).map(([mailbox, pause]) => ({ mailbox, ...pause })),
    resume: async (mailbox) => { const had = Boolean(pauses[mailbox]); delete pauses[mailbox]; return had; }
  };
  const esp = { ...stubbed(), gate };
  const listed = await call({ path: "/senders/paused", esp });
  assert.deepEqual(listed.payload.paused.map((row) => row.mailbox), ["anna@advantage-mail.com"]);
  const lifted = await call({ method: "POST", path: "/senders/resume", body: { mailbox: "anna@advantage-mail.com" }, esp });
  assert.equal(lifted.payload.resumed, true);
  assert.deepEqual(lifted.payload.paused, []);
  const empty = await call({ method: "POST", path: "/senders/resume", body: {}, esp });
  assert.equal(empty.status, 400);
});
