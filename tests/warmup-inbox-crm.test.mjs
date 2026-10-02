import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWarmupApi } from "../warmup/api.mjs";
import { CRM_COPIED, CRM_FAILED, CRM_RETRY_DAYS, outstandingCopies } from "../warmup/activities.mjs";
import { requestLine } from "../warmup/invites.mjs";
import { DEFAULT_STRATEGY } from "../warmup/strategy.mjs";

/**
 * A conversation lands on the person's CRM contact: what we wrote, what they
 * answered, and the request that started it — each once, however many mornings
 * the agent reads the same thread.
 *
 * The bug this file exists for: the CRM got one line per sync, the newest
 * thing they said, and nothing we said. A seller reading the contact saw an
 * answer to a question nobody could see, and a CRM that was down for a morning
 * lost those replies for good. These go through the routes the agent calls,
 * over a stub that plays both databases and honours the filters the write and
 * its retry depend on.
 */

const rows = {};
// What the stub should refuse, as `{ table: { METHOD: status } }`, or
// `{ table: { METHOD: { status, after } } }` to let `after` requests through first.
const refuse = {};
// How long the stub takes over a request, as `{ table: { METHOD: ms } }`.
const slow = {};
// Called with `(method, table, params)` before a request is answered; a GET
// it returns an array for is answered with that array instead.
let onRequest = null;
// The campaigns the routes read.
let campaignList = [];
// What Supabase answers at most to one request, whatever is asked.
const MAX_ROWS = 1000;
let stub;
let previousEnv;
let nextId = 0;

function columnValue(row, column) {
  if (!column.includes("->>")) return row[column];
  const [outer, key] = column.split("->>");
  const holder = row[outer];
  const value = holder && typeof holder === "object" ? holder[key] : undefined;
  return value === null || value === undefined ? value : String(value);
}

/**
 * `ilike` the way it reaches Postgres: PostgREST turns `*` into `%`, and then
 * LIKE reads `%` as any run, `_` as any one character and `\` as the escape.
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

/**
 * PostgREST's list grammar, for `in.(…)`: a quoted element runs to its closing
 * quote with `\` escaping the next character; a bare one runs to the next `,`
 * or `)` — which is how a URN sent bare is cut into pieces that match nothing.
 */
function listValues(list) {
  const values = [];
  let at = 1;
  while (at < list.length) {
    let value = "";
    if (list[at] === "\"") {
      at += 1;
      while (at < list.length && list[at] !== "\"") {
        if (list[at] === "\\") at += 1;
        value += list[at];
        at += 1;
      }
      at += 1;
    } else {
      while (at < list.length && list[at] !== "," && list[at] !== ")") value += list[at++];
    }
    values.push(value);
    if (list[at] === ")") break;
    at += 1;
  }
  return values;
}

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
    } else if (expression.startsWith("ilike.")) {
      if (!ilike(value, expression.slice(6))) return false;
    } else if (expression.startsWith("not.in.(")) {
      if (listValues(expression.slice(7)).includes(String(value))) return false;
    } else if (expression.startsWith("in.(")) {
      if (!listValues(expression.slice(3)).includes(String(value))) return false;
    } else if (expression.startsWith("lt.")) {
      if (value === null || value === undefined || !(String(value) < expression.slice(3))) return false;
    } else if (expression.startsWith("gte.")) {
      if (value === null || value === undefined || !(String(value) >= expression.slice(4))) return false;
    }
  }
  return true;
}

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
  const limit = params.has("limit") ? Number(params.get("limit")) : Infinity;
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
    campaigns: { read: () => campaignList, readTargeting: () => null, write: async () => {}, products: () => [] }
  });
  return captured;
}

test.before(async () => {
  stub = createServer(async (request, response) => {
    const [route, query] = request.url.split("?");
    const table = route.replace("/rest/v1/", "");
    const params = new URLSearchParams(query || "");
    const replaced = await onRequest?.(request.method, table, params);
    if (request.method === "GET" && Array.isArray(replaced)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(replaced));
      return;
    }
    const delay = slow[table]?.[request.method];
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const found = (rows[table] ?? []).filter((row) => matches(row, params));

    const rule = refuse[table]?.[request.method];
    const refused = rule && typeof rule === "object" ? (rule.after-- > 0 ? 0 : rule.status) : rule;
    if (refused) {
      request.resume();
      response.writeHead(refused, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "the CRM is not answering", code: "57014" }));
      return;
    }

    const answer = (payload, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    if (request.method === "GET") return answer(ordered(found, params).slice(0, MAX_ROWS));
    if (request.method === "DELETE") {
      rows[table] = (rows[table] ?? []).filter((row) => !found.includes(row));
      return answer(found);
    }

    let payload = "";
    request.on("data", (chunk) => { payload += chunk; });
    request.on("end", () => {
      const sent = payload ? JSON.parse(payload) : null;
      if (request.method === "POST") {
        // One object or an array of them, the way PostgREST takes a bulk insert
        // — and, as in Postgres, one statement is one moment: every row of a
        // bulk insert shares its `created_at`. Strictly increasing from one
        // statement to the next, so "newest first" means something in a test
        // that writes several inside one millisecond.
        const at = new Date(Date.now() + ++nextId).toISOString();
        const made = (Array.isArray(sent) ? sent : [sent]).map((value) => ({
          id: `row-${++nextId}`,
          created_at: at,
          ...value
        }));
        rows[table] = [...(rows[table] ?? []), ...made];
        return answer(made, 201);
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
  // The CRM is the same stub: `contacts` and `activities` are its tables.
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

function startedForDay(day) {
  const started = new Date();
  started.setUTCDate(started.getUTCDate() - (day - 1));
  started.setUTCHours(0, 0, 0, 0);
  return started.toISOString();
}

function onDay(day) {
  rows.wl_runs = [{
    id: "run-1", account_id: "acc-1", state: "running", started_at: startedForDay(day),
    paused_days: 0, paused_until: null, strategy_snapshot: DEFAULT_STRATEGY
  }];
}

test.beforeEach(() => {
  for (const table of Object.keys(refuse)) delete refuse[table];
  for (const table of Object.keys(slow)) delete slow[table];
  onRequest = null;
  campaignList = [];
  rows.wl_accounts = [{
    id: "acc-1", label: "Chloe Stewart", login: "chloe@example.com",
    profile_remote_id: "profile-1", status: "warming", health: "ok"
  }];
  onDay(12);
  rows.wl_day_actions = [];
  rows.wl_sessions = [];
  rows.wl_events = [];
  rows.wl_outreach = [{
    id: "o-1", account_id: "acc-1", crm_contact_id: "c-1", person_name: "Marta Kovalenko",
    person_company: "Fleetify", person_linkedin: "https://www.linkedin.com/in/marta-kovalenko/",
    sent_by: "chloe@example.com", status: "pending", note: null,
    created_at: "2026-09-10T10:00:00.000Z", responded_at: null
  }];
  rows.contacts = [
    { id: "c-1", name: "Marta Kovalenko", company: "Fleetify", linkedin: "https://www.linkedin.com/in/marta-kovalenko/", created_at: "2026-01-01T00:00:00.000Z" },
    // A prefix of the next one: `ilike` finds both, and only one is her.
    { id: "c-8", name: "Olena Bondar (another)", company: "Other", linkedin: "https://linkedin.com/in/olena-bondar-2", created_at: "2026-01-02T00:00:00.000Z" },
    { id: "c-7", name: "Olena Bondar", company: "Glovo", linkedin: "https://www.linkedin.com/in/Olena-Bondar/?trk=x", created_at: "2026-01-03T00:00:00.000Z" }
  ];
  rows.activities = [];
});

const events = (type) => rows.wl_events.filter((row) => row.type === type);

function thread(messages, participant = { name: "Marta Kovalenko", slug: "marta-kovalenko" }, threadKey = "t-marta") {
  return call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "inbox.thread", accountId: "acc-1", threadKey, participant, messages }
  });
}

const OURS = { externalId: "m-1", direction: "out", body: "Дякую, що прийняли запит!", sentAt: "2026-09-20T09:00:00.000Z" };
const THEIRS = { externalId: "m-2", direction: "in", body: "Привіт! Розкажіть більше.", sentAt: "2026-09-20T11:30:00.000Z" };
const THEIRS_AGAIN = { externalId: "m-3", direction: "in", body: "І ще: яка ціна?", sentAt: "2026-09-21T08:15:00.000Z" };

test("both sides of a conversation reach the contact, each message once however often it is read", async () => {
  // The agent posts newest first; the CRM must still read oldest first.
  const first = await thread([THEIRS, OURS]);
  assert.equal(first.status, 200);
  assert.equal(first.payload.stored, 2);
  assert.equal(first.payload.crm, "written");
  assert.equal(first.payload.crmWritten, 2);
  assert.equal(first.payload.matchedBy, "outreach");
  assert.equal(first.payload.statusMoved, true, "their answer still moves the approach on");

  assert.equal(rows.activities.length, 2);
  assert.ok(rows.activities.every((row) => row.contact_id === "c-1" && row.type === "linkedin"));
  assert.match(rows.activities[0].content, /Ми написали з акаунта chloe@example\.com · 2026-09-20 09:00 UTC\nДякую, що прийняли запит!/);
  assert.match(rows.activities[1].content, /Відповідь на акаунт chloe@example\.com · 2026-09-20 11:30 UTC\nПривіт! Розкажіть більше\./);

  // Tomorrow the agent reads the same thread again, with one new message in it.
  const second = await thread([THEIRS_AGAIN, THEIRS, OURS]);
  assert.equal(second.payload.stored, 1);
  assert.equal(second.payload.skipped, 2);
  assert.equal(rows.activities.length, 3, "the two already copied are not copied again");
  assert.match(rows.activities[2].content, /І ще: яка ціна\?/);

  // And a third read with nothing new writes nothing at all.
  const third = await thread([THEIRS_AGAIN, THEIRS, OURS]);
  assert.equal(third.payload.crm, "skipped");
  const done = await call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.done", accountId: "acc-1", threadsSeen: 1 } });
  assert.equal(done.payload.crmRetried.owed, 0);
  assert.equal(rows.activities.length, 3);

  // The markers say which rows went, and stay out of the account's log.
  assert.deepEqual(events(CRM_COPIED).flatMap((row) => row.meta.eventIds).length, 3);
  const log = await call({ method: "GET", path: "/api/warmup/events?accountId=acc-1" });
  assert.equal(log.payload.events.filter((row) => row.type === CRM_COPIED).length, 0);
});

test("somebody this account never approached is found by the LinkedIn link on their contact", async () => {
  const answer = await thread(
    [{ externalId: "o-in-1", direction: "in", body: "Бачила ваш профіль — поговоримо?", sentAt: "2026-09-22T10:00:00.000Z" }],
    { name: "Olena Bondar", slug: "https://www.linkedin.com/in/olena-bondar" },
    "t-olena"
  );
  assert.equal(answer.payload.matchedOutreachId, null, "no approach of this account's");
  assert.equal(answer.payload.matchedBy, "linkedin");
  assert.equal(answer.payload.crmContactId, "c-7", "the same profile, not the one whose slug merely starts the same");
  assert.equal(answer.payload.statusMoved, false, "there is no approach to move");
  assert.deepEqual(rows.activities.map((row) => row.contact_id), ["c-7"]);

  // The person key is on the stored message, so her history has it too —
  // with nobody's approach on record to lead there.
  const stored = events("message.in").find((row) => row.meta.externalId === "o-in-1");
  assert.equal(stored.meta.crmContactId, "c-7");
  const history = await call({ method: "GET", path: "/api/warmup/history?crmContactId=c-7" });
  assert.equal(history.payload.entries.length, 1);
  assert.equal(history.payload.entries[0].matchedBy, "contact_id");
  assert.equal(history.payload.entries[0].accountLabel, "chloe@example.com");

  // A name alone is never enough, and neither is a company page.
  rows.activities = [];
  await thread([{ externalId: "x-1", direction: "in", body: "hi", sentAt: "2026-09-22T11:00:00.000Z" }],
    { name: "Olena Bondar", slug: null }, "t-name-only");
  await thread([{ externalId: "x-2", direction: "in", body: "hi", sentAt: "2026-09-22T11:00:00.000Z" }],
    { name: "Glovo", slug: "https://www.linkedin.com/company/olena-bondar" }, "t-company");
  assert.equal(rows.activities.length, 0);
});

test("a thread read again after its time labels aged is not copied to the contact again", async () => {
  // No ids from the agent and only LinkedIn's labels for time, so every id is
  // a hash over a label — and tomorrow's labels are not today's.
  const first = await thread([
    { direction: "out", body: "Добрий день! Дякую за контакт.", sentAt: "10:42 AM" },
    { direction: "in", body: "Привіт, що пропонуєте?", sentAt: "11:05 AM" }
  ]);
  assert.equal(first.payload.stored, 2);
  assert.equal(rows.activities.length, 2);

  const next = await thread([
    { direction: "out", body: "Добрий день! Дякую за контакт.", sentAt: "Sep 24" },
    { direction: "in", body: "Привіт, що пропонуєте?", sentAt: "Sep 24" },
    { direction: "in", body: "І скільки це коштує?", sentAt: "9:00 AM" }
  ]);
  assert.equal(next.payload.stored, 1, "only the message that is new");
  assert.equal(next.payload.repeated, 2, "the two that came back under new ids");
  assert.equal(rows.activities.length, 3);
  assert.match(rows.activities[2].content, /І скільки це коштує\?/);
  assert.equal(events("message.in").length + events("message.out").length, 3, "stored once each, too");
  // "Sep 24" is a label with no year, not a reading from 2001.
  assert.ok(rows.activities.every((row) => !/2001/.test(row.content)));
});

test("a short slug finds its own contact behind a page of longer ones that start the same", async () => {
  // Sixty contacts whose links start with hers, every one older than hers: a
  // prefix search capped at a page of candidates never reached her.
  for (let n = 0; n < 60; n += 1) {
    rows.contacts.push({
      id: `c-prefix-${n}`, name: `Olena Bondar ${n}`, company: "Other",
      linkedin: `https://www.linkedin.com/in/olena-bondar-${n}`, created_at: `2025-01-01T00:00:${String(n).padStart(2, "0")}.000Z`
    });
  }
  const answer = await thread(
    [{ externalId: "short-1", direction: "in", body: "Так", sentAt: "2026-09-22T10:00:00.000Z" }],
    { name: "Olena Bondar", slug: "olena-bondar" },
    "t-olena-short"
  );
  assert.equal(answer.payload.crmContactId, "c-7");
  assert.deepEqual(rows.activities.map((row) => row.contact_id), ["c-7"]);
});

test("a copy the CRM refused is owed, and made on the next sync — once", async () => {
  refuse.activities = { POST: 503 };
  const first = await thread([THEIRS, OURS]);
  assert.equal(first.payload.stored, 2, "the messages are stored whatever the CRM says");
  assert.equal(first.payload.crm, "failed");
  assert.equal(rows.activities.length, 0);

  const failed = events(CRM_FAILED);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, "warn");
  assert.equal(failed[0].meta.owed.length, 2);
  assert.doesNotMatch(JSON.stringify(failed[0]), /Розкажіть/, "the warning is shown in the account's log; the message is private");

  // Still down when the sync ends: tried, and owed again from the first failure.
  const stillDown = await call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.done", accountId: "acc-1", threadsSeen: 1 } });
  assert.equal(stillDown.payload.crmRetried.failed, 2);
  assert.equal(events(CRM_FAILED).at(-1).meta.owed[0].since, failed[0].meta.owed[0].since);

  // Next morning the CRM is back. The thread has nothing new in it, and the
  // copy is made anyway — by the sync, not by the thread.
  delete refuse.activities;
  const again = await thread([THEIRS, OURS]);
  assert.equal(again.payload.stored, 0);
  const done = await call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.done", accountId: "acc-1", threadsSeen: 1 } });
  assert.equal(done.payload.crmRetried.written, 2);
  assert.equal(rows.activities.length, 2);
  assert.match(rows.activities[0].content, /Ми написали/, "still oldest first");

  // And never again.
  const later = await call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.done", accountId: "acc-1", threadsSeen: 0 } });
  assert.equal(later.payload.crmRetried.owed, 0);
  assert.equal(rows.activities.length, 2);
});

test("a CRM that cannot say who somebody is costs the copy a day, not the message", async () => {
  refuse.contacts = { GET: 503 };
  const answer = await thread(
    [{ externalId: "o-in-2", direction: "in", body: "Так, цікаво", sentAt: "2026-09-22T10:00:00.000Z" }],
    { name: "Olena Bondar", slug: "olena-bondar" },
    "t-olena"
  );
  assert.equal(answer.payload.stored, 1);
  assert.equal(answer.payload.crm, "failed");

  delete refuse.contacts;
  await call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.done", accountId: "acc-1", threadsSeen: 1 } });
  assert.deepEqual(rows.activities.map((row) => row.contact_id), ["c-7"], "asked again, and found");

  // The stored row still carries no key — rows are not rewritten — and her
  // card has no approach to lead there. The copy's marker names her, and that
  // is enough: the card shows what the CRM shows.
  assert.equal(events("message.in")[0].meta.crmContactId, null);
  const history = await call({ method: "GET", path: "/api/warmup/history?crmContactId=c-7" });
  assert.deepEqual(history.payload.entries.map((entry) => entry.body), ["Так, цікаво"]);
  assert.equal(history.payload.entries[0].matchedBy, "contact_id");
  assert.equal(history.payload.empty, false);
});

test("a failure older than the retry window is left in the log, not retried forever", async () => {
  const now = new Date();
  const long = new Date(now.getTime() - (CRM_RETRY_DAYS + 1) * 86_400_000).toISOString();
  const recent = new Date(now.getTime() - 86_400_000).toISOString();
  rows.wl_events = [
    { id: "f-old", account_id: "acc-1", type: CRM_FAILED, created_at: long, meta: { contactId: "c-1", owed: [{ eventId: "e-old", since: long }] } },
    // Failed again yesterday, but first failed a week and more ago.
    { id: "f-again", account_id: "acc-1", type: CRM_FAILED, created_at: recent, meta: { contactId: "c-1", owed: [{ eventId: "e-old", since: long }] } },
    { id: "f-new", account_id: "acc-1", type: CRM_FAILED, created_at: recent, meta: { contactId: "c-1", owed: [{ eventId: "e-new", since: recent }, { eventId: "e-done", since: recent }] } },
    { id: "k-1", account_id: "acc-1", type: CRM_COPIED, created_at: recent, meta: { contactId: "c-1", eventIds: ["e-done"] } },
    // Written before rows were named: nothing in it to copy again.
    { id: "f-legacy", account_id: "acc-1", type: CRM_FAILED, created_at: recent, meta: { contactId: "c-1" } }
  ];
  const owed = await outstandingCopies("acc-1", now);
  assert.deepEqual(owed.map((item) => item.eventId), ["e-new"]);
});

test("a request that went out lands on the contact once, with the note it really carried", async () => {
  rows.wl_outreach = [];
  const queued = await call({
    method: "POST", path: "/api/warmup/invites",
    body: { accountId: "acc-1", crmContactId: "c-1", note: "Раді знайомству" }
  });
  assert.equal(queued.status, 200);
  const outreachId = rows.wl_outreach[0].id;
  assert.equal(rows.activities.length, 0, "a request asked for is not a request sent");

  const sent = await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "sent" }
  });
  assert.equal(sent.status, 200);
  assert.equal(rows.activities.length, 1);
  assert.equal(rows.activities[0].contact_id, "c-1");
  assert.match(rows.activities[0].content, /Запит на контакт надіслано з акаунта chloe@example\.com \(агентом\)/);
  assert.match(rows.activities[0].content, /Записка: Раді знайомству/, "day 12 lets three words through");

  // Reported twice: the row has moved, so nothing is written twice.
  await call({ method: "POST", path: "/api/warmup/agent", body: { action: "invite.sent", accountId: "acc-1", outreachId, outcome: "sent" } });
  assert.equal(rows.activities.length, 1);
});

test("on a no-notes day the CRM says the request went bare, and a seller's own send says nothing it cannot know", async () => {
  onDay(8);
  rows.wl_outreach = [];
  await call({ method: "POST", path: "/api/warmup/invites", body: { accountId: "acc-1", crmContactId: "c-1", note: "Раді знайомству" } });
  await call({
    method: "POST", path: "/api/warmup/agent",
    body: { action: "invite.sent", accountId: "acc-1", outreachId: rows.wl_outreach[0].id, outcome: "sent" }
  });
  assert.match(rows.activities[0].content, /Без записки\./);

  // A seller who sent it from their own browser: nobody here saw the note.
  const line = requestLine({ type: "invite.sent", created_at: "2026-09-22T10:00:00.000Z", meta: { by: "seller" } }, "chloe@example.com");
  assert.match(line, /\(вручну\) · 2026-09-22 10:00 UTC$/);
  assert.doesNotMatch(line, /записк/i);
});

test("the inbox is due once a day, and not after the agent says it is done", async () => {
  const before = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(before.payload.inbox.due, true, "not read today");
  assert.equal(before.payload.inbox.maxThreads, 20);
  assert.equal(before.payload.upkeep.inbox, true, "the same answer the scheduler wakes it by");

  await call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.done", accountId: "acc-1", threadsSeen: 0 } });
  const after = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(after.payload.inbox.due, false, "read today");
  assert.ok(after.payload.inbox.lastSyncedAt);

  // Working mode reads it too.
  onDay(30);
  rows.wl_events = [];
  const working = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(working.payload.mode, "working");
  assert.equal(working.payload.inbox.due, true);

  // And a pause is nothing at all.
  rows.wl_runs[0] = { ...rows.wl_runs[0], state: "paused", paused_until: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) };
  const paused = await call({ method: "GET", path: "/api/warmup/agent?accountId=acc-1" });
  assert.equal(paused.payload.inbox.due, false);
  assert.equal(paused.payload.inbox.maxThreads, 0);
});

// ── ids, order and who a line belongs to ─────────────────────────────────

const done = () => call({ method: "POST", path: "/api/warmup/agent", body: { action: "inbox.done", accountId: "acc-1", threadsSeen: 1 } });
const bodies = () => rows.activities.map((row) => row.content.split("\n").slice(1).join("\n"));
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** LinkedIn's label for a day this many days back, as the agent's screen shows it: "Sep 20". */
function dayLabel(daysAgo) {
  const day = new Date();
  day.setDate(day.getDate() - daysAgo);
  return `${MONTH_NAMES[day.getMonth()]} ${day.getDate()}`;
}

test("a LinkedIn message URN is an id like any other: the thread read again stores and copies nothing", async () => {
  // A comma and brackets inside the id. Sent bare in `in.(…)`, it was cut in
  // two, matched nothing, and every re-read stored and copied the thread again.
  const ours = { externalId: "urn:li:msg_message:(urn:li:fsd_profile:ACoAAB1,2-MTcwOTk=)", direction: "out", body: "Добрий день!", sentAt: "2026-09-20T09:00:00.000Z" };
  const theirs = { externalId: "urn:li:msg_message:(urn:li:fsd_profile:ACoAAB1,2-MTcxOD==)", direction: "in", body: "Вітаю \"колего\", так", sentAt: "2026-09-20T11:00:00.000Z" };
  const first = await thread([ours, theirs]);
  assert.equal(first.payload.stored, 2);
  assert.equal(first.payload.crmWritten, 2);

  const again = await thread([ours, theirs]);
  assert.equal(again.payload.stored, 0);
  assert.equal(again.payload.skipped, 2);
  assert.equal(again.payload.repeated, 0, "recognised by its id, not rescued by the content check");
  assert.equal(rows.activities.length, 2);
  assert.equal(events("message.in").length + events("message.out").length, 2);
});

test("a namesake with a different profile is not the person this account approached", async () => {
  const answer = await thread(
    [
      { externalId: "n-1", direction: "out", body: "Привіт, Марто!", sentAt: "2026-09-20T09:00:00.000Z" },
      { externalId: "n-2", direction: "in", body: "Ви мене з кимось плутаєте", sentAt: "2026-09-20T10:00:00.000Z" }
    ],
    { name: "Marta Kovalenko", slug: "marta-kovalenko-4a7b9" },
    "t-namesake"
  );
  assert.equal(answer.payload.matchedOutreachId, null, "two known profiles that differ are two people");
  assert.equal(answer.payload.statusMoved, false);
  assert.equal(rows.wl_outreach[0].status, "pending");
  assert.equal(rows.activities.length, 0, "nothing of theirs on Marta's contact");
});

test("an inbox.done sent twice at once copies what was owed once", async () => {
  refuse.activities = { POST: 503 };
  await thread([THEIRS, OURS]);
  delete refuse.activities;

  // A slow CRM, and an agent that gave up waiting and asked again.
  slow.activities = { POST: 40 };
  const [one, two] = await Promise.all([done(), done()]);
  assert.equal(rows.activities.length, 2, "each owed line once");
  assert.equal(one.payload.crmRetried.written + two.payload.crmRetried.written, 2);
  assert.deepEqual(bodies(), [OURS.body, THEIRS.body]);
});

test("a line somebody else copied after it was read as owed is not written again", async () => {
  refuse.activities = { POST: 503 };
  await thread([OURS]);
  delete refuse.activities;
  const owedId = events("message.out")[0].id;

  // Another server copies it while this one is between reading what is owed
  // and writing it: its marker lands as this one reads the rows to copy.
  let copiedElsewhere = false;
  onRequest = (method, table, params) => {
    if (copiedElsewhere || method !== "GET" || table !== "wl_events" || !params.get("id")?.startsWith("in.(")) return;
    copiedElsewhere = true;
    rows.wl_events.push({
      id: `row-${++nextId}`, account_id: "acc-1", level: "info", type: CRM_COPIED,
      created_at: new Date(Date.now() + nextId).toISOString(), meta: { contactId: "c-1", eventIds: [owedId] }
    });
  };
  const retried = await done();
  assert.ok(copiedElsewhere, "the retry read the owed row back");
  assert.equal(retried.payload.crmRetried.owed, 1);
  assert.equal(retried.payload.crmRetried.written, 0);
  assert.equal(rows.activities.length, 0, "looked up again right before the insert, and found copied");
  assert.equal((await done()).payload.crmRetried.owed, 0, "and not owed any more");
});

test("a reply from somebody past the first thousand approaches still finds their approach", async () => {
  // Working mode sends every day; a thousand rows is a few months of it, and
  // one read answers no more than that.
  rows.wl_outreach = [];
  for (let n = 0; n < 1300; n += 1) {
    rows.wl_outreach.push({
      id: `o-bulk-${n}`, account_id: "acc-1", crm_contact_id: `c-bulk-${n}`, person_name: `Person ${n}`,
      person_linkedin: `https://www.linkedin.com/in/person-${n}`, status: "pending",
      created_at: new Date(Date.UTC(2026, 8, 20) - n * 60_000).toISOString(), responded_at: null
    });
  }
  // The oldest of them, and the last the table hands back.
  rows.wl_outreach.push({
    id: "o-anna", account_id: "acc-1", crm_contact_id: "c-anna", person_name: "Anna Shevchenko",
    person_linkedin: "https://www.linkedin.com/in/anna-shevchenko", status: "pending",
    created_at: "2026-01-02T00:00:00.000Z", responded_at: null
  });

  const answer = await thread(
    [{ externalId: "a-1", direction: "in", body: "Так, давайте поговоримо", sentAt: "2026-09-22T10:00:00.000Z" }],
    { name: "Anna Shevchenko", slug: "anna-shevchenko" },
    "t-anna"
  );
  assert.equal(answer.payload.matchedOutreachId, "o-anna");
  assert.equal(answer.payload.statusMoved, true);
  assert.equal(rows.wl_outreach.find((row) => row.id === "o-anna").status, "connected");
  assert.deepEqual(rows.activities.map((row) => row.contact_id), ["c-anna"]);

  // And the inbox list says the same about her thread.
  const inbox = await call({ method: "GET", path: "/api/warmup/inbox?accountId=acc-1" });
  const listed = inbox.payload.threads.find((row) => row.threadKey === "t-anna");
  assert.equal(listed.outreachStatus, "connected");
  assert.equal(listed.crmContactId, "c-anna");
});

test("a thread first stored with nobody to tie it to is copied whole once it is", async () => {
  // Read first while LinkedIn would not name her: stored, tied to nobody.
  const pitch = { externalId: "p-1", direction: "out", body: "Наша пропозиція", sentAt: "2026-09-20T09:00:00.000Z" };
  const first = await thread([pitch], { name: "LinkedIn Member", slug: null }, "t-later");
  assert.equal(first.payload.crmContactId, null);
  assert.equal(first.payload.crm, "skipped");

  // A message from before the copy existed: no key, and not waiting for one.
  rows.wl_events.push({
    id: "legacy-row", account_id: "acc-1", level: "info", type: "message.in", created_at: "2026-09-01T00:00:00.000Z",
    meta: { threadKey: "t-later", crmContactId: null, externalId: "legacy-1", direction: "in", body: "Старе повідомлення",
      sentAt: "2026-09-01T00:00:00.000Z", sentAtGiven: true, sentAtRaw: null, participant: { name: "Unknown", slug: null } }
  });

  // Next day the thread has her name and her link, and her answer.
  const reply = { externalId: "p-2", direction: "in", body: "Цікаво, розкажіть", sentAt: "2026-09-21T09:00:00.000Z" };
  const second = await thread([pitch, reply], { name: "Olena Bondar", slug: "olena-bondar" }, "t-later");
  assert.equal(second.payload.crmContactId, "c-7");
  assert.equal(second.payload.crmWritten, 2, "the answer, and the message it answers");
  assert.deepEqual(bodies(), [pitch.body, reply.body], "in the conversation's order");
  assert.ok(rows.activities.every((row) => row.contact_id === "c-7"));
  assert.equal((await done()).payload.crmRetried.owed, 0);

  // Once: the next message copies only itself.
  const more = { externalId: "p-3", direction: "in", body: "Коли зручно?", sentAt: "2026-09-22T09:00:00.000Z" };
  const third = await thread([pitch, reply, more], { name: "Olena Bondar", slug: "olena-bondar" }, "t-later");
  assert.equal(third.payload.crmWritten, 1);
  assert.deepEqual(bodies(), [pitch.body, reply.body, more.body]);
  assert.ok(!bodies().includes("Старе повідомлення"), "history from before the copy existed is not backfilled");

  // Her card shows the message stored before anyone knew it was hers.
  const history = await call({ method: "GET", path: "/api/warmup/history?crmContactId=c-7" });
  assert.deepEqual(history.payload.entries.map((entry) => entry.body).sort(), [pitch.body, reply.body, more.body].sort());
});

test("a thread with only time labels reaches the CRM in the order the agent posted it", async () => {
  // Oldest first, as asked, and not one real time: ours two afternoons ago,
  // their answer the next morning, our reply this morning. Every message is
  // stored as the moment it was read, so the order they came in is all that
  // says which came first — and "3:00 PM" before "10:00 AM" is not a reason
  // to turn it round.
  const posted = await thread([
    { externalId: "l-1", direction: "out", body: "1 — наше повідомлення", sentAt: "3:00 PM" },
    { externalId: "l-2", direction: "in", body: "2 — їхня відповідь", sentAt: "10:00 AM" },
    { externalId: "l-3", direction: "out", body: "3 — наша відповідь", sentAt: "9:30 AM" }
  ], { name: "Marta Kovalenko", slug: "marta-kovalenko" }, "t-labels");
  assert.equal(posted.payload.crmWritten, 3);
  assert.deepEqual(bodies(), ["1 — наше повідомлення", "2 — їхня відповідь", "3 — наша відповідь"]);
  // Stored together, they share one moment; each keeps its place for a later copy.
  const places = new Map([...events("message.in"), ...events("message.out")].map((row) => [row.meta.body, row.meta.position]));
  assert.deepEqual(["1 — наше повідомлення", "2 — їхня відповідь", "3 — наша відповідь"].map((body) => places.get(body)), [0, 1, 2]);

  // Oldest first, as asked, with one real time among the labels: the label
  // before it stays before it.
  rows.activities = [];
  const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  await thread([
    { externalId: "k-1", direction: "in", body: "a — перша", sentAt: dayLabel(5) },
    { externalId: "k-2", direction: "out", body: "b — наша", sentAt: daysAgo(3) },
    { externalId: "k-3", direction: "in", body: "c — остання", sentAt: "11:05 AM" }
  ], { name: "Marta Kovalenko", slug: "marta-kovalenko" }, "t-mixed");
  assert.deepEqual(bodies(), ["a — перша", "b — наша", "c — остання"]);

  // Newest first is told by real times, and only by them: turned round, with
  // the label between them kept between them.
  rows.activities = [];
  await thread([
    { externalId: "n-3", direction: "in", body: "z — остання", sentAt: daysAgo(1) },
    { externalId: "n-2", direction: "out", body: "y — наша", sentAt: dayLabel(3) },
    { externalId: "n-1", direction: "in", body: "x — перша", sentAt: daysAgo(5) }
  ], { name: "Marta Kovalenko", slug: "marta-kovalenko" }, "t-reversed");
  assert.deepEqual(bodies(), ["x — перша", "y — наша", "z — остання"]);
});

test("the thread screen and the inbox list show a thread in the order the CRM has it", async () => {
  const threadOf = (threadKey) => call({ method: "GET", path: `/api/warmup/inbox/thread?accountId=acc-1&threadKey=${threadKey}` });
  const listed = async (threadKey) => (await call({ method: "GET", path: "/api/warmup/inbox?accountId=acc-1" }))
    .payload.threads.find((row) => row.threadKey === threadKey);

  // Posted oldest first from a day-first page: 12 September, then 3 October.
  // `Date.parse` reads the labels as 9 December and 10 March — stored as
  // times, and still only labels.
  const posted = await thread([
    { externalId: "d-1", direction: "out", body: "Радий знайомству", sentAt: "12/9/2025" },
    { externalId: "d-2", direction: "in", body: "Дякую, навзаєм", sentAt: "3/10/2025" }
  ], { name: "Marta Kovalenko", slug: "marta-kovalenko" }, "t-numeric");
  assert.equal(posted.status, 200);
  assert.deepEqual(bodies(), ["Радий знайомству", "Дякую, навзаєм"]);
  const numeric = await threadOf("t-numeric");
  assert.equal(numeric.status, 200);
  assert.deepEqual(numeric.payload.messages.map((message) => message.body), ["Радий знайомству", "Дякую, навзаєм"],
    "the answer after the message it answers, as posted");
  assert.equal(numeric.payload.thread.lastMessage.body, "Дякую, навзаєм");
  assert.equal((await listed("t-numeric")).lastMessage.body, "Дякую, навзаєм");

  // Real times still decide between themselves: an older message a later read
  // found further up goes where it was sent, not after what was stored first.
  const answer = { externalId: "r-2", direction: "in", body: "Так, цікаво", sentAt: "2025-10-03T09:00:00.000Z" };
  await thread([answer], { name: "Marta Kovalenko", slug: "marta-kovalenko" }, "t-real");
  await thread([
    { externalId: "r-1", direction: "out", body: "Наша пропозиція", sentAt: "2025-09-12T09:00:00.000Z" }, answer
  ], { name: "Marta Kovalenko", slug: "marta-kovalenko" }, "t-real");
  assert.deepEqual((await threadOf("t-real")).payload.messages.map((message) => message.body), ["Наша пропозиція", "Так, цікаво"]);
  assert.equal((await listed("t-real")).lastMessage.body, "Так, цікаво");

  // Rows stored before the portal said which times are real keep the order
  // they were stored in.
  const legacy = (id, body, sentAt, createdAt) => ({
    id, account_id: "acc-1", level: "info", type: "message.in", created_at: createdAt,
    meta: { threadKey: "t-legacy", crmContactId: null, externalId: id, direction: "in", body, sentAt,
      sentAtGiven: true, sentAtRaw: null, participant: { name: "Marta Kovalenko", slug: "marta-kovalenko" } }
  });
  rows.wl_events.push(
    legacy("legacy-1", "перше", "2025-12-08T23:00:00.000Z", "2026-09-01T10:00:00.000Z"),
    legacy("legacy-2", "друге", "2025-03-09T23:00:00.000Z", "2026-09-02T10:00:00.000Z")
  );
  assert.deepEqual((await threadOf("t-legacy")).payload.messages.map((message) => message.body), ["перше", "друге"]);
  assert.equal((await listed("t-legacy")).lastMessage.body, "друге");
});

test("after an outage a contact's owed lines go before the new one, not after it", async () => {
  refuse.activities = { POST: 503 };
  await thread([THEIRS, OURS]);
  await done();
  assert.equal(rows.activities.length, 0);

  // Next morning the CRM is back and she has written again.
  delete refuse.activities;
  const next = await thread([THEIRS_AGAIN, THEIRS, OURS]);
  assert.equal(next.payload.crmWritten, 3, "what was owed, then what is new");
  assert.deepEqual(bodies(), [OURS.body, THEIRS.body, THEIRS_AGAIN.body]);
  assert.equal((await done()).payload.crmRetried.owed, 0);
  assert.equal(rows.activities.length, 3);
});

test("a copy that failed halfway through a thread is finished in order", async () => {
  const lines = [1, 2, 3, 4].map((n) => ({
    externalId: `h-${n}`, direction: n % 2 ? "in" : "out", body: `рядок ${n}`, sentAt: `2026-09-2${n}T09:00:00.000Z`
  }));
  // The first line lands; the CRM refuses the second, and so the rest wait.
  refuse.activities = { POST: { status: 503, after: 1 } };
  const first = await thread(lines.slice(0, 3));
  assert.equal(first.payload.crmWritten, 1);
  assert.equal(first.payload.crm, "failed");

  delete refuse.activities;
  await thread(lines);
  assert.deepEqual(bodies(), ["рядок 1", "рядок 2", "рядок 3", "рядок 4"]);
});

test("a person the CRM holds twice gets the line on the record this workspace is working", async () => {
  rows.contacts.push(
    { id: "c-old", name: "Ivan Petrenko", linkedin: "https://www.linkedin.com/in/ivan-petrenko", folder_id: "folder-old", created_at: "2024-01-01T00:00:00.000Z" },
    { id: "c-new", name: "Ivan Petrenko", linkedin: "https://linkedin.com/in/Ivan-Petrenko/", folder_id: "folder-new", created_at: "2026-09-01T00:00:00.000Z" }
  );
  const ivan = { name: "Ivan Petrenko", slug: "ivan-petrenko" };
  const write = (key) => thread([{ externalId: `iv-${key}`, direction: "in", body: `Привіт (${key})`, sentAt: "2026-09-22T10:00:00.000Z" }], ivan, `t-ivan-${key}`);

  // Nobody works either record: the older.
  assert.equal((await write("plain")).payload.crmContactId, "c-old");

  // A running campaign's folder holds the newer one.
  campaignList = [{ id: "camp-1", name: "LinkedIn", folderId: "folder-new", accountIds: ["acc-2"], state: "running" }];
  assert.equal((await write("folder")).payload.crmContactId, "c-new");

  // Another login approached the newer one, while a campaign holds the older:
  // an approach is the strongest claim there is.
  campaignList = [{ id: "camp-2", name: "Old", folderId: "folder-old", accountIds: ["acc-2"], state: "running" }];
  rows.wl_outreach.push({
    id: "o-2", account_id: "acc-2", crm_contact_id: "c-new", person_name: "Ivan Petrenko",
    person_linkedin: "https://www.linkedin.com/in/ivan-petrenko", status: "pending", created_at: "2026-09-10T00:00:00.000Z"
  });
  assert.equal((await write("approached")).payload.crmContactId, "c-new");
  const history = await call({ method: "GET", path: "/api/warmup/history?crmContactId=c-new" });
  assert.ok(history.payload.entries.some((entry) => entry.body === "Привіт (approached)"));
});

test("a message stored before the portal knew LinkedIn's year labels is not stored again when the label gains a year", async () => {
  // What the old code stored for "Sep 20": taken as given, in 2001.
  const day = new Date(Date.now() - 5 * 86_400_000);
  rows.wl_events.push({
    id: "legacy-2001", account_id: "acc-1", level: "info", type: "message.in",
    created_at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    meta: { threadKey: "t-marta", crmContactId: "c-1", externalId: "hash-old", direction: "in", body: "Так, цікаво",
      sentAt: new Date(2001, day.getMonth(), day.getDate()).toISOString(), sentAtGiven: true, sentAtRaw: null,
      participant: { name: "Marta Kovalenko", slug: "marta-kovalenko" } }
  });
  // The same message, its label now carrying the year, hashed afresh.
  const answer = await thread([{ externalId: "hash-new", direction: "in", body: "Так, цікаво", sentAt: `${dayLabel(5)}, ${day.getFullYear()}` }]);
  assert.equal(answer.payload.stored, 0);
  assert.equal(answer.payload.repeated, 1, "a 2001 on a stored row is a label, not a reading");
  assert.equal(rows.activities.length, 0);
});

test("a Cyrillic profile link, percent-encoded in the CRM, is found behind links that only resemble it", async () => {
  const encoded = encodeURIComponent("анна");
  // Older links whose encoding holds hers as a pattern with gaps: `%` in an
  // unescaped LIKE is any run, and a page of these pushed her off the end.
  for (let n = 0; n < 60; n += 1) {
    rows.contacts.push({
      id: `c-look-${n}`, name: `Анна ${n}`, created_at: `2025-02-01T00:${String(n).padStart(2, "0")}:00.000Z`,
      linkedin: `https://www.linkedin.com/in/${encoded}-${n}${encodeURIComponent("а")}/`
    });
  }
  rows.contacts.push({ id: "c-anna-cyr", name: "Анна", linkedin: `https://www.linkedin.com/in/${encoded}/`, created_at: "2026-05-01T00:00:00.000Z" });

  const answer = await thread(
    [{ externalId: "cyr-1", direction: "in", body: "Добрий день", sentAt: "2026-09-22T10:00:00.000Z" }],
    { name: "Анна", slug: `https://www.linkedin.com/in/${encoded}/` },
    "t-anna-cyr"
  );
  assert.equal(answer.payload.crmContactId, "c-anna-cyr");
  assert.deepEqual(rows.activities.map((row) => row.contact_id), ["c-anna-cyr"]);
});

test("owed lines are written in the thread's order, whatever order they came to be owed in", async () => {
  // Two messages stored together, each owed by its own failure — the later
  // one first. Only their place in the thread says which came first.
  const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const later = new Date(Date.now() - 86_400_000).toISOString();
  const label = (body, position) => ({
    threadKey: "t-marta", crmContactId: "c-1", awaitsContact: false, position, externalId: `lab-${position}`,
    direction: "in", body, sentAt: at, sentAtGiven: false, sentAtRaw: "Mon", participant: { name: "Marta Kovalenko", slug: "marta-kovalenko" }
  });
  rows.wl_events.push(
    { id: "ev-b", account_id: "acc-1", level: "info", type: "message.in", created_at: at, meta: label("перше", 0) },
    { id: "ev-a", account_id: "acc-1", level: "info", type: "message.in", created_at: at, meta: label("друге", 1) },
    { id: "f-1", account_id: "acc-1", level: "warn", type: CRM_FAILED, created_at: later, meta: { contactId: "c-1", owed: [{ eventId: "ev-a", since: later }] } },
    { id: "f-2", account_id: "acc-1", level: "warn", type: CRM_FAILED, created_at: new Date(Date.parse(later) + 1000).toISOString(), meta: { contactId: "c-1", owed: [{ eventId: "ev-b", since: later }] } }
  );
  const retried = await done();
  assert.equal(retried.payload.crmRetried.written, 2);
  assert.deepEqual(bodies(), ["перше", "друге"]);
});

test("a message the id check could not find is still recognised by what it says", async () => {
  await thread([THEIRS, OURS]);
  assert.equal(rows.activities.length, 2);
  // The id read comes back empty — a list the server cut, a page it dropped.
  onRequest = (method, table, params) => (method === "GET" && table === "wl_events" && params.has("meta->>externalId") ? [] : undefined);
  const again = await thread([THEIRS, OURS]);
  assert.equal(again.payload.stored, 0);
  assert.equal(again.payload.repeated, 2, "the stored rows are still there to be matched by content");
  assert.equal(rows.activities.length, 2);
});
