import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { campaignStore } from "../esp/campaigns.mjs";
import { StubGmailConnector } from "../esp/gmail.mjs";
import { pollInboxes } from "../esp/inbound.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { recordAboutContact, recordFailed, recordSending, recordSent } from "../esp/messages.mjs";
import { MailboxError, MicrosoftGraphConnector, providerOfFromEnv, providerRouter } from "../esp/provider.mjs";
import { addDomain, addSender, canSend, registry, setDomainStatus } from "../esp/registry.mjs";
import { SenderGate, stateSenderStore } from "../esp/senders.mjs";
import { runTick } from "../esp/sequence.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP 17 — «Абстракція провайдера: Microsoft (Graph API) додамо пізніше — не
 * зашивати Google у бізнес-логіку.»
 */

const ESP = new URL("../esp/", import.meta.url);
const PROVIDER_FILES = new Set(["gmail.mjs", "provider.mjs"]);

test("no business module knows Google: only the provider files name the Gmail API or import gmail.mjs", () => {
  for (const name of readdirSync(ESP).filter((file) => file.endsWith(".mjs") && !PROVIDER_FILES.has(file))) {
    const source = readFileSync(new URL(name, ESP), "utf8");
    assert.doesNotMatch(source, /googleapis\.com|gmail\.googleapis/i, `${name} talks to Google directly`);
    assert.doesNotMatch(source, /from "\.\/gmail\.mjs"/, `${name} imports the Gmail connector — take the contract from provider.mjs`);
  }
});

test("each mailbox goes to its provider; Microsoft is listed but says plainly it is not built yet", async () => {
  const gmail = new StubGmailConnector();
  const router = providerRouter({ connectors: { gmail, microsoft: new MicrosoftGraphConnector() }, providerOf: providerOfFromEnv({ ESP_MICROSOFT_DOMAINS: "advantage-365.com" }) });
  assert.equal(router.providerOf("anna@advantage-mail.com"), "stub");
  assert.equal(router.providerOf("anna@advantage-365.com"), "microsoft");
  assert.equal((await router.send("anna@advantage-mail.com", "raw")).stub, true);
  await assert.rejects(router.send("anna@advantage-365.com", "raw"), (error) => error instanceof MailboxError && error.code === "provider_not_ready" && /Microsoft 365/.test(error.message));
  await assert.rejects(router.inboxSince("anna@advantage-365.com", null), (error) => error.code === "provider_not_ready");
  assert.deepEqual(router.describe().providers, { gmail: "stub", microsoft: "microsoft" });
  assert.equal(gmail.sent.length, 1, "the Microsoft letter went through Google");
});

/**
 * Another provider, written only against the contract — opaque ids of its own,
 * no Gmail anywhere — runs the whole chain and its inbox unchanged.
 */
class OtherProvider {
  constructor() { this.kind = "other"; this.sent = []; this.inbox = []; }
  describe() { return { mode: "other", liveSend: true }; }
  async checkMailbox(mailbox) { return { ok: true, mailbox, address: mailbox, stub: false }; }
  async send(mailbox, raw, { threadId = null } = {}) {
    const id = `msg-${this.sent.length + 1}`;
    const conversation = threadId || `conv-${this.sent.length + 1}`;
    this.sent.push({ mailbox, raw, threadId: conversation });
    return { id, threadId: conversation, stub: false };
  }
  async inboxSince(_mailbox, cursor) { const from = Number(cursor) || 0; return { messages: this.inbox.slice(from), cursor: String(this.inbox.length) }; }
}

test("the chain and the inbox run unchanged on a provider that is not Google", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-13T07:00:00Z").getTime() });
  const dir = await mkdtemp(join(tmpdir(), "esp-prov-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-365.com" }, "test");
  await setDomainStatus({ domain: "advantage-365.com", status: "ramp" }, "test");
  await addSender({ email: "anna@advantage-365.com", rampStage: 35 }, "test");
  let templates = [];
  const tstore = templateStore({ read: () => templates, write: async (value) => { templates = value; } });
  const steps = [];
  for (const body of ["Hi {{first_name}}, a question.", "{{first_name}}, a nudge."]) steps.push({ templateId: (await tstore.create({ subject: "Hello", body })).template.id, delayDays: steps.length ? 3 : 0 });
  let campaigns = [];
  let enrollments = [];
  const cstore = campaignStore({ read: () => campaigns, write: async (value) => { campaigns = value; }, readEnrollments: () => enrollments, writeEnrollments: async (value) => { enrollments = value; }, templates: () => templates });
  const other = new OtherProvider();
  const router = providerRouter({ connectors: { gmail: new StubGmailConnector(), other }, providerOf: () => "other" });
  const gate = new SenderGate({ connector: router, store: stateSenderStore({ read: () => ({}), write: async () => {} }) });
  const campaign = await cstore.create({ name: "M365", steps, senders: ["anna@advantage-365.com"] });
  await cstore.enroll(campaign.id, [{ email: "olena@northwind.com", name: "Olena Koval", country: "Poland" }]);
  await cstore.setState(campaign.id, "running");
  const tick = (at) => {
    t.mock.timers.setTime(at.getTime());
    return runTick({ now: at, campaigns: cstore, templates: tstore, gate, halted: () => false, journal: { allEntries, recordSending, recordSent, recordFailed, recordAboutContact }, registry: { senders: async () => (await registry()).senders, canSend }, signature: () => ({ name: "Anna" }), unsubscribe: { secret: "test-unsubscribe-secret-0123456789" } });
  };
  assert.equal((await tick(new Date("2026-10-13T08:30:00Z"))).sent, 1);
  assert.equal((await tick(new Date("2026-10-16T08:30:00Z"))).sent, 1);
  assert.deepEqual(other.sent.map((row) => row.threadId), ["conv-1", "conv-1"], "the follow-up left its provider's conversation");
  other.inbox.push({ id: "in-1", threadId: "conv-1", raw: "From: olena@northwind.com\r\nTo: anna@advantage-365.com\r\nSubject: Re: Hello\r\nContent-Type: text/plain\r\n\r\nYes, let's talk." });
  const polled = await pollInboxes({ connector: router, mailboxes: ["anna@advantage-365.com"], cursors: { read: () => null, write: async () => {} }, journal: { allEntries, recordAboutContact, append }, postpone: async () => {} });
  assert.deepEqual(polled.actions, { reply: 1 });
});
