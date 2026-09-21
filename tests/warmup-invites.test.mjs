import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { ACCEPTED_STATUS, WAITING_STATUS, canMove, describeInvite } from "../warmup/invites.mjs";
import { DEFAULT_STRATEGY } from "../warmup/strategy.mjs";

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
  const outreachId = await queueOne();
  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "no_button" }
  });

  assert.equal(answer.payload.moved, false);
  assert.equal(rows.wl_outreach[0].status, WAITING_STATUS, "still held — a human decides whether to cancel");
  const failed = rows.wl_events.find((event) => event.type === "invite.failed");
  assert.equal(failed.meta.outcome, "no_button");
  assert.equal(failed.level, "warn");
});

test("a spent quota refuses the send and leaves the invitation for tomorrow", async () => {
  const outreachId = await queueOne();
  rows.wl_day_actions = [{
    id: "d-1", run_id: "run-1", account_id: "acc-1", on_date: new Date().toISOString().slice(0, 10),
    kind: "connect", quota: 99, done: 99
  }];

  const answer = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "sent" }
  });
  assert.equal(answer.status, 409, "an ordinary answer, not a failure");
  assert.equal(rows.wl_outreach[0].status, WAITING_STATUS);
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
