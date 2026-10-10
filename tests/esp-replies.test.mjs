import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { campaignStore } from "../esp/campaigns.mjs";
import { conversations, quickReply } from "../esp/conversations.mjs";
import { SendingLocked, StubGmailConnector } from "../esp/gmail.mjs";
import { pollInboxes } from "../esp/inbound.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { assertPlainLetter } from "../esp/letter.mjs";
import { recordAboutContact, recordFailed, recordSending, recordSent } from "../esp/messages.mjs";
import { addDomain, addSender, canSend, registry, setDomainStatus } from "../esp/registry.mjs";
import { classifyReply, currentLabels } from "../esp/replies.mjs";
import { SenderGate, stateSenderStore } from "../esp/senders.mjs";
import { runTick } from "../esp/sequence.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP 14 — a reply's label, a company paused when one of its people answers,
 * and the team's one inbox with a quick reply from the same sender.
 */

test("labels: positive, negative, referral, neutral — and the phrase that decided", () => {
  const cases = [
    ["Sounds interesting — can we talk on Thursday?", "positive"],
    ["Так, цікаво. Коли вам зручно созвонитися?", "positive"],
    ["Send me more details please", "positive"],
    ["Not interested, thanks.", "negative"],
    ["We already work with an agency, no need.", "negative"],
    ["Не цікаво.", "negative"],
    ["I'm not the right person — please contact Maria, maria@northwind.com.", "referral"],
    ["Зверніться до нашого CMO, я переслав вашого листа.", "referral"],
    ["Not now, maybe next quarter.", "neutral"],
    ["Thanks for the email.", "neutral"],
    ["", "neutral"]
  ];
  for (const [text, label] of cases) assert.equal(classifyReply(text).label, label, text);
  assert.match(classifyReply("Let's talk next week").rule, /let's talk/i);
});

test("a person's correction wins over the rule's label, and both stay on record", () => {
  const entries = [
    { type: "message.replied", data: { gmailId: "g1", label: "neutral", labelRule: "no rule matched" } },
    { type: "reply.labelled", actor: "olena@advantage.agency", at: "2026-10-13T10:00:00Z", data: { gmailId: "g1", label: "positive" } }
  ];
  assert.deepEqual(currentLabels(entries).get("g1"), { label: "positive", by: "olena@advantage.agency", at: "2026-10-13T10:00:00Z" });
  assert.equal(currentLabels(entries.slice(0, 1)).get("g1").by, "rule");
});

// ── end to end ─────────────────────────────────────────────────────────────

const TUESDAY = new Date("2026-10-13T08:30:00Z");
const at = (days, minutes = 0) => new Date(TUESDAY.getTime() + days * 86_400_000 + minutes * 60_000);
const ANNA = "anna@advantage-mail.com";

async function world(t) {
  t.mock.timers.enable({ apis: ["Date"], now: TUESDAY.getTime() - 3600_000 });
  const dir = await mkdtemp(join(tmpdir(), "esp-rep-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: ANNA, rampStage: 35 }, "test");
  let templates = [];
  const tstore = templateStore({ read: () => templates, write: async (value) => { templates = value; } });
  const steps = [];
  for (const body of ["Hi {{first_name}}, a question.", "{{first_name}}, a nudge."]) {
    steps.push({ templateId: (await tstore.create({ subject: "Northwind and us", body })).template.id, delayDays: steps.length ? 3 : 0 });
  }
  let campaigns = [];
  let enrollments = [];
  const cstore = campaignStore({ read: () => campaigns, write: async (value) => { campaigns = value; }, readEnrollments: () => enrollments, writeEnrollments: async (value) => { enrollments = value; }, templates: () => templates });
  const connector = new StubGmailConnector();
  let pauses = {};
  const gate = new SenderGate({ connector, store: stateSenderStore({ read: () => pauses, write: async (value) => { pauses = value; } }) });
  const tick = (now) => {
    t.mock.timers.setTime(now.getTime());
    return runTick({
      now, campaigns: cstore, templates: tstore, gate, journal: { allEntries, recordSending, recordSent, recordFailed, recordAboutContact },
      registry: { senders: async () => (await registry()).senders, canSend },
      signature: () => ({ name: "Anna Koval", company: "ADvantage" }), unsubscribe: { secret: "test-unsubscribe-secret-0123456789" }, halted: () => false
    });
  };
  let cursors = {};
  const poll = (now) => {
    t.mock.timers.setTime(now.getTime());
    return pollInboxes({ connector, mailboxes: [ANNA], now, cursors: { read: (m) => cursors[m] || null, write: async (m, c) => { cursors[m] = c; } }, journal: { allEntries, recordAboutContact, append }, postpone: async () => {} });
  };
  const campaign = await cstore.create({ name: "Northwind", steps, senders: [ANNA] });
  return { cstore, connector, gate, tick, poll, campaign };
}

const reply = (from, body, extra = "") => `From: ${from}\r\nTo: ${ANNA}\r\nSubject: Re: Northwind and us\r\nMessage-ID: <r-${Math.random().toString(36).slice(2)}@northwind.com>\r\n${extra}Content-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;

test("one person at a company answers — the company's other people in that campaign are paused, not written to again", async (t) => {
  const w = await world(t);
  // Two people at Northwind, one at Acme; the ramp for new people per company is two a day.
  await w.cstore.enroll(w.campaign.id, [
    { email: "olena@northwind.com", name: "Olena Koval", country: "Poland" },
    { email: "mark@northwind.com", name: "Mark Lee", country: "Poland" },
    { email: "ana@acme.com", name: "Ana Souza", country: "Poland" }
  ]);
  await w.cstore.setState(w.campaign.id, "running");
  for (let minute = 0; minute < 300; minute += 30) await w.tick(at(0, minute));
  assert.equal(w.connector.sent.length, 3);
  const olena = w.connector.sent.find((row) => row.raw.includes("olena@northwind.com"));
  w.connector.deliver(ANNA, reply("olena@northwind.com", "Sounds interesting, let's talk."), { threadId: olena.threadId });
  assert.deepEqual((await w.poll(at(1))).actions, { reply: 1 });
  const pass = await w.tick(at(3));
  assert.equal(pass.sent, 1, "only Acme's nudge goes");
  const people = Object.fromEntries(w.cstore.enrollmentsOf(w.campaign.id).map((row) => [row.email, row]));
  assert.deepEqual([people["olena@northwind.com"].status, people["olena@northwind.com"].reason], ["stopped", "replied"]);
  assert.deepEqual([people["mark@northwind.com"].status, people["mark@northwind.com"].reason, people["mark@northwind.com"].pausedBecause], ["paused", "company_replied", "olena@northwind.com"]);
  assert.equal(people["ana@acme.com"].step, 2);
  // A person decides: Mark is picked back up and gets his nudge.
  await w.cstore.resumePerson(w.campaign.id, "mark@northwind.com");
  assert.equal((await w.tick(at(3, 60))).sent, 1);
});

test("the shared inbox: one conversation per sender and person, our exact letters and their reply with its label", async (t) => {
  const w = await world(t);
  await w.cstore.enroll(w.campaign.id, [{ email: "olena@northwind.com", name: "Olena Koval", country: "Poland" }, { email: "quiet@acme.com", name: "Quiet One", country: "Poland" }]);
  await w.cstore.setState(w.campaign.id, "running");
  for (let minute = 0; minute < 120; minute += 30) await w.tick(at(0, minute));
  const sent = w.connector.sent.find((row) => row.raw.includes("olena@northwind.com"));
  w.connector.deliver(ANNA, reply("olena@northwind.com", "Not interested, thanks."), { threadId: sent.threadId });
  await w.poll(at(1));
  const list = conversations(await allEntries());
  assert.equal(list.length, 1, "a letter nobody answered is not inbox");
  const [olena] = list;
  assert.deepEqual([olena.sender, olena.contact, olena.label, olena.campaignId], [ANNA, "olena@northwind.com", "negative", w.campaign.id]);
  assert.deepEqual(olena.messages.map((message) => [message.direction, message.kind]), [["out", "sent"], ["in", "replied"]]);
  assert.match(olena.messages[0].text, /^Hi Olena, a question\./, "the exact text that went");
  assert.ok(olena.messages[1].messageId, "the reply's own Message-ID is kept for answering it");
});

test("a quick reply comes from the same sender, in the same thread, plain text — and the gate refuses it while sending is locked", async (t) => {
  const w = await world(t);
  await w.cstore.enroll(w.campaign.id, [{ email: "olena@northwind.com", name: "Olena Koval", country: "Poland" }]);
  await w.cstore.setState(w.campaign.id, "running");
  await w.tick(TUESDAY);
  const sent = w.connector.sent[0];
  w.connector.deliver(ANNA, reply("olena@northwind.com", "Let's talk on Thursday?"), { threadId: sent.threadId });
  await w.poll(at(1));
  const [conversation] = conversations(await allEntries());
  const letter = quickReply(conversation, "<p>Thursday&nbsp;works — 11:00?</p>", { name: "Anna Koval", company: "ADvantage" });
  const head = letter.raw.slice(0, letter.raw.indexOf("\r\n\r\n"));
  assert.match(head, /^From: "Anna Koval" <anna@advantage-mail\.com>$/m);
  assert.match(head, /^To: olena@northwind\.com$/m);
  assert.match(head, /^Subject: Re: Northwind and us$/m);
  const lastId = conversation.messages.at(-1).messageId;
  assert.match(head, new RegExp(`^In-Reply-To: ${lastId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal(letter.threadId, sent.threadId);
  assert.equal(assertPlainLetter(letter.raw), true);
  assert.match(letter.text, /^Thursday works — 11:00\?/, "the pasted HTML was cleaned");

  // The real connector, as it runs before ESP 11: refused before Google is asked.
  const { GmailApiConnector } = await import("../esp/gmail.mjs");
  const { generateKeyPairSync } = await import("node:crypto");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  let asked = 0;
  const locked = new SenderGate({ connector: new GmailApiConnector({ serviceAccount: { type: "service_account", client_email: "x@y.iam.gserviceaccount.com", private_key: key }, fetch: async () => { asked += 1; return { ok: true, json: async () => ({}) }; } }), store: stateSenderStore({ read: () => ({}), write: async () => {} }) });
  await assert.rejects(locked.send(ANNA, letter.raw, { threadId: letter.threadId }), SendingLocked);
  assert.equal(asked, 0);
});

test("on the stub, outside the acceptance cycle, a quick reply is refused — nothing «sent» goes into the timeline", async () => {
  const { handleEspApi } = await import("../esp/api.mjs");
  let answer = null;
  await handleEspApi({
    request: { method: "POST", auth: { profile: { role: "admin", email: "a@b.c" } } }, response: {}, url: new URL("http://x/api/esp/conversations/reply"),
    sendJson: (_r, status, payload) => { answer = { status, payload }; }, readJson: async () => ({ key: "x|y", text: "hi" }),
    esp: { connector: new StubGmailConnector(), sequenceOn: false }
  });
  assert.equal(answer.status, 409);
  assert.equal(answer.payload.code, "not_connected");
});
