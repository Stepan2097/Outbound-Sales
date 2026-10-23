import assert from "node:assert/strict";
import test from "node:test";

import { ESP_BULK, NO_LEADGEN, periodReport, reportRange, teamReport } from "../triage/team-report.mjs";

/**
 * «Звіт команди» (Марко 21.10, таск 3bc6830a): хто що зробив і з яким результатом за
 * день чи тиждень, у порівнянні з таким самим періодом раніше. LinkedIn — події агента,
 * зараховані лідгену акаунта; кваліфіковані — мітки Вхідних; дзвінки — історія CRM.
 */

const BOGDAN = "b@agency.co";
const event = (type, account, thread, at) => ({ type, account_id: account, created_at: at, meta: { threadKey: thread, sentAt: at, sentAtIso: false } });
const facts = (extra = {}) => ({
  leadgens: { acc1: "u-bogdan" },
  people: new Map([["u-bogdan", BOGDAN], ["u-pavlo", "p@agency.co"]]),
  names: new Map([[BOGDAN, "Богдан"]]),
  events: [], labels: {}, calls: [], journal: [], entries: [],
  ...extra
});

test("day compares with the same weekday a week ago; week runs Monday to Sunday", () => {
  assert.deepEqual(reportRange({ period: "day", date: "2026-10-21" }), { period: "day", from: "2026-10-21", to: "2026-10-21", prevFrom: "2026-10-14", prevTo: "2026-10-14" });
  assert.deepEqual(reportRange({ period: "week", date: "2026-10-21" }), { period: "week", from: "2026-10-19", to: "2026-10-25", prevFrom: "2026-10-12", prevTo: "2026-10-18" });
  assert.equal(reportRange({ period: "week", date: "2026-10-25" }).from, "2026-10-19", "Sunday belongs to the week that began on Monday");
});

test("LinkedIn sends count for the lead-gen who runs the account; people, not messages", () => {
  const report = periodReport(facts({
    events: [
      event("message.out", "acc1", "t1", "2026-10-21T08:00:00Z"),
      event("message.out", "acc1", "t1", "2026-10-21T09:00:00Z"),
      event("message.out", "acc1", "t2", "2026-10-21T10:00:00Z"),
      event("message.in", "acc1", "t2", "2026-10-21T11:00:00Z"),
      event("message.out", "acc-free", "t3", "2026-10-21T10:00:00Z"),
      event("message.out", "acc1", "t4", "2026-10-20T10:00:00Z")
    ]
  }), { from: "2026-10-21", to: "2026-10-21", now: new Date("2026-10-21T12:00:00Z") });
  const bogdan = report.rows.find((row) => row.key === BOGDAN);
  assert.equal(bogdan.name, "Богдан");
  assert.equal(bogdan.written, 2, "two people, though three messages; yesterday's is not today's");
  assert.equal(bogdan.replied, 1);
  assert.equal(bogdan.rate, 50);
  assert.equal(report.rows.find((row) => row.key === NO_LEADGEN).written, 1, "an account nobody runs is its own row");
  assert.equal(report.total.written, 3);
});

test("speed: from the person's first message to our answer; over a day — or no answer yet — is slow", () => {
  const report = periodReport(facts({
    events: [
      event("message.in", "acc1", "t1", "2026-10-21T08:00:00Z"),
      event("message.in", "acc1", "t1", "2026-10-21T08:30:00Z"),
      event("message.out", "acc1", "t1", "2026-10-21T09:00:00Z"),
      event("message.in", "acc1", "t2", "2026-10-19T08:00:00Z"),
      event("message.out", "acc1", "t2", "2026-10-20T10:00:00Z"),
      event("message.in", "acc1", "t3", "2026-10-19T09:00:00Z"),
      // Імпорт розмов: «відповідь» у ту саму мить — не відповідь.
      event("message.in", "acc1", "t4", "2026-10-19T10:00:00Z"),
      event("message.out", "acc1", "t4", "2026-10-19T10:00:00Z")
    ]
  }), { from: "2026-10-19", to: "2026-10-25", now: new Date("2026-10-21T12:00:00Z") });
  const bogdan = report.rows.find((row) => row.key === BOGDAN);
  assert.equal(bogdan.answeredCount, 2, "an answer in the same moment is not counted");
  assert.equal(bogdan.responseMedianMinutes, (60 + 26 * 60) / 2);
  assert.equal(bogdan.slow, 2, "26 hours to answer, and one still waiting since Monday");
});

test("qualified — by who set «Кваліфікований» in CRM in the period, never AI's label (таск e06c67c1); calls by who set «Дзвінок»", () => {
  const report = periodReport(facts({
    labels: { "acc1|t9": { label: "qualified", basis: "2|2026-10-21T08:00:00Z" } },
    qualified: [{ changed_at: "2026-10-21T08:00:00Z", changed_by: "u-bogdan" }, { changed_at: "2026-10-10T08:00:00Z", changed_by: "u-bogdan" }],
    calls: [{ changed_at: "2026-10-21T08:08:00Z", changed_by: "u-bogdan" }, { changed_at: "2026-10-21T09:00:00Z", changed_by: "u-pavlo" }, { changed_at: "2026-10-01T09:00:00Z", changed_by: "u-pavlo" }]
  }), { from: "2026-10-21", to: "2026-10-21" });
  assert.equal(report.rows.find((row) => row.key === BOGDAN).qualified, 1);
  assert.equal(report.rows.find((row) => row.key === BOGDAN).calls, 1);
  assert.equal(report.rows.find((row) => row.key === "p@agency.co").calls, 1);
  assert.equal(report.total.calls, 2);
});

test("mail counts in full: a letter by button is its sender's, the rest are the ESP campaigns'", () => {
  const report = periodReport(facts({
    entries: [{ action: "wrote", channel: "email", email: "lead@x.com", user: BOGDAN, at: "2026-10-21T07:59:00Z" }],
    journal: [
      { type: "message.sent", contact: "lead@x.com", at: "2026-10-21T08:00:00Z" },
      { type: "message.sent", contact: "bulk1@x.com", at: "2026-10-21T08:00:00Z" },
      { type: "message.sent", contact: "bulk2@x.com", at: "2026-10-21T08:00:00Z" },
      { type: "message.replied", contact: "bulk2@x.com", at: "2026-10-21T10:00:00Z" }
    ]
  }), { from: "2026-10-21", to: "2026-10-21" });
  assert.equal(report.rows.find((row) => row.key === BOGDAN).writtenEmail, 1);
  const bulk = report.rows.find((row) => row.key === ESP_BULK);
  assert.equal(bulk.name, "Розсилки пошти");
  assert.deepEqual([bulk.written, bulk.replied], [2, 1]);
});

test("the report pairs the period with the one before; a seller sees only their own row", () => {
  const data = facts({
    events: [
      event("message.out", "acc1", "t1", "2026-10-21T08:00:00Z"),
      event("message.out", "acc1", "t2", "2026-10-14T08:00:00Z"),
      event("message.out", "acc1", "t3", "2026-10-14T09:00:00Z"),
      event("message.out", "acc-free", "t4", "2026-10-21T08:00:00Z")
    ]
  });
  const report = teamReport(data, { period: "day", date: "2026-10-21", now: new Date("2026-10-21T12:00:00Z") });
  assert.equal(report.total.written, 2);
  assert.equal(report.previous.written, 2);
  assert.equal(report.rows.find((row) => row.key === BOGDAN).previous.written, 2);
  const mine = teamReport(data, { period: "week", date: "2026-10-21", now: new Date("2026-10-21T12:00:00Z"), only: BOGDAN });
  assert.deepEqual(mine.rows.map((row) => row.key), [BOGDAN]);
  assert.equal(mine.total.written, 1);
  assert.equal(mine.days.find((day) => day.date === "2026-10-21").written, 1, "the week strip is the seller's own too");
  assert.equal(mine.days.length, 7);
});

test("a week still going is compared with the same days of the week before, not the whole of it", () => {
  const data = facts({
    events: [
      event("message.out", "acc1", "t1", "2026-10-20T08:00:00Z"),
      event("message.out", "acc1", "t2", "2026-10-13T08:00:00Z"),
      event("message.out", "acc1", "t3", "2026-10-17T08:00:00Z")
    ]
  });
  const going = teamReport(data, { period: "week", date: "2026-10-21", now: new Date("2026-10-21T12:00:00Z") });
  assert.equal(going.partial, true);
  assert.deepEqual([going.prevFrom, going.prevTo], ["2026-10-12", "2026-10-14"]);
  assert.equal(going.previous.written, 1, "Saturday the 17th is past Wednesday — not counted against Monday–Wednesday");
  const done = teamReport(data, { period: "week", date: "2026-10-14", now: new Date("2026-10-21T12:00:00Z") });
  assert.equal(done.partial, undefined);
  assert.equal(done.total.written, 2);
});

test("journal of the day: a LinkedIn name loses the status and headline glued to it; rows are as tall as their content", async () => {
  const { participantName } = await import("../triage/work-log.mjs");
  assert.equal(participantName("Ako Gurjinyan Статус «офлайн» Founder | Entrepreneur | Investor-Ready Leader"), "Ako Gurjinyan");
  assert.equal(participantName("André Vinícius de Alencar Alves Статус «онлайн» Активний зараз"), "André Vinícius de Alencar Alves");
  assert.equal(participantName("Переглянути профіль Luke Status is online"), "Luke");
  assert.equal(participantName("Bar Afuta"), "Bar Afuta");
  assert.equal(participantName(""), null);
  const { readFileSync } = await import("node:fs");
  const grammar = readFileSync(new URL("../app/styles/grammar.css", import.meta.url), "utf8");
  const work = readFileSync(new URL("../app/styles/work.css", import.meta.url), "utf8");
  assert.match(grammar, /\.work-rows \{[^}]*grid-auto-rows: max-content;/, "a button's min-height must not let the list squeeze rows");
  assert.match(work, /\.work-row \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*padding: var\(--sp-3\) var\(--sp-4\);/);
});

test("a lead-gen's day journal: the sends from the accounts they run, not only the portal's buttons (таск 556679b0)", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /const led = user === "all" \? null : await accountsLedBy\(user, user === viewer \? profile\?\.id : ""\);/);
  assert.match(server, /const shown = led \? sends\.filter\(\(send\) => led\.has\(send\.accountId\)\) : sends;/);
  assert.match(server, /async function accountsLedBy\(email, knownId = ""\)/);
});
