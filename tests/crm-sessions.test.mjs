import assert from "node:assert/strict";
import test from "node:test";

import { HEARTBEAT_GRACE_MS, mergedIntervals, sessionBeat, sessionStats } from "../triage/crm-sessions.mjs";

// Час роботи один на CRM і Outbound (власник 23.10): Outbound продовжує відкриту
// сесію людини в CRM, перекриття не додаються.

const USER = "c1834a09-d2a5-4e3f-a221-4b377e5e69f1";

function fakeCrm(rows) {
  const from = () => {
    const filters = [];
    let method = "GET";
    let payload = null;
    const self = {
      select: () => self,
      eq: (column, value) => { filters.push((row) => row[column] === value); return self; },
      isNull: (column) => { filters.push((row) => row[column] == null); return self; },
      order: () => self, limit: () => self,
      update: (patch) => { method = "PATCH"; payload = patch; return self; },
      insert: (row) => { method = "POST"; payload = row; return self; },
      async maybeSingle() { return rows.filter((row) => filters.every((f) => f(row))).sort((a, b) => b.session_start.localeCompare(a.session_start))[0] || null; },
      async rows() {
        if (method === "PATCH") { for (const row of rows.filter((r) => filters.every((f) => f(r)))) Object.assign(row, payload); return []; }
        if (method === "POST") { const row = { id: `s${rows.length + 1}`, session_end: null, ...payload }; rows.push(row); return [row]; }
        return rows;
      }
    };
    return self;
  };
  return { from };
}

test("серцебиття Outbound продовжує свіжу сесію (і ту, що відкрила CRM), застарілу закриває й відкриває нову", async () => {
  const now = Date.parse("2026-10-23T10:00:00Z");
  const rows = [{ id: "crm", user_id: USER, session_start: "2026-10-23T09:00:00Z", updated_at: "2026-10-23T09:59:30Z", session_end: null }];
  const crm = fakeCrm(rows);
  assert.deepEqual(await sessionBeat({ crm, userId: USER, now }), { ok: true, sessionId: "crm", reused: true });
  assert.equal(rows[0].updated_at, "2026-10-23T10:00:00.000Z");
  const later = now + 30 * 60_000;
  const answer = await sessionBeat({ crm, userId: USER, now: later });
  assert.equal(answer.reused, false);
  assert.equal(rows[0].session_end, new Date(now + HEARTBEAT_GRACE_MS).toISOString(), "закрито на останньому серцебитті + 2 хв");
  assert.equal(rows.length, 2);
  assert.deepEqual(await sessionBeat({ crm, userId: "not-a-user" }), { ok: false });
});

test("відрізки CRM і Outbound, що перекриваються, — один час; обрізані межами й останнім серцебиттям", () => {
  const sessions = [
    { user_id: "a", session_start: "2026-10-20T08:00:00Z", session_end: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z" },
    { user_id: "a", session_start: "2026-10-20T09:00:00Z", session_end: "2026-10-20T11:00:00Z", updated_at: "2026-10-20T11:00:00Z" },
    { user_id: "a", session_start: "2026-10-20T12:00:00Z", session_end: null, updated_at: "2026-10-20T12:28:00Z" }
  ];
  const merged = mergedIntervals(sessions, { start: "2026-10-19T22:00:00Z", end: "2026-10-26T22:59:59Z", now: Date.parse("2026-10-21T00:00:00Z") });
  const [row] = sessionStats(merged);
  assert.equal(row.minutes, 180 + 30, "08–11 одним відрізком, 12:00–12:30 (серцебиття + 2 хв)");
  assert.equal(row.sessions, 2);
  assert.equal(row.weekdays[1].minutes, 210, "20.10 — вівторок");
});

test("робочий час за діями: дії ближче години — одна робота; поодинока — 3 хв; вкладки й дії, що перекриваються, — раз", async () => {
  const { actionIntervals, unionIntervals, ACTION_GAP_MS } = await import("../triage/crm-sessions.mjs");
  const t = (hhmm) => Date.parse(`2026-10-27T${hhmm}:00Z`);
  const work = actionIntervals([t("09:00"), t("09:40"), t("10:20"), t("12:00")]);
  assert.deepEqual(work.map((row) => [(row.to - row.from) / 60_000]), [[83], [3]], "пачки кожні 40 хв — одна робота 09:00–10:20 (+2 хв до, +1 після); 12:00 окремо");
  assert.equal(actionIntervals([t("09:00"), t("09:00") + ACTION_GAP_MS + 60_000]).length, 2, "понад годину — дві роботи");
  const all = unionIntervals([[{ from: t("10:00"), to: t("10:50") }], work], { start: "2026-10-27T00:00:00Z", end: "2026-10-28T00:00:00Z" });
  assert.deepEqual(all.map((row) => [new Date(row.from).toISOString().slice(11, 16), new Date(row.to).toISOString().slice(11, 16)]), [["08:58", "10:50"], ["11:58", "12:01"]]);
});

test("сесія, закрита на межі дня й зачеплена після, — не тягнеться до півночі: її останнє серцебиття невідоме", () => {
  const sessions = [{ user_id: "a", session_start: "2026-10-14T16:22:00Z", session_end: "2026-10-18T22:00:00Z", updated_at: "2026-10-19T10:18:00Z" }];
  const [row] = sessionStats(mergedIntervals(sessions, { start: "2026-10-12T22:00:00Z", end: "2026-10-19T21:59:59Z", now: Date.parse("2026-10-20T00:00:00Z") }));
  assert.equal(row.minutes, 2, "лише перші 2 хв замість 4 діб");
});
