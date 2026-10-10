import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { espRouteRight } from "../esp/api.mjs";
import { campaignStore } from "../esp/campaigns.mjs";
import { erasePerson, exportPerson } from "../esp/erasure.mjs";
import { checkLead, exclusions, refusedAtEnrolment } from "../esp/filters.mjs";
import { allEntries, append, erasureKey, eraseContact, timeline, useJournal, verify } from "../esp/journal.mjs";
import { sendLedger } from "../esp/limits.mjs";
import { recordAboutContact, recordSending, recordSent } from "../esp/messages.mjs";
import { addDomain, addSender, setDomainStatus } from "../esp/registry.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP 17 — «Експорт і видалення за email: для запитів людей про їхні дані:
 * показати, звідки адреса і що надсилали; видалити, лишивши хеш у виключеннях.»
 */

const OLENA = "olena@northwind.com";
const LEAD = { email: OLENA, name: "Olena Koval", company: "Northwind", country: "Poland", source: "Apollo", sourceDate: "2026-10-01", verification: "valid", verifiedAt: "2026-10-05" };

async function world(t) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-13T09:00:00Z").getTime() });
  const dir = await mkdtemp(join(tmpdir(), "esp-erase-"));
  const path = join(dir, "journal.jsonl");
  useJournal(path);
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: "anna@advantage-mail.com", rampStage: 35 }, "test");
  let templates = [];
  const tstore = templateStore({ read: () => templates, write: async (value) => { templates = value; } });
  const template = (await tstore.create({ subject: "Hello", body: "Hi {{first_name}}" })).template;
  let campaigns = [];
  let enrollments = [];
  const cstore = campaignStore({ read: () => campaigns, write: async (value) => { campaigns = value; }, readEnrollments: () => enrollments, writeEnrollments: async (value) => { enrollments = value; }, templates: () => templates });
  const campaign = await cstore.create({ name: "Northwind pilot", steps: [{ templateId: template.id, delayDays: 0 }], senders: ["anna@advantage-mail.com"] });
  await cstore.enroll(campaign.id, [LEAD, { email: "ivan@acme.com", country: "Poland" }]);

  const sending = await recordSending({ from: "anna@advantage-mail.com", to: OLENA, subject: "Olena, a question", text: "Hi Olena, a question about Northwind.", campaignId: campaign.id, step: 0 });
  await recordSent(sending, { messageId: "<m1@advantage-mail.com>", threadId: "t1" });
  await recordAboutContact("message.replied", OLENA, { sender: "anna@advantage-mail.com", campaignId: campaign.id, step: 0, subject: "Re: Olena, a question", text: "Not now — Olena Koval, Northwind" });
  const other = await recordSending({ from: "anna@advantage-mail.com", to: "ivan@acme.com", subject: "Ivan, a question", text: "Hi Ivan.", campaignId: campaign.id, step: 0 });
  await recordSent(other, { messageId: "<m2@advantage-mail.com>", threadId: "t2" });
  await append({ type: "esp.alert", data: { title: "Відповідь", text: `Відповіла ${OLENA.toUpperCase()} з кампанії` } });
  return { path, cstore, campaign };
}

test("the export shows where the address came from, every letter as sent, and what came back", async (t) => {
  const { cstore } = await world(t);
  const entries = await allEntries();
  const report = exportPerson(OLENA.toUpperCase(), { entries, enrollments: cstore.enrollments(), campaigns: cstore.list(), exclusions: await exclusions(entries) });
  assert.equal(report.found, true);
  assert.deepEqual(report.sources.map((row) => [row.campaign, row.source, row.sourceDate]), [["Northwind pilot", "Apollo", "2026-10-01"]]);
  assert.equal(report.sent.length, 1);
  assert.equal(report.sent[0].text, "Hi Olena, a question about Northwind.");
  assert.equal(report.sent[0].state, "sent");
  assert.deepEqual(report.received.map((row) => row.type), ["message.replied"]);
  assert.equal(report.erased, null);
  assert.equal(report.excluded, null);
  assert.equal(JSON.stringify(report).includes("ivan@acme.com"), false, "nobody else's data in somebody's export");
});

test("forgetting a person: the address is nowhere in the journal or the campaigns, a hash keeps them out", async (t) => {
  const { path, cstore, campaign } = await world(t);
  const sentBefore = sendLedger(await allEntries(), { now: new Date() }).senders.get("anna@advantage-mail.com").today;

  const result = await erasePerson(OLENA, { campaigns: cstore, actor: "pavlo@advantage-agency.co", note: "запит від 13.10" });
  assert.equal(result.campaignRows, 1);
  assert.equal(result.journalLines, 4, "sending, sent, reply — and the alert that named her");
  assert.equal(result.key, erasureKey(OLENA));

  const raw = await readFile(path, "utf8");
  for (const trace of [OLENA, "Olena", "Northwind", "a question about"]) assert.equal(raw.toLowerCase().includes(trace.toLowerCase()), false, `«${trace}» is still in the file`);
  assert.ok(raw.includes("ivan@acme.com"), "somebody else's letters stay");
  assert.deepEqual(await timeline(OLENA), []);
  assert.deepEqual(cstore.enrollments().map((row) => row.email), ["ivan@acme.com"]);

  // The chain still holds, and the sender's day still counts her letter.
  const check = await verify();
  assert.equal(check.ok, true, JSON.stringify(check.problems));
  assert.equal(sendLedger(await allEntries(), { now: new Date() }).senders.get("anna@advantage-mail.com").today, sentBefore);
  const alert = (await allEntries()).find((entry) => entry.type === "esp.alert");
  assert.match(alert.data.text, /Відповіла \[видалено\] з кампанії/);

  // Pasted again later — refused for good, by the hash.
  const list = await exclusions();
  assert.equal(list.get(erasureKey(OLENA)).category, "erased");
  const verdict = await checkLead(LEAD, { exclusions: list, countries: [], dns: { resolveMx: async () => [{ exchange: "aspmx.l.google.com" }] } });
  assert.equal(verdict.reason, "erased");
  assert.equal(refusedAtEnrolment(verdict), true);
  const again = await cstore.enroll(campaign.id, [LEAD], { blocked: () => (refusedAtEnrolment(verdict) ? verdict.reason : null) });
  assert.deepEqual(again.skipped.map((row) => row.reason), ["erased"]);

  // The export now says what happened — and holds nothing else.
  const entries = await allEntries();
  const report = exportPerson(OLENA, { entries, enrollments: cstore.enrollments(), campaigns: cstore.list(), exclusions: await exclusions(entries) });
  assert.equal(report.found, false);
  assert.equal(report.erased.by, "pavlo@advantage-agency.co");
  assert.equal(report.excluded.category, "erased");
});

test("a redacted line no erasure accounts for, or an edit elsewhere, is still caught", async (t) => {
  const { path } = await world(t);
  await eraseContact(OLENA, { actor: "test" });
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const target = lines.find((entry) => entry.contact === "ivan@acme.com");
  target.redacted = lines.at(-1).seq;
  target.data.text = "changed";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const check = await verify();
  assert.equal(check.ok, false);
  assert.deepEqual(check.problems.map((problem) => problem.problem), ["redaction_unaccounted"]);
});

test("a journal with a torn line is not rewritten: the erasure waits for the repair", async (t) => {
  const { path } = await world(t);
  await appendFile(path, '{"seq":99,"at":');
  useJournal(path);
  await assert.rejects(eraseContact(OLENA, { actor: "test" }), (error) => error.statusCode === 409);
  assert.ok((await readFile(path, "utf8")).includes(OLENA));
});

test("reading a person's data is the journal's right; forgetting them is an administrator's", () => {
  assert.equal(espRouteRight("GET", "/people/export"), "journal.read");
  assert.equal(espRouteRight("POST", "/people/erase"), "access.manage");
});
