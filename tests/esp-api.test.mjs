import assert from "node:assert/strict";
import test from "node:test";

import { handleEspApi } from "../esp/api.mjs";
import { MailboxError, StubGmailConnector } from "../esp/gmail.mjs";
import { templateStore } from "../esp/templates.mjs";

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

function stubbed() {
  let templates = [];
  let signature = null;
  return {
    connector: new StubGmailConnector({ domains: ["advantage-mail.com"] }),
    keyError: null,
    templates: templateStore({ read: () => templates, write: async (value) => { templates = value; } }),
    signature: { read: () => signature, write: async (value) => { signature = value; } },
    unsubscribe: { secret: "test-unsubscribe-secret-0123456789", ephemeral: false }
  };
}

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


// ── ESP 2: templates, signature, preview ─────────────────────────────────────

test("saving a template cleans it and says what was removed; a template with a bad variable is refused", async () => {
  const esp = stubbed();
  const saved = await call({ method: "POST", path: "/templates", esp, body: { name: "Перший", subject: "Hi&nbsp;{{first_name}}", body: "<p style=\"x\">Hi {{first_name|there}},</p><p>We help.</p>" } });
  assert.equal(saved.status, 201);
  assert.equal(saved.payload.template.subject, "Hi {{first_name}}");
  assert.equal(saved.payload.template.body, "Hi {{first_name|there}},\n\nWe help.");
  assert.ok(saved.payload.removed.includes("html"));
  const refused = await call({ method: "POST", path: "/templates", esp, body: { subject: "Hi", body: "{{nickname}}" } });
  assert.equal(refused.status, 400);
  assert.equal(refused.payload.code, "unknown_variable");
  const listed = await call({ path: "/templates", esp });
  assert.equal(listed.payload.templates.length, 1);
  assert.ok(listed.payload.variables.some((variable) => variable.name === "first_name"));
});

test("the preview is the real letter for one lead — plain text with the signature — and nothing is sent", async () => {
  const esp = stubbed();
  await call({ method: "PUT", path: "/signature", esp, body: { name: "Anna Koval", title: "Partnerships", site: "advantage.agency", usPostalAddress: "ADvantage LLC\n1 Main St" } });
  const { payload } = await call({ method: "POST", path: "/templates", esp, body: { subject: "Hi {{first_name}}", body: "Hi {{first_name}}, a question about {{company|your team}}." } });
  const preview = await call({ method: "POST", path: "/preview", esp, body: { templateId: payload.template.id, mailbox: "anna@advantage-mail.com", lead: { name: "Olena Hrytsenko", country: "Poland" } } });
  assert.equal(preview.payload.ok, true);
  assert.equal(preview.payload.subject, "Hi Olena");
  assert.equal(preview.payload.text, "Hi Olena, a question about your team.\n\nAnna Koval\nPartnerships\nADvantage\nadvantage.agency");
  assert.equal(preview.payload.contentType, "text/plain; charset=UTF-8");
  assert.equal(esp.connector.sent.length, 0, "a preview sent something");

  const us = await call({ method: "POST", path: "/preview", esp, body: { templateId: payload.template.id, lead: { name: "Mark Lee", country: "USA" } } });
  assert.match(us.payload.text, /1 Main St$/);

  const empty = await call({ method: "POST", path: "/preview", esp, body: { templateId: payload.template.id, lead: { country: "Poland" } } });
  assert.equal(empty.payload.ok, false);
  assert.equal(empty.payload.reason, "empty_variable");
  assert.deepEqual(empty.payload.variables, ["first_name"]);
});

test("a US lead without the company's postal address is not previewed as sendable", async () => {
  const esp = stubbed();
  await call({ method: "PUT", path: "/signature", esp, body: { name: "Anna" } });
  const preview = await call({ method: "POST", path: "/preview", esp, body: { subject: "Hi", body: "Hi {{first_name}}", lead: { name: "Mark Lee", country: "United States" } } });
  assert.equal(preview.payload.ok, false);
  assert.equal(preview.payload.reason, "us_address_missing");
});

test("the preview carries the unsubscribe headers on the sender's own domain, and the connection says whether their key will survive a restart", async () => {
  const esp = stubbed();
  await call({ method: "PUT", path: "/signature", esp, body: { name: "Anna" } });
  const preview = await call({ method: "POST", path: "/preview", esp, body: { subject: "Hi", body: "Hi {{first_name}}", mailbox: "anna@advantage-mail.com", lead: { name: "Olena", email: "olena@northwind.com" } } });
  assert.match(preview.payload.listUnsubscribe, /^<mailto:anna@advantage-mail\.com\?subject=unsubscribe>, <https:\/\/advantage-mail\.com\/u\/[\w-]+\.[\w-]+>$/);
  assert.equal(preview.payload.listUnsubscribePost, "List-Unsubscribe=One-Click");
  const connection = await call({ path: "/connection", esp: { ...esp, unsubscribe: { secret: "x", ephemeral: true } } });
  assert.equal(connection.payload.unsubscribe.configured, false);
  const fake = await call({ method: "POST", path: "/preview", esp, body: { subject: "Re: our call", body: "Hi {{first_name}}", lead: { name: "Olena" } } });
  assert.equal(fake.payload.ok, false);
  assert.equal(fake.payload.reason, "fake_reply");
});
