import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// There is one user base and it belongs to the CRM. This app invites nobody:
// whoever the CRM approved signs in with their CRM account, and the profile
// kept here is a record — a model, spend, time — rather than a pass. What an
// admin sets in the team panel is a role, and nothing else.
//
// The gate matters because signing up to this Supabase project is open and
// self-confirming, so "anybody with an account" would mean anybody at all. The
// CRM's approval flag is the same base's own answer to that.

const authUsers = [
  { id: "u-stepan", email: "stepan@advantage-agency.co", created_at: "2026-09-16T08:08:36Z", last_sign_in_at: "2026-09-17T09:00:00Z", user_metadata: { name: "Stepan" } },
  { id: "u-dev", email: "developer@localhost", created_at: "2026-01-01T00:00:00Z", last_sign_in_at: "2026-09-17T08:00:00Z", user_metadata: {} },
  { id: "u-lilia", email: "ovchar.lilia17@gmail.com", created_at: "2026-01-26T12:58:36Z", last_sign_in_at: "2026-07-07T10:00:00Z", user_metadata: {} },
  { id: "u-mark", email: "yurkevych.mark@gmail.com", created_at: "2026-01-11T14:36:07Z", last_sign_in_at: null, user_metadata: {} },
  { id: "u-stranger", email: "stranger@example.com", created_at: "2026-09-01T00:00:00Z", last_sign_in_at: null, user_metadata: {} },
  // Gmail delivers these two to one inbox: "+outbound" is a tag, and Gmail
  // ignores the dot as well. Supabase holds them as two accounts.
  { id: "u-pavlo", email: "pavlo.work.101@gmail.com", created_at: "2026-02-01T00:00:00Z", last_sign_in_at: "2026-09-17T07:00:00Z", user_metadata: {} },
  { id: "u-pavlo-tag", email: "pavlowork101+outbound@gmail.com", created_at: "2026-09-15T00:00:00Z", last_sign_in_at: "2026-09-15T14:17:49Z", user_metadata: { name: "Pavlo" } }
];

const crmProfiles = [
  { id: "u-stepan", email: "stepan@advantage-agency.co", role: "user", approval_status: "pending", last_sign_in_at: null },
  { id: "u-dev", email: "developer@localhost", role: "user", approval_status: "approved", last_sign_in_at: null },
  { id: "u-lilia", email: "ovchar.lilia17@gmail.com", role: "user", approval_status: "approved", last_sign_in_at: null },
  { id: "u-mark", email: "yurkevych.mark@gmail.com", role: "admin", approval_status: "approved", last_sign_in_at: null },
  { id: "u-pavlo", email: "pavlo.work.101@gmail.com", role: "admin", approval_status: "approved", last_sign_in_at: null }
];

/** A Supabase that answers the two questions this app asks of it. */
function startFakeSupabase() {
  return new Promise((resolve) => {
    const service = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url.startsWith("/auth/v1/admin/users")) {
        response.end(JSON.stringify({ users: authUsers }));
        return;
      }
      if (request.url.startsWith("/rest/v1/profiles")) {
        response.end(JSON.stringify(crmProfiles));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `no stub for ${request.url}` }));
    });
    service.listen(0, "127.0.0.1", () => resolve({ service, port: service.address().port }));
  });
}

async function startWorkspace(supabasePort, savedState = null) {
  const dir = await mkdtemp(join(tmpdir(), "outbound-directory-"));
  const statePath = join(dir, "state.json");
  if (savedState) await writeFile(statePath, JSON.stringify(savedState), "utf8");
  const port = 4600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      SUPABASE_API_KEY: "service-role-stub"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("workspace did not start")), 15000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("running at")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`workspace exited with ${code}`)));
  });
  const call = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { call, stop: async () => { child.kill(); await rm(dir, { recursive: true, force: true }); } };
}

async function withWorkspace(t, savedState = null) {
  const supabase = await startFakeSupabase();
  const workspace = await startWorkspace(supabase.port, savedState);
  t.after(async () => { await workspace.stop(); supabase.service.close(); });
  return workspace;
}

test("the team panel is the CRM's user base, not a list of invitations", async (t) => {
  const workspace = await withWorkspace(t);

  const { status, body } = await workspace.call("/api/account/directory");
  assert.equal(status, 200);
  // One row fewer than accounts: the two Gmail addresses are one mailbox.
  assert.equal(body.people.length, authUsers.length - 1);
  assert.equal(body.canSignIn, 4, "the four the CRM approved");

  const byEmail = new Map(body.people.map((person) => [person.email, person]));
  assert.equal(byEmail.get("ovchar.lilia17@gmail.com").blocked, "", "approved in the CRM is enough");
  assert.equal(byEmail.get("ovchar.lilia17@gmail.com").signedInHere, false, "and they have never been here");
  assert.equal(byEmail.get("yurkevych.mark@gmail.com").role, "admin", "an admin there arrives an admin here");
  assert.equal(byEmail.get("ovchar.lilia17@gmail.com").role, "seller");
  assert.equal(byEmail.get("stranger@example.com").blocked, "немає в базі CRM");
  assert.equal(byEmail.get("stepan@advantage-agency.co").blocked, "не підтверджений у CRM");

  const order = body.people.map((person) => person.email);
  assert.deepEqual(order.slice(-2).sort(), ["stepan@advantage-agency.co", "stranger@example.com"], "whoever cannot sign in sinks");
});

/* ── Одна людина — один рядок ───────────────────────────────────────────────
 *
 * Fourteen accounts in the CRM's Supabase are not fourteen colleagues: some are
 * leftover test rows, and one person holds two addresses that reach the same
 * inbox. A list of people has to read as the team.
 */

test("two addresses that reach one inbox are one person, and the other address stays named", async (t) => {
  const workspace = await withWorkspace(t);

  const { body } = await workspace.call("/api/account/directory");
  const pavloRows = body.people.filter((person) => person.email.includes("pavlo"));
  assert.equal(pavloRows.length, 1, "one mailbox, one row");
  assert.equal(pavloRows[0].email, "pavlo.work.101@gmail.com", "the address the CRM approved is the one kept");
  assert.deepEqual(pavloRows[0].aliases, ["pavlowork101+outbound@gmail.com"], "and the folded address is still said out loud");
  assert.equal(pavloRows[0].blocked, "", "the kept row is the one that can work");
});

test("both rows stay when both have worked here, because each holds its own spend", async (t) => {
  // Folding an account that has a profile would hide the model it chose, the
  // credits it spent and the hours it sat here. Two used accounts are two rows.
  const workspace = await withWorkspace(t, {
    version: 1,
    users: [
      { id: "u-pavlo", email: "pavlo.work.101@gmail.com", name: "Pavlo", role: "admin", status: "active", modelId: "", createdAt: new Date().toISOString() },
      { id: "u-pavlo-tag", email: "pavlowork101+outbound@gmail.com", name: "Pavlo", role: "seller", status: "active", modelId: "", createdAt: new Date().toISOString() }
    ]
  });

  const { body } = await workspace.call("/api/account/directory");
  const pavloRows = body.people.filter((person) => person.email.includes("pavlo"));
  assert.equal(pavloRows.length, 2);
  for (const row of pavloRows) {
    assert.equal(row.aliases.length, 1, "each row names the other");
  }
});

test("the part of an address before the @ is not a name", async (t) => {
  const workspace = await withWorkspace(t);

  const { body } = await workspace.call("/api/account/directory");
  const byEmail = new Map(body.people.map((person) => [person.email, person]));
  // Nobody filled in a display name for Lilia, so there is none — rather than
  // "ovchar.lilia17" standing above "ovchar.lilia17@gmail.com".
  assert.equal(byEmail.get("ovchar.lilia17@gmail.com").name, "");
  // A real name is still a name.
  assert.equal(byEmail.get("stepan@advantage-agency.co").name, "Stepan");
});

test("an approved CRM account signs in without anybody inviting it", async (t) => {
  const workspace = await withWorkspace(t);

  const before = await workspace.call("/api/account/directory");
  assert.equal(before.body.people.find((person) => person.email === "ovchar.lilia17@gmail.com").signedInHere, false);

  const login = await workspace.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "ovchar.lilia17@gmail.com", password: "irrelevant-here" })
  });
  // The fake Supabase has no token endpoint, so the sign-in cannot complete —
  // but it must fail on Supabase and not on an invitation this app never has.
  assert.notEqual(login.status, 403, "no invitation check stands in front of the password check");

  const role = await workspace.call("/api/account/role", {
    method: "POST",
    body: JSON.stringify({ email: "ovchar.lilia17@gmail.com", role: "admin" })
  });
  assert.equal(role.status, 200);
  assert.equal(role.body.user.role, "admin");

  const after = await workspace.call("/api/account/directory");
  const row = after.body.people.find((person) => person.email === "ovchar.lilia17@gmail.com");
  assert.equal(row.role, "admin", "a role set by hand outranks the CRM's default");
  assert.equal(row.blocked, "");
});

test("an admin cannot demote themselves", async (t) => {
  const workspace = await withWorkspace(t);

  const { status, body } = await workspace.call("/api/account/role", {
    method: "POST",
    body: JSON.stringify({ email: "developer@localhost", role: "seller" })
  });
  assert.equal(status, 400);
  assert.match(body.error, /Свою власну роль/);
});

test("a role is only ever one of two words", async (t) => {
  const workspace = await withWorkspace(t);

  const { status, body } = await workspace.call("/api/account/role", {
    method: "POST",
    body: JSON.stringify({ email: "ovchar.lilia17@gmail.com", role: "owner" })
  });
  assert.equal(status, 400);
  assert.match(body.error, /admin або seller/);
});

test("somebody already working here is not locked out by the CRM's approval flag", async (t) => {
  // stepan is "pending" in the CRM only because the account was made through
  // the admin API and never went through the CRM's own approval screen. A gate
  // added afterwards must not throw out the people already inside.
  const workspace = await withWorkspace(t, {
    version: 1,
    users: [{
      id: "u-stepan",
      email: "stepan@advantage-agency.co",
      name: "Stepan",
      role: "admin",
      status: "active",
      modelId: "",
      createdAt: new Date().toISOString()
    }]
  });

  const { body } = await workspace.call("/api/account/directory");
  const row = body.people.find((person) => person.email === "stepan@advantage-agency.co");
  assert.equal(row.blocked, "", "known here outranks pending there");
  assert.equal(row.signedInHere, true);
  assert.equal(body.canSignIn, 5);
});

/* ── Картка однієї людини ───────────────────────────────────────────────────
 *
 * The Users tab is a list of people and, under it, one person's card: their
 * email, the model chosen for them, their credits and their time. The model is
 * therefore chosen per person, which means an admin must be able to open
 * somebody else's card — and a seller must not.
 */

test("an admin opens somebody else's card and chooses a model for them", async (t) => {
  const workspace = await withWorkspace(t);

  // Lilia is approved in the CRM and has never signed in here, so she has no
  // profile row at all. Reading her card must not invent one.
  const read = await workspace.call("/api/account/profile?user=u-lilia");
  assert.equal(read.status, 200);
  assert.equal(read.body.user.email, "ovchar.lilia17@gmail.com");
  assert.equal(read.body.self, false, "it is not the reader's own card");
  assert.equal(read.body.signedInHere, false);
  assert.equal(read.body.model.modelId, "", "nothing chosen for her yet");
  assert.equal(read.body.spend.buckets.length, 30, "an empty month is still a month");
  assert.equal(read.body.spend.totalCostUsd, 0);
  assert.equal(read.body.time.totalSeconds, 0);

  const before = await workspace.call("/api/account/directory");
  assert.equal(before.body.people.find((person) => person.id === "u-lilia").signedInHere, false);

  // Choosing writes her profile early — the same thing setting a role does.
  const chosen = await workspace.call("/api/account/model", {
    method: "POST",
    body: JSON.stringify({ userId: "u-lilia", modelId: "anthropic/claude-sonnet-5#high" })
  });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.model.modelId, "anthropic/claude-sonnet-5#high");

  const after = await workspace.call("/api/account/profile?user=u-lilia");
  assert.equal(after.body.model.modelId, "anthropic/claude-sonnet-5#high");
  assert.equal(after.body.model.source, "user");

  // And the choice is visible in the list, so the spread of models across the
  // team is one glance rather than fourteen clicks.
  const directory = await workspace.call("/api/account/directory");
  const row = directory.body.people.find((person) => person.id === "u-lilia");
  assert.equal(row.modelId, "anthropic/claude-sonnet-5#high");
  assert.equal(row.modelLabel, "Claude Sonnet 5 · глибоке думання");

  // The admin's own card is untouched by any of it.
  const mine = await workspace.call("/api/account/profile");
  assert.equal(mine.body.self, true);
  assert.equal(mine.body.user.email, "developer@localhost");
  assert.equal(mine.body.model.modelId, "");
});

test("a seller's card is their own, and asking for another's is refused rather than substituted", async (t) => {
  const workspace = await withWorkspace(t, {
    version: 1,
    users: [{
      id: "dev-user",
      email: "developer@localhost",
      name: "Local Tester",
      role: "seller",
      status: "active",
      modelId: "",
      createdAt: new Date().toISOString()
    }]
  });

  const mine = await workspace.call("/api/account/profile");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.user.email, "developer@localhost");

  // Their own id and their own email are their own card, however they spell it.
  const byId = await workspace.call("/api/account/profile?user=dev-user");
  assert.equal(byId.status, 200);
  assert.equal(byId.body.self, true);

  const someoneElse = await workspace.call("/api/account/profile?user=u-lilia");
  assert.equal(someoneElse.status, 403, "a wrong person's spend is worse than a refusal");

  const writeForSomeoneElse = await workspace.call("/api/account/model", {
    method: "POST",
    body: JSON.stringify({ userId: "u-lilia", modelId: "anthropic/claude-sonnet-5" })
  });
  assert.equal(writeForSomeoneElse.status, 403);

  // Their own model they still choose.
  const own = await workspace.call("/api/account/model", {
    method: "POST",
    body: JSON.stringify({ modelId: "anthropic/claude-haiku-4.5#low" })
  });
  assert.equal(own.status, 200);
  assert.equal(own.body.model.modelId, "anthropic/claude-haiku-4.5#low");
});

/* ── Усі, і з цифрами ───────────────────────────────────────────────────────
 *
 * The Users tab is meant to be everybody, with what each person costs and how
 * long they were here. Two things had to hold for that: the list must not need
 * a service-role key to exist at all, and every row must carry its own numbers.
 */

test("every row carries the person's own spend and time", async (t) => {
  const workspace = await withWorkspace(t, {
    version: 1,
    users: [
      { id: "u-lilia", email: "ovchar.lilia17@gmail.com", name: "Лілія", role: "seller", status: "active", modelId: "", createdAt: new Date().toISOString() }
    ],
    usage: [
      { id: "r1", at: new Date().toISOString(), taskType: "COLD_EMAIL", modelId: "anthropic/claude-haiku-4.5", provider: "openrouter", userId: "u-lilia", inputTokens: 1000, outputTokens: 200, costUsd: 0.75, latencyMs: 700 },
      { id: "r2", at: new Date().toISOString(), taskType: "COLD_EMAIL", modelId: "anthropic/claude-haiku-4.5", provider: "openrouter", userId: "u-lilia", inputTokens: 1000, outputTokens: 200, costUsd: 0.25, latencyMs: 700 },
      // Somebody else's, and a fabricated row: neither belongs to her.
      { id: "r3", at: new Date().toISOString(), taskType: "COLD_EMAIL", modelId: "anthropic/claude-haiku-4.5", provider: "openrouter", userId: "u-mark", inputTokens: 10, outputTokens: 10, costUsd: 5, latencyMs: 10 },
      { id: "r4", at: new Date().toISOString(), taskType: "COLD_EMAIL", modelId: "mock/economy", provider: "mock", userId: "u-lilia", inputTokens: 10, outputTokens: 10, costUsd: 99, latencyMs: 10 }
    ],
    userActivity: {
      "u-lilia": { userId: "u-lilia", days: { [new Date().toISOString().slice(0, 10)]: 5400 }, tabs: {}, lastCreditedAt: null, lastSeenAt: null }
    }
  });

  const { body } = await workspace.call("/api/account/directory");
  assert.equal(body.days, 30, "the numbers are for a stated window");
  const byEmail = new Map(body.people.map((person) => [person.email, person]));

  const lilia = byEmail.get("ovchar.lilia17@gmail.com");
  assert.equal(lilia.costUsd, 1, "her two real rows, and not the mock one");
  assert.equal(lilia.requests, 2);
  assert.equal(lilia.seconds, 5400);
  assert.equal(lilia.activeDays, 1);

  const mark = byEmail.get("yurkevych.mark@gmail.com");
  assert.equal(mark.costUsd, 5, "and his are his");
  assert.equal(mark.seconds, 0);

  const untouched = byEmail.get("stranger@example.com");
  assert.equal(untouched.costUsd, 0, "nobody's numbers leak onto somebody who never worked");
  assert.equal(untouched.requests, 0);
  assert.equal(untouched.seconds, 0);
});

test("the list still exists when the service-role endpoint refuses, and says where it came from", async (t) => {
  // A workspace holding the project's publishable key gets 401 from
  // auth/v1/admin/users. That used to leave the tab with no list at all; the
  // CRM's own profiles table is readable either way and answers instead.
  const supabase = await startFakeSupabase();
  const noAdminApi = await new Promise((resolve) => {
    const service = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url.startsWith("/auth/v1/admin/users")) {
        response.statusCode = 401;
        response.end(JSON.stringify({ msg: "User not allowed" }));
        return;
      }
      if (request.url.startsWith("/rest/v1/profiles")) {
        response.end(JSON.stringify(crmProfiles));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "no stub" }));
    });
    service.listen(0, "127.0.0.1", () => resolve({ service, port: service.address().port }));
  });
  supabase.service.close();
  const workspace = await startWorkspace(noAdminApi.port);
  t.after(async () => { await workspace.stop(); noAdminApi.service.close(); });

  const { status, body } = await workspace.call("/api/account/directory");
  assert.equal(status, 200, "a refused admin endpoint is not a broken screen");
  assert.equal(body.adminApi, false, "and the screen is told which list it got");
  assert.ok(body.people.length >= crmProfiles.length, "everybody the CRM knows is there");
  const emails = body.people.map((person) => person.email);
  assert.ok(emails.includes("ovchar.lilia17@gmail.com"));
  assert.ok(emails.includes("yurkevych.mark@gmail.com"));
  // The one account Supabase has and the CRM does not cannot be known this way,
  // which is exactly what adminApi:false is there to say.
  assert.ok(!emails.includes("stranger@example.com"));
});
