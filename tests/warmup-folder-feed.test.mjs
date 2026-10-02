import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import {
  DEFAULT_FROM_DAY, feedingFor, folderRoom, folderWork, normalizeCampaign, parseFromDay
} from "../warmup/campaigns.mjs";
import { resetFeedHints } from "../warmup/feed.mjs";
import { MAX_INVITES_PER_RUN } from "../warmup/invites.mjs";
import { anty } from "../warmup/db.mjs";
import { dueFrom, resetScheduler, sameDayGapMinutes } from "../warmup/scheduler.mjs";
import { DEFAULT_STRATEGY, dailyQuota } from "../warmup/strategy.mjs";

/**
 * A running campaign feeds its accounts from its folder, by itself.
 *
 * The bug this file exists for: a campaign looked alive on screen — a
 * forecast, a rank, "#1 у черзі" — and sent nobody, because the only thing
 * that ever turned a folder into a request the agent would send was a seller
 * queueing people one at a time. These go through the routes the agent and
 * the worker actually call, over a stub that honours the filters, the order
 * and the paging the walk depends on.
 */

// ── the arithmetic ────────────────────────────────────────────────────────

test("a campaign feeds from day 7 unless it says otherwise, and a typo is refused, not defaulted", () => {
  assert.equal(DEFAULT_FROM_DAY, 7, "days 4–6 are the account's own team, picked by hand");
  assert.equal(normalizeCampaign({ folderId: "f" }).fromDay, 7, "a campaign saved before the setting feeds from day 7");
  assert.equal(normalizeCampaign({ folderId: "f", fromDay: 4 }).fromDay, 4);
  assert.equal(normalizeCampaign({ folderId: "f", fromDay: 0 }).fromDay, 7);

  assert.deepEqual(parseFromDay(9), { value: 9 });
  assert.deepEqual(parseFromDay("4"), { value: 4 }, "a number input sends a string");
  for (const wrong of [0, -1, 7.5, "сьомого", "", null, 400]) {
    assert.ok(parseFromDay(wrong).error, `${JSON.stringify(wrong)} is refused`);
  }
});

test("only running campaigns the account is ticked on, and only from their day", () => {
  const campaigns = [
    normalizeCampaign({ id: "team", folderId: "f-team", accountIds: ["a"], state: "running", fromDay: 4, order: 0 }),
    normalizeCampaign({ id: "leads", folderId: "f-leads", accountIds: ["a"], state: "running", order: 1 }),
    normalizeCampaign({ id: "draft", folderId: "f-leads", accountIds: ["a"], state: "draft", fromDay: 1, order: 2 }),
    normalizeCampaign({ id: "other", folderId: "f-leads", accountIds: ["b"], state: "running", fromDay: 1, order: 3 })
  ];
  assert.deepEqual(feedingFor(campaigns, "a", 3).map((campaign) => campaign.id), []);
  assert.deepEqual(feedingFor(campaigns, "a", 5).map((campaign) => campaign.id), ["team"]);
  assert.deepEqual(feedingFor(campaigns, "a", 7).map((campaign) => campaign.id), ["team", "leads"], "in the seller's order");
  assert.deepEqual(feedingFor(campaigns, "a", 40).map((campaign) => campaign.id), ["team", "leads"], "working mode too");
});

test("the folder fills what is left after what is held, and the scheduler counts the same sum", () => {
  assert.equal(folderRoom({ left: 4 }), 4);
  assert.equal(folderRoom({ left: 4, waiting: 1 }), 3, "a person picked by hand comes first");
  assert.equal(folderRoom({ left: 4, waiting: 1, claimed: 2 }), 1, "and so does a claim somebody means to send");
  assert.equal(folderRoom({ left: 4, waiting: 6 }), 0, "never below nothing");

  const feeds = [{ fromDay: 7, available: 20 }, { fromDay: 4, available: 1 }];
  assert.equal(folderWork({ feeds, day: 5, left: 2 }), 1, "only the campaign whose day has come");
  assert.equal(folderWork({ feeds, day: 8, left: 4, waiting: 1 }), 3);
  assert.equal(folderWork({ feeds: [{ fromDay: 7, available: 2 }], day: 8, left: 4 }), 2, "no more than the folder has");
  assert.equal(folderWork({ feeds: [], day: 8, left: 4 }), 0);

  // The poll's view of the same account: one picked by hand, and the folder
  // for the rest of the day's four.
  const run = { id: "r", account_id: "a", started_at: "2026-09-10T08:00:00.000Z", paused_days: 0, strategy_snapshot: DEFAULT_STRATEGY };
  const nowMs = Date.parse("2026-09-17T10:00:00.000Z");
  const day = 8;
  const quota = dailyQuota(DEFAULT_STRATEGY, "a", day, "connect");
  const { ready } = dueFrom({
    accounts: [{ id: "a", label: "A", profile_remote_id: "p" }],
    runs: [run],
    dayActions: [{ account_id: "a", kind: "profile_view", done: 99 }, { account_id: "a", kind: "like", done: 99 }],
    invitesWaiting: new Map([["a", 1]]),
    invitesClaimed: new Map(),
    folderFeeds: new Map([["a", [{ fromDay: 7, available: 20 }]]]),
    todayIso: "2026-09-17",
    nowMs
  });
  assert.equal(ready[0].day, day);
  assert.deepEqual(ready[0].kinds, ["connect"]);
  assert.equal(ready[0].invites, quota, "the one waiting plus what the folder adds, to the allowance and no further");
});

test("a second order is a tie-break in the same parameter, not a second parameter PostgREST ignores", () => {
  const params = anty.from("contacts").order("created_at", { ascending: false }).order("id", { ascending: false }).params;
  assert.deepEqual(params.getAll("order"), ["created_at.desc,id.desc"]);
});

// ── the routes, over a PostgREST-shaped stub ──────────────────────────────

const rows = {};
const requests = [];
/** Tables the stub answers late, and by how many milliseconds — a CRM that hangs. */
const slow = new Map();
/** `(table, row) => boolean`: the next insert it matches fails, once — a write that did not land. */
let refuseInsert = null;
/** `(table) => boolean`: the next delete it matches fails, once. */
let refuseDelete = null;
/** `(table) => boolean`: the next read it matches fails, once — a read that did not land. */
let refuseRead = null;
/** `(table) => boolean`: the next update it matches fails, once. */
let refuseUpdate = null;
let campaigns = [];
let stub;
let previousEnv;
let nextId = 0;

function columnValue(row, column) {
  if (!column.includes("->>")) return row[column];
  const [outer, key] = column.split("->>");
  const holder = row[outer];
  return holder && typeof holder === "object" ? holder[key] : undefined;
}

/**
 * `ilike` the way it reaches Postgres: PostgREST turns `*` into `%`, and then
 * LIKE reads `%` as any run, `_` as any one character and `\` as the escape
 * — the walk's slug patterns arrive escaped (`slugLikeForms`).
 */
function ilike(value, pattern) {
  if (value === null || value === undefined) return false;
  const like = pattern.replaceAll("*", "%");
  const literal = (char) => char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let source = "";
  for (let at = 0; at < like.length; at += 1) {
    const char = like[at];
    if (char === "\\" && at + 1 < like.length) source += literal(like[++at]);
    else if (char === "%") source += ".*";
    else if (char === "_") source += ".";
    else source += literal(char);
  }
  return new RegExp(`^${source}$`, "is").test(String(value));
}

/** One `column.op.value` term inside `or=(…)`: only `ilike`, the one the walk builds. */
function orTerm(row, term) {
  const first = term.indexOf(".");
  const second = term.indexOf(".", first + 1);
  const column = term.slice(0, first);
  const op = term.slice(first + 1, second);
  const value = term.slice(second + 1);
  if (op !== "ilike") throw new Error(`the stub does not know or=(…${op}…)`);
  return ilike(columnValue(row, column), value);
}

function matches(row, params) {
  for (const [column, expression] of params.entries()) {
    if (["select", "limit", "offset", "order"].includes(column)) continue;
    if (column === "or") {
      if (!expression.slice(1, -1).split(",").some((term) => orTerm(row, term))) return false;
      continue;
    }
    const value = columnValue(row, column);
    if (expression === "is.null") {
      if (value !== null && value !== undefined) return false;
    } else if (expression === "not.is.null") {
      if (value === null || value === undefined) return false;
    } else if (expression.startsWith("eq.")) {
      if (String(value) !== expression.slice(3)) return false;
    } else if (expression.startsWith("neq.")) {
      if (String(value) === expression.slice(4)) return false;
    } else if (expression.startsWith("ilike.")) {
      if (!ilike(value, expression.slice(6))) return false;
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

/**
 * Supabase's `max-rows`: whatever `limit` asks for, one answer carries a
 * thousand rows at most and says nothing about the rest. A reader that does
 * not page is cut off here the way it is in production.
 */
const MAX_ROWS = 1000;

/** `order=a.desc,b.asc`, then `offset` and `limit` — the walk pages on these. */
function ordered(found, params) {
  const terms = (params.get("order") || "").split(",").filter(Boolean).map((term) => {
    const [column, direction] = term.split(".");
    return { column, sign: direction === "desc" ? -1 : 1 };
  });
  const sorted = found.slice().sort((left, right) => {
    for (const { column, sign } of terms) {
      const a = String(left[column] ?? "");
      const b = String(right[column] ?? "");
      if (a !== b) return a < b ? -sign : sign;
    }
    return 0;
  });
  const offset = Number(params.get("offset")) || 0;
  const limit = Math.min(MAX_ROWS, params.has("limit") ? Number(params.get("limit")) : Infinity);
  return sorted.slice(offset, offset + limit);
}

async function call({ method, path, body = null }) {
  let captured = null;
  await handleWarmupApi({
    request: { method, headers: {}, auth: { profile: { email: "seller@example.com" } } },
    response: {},
    url: new URL(`http://127.0.0.1${path}`),
    sendJson: (_response, status, payload) => { captured = { status, payload }; },
    readJson: async () => body,
    campaigns: {
      read: () => campaigns,
      readTargeting: () => null,
      write: async (value) => { campaigns = value; },
      products: () => []
    }
  });
  return captured;
}

test.before(async () => {
  stub = createServer((request, response) => {
    const [route, query] = request.url.split("?");
    const table = route.replace("/rest/v1/", "");
    const params = new URLSearchParams(query || "");
    requests.push({ method: request.method, table });
    const found = (rows[table] ?? []).filter((row) => matches(row, params));

    const answer = (payload, status = 200) => {
      const send = () => {
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
      if (slow.has(table)) setTimeout(send, slow.get(table));
      else send();
    };

    if (request.method === "GET" && refuseRead?.(table)) {
      refuseRead = null;
      return answer({ message: "the read did not land" }, 503);
    }
    if (request.method === "GET") return answer(ordered(found, params));
    if (request.method === "DELETE" && refuseDelete?.(table)) {
      refuseDelete = null;
      return answer({ message: "the delete did not land" }, 503);
    }
    if (request.method === "DELETE") {
      rows[table] = (rows[table] ?? []).filter((row) => !found.includes(row));
      return answer(found);
    }

    let payload = "";
    request.on("data", (chunk) => { payload += chunk; });
    request.on("end", () => {
      const sent = payload ? JSON.parse(payload) : null;
      if (request.method === "POST" && refuseInsert?.(table, sent)) {
        refuseInsert = null;
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: "the insert did not land" }));
        return;
      }
      if (request.method === "POST") {
        const row = { id: `row-${++nextId}`, created_at: new Date().toISOString(), responded_at: null, ...sent };
        rows[table] = [...(rows[table] ?? []), row];
        return answer([row], 201);
      }
      if (request.method === "PATCH" && refuseUpdate?.(table)) {
        refuseUpdate = null;
        return answer({ message: "the update did not land" }, 503);
      }
      return answer(found.map((row) => Object.assign(row, sent)));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));

  previousEnv = {
    url: process.env.ANTY_SUPABASE_URL, key: process.env.ANTY_SERVICE_ROLE_KEY,
    crmUrl: process.env.WARMUP_CRM_SUPABASE_URL, crmKey: process.env.WARMUP_CRM_SERVICE_ROLE_KEY
  };
  const address = `http://127.0.0.1:${stub.address().port}`;
  process.env.ANTY_SUPABASE_URL = address;
  process.env.ANTY_SERVICE_ROLE_KEY = "stub-key";
  // The CRM is the same stub: the folder is the `contacts` fixture below.
  process.env.WARMUP_CRM_SUPABASE_URL = address;
  process.env.WARMUP_CRM_SERVICE_ROLE_KEY = "stub-key";
});

test.after(async () => {
  process.env.ANTY_SUPABASE_URL = previousEnv.url ?? "";
  process.env.ANTY_SERVICE_ROLE_KEY = previousEnv.key ?? "";
  process.env.WARMUP_CRM_SUPABASE_URL = previousEnv.crmUrl ?? "";
  process.env.WARMUP_CRM_SERVICE_ROLE_KEY = previousEnv.crmKey ?? "";
  await new Promise((resolve) => stub.close(resolve));
});

/** Ten in the morning on the operator's clock — inside the session window. */
const MORNING = new Date(2026, 8, 24, 10, 0, 0, 0);
const TODAY = MORNING.toISOString().slice(0, 10);

function startedForDay(day) {
  const at = new Date(`${TODAY}T08:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() - (day - 1));
  return at.toISOString();
}

function onDay(day) {
  rows.wl_runs = [{
    id: "run-1", account_id: "acc-1", state: "running", started_at: startedForDay(day),
    paused_days: 0, paused_until: null, strategy_snapshot: DEFAULT_STRATEGY
  }];
  return dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "connect");
}

/** Contact `index` in the folder; a higher index was added later, so comes first. */
function contact(index, overrides = {}) {
  const id = `c-${String(index).padStart(4, "0")}`;
  return {
    id, folder_id: "folder-1", name: `Person ${index}`, company: `Company ${index}`, position: "Head of UA",
    linkedin: `https://www.linkedin.com/in/person-${index}`, country: "Poland", email: null, phone: null,
    description: null, lead_status: "new", owner_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    ...overrides
  };
}

/** The newest `count` ids, newest first — the order the folder is fed in. */
function newest(count, from = rows.contacts) {
  return from.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, count).map((row) => row.id);
}

function spentToday(kinds) {
  rows.wl_day_actions = Object.entries(kinds).map(([kind, done], index) => ({
    id: `d-${index}`, run_id: "run-1", account_id: "acc-1", on_date: TODAY, kind, quota: 99, done,
    created_at: `${TODAY}T07:00:00.000Z`
  }));
}

/**
 * Today's inbox read, done: it is owed once a day on every day of a plan, so
 * an account with nothing else to do is still due until it is written.
 */
function inboxReadToday() {
  rows.wl_events.push({
    id: `synced-${++nextId}`, account_id: "acc-1", level: "info", type: "inbox.synced",
    message: "Inbox synced — 0 conversations seen", meta: { threadsSeen: 0 }, created_at: MORNING.toISOString()
  });
}

const waitingRows = () => rows.wl_outreach.filter((row) => row.status === "waiting");
const events = (type) => rows.wl_events.filter((row) => row.type === type);
const writes = () => requests.filter((entry) => entry.method !== "GET");

/**
 * What the agent does when it is handed an account: take it, then ask for
 * its work. The asking is what writes the folder's people down; taking it
 * only counts them.
 */
async function takeAndAsk(accountId = "acc-1") {
  const taken = await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId } });
  if (taken.status === 200) await call({ method: "GET", path: `/api/warmup/agent?accountId=${accountId}` });
  return taken;
}

test.beforeEach((t) => {
  t.mock.timers.enable({ apis: ["Date"], now: MORNING.getTime() });
  resetScheduler();
  resetFeedHints();
  refuseInsert = null;
  refuseDelete = null;
  refuseRead = null;
  refuseUpdate = null;
  delete process.env.WARMUP_SCHEDULER_DISABLED;
  requests.length = 0;
  rows.wl_accounts = [{
    id: "acc-1", label: "Chloe Stewart", login: "chloe@example.com",
    profile_remote_id: "profile-1", status: "warming", health: "ok"
  }];
  onDay(8);
  rows.wl_day_actions = [];
  rows.wl_outreach = [];
  rows.wl_events = [];
  rows.wl_sessions = [];
  rows.anty_browser_profiles = [{ id: "profile-1", status: "stopped", is_deleted: false }];
  rows.contact_folders = [{ id: "folder-1", name: "ліди з linkedin2" }];
  rows.contacts = Array.from({ length: 30 }, (_, index) => contact(index));
  campaigns = [normalizeCampaign({
    id: "camp-1", name: "LinkedIn2", folderId: "folder-1", folderName: "ліди з linkedin2",
    filters: {}, accountIds: ["acc-1"], state: "running", order: 0
  })];
});

test("on day 8 taking the account fills today's allowance from the folder, newest first, and no more", async () => {
  const quota = onDay(8);
  assert.ok(quota >= 3, "days 7–10 allow three or four");

  const taken = await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId: "acc-1" } });
  assert.equal(taken.status, 200);
  // Taking it answers at once and writes nothing for the folder: the agent's
  // question straight after is what fills the day, and doing it twice only
  // held back the one reply whose loss strands a lease.
  assert.equal(rows.wl_outreach.length, 0, "the lease only counted the folder");
  assert.equal(events("invite.requested").length, 0);
  assert.equal(taken.payload.lease.invites, quota, "though it says how many the folder will add");
  await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });

  assert.deepEqual(waitingRows().map((row) => row.crm_contact_id), newest(quota));
  assert.ok(waitingRows().every((row) => row.account_id === "acc-1" && row.note === null), "nobody wrote a note");

  // The same path as a seller's invitation, so the person's history has it.
  const requested = events("invite.requested");
  assert.equal(requested.length, quota);
  for (const event of requested) {
    assert.equal(event.meta.source, "campaign");
    assert.equal(event.meta.campaignId, "camp-1");
    assert.equal(event.meta.note, null);
  }
  assert.equal(events("campaign.fed").length, 1);
  assert.equal(events("campaign.fed")[0].meta.added, quota);

  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(agent.payload.runnable, true);
  assert.deepEqual(agent.payload.invites.toSend.map((row) => row.crmContactId), newest(quota));
  // "" and not null: the agent in the field was only ever handed strings.
  assert.ok(agent.payload.invites.toSend.every((row) => row.note === "" && row.linkedin));
});

test("asking again, and again, adds nobody: the room is counted from what is held", async () => {
  const quota = onDay(8);
  await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId: "acc-1" } });
  for (let index = 0; index < 3; index += 1) {
    await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  }
  assert.equal(waitingRows().length, quota);
  assert.equal(events("invite.requested").length, quota);
  assert.equal(events("campaign.fed").length, 1);

  // And the agent asking first, with no lease, fills it exactly once too.
  rows.wl_outreach = [];
  rows.wl_events = [];
  await Promise.all([
    call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" }),
    call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" })
  ]);
  assert.equal(waitingRows().length, quota, "two questions at once still fill it once");
});

test("on day 5 the folder feeds nobody — those days are the team's, picked by hand", async () => {
  const quota = onDay(5);
  assert.ok(quota >= 1, "day 5 does allow a request or two");

  await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId: "acc-1" } });
  await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(waitingRows().length, 0);

  // Views and likes done, and the inbox read: with nobody picked by hand there
  // is nothing to wake it for.
  resetScheduler();
  spentToday({ profile_view: 99, like: 99 });
  inboxReadToday();
  const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(due.payload.next, null);
  assert.equal(due.payload.reason, "nothing owes work today");

  // A campaign that is the team folder can start on day 4.
  campaigns = [normalizeCampaign({ ...campaigns[0], fromDay: 4 })];
  const team = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(team.payload.next?.accountId, "acc-1");
  assert.equal(team.payload.next.invites, quota);
});

test("the poll counts the folder as work and takes nothing, however often it asks", async () => {
  const quota = onDay(8);
  spentToday({ profile_view: 99, like: 99 });
  inboxReadToday();

  for (let index = 0; index < 4; index += 1) {
    const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
    assert.equal(due.status, 200);
    assert.equal(due.payload.next.accountId, "acc-1", "a folder with people is a reason to open the browser");
    assert.deepEqual(due.payload.next.kinds, ["connect"]);
    assert.equal(due.payload.next.invites, quota);
    assert.equal(due.payload.next.leaseId, null);
  }
  assert.deepEqual(writes(), [], "no insert, no update, no delete — not even a log line");
  assert.equal(rows.wl_outreach.length, 0);

  // A folder everybody in has already been approached is not work.
  rows.wl_outreach = rows.contacts.map((row, index) => ({
    id: `o-${index}`, account_id: "acc-2", crm_contact_id: row.id, status: "pending", created_at: "2026-09-01T10:00:00.000Z"
  }));
  resetFeedHints();
  const empty = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(empty.payload.next, null, "a browser opened for nobody is the failure this rule exists to prevent");
});

test("a CRM that does not answer costs the poll the folder, not the answer — and is said once", async (t) => {
  const quota = onDay(8);
  // Views and likes done and the inbox read: the folder is the only reason to wake.
  spentToday({ profile_view: 99, like: 99 });
  inboxReadToday();
  process.env.WARMUP_FOLDER_CHECK_SECONDS = "0.05";
  slow.set("contacts", 400);
  t.after(() => { slow.clear(); delete process.env.WARMUP_FOLDER_CHECK_SECONDS; });
  const logged = t.mock.method(console, "error", () => {});

  // Without a bound the poll waited on the CRM for as long as it took — and
  // `fetch` has no timeout of its own. Now it answers without the folder.
  for (let index = 0; index < 3; index += 1) {
    const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
    assert.equal(due.status, 200);
    assert.equal(due.payload.next, null, "the folder counts as empty for this poll");
    assert.equal(due.payload.reason, "nothing owes work today");
  }
  const lease = await call({ method: "POST", path: "/api/warmup/agent/lease", body: { accountId: "acc-1" } });
  assert.equal(lease.status, 409, "and the lease is answered too, the same way");
  const said = logged.mock.calls.filter((entry) => String(entry.arguments[0]).includes("folder check"));
  assert.equal(said.length, 1, "an outage is said once, not on every poll all morning");

  // The CRM answers again, and the folder counts again.
  slow.clear();
  const back = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(back.payload.next?.accountId, "acc-1");
  assert.equal(back.payload.next.invites, quota);
});

test("what a person picked goes first, and the folder only fills the rest", async (t) => {
  const quota = onDay(8);
  rows.contacts.push(contact(900, { id: "c-hand", folder_id: "folder-team", created_at: "2026-02-01T00:00:00.000Z" }));
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-hand" } });

  t.mock.timers.setTime(MORNING.getTime() + 60_000);
  await takeAndAsk();
  assert.equal(waitingRows().length, quota, "one by hand, the rest from the folder");
  assert.equal(events("campaign.fed")[0].meta.added, quota - 1);

  // A seller picks somebody after the folder already filled the day. Theirs
  // goes ahead of the folder's; the stranger it displaces waits for tomorrow.
  t.mock.timers.setTime(MORNING.getTime() + 120_000);
  rows.contacts.push(contact(901, { id: "c-hand-2", folder_id: "folder-team", created_at: "2026-02-01T00:00:00.000Z" }));
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-hand-2" } });

  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  const sending = agent.payload.invites.toSend.map((row) => row.crmContactId);
  assert.equal(sending.length, quota, "cut to the allowance");
  assert.deepEqual(sending.slice(0, 2), ["c-hand", "c-hand-2"]);
  assert.equal(waitingRows().length, quota + 1, "nothing more was added for the one picked by hand");
});

test("nobody without a profile link, and nobody anybody already has", async () => {
  onDay(20);
  rows.contacts = [
    contact(10, { linkedin: null }),
    contact(9, { linkedin: "" }),
    contact(8, { linkedin: "https://www.linkedin.com/company/fleetify" }),
    contact(7),
    contact(6),
    contact(5),
    contact(4),
    contact(3),
    contact(2),
    contact(1)
  ];
  // Approached, claimed and held by other accounts, in every status there is.
  rows.wl_outreach = [
    { id: "o-a", account_id: "acc-2", crm_contact_id: "c-0007", status: "pending", created_at: "2026-09-01T10:00:00.000Z" },
    { id: "o-b", account_id: "acc-2", crm_contact_id: "c-0006", status: "queued", created_at: `${TODAY}T07:00:00.000Z` },
    { id: "o-c", account_id: "acc-3", crm_contact_id: "c-0005", status: "waiting", created_at: "2026-09-01T10:00:00.000Z" },
    { id: "o-d", account_id: "acc-3", crm_contact_id: "c-0004", status: "connected", created_at: "2026-09-01T10:00:00.000Z" }
  ];

  await takeAndAsk();
  const mine = rows.wl_outreach.filter((row) => row.account_id === "acc-1");
  assert.deepEqual(mine.map((row) => row.crm_contact_id), ["c-0003", "c-0002", "c-0001"]);
});

test("a folder whose first few hundred are spoken for still feeds — and the next walk starts where that one ended", async () => {
  const quota = onDay(8);
  // Three hundred newest, all approached from other accounts: the old walk read
  // two hundred rows from the front and answered "nobody left".
  rows.contacts = Array.from({ length: 320 }, (_, index) => contact(index));
  const spoken = newest(300);
  rows.wl_outreach = spoken.map((id, index) => ({
    id: `o-${index}`, account_id: "acc-2", crm_contact_id: id, status: "pending", created_at: "2026-09-01T10:00:00.000Z"
  }));

  await takeAndAsk();
  const mine = rows.wl_outreach.filter((row) => row.account_id === "acc-1").map((row) => row.crm_contact_id);
  assert.deepEqual(mine, newest(quota, rows.contacts.filter((row) => !spoken.includes(row.id))));

  // The next question does not walk the three hundred again.
  resetScheduler();
  requests.length = 0;
  spentToday({ profile_view: 99, like: 99 });
  rows.wl_outreach = rows.wl_outreach.filter((row) => row.account_id !== "acc-1");
  const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(due.payload.next?.invites, quota);
  assert.ok(requests.filter((entry) => entry.table === "contacts").length <= 3, "a page or two from where the last walk ended");
});

test("working mode tops up to the day's 10–15, and the account comes back for what one run could not carry", async (t) => {
  let day = 15;
  while (dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "connect") <= MAX_INVITES_PER_RUN) day += 1;
  const quota = onDay(day);
  assert.ok(quota >= 10 && quota <= 15);

  await takeAndAsk();
  assert.equal(waitingRows().length, quota);

  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(agent.payload.mode, "working");
  assert.equal(agent.payload.invites.toSend.length, MAX_INVITES_PER_RUN, "one run carries ten");

  // The ten went out; the rest wait, and the folder adds nobody on top of them.
  for (const row of agent.payload.invites.toSend) {
    await call({ method: "POST", path: "/api/warmup/agent", body: { action: "invite.sent", accountId: "acc-1", outreachId: row.outreachId, outcome: "sent" } });
  }
  await call({ method: "POST", path: "/api/warmup/agent", body: { action: "run.finished", accountId: "acc-1", ok: true } });
  const connects = rows.wl_day_actions.find((row) => row.kind === "connect");
  assert.equal(connects.done, MAX_INVITES_PER_RUN);
  rows.wl_day_actions.push(
    { id: "d-v", run_id: "run-1", account_id: "acc-1", on_date: TODAY, kind: "profile_view", done: 99, created_at: `${TODAY}T07:00:00.000Z` },
    { id: "d-l", run_id: "run-1", account_id: "acc-1", on_date: TODAY, kind: "like", done: 99, created_at: `${TODAY}T07:00:00.000Z` }
  );

  // Not straight away: the session that sent the ten has only just ended, and
  // with views and likes spent the next one would open on a Connect.
  const resting = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(resting.payload.next, null);
  assert.equal(resting.payload.reason, "Chloe Stewart is resting between sessions");

  t.mock.timers.setTime(MORNING.getTime() + (sameDayGapMinutes() + 1) * 60_000);
  const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(due.payload.next?.accountId, "acc-1");
  assert.equal(due.payload.next.mode, "working");
  assert.equal(due.payload.next.invites, quota - MAX_INVITES_PER_RUN, "the rest, and no more");

  await takeAndAsk();
  assert.equal(waitingRows().length, quota - MAX_INVITES_PER_RUN, "nothing added: what waits already fills the day");
});

/** A working-mode day on which acc-1 is dealt more requests than one run carries. */
function workingDayOverOneRun() {
  let day = 15;
  while (dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "connect") <= MAX_INVITES_PER_RUN) day += 1;
  const quota = onDay(day);
  return {
    day, quota,
    views: dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "profile_view"),
    likes: dailyQuota(DEFAULT_STRATEGY, "acc-1", day, "like")
  };
}

const record = (kind) => call({ method: "POST", path: "/api/warmup/agent", body: { action: "record", accountId: "acc-1", kind } });
const planRow = (agent, kind) => agent.payload.plan.find((row) => row.kind === kind);

test("a first session that failed after three requests leaves the next one its two views, before its requests", async (t) => {
  const { quota, views, likes } = workingDayOverOneRun();
  inboxReadToday();

  // The first session: the folder fills the day, and two views wait.
  const taken = await takeAndAsk();
  let agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(planRow(agent, "profile_view").heldBack, 2);
  assert.equal(planRow(agent, "profile_view").remaining, views - 2);

  // It does its views and likes — each answer counts down to the plan's
  // figure, not the day's — sends three, and Anty dies.
  const answers = [];
  for (let index = 0; index < views - 2; index += 1) answers.push((await record("profile_view")).payload);
  assert.deepEqual(answers.map((answer) => answer.remaining), Array.from({ length: views - 2 }, (_, index) => views - 3 - index));
  assert.ok(answers.every((answer) => answer.heldBack === 2 && answer.quota === views));
  for (let index = 0; index < likes; index += 1) await record("like");
  for (const row of agent.payload.invites.toSend.slice(0, 3)) {
    await call({ method: "POST", path: "/api/warmup/agent", body: { action: "invite.sent", accountId: "acc-1", outreachId: row.outreachId, outcome: "sent" } });
  }
  await call({ method: "POST", path: "/api/warmup/agent", body: {
    action: "run.finished", accountId: "acc-1", leaseId: taken.payload.lease.leaseId, ok: false, note: "Anty closed the profile"
  } });

  // After the cool-off: the two views are what it is woken for first, however
  // many requests are still to go.
  t.mock.timers.setTime(MORNING.getTime() + 46 * 60_000);
  const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.deepEqual(due.payload.next?.kinds, ["profile_view", "connect"]);
  assert.equal(due.payload.next.remaining, 2 + quota - 3);

  await takeAndAsk();
  agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(planRow(agent, "profile_view").heldBack, 0);
  assert.equal(planRow(agent, "profile_view").remaining, 2, "it opens on the two views, not on a Connect");
  assert.equal(planRow(agent, "like").remaining, 0);
  assert.equal(agent.payload.invites.toSend.length, Math.min(MAX_INVITES_PER_RUN, quota - 3));
  const view = await record("profile_view");
  assert.equal(view.payload.remaining, 1);
  assert.equal(view.payload.heldBack, 0);
});

test("a view is never refused for the two kept back, and the record answer counts them as the plan does", async () => {
  const { views } = workingDayOverOneRun();
  await takeAndAsk();

  let last = null;
  for (let index = 0; index < views - 2; index += 1) last = await record("profile_view");
  assert.deepEqual(last.payload, { success: true, done: views - 2, quota: views, remaining: 0, heldBack: 2 });
  // One past the plan is still the day's own: counted, not refused.
  const past = await record("profile_view");
  assert.equal(past.status, 200);
  assert.equal(past.payload.done, views - 1);
  assert.equal(past.payload.remaining, 1);
  assert.equal((await record("profile_view")).status, 200);
  assert.equal((await record("profile_view")).status, 409, "the day's quota is the only refusal");
  // Other kinds are as they were.
  const like = await record("like");
  assert.equal(like.payload.heldBack, 0);
  assert.equal(like.payload.remaining, like.payload.quota - like.payload.done);
});

test("a view whose hold-back could not be read is refused before it is counted, and the next one is answered in full", async () => {
  const { views } = workingDayOverOneRun();
  await takeAndAsk();
  const viewsCounted = () => rows.wl_day_actions
    .filter((row) => row.kind === "profile_view")
    .reduce((total, row) => total + (Number(row.done) || 0), 0);

  // The queue is read for the two kept back, and the read fails: the agent
  // hears an error for a view that is not on the day's counter, so its retry
  // counts it once.
  refuseRead = (table) => table === "wl_outreach";
  const failed = await record("profile_view");
  assert.ok(failed.status >= 500, `answered ${failed.status}`);
  assert.equal(viewsCounted(), 0, "nothing counted for a view the agent was told failed");
  assert.equal(events("action.recorded").length, 0);

  const retried = await record("profile_view");
  assert.deepEqual(retried.payload, { success: true, done: 1, quota: views, remaining: views - 2 - 1, heldBack: 2 });
  assert.equal(viewsCounted(), 1);
});

const report = (outreachId, outcome, accountId = "acc-1") => call({
  method: "POST", path: "/api/warmup/agent", body: { action: "invite.sent", accountId, outreachId, outcome }
});
const lease = takeAndAsk;
const agentWork = (accountId = "acc-1") => call({ method: "GET", path: `/api/warmup/agent?accountId=${accountId}` });
const finished = (leaseId, accountId = "acc-1") => call({
  method: "POST", path: "/api/warmup/agent", body: { action: "run.finished", accountId, leaseId, ok: true }
});
/** Who the folder would offer next, as the lead pool shows it. */
const pool = async () => (await call({ method: "GET", path: "/api/warmup/leads?campaignId=camp-1&limit=50" })).payload.leads.map((lead) => lead.id);
const DAY_MS = 86_400_000;

/** A second account with a run of its own on `day`. */
function secondAccount(day = 8) {
  rows.wl_accounts.push({
    id: "acc-2", label: "Dan Moreau", login: "dan@example.com", profile_remote_id: "profile-2", status: "warming", health: "ok"
  });
  rows.wl_runs.push({ ...rows.wl_runs[0], id: "run-2", account_id: "acc-2", started_at: startedForDay(day), paused_days: 0, paused_until: null });
  rows.anty_browser_profiles.push({ id: "profile-2", status: "stopped", is_deleted: false });
}

test("a held outcome about the person lets a folder person go, and the folder never offers them again", async (t) => {
  // `blocked` is here on purpose: the page may have been about the account,
  // not the person, but offering them again risks a second two-day pause.
  for (const outcome of ["no_button", "profile_gone", "blocked"]) {
    t.mock.timers.setTime(MORNING.getTime());
    resetScheduler();
    resetFeedHints();
    const quota = onDay(8);
    rows.wl_outreach = [];
    rows.wl_events = [];
    rows.wl_accounts[0].status = "warming";

    await lease();
    const [broken] = waitingRows();
    const answer = await report(broken.id, outcome);
    assert.equal(answer.status, 200, outcome);
    assert.equal(answer.payload.recorded, outcome);
    assert.equal(answer.payload.released, true, `${outcome}: nobody picked them, so nobody is left to wait for them`);
    assert.equal(answer.payload.skipped, true, outcome);
    assert.equal(rows.wl_outreach.some((row) => row.id === broken.id), false, outcome);
    assert.equal(events("invite.failed").length, 1, `${outcome}: why is on the record`);
    const [skip] = events("campaign.skipped");
    assert.equal(skip.meta.crmContactId, broken.crm_contact_id, outcome);
    assert.equal(skip.meta.outcome, outcome);
    assert.equal(skip.meta.slug, broken.person_linkedin.split("/in/")[1], "the profile goes in too, for its twins");
    assert.equal(skip.meta.campaignId, "camp-1");

    if (outcome === "blocked") {
      assert.equal(answer.payload.paused, true, "a block page still pauses the account");
      assert.equal(answer.payload.stopSending, true);
      assert.equal(answer.payload.parked, false, "let go, not parked: nobody is there to look at it");
    } else {
      // The day is not lost: somebody else from the folder takes the place.
      const agent = await agentWork();
      const sending = agent.payload.invites.toSend.map((row) => row.crmContactId);
      assert.equal(sending.length, quota, `${outcome}: the folder fills the place`);
      assert.equal(sending.includes(broken.crm_contact_id), false);
    }

    // And never offers them again: not when the walk starts from the front
    // tomorrow, where they would otherwise be first — their row is gone.
    resetFeedHints();
    t.mock.timers.setTime(MORNING.getTime() + DAY_MS);
    assert.equal((await pool()).includes(broken.crm_contact_id), false, `${outcome}: not in the pool the walk offers`);
  }
});

test("an agent that reports no_note for a bare request is named on the log as out of date", async () => {
  onDay(8);
  await lease();
  const [row] = waitingRows();
  await report(row.id, "no_note");
  const [mismatch] = events("invite.agent_mismatch");
  assert.equal(mismatch?.level, "error");
  assert.match(mismatch.message, /out of date/);

  // A note that was handed over and could not be attached is the real thing.
  rows.wl_events = [];
  onDay(12);
  rows.contacts.push(contact(900, { id: "c-hand", folder_id: "folder-team" }));
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-hand", note: "Привіт, Анно!" } });
  const picked = rows.wl_outreach.find((entry) => entry.crm_contact_id === "c-hand");
  await report(picked.id, "no_note");
  assert.equal(events("invite.agent_mismatch").length, 0);
});

test("an out-of-date agent's no_note sends a folder person back to the pool, not out of the folder", async (t) => {
  // Sessions ten minutes apart, as in the drain test below: the day's cap, not
  // the rest between sessions, is what ends the morning.
  process.env.WARMUP_SAME_DAY_GAP_MINUTES = "5";
  t.after(() => { delete process.env.WARMUP_SAME_DAY_GAP_MINUTES; });
  const quota = onDay(8);
  rows.contacts = Array.from({ length: 80 }, (_, index) => contact(index));
  spentToday({ profile_view: 99, like: 99 });
  inboxReadToday();

  // An agent built to the old handoff: every request comes bare, and it
  // reports `no_note` for every one of them.
  let now = MORNING.getTime();
  const answers = [];
  for (let cycle = 0; cycle < 8; cycle += 1) {
    now += 10 * 60_000;
    t.mock.timers.setTime(now);
    const taken = await lease();
    if (taken.status !== 200) break;
    const agent = await agentWork();
    for (const row of agent.payload.invites.toSend) answers.push((await report(row.outreachId, "no_note")).payload);
    await finished(taken.payload.lease.leaseId);
  }

  const fed = events("invite.requested").filter((event) => event.meta.source === "campaign");
  assert.equal(fed.length, 2 * quota, "still the day's cap and no more");
  assert.ok(answers.length && answers.every((answer) => answer.released === true && answer.skipped === false));
  assert.equal(events("invite.agent_mismatch").length, answers.length, "each one named on the log");
  assert.equal(events("campaign.skipped").length, 0, "nobody written off for the agent's fault");
  assert.equal(waitingRows().length, 0, "and nobody left holding the account's day");

  // Tomorrow the walk starts from the front, and every one of them is there.
  resetFeedHints();
  t.mock.timers.setTime(MORNING.getTime() + DAY_MS);
  const offered = await pool();
  for (const event of fed) assert.ok(offered.includes(event.meta.crmContactId), `${event.meta.crmContactId} back in the pool`);
});

test("a no_note on a folder row that was handed its note is about the person, and lets them go for good", async () => {
  // Day 12: a note of three words or fewer goes. The folder writes none, so
  // this is a person who set one on the row by hand.
  onDay(12);
  await lease();
  const [row] = waitingRows();
  row.note = "Раді знайомству";
  const handed = (await agentWork()).payload.invites.toSend.find((entry) => entry.outreachId === row.id);
  assert.equal(handed.note, "Раді знайомству");

  const answer = await report(row.id, "no_note");
  assert.equal(answer.payload.released, true);
  assert.equal(answer.payload.skipped, true);
  assert.equal(events("invite.agent_mismatch").length, 0, "the agent did what it was told");
  assert.equal(events("campaign.skipped")[0]?.meta.crmContactId, row.crm_contact_id);
});

test("still anybody's to pick by hand: the folder letting somebody go binds only the folder", async () => {
  const quota = onDay(8);
  await lease();
  const [broken] = waitingRows();
  await report(broken.id, "profile_gone");

  const queued = await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: broken.crm_contact_id } });
  assert.equal(queued.status, 200);
  assert.equal(queued.payload.invite.fromCampaign, null, "this one a person picked — not the folder's old request");
  const agent = await agentWork();
  assert.equal(agent.payload.invites.toSend[0].crmContactId, broken.crm_contact_id, "and a person's pick goes first");
  assert.equal(agent.payload.invites.toSend.length, quota);
});

test("an agent that can reach nobody cannot walk the folder: it adds twice the day's quota at most", async (t) => {
  // Sessions ten minutes apart, so the cap and not the hour's rest between
  // sessions is what ends the morning.
  process.env.WARMUP_SAME_DAY_GAP_MINUTES = "5";
  t.after(() => { delete process.env.WARMUP_SAME_DAY_GAP_MINUTES; });
  const quota = onDay(8);
  rows.contacts = Array.from({ length: 80 }, (_, index) => contact(index));
  spentToday({ profile_view: 99, like: 99 });
  inboxReadToday();

  // Selector rot: every profile comes back `no_button`, every session ends ok.
  let now = MORNING.getTime();
  let sessions = 0;
  for (let cycle = 0; cycle < 8; cycle += 1) {
    now += 10 * 60_000;
    t.mock.timers.setTime(now);
    const taken = await lease();
    if (taken.status !== 200) break;
    sessions += 1;
    const agent = await agentWork();
    for (const row of agent.payload.invites.toSend) await report(row.outreachId, "no_button");
    await finished(taken.payload.lease.leaseId);
  }

  const fed = events("invite.requested").filter((event) => event.meta.source === "campaign");
  assert.equal(fed.length, 2 * quota, "one full replacement of everybody, and no more");
  assert.equal(sessions, 2);
  assert.equal(events("campaign.skipped").length, 2 * quota);
  assert.equal(waitingRows().length, 0, "and nobody left behind holding the account's day");

  // The poll counts the same cap: nothing to wake the account for.
  t.mock.timers.setTime(now + 10 * 60_000);
  const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(due.payload.next, null);
  assert.equal(due.payload.reason, "nothing owes work today");
  // And a question from the agent adds nobody past it either.
  await agentWork();
  assert.equal(events("invite.requested").length, 2 * quota);
});

test("a person picked by hand whom the browser could not reach rests until tomorrow, and does not keep waking the account", async (t) => {
  onDay(8);
  campaigns = [];
  rows.contacts.push(contact(900, { id: "c-hand", folder_id: "folder-team" }));
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-hand" } });
  const [row] = waitingRows();
  // Views and likes done and the inbox read: the request is the one thing left.
  spentToday({ profile_view: 99, like: 99 });
  inboxReadToday();

  const before = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.deepEqual(before.payload.next?.kinds, ["connect"]);
  const taken = await lease();
  assert.equal(taken.status, 200);
  await report(row.id, "no_button");
  assert.equal(rows.wl_outreach.find((entry) => entry.id === row.id).status, "waiting", "a person picked it, so it waits for a person");
  assert.equal(events("campaign.skipped").length, 0);
  await finished(taken.payload.lease.leaseId);

  // Allowance left, the lease given back — and still nothing to wake it for.
  const after = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(after.payload.next, null);
  assert.equal(after.payload.reason, "nothing owes work today");
  assert.deepEqual((await agentWork()).payload.invites.toSend, [], "not handed straight back the same day");

  // The failure today is the whole reason: without it the account is due —
  // once the rest after this morning's session is over.
  rows.wl_events = rows.wl_events.filter((event) => event.type !== "invite.failed");
  t.mock.timers.setTime(MORNING.getTime() + (sameDayGapMinutes() + 1) * 60_000);
  const without = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.deepEqual(without.payload.next?.kinds, ["connect"]);
  assert.equal(without.payload.next.invites, 1);
});

/** Views and likes done and the inbox read today: invitations are all an account could be woken for. */
function everythingElseDone() {
  const todayIso = new Date().toISOString().slice(0, 10);
  rows.wl_day_actions = ["profile_view", "like"].map((kind, index) => ({
    id: `d-${index}`, run_id: "run-1", account_id: "acc-1", on_date: todayIso, kind, quota: 99, done: 99,
    created_at: new Date().toISOString()
  }));
  rows.wl_events.push({
    id: `synced-${++nextId}`, account_id: "acc-1", level: "info", type: "inbox.synced", message: "Inbox synced", meta: { threadsSeen: 0 },
    created_at: new Date().toISOString()
  });
}

test("a block page on a person picked by hand pauses the account and parks them at once, even alone in the queue", async (t) => {
  onDay(8);
  campaigns = [];
  for (const [index, id] of ["c-a", "c-b", "c-c"].entries()) {
    rows.contacts.push(contact(900 + index, { id, folder_id: "folder-team", name: `Picked ${id}` }));
    await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: id } });
  }
  rows.wl_outreach.forEach((row, index) => { row.created_at = `2026-09-20T10:0${index}:00.000Z`; });
  const idOf = (contactId) => rows.wl_outreach.find((row) => row.crm_contact_id === contactId).id;

  const first = await report(idOf("c-a"), "blocked");
  assert.equal(first.payload.paused, true, "a block page is LinkedIn's warning: the whole account stops");
  assert.equal(first.payload.released, false, "a person picked them, so they stay held");
  assert.equal(first.payload.skipped, false);
  assert.equal(first.payload.parked, true, "on the first block page, not the second");
  const pausedUntil = rows.wl_runs[0].paused_until;

  // The pause over: not handed out, not counted, and said to a person.
  t.mock.timers.setTime(MORNING.getTime() + 3 * DAY_MS);
  let agent = await agentWork();
  assert.equal(agent.payload.runnable, true);
  assert.deepEqual(agent.payload.invites.toSend.map((row) => row.crmContactId), ["c-b", "c-c"]);
  const card = await call({ method: "GET", path: "/api/warmup/invites?crmContactId=c-a" });
  assert.equal(card.payload.invite.parked, true);
  const queue = await call({ method: "GET", path: "/api/warmup/queue?accountId=acc-1" });
  assert.equal(queue.payload.waiting.find((row) => row.crmContactId === "c-a").parked, true);
  assert.equal(queue.payload.waiting.find((row) => row.crmContactId === "c-b").parked, false);

  // Alone in the queue it is still nobody's work. Once it was only sent to
  // the back, and with nobody in front of it opened the next session, where
  // the same page paused the account a second time.
  rows.wl_outreach = rows.wl_outreach.filter((row) => row.crm_contact_id === "c-a");
  resetScheduler();
  everythingElseDone();
  const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(due.payload.next, null, "a parked person is nobody's work until a person moves them");
  assert.deepEqual((await agentWork()).payload.invites.toSend, []);
  assert.equal(events("run.warning").length, 1);
  assert.equal(rows.wl_runs[0].paused_until, pausedUntil, "no second pause");

  // Moved to another login, it is a fresh attempt.
  secondAccount(8);
  const moved = await call({ method: "POST", path: "/api/warmup/invites/reassign", body: { outreachId: idOf("c-a"), accountId: "acc-2" } });
  assert.equal(moved.status, 200);
  assert.equal(moved.payload.invite.parked, false);
  const other = await agentWork("acc-2");
  assert.equal(other.payload.invites.toSend[0]?.crmContactId, "c-a");

  // Blocked there too, then cancelled and queued again: a new request, and
  // nothing about the old one parks it.
  t.mock.timers.setTime(MORNING.getTime() + 3 * DAY_MS + 60 * 60_000);
  assert.equal((await report(idOf("c-a"), "blocked", "acc-2")).payload.parked, true);
  const blockedAgain = await call({ method: "GET", path: "/api/warmup/invites?crmContactId=c-a" });
  assert.equal(blockedAgain.payload.invite.parked, true, "a block page after the move parks it again");
  await call({ method: "POST", path: "/api/warmup/invites/cancel", body: { outreachId: idOf("c-a") } });
  const requeued = await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-a" } });
  assert.equal(requeued.status, 200);
  assert.equal(requeued.payload.invite.parked, false);
  assert.equal((await agentWork()).payload.invites.toSend[0]?.crmContactId, "c-a");
});

test("a report while an earlier block page's pause holds is about the account: nobody is parked or skipped for it", async (t) => {
  onDay(8);
  const idOf = await twoPicked();
  await lease();
  const [folderRow] = waitingRows().filter((row) => !["c-a", "c-b"].includes(row.crm_contact_id));
  assert.ok(folderRow, "the folder fills the rest of the day");

  // The first block page: about the person as far as anybody can tell. Its
  // answer says `overQuota` too — what an agent built before `blocked`
  // paused anything stops on.
  const first = await report(idOf("c-a"), "blocked");
  assert.equal(first.payload.parked, true);
  assert.equal(first.payload.paused, true);
  assert.equal(first.payload.overQuota, true);
  assert.equal(first.payload.stopSending, true);
  assert.equal(first.payload.duringPause, undefined);

  // An agent that went on anyway: the next person lands on a block page as
  // well, and so does the folder's. The account was paused already.
  const second = await report(idOf("c-b"), "blocked");
  assert.equal(second.status, 200);
  assert.equal(second.payload.parked, false, "the page was about the account");
  assert.equal(second.payload.released, false);
  assert.equal(second.payload.duringPause, true);
  assert.equal(second.payload.overQuota, true);
  assert.equal(second.payload.stopSending, true);
  assert.equal(rows.wl_outreach.find((row) => row.id === idOf("c-b")).status, "waiting");
  const failed = events("invite.failed").find((event) => event.meta.outreachId === idOf("c-b"));
  assert.equal(failed.meta.duringPause, true);

  const folder = await report(folderRow.id, "profile_gone");
  assert.equal(folder.payload.released, true, "nobody picked them, so the row still goes");
  assert.equal(folder.payload.skipped, false, "but back to the pool, not out of the folder");
  assert.equal(folder.payload.duringPause, true);
  assert.equal(folder.payload.overQuota, true);
  assert.equal(folder.payload.stopSending, true);
  assert.equal(events("campaign.skipped").length, 0);

  // The pause over: the one the first page was about stays parked, the other
  // is handed out, and the folder's person is in the pool again.
  resetFeedHints();
  t.mock.timers.setTime(MORNING.getTime() + 3 * DAY_MS);
  assert.equal((await call({ method: "GET", path: "/api/warmup/invites?crmContactId=c-b" })).payload.invite.parked, false);
  assert.equal((await call({ method: "GET", path: "/api/warmup/invites?crmContactId=c-a" })).payload.invite.parked, true);
  const sending = (await agentWork()).payload.invites.toSend.map((row) => row.crmContactId);
  assert.ok(sending.includes("c-b"));
  assert.equal(sending.includes("c-a"), false);
  assert.ok(sending.includes(folderRow.crm_contact_id) || (await pool()).includes(folderRow.crm_contact_id));
});

test("a block page whose failure could not be written parks the person on the retry: the pause was its own", async (t) => {
  onDay(8);
  campaigns = [];
  const idOf = await twoPicked();
  await lease();

  // The pause is written, then the failure is not: the agent hears 503 and
  // asks again, as it is told to. The account is paused by then — by this
  // report, not an earlier one.
  refuseInsert = (table, inserted) => table === "wl_events" && inserted?.type === "invite.failed";
  assert.equal((await report(idOf("c-a"), "blocked")).status, 503);
  assert.ok(rows.wl_runs[0].paused_until, "paused all the same");
  const retry = await report(idOf("c-a"), "blocked");
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.parked, true, "the block page was on this person, as far as anybody can tell");
  assert.equal(retry.payload.duringPause, undefined);
  assert.equal(retry.payload.paused, true);
  const failed = events("invite.failed").filter((event) => event.meta.outreachId === idOf("c-a"));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].meta.duringPause, undefined);

  // A report that came while that pause held is still about the account,
  // retried or not.
  refuseInsert = (table, inserted) => table === "wl_events" && inserted?.type === "invite.failed";
  assert.equal((await report(idOf("c-b"), "blocked")).status, 503);
  const later = await report(idOf("c-b"), "blocked");
  assert.equal(later.payload.parked, false);
  assert.equal(later.payload.duringPause, true);

  // The pause over: the person whose page paused the account is not handed
  // out again to pause it a second time.
  t.mock.timers.setTime(MORNING.getTime() + 3 * DAY_MS);
  assert.equal((await call({ method: "GET", path: "/api/warmup/invites?crmContactId=c-a" })).payload.invite.parked, true);
  assert.deepEqual((await agentWork()).payload.invites.toSend.map((row) => row.crmContactId), ["c-b"]);
});

test("a folder's block page whose account row could not be written is skipped on the retry", async () => {
  onDay(8);
  await lease();
  const [row] = waitingRows();

  // The run is paused and its warning written, then the account row is not.
  refuseUpdate = (table) => table === "wl_accounts";
  assert.equal((await report(row.id, "blocked")).status, 503);
  assert.ok(rows.wl_runs[0].paused_until);
  const retry = await report(row.id, "blocked");
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.released, true);
  assert.equal(retry.payload.skipped, true, "out of the folder, not back in the pool");
  assert.equal(retry.payload.duringPause, undefined);
  assert.equal(rows.wl_accounts[0].status, "restricted", "and the retry wrote the account row");
  assert.ok(events("campaign.skipped").some((event) => event.meta.outreachId === row.id));
  assert.equal(rows.wl_outreach.some((entry) => entry.id === row.id), false);
});

// ── a report sent twice ──────────────────────────────────────────────────
//
// The handoff tells the agent to retry a report twice, three seconds apart,
// when it gets no answer — and the usual reason is a socket dropped after the
// server had done everything.

/** Two people picked by hand on acc-1, oldest first. */
async function twoPicked() {
  for (const [index, id] of ["c-a", "c-b"].entries()) {
    rows.contacts.push(contact(900 + index, { id, folder_id: "folder-team", name: `Picked ${id}` }));
    await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: id } });
  }
  return (contactId) => rows.wl_outreach.find((row) => row.crm_contact_id === contactId).id;
}

test("a held report sent again in the same session gets the same answer and changes nothing", async (t) => {
  onDay(8);
  campaigns = [];
  const idOf = await twoPicked();
  await lease();

  const first = await report(idOf("c-a"), "no_button");
  t.mock.timers.setTime(MORNING.getTime() + 15 * 60_000);
  const retry = await report(idOf("c-a"), "no_button");
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.payload, first.payload);
  assert.equal(events("invite.failed").length, 1, "one attempt, one failure on the record");

  const blocked = await report(idOf("c-b"), "blocked");
  const pause = { ...rows.wl_runs[0] };
  const blockedRetry = await report(idOf("c-b"), "blocked");
  assert.deepEqual(blockedRetry.payload, blocked.payload);
  assert.equal(blockedRetry.payload.parked, true);
  assert.equal(events("invite.failed").length, 2);
  assert.equal(events("run.warning").length, 1, "one block page, one warning");
  assert.deepEqual(rows.wl_runs[0], pause, "and the pause is not moved again");

  // Two copies at once — the retry while the first is still being handled.
  rows.wl_events = [];
  const [one, two] = await Promise.all([report(idOf("c-a"), "profile_gone"), report(idOf("c-a"), "profile_gone")]);
  assert.deepEqual(one.payload, two.payload);
  assert.equal(events("invite.failed").length, 1);
});

test("with no session to tell by, a held report counts as the same for ten minutes", async (t) => {
  onDay(8);
  campaigns = [];
  const idOf = await twoPicked();

  const first = await report(idOf("c-a"), "no_button");
  t.mock.timers.setTime(MORNING.getTime() + 9 * 60_000);
  assert.deepEqual((await report(idOf("c-a"), "no_button")).payload, first.payload);
  assert.equal(events("invite.failed").length, 1);

  // Another outcome is another report, and so is the same one later on.
  await report(idOf("c-a"), "profile_gone");
  assert.equal(events("invite.failed").length, 2);
  t.mock.timers.setTime(MORNING.getTime() + 20 * 60_000);
  await report(idOf("c-a"), "profile_gone");
  assert.equal(events("invite.failed").length, 3);

  // And a session's own lease id says which session it is, whatever the clock.
  await call({ method: "POST", path: "/api/warmup/agent", body: {
    action: "invite.sent", accountId: "acc-1", outreachId: idOf("c-b"), outcome: "no_button", leaseId: "session-1"
  } });
  await call({ method: "POST", path: "/api/warmup/agent", body: {
    action: "invite.sent", accountId: "acc-1", outreachId: idOf("c-b"), outcome: "no_button", leaseId: "session-2"
  } });
  assert.equal(events("invite.failed").filter((event) => event.meta.outreachId === idOf("c-b")).length, 2);
});

test("a held report sent again after it let a folder person go gets the same answer, not a 404", async () => {
  onDay(8);
  await lease();
  const [skipped, unmarked, blocked] = waitingRows();

  for (const [row, outcome] of [[skipped, "profile_gone"], [unmarked, "no_note"], [blocked, "blocked"]]) {
    const first = await report(row.id, outcome);
    assert.equal(first.payload.released, true, outcome);
    const retry = await report(row.id, outcome);
    assert.equal(retry.status, 200, `${outcome}: not "that invitation is gone"`);
    assert.deepEqual(retry.payload, first.payload, outcome);
  }
  assert.equal(events("invite.failed").length, 3, "no second failure, and no 'cancelled mid-send'");
  assert.equal(events("invite.failed").some((event) => event.meta.outcome === "row_gone"), false);
  assert.equal(events("campaign.skipped").length, 2, "the two about the person, once each");
  assert.equal(events("invite.agent_mismatch").length, 1);
  assert.equal(events("run.warning").length, 1);

  // A request that did go out to somebody let go is still the orphan it was.
  const sent = await report(skipped.id, "sent");
  assert.equal(sent.status, 404);
  assert.equal(events("invite.failed").filter((event) => event.meta.outcome === "row_gone").length, 1);
});

test("a held report whose failure could not be written lets nobody go, and its retry is handled in full", async () => {
  onDay(8);
  await lease();
  const [row] = waitingRows();

  // The failure is what a retry is answered from once the row is gone, so it
  // is written first: a row let go with no record of why would come back 404.
  refuseInsert = (table, inserted) => table === "wl_events" && inserted?.type === "invite.failed";
  const first = await report(row.id, "no_note");
  assert.equal(first.status, 503);
  assert.equal(rows.wl_outreach.some((entry) => entry.id === row.id), true, "still held: nothing was let go");

  const retry = await report(row.id, "no_note");
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.released, true);
  assert.equal(rows.wl_outreach.some((entry) => entry.id === row.id), false);
  assert.equal(events("invite.failed").length, 1);
});

test("a held report whose release failed half-way is finished by its retry", async () => {
  onDay(8);
  await lease();
  const [undeleted, unmarked] = waitingRows();

  // The answer is stored and the skip marker written, then the delete does
  // not land: the row is still here, and a retry that only repeated the
  // answer left it holding the account's day.
  refuseDelete = (table) => table === "wl_outreach";
  assert.equal((await report(undeleted.id, "no_button")).status, 503);
  assert.equal(rows.wl_outreach.some((row) => row.id === undeleted.id), true);
  const again = await report(undeleted.id, "no_button");
  assert.equal(again.status, 200);
  assert.equal(again.payload.released, true);
  assert.equal(again.payload.skipped, true);
  assert.equal(rows.wl_outreach.some((row) => row.id === undeleted.id), false, "let go now");
  assert.ok(events("campaign.skipped").some((event) => event.meta.outreachId === undeleted.id));
  assert.equal(events("invite.failed").filter((event) => event.meta.outreachId === undeleted.id).length, 1);

  // The skip marker does not land: a block page's folder row stayed in the
  // queue as «Потребує уваги» for good.
  refuseInsert = (table, inserted) => table === "wl_events" && inserted?.type === "campaign.skipped";
  assert.equal((await report(unmarked.id, "blocked")).status, 503);
  assert.equal(rows.wl_outreach.some((row) => row.id === unmarked.id), true);
  const retry = await report(unmarked.id, "blocked");
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.released, true);
  assert.equal(retry.payload.skipped, true);
  assert.equal(rows.wl_outreach.some((row) => row.id === unmarked.id), false);
  assert.equal(events("campaign.skipped").filter((event) => event.meta.outreachId === unmarked.id).length, 1);
  assert.equal(events("invite.failed").filter((event) => event.meta.outreachId === unmarked.id).length, 1);
  const queue = await call({ method: "GET", path: "/api/warmup/queue?accountId=acc-1" });
  assert.equal(queue.payload.waiting.some((row) => row.crmContactId === unmarked.crm_contact_id), false);
});

// ── a long history ───────────────────────────────────────────────────────

test("today's failure and a block page are seen however many failures came before them", async () => {
  onDay(8);
  campaigns = [];
  for (const [index, id] of ["c-a", "c-b", "c-c"].entries()) {
    rows.contacts.push(contact(900 + index, { id, folder_id: "folder-team", name: `Picked ${id}` }));
    await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: id } });
  }
  const idOf = (contactId) => rows.wl_outreach.find((row) => row.crm_contact_id === contactId).id;
  spentToday({ profile_view: 99, like: 99 });
  inboxReadToday();

  // A person no profile will ever take fails once a day for as long as they
  // wait. Here: twelve hundred failures before today — more than one answer
  // from Supabase carries — then six hundred block pages on another row from
  // the days before the account learned to park, and one on a third row
  // older than all of them.
  const midnight = Date.parse(`${TODAY}T00:00:00.000Z`);
  const old = (index, outreachId, outcome) => ({
    id: `old-${index}`, account_id: "acc-1", level: "warn", type: "invite.failed", message: `Could not invite: ${outcome}`,
    meta: { outreachId, outcome }, created_at: new Date(midnight - (index + 1) * 30_000).toISOString()
  });
  let index = 0;
  for (let count = 0; count < 600; count += 1) rows.wl_events.push(old(index++, idOf("c-b"), "blocked"));
  for (let count = 0; count < 1200; count += 1) rows.wl_events.push(old(index++, idOf("c-a"), "no_button"));
  rows.wl_events.push(old(index++, idOf("c-c"), "blocked"));

  // Today the first one fails again.
  await report(idOf("c-a"), "no_button");

  assert.deepEqual((await agentWork()).payload.invites.toSend, [], "one resting until tomorrow, two parked");
  const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(due.payload.next, null);
  assert.equal(due.payload.reason, "nothing owes work today");
  for (const id of ["c-b", "c-c"]) {
    const card = await call({ method: "GET", path: `/api/warmup/invites?crmContactId=${id}` });
    assert.equal(card.payload.invite.parked, true, id);
  }
});

test("cancelling a person the folder added keeps the folder from offering them again; a person picked by hand goes back to the pool", async () => {
  const quota = onDay(8);
  await lease();
  const [first] = waitingRows();
  const cancelled = await call({ method: "POST", path: "/api/warmup/invites/cancel", body: { outreachId: first.id } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.payload.skipped, true);
  const [skip] = events("campaign.skipped");
  assert.equal(skip.meta.reason, "cancelled");
  assert.equal(skip.meta.cancelledBy, "seller@example.com");

  const agent = await agentWork();
  assert.equal(agent.payload.invites.toSend.length, quota, "the folder fills the place with somebody else");
  assert.equal(agent.payload.invites.toSend.some((row) => row.crmContactId === first.crm_contact_id), false);
  assert.equal((await pool()).includes(first.crm_contact_id), false);
  // Still the same contact after somebody fixes the link in the CRM.
  rows.contacts.find((row) => row.id === first.crm_contact_id).linkedin = "https://www.linkedin.com/in/fixed-link";
  resetFeedHints();
  assert.equal((await pool()).includes(first.crm_contact_id), false, "skipped by contact, not only by profile");

  // Picked by hand from the same folder, then cancelled: back in the pool.
  const [next] = await pool();
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: next } });
  const picked = rows.wl_outreach.find((row) => row.crm_contact_id === next);
  const again = await call({ method: "POST", path: "/api/warmup/invites/cancel", body: { outreachId: picked.id } });
  assert.equal(again.payload.skipped, false);
  assert.equal(events("campaign.skipped").length, 1);
  resetFeedHints();
  assert.equal((await pool())[0], next);
});

test("one profile entered twice in the CRM is approached once, whichever account asks", async () => {
  const quota = onDay(8);
  secondAccount(8);
  campaigns = [normalizeCampaign({ ...campaigns[0], accountIds: ["acc-1", "acc-2"] })];
  rows.contacts = [
    contact(5, { id: "c-202", linkedin: "https://www.linkedin.com/in/anna-k?trk=x" }),
    contact(4, { id: "c-101", linkedin: "linkedin.com/in/Anna-K/" }),
    contact(3, { id: "c-bob", linkedin: "https://www.linkedin.com/in/bob-z" }),
    contact(2),
    contact(1)
  ];
  // Bob was approached long ago, under another contact and another spelling.
  rows.wl_outreach = [{
    id: "o-bob", account_id: "acc-3", crm_contact_id: "c-bob-old", person_linkedin: "http://linkedin.com/in/Bob-Z/",
    status: "pending", created_at: "2026-09-01T10:00:00.000Z"
  }];

  assert.deepEqual(await pool(), ["c-202", "c-0002", "c-0001"]);

  // The first account has room for one today, so the second one is asked
  // about the rest — the way the same person used to reach two logins.
  spentToday({ profile_view: 99, like: 99, connect: quota - 1 });
  await agentWork("acc-1");
  await agentWork("acc-2");
  assert.deepEqual(rows.wl_outreach.filter((row) => row.account_id === "acc-1").map((row) => row.crm_contact_id), ["c-202"]);
  const queued = rows.wl_outreach.filter((row) => row.status === "waiting").map((row) => row.crm_contact_id);
  assert.equal(queued.includes("c-202") && queued.includes("c-101"), false, "Anna gets one request, not one from each login");
  assert.equal(queued.includes("c-bob"), false);
  assert.equal(queued.filter((id) => id === "c-202" || id === "c-101").length, 1);

  // Let go under one contact, not offered under the other.
  rows.wl_outreach = [];
  rows.wl_events = [];
  resetFeedHints();
  await lease();
  const anna = rows.wl_outreach.find((row) => row.crm_contact_id === "c-202");
  await report(anna.id, "profile_gone");
  resetFeedHints();
  assert.equal((await pool()).includes("c-101"), false, "the same profile is the same person");
});

test("people the folder queued wait for their campaign's first day, even on a run started again", async () => {
  const quota = onDay(8);
  await lease();
  assert.equal(waitingRows().length, quota);

  // Stopped and started again: a new run, and on its day 5 the folder's
  // leftovers are not the team's one or two requests.
  onDay(5);
  resetScheduler();
  const agent = await agentWork();
  assert.deepEqual(agent.payload.invites.toSend, [], "days 4–6 are for people picked by hand");
  spentToday({ profile_view: 99, like: 99 });
  inboxReadToday();
  const due = await call({ method: "GET", path: "/api/warmup/agent/due" });
  assert.equal(due.payload.next, null, "and nobody wakes the account for them");

  // A person picked by hand still goes.
  rows.contacts.push(contact(900, { id: "c-hand", folder_id: "folder-team" }));
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-hand" } });
  assert.deepEqual((await agentWork()).payload.invites.toSend.map((row) => row.crmContactId), ["c-hand"]);

  // From the campaign's day on, the folder's people go again.
  onDay(7);
  rows.wl_day_actions = [];
  const later = await agentWork();
  assert.ok(later.payload.invites.toSend.some((row) => row.crmContactId !== "c-hand"));
});

test("a claim a person took by hand still works, and the folder counts it as held", async () => {
  const quota = onDay(8);
  const claimed = await call({ method: "POST", path: "/api/warmup/campaigns/claim", body: { accountId: "acc-1" } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.payload.claimed.length, quota);
  assert.ok(claimed.payload.claimed.every((row) => row.linkedin), "claims come from the same queue, profile links only");

  await takeAndAsk();
  assert.equal(waitingRows().length, 0, "the day is already allocated to the person who claimed it");

  // And the other way round: a day the folder filled has nothing left to claim.
  rows.wl_outreach = [];
  await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  const again = await call({ method: "POST", path: "/api/warmup/campaigns/claim", body: { accountId: "acc-1" } });
  assert.deepEqual(again.payload.claimed, []);
  assert.match(again.payload.reason, /already claimed/);
});

test("a warning stops the feed with everything else", async () => {
  onDay(8);
  await call({ method: "POST", path: "/api/warmup/agent", body: { action: "warning", accountId: "acc-1" } });
  const agent = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(agent.payload.runnable, false);
  assert.equal(waitingRows().length, 0);
});

test("a campaign that is not running, or not ticked, feeds nobody", async () => {
  onDay(8);
  campaigns = [normalizeCampaign({ ...campaigns[0], state: "paused" })];
  await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(waitingRows().length, 0);

  campaigns = [normalizeCampaign({ ...campaigns[0], state: "running", accountIds: ["acc-2"] })];
  await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(waitingRows().length, 0);
});

test("the queue panel hears whether the folder is feeding, and which waiting rows came from it", async () => {
  const quota = onDay(8);
  await takeAndAsk();

  const queue = await call({ method: "GET", path: "/api/warmup/queue?accountId=acc-1&campaignId=camp-1" });
  assert.equal(queue.status, 200);
  assert.equal(queue.payload.autoFeed.on, true);
  assert.equal(queue.payload.autoFeed.fromDay, 7);
  assert.equal(queue.payload.autoFeed.day, 8);
  assert.equal(queue.payload.waiting.length, quota);
  assert.ok(queue.payload.waiting.every((row) => row.fromFolder && row.campaignName === "LinkedIn2"));

  onDay(5);
  const early = await call({ method: "GET", path: "/api/warmup/queue?accountId=acc-1&campaignId=camp-1" });
  assert.equal(early.payload.autoFeed.on, false);
  assert.equal(early.payload.autoFeed.day, 5);
});

test("the queue panel hears which campaigns above fill the account first", async () => {
  // The top-up fills first campaign first, so a campaign ranked below another
  // on the same account is "on" while its folder never moves. The panel is
  // told who is ahead, and says so instead of «працює».
  onDay(8);
  const below = normalizeCampaign({ ...campaigns[0], order: 1 });
  const above = normalizeCampaign({
    id: "camp-0", name: "Команда", folderId: "folder-1", filters: {}, accountIds: ["acc-1"], state: "running", order: 0
  });
  campaigns = [above, below];
  const queue = (campaignId) => call({ method: "GET", path: `/api/warmup/queue?accountId=acc-1&campaignId=${campaignId}` });

  const lower = await queue("camp-1");
  assert.equal(lower.payload.autoFeed.on, true);
  assert.deepEqual(lower.payload.autoFeed.ahead, [{ id: "camp-0", name: "Команда" }]);
  assert.deepEqual((await queue("camp-0")).payload.autoFeed.ahead, [], "nobody is ahead of the first");

  // Only what actually takes today counts as ahead: one above that has not
  // reached its day, or is paused, or does not tick this account, takes nothing.
  for (const change of [{ fromDay: 10 }, { state: "paused" }, { accountIds: ["acc-2"] }]) {
    campaigns = [normalizeCampaign({ ...above, ...change }), below];
    assert.deepEqual((await queue("camp-1")).payload.autoFeed.ahead, [], JSON.stringify(change));
  }
});

test("a campaign is created and edited with its first day, and a wrong one is refused", async () => {
  const created = await call({
    method: "POST", path: "/api/warmup/campaigns",
    body: { name: "Team", folderId: "folder-1", accountIds: ["acc-1"], filters: {} }
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.campaign.fromDay, 7);

  const edited = await call({ method: "PATCH", path: "/api/warmup/campaigns", body: { id: created.payload.campaign.id, fromDay: "4" } });
  assert.equal(edited.status, 200);
  assert.equal(edited.payload.campaign.fromDay, 4);

  const kept = await call({ method: "PATCH", path: "/api/warmup/campaigns", body: { id: created.payload.campaign.id, name: "Team 2" } });
  assert.equal(kept.payload.campaign.fromDay, 4, "absent keeps what was saved");

  const wrong = await call({ method: "PATCH", path: "/api/warmup/campaigns", body: { id: created.payload.campaign.id, fromDay: 0 } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.payload.error, /З якого дня/);

  const wrongNew = await call({ method: "POST", path: "/api/warmup/campaigns", body: { name: "X", folderId: "folder-1", fromDay: "later" } });
  assert.equal(wrongNew.status, 400);
});

test("a profile spelled in Cyrillic or with an underscore is still one person to the walk", async () => {
  onDay(8);
  // The slug goes into the pattern literal now (`slugLikeForms`): the escaped
  // `%` of the encoded spelling and the escaped `_` still have to find the twin.
  const cyrillic = "анна-коваленко";
  rows.contacts = [
    contact(4, { id: "c-cyr", linkedin: `https://www.linkedin.com/in/${cyrillic}/` }),
    contact(3, { id: "c-under", linkedin: "https://www.linkedin.com/in/anna_k2" }),
    contact(2),
    contact(1)
  ];
  rows.wl_outreach = [
    { id: "o-cyr", account_id: "acc-3", crm_contact_id: "c-cyr-old", person_linkedin: `http://linkedin.com/in/${encodeURIComponent(cyrillic)}`,
      status: "pending", created_at: "2026-09-01T10:00:00.000Z" },
    { id: "o-under", account_id: "acc-3", crm_contact_id: "c-under-old", person_linkedin: "linkedin.com/in/Anna_K2/",
      status: "pending", created_at: "2026-09-01T10:00:00.000Z" }
  ];
  assert.deepEqual(await pool(), ["c-0002", "c-0001"]);
});

function historicConnections(done, daysAgo = 1, accountId = 'acc-1', runId = 'previous-run') {
  const date = new Date(MORNING);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  rows.wl_day_actions.push({ id: `history-${++nextId}`, account_id: accountId, run_id: runId,
    kind: 'connect', done, on_date: date.toISOString().slice(0, 10), created_at: date.toISOString() });
}

test('the weekly limit survives a restarted run and cuts the lease, folder and send plan to two', async () => {
  onDay(22);
  spentToday({ profile_view: 99, like: 99 });
  historicConnections(58);
  historicConnections(100, 7);
  historicConnections(100, -1);
  historicConnections(60, 1, 'acc-2');
  inboxReadToday();
  const due = await call({ method: 'GET', path: '/api/warmup/agent/due' });
  assert.equal(due.payload.next.invites, 2);
  const lease = await takeAndAsk();
  assert.equal(lease.payload.lease.invites, 2);
  const plan = await call({ method: 'GET', path: '/api/warmup/agent?accountId=acc-1' });
  assert.equal(plan.payload.weeklyConnections.done, 58);
  assert.equal(plan.payload.invites.toSend.length, 2);
  assert.equal(plan.payload.plan.find((row) => row.kind === 'connect').remaining, 2);
  for (const invite of plan.payload.invites.toSend) {
    const prepared = await call({ method: 'POST', path: '/api/warmup/agent', body: { accountId: 'acc-1', action: 'invite.prepare', outreachId: invite.outreachId } });
    assert.equal(prepared.payload.allowed, true);
    const sent = await call({ method: 'POST', path: '/api/warmup/agent', body: { accountId: 'acc-1', action: 'invite.sent', outreachId: invite.outreachId, outcome: 'sent' } });
    assert.equal(sent.payload.overQuota, false);
  }
  const denied = await call({ method: 'POST', path: '/api/warmup/agent', body: { accountId: 'acc-1', action: 'record', kind: 'connect' } });
  assert.equal(denied.status, 409);
  assert.match(denied.payload.error, /Weekly/);
  const empty = await call({ method: 'GET', path: '/api/warmup/agent?accountId=acc-1' });
  assert.equal(empty.payload.weeklyConnections.done, 60);
  assert.equal(empty.payload.invites.toSend.length, 0);
});

test('a week at 60 forbids new connects but still offers the daily inbox', async () => {
  onDay(22);
  spentToday({ profile_view: 99, like: 99 });
  historicConnections(60);
  const due = await call({ method: 'GET', path: '/api/warmup/agent/due' });
  assert.equal(due.payload.next.invites, 0);
  assert.equal(due.payload.next.upkeep.inbox, true);
  const plan = await call({ method: 'GET', path: '/api/warmup/agent?accountId=acc-1' });
  assert.equal(plan.payload.inbox.due, true);
  assert.deepEqual(plan.payload.invites.toSend, []);
  assert.equal(waitingRows().length, 0);
  inboxReadToday();
  const quiet = await call({ method: 'GET', path: '/api/warmup/agent/due' });
  assert.equal(quiet.payload.next, null);
});

test('a real send outside the allowance counts in the week once, and the oldest date expires', async (t) => {
  onDay(22);
  historicConnections(59, 6);
  rows.wl_events.push({ id: 'overshoot', account_id: 'acc-1', type: 'invite.sent', meta: { overQuota: true }, created_at: MORNING.toISOString() });
  rows.wl_events.push({ id: 'normal', account_id: 'acc-1', type: 'invite.sent', meta: { overQuota: false }, created_at: MORNING.toISOString() });
  const full = await call({ method: 'GET', path: '/api/warmup/agent?accountId=acc-1' });
  assert.equal(full.payload.weeklyConnections.done, 60);
  assert.deepEqual(full.payload.invites.toSend, []);
  t.mock.timers.setTime(MORNING.getTime() + 24 * 60 * 60 * 1000);
  const next = await call({ method: 'GET', path: '/api/warmup/agent?accountId=acc-1' });
  assert.equal(next.payload.weeklyConnections.done, 1);
  assert.ok(next.payload.invites.toSend.length > 0);
});

test('preparing a stale invitation after an operator pause permits no browser action', async () => {
  onDay(22);
  const initial = await call({ method: 'GET', path: '/api/warmup/agent?accountId=acc-1' });
  const invite = initial.payload.invites.toSend[0];
  await call({ method: 'POST', path: '/api/warmup/agent', body: { accountId: 'acc-1', action: 'warning' } });
  const prepared = await call({ method: 'POST', path: '/api/warmup/agent', body: { accountId: 'acc-1', action: 'invite.prepare', outreachId: invite.outreachId } });
  assert.equal(prepared.payload.allowed, false);
  assert.equal(prepared.payload.stopAll, true);
});

test('two concurrent reports cannot both spend the last request of the week', async () => {
  onDay(22);
  historicConnections(59);
  const answers = await Promise.all([1, 2].map(() => call({ method: 'POST', path: '/api/warmup/agent', body: { accountId: 'acc-1', action: 'record', kind: 'connect' } })));
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409]);
  const plan = await call({ method: 'GET', path: '/api/warmup/agent?accountId=acc-1' });
  assert.equal(plan.payload.weeklyConnections.done, 60);
});
