import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyAlerts, reviewAlerts, telegramNotifier } from "../esp/alerts.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { addDomain, addSender, canSend, registry, setDomainStatus, setSenderStatus } from "../esp/registry.mjs";

/**
 * ESP 8 — a sender with too many bounces, a campaign whose first people bounce,
 * and Gmail refusing: paused without anybody pressing, with the reason, and a
 * person told once.
 */

const NOW = new Date("2026-10-13T12:00:00Z");
const ANNA = "anna@advantage-mail.com";
const sender = (email = ANNA) => ({ email, status: "active" });
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3600_000).toISOString();

function sends(count, { from = ANNA, hours = 24, campaignId = "c-1" } = {}) {
  return Array.from({ length: count }, (_, index) => ({ type: "message.sent", at: hoursAgo(hours), contact: `l${index}@co${index}.com`, data: { from, campaignId } }));
}
const bounce = (contact, code = "5.1.1", hours = 2) => ({ type: "message.bounced", at: hoursAgo(hours), contact, data: { sender: ANNA, code, campaignId: "c-1" } });
const review = (entries, extra = {}) => reviewAlerts({ entries, senders: [sender()], campaigns: [], enrollmentsOf: () => [], now: NOW, ...extra });

test("more than 2% permanent bounces in 7 days pauses the sender; 2% exactly does not; a 4.x.x is not a bounce here", () => {
  const sent = sends(100);
  assert.deepEqual(review([...sent, bounce("l1@co1.com"), bounce("l2@co2.com")]), [], "2 of 100 is not more than 2%");
  const three = review([...sent, bounce("l1@co1.com"), bounce("l2@co2.com"), bounce("l3@co3.com")]);
  assert.deepEqual(three.map((row) => [row.kind, row.code]), [["pause_sender", "bounce_rate_7d"]]);
  assert.match(three[0].reason, /3\.0% за 7 днів/);
  assert.deepEqual(review([...sent, ...["l1@co1.com", "l2@co2.com", "l3@co3.com"].map((contact) => bounce(contact, "4.4.7"))]), []);
});

test("3 bounces on the last 100 letters pauses the sender even when the week is bigger", () => {
  const old = sends(300, { hours: 24 * 6 });
  const recent = sends(100, { hours: 1 }).map((row, index) => ({ ...row, contact: `r${index}@r${index}.com` }));
  const findings = review([...old, ...recent, bounce("r1@r1.com", "5.1.1", 0.5), bounce("r2@r2.com", "5.1.1", 0.5), bounce("r3@r3.com", "5.1.1", 0.5)]);
  assert.deepEqual(findings.map((row) => row.code), ["bounce_per_100"]);
});

test("Gmail refusing — a daily limit, a blocked account, a pile of failures in an hour, a 5.7.x by policy — pauses the sender", () => {
  const fail = (error, hours = 1) => ({ type: "message.failed", at: hoursAgo(hours), data: { from: ANNA, error } });
  assert.deepEqual(review([fail("Gmail API відповів 429: User-rate limit exceeded.")]).map((row) => row.code), ["gmail_limit"]);
  assert.deepEqual(review([fail("Gmail API відповів 403: Mail service not enabled; account disabled")]).map((row) => row.code), ["gmail_blocked"]);
  assert.deepEqual(review(Array.from({ length: 5 }, () => fail("Gmail API відповів 503: Backend Error", 0.2))).map((row) => row.code), ["gmail_mass_failures"]);
  assert.deepEqual(review(Array.from({ length: 4 }, () => fail("Gmail API відповів 503: Backend Error", 0.2))), [], "four is not a pile");
  assert.deepEqual(review([{ type: "sender.alert", at: hoursAgo(3), data: { email: ANNA, code: "5.7.1", contact: "ceo@big.com" } }]).map((row) => row.code), ["policy_bounce"]);
});

test("a new campaign with more than 3% bounces among its first 100–300 people is paused; fewer than 100 reached is too early to tell", () => {
  const people = Array.from({ length: 150 }, (_, index) => ({ email: `p${index}@p${index}.com`, firstSentAt: hoursAgo(10 - index / 100) }));
  const campaign = { id: "c-1", name: "Northwind", state: "running" };
  const bounced = ["p1", "p2", "p3", "p4", "p5"].map((name) => bounce(`${name}@${name}.com`));
  const findings = reviewAlerts({ entries: bounced, senders: [], campaigns: [campaign], enrollmentsOf: () => people, now: NOW });
  assert.deepEqual(findings.map((row) => [row.kind, row.code]), [["pause_campaign", "campaign_bounce"]]);
  assert.match(findings[0].reason, /3\.3% на перших 150/);
  assert.deepEqual(reviewAlerts({ entries: bounced, senders: [], campaigns: [campaign], enrollmentsOf: () => people.slice(0, 80), now: NOW }), []);
  assert.deepEqual(reviewAlerts({ entries: bounced.slice(0, 4), senders: [], campaigns: [campaign], enrollmentsOf: () => people, now: NOW }), [], "4 of 150 is under 3%");
});

test("applied: the sender is paused in the registry with the reason, the alarm is journalled and sent once — not every hour", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "esp-alerts-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: ANNA, rampStage: 35 }, "test");
  for (const row of sends(50)) await append({ type: row.type, contact: row.contact, data: row.data });
  for (const contact of ["l1@co1.com", "l2@co2.com"]) await append({ type: "message.bounced", contact, data: { sender: ANNA, code: "5.1.1" } });
  const told = [];
  const run = async () => {
    const entries = await allEntries();
    const actions = reviewAlerts({ entries, senders: (await registry()).senders, campaigns: [], enrollmentsOf: () => [] });
    return applyAlerts({ actions, entries, setSenderStatus, pauseCampaign: async () => {}, append, notify: async (text) => { told.push(text); } });
  };
  assert.equal((await run()).length, 1);
  assert.equal((await canSend(ANNA)).ok, false, "the sender still sends");
  const paused = (await registry()).senders.find((row) => row.email === ANNA);
  assert.equal(paused.status, "paused");
  assert.match(paused.history.at(-1).reason, /bounce 4\.0% за 7 днів/);
  assert.equal(paused.history.at(-1).code, "bounce_rate_7d");
  assert.equal(told.length, 1);
  assert.match(told[0], /Сендер anna@advantage-mail\.com на паузі/);
  assert.equal((await run()).length, 0, "raised again an hour later");
  assert.equal((await allEntries()).filter((entry) => entry.type === "esp.alert").length, 1);
});

test("a campaign paused by an alarm keeps why, for the person who checks its source", async () => {
  const { campaignStore } = await import("../esp/campaigns.mjs");
  let campaigns = [{ id: "c-1", name: "N", state: "running", steps: [], senders: [] }];
  const store = campaignStore({ read: () => campaigns, write: async (value) => { campaigns = value; }, readEnrollments: () => [], writeEnrollments: async () => {}, templates: () => [] });
  const paused = await store.pauseForReview("c-1", "bounce 3.3% на перших 150");
  assert.equal(paused.state, "paused");
  assert.equal(paused.sourceReview.reason, "bounce 3.3% на перших 150");
  assert.equal(await store.pauseForReview("c-1", "again"), null, "an already paused campaign is left alone");
});

test("Telegram only when both the token and the chat are set; send only", async () => {
  assert.equal(telegramNotifier({}).configured, false);
  assert.equal(telegramNotifier({ TELEGRAM_BOT_TOKEN: "x" }).configured, false);
  const calls = [];
  const telegram = telegramNotifier({ TELEGRAM_BOT_TOKEN: "123:abc", ESP_ALERT_CHAT_ID: "-100" }, { fetch: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true }; } });
  await telegram.notify("⚠️ test");
  assert.equal(calls[0][0], "https://api.telegram.org/bot123:abc/sendMessage");
  assert.deepEqual(calls[0][1].chat_id, "-100");
});

test("when the pause itself cannot be set, the person is still told only once a day", async () => {
  const told = [];
  const journal = [];
  const actions = [{ kind: "pause_sender", email: ANNA, code: "gmail_limit", reason: "Gmail: ліміт", key: `sender:${ANNA}:gmail_limit` }];
  const run = () => applyAlerts({
    actions, entries: journal, now: NOW,
    setSenderStatus: async () => { throw new Error("not in the registry"); },
    pauseCampaign: async () => {}, append: async (event) => { journal.push({ ...event, at: NOW.toISOString() }); },
    notify: async (text) => { told.push(text); }
  });
  await run();
  await run();
  assert.equal(told.length, 1, "told every hour");
});
