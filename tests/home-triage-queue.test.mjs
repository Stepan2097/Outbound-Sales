import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { nextContact } from "../triage/queue.mjs";

/**
 * Головна (власник 12.10): «вибираю папку і отримую послідовність контактів
 * (до яких ніхто ще не писав)… впершу чергу показувати людей які вже є в
 * друзях лінкедин акаунтів».
 */

const FOLDER = "11111111-1111-4111-8111-111111111111";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rows = {};
let stub;
let previous;

function matches(row, params) {
  for (const [column, expression] of params.entries()) {
    if (["select", "limit", "offset", "order"].includes(column)) continue;
    const value = column.includes("->>") ? (row[column.split("->>")[0]] || {})[column.split("->>")[1]] : row[column];
    if (expression.startsWith("eq.") && String(value) !== expression.slice(3)) return false;
    if (expression.startsWith("in.(")) {
      const list = expression.slice(4, -1).split(",").map((item) => item.replace(/^"|"$/g, ""));
      if (!list.includes(String(value))) return false;
    }
    if (expression.startsWith("not.in.(")) {
      const list = expression.slice(8, -1).split(",").map((item) => item.replace(/^"|"$/g, ""));
      if (list.includes(String(value))) return false;
    }
  }
  return true;
}

test.before(async () => {
  stub = createServer((request, response) => {
    const [route, query] = request.url.split("?");
    const table = route.replace("/rest/v1/", "");
    const params = new URLSearchParams(query || "");
    let found = (rows[table] || []).filter((row) => matches(row, params));
    const order = params.get("order");
    if (order) {
      const [column, direction] = order.split(",")[0].split(".");
      found = found.slice().sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (direction === "desc" ? -1 : 1));
    }
    const offset = Number(params.get("offset")) || 0;
    const limit = params.has("limit") ? Number(params.get("limit")) : Infinity;
    const page = found.slice(offset, offset + limit);
    response.writeHead(200, { "Content-Type": "application/json", "Content-Range": `0-${Math.max(0, page.length - 1)}/${found.length}` });
    response.end(JSON.stringify(request.headers.prefer?.includes("count=exact") ? [] : page));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${stub.address().port}`;
  previous = { ...process.env };
  Object.assign(process.env, { ANTY_SUPABASE_URL: address, ANTY_SERVICE_ROLE_KEY: "stub", WARMUP_CRM_SUPABASE_URL: address, WARMUP_CRM_SERVICE_ROLE_KEY: "stub" });
});

test.after(async () => {
  for (const key of ["ANTY_SUPABASE_URL", "ANTY_SERVICE_ROLE_KEY", "WARMUP_CRM_SUPABASE_URL", "WARMUP_CRM_SERVICE_ROLE_KEY"]) process.env[key] = previous[key] ?? "";
  await new Promise((resolve) => stub.close(resolve));
});

test.beforeEach(() => {
  const contact = (n, extra = {}) => ({ id: id(n), folder_id: FOLDER, name: `Person ${n}`, company: "Acme", created_at: `2026-01-0${n}T00:00:00Z`, ...extra });
  rows.contacts = [
    contact(1),                                                              // nobody wrote: first in the folder
    contact(2, { linkedin: "https://www.linkedin.com/in/friend-two" }),      // a friend of a working account, silent
    contact(3, { email: "three@acme.com" }),                                 // a cold email already went
    contact(4),                                                              // marked «не валідний»
    contact(5, { linkedin: "https://www.linkedin.com/in/talking-five" }),   // a LinkedIn conversation exists
    contact(6, { linkedin: "https://www.linkedin.com/in/six" })              // a friend only of a blocked account
  ];
  rows.wl_accounts = [
    { id: "acc-1", label: "Profile 48", login: "", status: "warming", health: "ok" },
    { id: "acc-2", label: "Profile 47", login: "", status: "warming", health: "blocked" }
  ];
  rows.wl_outreach = [
    { id: "o-2", account_id: "acc-1", crm_contact_id: id(2), status: "accepted", person_linkedin: "https://www.linkedin.com/in/friend-two", created_at: "2026-10-08T00:00:00Z", responded_at: "2026-10-09T00:00:00Z" },
    { id: "o-6", account_id: "acc-2", crm_contact_id: id(6), status: "accepted", person_linkedin: "https://www.linkedin.com/in/six", created_at: "2026-10-08T00:00:00Z", responded_at: "2026-10-09T00:00:00Z" }
  ];
  rows.wl_events = [
    { id: "e-1", account_id: "acc-1", type: "message.in", created_at: "2026-10-10T00:00:00Z", meta: { participant: { slug: "talking-five" } } }
  ];
});

const emailed = new Map([["three@acme.com", { at: "2026-10-05T00:00:00Z", from: "anna@advantage-mail.com" }]]);
const decisions = { [id(4)]: { decision: "invalid" } };
const ask = (skip = []) => nextContact({ folderId: FOLDER, cursor: 0, skip, decisions, emailed });

test("a friend of a working account comes first, with the account that can write to them", async () => {
  const answer = await ask();
  assert.equal(answer.phase, "friends");
  assert.equal(answer.contact.id, id(2));
  assert.equal(answer.friendsLeft, 1);
  assert.deepEqual(answer.linkedin.friends.map((friend) => [friend.accountName, friend.canWrite]), [["Profile 48", true]]);
});

test("then the folder oldest first, past whoever was written to, marked not valid or skipped", async () => {
  const first = await ask([id(2)]);
  assert.equal(first.phase, "folder");
  assert.equal(first.contact.id, id(1), "nobody wrote to person 1");
  assert.equal(first.cursor, 0);

  const next = await ask([id(2), id(1)]);
  assert.equal(next.contact.id, id(6), "3 was emailed, 4 is not valid, 5 has a LinkedIn conversation");
  const friend = next.linkedin.friends[0];
  assert.equal(friend.canWrite, false, "a blocked account does not write");
  assert.match(friend.why, /заблоковано/);

  const done = await ask([id(2), id(1), id(6)]);
  assert.equal(done.contact, null);
  assert.equal(done.done, true);
});

test("an emailed address says when and from which mailbox", async () => {
  rows.contacts = rows.contacts.filter((row) => row.id === id(3));
  rows.wl_outreach = [];
  // Asked about directly: the queue never offers them, the card still says why.
  const { channelsFor } = await import("../triage/queue.mjs");
  const channels = await channelsFor(rows.contacts[0], { emailed });
  assert.equal(channels.email.written, true);
  assert.equal(channels.email.writtenFrom, "anna@advantage-mail.com");
});
