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
  { id: "u-stranger", email: "stranger@example.com", created_at: "2026-09-01T00:00:00Z", last_sign_in_at: null, user_metadata: {} }
];

const crmProfiles = [
  { id: "u-stepan", email: "stepan@advantage-agency.co", role: "user", approval_status: "pending", last_sign_in_at: null },
  { id: "u-dev", email: "developer@localhost", role: "user", approval_status: "approved", last_sign_in_at: null },
  { id: "u-lilia", email: "ovchar.lilia17@gmail.com", role: "user", approval_status: "approved", last_sign_in_at: null },
  { id: "u-mark", email: "yurkevych.mark@gmail.com", role: "admin", approval_status: "approved", last_sign_in_at: null }
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
  assert.equal(body.people.length, authUsers.length);
  assert.equal(body.canSignIn, 3, "the three the CRM approved");

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
  assert.equal(body.canSignIn, 4);
});
