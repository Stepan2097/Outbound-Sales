import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { campaignStore } from "../esp/campaigns.mjs";
import { GmailApiConnector, StubGmailConnector } from "../esp/gmail.mjs";
import { classifyInbound, freshText, pollInboxes, returnDate } from "../esp/inbound.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { recordAboutContact, recordFailed, recordSending, recordSent } from "../esp/messages.mjs";
import { parseMessage, plainText } from "../esp/mime.mjs";
import { addDomain, addSender, canSend, registry, setDomainStatus } from "../esp/registry.mjs";
import { SenderGate, stateSenderStore } from "../esp/senders.mjs";
import { postponedDue, runTick } from "../esp/sequence.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP 7 — the inboxes: a reply stops the chain, an auto-reply moves the next
 * letter, bounces by their code, an unsubscribe the same day; journalled once.
 */

const TUESDAY = new Date("2026-10-13T08:30:00Z");
const at = (days, minutes = 0) => new Date(TUESDAY.getTime() + days * 86_400_000 + minutes * 60_000);
const ANNA = "anna@advantage-mail.com";

async function world(t) {
  t.mock.timers.enable({ apis: ["Date"], now: TUESDAY.getTime() - 3600_000 });
  const dir = await mkdtemp(join(tmpdir(), "esp-in-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: ANNA, rampStage: 35 }, "test");
  let templates = [];
  const tstore = templateStore({ read: () => templates, write: async (value) => { templates = value; } });
  const steps = [];
  for (const body of ["Hi {{first_name}}, a question.", "{{first_name}}, a nudge.", "{{first_name}}, the last one."]) {
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
    return pollInboxes({
      connector, mailboxes: [ANNA], now,
      cursors: { read: (mailbox) => cursors[mailbox] || null, write: async (mailbox, cursor) => { cursors[mailbox] = cursor; } },
      journal: { allEntries, recordAboutContact, append },
      postpone: async ({ campaignId, email, until }) => {
        const row = cstore.enrollmentsOf(campaignId).find((item) => item.email === email && item.status === "active");
        if (row) await cstore.saveEnrollment({ ...row, nextDueDate: postponedDue(row, { until, today: now.toISOString().slice(0, 10) }) });
      }
    });
  };
  const campaign = await cstore.create({ name: "N", steps, senders: [ANNA] });
  return { cstore, connector, tick, poll, campaign };
}

const lead = (name) => ({ email: `${name}@${name}-co.com`, name: `${name[0].toUpperCase()}${name.slice(1)} Koval`, company: name, country: "Poland" });

function reply(to, { from, subject = "Re: Northwind and us", body, headers = "" }) {
  return `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n${headers}Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${body}`;
}

function dsn({ to, recipient, status, messageId = "" }) {
  return [
    "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>", `To: ${to}`, "Subject: Delivery Status Notification (Failure)",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=UTF-8", "",
    `Your message wasn't delivered to ${recipient}.`, "", "--b1", "Content-Type: message/delivery-status", "",
    "Reporting-MTA: dns; googlemail.com", "", `Final-Recipient: rfc822; ${recipient}`, "Action: failed", `Status: ${status}`, "",
    "--b1", "Content-Type: text/rfc822-headers", "", `Message-ID: ${messageId}`, `To: ${recipient}`, "", "--b1--", ""
  ].join("\r\n");
}

async function started(w, names) {
  await w.cstore.enroll(w.campaign.id, names.map(lead));
  await w.cstore.setState(w.campaign.id, "running");
  for (let minute = 0; minute < 200; minute += 45) await w.tick(at(0, minute));
  return Object.fromEntries(names.map((name) => [name, w.connector.sent.find((row) => row.raw.includes(`${name}@${name}-co.com`))]));
}

test("a reply in the thread stops the person's chain; a stranger's mail is not ours to journal", async (t) => {
  const w = await world(t);
  const sent = await started(w, ["olena"]);
  w.connector.deliver(ANNA, reply(ANNA, { from: "Olena Koval <olena@olena-co.com>", body: "Sounds interesting =E2=80=94 can we talk on Thursday?\r\n\r\nOn Tue, Anna wrote:\r\n> Hi Olena, a question." }), { threadId: sent.olena.threadId });
  w.connector.deliver(ANNA, reply(ANNA, { from: "spam@elsewhere.com", subject: "Buy now", body: "hello" }));
  const pass = await w.poll(at(1));
  assert.deepEqual(pass.actions, { reply: 1, not_ours: 1 });
  const replied = (await allEntries()).find((entry) => entry.type === "message.replied");
  assert.equal(replied.contact, "olena@olena-co.com");
  assert.equal(replied.data.sender, ANNA);
  assert.equal(replied.data.text, "Sounds interesting — can we talk on Thursday?", "the quoted letter was kept as the reply");
  const next = await w.tick(at(3));
  assert.deepEqual([next.sent, next.stopped], [0, 1]);
  assert.equal(w.cstore.enrollmentsOf(w.campaign.id)[0].reason, "replied");
});

test("an out-of-office moves the next letter past the return date — it neither stops the chain nor counts as a reply", async (t) => {
  const w = await world(t);
  const sent = await started(w, ["olena"]);
  w.connector.deliver(ANNA, reply(ANNA, { from: "olena@olena-co.com", subject: "Automatic reply: Northwind and us", headers: "Auto-Submitted: auto-replied\r\n", body: "I am out of the office until 23.10.2026 with limited access to email." }), { threadId: sent.olena.threadId });
  assert.deepEqual((await w.poll(at(1))).actions, { autoreply: 1 });
  const person = w.cstore.enrollmentsOf(w.campaign.id)[0];
  assert.equal(person.status, "active");
  assert.equal(person.nextDueDate, "2026-10-26", "Friday the 23rd back, next letter the working day after");
  assert.equal((await w.tick(at(3))).sent, 0, "the nudge went while she was away");
  assert.equal((await allEntries()).filter((entry) => entry.type === "message.replied").length, 0);
  assert.equal(postponedDue({ nextDueDate: null }, { until: null, today: "2026-10-13" }), "2026-10-16", "no date said: three working days on");
});

test("bounces by code: 5.1.1 stops the chain and excludes the address; 5.7.x raises an alert on the sender; 4.x.x is counted apart and stops nothing", async (t) => {
  const w = await world(t);
  const sent = await started(w, ["gone", "policy", "later"]);
  w.connector.deliver(ANNA, dsn({ to: ANNA, recipient: "gone@gone-co.com", status: "5.1.1" }), { threadId: sent.gone.threadId });
  w.connector.deliver(ANNA, dsn({ to: ANNA, recipient: "policy@policy-co.com", status: "5.7.1" }));
  w.connector.deliver(ANNA, dsn({ to: ANNA, recipient: "later@later-co.com", status: "4.4.7" }));
  assert.deepEqual((await w.poll(at(0, 300))).actions, { bounce: 3 });
  const journal = await allEntries();
  assert.deepEqual(journal.filter((entry) => entry.type === "message.bounced").map((entry) => [entry.contact, entry.data.code]).sort(),
    [["gone@gone-co.com", "5.1.1"], ["later@later-co.com", "4.4.7"], ["policy@policy-co.com", "5.7.1"]]);
  const alerts = journal.filter((entry) => entry.type === "sender.alert");
  assert.deepEqual(alerts.map((entry) => [entry.data.email, entry.data.code]), [[ANNA, "5.7.1"]]);
  await w.tick(at(3));
  const people = Object.fromEntries(w.cstore.enrollmentsOf(w.campaign.id).map((row) => [row.email.split("@")[0], row]));
  assert.equal(people.gone.reason, "bounced");
  assert.equal(people.policy.reason, "bounced");
  assert.equal(people.later.status, "active", "a 4.x.x delay ended the chain");
});

test("unsubscribe the same day: the mailto, a word in the reply, a short «no» — and «no problem» is a reply, not an unsubscribe", async (t) => {
  const w = await world(t);
  const sent = await started(w, ["mailto", "word", "short", "fine"]);
  w.connector.deliver(ANNA, reply(ANNA, { from: "mailto@mailto-co.com", subject: "unsubscribe", body: "" }));
  w.connector.deliver(ANNA, reply(ANNA, { from: "word@word-co.com", body: "Please remove me from your list." }), { threadId: sent.word.threadId });
  w.connector.deliver(ANNA, reply(ANNA, { from: "short@short-co.com", body: "=D0=9D=D1=96." }), { threadId: sent.short.threadId });
  w.connector.deliver(ANNA, reply(ANNA, { from: "fine@fine-co.com", body: "No problem, let's talk next week." }), { threadId: sent.fine.threadId });
  assert.deepEqual((await w.poll(at(0, 300))).actions, { unsubscribe: 3, reply: 1 });
  const unsubscribed = (await allEntries()).filter((entry) => entry.type === "contact.unsubscribed");
  assert.deepEqual(unsubscribed.map((entry) => [entry.contact, entry.data.via]).sort(), [["mailto@mailto-co.com", "mailto"], ["short@short-co.com", "reply"], ["word@word-co.com", "reply"]]);
});

test("read twice — after a restart, or the same message listed again — journalled once", async (t) => {
  const w = await world(t);
  const sent = await started(w, ["olena"]);
  const message = w.connector.deliver(ANNA, reply(ANNA, { from: "olena@olena-co.com", body: "Yes, interested." }), { threadId: sent.olena.threadId });
  await w.poll(at(1));
  // A restart lost the cursor: the inbox is read from the start again.
  const again = await pollInboxes({
    connector: w.connector, mailboxes: [ANNA], cursors: { read: () => null, write: async () => {} },
    journal: { allEntries, recordAboutContact, append }, postpone: async () => {}
  });
  assert.deepEqual(again.actions, { seen: 1 });
  assert.equal((await allEntries()).filter((entry) => entry.type === "message.replied" && entry.data.gmailId === message.id).length, 1);
});

// ── reading the message ─────────────────────────────────────────────────────

test("MIME: encoded subjects, base64 and quoted-printable bodies, multipart/alternative", () => {
  const raw = [
    "From: =?UTF-8?B?0J7Qu9C10L3QsA==?= <olena@x.com>", "Subject: =?UTF-8?Q?=D0=9F=D1=80=D0=B8=D0=B2=D1=96=D1=82?=",
    'Content-Type: multipart/alternative; boundary="alt"', "", "--alt", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from("Так, давайте поговоримо.").toString("base64"), "--alt", "Content-Type: text/html; charset=UTF-8", "", "<p>Так</p>", "--alt--"
  ].join("\r\n");
  const message = parseMessage(raw);
  assert.equal(message.headers.subject, "Привіт");
  assert.equal(message.headers.from, "Олена <olena@x.com>");
  assert.equal(plainText(message), "Так, давайте поговоримо.");
});

test("the fresh part of a reply stops at the quote, in English and in Ukrainian", () => {
  assert.equal(freshText("Yes!\n\nOn Tue, 13 Oct 2026 at 10:30, Anna <a@x.com> wrote:\n> Hi"), "Yes!");
  assert.equal(freshText("Так, цікаво.\n\nвт, 13 жовт. 2026 р. о 10:30 Anna <a@x.com> пише:\n> Hi"), "Так, цікаво.");
  assert.equal(freshText("Ok\n-----Original Message-----\nFrom: a@x.com"), "Ok");
});

test("auto-replies are recognised by header, subject or text in several languages, and the return date is read", () => {
  const now = new Date("2026-10-13T09:00:00Z");
  for (const [headers, subject, body] of [
    ["Auto-Submitted: auto-replied\r\n", "Re: hi", "Thanks"],
    ["", "Abwesenheitsnotiz: hi", "Ich bin bis 20.10. nicht im Büro."],
    ["", "Respuesta automática: hi", "Estoy fuera hasta el 21/10/2026."],
    ["", "Re: hi", "I'm currently out of the office and will return on October 22."],
    ["", "Автоматична відповідь", "Я у відпустці до 24.10.2026"]
  ]) {
    const kind = classifyInbound(reply("a@x.com", { from: "b@y.com", subject, headers, body }), { mailbox: "a@x.com", now }).kind;
    assert.equal(kind, "autoreply", subject);
  }
  assert.equal(returnDate("back on October 22", now), "2026-10-22");
  assert.equal(returnDate("bis 20.10.", now), "2026-10-20");
  assert.equal(returnDate("I was away on 01.01.2020", now), null, "a past date is not a return date");
});

// ── Gmail ───────────────────────────────────────────────────────────────────

test("Gmail: history from the cursor, raw messages, our own sent mail left out; a forgotten cursor falls back to the last two days", async () => {
  const calls = [];
  const raw = (text) => Buffer.from(text).toString("base64url");
  const fetch = async (url) => {
    calls.push(url);
    const answer = url.includes("oauth2") ? { access_token: "t", expires_in: 3600 }
      : url.includes("/history?startHistoryId=old") ? null
      : url.includes("/history?") ? { history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] }], historyId: "200" }
      : url.endsWith("/profile") ? { historyId: "300" }
      : url.includes("/messages?q=") ? { messages: [{ id: "m3" }] }
      : url.includes("/messages/m2") ? { id: "m2", threadId: "t2", labelIds: ["SENT"], raw: raw("From: a@x.com\r\n\r\nmine") }
      : { id: url.match(/messages\/(m\d)/)[1], threadId: "t1", labelIds: ["INBOX"], raw: raw("From: b@y.com\r\nSubject: hi\r\n\r\nhello") };
    return answer ? { ok: true, status: 200, json: async () => answer } : { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
  };
  const { generateKeyPairSync } = await import("node:crypto");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const gmail = new GmailApiConnector({ serviceAccount: { type: "service_account", client_email: "x@y.iam.gserviceaccount.com", private_key: key }, fetch });
  const fresh = await gmail.inboxSince("a@x.com", "100");
  assert.deepEqual(fresh.messages.map((message) => message.id), ["m1"], "our own sent message came back as inbox");
  assert.equal(fresh.cursor, "200");
  assert.match(fresh.messages[0].raw, /Subject: hi/);
  const lost = await gmail.inboxSince("a@x.com", "old");
  assert.deepEqual([lost.messages.map((message) => message.id), lost.cursor], [["m3"], "300"]);
  assert.ok(calls.some((url) => url.includes(encodeURIComponent("in:inbox newer_than:2d"))));
});
