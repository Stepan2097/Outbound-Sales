import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { ACCEPTED_STATUS, WAITING_STATUS, canMove, describeInvite } from "../warmup/invites.mjs";
import { DEFAULT_STRATEGY, nextNoteDay, noteAllowedOnDay } from "../warmup/strategy.mjs";

// ── the transition table ──────────────────────────────────────────────────
//
// This is the part of the feature that would have shipped broken. A person
// accepts an invitation and writes the same day; inside one agent run the
// inbox sync sets `connected` and the invitation check then sets `accepted`
// over it, because nothing orders the two reports. The seller is told to go
// and write to somebody who already wrote to them, and `responded_at` is gone.

test("an automatic writer may move an invitation forward and never back", () => {
  assert.ok(canMove(WAITING_STATUS, "pending"), "queued for tomorrow, sent today");
  assert.ok(canMove("pending", ACCEPTED_STATUS), "the daily check found them connected");
  assert.ok(canMove(ACCEPTED_STATUS, "connected"), "and then they wrote");
  assert.ok(canMove("pending", "connected"), "or they accepted and wrote before anybody looked");

  assert.equal(canMove("connected", ACCEPTED_STATUS), false, "the bug this table exists for");
  assert.equal(canMove(ACCEPTED_STATUS, "pending"), false);
  assert.equal(canMove("connected", "pending"), false);
  assert.equal(canMove("pending", WAITING_STATUS), false);
});

test("somebody who accepted and later removed the connection keeps their acceptance", () => {
  // `gone` from the daily check means "no longer in the sent list". From a
  // pending invitation that is a withdrawal; from an accepted one it is a
  // person who connected and then changed their mind, and the acceptance
  // already happened. History is not edited to match the present.
  assert.ok(canMove("pending", "withdrawn"));
  assert.ok(canMove(WAITING_STATUS, "withdrawn"));
  assert.equal(canMove(ACCEPTED_STATUS, "withdrawn"), false);
  assert.equal(canMove("connected", "withdrawn"), false);
});

test("a finished conversation is finished", () => {
  for (const terminal of ["connected", "declined", "withdrawn"]) {
    for (const target of [WAITING_STATUS, "pending", ACCEPTED_STATUS, "declined"]) {
      if (terminal === "connected" && target === "declined") continue;
      assert.equal(canMove(terminal, target), false, `${terminal} → ${target} must be refused`);
    }
  }
});

test("an invitation is dated by when it was sent, not by when the person was held", () => {
  const row = {
    id: "o-1", account_id: "acc-1", crm_contact_id: "c-1", person_name: "Marta",
    person_company: "Fleetify", person_linkedin: "https://linkedin.com/in/marta",
    sent_by: "chloe@example.com", status: "pending", note: null,
    created_at: "2026-09-20T10:00:00.000Z", responded_at: null
  };
  const events = [
    { type: "invite.requested", at: "2026-09-20T10:00:00.000Z", meta: { requestedBy: "seller@example.com" } },
    { type: "invite.sent", at: "2026-09-21T09:14:00.000Z", meta: { by: "agent" } }
  ];
  const invite = describeInvite(row, events);
  assert.equal(invite.heldAt, "2026-09-20T10:00:00.000Z");
  assert.equal(invite.sentAt, "2026-09-21T09:14:00.000Z", "a day later, and the timeline must say so");
  assert.equal(invite.requestedBy, "seller@example.com");
  assert.equal(invite.sentByWhom, "agent");
  assert.equal(invite.waitingDays, 0, "only a waiting row counts days");
});

// ── the routes, over a PostgREST-shaped stub ──────────────────────────────
//
// `anty` is pointed at a stub in this process rather than at Supabase: a test
// that needs a database password is a test nobody runs. The stub honours the
// handful of filters these routes actually build.

const rows = { wl_accounts: [], wl_runs: [], wl_day_actions: [], wl_outreach: [], wl_events: [] };
// What the stub should refuse, as `{ table: { METHOD: status } }`. A probe that
// can only ever answer yes is not a probe.
const refuse = {};
let stub;
let previousEnv;
let nextId = 0;

/** `meta->>crmContactId` reads the json path, the way PostgREST does. */
function columnValue(row, column) {
  if (!column.includes("->>")) return row[column];
  const [outer, key] = column.split("->>");
  const holder = row[outer];
  return holder && typeof holder === "object" ? holder[key] : undefined;
}

function matches(row, params) {
  for (const [column, expression] of params.entries()) {
    if (["select", "limit", "offset", "order"].includes(column)) continue;
    const value = columnValue(row, column);
    if (expression.startsWith("eq.")) {
      if (String(value) !== expression.slice(3)) return false;
    } else if (expression.startsWith("neq.")) {
      if (String(value) === expression.slice(4)) return false;
    } else if (expression.startsWith("not.in.(")) {
      if (expression.slice(8, -1).split(",").includes(String(value))) return false;
    } else if (expression.startsWith("in.(")) {
      if (!expression.slice(4, -1).split(",").includes(String(value))) return false;
    } else if (expression.startsWith("lt.")) {
      if (!(String(value) < expression.slice(3))) return false;
    } else if (expression === "is.null") {
      if (value !== null && value !== undefined) return false;
    } else if (expression === "not.is.null") {
      if (value === null || value === undefined) return false;
    }
  }
  return true;
}

function startedForDay(day) {
  const started = new Date();
  started.setUTCDate(started.getUTCDate() - (day - 1));
  started.setUTCHours(8, 0, 0, 0);
  return started.toISOString();
}

async function call({ method, path, body = null, auth = "seller@example.com" }) {
  let captured = null;
  await handleWarmupApi({
    request: { method, headers: {}, auth: { profile: { email: auth } } },
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

    const refused = refuse[table]?.[request.method];
    if (refused) {
      request.resume();
      response.writeHead(refused, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "permission denied for table", code: "42501" }));
      return;
    }

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
        const row = { id: `row-${++nextId}`, created_at: new Date().toISOString(), responded_at: null, ...sent };
        rows[table] = [...(rows[table] ?? []), row];
        return answer([row], 201);
      }
      // PATCH
      const updated = found.map((row) => Object.assign(row, sent));
      return answer(updated);
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));

  previousEnv = {
    url: process.env.ANTY_SUPABASE_URL, key: process.env.ANTY_SERVICE_ROLE_KEY,
    crmUrl: process.env.WARMUP_CRM_SUPABASE_URL, crmKey: process.env.WARMUP_CRM_SERVICE_ROLE_KEY
  };
  process.env.ANTY_SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.ANTY_SERVICE_ROLE_KEY = "stub-key";
  // The CRM is the same stub: `leadById` reads one contacts row, and the
  // fixture below is that row.
  process.env.WARMUP_CRM_SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.WARMUP_CRM_SERVICE_ROLE_KEY = "stub-key";
});

test.after(async () => {
  process.env.ANTY_SUPABASE_URL = previousEnv.url ?? "";
  process.env.ANTY_SERVICE_ROLE_KEY = previousEnv.key ?? "";
  process.env.WARMUP_CRM_SUPABASE_URL = previousEnv.crmUrl ?? "";
  process.env.WARMUP_CRM_SERVICE_ROLE_KEY = previousEnv.crmKey ?? "";
  await new Promise((resolve) => stub.close(resolve));
});

test.beforeEach(() => {
  rows.wl_accounts = [{
    id: "acc-1", label: "Chloe Stewart", login: "chloe@example.com",
    profile_remote_id: "profile-1", status: "warming", health: "ok"
  }];
  rows.wl_runs = [{
    id: "run-1", account_id: "acc-1", state: "running", started_at: startedForDay(5),
    paused_days: 0, paused_until: null, strategy_snapshot: DEFAULT_STRATEGY
  }];
  rows.wl_day_actions = [];
  rows.wl_outreach = [];
  rows.wl_events = [];
  for (const table of Object.keys(refuse)) delete refuse[table];
  rows.contacts = [{
    id: "c-1", name: "Marta Kovalenko", company: "Fleetify", position: "Head of UA",
    linkedin: "https://linkedin.com/in/marta", country: "Poland"
  }];
});

test("an invitation asked for from the workspace holds the person and spends no quota", async () => {
  const answer = await call({
    method: "POST", path: "/api/warmup/invites",
    body: { accountId: "acc-1", crmContactId: "c-1", note: "Пишу без приводу — одне питання." }
  });

  assert.equal(answer.status, 200);
  assert.equal(answer.payload.invite.status, WAITING_STATUS);
  assert.equal(answer.payload.invite.requestedBy, "seller@example.com");
  assert.equal(answer.payload.invite.note, "Пишу без приводу — одне питання.");
  assert.equal(rows.wl_day_actions.length, 0, "the count moves when something is sent, not when it is asked for");
  assert.equal(rows.wl_outreach[0].status, WAITING_STATUS);
  assert.ok(rows.wl_events.some((event) => event.type === "invite.requested"));
});

test("a waiting invitation is invisible to the claim sweep that deletes claims", async () => {
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-1" } });
  // The sweep runs on any Claim or Release click and deletes every `queued`
  // row older than the TTL. A waiting row is not `queued`, which is the entire
  // reason for a separate status rather than a longer TTL.
  rows.wl_outreach[0].created_at = "2020-01-01T00:00:00.000Z";
  await call({ method: "POST", path: "/api/warmup/campaigns/release", body: { accountId: "acc-1" } });
  assert.equal(rows.wl_outreach.length, 1, "still held");
  assert.equal(rows.wl_outreach[0].status, WAITING_STATUS);
});

test("a person somebody else already has comes back as an answer, not an error", async () => {
  rows.wl_outreach = [{
    id: "o-9", account_id: "acc-2", crm_contact_id: "c-1", person_name: "Marta Kovalenko",
    sent_by: "dan@example.com", status: "pending", created_at: "2026-09-01T10:00:00.000Z", responded_at: null
  }];
  // The stub has no unique index, so the route's own pre-check is what answers
  // here; against the real database the same answer comes back from a 23505.
  const answer = await call({
    method: "POST", path: "/api/warmup/invites/sent-by-hand",
    body: { accountId: "acc-1", crmContactId: "c-1" }
  });
  assert.equal(answer.status, 409);
  assert.match(answer.payload.error, /вже в аутрічі/);
  assert.equal(rows.wl_outreach.length, 1, "nothing was written beside the row that already exists");
});

test("a request the seller already sent by hand is recorded even past the day's allowance", async () => {
  // The allowance for day 5 of the default strategy, spent to the last one.
  rows.wl_day_actions = [{
    id: "d-1", run_id: "run-1", account_id: "acc-1", on_date: new Date().toISOString().slice(0, 10),
    kind: "connect", quota: 99, done: 99
  }];

  const answer = await call({
    method: "POST", path: "/api/warmup/invites/sent-by-hand",
    body: { accountId: "acc-1", crmContactId: "c-1" }
  });

  // Refusing would not un-send the request that is already on LinkedIn; it
  // would only make our own record false and hand the person to the next
  // campaign that asks. The quota governs what we cause, not what we observe.
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.overQuota, true);
  assert.equal(rows.wl_outreach[0].status, "pending");
  const sent = rows.wl_events.find((event) => event.type === "invite.sent");
  assert.ok(sent, "the send is written down");
  assert.equal(sent.meta.overQuota, true);
  assert.equal(sent.level, "warn", "and it is visible as an exception, not buried");
  assert.equal(rows.wl_day_actions[0].done, 99, "the counter is not pushed past its own quota");
});

test("a seller who queued somebody and then sent the request by hand keeps one row", async () => {
  // The path that goes through the transition table rather than an insert. It
  // had no test, and the import it depends on was missing — the module still
  // loaded, because a free identifier is only a ReferenceError when it runs.
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-1" } });
  assert.equal(rows.wl_outreach[0].status, WAITING_STATUS);

  const answer = await call({
    method: "POST", path: "/api/warmup/invites/sent-by-hand",
    body: { accountId: "acc-1", crmContactId: "c-1" }
  });
  assert.equal(answer.status, 200);
  assert.equal(rows.wl_outreach.length, 1, "the waiting row became the sent row rather than a second one");
  assert.equal(rows.wl_outreach[0].status, "pending");
  assert.equal(answer.payload.invite.status, "pending");
});

test("only an unsent invitation can be cancelled or moved to another account", async () => {
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-1" } });
  const outreachId = rows.wl_outreach[0].id;

  rows.wl_accounts.push({
    id: "acc-2", label: "Dan Moreau", login: "dan@example.com",
    profile_remote_id: "profile-2", status: "warming", health: "ok"
  });
  const moved = await call({
    method: "POST", path: "/api/warmup/invites/reassign",
    body: { outreachId, accountId: "acc-2" }
  });
  assert.equal(moved.status, 200);
  assert.equal(rows.wl_outreach[0].account_id, "acc-2", "a waiting row can change account — the index is on the person");
  assert.equal(rows.wl_outreach[0].sent_by, "dan@example.com");

  rows.wl_outreach[0].status = "pending";
  const lateCancel = await call({ method: "POST", path: "/api/warmup/invites/cancel", body: { outreachId } });
  assert.equal(lateCancel.status, 409, "a request already on LinkedIn cannot be unsent from here");
  assert.equal(rows.wl_outreach.length, 1, "and the person stays held");

  rows.wl_outreach[0].status = WAITING_STATUS;
  const cancelled = await call({ method: "POST", path: "/api/warmup/invites/cancel", body: { outreachId } });
  assert.equal(cancelled.status, 200);
  assert.equal(rows.wl_outreach.length, 0, "the person goes back to the pool");
  assert.ok(rows.wl_events.some((event) => event.type === "invite.cancelled"));
});

// ── what the agent reports ────────────────────────────────────────────────

/** Queue one invitation and hand back its id. */
async function queueOne() {
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-1" } });
  return rows.wl_outreach[0].id;
}

test("the allowance moves when the agent says a request really went out", async () => {
  const outreachId = await queueOne();
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "sent" }
  });

  assert.equal(answer.status, 200);
  assert.equal(answer.payload.moved, true);
  assert.equal(rows.wl_outreach[0].status, "pending");
  assert.equal(rows.wl_day_actions.length, 1, "counted at the send, which is the thing that happened");
  assert.equal(rows.wl_day_actions[0].kind, "connect");
  const sent = rows.wl_events.find((event) => event.type === "invite.sent");
  assert.equal(sent.meta.by, "agent");
});

test("a request the agent finds already pending costs no allowance", async () => {
  const outreachId = await queueOne();
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "already_pending" }
  });

  // The reconciliation for a run that clicked and died before it could report.
  // Charging for it would bill the account twice for one request.
  assert.equal(answer.payload.moved, true);
  assert.equal(rows.wl_outreach[0].status, "pending");
  assert.equal(rows.wl_day_actions.length, 0, "nothing new happened on LinkedIn, so nothing is counted");
});

test("a request the browser could not send leaves the person held, with the reason", async () => {
  for (const outcome of ["no_button", "no_note", "profile_gone", "blocked"]) {
    rows.wl_outreach = [];
    rows.wl_events = [];
    const outreachId = await queueOne();
    const answer = await call({
      method: "POST", path: "/api/warmup/agent",
      body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome }
    });

    assert.equal(answer.payload.moved, false, outcome);
    assert.equal(rows.wl_outreach[0].status, WAITING_STATUS, `${outcome}: still held — a human decides what to do`);
    const failed = rows.wl_events.find((event) => event.type === "invite.failed");
    assert.equal(failed.meta.outcome, outcome);
    assert.equal(failed.level, "warn");
    assert.equal(rows.wl_day_actions.length, 0, `${outcome}: nothing went out, so nothing is counted`);
  }
});

test("a note LinkedIn will not carry stops the request rather than sending it bare", async () => {
  // The only approach this person will ever get, from anybody here — so a
  // blank request does not cost a retry, it costs the person.
  const outreachId = await queueOne();
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "no_note" }
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.recorded, "no_note");
  assert.equal(rows.wl_outreach[0].status, WAITING_STATUS);
});

test("a request past the day's allowance is still recorded, and the agent is told to stop", async () => {
  const outreachId = await queueOne();
  rows.wl_day_actions = [{
    id: "d-1", run_id: "run-1", account_id: "acc-1", on_date: new Date().toISOString().slice(0, 10),
    kind: "connect", quota: 99, done: 99
  }];

  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "sent" }
  });

  // The agent reports only after LinkedIn's card reads Pending, so the request
  // already exists. A 409 here would not un-send it — it would throw away the
  // record and hand the person to the next campaign that asks.
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.overQuota, true);
  assert.equal(answer.payload.stopSending, true, "and this is how the run stops, not an error it has to read");
  assert.equal(rows.wl_outreach[0].status, "pending", "the person stays approached, because they were");
  assert.equal(rows.wl_day_actions[0].done, 99, "but the counter is not pushed past its own quota");
  const sent = rows.wl_events.find((event) => event.type === "invite.sent");
  assert.equal(sent.meta.overQuota, true);
  assert.equal(sent.level, "warn");
});

test("an outcome the portal does not know is refused rather than guessed at", async () => {
  const outreachId = await queueOne();
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "rate_limited" }
  });

  // Unvalidated, an unknown string fell through to "treat as already pending":
  // the row moved as though the request had gone out and the allowance was
  // never spent — one more request than the day allowed, and nothing said so.
  assert.equal(answer.status, 400);
  assert.match(answer.payload.error, /Unknown outcome/);
  assert.equal(rows.wl_outreach[0].status, WAITING_STATUS, "and nothing moved");
  assert.equal(rows.wl_day_actions.length, 0);
});

test("a check may only move the reporting account's own rows", async () => {
  const outreachId = await queueOne();
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "sent" }
  });
  rows.wl_accounts.push({
    id: "acc-2", label: "Dan Moreau", login: "dan@example.com",
    profile_remote_id: "profile-2", status: "warming", health: "ok"
  });
  rows.wl_runs.push({ ...rows.wl_runs[0], id: "run-2", account_id: "acc-2" });

  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invites.checked", accountId: "acc-2", results: [{ outreachId, state: "gone" }] }
  });

  // `withdrawn` has no exit, and the row would have dropped out of every query
  // that could ever surface that person again — while the event was filed
  // under the wrong account's log.
  assert.equal(answer.payload.withdrawn, 0);
  assert.deepEqual(answer.payload.foreign, [outreachId], "and the mis-scoped report is visible, not swallowed");
  assert.equal(rows.wl_outreach[0].status, "pending", "acc-1's row is untouched");
});

test("the daily check cannot turn somebody who already replied back into somebody to write to", async () => {
  // The headline bug, end to end: the inbox sync got there first inside the
  // same run, and the invitation check arrives afterwards with a stale view.
  const outreachId = await queueOne();
  rows.wl_outreach[0].status = "connected";
  rows.wl_outreach[0].responded_at = "2026-09-21T11:00:00.000Z";

  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invites.checked", accountId: "acc-1", results: [{ outreachId, state: "accepted" }] }
  });

  assert.equal(answer.payload.accepted, 0);
  assert.equal(rows.wl_outreach[0].status, "connected");
  assert.equal(rows.wl_outreach[0].responded_at, "2026-09-21T11:00:00.000Z", "and the reply time survives");
  const checked = rows.wl_events.find((event) => event.type === "invite.checked");
  assert.equal(checked.meta.refused.length, 1, "a refused move is worth seeing, not swallowing");
});

test("a check that changed nothing is still written down", async () => {
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invites.checked", accountId: "acc-1", results: [] }
  });
  const checked = rows.wl_events.find((event) => event.type === "invite.checked");
  // Without this row, "nobody is accepting" and "the agent stopped looking"
  // are the same empty screen.
  assert.ok(checked, "the check is recorded even with nothing to report");
  assert.equal(checked.meta.checked, 0);
});

test("an account is woken for invitations only when somebody is actually waiting", async () => {
  const { dueFrom } = await import("../warmup/scheduler.mjs");
  const now = new Date("2026-09-21T10:00:00.000Z");
  const started = new Date(now);
  started.setUTCDate(started.getUTCDate() - 12);
  const base = {
    accounts: [{ id: "acc-1", label: "Chloe", profile_remote_id: "p-1", status: "warming", health: "ok" }],
    runs: [{
      id: "run-1", account_id: "acc-1", state: "running", started_at: started.toISOString(),
      paused_days: 0, paused_until: null, strategy_snapshot: DEFAULT_STRATEGY
    }],
    // Day 13: views and likes are done, so the only thing that could owe work
    // is an invitation.
    dayActions: [
      { account_id: "acc-1", kind: "profile_view", done: 99 },
      { account_id: "acc-1", kind: "like", done: 99 }
    ],
    todayIso: "2026-09-21",
    nowMs: now.getTime()
  };

  const idle = dueFrom(base);
  assert.equal(idle.ready.length, 0, "allowance alone is not work — the browser would open to send nothing");

  const busy = dueFrom({ ...base, invitesWaiting: new Map([["acc-1", 2]]) });
  assert.equal(busy.ready.length, 1, "two people queued is a reason to open a browser");
  assert.ok(busy.ready[0].kinds.includes("connect"));
  assert.equal(busy.ready[0].invites, 2);
});

test("an account that finished warming is still told to come and check what it sent", async () => {
  // The run is past the last day of the plan.
  rows.wl_runs[0].started_at = startedForDay(30);
  rows.wl_outreach = [{
    id: "o-1", account_id: "acc-1", crm_contact_id: "c-1", person_name: "Marta Kovalenko",
    person_linkedin: "https://linkedin.com/in/marta", sent_by: "chloe@example.com",
    status: "pending", created_at: "2026-09-10T10:00:00.000Z", responded_at: null
  }];

  const answer = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.runnable, true, "a flat false here is what left sent invitations unwatched for good");
  assert.match(answer.payload.reason, /upkeep only/);
  assert.deepEqual(answer.payload.plan, [], "and there is genuinely no warming left to do");
  assert.equal(answer.payload.upkeep.checks, 1);
  assert.equal(answer.payload.invites.toCheck.length, 1, "with the person to check already in hand");

  // Once a day: after the check is written, there is nothing left to check.
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invites.checked", accountId: "acc-1", results: [{ outreachId: "o-1", state: "pending" }] }
  });
  const second = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(second.payload.upkeep.checks, 0);
  // Still worth opening, though — past the last day of the plan nothing else
  // will ever wake this account to read what people wrote back.
  assert.equal(second.payload.runnable, true);
  assert.equal(second.payload.upkeep.inbox, true);

  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "inbox.done", accountId: "acc-1", threadsSeen: 0 }
  });
  const third = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(third.payload.runnable, false, "checked and read — nothing owing until tomorrow");
  assert.equal(third.payload.reason, "Warm-up is finished");
});

test("the scheduler and the semaphore answer with one upkeep, not two", async () => {
  // The scheduler decides who to wake; the semaphore tells the agent what to do
  // when it gets there. Two copies of this arithmetic that drifted would wake
  // an account by one rule and hand it an empty list by the other — a browser
  // opened for nothing, which is the failure upkeep exists to prevent.
  const { dueFrom, resetScheduler } = await import("../warmup/scheduler.mjs");
  const { checkedTodayAccounts, openConversationCounts, pendingCounts } = await import("../warmup/invites.mjs");
  const { syncedTodayAccounts } = await import("../warmup/inbox.mjs");
  resetScheduler();

  rows.wl_runs[0].started_at = startedForDay(30);
  rows.wl_outreach = [{
    id: "o-1", account_id: "acc-1", crm_contact_id: "c-1", person_name: "Marta Kovalenko",
    person_linkedin: "https://linkedin.com/in/marta", sent_by: "chloe@example.com",
    status: "pending", created_at: "2026-09-10T10:00:00.000Z", responded_at: null
  }];

  const fromSemaphore = (await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" })).payload.upkeep;

  const todayIso = new Date().toISOString().slice(0, 10);
  const ids = ["acc-1"];
  const { ready } = dueFrom({
    accounts: rows.wl_accounts,
    runs: rows.wl_runs,
    dayActions: rows.wl_day_actions,
    pendingInvites: await pendingCounts(ids),
    openConversations: await openConversationCounts(ids),
    checkedToday: await checkedTodayAccounts(ids, todayIso),
    inboxSyncedToday: await syncedTodayAccounts(ids, todayIso),
    todayIso,
    nowMs: Date.now()
  });

  assert.equal(ready.length, 1, "the scheduler wakes it");
  assert.deepEqual(ready[0].upkeep, fromSemaphore, "and hands over exactly what the semaphore will describe");
  assert.equal(fromSemaphore.checks, 1);
});

test("one person's history is the invitation and the messages, newest first", async () => {
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-1", note: "коротке питання" } });
  const outreachId = rows.wl_outreach[0].id;
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "sent" }
  });

  // The messages are counted from the moment this test queued the invitation,
  // not written as dates. The invite events are stamped by the real clock, so
  // a calendar fixture only sorts above them while it is still in the future —
  // this test passed for as long as it did because the dates had not arrived
  // yet, and broke at a midnight that changed nothing. Offsets make the order
  // a property of the data.
  const queuedAt = Date.parse(rows.wl_events.find((event) => event.type === "invite.requested").created_at);
  const after = (minutes) => new Date(queuedAt + minutes * 60_000).toISOString();

  // Two messages: one carrying the person key written at store time, one from
  // before this phase that has to be matched the old way, on the slug.
  rows.wl_events.push({
    id: "m-1", account_id: "acc-1", type: "message.out", created_at: after(1),
    meta: { threadKey: "t-1", crmContactId: "c-1", direction: "out", body: "Дякую, що прийняли", sentAt: after(1) }
  });
  rows.wl_events.push({
    id: "m-2", account_id: "acc-1", type: "message.in", created_at: after(2),
    meta: { threadKey: "t-1", direction: "in", body: "Привіт, розкажіть більше", sentAt: after(2),
      participant: { name: "Marta Kovalenko", slug: "marta" } }
  });

  const answer = await call({ method: "GET", path: "/api/warmup/history?crmContactId=c-1" });
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.contact.name, "Marta Kovalenko");

  const kinds = answer.payload.entries.map((entry) => `${entry.kind}:${entry.event || entry.direction}`);
  // Newest first: the reply, our message, the send, the queueing.
  assert.deepEqual(kinds, ["message:in", "message:out", "invite:invite.sent", "invite:invite.requested"]);

  const older = answer.payload.entries.find((entry) => entry.direction === "in");
  assert.equal(older.matchedBy, "name_or_slug", "and the screen can say this one was matched by name");
  const ours = answer.payload.entries.find((entry) => entry.direction === "out" && entry.kind === "message");
  assert.equal(ours.matchedBy, "contact_id");

  // The daily check is an account's business, not a person's story.
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invites.checked", accountId: "acc-1", results: [] }
  });
  const again = await call({ method: "GET", path: "/api/warmup/history?crmContactId=c-1" });
  assert.equal(again.payload.entries.filter((entry) => entry.event === "invite.checked").length, 0);
});

test("a person nobody has written to says so rather than showing an empty list", async () => {
  const answer = await call({ method: "GET", path: "/api/warmup/history?crmContactId=c-1" });
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.empty, true);
  assert.deepEqual(answer.payload.entries, []);
  assert.equal(answer.payload.invite, null);
});

test("two actions counted at once both reach the day's counter", async () => {
  const { checkQuota, commitAction } = await import("../warmup/store.mjs");
  const account = rows.wl_accounts[0];
  const run = rows.wl_runs[0];

  // The interleaving that loses a count: both read the same `done`, both then
  // write an absolute number on top of it. Unguarded, the second write lands
  // on the first and one real connection request disappears from the day.
  const first = await checkQuota(account, run, "connect");
  const second = await checkQuota(account, run, "connect");
  assert.ok(first.ok && second.ok);

  await commitAction(account, run, "connect", first);
  await commitAction(account, run, "connect", second);

  // One row, holding both. The second commit found the row the first had just
  // made and added to it rather than writing a second row beside it.
  assert.equal(rows.wl_day_actions.length, 1);
  assert.equal(rows.wl_day_actions[0].done, 2, "both were counted");
});

test("the write-access probe answers for each of the three writes, and cleans up", async () => {
  // Which way the history dedupe has to be built hangs on this answer, and it
  // can only be asked where the keys are — the deployed server.
  const answer = await call({ method: "POST", path: "/api/warmup/diagnostics/event-write", body: {} });
  assert.equal(answer.status, 200);
  assert.equal(answer.payload.probe.verdict, "full");
  assert.equal(answer.payload.probe.canUpdate, true);
  assert.equal(answer.payload.probe.probeId, null, "nothing left behind");
  assert.equal(rows.wl_events.length, 0, "and the row really is gone");
});

test("a key that cannot update says so instead of quietly passing", async () => {
  refuse.wl_events = { PATCH: 403 };
  const answer = await call({ method: "POST", path: "/api/warmup/diagnostics/event-write", body: {} });

  assert.equal(answer.payload.probe.verdict, "no_update");
  assert.equal(answer.payload.probe.canUpdate, false);
  assert.equal(answer.payload.probe.insert.ok, true);
  assert.match(answer.payload.probe.update.error, /permission denied|42501|403/);
  assert.equal(answer.payload.probe.remove.ok, true, "a failed update still cleans up after itself");
  assert.equal(rows.wl_events.length, 0);
});

test("a probe row that could not be removed is reported by id", async () => {
  refuse.wl_events = { DELETE: 403 };
  const answer = await call({ method: "POST", path: "/api/warmup/diagnostics/event-write", body: {} });

  assert.equal(answer.payload.probe.verdict, "no_delete");
  assert.equal(answer.payload.probe.canUpdate, true);
  assert.ok(answer.payload.probe.probeId, "an operator has to be able to go and find it");
  assert.equal(rows.wl_events.length, 1);
});

test("a person waiting for an invitation is not counted as somebody we approached", async () => {
  const { progressFrom } = await import("../warmup/campaigns.mjs");
  const todayIso = new Date().toISOString().slice(0, 10);
  const progress = progressFrom([
    { status: "waiting", created_at: `${todayIso}T09:00:00.000Z` },
    { status: "queued", created_at: `${todayIso}T09:00:00.000Z` },
    { status: "pending", created_at: `${todayIso}T09:00:00.000Z` },
    { status: "connected", created_at: `${todayIso}T09:00:00.000Z` }
  ], { todayIso, sentToday: 0 });

  // The split is binary — anything not `queued` counted as sent — so a status
  // it has not been taught inflates every campaign's progress by everything
  // the lead workspace is holding.
  assert.equal(progress.sent, 2, "only the request and the reply were really approaches");
  assert.equal(progress.queued, 2, "the waiting invitation sits with the claims");
  assert.equal(progress.replied, 1);
});

test("the account picker offers only accounts that could carry a request, and says why not", async () => {
  rows.wl_accounts.push({
    id: "acc-3", label: "Sam Blocked", login: "sam@example.com",
    profile_remote_id: "profile-3", status: "warming", health: "captcha"
  });
  const answer = await call({ method: "GET", path: "/api/warmup/invites/accounts" });
  assert.equal(answer.status, 200);

  const chloe = answer.payload.accounts.find((account) => account.id === "acc-1");
  const sam = answer.payload.accounts.find((account) => account.id === "acc-3");
  assert.equal(chloe.canSend, true);
  assert.ok(chloe.connectQuota >= 0);
  assert.equal(sam.canSend, false);
  assert.match(sam.reason, /captcha|Account health/i, "a blocked account is listed with its reason, not hidden");
});

// ── the day's rule about notes, and the seller's approved sentence ─────────
//
// Two rules that were written apart and meet here. The warm-up says early days
// send requests with nothing attached; outreach says a note a human approved
// must never silently vanish. An invitation queued on day 2 and sent on day 5
// used to satisfy the first by breaking the second — the request went out bare
// and the screen called it sent.

test("an invitation carrying a note is not handed over on a day that forbids notes", async () => {
  // Day 5 of the shipped strategy: requests are allowed, notes are not.
  await call({
    method: "POST", path: "/api/warmup/invites",
    body: { accountId: "acc-1", crmContactId: "c-1", note: "одне коротке питання" }
  });

  const answer = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.payload.invites.toSend, [], "sending it today would drop the sentence a human approved");
  assert.equal(answer.payload.invites.notesAllowedToday, false);
  assert.equal(answer.payload.invites.nextNoteDay, 11, "and the answer says when it can go");
  assert.equal(rows.wl_outreach[0].status, WAITING_STATUS, "the person is held, not spent");
});

test("an invitation with no note goes out on that same day, because bare is what the day means", async () => {
  await call({
    method: "POST", path: "/api/warmup/invites",
    body: { accountId: "acc-1", crmContactId: "c-1" }
  });

  const answer = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  const [invitation] = answer.payload.invites.toSend;
  assert.ok(invitation, "nothing is lost here — there is no text to lose");
  assert.equal(invitation.note, "");
  assert.equal(invitation.noteExpected, false, "so `no_note` would be the wrong report on this one");
});

test("on a day that allows a note the person and the note travel together", async () => {
  rows.wl_runs[0].started_at = startedForDay(12);
  await call({
    method: "POST", path: "/api/warmup/invites",
    body: { accountId: "acc-1", crmContactId: "c-1", note: "одне коротке питання" }
  });

  const answer = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  const [invitation] = answer.payload.invites.toSend;
  assert.ok(invitation);
  assert.equal(invitation.note, "одне коротке питання");
  assert.equal(invitation.noteExpected, true, "and here a missing note really is `no_note`");
  assert.equal(answer.payload.invites.notesAllowedToday, true);
  assert.equal(answer.payload.invites.nextNoteDay, 12, "today is the day");
});

test("the screen where the note is written learns the same rule", async () => {
  const answer = await call({ method: "GET", path: "/api/warmup/invites/accounts" });
  const [account] = answer.payload.accounts;
  assert.equal(account.notesAllowedToday, false);
  assert.equal(account.nextNoteDay, 11);
  assert.equal(account.day, 5, "a seller can see which day they are on");
});

test("a strategy that never allows a note says so instead of promising a day", () => {
  const silent = { phases: [{ fromDay: 1, toDay: 14, quotas: { connect: [1, 2] }, connectionNote: false }] };
  assert.equal(noteAllowedOnDay(silent, 7), false);
  assert.equal(nextNoteDay(silent, 1), null, "null is an answer: somebody decided this, it is not a wait that ends");
  assert.equal(nextNoteDay(DEFAULT_STRATEGY, 1), 11);
  assert.equal(nextNoteDay(DEFAULT_STRATEGY, 12), 12, "asking from a day that allows one answers that day");
  assert.equal(nextNoteDay(DEFAULT_STRATEGY, 15), null, "past the end of the plan there is no next day");
});
