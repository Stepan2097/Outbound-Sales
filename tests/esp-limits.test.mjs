import assert from "node:assert/strict";
import test from "node:test";

import {
  COLD_LIMIT_DEFAULT, DOMAIN_DAILY_LIMIT, GAP_MINUTES, coldAllowance, inWindow, localTime, nextWindowOpen, seeded, sendDecision, sendLedger, senderDailyLimit, zonesFor
} from "../esp/limits.mjs";

/**
 * ESP 4 — limits per sender and per domain, the recipient's working window,
 * random gaps, and no catching up.
 */

const SENDER = { email: "anna@advantage-mail.com", rampStage: 10 };
const POLAND = { country: "Poland" };
// Tuesday 13.10.2026, 11:00 in Warsaw (09:00 UTC), 12:00 in Kyiv.
const TUESDAY = new Date("2026-10-13T09:00:00Z");

let seq = 0;
function sent(from, at, { failed = false } = {}) {
  seq += 1;
  const sending = { seq, type: "message.sending", at: new Date(at).toISOString(), data: { from, to: `lead${seq}@example.com` } };
  return failed ? [sending, { seq: seq + 1000, type: "message.failed", at: sending.at, data: { sendingSeq: seq } }] : [sending];
}
const ledgerOf = (rows, now = TUESDAY) => sendLedger(rows.flat(), { now });
// One cold letter on each of `days` days of the week before: a mailbox that has
// written cold mail that many days, so its daily ramp has climbed.
const before = (from, days) => Array.from({ length: days }, (_, index) => sent(from, new Date("2026-10-05T09:00:00Z").getTime() + index * 86_400_000));

// ── limits ──────────────────────────────────────────────────────────────────

test("a mailbox's ceiling is what was set for it, 35 (the target) until then, never above 35 (03.11)", () => {
  assert.equal(COLD_LIMIT_DEFAULT, 35);
  assert.equal(senderDailyLimit({}), 35);
  assert.equal(senderDailyLimit({ coldLimit: 12 }), 12);
  assert.equal(senderDailyLimit({ coldLimit: 0 }), 0);
  assert.equal(senderDailyLimit({ coldLimit: 80 }), 35);
});

test("a mailbox's day is its ramp stage — start 5, +5 a clean week, to 35 — under its ceiling (03.11, the strategy)", () => {
  assert.equal(coldAllowance({}), 5, "a new mailbox starts at 5");
  assert.deepEqual([5, 10, 15, 35].map((rampStage) => coldAllowance({ rampStage })), [5, 10, 15, 35]);
  assert.equal(coldAllowance({ rampStage: 20, coldLimit: 12 }), 12, "the ceiling typed in the table wins");
  assert.equal(coldAllowance({ rampStage: 50 }), 5, "an unknown stage is the first one");
  const answer = sendDecision({ sender: { email: SENDER.email, rampStage: 15 }, recipient: POLAND, ledger: ledgerOf([]), now: TUESDAY });
  assert.equal(answer.limit, 15);
});

test("the limit counts every campaign's letters of the day; a failed attempt does not count, one in flight does", () => {
  const rows = before(SENDER.email, 4);
  for (let index = 0; index < 9; index += 1) rows.push(sent(SENDER.email, TUESDAY.getTime() - (index + 1) * 50 * 60_000));
  rows.push(sent(SENDER.email, TUESDAY.getTime() - 20 * 60_000, { failed: true }));
  const ledger = ledgerOf(rows);
  assert.equal(ledger.senders.get(SENDER.email).today, 9);
  const tenth = sendDecision({ sender: SENDER, recipient: POLAND, ledger, now: new Date(TUESDAY.getTime() + 60 * 60_000) });
  assert.equal(tenth.ok, true, tenth.message);

  rows.push(sent(SENDER.email, TUESDAY.getTime() + 30 * 60_000));
  const full = sendDecision({ sender: SENDER, recipient: POLAND, ledger: ledgerOf(rows), now: new Date(TUESDAY.getTime() + 3 * 3600_000) });
  assert.equal(full.ok, false);
  assert.equal(full.reason, "sender_daily_limit");
  assert.equal(new Date(full.retryAt).toISOString(), "2026-10-13T21:00:00.000Z", "back at midnight in Kyiv, not in twelve minutes");
});

test("the domain stops at 105 a day across all its senders", () => {
  const rows = [];
  for (let sender = 0; sender < 3; sender += 1) {
    for (let index = 0; index < 35; index += 1) rows.push(sent(`s${sender}@advantage-mail.com`, TUESDAY.getTime() - (index + 1) * 60_000));
  }
  const ledger = ledgerOf(rows);
  assert.equal(ledger.domains.get("advantage-mail.com"), DOMAIN_DAILY_LIMIT);
  const fourth = sendDecision({ sender: { email: "s3@advantage-mail.com", rampStage: 35 }, recipient: POLAND, ledger, now: TUESDAY });
  assert.equal(fourth.reason, "domain_daily_limit");
  const elsewhere = sendDecision({ sender: { email: "s0@other-mail.com", rampStage: 35 }, recipient: POLAND, ledger, now: TUESDAY });
  assert.notEqual(elsewhere.reason, "domain_daily_limit");
});

// ── the recipient's window ─────────────────────────────────────────────────

test("the window is 08:00–17:00 on weekdays where the recipient is", () => {
  const warsaw = zonesFor(POLAND);
  assert.equal(inWindow(new Date("2026-10-13T05:59:00Z"), warsaw), false, "07:59 in Warsaw");
  assert.equal(inWindow(new Date("2026-10-13T06:00:00Z"), warsaw), true, "08:00 in Warsaw");
  assert.equal(inWindow(new Date("2026-10-13T14:59:00Z"), warsaw), true, "16:59");
  assert.equal(inWindow(new Date("2026-10-13T15:00:00Z"), warsaw), false, "17:00 is closed");
  assert.equal(inWindow(new Date("2026-10-17T09:00:00Z"), warsaw), false, "Saturday");
  assert.equal(inWindow(new Date("2026-10-18T09:00:00Z"), warsaw), false, "Sunday");
});

test("a country with several zones gets letters only when it is working hours in all of them", () => {
  const us = zonesFor({ country: "USA" });
  assert.ok(us.includes("America/Los_Angeles") && us.includes("America/New_York"));
  // 09:00 in New York is 06:00 in Los Angeles: not yet.
  assert.equal(inWindow(new Date("2026-10-13T13:00:00Z"), us), false);
  // 11:00 in New York, 08:00 in Los Angeles.
  assert.equal(inWindow(new Date("2026-10-13T15:00:00Z"), us), true);
  // 17:00 in New York.
  assert.equal(inWindow(new Date("2026-10-13T21:00:00Z"), us), false);
  // An explicit zone on the lead is used as is.
  assert.deepEqual(zonesFor({ timezone: "America/Chicago", country: "USA" }), ["America/Chicago"]);
});

test("outside the window or on a weekend the answer names when it opens; an unknown zone is not guessed", () => {
  const evening = sendDecision({ sender: SENDER, recipient: POLAND, ledger: ledgerOf([]), now: new Date("2026-10-13T16:30:00Z") });
  assert.equal(evening.reason, "outside_window");
  assert.equal(evening.retryAt, "2026-10-14T06:00:00.000Z", "08:00 the next morning in Warsaw");
  const friday = sendDecision({ sender: SENDER, recipient: POLAND, ledger: ledgerOf([]), now: new Date("2026-10-16T15:30:00Z") });
  assert.equal(friday.reason, "outside_window");
  const saturday = sendDecision({ sender: SENDER, recipient: POLAND, ledger: ledgerOf([]), now: new Date("2026-10-17T10:00:00Z") });
  assert.equal(saturday.reason, "weekend");
  assert.equal(saturday.retryAt, "2026-10-19T06:00:00.000Z", "Monday 08:00 in Warsaw");
  // Unknown country: European working hours (03.11) — Berlin's 08–17.
  assert.deepEqual(zonesFor({ country: "" }), ["Europe/Berlin"]);
  assert.equal(sendDecision({ sender: SENDER, recipient: { country: "Atlantis" }, ledger: ledgerOf([]), now: TUESDAY, spreadDay: false }).reason !== "unknown_timezone", true);
  assert.equal(sendDecision({ sender: SENDER, recipient: {}, ledger: ledgerOf([]), now: new Date("2026-10-13T16:30:00Z") }).reason, "outside_window", "18:30 in Berlin");
  assert.equal(nextWindowOpen(TUESDAY, []), null);
});

// ── gaps ──────────────────────────────────────────────────────────────────

test("12–40 minutes between one sender's letters, the same gap on every tick", () => {
  const last = new Date(TUESDAY.getTime() - 5 * 60_000);
  const ledger = ledgerOf([sent(SENDER.email, last)]);
  const soon = sendDecision({ sender: SENDER, recipient: POLAND, ledger, now: TUESDAY, spreadDay: false });
  assert.equal(soon.reason, "too_soon");
  const gap = (new Date(soon.retryAt) - last) / 60_000;
  assert.ok(gap >= GAP_MINUTES.min && gap <= GAP_MINUTES.max, `gap ${gap}`);
  const again = sendDecision({ sender: SENDER, recipient: POLAND, ledger, now: new Date(TUESDAY.getTime() + 60_000), spreadDay: false });
  assert.equal(again.retryAt, soon.retryAt, "the gap was re-rolled between two ticks");
  assert.equal(sendDecision({ sender: SENDER, recipient: POLAND, ledger, now: new Date(soon.retryAt), spreadDay: false }).ok, true);

  const gaps = new Set(Array.from({ length: 200 }, (_, index) => seeded(`x|${index}`, GAP_MINUTES.min, GAP_MINUTES.max)));
  assert.ok(Math.min(...gaps) >= 12 && Math.max(...gaps) <= 40);
  assert.ok(gaps.size > 20, "the gaps are not one number");
});

test("no burst at the opening: senders start their day at different minutes, never right on the hour", () => {
  const opening = new Date("2026-10-13T06:00:00Z"); // 08:00 in Warsaw
  const starts = [];
  for (let index = 0; index < 12; index += 1) {
    const sender = { email: `s${index}@advantage-mail.com`, rampStage: 35 };
    const first = sendDecision({ sender, recipient: POLAND, ledger: ledgerOf([]), now: opening });
    assert.equal(first.reason, "too_soon", "a sender went at 08:00 sharp");
    const minutes = (new Date(first.retryAt) - opening) / 60_000;
    assert.ok(minutes >= 3 && minutes <= 40, `start offset ${minutes}`);
    starts.push(minutes);
  }
  assert.ok(new Set(starts).size >= 6, "everybody starts at the same minute");
});

// ── no catching up ─────────────────────────────────────────────────────────

test("yesterday's unsent letters do not make today's limit bigger", () => {
  const monday = new Date("2026-10-12T09:00:00Z");
  // On Monday the sender managed only 2 of its 10 (it had written cold mail for three days before).
  const rows = [...before(SENDER.email, 3), sent(SENDER.email, monday.getTime()), sent(SENDER.email, monday.getTime() + 30 * 60_000)];
  // On Tuesday it sends its ten through the day, gap by gap…
  let now = new Date("2026-10-13T07:00:00Z");
  let sentTuesday = 0;
  for (let tick = 0; tick < 200 && now < new Date("2026-10-13T15:00:00Z"); tick += 1) {
    const decision = sendDecision({ sender: SENDER, recipient: POLAND, ledger: ledgerOf(rows, now), now, spreadDay: false });
    if (decision.ok) {
      rows.push(sent(SENDER.email, now));
      sentTuesday += 1;
    } else if (decision.reason === "sender_daily_limit") {
      break;
    }
    now = new Date(now.getTime() + 5 * 60_000);
  }
  // …and stops at ten, not at eighteen.
  assert.equal(sentTuesday, 10);
  const after = sendDecision({ sender: SENDER, recipient: POLAND, ledger: ledgerOf(rows, now), now, spreadDay: false });
  assert.equal(after.reason, "sender_daily_limit");
  const times = rows.slice(5).map((row) => new Date(row[0].at));
  for (let index = 1; index < times.length; index += 1) {
    assert.ok((times[index] - times[index - 1]) / 60_000 >= GAP_MINUTES.min, "two letters closer than 12 minutes");
  }
});

test("a mailbox's cold letters are spread over the working day, not sent in its first hour (03.11)", () => {
  // A new mailbox: 5 today, so about 1¾ hours apart (9-hour window ÷ 5, ± a quarter).
  const fresh = { email: "anna@advantage-mail.com" };
  const rows = [];
  let now = new Date("2026-10-13T06:00:00Z"); // 08:00 in Warsaw
  while (now < new Date("2026-10-13T15:00:00Z")) {
    if (sendDecision({ sender: fresh, recipient: POLAND, ledger: ledgerOf(rows, now), now }).ok) rows.push(sent(fresh.email, now));
    now = new Date(now.getTime() + 5 * 60_000);
  }
  const times = rows.map((row) => new Date(row[0].at).getTime());
  assert.ok(times.length >= 4 && times.length <= 5, `sent ${times.length}`);
  for (let index = 1; index < times.length; index += 1) {
    const gap = (times[index] - times[index - 1]) / 60_000;
    assert.ok(gap >= 81 && gap <= 140, `gap ${gap}`);
  }
});

test("local time is read in the zone asked for", () => {
  assert.deepEqual(localTime(new Date("2026-10-13T21:30:00Z"), "Europe/Kyiv"), { weekday: 3, hour: 0, minute: 30, date: "2026-10-14" });
});

test("/api/esp/limits reads the registry and the journal: each sender's day against its limit and ramp, each domain's against 105", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { append, useJournal } = await import("../esp/journal.mjs");
  const { addDomain, addSender, setDomainStatus, updateSender } = await import("../esp/registry.mjs");
  const { handleEspApi } = await import("../esp/api.mjs");
  const dir = await mkdtemp(join(tmpdir(), "esp-limits-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });

  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: "anna@advantage-mail.com" }, "test");
  await updateSender({ email: "anna@advantage-mail.com", coldLimit: 10 }, "test");
  for (let index = 0; index < 3; index += 1) {
    await append({ type: "message.sending", contact: `lead${index}@example.com`, data: { from: "anna@advantage-mail.com", to: `lead${index}@example.com` } });
  }
  let answer = null;
  await handleEspApi({
    request: { method: "GET", auth: { profile: { role: "admin" } } }, response: {}, url: new URL("http://x/api/esp/limits"),
    sendJson: (_r, status, payload) => { answer = { status, payload }; }, readJson: async () => null, esp: {}
  });
  assert.equal(answer.status, 200);
  const anna = answer.payload.senders.find((row) => row.email === "anna@advantage-mail.com");
  assert.deepEqual([anna.today, anna.limit, anna.coldLimit], [3, 5, 10], "a new mailbox: 5 a day under a ceiling of 10");
  assert.deepEqual(answer.payload.domains.map((row) => [row.domain, row.today, row.limit]), [["advantage-mail.com", 3, 105]]);
});

test("a mail provider's own domain is not one sender: many @gmail.com mailboxes do not share the domain's day", async () => {
  const { PUBLIC_MAIL_DOMAINS } = await import("../esp/limits.mjs");
  assert.ok(PUBLIC_MAIL_DOMAINS.has("gmail.com"));
  const ledger = { senders: new Map(), domains: new Map([["gmail.com", DOMAIN_DAILY_LIMIT + 50]]) };
  const answer = sendDecision({ sender: { email: "olena.advantage@gmail.com", rampStage: 5 }, recipient: { country: "UA" }, ledger, now: new Date("2026-10-14T09:00:00Z") });
  assert.notEqual(answer.reason, "domain_daily_limit");
});

test("«Холодних листів»: the limit is typed per mailbox and kept in the registry; outside 0–35 it is refused (03.11)", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { useJournal } = await import("../esp/journal.mjs");
  const { addDomain, addSender, registry, setDomainStatus } = await import("../esp/registry.mjs");
  const { handleEspApi } = await import("../esp/api.mjs");
  const dir = await mkdtemp(join(tmpdir(), "esp-cold-limit-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: "anna@advantage-mail.com" }, "test");

  const post = async (body) => {
    let answer = null;
    await handleEspApi({
      request: { method: "POST", auth: { profile: { role: "admin", email: "owner@advantage.agency" } } }, response: {}, url: new URL("http://x/api/esp/warmup/cold-limit"),
      sendJson: (_r, status, payload) => { answer = { status, payload }; }, readJson: async () => body, esp: {}
    });
    return answer;
  };
  assert.equal((await post({ mailbox: "anna@advantage-mail.com", limit: 12 })).status, 200);
  const anna = (await registry()).senders.find((row) => row.email === "anna@advantage-mail.com");
  assert.deepEqual([anna.coldLimit, senderDailyLimit(anna)], [12, 12]);
  assert.equal((await post({ mailbox: "anna@advantage-mail.com", limit: 36 })).status, 400);
  assert.equal((await post({ mailbox: "anna@advantage-mail.com", limit: 2.5 })).status, 400);
  assert.equal((await post({ mailbox: "nobody@advantage-mail.com", limit: 5 })).status, 404);
});
