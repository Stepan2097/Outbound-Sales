import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { decideNext, leaseAccount, releaseLease, resetScheduler, sameDayGapMinutes } from "../warmup/scheduler.mjs";
import {
  DEFAULT_STRATEGY, dayOfRun, pausedDaysOn, pausedOn, resumeCredit, runDay, warningPause
} from "../warmup/strategy.mjs";

/**
 * The pause after a LinkedIn warning, end to end.
 *
 * The bug this file exists for shipped with a green test beside it: the one
 * test of "a pause that ended does not hold anything back" used a run the
 * warning never writes — `running`, on a `warming` account — while the real
 * warning wrote `paused` and `restricted`, which the scheduler never asked for
 * again. So these go through the routes, starting from the button, over a
 * stub that honours the filters, and a pause is only ever made by a warning.
 */

// ── the arithmetic ────────────────────────────────────────────────────────

const W = "2026-09-17";
const plus = (iso, days) => {
  const at = new Date(`${iso}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

test("a warning takes the pause's dates out of the count once, however many times it is reported", () => {
  const fresh = warningPause({ paused_days: 0, paused_until: null }, W, 2);
  assert.deepEqual(fresh, { pausedUntil: plus(W, 2), pausedDays: 2, added: 2, extended: false });

  // The agent reporting a block page on every invitation it tries is one
  // morning's warning, not five pauses.
  const again = warningPause({ paused_days: 2, paused_until: plus(W, 2) }, W, 2);
  assert.deepEqual(again, { pausedUntil: plus(W, 2), pausedDays: 2, added: 0, extended: true });

  // A new warning the next day moves the end by one date, and takes that one.
  const later = warningPause({ paused_days: 2, paused_until: plus(W, 2) }, plus(W, 1), 2);
  assert.deepEqual(later, { pausedUntil: plus(W, 3), pausedDays: 3, added: 1, extended: true });

  // A pause that has already run out is history: a warning after it is fresh.
  const afterwards = warningPause({ paused_days: 2, paused_until: plus(W, 2) }, plus(W, 5), 2);
  assert.deepEqual(afterwards, { pausedUntil: plus(W, 7), pausedDays: 4, added: 2, extended: false });
});

test("a pause holds through its last date and not a day longer, whatever the row's state says", () => {
  const run = { state: "paused", paused_until: plus(W, 2) };
  assert.equal(pausedOn(run, W), true);
  assert.equal(pausedOn(run, plus(W, 2)), true, "the last date is still paused");
  assert.equal(pausedOn(run, plus(W, 3)), false, "the day after it is not, with nobody having written anything");
  assert.equal(pausedOn({ state: "running", paused_until: null }, W), false);
  assert.equal(pausedOn(null, W), false);
});

test("resuming early gives back the paused dates not reached; resuming late gives back nothing", () => {
  const warned = { paused_days: 2, paused_until: plus(W, 2) };
  assert.equal(resumeCredit(warned, W, 2), 2, "undone the same day: as though it never happened");
  assert.equal(resumeCredit(warned, plus(W, 1), 2), 2, "the next morning: no date was actually sat out");
  assert.equal(resumeCredit(warned, plus(W, 2), 2), 1, "on the last date: one was");
  assert.equal(resumeCredit(warned, plus(W, 3), 2), 0, "after it ran out: both were, and they stay out");
  assert.equal(resumeCredit({ paused_days: 0, paused_until: null }, W, 2), 0, "nothing paused, nothing owed");
  // Never more than was taken, whatever an old row says.
  assert.equal(resumeCredit({ paused_days: 1, paused_until: plus(W, 2) }, W, 2), 1);
});

test("the day stands still through a pause and moves on by one when it ends", () => {
  // Day 8 on the day of the warning.
  const run = { started_at: `${plus(W, -7)}T08:00:00.000Z`, paused_days: 0, paused_until: null };
  const at = (iso) => new Date(`${iso}T10:00:00.000Z`);
  assert.equal(runDay(run, at(W)), 8);

  const pause = warningPause(run, W, 2);
  const warned = { ...run, paused_days: pause.pausedDays, paused_until: pause.pausedUntil };
  assert.equal(runDay(warned, at(W)), 8, "not day 6: the warning does not send the account back");
  assert.equal(runDay(warned, at(plus(W, 1))), 8);
  assert.equal(runDay(warned, at(plus(W, 2))), 8);
  // The warning day was worked; the two whole dates after it were not.
  assert.equal(runDay(warned, at(plus(W, 3))), 9);
});

test("the dates after a pause that nobody took the account on count as paused, not as progress", () => {
  // Day 8 on the warning day, as the old code left it: `paused` for good,
  // because nothing ever wrote the end of a pause back then.
  const stalled = {
    state: "paused", started_at: `${plus(W, -7)}T08:00:00.000Z`, paused_days: 2, paused_until: plus(W, 2)
  };
  const at = (iso) => new Date(`${iso}T10:00:00.000Z`);

  // The first morning after the pause: nothing stalled yet, today can still be worked.
  assert.equal(pausedDaysOn(stalled, plus(W, 3)), 2);
  assert.equal(dayOfRun(stalled, at(plus(W, 3))), 9);
  // Three weeks on it is still the day after the warning day — not day 30,
  // and not working mode with a folder's worth of strangers.
  assert.equal(pausedDaysOn(stalled, plus(W, 24)), 23);
  assert.equal(dayOfRun(stalled, at(plus(W, 24))), 9);
  assert.equal(runDay(stalled, at(plus(W, 24))), 9, "and the screen says the same");

  // Written down as running, the recorded number is the whole answer.
  assert.equal(pausedDaysOn({ ...stalled, state: "running" }, plus(W, 24)), 2);
  // While the pause holds there is no stall at all.
  assert.equal(pausedDaysOn(stalled, plus(W, 2)), 2);

  // A warning on a stalled run keeps the stall out of the count, and the day
  // stands still through the new pause at the day it was found on.
  const again = warningPause(stalled, plus(W, 24), 2);
  assert.deepEqual(again, { pausedUntil: plus(W, 26), pausedDays: 25, added: 2, extended: false });
  const rewarned = { ...stalled, paused_days: again.pausedDays, paused_until: again.pausedUntil };
  assert.equal(runDay(rewarned, at(plus(W, 24))), 9);
  assert.equal(dayOfRun(rewarned, at(plus(W, 27))), 10);
});

// ── the routes, over a PostgREST-shaped stub ──────────────────────────────

const rows = {};
let stub;
let previousEnv;
let nextId = 0;

function columnValue(row, column) {
  if (!column.includes("->>")) return row[column];
  const [outer, key] = column.split("->>");
  const holder = row[outer];
  return holder && typeof holder === "object" ? holder[key] : undefined;
}

/** The filters these routes build, and nothing else. */
function matches(row, params) {
  for (const [column, expression] of params.entries()) {
    if (["select", "limit", "offset", "order"].includes(column)) continue;
    const value = columnValue(row, column);
    if (expression === "is.null") {
      if (value !== null && value !== undefined) return false;
    } else if (expression === "not.is.null") {
      if (value === null || value === undefined) return false;
    } else if (expression.startsWith("eq.")) {
      if (String(value) !== expression.slice(3)) return false;
    } else if (expression.startsWith("neq.")) {
      if (String(value) === expression.slice(4)) return false;
    } else if (expression.startsWith("not.in.(")) {
      if (expression.slice(8, -1).split(",").includes(String(value))) return false;
    } else if (expression.startsWith("in.(")) {
      if (!expression.slice(4, -1).split(",").includes(String(value))) return false;
    } else if (expression.startsWith("lt.")) {
      if (value === null || value === undefined || !(String(value) < expression.slice(3))) return false;
    } else if (expression.startsWith("gte.")) {
      if (value === null || value === undefined || !(String(value) >= expression.slice(4))) return false;
    }
  }
  return true;
}

async function call({ method, path, body = null }) {
  let captured = null;
  await handleWarmupApi({
    request: { method, headers: {}, auth: { profile: { email: "seller@example.com" } } },
    response: {},
    url: new URL(`http://127.0.0.1${path}`),
    sendJson: (_response, status, payload) => { captured = { status, payload }; },
    readJson: async () => body,
    campaigns: { read: () => [], readTargeting: () => null, write: async () => {} }
  });
  return captured;
}

test.before(async () => {
  stub = createServer((request, response) => {
    const [route, query] = request.url.split("?");
    const table = route.replace("/rest/v1/", "");
    const params = new URLSearchParams(query || "");
    const found = (rows[table] ?? []).filter((row) => matches(row, params));

    const answer = (payload, status = 200) => {
      const headers = { "Content-Type": "application/json" };
      if (request.headers.prefer?.includes("count=exact")) {
        headers["content-range"] = `0-0/${found.length}`;
        response.writeHead(status, headers);
        response.end("[]");
        return;
      }
      response.writeHead(status, headers);
      response.end(JSON.stringify(payload));
    };

    if (request.method === "GET") return answer(found);
    if (request.method === "DELETE") {
      rows[table] = (rows[table] ?? []).filter((row) => !found.includes(row));
      return answer(found);
    }

    let payload = "";
    request.on("data", (chunk) => { payload += chunk; });
    request.on("end", () => {
      const sent = payload ? JSON.parse(payload) : null;
      if (request.method === "POST") {
        const row = { id: `row-${++nextId}`, created_at: new Date().toISOString(), ...sent };
        rows[table] = [...(rows[table] ?? []), row];
        return answer([row], 201);
      }
      // PATCH, on exactly the rows the filters found — which is what makes a
      // conditional write conditional here too.
      return answer(found.map((row) => Object.assign(row, sent)));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));

  previousEnv = { url: process.env.ANTY_SUPABASE_URL, key: process.env.ANTY_SERVICE_ROLE_KEY };
  process.env.ANTY_SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.ANTY_SERVICE_ROLE_KEY = "stub-key";
});

test.after(async () => {
  process.env.ANTY_SUPABASE_URL = previousEnv.url ?? "";
  process.env.ANTY_SERVICE_ROLE_KEY = previousEnv.key ?? "";
  await new Promise((resolve) => stub.close(resolve));
});

/**
 * Ten in the morning on the operator's clock, `offset` days after the warning.
 * Local, because the session window is; the date the server reckons in is the
 * UTC one, read back from the same instant rather than assumed.
 */
const WARNED_ON = new Date(2026, 8, 17, 10, 0, 0, 0);
function morning(offset) {
  const at = new Date(WARNED_ON);
  at.setDate(at.getDate() + offset);
  return at;
}
const isoOf = (date) => date.toISOString().slice(0, 10);

test.beforeEach(() => {
  resetScheduler();
  delete process.env.WARMUP_SCHEDULER_DISABLED;
  const warnedIso = isoOf(WARNED_ON);
  rows.wl_accounts = [{
    id: "acc-1", label: "Chloe Stewart", login: "chloe@example.com",
    profile_remote_id: "profile-1", status: "warming", health: "ok", proxy_id: null
  }];
  // Day 8 on the morning of the warning: views, likes and requests, no notes.
  rows.wl_runs = [{
    id: "run-1", account_id: "acc-1", state: "running",
    started_at: `${plus(warnedIso, -7)}T08:00:00.000Z`,
    paused_days: 0, paused_until: null, strategy_snapshot: DEFAULT_STRATEGY
  }];
  rows.wl_day_actions = [];
  rows.wl_events = [];
  rows.wl_sessions = [];
  rows.anty_browser_profiles = [{ id: "profile-1", status: "stopped", is_deleted: false }];
  // Somebody to invite and somebody to look at: a pause must hold back both.
  rows.wl_outreach = [
    {
      id: "o-wait", account_id: "acc-1", crm_contact_id: "c-1", person_name: "Marta Kovalenko",
      person_linkedin: "https://linkedin.com/in/marta", status: "waiting", note: null,
      created_at: "2026-09-10T10:00:00.000Z"
    },
    {
      id: "o-sent", account_id: "acc-1", crm_contact_id: "c-2", person_name: "Ivan Petrenko",
      person_linkedin: "https://linkedin.com/in/ivan", status: "pending", note: null,
      created_at: "2026-09-09T10:00:00.000Z"
    }
  ];
});

const events = (type) => rows.wl_events.filter((row) => row.type === type);

test("a warning stops everything for two days, and on the third the account is back by itself, one day on", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });

  const warned = await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "warning" } });
  assert.equal(warned.status, 200);
  const pausedUntil = plus(isoOf(morning(0)), 2);
  assert.equal(warned.payload.account.warmup.state, "paused");
  assert.equal(warned.payload.account.warmup.pausedUntil, pausedUntil);
  assert.equal(warned.payload.account.warmup.day, 8, "the count stands still where the warning found it");
  assert.equal(rows.wl_runs[0].state, "paused");
  assert.equal(rows.wl_runs[0].paused_days, 2);
  assert.equal(rows.wl_accounts[0].status, "restricted");
  assert.equal(events("run.warning")[0].meta.source, "operator");

  // The day of the warning and the two after it: nothing at all.
  for (const offset of [0, 1, 2]) {
    const now = morning(offset);
    t.mock.timers.setTime(now.getTime());

    const due = await decideNext({ now });
    assert.equal(due.next, null, `nothing is handed out ${offset} day(s) after the warning`);
    const lease = await leaseAccount({ accountId: "acc-1", now });
    assert.equal(lease.ok, false);

    // And an agent that turns up anyway is given nothing to do.
    const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
    assert.equal(agent.payload.runnable, false);
    assert.equal(agent.payload.pausedUntil, pausedUntil);
    assert.deepEqual(agent.payload.plan, []);
    assert.deepEqual(agent.payload.invites.toSend, [], "no invitations to send");
    assert.deepEqual(agent.payload.invites.toCheck, [], "and none to check either");
    assert.equal(agent.payload.invites.connectsLeft, 0);
    assert.deepEqual(agent.payload.queue, []);
    assert.equal(agent.payload.upkeep.any, false);
    assert.equal(agent.payload.inbox.maxThreads, 0, "no inbox read");
  }

  // The third morning. Nobody pressed anything.
  const back = morning(3);
  t.mock.timers.setTime(back.getTime());

  const writesBefore = rows.wl_events.length;
  const due = await decideNext({ now: back });
  assert.equal(due.next?.accountId, "acc-1", "the account is due again on its own");
  assert.equal(due.next.day, 9, "the warning day counted and the two paused days did not");
  assert.ok(due.next.kinds.includes("connect"), "and the person it was holding goes out");
  assert.equal(due.next.upkeep.checks, 1);
  assert.equal(rows.wl_events.length, writesBefore, "asking still takes nothing and writes nothing");
  assert.equal(rows.wl_runs[0].state, "paused", "the poll left the row as it found it");

  const lease = await leaseAccount({ accountId: "acc-1", now: back });
  assert.equal(lease.ok, true);
  assert.equal(lease.lease.day, 9);
  // Taking it is what writes the pause down as over — and only that.
  assert.equal(rows.wl_runs[0].state, "running");
  assert.equal(rows.wl_runs[0].paused_until, null);
  assert.equal(rows.wl_runs[0].paused_days, 2, "the paused days were counted once, when the warning came in");
  assert.equal(rows.wl_accounts[0].status, "warming");
  assert.equal(events("run.resumed").length, 1);
  assert.equal(events("run.resumed")[0].meta.auto, true);

  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(agent.payload.runnable, true);
  assert.equal(agent.payload.day, 9);
  assert.deepEqual(agent.payload.invites.toSend.map((row) => row.outreachId), ["o-wait"]);
  assert.deepEqual(agent.payload.invites.toCheck.map((row) => row.outreachId), ["o-sent"]);

  // Handed out again later the same day: nothing left to settle, nothing counted twice.
  releaseLease("acc-1", lease.lease.leaseId, back.getTime());
  const later = new Date(back.getTime() + (sameDayGapMinutes() + 1) * 60_000);
  t.mock.timers.setTime(later.getTime());
  const again = await leaseAccount({ accountId: "acc-1", now: later });
  assert.equal(again.ok, true);
  assert.equal(events("run.resumed").length, 1);
  assert.equal(rows.wl_runs[0].paused_days, 2);
});

test("an account whose pause ran out shows as warming, with nothing to press", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "warning" } });

  // Four days on, nobody has taken the account yet, so the row still says
  // paused. The screen must not.
  t.mock.timers.setTime(morning(4).getTime());
  const detail = await call({ method: "GET", path: "/api/warmup/accounts?id=acc-1" });
  assert.equal(detail.status, 200);
  const warmup = detail.payload.account.warmup;
  assert.equal(warmup.state, "running");
  assert.equal(warmup.pausedUntil, null, "a date that has passed is not a pause");
  // Day 8 on the warning day; the third morning nobody took it, so that date
  // was not worked either, and today is the first one that can be.
  assert.equal(warmup.day, 9);
  assert.equal(warmup.pausedDays, 3);
});

test("an account the old code left paused comes back on the day after its warning, whoever writes it down first", async (t) => {
  // What a warning wrote before the pause ended by itself, and what stayed
  // there: nothing ever resumed it, so the row reads the same five days on.
  const warnedIso = isoOf(WARNED_ON);
  Object.assign(rows.wl_runs[0], { state: "paused", paused_days: 2, paused_until: plus(warnedIso, 2) });
  rows.wl_accounts[0].status = "restricted";
  const now = morning(8);
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });

  // Read before anything is written: the poll, the screen and the agent's
  // question all count the five dates nobody worked as paused.
  const due = await decideNext({ now });
  assert.equal(due.next?.accountId, "acc-1");
  assert.equal(due.next.day, 9, "the day after its warning day, not day 14");
  assert.equal(due.next.mode, "warmup");
  const detail = await call({ method: "GET", path: "/api/warmup/accounts?id=acc-1" });
  assert.equal(detail.payload.account.warmup.day, 9);
  assert.equal(rows.wl_runs[0].state, "paused", "and none of that wrote anything");

  // Taking it writes down exactly the number every reader counted with.
  const lease = await leaseAccount({ accountId: "acc-1", now });
  assert.equal(lease.ok, true);
  assert.equal(lease.lease.day, 9);
  assert.equal(rows.wl_runs[0].state, "running");
  assert.equal(rows.wl_runs[0].paused_days, 7, "the two the warning took, and the five nobody took the account on");
  assert.equal(events("run.resumed")[0].meta.stalled, 5);
  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(agent.payload.day, 9, "the agent is told the same day once the row is written");
});

test("the account's screen sums today's counters too, however many rows hold them", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  const on = isoOf(morning(0));
  rows.wl_day_actions = [
    { id: "d-1", run_id: "run-1", account_id: "acc-1", on_date: on, kind: "profile_view", quota: 99, done: 2 },
    { id: "d-2", run_id: "run-1", account_id: "acc-1", on_date: on, kind: "profile_view", quota: 99, done: 1 }
  ];
  const detail = await call({ method: "GET", path: "/api/warmup/accounts?id=acc-1" });
  assert.equal(detail.payload.account.warmup.done.profile_view, 3, "what `checkQuota` refuses by, not the last row read");
});

test("a day worked by hand after the pause is not counted as stalled the next morning", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "warning" } });

  // The first morning after the pause, with no scheduler taking the account:
  // the operator records a view from the warm-up panel.
  t.mock.timers.setTime(morning(3).getTime());
  const recorded = await call({
    method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "record", kind: "profile_view" }
  });
  assert.equal(recorded.status, 200);
  assert.equal(recorded.payload.account.warmup.day, 9);
  assert.equal(rows.wl_runs[0].state, "running", "working the account is what ends the pause on the record");
  assert.equal(rows.wl_runs[0].paused_days, 2);

  // So the next morning is the next day, not the same one again.
  t.mock.timers.setTime(morning(4).getTime());
  const detail = await call({ method: "GET", path: "/api/warmup/accounts?id=acc-1" });
  assert.equal(detail.payload.account.warmup.day, 10);
});

test("the end of a stalled pause is written once, with one number, by whichever route gets there first", async (t) => {
  const warnedIso = isoOf(WARNED_ON);
  Object.assign(rows.wl_runs[0], { state: "paused", paused_days: 2, paused_until: plus(warnedIso, 2) });
  rows.wl_accounts[0].status = "restricted";
  const now = morning(8);
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });

  // A person presses Resume first; the lease that follows finds nothing to do.
  const resumed = await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "resume" } });
  assert.equal(resumed.payload.account.warmup.day, 9);
  assert.equal(rows.wl_runs[0].paused_days, 7);
  const lease = await leaseAccount({ accountId: "acc-1", now });
  assert.equal(lease.lease.day, 9);
  assert.equal(rows.wl_runs[0].paused_days, 7, "not counted a second time");
  assert.equal(events("run.resumed").length, 1, "only the button's");

  // And the write is conditional on the row it was computed from: a warning
  // that landed after the read is not overwritten by a stale settle.
  Object.assign(rows.wl_runs[0], { state: "paused", paused_days: 2, paused_until: plus(warnedIso, 2) });
  rows.wl_accounts[0].status = "restricted";
  const stale = { ...rows.wl_runs[0] };
  Object.assign(rows.wl_runs[0], { paused_days: 9, paused_until: plus(isoOf(now), 2) });
  const { settlePause } = await import("../warmup/store.mjs");
  assert.equal(await settlePause(rows.wl_accounts[0], stale, isoOf(now)), false);
  assert.equal(rows.wl_runs[0].paused_days, 9);
  assert.equal(rows.wl_runs[0].state, "paused");
  assert.equal(rows.wl_accounts[0].status, "restricted", "the new warning's account stays restricted");
});

/**
 * 09.10.2026: two accounts read «На паузі» and the owner asked how, since
 * nobody had paused them. LinkedIn had — its weekly invitation limit — and the
 * agent's two-day rest was only the answer to it. The list says the cause.
 */
test("a pause for LinkedIn's weekly invitation limit reads as the limit, with its last date, in the list and on the card", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  const pausedUntil = plus(isoOf(morning(0)), 2);
  rows.anty_browser_profiles[0] = { ...rows.anty_browser_profiles[0], name: "Chloe Stewart", start_page: "https://www.linkedin.com/feed/", tags: ["linkedin"] };

  await call({ method: "POST", path: "/api/warmup/agent", body: { action: "warning", accountId: "acc-1", note: "Banner: unusual activity on your account" } });
  await call({ method: "POST", path: "/api/warmup/agent", body: { action: "warning", accountId: "acc-1", note: "запрошення не було надіслано" } });
  rows.wl_events.find((row) => row.type === "run.warning").created_at = `${isoOf(morning(0))}T07:00:00.000Z`;
  rows.wl_events.filter((row) => row.type === "run.warning")[1].created_at = `${isoOf(morning(0))}T07:05:00.000Z`;

  const list = await call({ method: "GET", path: "/api/warmup/profiles" });
  const row = list.payload.profiles.find((profile) => profile.account?.id === "acc-1");
  assert.equal(row.status, "limited", "the newest warning was the limit");
  assert.deepEqual(row.pause, { until: pausedUntil, cause: "invite_limit" });

  const card = await call({ method: "GET", path: "/api/warmup/accounts?id=acc-1" });
  assert.equal(card.payload.account.warmup.pauseCause, "invite_limit");
  assert.equal(card.payload.account.warmup.pauseNote, "запрошення не було надіслано");

  // Any other warning is still a pause, said as one.
  rows.wl_events.filter((row) => row.type === "run.warning")[1].created_at = `${isoOf(morning(0))}T06:00:00.000Z`;
  const other = await call({ method: "GET", path: "/api/warmup/profiles" });
  const again = other.payload.profiles.find((profile) => profile.account?.id === "acc-1");
  assert.equal(again.status, "paused");
  assert.deepEqual(again.pause, { until: pausedUntil, cause: "warning" });
});

test("the agent can report a warning, and a second report the same morning is the same pause", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  const pausedUntil = plus(isoOf(morning(0)), 2);

  const first = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "warning", accountId: "acc-1", note: "Banner: unusual activity on your account" }
  });
  assert.equal(first.status, 200);
  assert.equal(first.payload.paused, true);
  assert.equal(first.payload.pausedUntil, pausedUntil);
  assert.equal(first.payload.stopSending, true, "the agent stops everything on this answer");
  assert.equal(rows.wl_runs[0].state, "paused");
  assert.equal(rows.wl_runs[0].paused_until, pausedUntil);
  assert.equal(rows.wl_runs[0].paused_days, 2);
  assert.equal(rows.wl_accounts[0].status, "restricted");
  assert.equal(rows.wl_accounts[0].health, "ok", "a warning is not a health problem — nobody has to log in");
  const [event] = events("run.warning");
  assert.equal(event.level, "warn");
  assert.equal(event.meta.source, "agent");
  assert.equal(event.meta.note, "Banner: unusual activity on your account");

  const second = await call({ method: "POST", path: "/api/warmup/agent", body: { action: "warning", accountId: "acc-1" } });
  assert.equal(second.payload.pausedUntil, pausedUntil);
  assert.equal(rows.wl_runs[0].paused_days, 2, "one morning's warning is one pause");
  assert.equal(events("run.warning").length, 2, "both reports are on the record");

  // And it is the same pause the button starts: nothing handed out.
  assert.equal((await decideNext({ now: morning(0) })).next, null);
});

test("an invitation LinkedIn answered with a block page starts the same pause and keeps the person held", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });

  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId: "o-wait", outcome: "blocked" }
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.moved, false);
  assert.equal(answer.payload.recorded, "blocked");
  assert.equal(answer.payload.paused, true);
  assert.equal(answer.payload.pausedUntil, plus(isoOf(morning(0)), 2));
  assert.equal(answer.payload.stopSending, true);

  assert.equal(rows.wl_outreach.find((row) => row.id === "o-wait").status, "waiting", "the person is still held");
  assert.equal(events("invite.failed").length, 1);
  assert.equal(rows.wl_runs[0].state, "paused");
  assert.equal(rows.wl_runs[0].paused_days, 2);
  assert.equal(rows.wl_accounts[0].status, "restricted");
  assert.equal(events("run.warning")[0].meta.source, "invite.blocked");
  assert.equal(rows.wl_day_actions.length, 0, "and nothing was spent");
});

test("the other held outcomes and a health report start no pause", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });

  // Every held outcome but `blocked`. A dead link is routine with folder-fed
  // people, and a pause on each one would stop an account for two days at a
  // time for nothing LinkedIn said.
  for (const outcome of ["no_button", "cannot_connect", "no_note", "profile_gone"]) {
    rows.wl_outreach.find((row) => row.id === "o-wait").status = "waiting";
    const held = await call({
      method: "POST", path: "/api/warmup/agent",
      body: { action: "invite.sent", accountId: "acc-1", outreachId: "o-wait", outcome }
    });
    assert.equal(held.status, 200, outcome);
    assert.equal(held.payload.recorded, outcome);
    assert.equal(held.payload.paused, undefined, `${outcome} is not a warning`);
    assert.equal(held.payload.stopSending, undefined, `${outcome}: the run goes on to the next person`);
    assert.equal(rows.wl_runs[0].state, "running", outcome);
    assert.equal(rows.wl_runs[0].paused_until, null, outcome);
    assert.equal(rows.wl_runs[0].paused_days, 0, outcome);
    assert.equal(rows.wl_accounts[0].status, "warming", outcome);
    assert.equal(events("run.warning").length, 0, outcome);
  }
  assert.equal(events("invite.failed").length, 4, "each one is on the record all the same");

  // A captcha needs a person, and says nothing about leaving the account alone
  // for two days. It keeps meaning exactly what it meant.
  const captcha = await call({ method: "POST", path: "/api/warmup/agent", body: { action: "health", accountId: "acc-1", health: "captcha" } });
  assert.equal(captcha.status, 200);
  assert.equal(rows.wl_accounts[0].health, "captcha");

  assert.equal(rows.wl_runs[0].state, "running");
  assert.equal(rows.wl_runs[0].paused_until, null);
  assert.equal(rows.wl_runs[0].paused_days, 0);
  assert.equal(events("run.warning").length, 0);
});

test("resume the next morning and the account carries on from the next day, not two behind", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "warning" } });

  t.mock.timers.setTime(morning(1).getTime());
  const resumed = await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "resume" } });
  assert.equal(resumed.status, 200);
  assert.equal(rows.wl_runs[0].paused_days, 0, "no date was sat out, so none stays out of the count");
  assert.equal(rows.wl_runs[0].state, "running");
  assert.equal(rows.wl_accounts[0].status, "warming");
  assert.equal(resumed.payload.account.warmup.day, 9, "day 8 yesterday, day 9 today");
  assert.equal(events("run.resumed")[0].meta.givenBack, 2);
});

test("resume after the pause ran out tidies the row and moves the count not at all", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "warning" } });

  // Nobody took the account, and somebody presses Resume two days late.
  t.mock.timers.setTime(morning(5).getTime());
  const before = await call({ method: "GET", path: "/api/warmup/accounts?id=acc-1" });
  const resumed = await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "resume" } });
  assert.equal(resumed.status, 200);
  assert.equal(rows.wl_runs[0].paused_days, 4, "the two paused dates, and the two after them nobody took the account on");
  assert.equal(resumed.payload.account.warmup.day, 9, "8 on the warning day, and today is the next one worked");
  assert.equal(resumed.payload.account.warmup.day, before.payload.account.warmup.day, "the button moves nothing");
  assert.equal(events("run.resumed")[0].meta.givenBack, 0);
});

test("a request sent after a block page paused the account is recorded as that, and not counted", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  rows.wl_outreach.push({
    id: "o-next", account_id: "acc-1", crm_contact_id: "c-3", person_name: "Olena Shevchuk",
    person_linkedin: "https://linkedin.com/in/olena", status: "waiting", note: null,
    created_at: "2026-09-11T10:00:00.000Z"
  });
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId: "o-wait", outcome: "blocked" }
  });

  // An agent built before `stopSending` meant the whole run goes on to the
  // next person, and LinkedIn takes that request.
  const next = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId: "o-next", outcome: "sent" }
  });
  assert.equal(next.status, 200);
  assert.equal(next.payload.moved, true, "it is on LinkedIn, so it is on the record");
  assert.equal(next.payload.duringPause, true);
  assert.equal(next.payload.stopSending, true);
  assert.equal(next.payload.overQuota, true, "what an agent from before `duringPause` stops on");
  assert.equal(next.payload.connectsLeft, 0);

  const [sent] = events("invite.sent");
  assert.equal(sent.level, "warn");
  assert.match(sent.message, /after a warning paused the account/);
  assert.doesNotMatch(sent.message, /beyond today's allowance/, "not an overshoot — a different thing to go and fix");
  assert.equal(sent.meta.duringPause, true);
  assert.equal(sent.meta.overQuota, false);
  assert.equal(rows.wl_day_actions.length, 0, "a paused day allows nothing, so nothing is counted toward it");

  const card = await call({ method: "GET", path: "/api/warmup/invites?crmContactId=c-3" });
  assert.equal(card.payload.invite.duringPause, true);
  assert.equal(card.payload.invite.overQuota, false);
});

test("the note a request carried is recorded by the day it was handed out on, not the day a warning moved the count to", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: morning(0).getTime() });
  // Day 12: a note of three words or fewer goes.
  rows.wl_runs[0].started_at = `${plus(isoOf(WARNED_ON), -11)}T08:00:00.000Z`;
  rows.wl_outreach[0].note = "Раді знайомству";
  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(agent.payload.day, 12);
  assert.equal(agent.payload.invites.toSend[0].note, "Раді знайомству");

  // The warning lands mid-run, and the agent reports the request it had
  // already sent with that note. The count behind the day drops by the two
  // paused dates at once; the note went out on day 12 all the same.
  await call({ method: "POST", path: "/api/warmup/control", body: { accountId: "acc-1", action: "warning" } });
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId: "o-wait", outcome: "sent" }
  });
  const [sent] = events("invite.sent");
  assert.equal(sent.meta.note, "Раді знайомству", "not «Без записки» on the CRM for a note LinkedIn received");
  assert.equal(sent.meta.noteDropped, null);
});
