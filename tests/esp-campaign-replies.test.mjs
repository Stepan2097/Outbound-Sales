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
test("«Відповіді» in a campaign count every answer; the relevant ones and the auto-replies are told apart for the hover", async (t) => {
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
  assert.equal(campaign.replied, 4, "every answer counts — two people, an out-of-office and a help desk");
  assert.deepEqual(campaign.replyKinds, { positive: 1, neutral: 0, negative: 1, referral: 0, unlabelled: 0, auto: 2 });
});

test("a good answer in Telegram: who, campaign and mailbox, the words, where to answer — in paragraphs", () => {
  const text = coldReplyText({ name: "Olga Shevchenko", company: "Acme", email: "olga@acme.com", campaign: "Оператори · A", sender: "anna@send.com", label: "positive", text: "Hi Anna,\n\n\n  Yes, let's talk   on Tuesday.\r\nBest,\nOlga", url: "https://app/#mail-inbox" });
  assert.equal(text, [
    "✅ Хороша відповідь на холодний лист",
    "Olga Shevchenko · Acme\nolga@acme.com",
    "Кампанія: Оператори · A\nПошта: anna@send.com",
    "«Hi Anna,\n\nYes, let's talk on Tuesday.\nBest,\nOlga»",
    "Відповісти: https://app/#mail-inbox"
  ].join("\n\n"));
});

test("05.11: the signature stays out — cut after the sign-off and the name; lines the mail program wrapped are joined back", () => {
  const raw = "Hi Camille,\r\n\r\nThanks for reaching out.\r\n\r\nTo be honest, this isn't my area of expertise. I'm focused on other\r\ncampaigns, so I'm not the right person to speak on that.\r\n\r\nBest,\r\nMehedi\r\nMehedi Hasan\r\nAffiliate Manager | DOPPCALL\r\nE: mehedi@doppcall.com  M: +1 (929) 822-5911";
  const text = coldReplyText({ email: "mehedi@doppcall.com", label: "referral", text: raw });
  assert.match(text, /«Hi Camille,\n\nThanks for reaching out\.\n\nTo be honest, this isn't my area of expertise\. I'm focused on other campaigns, so I'm not the right person to speak on that\.\n\nBest,\nMehedi»$/);
});

test("05.11 «це не є Хороша відповідь а переадресація»: a referral is titled as one", () => {
  const text = coldReplyText({ email: "mehedi@doppcall.com", label: "referral", text: "Hi Camille, this isn't my area." });
  assert.match(text, /^↪️ Переадресація — відповідь на холодний лист\n\nmehedi@doppcall\.com\n\n«Hi Camille/);
  assert.doesNotMatch(text, /Хороша/);
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

// Owner 05.11: «при наведені я хочу бачити детальну інформацію скільки перших листів скільки других і тд».
test("«Одержувачів» на наведенні: скільки людей отримали 1-й лист, 2-й, 3-й, і скільки ще чекають першого", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "esp-steps-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  for (const contact of ["a@x.com", "b@x.com", "c@x.com"]) await append({ type: "message.sent", contact, data: { from: "anna@send.com", campaignId: "c1", step: 0 } });
  await append({ type: "message.sent", contact: "a@x.com", data: { from: "anna@send.com", campaignId: "c1", step: 1 } });
  await append({ type: "message.sent", contact: "a@x.com", data: { from: "anna@send.com", campaignId: "c1", step: 1 } });
  await append({ type: "message.sent", contact: "z@x.com", data: { from: "anna@send.com", campaignId: "other", step: 0 } });
  const rows = [
    { email: "a@x.com", status: "active", step: 2, lastSent: "2026-11-04" },
    { email: "b@x.com", status: "active", step: 1, lastSent: "2026-11-03" },
    { email: "c@x.com", status: "stopped", step: 1, lastSent: "2026-11-03" },
    { email: "d@x.com", status: "active", step: 0, lastSent: null },
    { email: "e@x.com", status: "active", step: 0, lastSent: null }
  ].map((row) => ({ ...row, enrolledAt: "2026-11-01T00:00:00.000Z", sender: "anna@send.com" }));
  const esp = { campaigns: { list: () => [{ id: "c1", name: "Operators", state: "running", steps: [{}, {}, {}], senders: ["anna@send.com"] }], enrollmentsOf: () => rows } };
  let answer = null;
  await handleEspApi({
    request: { method: "GET", auth: { profile: { role: "admin" } } }, response: {}, url: new URL("http://x/api/esp/campaigns"),
    sendJson: (_r, status, payload) => { answer = { status, payload }; }, readJson: async () => null, esp
  });
  const [campaign] = answer.payload.campaigns;
  assert.deepEqual(campaign.byStep, [3, 1, 0], "a resend of the 2nd letter is one person, not two");
  assert.equal(campaign.waiting, 2);
});
