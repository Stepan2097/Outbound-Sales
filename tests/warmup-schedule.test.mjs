import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_KINDS, DEFAULT_STRATEGY, currentDay, dailyQuota, fromDays, planForDay, toDays, totalDays,
  validateStrategy, withDay
} from "../warmup/strategy.mjs";
import { SESSION_WINDOW, insideWindow, nextSession, sessionTimeOn } from "../warmup/schedule.mjs";
import { deriveStatus } from "../warmup/status.mjs";
import { parseProxy, platformOf, retag } from "../warmup/platform.mjs";

const strategy = DEFAULT_STRATEGY;

test("a phase without a quota for an action forbids it rather than allowing any", () => {
  // Day 1-3 is views only. A missing entry is the difference between "none
  // today" and "as many as you like".
  assert.equal(dailyQuota(strategy, "account-a", 1, "connect"), 0);
  assert.equal(dailyQuota(strategy, "account-a", 1, "like"), 0);
  assert.ok(dailyQuota(strategy, "account-a", 1, "profile_view") >= 3);
});

test("today's figure is stable per account per day and differs between accounts", () => {
  const first = dailyQuota(strategy, "account-a", 5, "profile_view");
  assert.equal(first, dailyQuota(strategy, "account-a", 5, "profile_view"));
  assert.notEqual(first, dailyQuota(strategy, "account-a", 6, "profile_view"));

  const spread = new Set(
    Array.from({ length: 40 }, (_, index) => dailyQuota(strategy, `account-${index}`, 5, "profile_view"))
  );
  assert.ok(spread.size > 1, "every account drawing the same figure would itself be a pattern");
});

test("every drawn figure stays inside its phase range", () => {
  for (const phase of strategy.phases) {
    for (const [kind, [low, high]] of Object.entries(phase.quotas)) {
      for (let day = phase.fromDay; day <= phase.toDay; day += 1) {
        for (let index = 0; index < 25; index += 1) {
          const drawn = dailyQuota(strategy, `account-${index}`, day, kind);
          assert.ok(drawn >= low && drawn <= high, `${kind} day ${day} drew ${drawn}, outside ${low}-${high}`);
        }
      }
    }
  }
});

test("paused days are dead time, not progress", () => {
  const started = new Date("2026-09-01T00:00:00Z");
  const now = new Date("2026-09-11T00:00:00Z");
  assert.equal(currentDay(started, 0, now), 11);
  // Two days paused means the account comes back on day 9, not day 11 — that is
  // what stops a flagged account returning into a heavier phase.
  assert.equal(currentDay(started, 2, now), 9);
  assert.equal(currentDay(started, 99, now), 1, "progress never runs backwards past day 1");
});

test("a day past the last phase is finished", () => {
  assert.equal(totalDays(strategy), 14);
  assert.equal(planForDay(strategy, "account-a", 15).finished, true);
  assert.equal(planForDay(strategy, "account-a", 14).finished, false);
});

test("a strategy with a gap between phases is refused", () => {
  const valid = { name: "Two phases", pauseDays: 2, phases: [
    { fromDay: 1, toDay: 3, label: "a", quotas: { profile_view: [1, 2] }, connectionNote: false, rules: [] },
    { fromDay: 4, toDay: 6, label: "b", quotas: { like: [1, 1] }, connectionNote: false, rules: [] }
  ] };
  assert.equal(validateStrategy(valid), null);

  const gapped = structuredClone(valid);
  gapped.phases[1].fromDay = 5;
  assert.match(validateStrategy(gapped), /має починатися з дня 4/);

  const unnamed = structuredClone(valid);
  unnamed.name = "  ";
  assert.match(validateStrategy(unnamed), /потрібна назва/);

  const backwards = structuredClone(valid);
  backwards.phases[0].toDay = 0;
  assert.match(validateStrategy(backwards), /іде навпаки/);
});

test("the planned session time lands inside the window, on a five-minute step", () => {
  for (let index = 0; index < 50; index += 1) {
    const planned = sessionTimeOn(`account-${index}`, new Date("2026-09-16T00:00:00"));
    assert.ok(planned.getHours() >= SESSION_WINDOW.startHour && planned.getHours() < SESSION_WINDOW.endHour);
    assert.equal(planned.getMinutes() % 5, 0);
  }
  assert.equal(insideWindow(new Date("2026-09-16T10:00:00")), true);
  assert.equal(insideWindow(new Date("2026-09-16T04:00:00")), false);
  assert.equal(insideWindow(new Date("2026-09-16T13:00:00")), false, "endHour is the first hour a session may not start");
});

test("an unfinished quota keeps the session due today, not tomorrow", () => {
  const account = "account-a";
  const slot = sessionTimeOn(account, new Date("2026-09-16T00:00:00"));
  const afterSlot = new Date(slot.getTime() + 60 * 60 * 1000);

  const overdue = nextSession(account, { outstanding: true, now: afterSlot });
  assert.equal(overdue.today, true);
  assert.equal(overdue.overdue, true, "answering 'tomorrow' sends an operator home with the day's work still there");

  const done = nextSession(account, { outstanding: false, now: afterSlot });
  assert.equal(done.today, false);
  assert.equal(done.overdue, false);

  const beforeSlot = new Date(slot.getTime() - 60 * 60 * 1000);
  const ahead = nextSession(account, { outstanding: true, now: beforeSlot });
  assert.equal(ahead.overdue, false);
  assert.equal(ahead.inMinutes, 60);
});

test("a finished day points at tomorrow even before today's slot has passed", () => {
  const account = "account-b";
  const slot = sessionTimeOn(account, new Date("2026-09-16T00:00:00"));
  const justBefore = new Date(slot.getTime() - 30 * 60 * 1000);
  const answer = nextSession(account, { outstanding: false, now: justBefore });
  assert.equal(answer.today, false, "a session today that would do nothing is not the next session");
});

test("status folds health and the run in a fixed order of urgency", () => {
  const todayIso = "2026-09-16";
  const run = {
    state: "running",
    paused_until: null,
    started_at: "2026-09-15T00:00:00Z",
    paused_days: 0,
    strategy_snapshot: { phases: strategy.phases }
  };
  const healthy = { status: "warming", health: "ok", profile_remote_id: "profile-1" };

  assert.equal(deriveStatus(healthy, run, todayIso), "warming");
  assert.equal(deriveStatus({ ...healthy, health: "blocked" }, run, todayIso), "blocked");
  assert.equal(deriveStatus({ ...healthy, health: "captcha" }, run, todayIso), "needs_attention");
  assert.equal(deriveStatus({ ...healthy, status: "excluded", health: "blocked" }, run, todayIso), "excluded");
  // A blocked account that is also paused reads as blocked: the pause is a
  // consequence, and the word the operator needs is the cause.
  assert.equal(deriveStatus({ ...healthy, health: "blocked" }, { ...run, paused_until: "2026-09-20" }, todayIso), "blocked");
  assert.equal(deriveStatus(healthy, { ...run, paused_until: "2026-09-20" }, todayIso), "paused");
  assert.equal(deriveStatus({ ...healthy, profile_remote_id: null }, run, todayIso), "needs_attention");
  assert.equal(deriveStatus(healthy, null, todayIso), "off");
  assert.equal(deriveStatus(null, null, todayIso), "off");
  // Past the last day is finished whether or not anything marked it completed.
  assert.equal(deriveStatus(healthy, { ...run, started_at: "2026-01-01T00:00:00Z" }, todayIso), "finished");
});

test("a profile's platform is read the way Anty reads it", () => {
  assert.equal(platformOf({ start_page: "https://www.linkedin.com/feed/" }), "linkedin");
  assert.equal(platformOf({ tags: ["li", "ban"] }), "linkedin");
  assert.equal(platformOf({ tags: [{ name: "Facebook" }] }), "facebook");
  assert.equal(platformOf({ start_page: "https://example.com" }), "other");
});

test("re-tagging keeps working notes and refuses to contradict the start page", () => {
  const profile = { start_page: "", tags: ["fb", "ban", "bm"] };
  assert.deepEqual(retag(profile, "linkedin").tags, ["ban", "bm", "linkedin"]);
  assert.deepEqual(retag(profile, "other").tags, ["ban", "bm"]);

  const decided = { start_page: "https://www.linkedin.com/feed/", tags: [] };
  assert.equal(retag(decided, "facebook").conflict, "linkedin");
});

test("a proxy line round-trips, including a password holding an @", () => {
  const parsed = parseProxy("socks5://user:p@ss:word@host.example.com:1080");
  assert.deepEqual(parsed, { type: "socks5", host: "host.example.com", port: 1080, username: "user", password: "p@ss:word" });

  assert.deepEqual(parseProxy("1.2.3.4:8080"), { type: "http", host: "1.2.3.4", port: 8080 });
  assert.match(parseProxy("host.example.com").error, /Немає порту/);
  assert.match(parseProxy("host.example.com:70000").error, /від 1 до 65535/);
  assert.match(parseProxy("ftp://host:21").error, /Невідомий тип проксі/);
});

test("every action kind carries a label, so a refusal can name itself", async () => {
  const { ACTION_LABEL } = await import("../warmup/strategy.mjs");
  for (const kind of ACTION_KINDS) assert.ok(ACTION_LABEL[kind], `${kind} has no label`);
});

// ── a schedule read and written by days ───────────────────────────────────

test("every day of the strategy is one row, in order", () => {
  const days = toDays(DEFAULT_STRATEGY);
  assert.equal(days.length, totalDays(DEFAULT_STRATEGY));
  assert.deepEqual(days.map((row) => row.day), Array.from({ length: 14 }, (unused, index) => index + 1));
});

test("a day carries the phase it falls in", () => {
  const [day5] = toDays(DEFAULT_STRATEGY).filter((row) => row.day === 5);
  assert.equal(day5.label, "First contact");
  assert.deepEqual(day5.quotas.connect, [1, 2]);
});

test("days fold back into exactly the phases they came from", () => {
  assert.deepEqual(fromDays(toDays(DEFAULT_STRATEGY)), DEFAULT_STRATEGY.phases);
});

test("editing one day splits its phase around it", () => {
  const phases = withDay(DEFAULT_STRATEGY, 5, { quotas: { profile_view: [5, 7], like: [1, 2], connect: [0, 0] } });
  const around = phases.filter((phase) => phase.fromDay <= 6 && phase.toDay >= 4);
  assert.deepEqual(around.map((phase) => [phase.fromDay, phase.toDay]), [[4, 4], [5, 5], [6, 6]]);
  assert.equal(validateStrategy({ name: "x", phases }), null, "a split schedule is still contiguous from day 1");
});

test("a day set back to what its neighbours say merges again", () => {
  const edited = { ...DEFAULT_STRATEGY, phases: withDay(DEFAULT_STRATEGY, 5, { quotas: { connect: [0, 0] } }) };
  const restored = withDay(edited, 5, { quotas: { profile_view: [5, 7], like: [1, 2], connect: [1, 2] } });
  assert.deepEqual(restored, DEFAULT_STRATEGY.phases, "an undone edit leaves no seam behind");
});

test("editing a day never touches the others", () => {
  const phases = withDay(DEFAULT_STRATEGY, 12, { quotas: { connect: [9, 9] } });
  const days = toDays({ phases });
  assert.deepEqual(days.find((row) => row.day === 12).quotas, { connect: [9, 9] });
  assert.deepEqual(days.find((row) => row.day === 11).quotas, { profile_view: [10, 12], like: [2, 3], connect: [5, 6] });
  assert.equal(days.length, 14, "a day is changed, not added or lost");
});

test("a day edited to allow a note keeps that day alone", () => {
  const phases = withDay(DEFAULT_STRATEGY, 8, { connectionNote: { maxWords: 3, allowLinks: false } });
  const day8 = phases.find((phase) => phase.fromDay === 8);
  assert.deepEqual(day8.connectionNote, { maxWords: 3, allowLinks: false });
  assert.equal(toDays({ phases }).find((row) => row.day === 7).connectionNote, false);
});

test("an empty strategy has no days and no phases", () => {
  assert.deepEqual(toDays({ phases: [] }), []);
  assert.deepEqual(fromDays([]), []);
});
