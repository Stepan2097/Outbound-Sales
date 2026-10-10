import assert from "node:assert/strict";
import test from "node:test";

import { easterSunday, holidayCountry, holidaysOf, isHoliday, orthodoxEasterSunday } from "../esp/holidays.mjs";
import { inWindow, nextWindowOpen, sendDecision, sendLedger, zonesFor } from "../esp/limits.mjs";
import { addWorkingDays, postponedDue } from "../esp/sequence.mjs";

/**
 * ESP 17 — «Свята країни одержувача — пропускати державні вихідні.»
 */

test("Easter, Western and Orthodox, lands on the known Sundays", () => {
  for (const [year, day] of [[2025, "2025-04-20"], [2026, "2026-04-05"], [2027, "2027-03-28"], [2028, "2028-04-16"]]) {
    assert.equal(easterSunday(year).toISOString().slice(0, 10), day);
  }
  for (const [year, day] of [[2025, "2025-04-20"], [2026, "2026-04-12"], [2027, "2027-05-02"]]) {
    assert.equal(orthodoxEasterSunday(year).toISOString().slice(0, 10), day);
  }
});

test("each market's days off: fixed, from Easter, the n-th Monday, moved off the weekend", () => {
  const has = (country, ...days) => days.forEach((day) => assert.ok(isHoliday(country, day), `${country} ${day}`));
  has("Poland", "2026-04-06", "2026-06-04", "2026-11-11", "2026-12-24");
  has("Germany", "2026-04-03", "2026-05-14", "2026-10-03");
  has("United States", "2026-01-19", "2026-07-03", "2026-11-26");   // MLK, July 4th on a Saturday → Friday, Thanksgiving
  has("UK", "2026-05-04", "2026-08-31", "2026-12-28");               // Boxing Day on a Saturday → Monday
  has("Canada", "2026-05-18", "2026-10-12");                        // Victoria Day, Thanksgiving
  has("Ireland", "2026-02-02", "2026-03-17");
  has("Cyprus", "2026-04-10", "2026-04-13");                        // Orthodox Good Friday and Easter Monday
  has("Brazil", "2026-02-16", "2026-02-17", "2026-11-20");
  has("IT", "2026-10-04");
  assert.equal(isHoliday("Poland", "2026-10-13"), false);
  assert.equal(isHoliday("Germany", "2026-11-11"), false, "Poland's day is not Germany's");
  assert.equal(isHoliday("Ukraine", "2026-08-24"), false, "martial law: holidays are working days");
  assert.equal(isHoliday("Atlantis", "2026-12-25"), false, "an unknown country has no holidays, not an error");
  assert.equal(holidayCountry("польща"), "PL");
  assert.equal(holidayCountry("us"), "US");
  assert.ok(holidaysOf("PL", 2027).has("2027-12-25"));
});

test("no letter goes on the recipient's public holiday; it comes back the next working morning", () => {
  const recipient = { email: "olena@northwind.pl", country: "Poland" };
  const zones = zonesFor(recipient);
  const allSaints = new Date("2027-11-01T10:00:00Z"); // Monday, 11:00 in Warsaw
  assert.equal(inWindow(allSaints, zones), true, "the weekday window alone would let it go");
  assert.equal(inWindow(allSaints, zones, "Poland"), false);
  const sender = { email: "anna@advantage-mail.com", rampStage: 35 };
  const decision = sendDecision({ sender, recipient, ledger: sendLedger([], { now: allSaints }), now: allSaints });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "holiday");
  assert.match(decision.message, /свято/);
  assert.equal(decision.retryAt, "2027-11-02T07:00:00.000Z", "Tuesday 08:00 in Warsaw");

  // The same Monday is a working day for a German lead.
  const german = sendDecision({ sender, recipient: { email: "jan@nordwind.de", country: "Germany" }, ledger: sendLedger([], { now: allSaints }), now: allSaints });
  assert.notEqual(german.reason, "holiday");
});

test("a run of days off — Christmas, a holiday, a weekend — is still crossed", () => {
  const zones = zonesFor({ country: "Poland" });
  // Thursday 24 Dec 2026: 24, 25, 26 are holidays, then the weekend.
  assert.equal(nextWindowOpen(new Date("2026-12-24T09:00:00Z"), zones, "Poland").toISOString(), "2026-12-28T07:00:00.000Z");
});

test("follow-up delays and auto-reply postponements count working days without the holidays", () => {
  assert.equal(addWorkingDays("2026-04-02", 2), "2026-04-06");
  assert.equal(addWorkingDays("2026-04-02", 2, "Germany"), "2026-04-08", "Good Friday and Easter Monday are skipped");
  assert.equal(addWorkingDays("2026-04-02", 2, "Ukraine"), "2026-04-06");
  const enrollment = { email: "olena@northwind.pl", lead: { country: "Poland" }, nextDueDate: null };
  assert.equal(postponedDue(enrollment, { until: "2026-12-23", today: "2026-12-20" }), "2026-12-28");
});
