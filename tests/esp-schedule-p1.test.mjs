import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { campaignStore } from "../esp/campaigns.mjs";
import { companyKey, recentContactBlocks } from "../esp/company.mjs";
import { StubGmailConnector } from "../esp/gmail.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { recordAboutContact, recordFailed, recordSending, recordSent } from "../esp/messages.mjs";
import { applyRampReviews, reviewRamp } from "../esp/ramp.mjs";
import { addDomain, addSender, canSend, registry, setDomainStatus, updateSender } from "../esp/registry.mjs";
import { SenderGate, stateSenderStore } from "../esp/senders.mjs";
import { runTick } from "../esp/sequence.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP 13 — two new people from one company a day, one of our domains per
 * company at a time, the ramp only on a clean week, and 90 days before
 * writing to somebody again.
 */

const TUESDAY = new Date("2026-10-13T08:30:00Z");
const at = (days, minutes = 0) => new Date(TUESDAY.getTime() + days * 86_400_000 + minutes * 60_000);

async function world(t) {
  t.mock.timers.enable({ apis: ["Date"], now: TUESDAY.getTime() - 3600_000 });
  const dir = await mkdtemp(join(tmpdir(), "esp-p1-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  for (const domain of ["advantage-mail.com", "advantage-post.com"]) {
    await addDomain({ domain }, "test");
    await setDomainStatus({ domain, status: "ramp" }, "test");
  }
  await addSender({ email: "anna@advantage-mail.com", rampStage: 35 }, "test");
  await addSender({ email: "boris@advantage-post.com", rampStage: 35 }, "test");
  let templates = [];
  const store = templateStore({ read: () => templates, write: async (value) => { templates = value; } });
  const { template } = await store.create({ subject: "Hi", body: "Hi {{first_name}}." });
  const { template: nudge } = await store.create({ subject: "x", body: "{{first_name}}, again." });
  let campaigns = [];
  let enrollments = [];
  const cstore = campaignStore({ read: () => campaigns, write: async (value) => { campaigns = value; }, readEnrollments: () => enrollments, writeEnrollments: async (value) => { enrollments = value; }, templates: () => templates });
  const connector = new StubGmailConnector();
  let pauses = {};
  const gate = new SenderGate({ connector, store: stateSenderStore({ read: () => pauses, write: async (value) => { pauses = value; } }) });
  const tick = (now) => {
    t.mock.timers.setTime(now.getTime());
    return runTick({
      now, campaigns: cstore, templates: store, gate,
      journal: { allEntries, recordSending, recordSent, recordFailed, recordAboutContact },
      registry: { senders: async () => (await registry()).senders, canSend },
      signature: () => ({ name: "Anna", company: "ADvantage" }), unsubscribe: { secret: "test-unsubscribe-secret-0123456789" }, halted: () => false
    });
  };
  return { cstore, connector, tick, steps: [{ templateId: template.id, delayDays: 0 }, { templateId: nudge.id, delayDays: 1 }] };
}

const person = (email, company = "") => ({ email, name: "Olena Koval", company, country: "Poland" });

test("a company is its email domain, or its name behind a free mailbox", () => {
  assert.equal(companyKey({ email: "olena@northwind.com" }), "d:northwind.com");
  assert.equal(companyKey({ email: "olena@mail.northwind.com" }), "d:northwind.com");
  assert.equal(companyKey({ email: "olena@gmail.com", company: "Northwind Ltd." }), "n:northwind");
  assert.equal(companyKey({ email: "olena@gmail.com" }), null);
});

test("no more than two new people from one company a day — the third waits for tomorrow", async (t) => {
  const w = await world(t);
  const campaign = await w.cstore.create({ name: "N", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  await w.cstore.enroll(campaign.id, ["a", "b", "c"].map((name) => person(`${name}@northwind.com`)).concat(person("x@acme.com")));
  await w.cstore.setState(campaign.id, "running");
  let skippedForCompany = 0;
  for (let minute = 0; minute < 6 * 60; minute += 10) skippedForCompany += (await w.tick(at(0, minute))).skipped.company_daily_limit || 0;
  const northwind = w.connector.sent.filter((row) => /To: .*@northwind\.com/.test(row.raw));
  assert.equal(northwind.length, 2, "a third person from the same company was written to on the same day");
  assert.ok(skippedForCompany > 0);
  assert.equal(w.connector.sent.filter((row) => /To: .*@acme\.com/.test(row.raw)).length, 1, "another company was held back too");
  await w.tick(at(1));
  for (let minute = 0; minute < 120; minute += 15) await w.tick(at(1, minute));
  assert.equal(w.connector.sent.filter((row) => /To: .*c@northwind\.com/.test(row.raw)).length, 1, "the third did not go the next day");
});

test("a company one of our domains is writing to does not get a first letter from another of our domains", async (t) => {
  const w = await world(t);
  const first = await w.cstore.create({ name: "A", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  const second = await w.cstore.create({ name: "B", steps: w.steps, senders: ["boris@advantage-post.com"] });
  await w.cstore.enroll(first.id, [person("a@northwind.com")]);
  await w.cstore.setState(first.id, "running");
  await w.tick(TUESDAY);
  await w.cstore.enroll(second.id, [person("b@northwind.com")]);
  await w.cstore.setState(second.id, "running");
  const pass = await w.tick(at(0, 60));
  assert.equal(pass.skipped.company_other_domain, 1);
  assert.equal(w.connector.sent.filter((row) => row.mailbox === "boris@advantage-post.com").length, 0);
});

test("the 90-day rule: written to without an answer — not again yet; ever answered — not by a sequence", () => {
  const now = new Date("2026-10-13T09:00:00Z");
  const entries = [
    { type: "message.sent", contact: "recent@x.com", at: "2026-09-01T09:00:00Z" },
    { type: "message.sent", contact: "old@x.com", at: "2026-06-01T09:00:00Z" },
    { type: "message.sent", contact: "talked@x.com", at: "2026-03-01T09:00:00Z" },
    { type: "message.replied", contact: "talked@x.com", at: "2026-03-02T09:00:00Z" }
  ];
  const blocked = recentContactBlocks(entries, { now });
  assert.equal(blocked("recent@x.com"), "contacted_recently");
  assert.equal(blocked("old@x.com"), null, "more than 90 days ago is fine");
  assert.equal(blocked("talked@x.com"), "replied_before");
  assert.equal(blocked("new@x.com"), null);
});

// ── the ramp ───────────────────────────────────────────────────────────────

const SENDER = (stage = 10) => ({ email: "anna@advantage-mail.com", rampStage: stage, effectiveStatus: "active", addedAt: "2026-10-01T09:00:00Z", history: [] });
const week = (counts) => {
  const entries = [];
  for (let index = 0; index < counts.sent; index += 1) entries.push({ type: "message.sent", at: "2026-10-12T09:00:00Z", data: { from: "anna@advantage-mail.com" } });
  for (const code of counts.bounces || []) entries.push({ type: "message.bounced", at: "2026-10-12T10:00:00Z", data: { sender: "anna@advantage-mail.com", code } });
  for (let index = 0; index < (counts.replies || 0); index += 1) entries.push({ type: "message.replied", at: "2026-10-12T11:00:00Z", data: { sender: "anna@advantage-mail.com" } });
  return entries;
};
const NOW = new Date("2026-10-13T09:00:00Z");

test("a clean week — bounce up to 2%, no 5.7.x, a reply — moves the ramp one step", () => {
  const review = reviewRamp(SENDER(10), week({ sent: 60, bounces: ["5.1.1"], replies: 2 }), { now: NOW });
  assert.deepEqual([review.due, review.eligible, review.nextStage, review.reasons], [true, true, 15, []]);
});

test("too many bounces, any 5.7.x, no replies or nothing sent — the stage stays, with the reasons", () => {
  assert.match(reviewRamp(SENDER(), week({ sent: 40, bounces: ["5.1.1", "5.1.1"], replies: 1 }), { now: NOW }).reasons.join(), /bounce 5\.0%/);
  assert.match(reviewRamp(SENDER(), week({ sent: 60, bounces: ["5.7.1"], replies: 3 }), { now: NOW }).reasons.join(), /5\.7\.x/);
  assert.match(reviewRamp(SENDER(), week({ sent: 60, replies: 0 }), { now: NOW }).reasons.join(), /жодної відповіді/);
  assert.match(reviewRamp(SENDER(), [], { now: NOW }).reasons.join(), /не надіслано/);
  const young = { ...SENDER(), addedAt: "2026-10-10T09:00:00Z" };
  assert.equal(reviewRamp(young, week({ sent: 60, replies: 3 }), { now: NOW }).due, false, "a week has not passed since the stage was set");
  assert.equal(reviewRamp(SENDER(35), week({ sent: 60, replies: 3 }), { now: NOW }).nextStage, null);
});

test("applied: the clean sender steps up in the registry, the held one gets a journal note — once a week, not every hour", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "esp-ramp-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T09:00:00Z").getTime() });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: "anna@advantage-mail.com", rampStage: 10 }, "test");
  await addSender({ email: "boris@advantage-mail.com", rampStage: 10 }, "test");
  t.mock.timers.setTime(new Date("2026-10-12T09:00:00Z").getTime());
  for (let index = 0; index < 50; index += 1) {
    await append({ type: "message.sent", contact: `l${index}@x.com`, data: { from: "anna@advantage-mail.com" } });
    await append({ type: "message.sent", contact: `m${index}@x.com`, data: { from: "boris@advantage-mail.com" } });
  }
  await append({ type: "message.replied", contact: "l1@x.com", data: { sender: "anna@advantage-mail.com" } });
  t.mock.timers.setTime(NOW.getTime());
  const run = async () => applyRampReviews({ senders: (await registry()).senders, entries: await allEntries(), now: new Date(), updateSender, append });
  const results = await run();
  assert.deepEqual(results.map((row) => [row.email, row.action]).sort(), [["anna@advantage-mail.com", "stepped_up"], ["boris@advantage-mail.com", "held"]]);
  const { senders } = await registry();
  assert.equal(senders.find((row) => row.email === "anna@advantage-mail.com").rampStage, 15);
  assert.equal(senders.find((row) => row.email === "boris@advantage-mail.com").rampStage, 10);
  assert.deepEqual(await run(), [], "looked at again an hour later");
  const held = (await allEntries()).filter((entry) => entry.type === "sender.ramp_held");
  assert.equal(held.length, 1);
  assert.match(held[0].data.reasons.join(), /жодної відповіді/);
});
