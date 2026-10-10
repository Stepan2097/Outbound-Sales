import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { campaignStore } from "../esp/campaigns.mjs";
import { StubGmailConnector } from "../esp/gmail.mjs";
import { pollInboxes } from "../esp/inbound.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { assertPlainLetter } from "../esp/letter.mjs";
import { localTime } from "../esp/limits.mjs";
import { parseMessage, plainText } from "../esp/mime.mjs";
import { recordAboutContact, recordFailed, recordSending, recordSent } from "../esp/messages.mjs";
import { addDomain, addSender, canSend, registry, setDomainStatus } from "../esp/registry.mjs";
import { SenderGate, stateSenderStore } from "../esp/senders.mjs";
import { postponedDue, runTick } from "../esp/sequence.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP 11 — the gate before the first cold letter, the part a machine can do.
 * Checklist: «Приймання перед першим холодним листом»:
 *   1. a test campaign over internal mailboxes — 3 letters in one thread, a
 *      reply stops the chain, «out of office» moves the step, an unsubscribe
 *      works the same day;
 *   2. the original of the letter — only text/plain, List-Unsubscribe, no
 *      pixels or rewritten links;
 *   3. a load run — with a huge queue no sender goes over its limit or its
 *      gap, and a retry after a failure does not duplicate;
 *   4. «стоп усе» stops sending within seconds.
 *
 * Everything real except Gmail, which is the stub: the journal and registry
 * (ESP 9), the letter and headers (ESP 2/3), the limits (ESP 4), the chain
 * (ESP 5), the pre-send checks are not wired here (ESP 6 runs on the server),
 * the inbox (ESP 7). `scripts/esp-acceptance.mjs` runs this file and prints
 * the PASS/FAIL report. The live half — real mailboxes, «Show original» in
 * Gmail — is the owner's, after the keys.
 */

const MONDAY = new Date("2026-10-12T07:30:00Z"); // 09:30 in Warsaw, 10:30 in Kyiv
const at = (days, minutes = 0) => new Date(MONDAY.getTime() + days * 86_400_000 + minutes * 60_000);
const LINK = "https://advantage.agency/case";

async function world(t, { senders = ["anna", "boris"], rampStage = 35, connector = new StubGmailConnector() } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: MONDAY.getTime() - 3600_000 });
  const dir = await mkdtemp(join(tmpdir(), "esp-acc-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "acceptance");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "acceptance");
  for (const name of senders) await addSender({ email: `${name}@advantage-mail.com`, displayName: name, rampStage }, "acceptance");
  let templates = [];
  const tstore = templateStore({ read: () => templates, write: async (value) => { templates = value; } });
  const steps = [];
  for (const [body, delay] of [[`Hi {{first_name}}, a question about {{company}}. Our case: ${LINK}`, 0], ["{{first_name}}, a short nudge.", 3], ["{{first_name}}, the last note from me.", 4]]) {
    steps.push({ templateId: (await tstore.create({ subject: "{{company}} and ADvantage", body })).template.id, delayDays: delay });
  }
  let campaigns = [];
  let enrollments = [];
  const cstore = campaignStore({ read: () => campaigns, write: async (value) => { campaigns = value; }, readEnrollments: () => enrollments, writeEnrollments: async (value) => { enrollments = value; }, templates: () => templates });
  const halt = { on: false };
  let pauses = {};
  const gate = new SenderGate({ connector, store: stateSenderStore({ read: () => pauses, write: async (value) => { pauses = value; } }), halted: () => halt.on });
  const tick = (now) => {
    t.mock.timers.setTime(now.getTime());
    return runTick({
      now, campaigns: cstore, templates: tstore, gate, halted: () => halt.on,
      journal: { allEntries, recordSending, recordSent, recordFailed, recordAboutContact },
      registry: { senders: async () => (await registry()).senders, canSend },
      signature: () => ({ name: "Anna Koval", title: "Partnerships", company: "ADvantage", site: "advantage.agency" }),
      unsubscribe: { secret: "acceptance-unsubscribe-secret-0123456789" }
    });
  };
  let cursors = {};
  const poll = (now) => {
    t.mock.timers.setTime(now.getTime());
    return pollInboxes({
      connector, now, mailboxes: senders.map((name) => `${name}@advantage-mail.com`),
      cursors: { read: (mailbox) => cursors[mailbox] || null, write: async (mailbox, cursor) => { cursors[mailbox] = cursor; } },
      journal: { allEntries, recordAboutContact, append },
      postpone: async ({ campaignId, email, until }) => {
        const row = cstore.enrollmentsOf(campaignId).find((item) => item.email === email && item.status === "active");
        if (row) await cstore.saveEnrollment({ ...row, nextDueDate: postponedDue(row, { until, today: now.toISOString().slice(0, 10) }) });
      }
    });
  };
  return { cstore, connector, gate, tick, poll, halt, steps };
}

const header = (raw, name) => (raw.slice(0, raw.indexOf("\r\n\r\n")).replace(/\r\n /g, " ").split("\r\n")
  .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) || "").slice(name.length + 1).trim();
const internal = (count) => Array.from({ length: count }, (_, index) => ({ email: `qa${index + 1}@qa-box${index + 1}.com`, name: `Qa Tester${index + 1}`, company: `QA ${index + 1}`, country: "Poland" }));
const inbound = (from, to, body, extra = "") => `From: ${from}\r\nTo: ${to}\r\nSubject: Re: test\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@qa>\r\n${extra}Content-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;

test("ESP 11 · 1 — test campaign on 12 internal mailboxes: three letters in one thread, a reply stops, out-of-office moves the step, an unsubscribe the same day", async (t) => {
  const w = await world(t);
  const campaign = await w.cstore.create({ name: "Acceptance", steps: w.steps, senders: ["anna@advantage-mail.com", "boris@advantage-mail.com"] });
  const people = internal(12);
  await w.cstore.enroll(campaign.id, people);
  await w.cstore.setState(campaign.id, "running");

  // Day 0: everybody's first letter.
  for (let minute = 0; minute < 7 * 60; minute += 10) await w.tick(at(0, minute));
  const first = (email) => w.connector.sent.find((row) => header(row.raw, "To").includes(email));
  assert.equal(w.connector.sent.length, 12, "every internal mailbox got letter 1 on day 0");

  // Day 1: qa1 replies, qa2 is away until Monday the 19th, qa3 unsubscribes by the mailto.
  const sender = (email) => w.cstore.enrollmentsOf(campaign.id).find((row) => row.email === email).sender;
  w.connector.deliver(sender("qa1@qa-box1.com"), inbound("qa1@qa-box1.com", sender("qa1@qa-box1.com"), "Sounds interesting — let's talk."), { threadId: first("qa1@qa-box1.com").threadId });
  w.connector.deliver(sender("qa2@qa-box2.com"), inbound("qa2@qa-box2.com", sender("qa2@qa-box2.com"), "I am out of the office until 19.10.2026.", "Auto-Submitted: auto-replied\r\n"), { threadId: first("qa2@qa-box2.com").threadId });
  w.connector.deliver(sender("qa3@qa-box3.com"), inbound("qa3@qa-box3.com", sender("qa3@qa-box3.com"), "").replace("Subject: Re: test", "Subject: unsubscribe"));
  const polled = await w.poll(at(1));
  assert.deepEqual(polled.actions, { reply: 1, autoreply: 1, unsubscribe: 1 });

  // The rest of the fortnight, every half hour of the working day.
  for (let day = 1; day <= 14; day += 1) for (let minute = 0; minute < 7 * 60; minute += 30) await w.tick(at(day, minute));

  const letters = (email) => w.connector.sent.filter((row) => header(row.raw, "To").includes(email));
  for (const person of people.slice(3)) {
    const chain = letters(person.email);
    assert.equal(chain.length, 3, `${person.email}: not three letters`);
    assert.equal(new Set(chain.map((row) => row.threadId)).size, 1, `${person.email}: letters in more than one thread`);
    assert.equal(new Set(chain.map((row) => row.mailbox)).size, 1, `${person.email}: more than one sender`);
    assert.equal(header(chain[1].raw, "In-Reply-To"), header(chain[0].raw, "Message-ID"));
    assert.equal(header(chain[2].raw, "In-Reply-To"), header(chain[1].raw, "Message-ID"));
    assert.equal(header(chain[2].raw, "Subject"), `Re: ${header(chain[0].raw, "Subject")}`);
  }
  assert.equal(letters("qa1@qa-box1.com").length, 1, "the reply did not stop the chain");
  assert.equal(letters("qa3@qa-box3.com").length, 1, "the unsubscribe did not stop the chain");
  const away = letters("qa2@qa-box2.com");
  assert.ok(away.length >= 2, "out-of-office ended the chain instead of moving it");
  const secondDate = localTime(new Date(w.connector.sent.indexOf(away[1]) >= 0 ? (await allEntries()).filter((entry) => entry.type === "message.sent" && entry.contact === "qa2@qa-box2.com")[1].at : 0), "Europe/Warsaw").date;
  assert.ok(secondDate >= "2026-10-20", `the nudge went on ${secondDate}, before the person was back`);
  const unsubscribed = (await allEntries()).filter((entry) => entry.type === "contact.unsubscribed").map((entry) => entry.contact);
  assert.deepEqual(unsubscribed, ["qa3@qa-box3.com"], "the unsubscribe was not recorded as an exclusion the same day");
});

test("ESP 11 · 2 — the original of every letter: one text/plain part, List-Unsubscribe with One-Click, no pixel, no rewritten link", async (t) => {
  const w = await world(t);
  const campaign = await w.cstore.create({ name: "Original", steps: w.steps, senders: ["anna@advantage-mail.com"] });
  await w.cstore.enroll(campaign.id, internal(3));
  await w.cstore.setState(campaign.id, "running");
  for (let day = 0; day <= 9; day += 1) for (let minute = 0; minute < 7 * 60; minute += 20) await w.tick(at(day, minute));
  assert.equal(w.connector.sent.length, 9);
  for (const row of w.connector.sent) {
    assert.equal(assertPlainLetter(row.raw), true);
    const head = row.raw.slice(0, row.raw.indexOf("\r\n\r\n"));
    assert.equal((head.match(/^Content-Type:/gim) || []).length, 1);
    assert.match(head, /^Content-Type: text\/plain; charset=UTF-8$/m);
    assert.doesNotMatch(row.raw, /text\/html|multipart|<img|<a |<html/i);
    assert.match(header(row.raw, "List-Unsubscribe"), /^<mailto:anna@advantage-mail\.com\?subject=unsubscribe>, <https:\/\/advantage-mail\.com\/u\/[\w-]+\.[\w-]+>$/);
    assert.equal(header(row.raw, "List-Unsubscribe-Post"), "List-Unsubscribe=One-Click");
    const text = plainText(parseMessage(row.raw));
    for (const url of text.match(/https?:\/\/\S+/g) || []) {
      // Only the template's own link, as written, and the sender's own domain
      // (the EU/UK notice's data policy, ESP 12) — nothing wrapped, nothing redirected.
      assert.ok(url.startsWith(LINK) || url.startsWith("https://advantage-mail.com/"), `a link that is not ours as written: ${url}`);
    }
  }
  const opener = plainText(parseMessage(w.connector.sent[0].raw));
  assert.ok(opener.includes(LINK), "the link was not left as the template has it");
});

test("ESP 11 · 3 — load: 300 people on 3 senders over a working week — no sender over its ramp or under its gap, and a retry after a failure sends nothing twice", async (t) => {
  const stub = new StubGmailConnector();
  let failNext = 3;
  // Every so often Gmail takes the letter and the answer is lost: the worst case for duplicates.
  const flaky = { kind: "stub", sent: stub.sent, inboxes: stub.inboxes, inboxSince: (...args) => stub.inboxSince(...args), async send(...args) {
    const result = await stub.send(...args);
    if (failNext > 0 && stub.sent.length % 40 === 0) { failNext -= 1; throw new TypeError("fetch failed: socket hang up"); }
    return result;
  } };
  const w = await world(t, { senders: ["anna", "boris", "clara"], rampStage: 15, connector: flaky });
  const campaign = await w.cstore.create({ name: "Load", steps: w.steps, senders: ["anna@advantage-mail.com", "boris@advantage-mail.com", "clara@advantage-mail.com"] });
  const crowd = Array.from({ length: 300 }, (_, index) => ({ email: `p${index}@company${index}.com`, name: `Person ${index}`, company: `Company ${index}`, country: "Poland" }));
  await w.cstore.enroll(campaign.id, crowd);
  await w.cstore.setState(campaign.id, "running");
  for (let day = 0; day < 5; day += 1) for (let minute = -60; minute < 8 * 60; minute += 5) await w.tick(at(day, minute));

  const sent = (await allEntries()).filter((entry) => entry.type === "message.sent");
  const sendings = (await allEntries()).filter((entry) => entry.type === "message.sending");
  const perSenderDay = new Map();
  const bySender = new Map();
  for (const entry of sendings) {
    const key = `${entry.data.from}|${localTime(new Date(entry.at), "Europe/Kyiv").date}`;
    perSenderDay.set(key, (perSenderDay.get(key) || 0) + 1);
    if (!bySender.has(entry.data.from)) bySender.set(entry.data.from, []);
    bySender.get(entry.data.from).push(new Date(entry.at).getTime());
  }
  for (const [key, count] of perSenderDay) assert.ok(count <= 15, `${key}: ${count} letters, over the ramp of 15`);
  for (const [from, times] of bySender) {
    for (let index = 1; index < times.length; index += 1) {
      const gap = (times[index] - times[index - 1]) / 60_000;
      if (gap < 600) assert.ok(gap >= 12, `${from}: ${gap} minutes between two letters`);
    }
  }
  const keys = stub.sent.map((row) => `${header(row.raw, "To")}|${header(row.raw, "Subject")}|${header(row.raw, "In-Reply-To")}`);
  assert.equal(new Set(keys).size, keys.length, "a letter went twice");
  const uncertain = w.cstore.enrollmentsOf(campaign.id).filter((row) => row.status === "uncertain").length;
  assert.ok(uncertain >= 1, "the injected failures never happened");
  assert.ok(sent.length >= 150, `the queue barely moved: ${sent.length}`);
});

test("ESP 11 · 4 — «стоп усе» stops sending within seconds: pressed mid-pass, not one more letter leaves", async (t) => {
  const w = await world(t, { senders: ["anna", "boris"], rampStage: 35 });
  const campaign = await w.cstore.create({ name: "Stop", steps: w.steps, senders: ["anna@advantage-mail.com", "boris@advantage-mail.com"] });
  await w.cstore.enroll(campaign.id, internal(10));
  await w.cstore.setState(campaign.id, "running");
  const original = w.gate.connector.send.bind(w.gate.connector);
  let pressedAt = null;
  w.gate.connector.send = async (...args) => {
    const result = await original(...args);
    if (!pressedAt) { w.halt.on = true; pressedAt = process.hrtime.bigint(); }
    return result;
  };
  const started = process.hrtime.bigint();
  const pass = await w.tick(MONDAY);
  const stoppedAfterMs = Number(process.hrtime.bigint() - pressedAt) / 1e6;
  assert.equal(pass.halted, true);
  assert.equal(w.connector.sent.length, 1, "a letter left after «стоп усе»");
  assert.ok(stoppedAfterMs < 5000, `the pass ran on for ${stoppedAfterMs} ms after the stop`);
  for (let minute = 10; minute < 300; minute += 10) assert.equal((await w.tick(at(0, minute))).halted, true);
  assert.equal(w.connector.sent.length, 1);
  assert.ok(Number(process.hrtime.bigint() - started) > 0);
});
