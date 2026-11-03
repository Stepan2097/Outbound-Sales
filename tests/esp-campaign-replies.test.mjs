import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleEspApi } from "../esp/api.mjs";
import { append, useJournal } from "../esp/journal.mjs";
import { coldReplyText } from "../triage/leadgen-notify.mjs";

// Owner 03.11: «чому тут пише 1 відповідь якщо є 2 автовідповіді, при наведені на
// цифру має відкриватися детальна інформація … скільки хороших відповідей скільки автовідповідей».
test("«Відповіді» in a campaign are people's answers; auto-replies and help desks are counted apart, with labels", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "esp-replies-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  const enrolledAt = "2026-11-01T00:00:00.000Z";
  const people = ["olga@acme.com", "max@delta.com", "ellie@yaspa.com", "payments-support@paripesa.com"];
  for (const contact of people) await append({ type: "message.sent", contact, data: { from: "anna@send.com", campaignId: "c1" } });
  await append({ type: "message.replied", contact: "olga@acme.com", data: { sender: "anna@send.com", campaignId: "c1", text: "Yes, let's talk", label: "positive" } });
  await append({ type: "message.replied", contact: "max@delta.com", data: { sender: "anna@send.com", campaignId: "c1", text: "Not now", label: "negative" } });
  await append({ type: "message.autoreplied", contact: "ellie@yaspa.com", data: { sender: "anna@send.com", campaignId: "c1" } });
  await append({ type: "message.replied", contact: "payments-support@paripesa.com", data: { sender: "anna@send.com", campaignId: "c1", text: "Good day! So how can we help you today?", label: "neutral" } });
  const esp = {
    campaigns: {
      list: () => [{ id: "c1", name: "Operators", state: "running", steps: [], senders: ["anna@send.com"] }],
      enrollmentsOf: () => people.map((email) => ({ email, enrolledAt, status: "active", sender: "anna@send.com" }))
    }
  };
  let answer = null;
  await handleEspApi({
    request: { method: "GET", auth: { profile: { role: "admin" } } }, response: {}, url: new URL("http://x/api/esp/campaigns"),
    sendJson: (_r, status, payload) => { answer = { status, payload }; }, readJson: async () => null, esp
  });
  const [campaign] = answer.payload.campaigns;
  assert.equal(campaign.replied, 2, "two people answered; the out-of-office and the help desk are not answers");
  assert.deepEqual(campaign.replyKinds, { positive: 1, neutral: 0, negative: 1, referral: 0, unlabelled: 0, auto: 2 });
});

test("a good answer in Telegram: who, campaign and mailbox, the words, where to answer", () => {
  const text = coldReplyText({ name: "Olga Shevchenko", company: "Acme", email: "olga@acme.com", campaign: "Оператори · A", sender: "anna@send.com", label: "positive", text: "Yes, let's talk on Tuesday", url: "https://app/#mail-inbox" });
  assert.match(text, /^✅ Хороша відповідь на холодний лист \(позитивна\)/);
  assert.match(text, /Olga Shevchenko · Acme \(olga@acme\.com\)/);
  assert.match(text, /Кампанія: Оператори · A · пошта anna@send\.com/);
  assert.match(text, /«Yes, let's talk on Tuesday»/);
  assert.match(text, /Відповісти: https:\/\/app\/#mail-inbox/);
});

test("a pause somebody already lifted is no longer shown as an alert; one still on is (03.11, tomas@trafpush.com)", async (t) => {
  const { addDomain, addSender, setDomainStatus, setSenderStatus } = await import("../esp/registry.mjs");
  const dir = await mkdtemp(join(tmpdir(), "esp-alerts-view-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "send.com" }, "test");
  await setDomainStatus({ domain: "send.com", status: "ramp" }, "test");
  for (const email of ["tomas@send.com", "anna@send.com"]) {
    await addSender({ email }, "test");
    await setSenderStatus({ email, status: "paused", reason: "bounce", code: "bounce_rate_7d" }, "esp-alerts");
    await append({ type: "esp.alert", actor: "esp-alerts", data: { key: `sender:${email}`, kind: "pause_sender", email, title: `Сендер ${email} на паузі` } });
  }
  await setSenderStatus({ email: "tomas@send.com", status: "active", reason: "знято" }, "owner@x.com");
  let answer = null;
  await handleEspApi({
    request: { method: "GET", auth: { profile: { role: "admin" } } }, response: {}, url: new URL("http://x/api/esp/alerts"),
    sendJson: (_r, status, payload) => { answer = { status, payload }; }, readJson: async () => null, esp: { campaigns: { list: () => [] } }
  });
  assert.deepEqual(answer.payload.alerts.map((row) => row.email), ["anna@send.com"]);
});
