import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { campaignStore, parseLeadLines } from "../esp/campaigns.mjs";
import { MailboxError, StubGmailConnector } from "../esp/gmail.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { recordAboutContact, recordFailed, recordSending, recordSent } from "../esp/messages.mjs";
import { addDomain, addSender, canSend, registry, setDomainStatus, setSenderStatus } from "../esp/registry.mjs";
import { SenderGate, stateSenderStore } from "../esp/senders.mjs";
import { addWorkingDays, attemptOf, runTick } from "../esp/sequence.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP 5 — the chain, end to end over the real journal and registry (ESP 9),
 * the real letter (ESP 2/3), the real limits (ESP 4) and the gate (ESP 1), with
 * Gmail stubbed.
 */

const SECRET = "test-unsubscribe-secret-0123456789";
// Tuesday 13.10.2026, 10:30 in Warsaw — well inside the window and past every
// sender's first-of-day offset.
const TUESDAY = new Date("2026-10-13T08:30:00Z");
const at = (days, minutes = 0) => new Date(TUESDAY.getTime() + days * 86_400_000 + minutes * 60_000);

async function world(t, { rampStage = 35, connector = new StubGmailConnector() } = {}) {
  // The journal stamps entries with the clock, and the limits read those
  // stamps: the test's clock and the journal's must be the same one.
  t.mock.timers.enable({ apis: ["Date"], now: TUESDAY.getTime() - 3600_000 });
  const dir = await mkdtemp(join(tmpdir(), "esp-seq-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: "anna@advantage-mail.com", displayName: "Anna Koval", rampStage }, "test");
  await addSender({ email: "boris@advantage-mail.com", displayName: "Boris Lis", rampStage }, "test");

  let templateRows = [];
  const templates = templateStore({ read: () => templateRows, write: async (value) => { templateRows = value; } });
  const first = (await templates.create({ subject: "{{company}} and us", body: "Hi {{first_name}}, a question." })).template;
  const nudge = (await templates.create({ subject: "ignored", body: "{{first_name}}, a nudge." })).template;
  const last = (await templates.create({ subject: "ignored", body: "{{first_name}}, the last one." })).template;

  let campaignRows = [];
  let enrollmentRows = [];
  const campaigns = campaignStore({
    read: () => campaignRows, write: async (value) => { campaignRows = value; },
    readEnrollments: () => enrollmentRows, writeEnrollments: async (value) => { enrollmentRows = value; },
    templates: () => templateRows
  });
  let pauses = {};
  const halt = { on: false };
  const gate = new SenderGate({ connector, store: stateSenderStore({ read: () => pauses, write: async (value) => { pauses = value; } }), halted: () => halt.on });
  const deps = {
    campaigns, templates, gate,
    journal: { allEntries, recordSending, recordSent, recordFailed, recordAboutContact },
    registry: { senders: async () => (await registry()).senders, canSend },
    signature: () => ({ name: "Anna Koval", title: "Partnerships", company: "ADvantage", site: "advantage.agency" }),
    unsubscribe: { secret: SECRET },
    halted: () => halt.on
  };
  const tick = (now, extra = {}) => {
    t.mock.timers.setTime(now.getTime());
    return runTick({ now, ...deps, ...extra });
  };
  return { campaigns, templates, connector, gate, halt, tick, steps: [first, nudge, last].map((template, index) => ({ templateId: template.id, delayDays: [0, 3, 4][index] })) };
}

const LEAD = { email: "olena@northwind.com", name: "Olena Hrytsenko", company: "Northwind", country: "Poland" };
const header = (raw, name) => (raw.slice(0, raw.indexOf("\r\n\r\n")).replace(/\r\n /g, " ").split("\r\n")
  .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) || "").slice(name.length + 1).trim();

test("three letters on day 0, +3 and +4 working days, from one mailbox, in one thread", async (t) => {
  const w = await world(t);
  const campaign = await w.campaigns.create({ name: "Northwind", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  await w.campaigns.enroll(campaign.id, [LEAD]);
  await w.campaigns.setState(campaign.id, "running");

  assert.equal((await w.tick(TUESDAY)).sent, 1);
  assert.equal((await w.tick(at(0, 60))).sent, 0, "the second letter went the same day");
  // +3 working days from Tuesday is Friday; Thursday is too early.
  assert.equal((await w.tick(at(2))).sent, 0);
  assert.equal((await w.tick(at(3))).sent, 1);
  // +4 working days from Friday skips the weekend: Thursday.
  assert.equal(addWorkingDays("2026-10-16", 4), "2026-10-22");
  assert.equal((await w.tick(at(8))).sent, 0, "Wednesday is too early");
  assert.equal((await w.tick(at(9))).sent, 1);
  assert.equal((await w.tick(at(20))).sent, 0, "nothing after the last step");

  const [one, two, three] = w.connector.sent;
  assert.deepEqual(w.connector.sent.map((row) => row.mailbox), Array(3).fill("anna@advantage-mail.com"));
  assert.equal(header(one.raw, "Subject"), "Northwind and us");
  assert.equal(header(two.raw, "Subject"), "Re: Northwind and us");
  assert.equal(header(two.raw, "In-Reply-To"), header(one.raw, "Message-ID"));
  assert.equal(header(three.raw, "References"), `${header(one.raw, "Message-ID")} ${header(two.raw, "Message-ID")}`);
  assert.equal(two.threadId, one.threadId);
  assert.equal(three.threadId, one.threadId);
  assert.equal(w.campaigns.enrollmentsOf(campaign.id)[0].status, "done");
  const journal = await allEntries();
  assert.equal(journal.filter((entry) => entry.type === "message.sent").length, 3);
  const firstSending = journal.find((entry) => entry.type === "message.sending");
  assert.match(firstSending.data.text, /^Hi Olena, a question\.\n\nAnna Koval/, "the journal keeps the exact text that went");
  // ESP 12: what this person got — the spintax group and the EU notice version (Poland).
  assert.equal(firstSending.data.variantIds.group, "spin");
  assert.equal(firstSending.data.variantIds.notice, "eu-uk-2026-10-v1");
  assert.match(firstSending.data.text, /How we handle your data: https:\/\/advantage-mail\.com\/privacy/);
});

test("a lead is in one live campaign only, and keeps the sender it got for the whole chain", async (t) => {
  const w = await world(t);
  const a = await w.campaigns.create({ name: "A", steps: w.steps, senders: ["anna@advantage-mail.com", "boris@advantage-mail.com"] });
  const b = await w.campaigns.create({ name: "B", steps: w.steps, senders: ["boris@advantage-mail.com"] });
  const { added } = await w.campaigns.enroll(a.id, [LEAD, { email: "mark@acme.com", name: "Mark", company: "Acme", country: "Poland" }]);
  assert.deepEqual(added.map((row) => row.sender).sort(), ["anna@advantage-mail.com", "boris@advantage-mail.com"], "the load is spread");
  const second = await w.campaigns.enroll(b.id, [LEAD]);
  assert.deepEqual(second.skipped, [{ email: "olena@northwind.com", reason: "in_other_campaign", campaign: "A" }]);
  const again = await w.campaigns.enroll(a.id, [LEAD]);
  assert.equal(again.skipped[0].reason, "already_in_campaign");

  const olena = w.campaigns.enrollmentsOf(a.id).find((row) => row.email === LEAD.email);
  await assert.rejects(w.campaigns.update(a.id, { senders: olena.sender === "anna@advantage-mail.com" ? ["boris@advantage-mail.com"] : ["anna@advantage-mail.com"] }), (error) => error.code === "sender_in_use");
  await w.campaigns.setState(a.id, "running");
  await w.tick(TUESDAY);
  await w.tick(at(3));
  const mine = w.connector.sent.filter((row) => row.raw.includes("To: \"Olena Hrytsenko\" <olena@northwind.com>"));
  assert.equal(mine.length, 2);
  assert.ok(mine.every((row) => row.mailbox === olena.sender));
});

test("idempotency: a send whose answer never came is not sent again — the person is set aside for a human", async (t) => {
  const stub = new StubGmailConnector();
  // Delivers, then the connection drops before the answer: the worst case.
  const flaky = { kind: "stub", sent: stub.sent, async send(...args) { await stub.send(...args); throw new TypeError("fetch failed: socket hang up"); } };
  const w = await world(t, { connector: flaky });
  const campaign = await w.campaigns.create({ name: "N", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  await w.campaigns.enroll(campaign.id, [LEAD]);
  await w.campaigns.setState(campaign.id, "running");
  const first = await w.tick(TUESDAY);
  assert.equal(first.uncertain, 1);
  for (let tick = 1; tick < 10; tick += 1) await w.tick(at(0, tick * 45));
  assert.equal(stub.sent.length, 1, "a second letter went after a timeout");
  const enrollment = w.campaigns.enrollmentsOf(campaign.id)[0];
  assert.deepEqual([enrollment.status, enrollment.reason], ["uncertain", "no_answer_from_provider"]);
  assert.equal(attemptOf(await allEntries(), { campaignId: campaign.id, email: LEAD.email, step: 0 }).state, "in_flight");
});

test("idempotency: the process died between writing the attempt and Gmail's answer — after a restart nothing is sent again", async (t) => {
  const w = await world(t);
  const campaign = await w.campaigns.create({ name: "N", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  await w.campaigns.enroll(campaign.id, [LEAD]);
  await w.campaigns.setState(campaign.id, "running");
  // The attempt is on disk; the enrolment still says «active», step 0.
  t.mock.timers.setTime(TUESDAY.getTime() - 3600_000);
  await recordSending({ from: "anna@advantage-mail.com", to: LEAD.email, subject: "Northwind and us", text: "Hi", campaignId: campaign.id, step: 0 });
  const pass = await w.tick(TUESDAY);
  assert.deepEqual([pass.sent, pass.uncertain], [0, 1]);
  assert.equal(w.connector.sent.length, 0);
  assert.equal(w.campaigns.enrollmentsOf(campaign.id)[0].status, "uncertain");
});

test("idempotency: a letter the journal says went is not sent again even if the campaign forgot it", async (t) => {
  const w = await world(t);
  const campaign = await w.campaigns.create({ name: "N", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  await w.campaigns.enroll(campaign.id, [LEAD]);
  await w.campaigns.setState(campaign.id, "running");
  // Somebody else's process sent step 0 and crashed before saving the enrolment.
  const sending = await recordSending({ from: "anna@advantage-mail.com", to: LEAD.email, subject: "Northwind and us", text: "Hi", headers: { "Message-ID": "<m1@advantage-mail.com>" }, campaignId: campaign.id, step: 0 });
  await recordSent(sending, { messageId: "gmail-1", threadId: "thread-1" });
  const tick = await w.tick(TUESDAY);
  assert.equal(tick.sent, 0);
  assert.equal(w.connector.sent.length, 0);
  const repaired = w.campaigns.enrollmentsOf(campaign.id)[0];
  assert.deepEqual([repaired.step, repaired.lastSent.messageId, repaired.lastSent.threadId], [1, "<m1@advantage-mail.com>", "thread-1"]);
});

test("a definite refusal from Gmail is recorded as not sent, and the next tick tries again — once", async (t) => {
  const stub = new StubGmailConnector();
  let refuse = true;
  const connector = { kind: "stub", sent: stub.sent, async send(...args) { if (refuse) { refuse = false; throw new MailboxError("Gmail API відповів 503", { code: "gmail_error", status: 503 }); } return stub.send(...args); } };
  const w = await world(t, { connector });
  const campaign = await w.campaigns.create({ name: "N", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  await w.campaigns.enroll(campaign.id, [LEAD]);
  await w.campaigns.setState(campaign.id, "running");
  assert.equal((await w.tick(TUESDAY)).skipped.provider_refused, 1);
  assert.equal((await w.tick(at(0, 30))).sent, 1);
  assert.equal(stub.sent.length, 1);
  const journal = await allEntries();
  assert.equal(journal.filter((entry) => entry.type === "message.failed").length, 1);
});

test("«стоп усе» stops between two letters, and nothing goes while it is on", async (t) => {
  const w = await world(t);
  const campaign = await w.campaigns.create({ name: "N", steps: w.steps, senders: ["anna@advantage-mail.com", "boris@advantage-mail.com"] });
  await w.campaigns.enroll(campaign.id, [LEAD, { email: "mark@acme.com", name: "Mark", company: "Acme", country: "Poland" }]);
  await w.campaigns.setState(campaign.id, "running");
  // Pressed while the first letter is on its way.
  const original = w.gate.connector.send.bind(w.gate.connector);
  w.gate.connector.send = async (...args) => { const result = await original(...args); w.halt.on = true; return result; };
  const pass = await w.tick(TUESDAY);
  assert.deepEqual([pass.sent, pass.halted], [1, true]);
  assert.equal((await w.tick(at(0, 60))).halted, true);
  assert.equal(w.connector.sent.length, 1);
  w.halt.on = false;
  assert.equal((await w.tick(at(0, 90))).sent, 1, "back on, the second person gets theirs");
});

test("a pause at every level holds the letter: campaign, sender, domain", async (t) => {
  const w = await world(t);
  const campaign = await w.campaigns.create({ name: "N", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  await w.campaigns.enroll(campaign.id, [LEAD]);
  await w.campaigns.setState(campaign.id, "paused");
  assert.equal((await w.tick(TUESDAY)).sent, 0, "a paused campaign sent");
  await w.campaigns.setState(campaign.id, "running");
  await setSenderStatus({ email: "anna@advantage-mail.com", status: "paused", reason: "test" }, "test");
  assert.equal((await w.tick(TUESDAY)).skipped.sender_unavailable, 1);
  await setSenderStatus({ email: "anna@advantage-mail.com", status: "active" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "paused", reason: "test" }, "test");
  assert.equal((await w.tick(TUESDAY)).skipped.sender_unavailable, 1, "a paused domain let its sender through");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  assert.equal((await w.tick(TUESDAY)).sent, 1);
});

test("a reply, a bounce or an unsubscribe stops the person's chain", async (t) => {
  const w = await world(t);
  const campaign = await w.campaigns.create({ name: "N", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  const people = ["replied", "bounced", "unsubscribed"].map((kind) => ({ email: `${kind}@example.com`, name: "Olena", company: "X", country: "Poland" }));
  await w.campaigns.enroll(campaign.id, people);
  await w.campaigns.setState(campaign.id, "running");
  for (let minute = 0; minute < 200; minute += 45) await w.tick(at(0, minute));
  assert.equal(w.connector.sent.length, 3);
  await append({ type: "message.replied", contact: "replied@example.com", data: {} });
  await append({ type: "message.bounced", contact: "bounced@example.com", data: { code: "5.1.1" } });
  await append({ type: "contact.unsubscribed", contact: "unsubscribed@example.com", data: {} });
  const pass = await w.tick(at(3));
  assert.deepEqual([pass.sent, pass.stopped], [0, 3]);
  assert.deepEqual(w.campaigns.enrollmentsOf(campaign.id).map((row) => row.reason).sort(), ["bounced", "replied", "unsubscribed"]);
});

test("a big queue still goes out within the sender's ramp and its gaps; the dry run says the same and sends nothing", async (t) => {
  const w = await world(t, { rampStage: 5 });
  const campaign = await w.campaigns.create({ name: "Big", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  const lines = Array.from({ length: 40 }, (_, index) => `lead${index}@example.com, Lead ${index}, Co ${index}, Poland`).join("\n");
  const { leads } = parseLeadLines(lines);
  assert.equal((await w.campaigns.enroll(campaign.id, leads)).added.length, 40);
  await w.campaigns.setState(campaign.id, "running");

  const plan = await w.tick(TUESDAY, { dryRun: true });
  assert.equal(plan.planned.length, 1, "the plan respects the gap too");
  assert.equal(w.connector.sent.length, 0, "a dry run sent something");

  for (let minute = 0; minute < 8 * 60; minute += 5) await w.tick(at(0, minute - 120));
  assert.equal(w.connector.sent.length, 5, "the ramp is 5 a day, whatever the queue");
  const times = (await allEntries()).filter((entry) => entry.type === "message.sent").map((entry) => new Date(entry.at).getTime());
  assert.equal(times.length, 5);
  for (let index = 1; index < times.length; index += 1) {
    assert.ok((times[index] - times[index - 1]) / 60_000 >= 12, "two letters closer than 12 minutes");
  }
});

test("lines pasted from a sheet become people; a line without an email is reported", () => {
  const { leads, rejected } = parseLeadLines("olena@northwind.com, Olena Hrytsenko, Northwind, Poland\nnot-an-email, X\n\nmark@acme.com;Mark;Acme;USA;America/Chicago");
  assert.deepEqual(leads.map((lead) => [lead.email, lead.country, lead.timezone]), [["olena@northwind.com", "Poland", ""], ["mark@acme.com", "USA", "America/Chicago"]]);
  assert.deepEqual(rejected, [{ line: 2, text: "not-an-email, X" }]);
});

test("the API: «стоп усе» needs a reason and is in force before it answers; an empty campaign is not started; somebody who unsubscribed is not added", async (t) => {
  const w = await world(t);
  const { handleEspApi } = await import("../esp/api.mjs");
  let haltRow = { on: false };
  const esp = {
    campaigns: w.campaigns, templates: w.templates,
    halt: { read: () => haltRow, write: async (value) => { haltRow = value; } },
    tick: (options) => w.tick(TUESDAY, options), sequenceOn: false
  };
  const call = async (method, path, body = null) => {
    let answer = null;
    await handleEspApi({
      request: { method, auth: { profile: { role: "admin", email: "pavlo@advantage.agency" } } }, response: {}, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_r, status, payload) => { answer = { status, payload }; }, readJson: async () => body, esp
    });
    return answer;
  };
  assert.equal((await call("POST", "/halt", { on: true })).status, 400);
  const halted = await call("POST", "/halt", { on: true, reason: "тест" });
  assert.equal(halted.payload.halt.on, true);
  assert.equal(haltRow.on, true, "written before the answer");
  assert.equal(haltRow.by, "pavlo@advantage.agency");
  await call("POST", "/halt", { on: false });

  const created = await call("POST", "/campaigns", { name: "API", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  assert.equal(created.status, 201);
  const id = created.payload.campaign.id;
  assert.equal((await call("POST", "/campaigns/state", { id, state: "running" })).payload.code, "empty");

  await append({ type: "contact.unsubscribed", contact: "gone@example.com", data: {} });
  const leads = await call("POST", "/campaigns/leads", { id, text: "gone@example.com, Gone, X, Poland\nolena@northwind.com, Olena, Northwind, Poland\nnope" });
  assert.equal(leads.payload.added, 1);
  assert.deepEqual(leads.payload.skipped, [{ email: "gone@example.com", reason: "unsubscribed" }]);
  assert.equal(leads.payload.rejected.length, 1);
  assert.equal((await call("POST", "/campaigns/state", { id, state: "running" })).status, 200);

  const plan = await call("GET", "/campaigns/plan");
  assert.equal(plan.payload.planned.length, 1);
  assert.equal(w.connector.sent.length, 0, "the plan sent something");
  const list = await call("GET", "/campaigns");
  assert.deepEqual([list.payload.campaigns[0].people, list.payload.campaigns[0].sent], [1, 0]);
});
