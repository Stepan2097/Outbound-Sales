import assert from "node:assert/strict";
import test from "node:test";

import { readLinkedinLabel, withLinkedinTimes } from "../warmup/linkedin-time.mjs";

/**
 * Коли повідомлення прийшло в LinkedIn (власник 16.10: «хіба це повідомлення
 * прийшло 4 год назад, став там дату коли це повідомлення приходить в
 * лінкедин»). Агент шле підпис LinkedIn як є — день у першого повідомлення дня,
 * годинник у наступних; тут він знову стає днем і часом.
 */

const READ = Date.parse("2026-10-16T10:55:55Z"); // п'ятниця, 13:55 у Києві

test("підписи дня: дата з місяцем (укр, англ, ісп), з роком і без, тиждень, сьогодні, вчора", () => {
  const day = (label) => readLinkedinLabel(label, READ)?.day ?? null;
  assert.equal(day("Sep 1"), "2026-09-01", "привітання від LinkedIn Team — 1 вересня, а не «4 год тому»");
  assert.equal(day("28 вер."), "2026-09-28");
  assert.equal(day("7 жовт."), "2026-10-07");
  assert.equal(day("1 трав."), "2026-05-01");
  assert.equal(day("1 de sept."), "2026-09-01");
  assert.equal(day("Sep 1, 2025"), "2025-09-01");
  assert.equal(day("20 груд."), "2025-12-20", "без року — найближча минула, не майбутня");
  assert.equal(day("Сьогодні"), "2026-10-16");
  assert.equal(day("вчора"), "2026-10-15");
  assert.equal(day("вівторок"), "2026-10-13");
  assert.equal(day("пʼятниця"), "2026-10-09", "день тижня — ніколи не сьогодні");
  assert.equal(day("3d"), "2026-10-13");
  assert.equal(readLinkedinLabel("nonsense", READ), null);
  assert.equal(readLinkedinLabel("", READ), null);
});

test("годинник і відносний час", () => {
  assert.deepEqual(readLinkedinLabel("14:31", READ), { clock: [14, 31] });
  assert.deepEqual(readLinkedinLabel("10:32 PM", READ), { clock: [22, 32] });
  assert.deepEqual(readLinkedinLabel("4:05 p. m.", READ), { clock: [16, 5] });
  assert.deepEqual(readLinkedinLabel("2h", READ), { at: READ - 2 * 3_600_000 });
  assert.equal(readLinkedinLabel("25:10", READ), null);
});

test("у розмові годинник належить дню, названому перед ним; повідомлення без підпису — дню попереднього", () => {
  const stored = "2026-10-16T11:35:00Z";
  const times = withLinkedinTimes([
    { sentAtRaw: "7 жовт.", storedAt: stored },
    { sentAtRaw: "8 жовт.", storedAt: stored },
    { sentAtRaw: "14:31", storedAt: stored },
    { sentAtRaw: "Сьогодні", storedAt: "2026-10-16T12:34:00Z" },
    { sentAtRaw: null, storedAt: "2026-10-16T12:34:00Z" },
    { sentAtRaw: "15:37", storedAt: "2026-10-16T13:04:00Z" }
  ]).map((message) => [message.linkedinDay, message.linkedinAt]);
  assert.deepEqual(times, [
    ["2026-10-07", null],
    ["2026-10-08", null],
    ["2026-10-08", "2026-10-08T11:31:00.000Z"],
    ["2026-10-16", null],
    ["2026-10-16", null],
    ["2026-10-16", "2026-10-16T12:37:00.000Z"]
  ]);
});

test("справжній час LinkedIn лишається; годинник без дня, пізніший за прочитання, — учорашній", () => {
  const [given] = withLinkedinTimes([{ sentAtGiven: true, sentAt: "2026-09-12T08:00:00.000Z", storedAt: "2026-10-16T10:00:00Z" }]);
  assert.equal(given.linkedinAt, "2026-09-12T08:00:00.000Z");
  assert.equal(given.linkedinDay, "2026-09-12");
  const [late] = withLinkedinTimes([{ sentAtRaw: "23:10", storedAt: "2026-10-16T06:00:00Z" }]);
  assert.equal(late.linkedinDay, "2026-10-15");
  const [none] = withLinkedinTimes([{ sentAtRaw: null, storedAt: "2026-10-16T06:00:00Z" }]);
  assert.equal(none.linkedinDay, null, "нічого не сказано — показ лишається від прочитання");
});
