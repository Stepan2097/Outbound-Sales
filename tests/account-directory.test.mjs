import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Signing in needs two separate things: an account in Supabase Auth and a
// profile in this workspace. The team panel used to show only the second, so
// the twelve colleagues who had the first were invisible — and an admin had no
// way to see that they existed, let alone let them in. These tests hold the
// panel to showing everybody, and hold the access switch to being reversible.

const authUsers = [
  { id: "u-stepan", email: "stepan@advantage-agency.co", created_at: "2026-09-16T08:08:36Z", last_sign_in_at: "2026-09-17T09:00:00Z", user_metadata: { name: "Stepan" } },
  { id: "u-dev", email: "developer@localhost", created_at: "2026-01-01T00:00:00Z", last_sign_in_at: "2026-09-17T08:00:00Z", user_metadata: {} },
  { id: "u-lilia", email: "ovchar.lilia17@gmail.com", created_at: "2026-01-26T12:58:36Z", last_sign_in_at: "2026-07-07T10:00:00Z", user_metadata: {} },
  { id: "u-mark", email: "yurkevych.mark@gmail.com", created_at: "2026-01-11T14:36:07Z", last_sign_in_at: null, user_metadata: {} }
];

const crmProfiles = [
  { id: "u-stepan", email: "stepan@advantage-agency.co", role: "user", approval_status: "pending", last_sign_in_at: null },
  { id: "u-mark", email: "yurkevych.mark@gmail.com", role: "admin", approval_status: "approved", last_sign_in_at: null }
];

/** A Supabase that answers the two questions the directory asks of it. */
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

async function startWorkspace(supabasePort) {
  const dir = await mkdtemp(join(tmpdir(), "outbound-directory-"));
  const port = 4600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: join(dir, "state.json"),
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

test("the team panel shows everybody with a CRM account, not only the invited", async (t) => {
  const supabase = await startFakeSupabase();
  const workspace = await startWorkspace(supabase.port);
  t.after(async () => { await workspace.stop(); supabase.service.close(); });

  const { status, body } = await workspace.call("/api/account/directory");
  assert.equal(status, 200);
  assert.equal(body.people.length, authUsers.length);
  assert.equal(body.withAccess, 1, "only the dev-bypass owner has been let in");

  const byEmail = new Map(body.people.map((person) => [person.email, person]));
  assert.equal(byEmail.get("stepan@advantage-agency.co").access, "", "in Supabase is not the same as invited");
  assert.equal(byEmail.get("yurkevych.mark@gmail.com").crmRole, "admin", "the CRM's own role decorates the row");
  assert.equal(byEmail.get("stepan@advantage-agency.co").approvalStatus, "pending");
  assert.equal(byEmail.get("ovchar.lilia17@gmail.com").crmRole, "", "a missing CRM profile costs a column, not the row");

  assert.equal(body.people[0].access, "admin", "whoever can work comes first");
  const outsiders = body.people.slice(1).map((person) => person.email);
  assert.deepEqual(outsiders, [
    "stepan@advantage-agency.co",
    "ovchar.lilia17@gmail.com",
    "yurkevych.mark@gmail.com"
  ], "the rest read by how recently they signed into the CRM");
});

test("access is given, changed and withdrawn without anybody being deleted", async (t) => {
  const supabase = await startFakeSupabase();
  const workspace = await startWorkspace(supabase.port);
  t.after(async () => { await workspace.stop(); supabase.service.close(); });

  const grant = await workspace.call("/api/account/access", {
    method: "POST",
    body: JSON.stringify({ email: "stepan@advantage-agency.co", access: "seller" })
  });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.user.role, "seller");

  const promoted = await workspace.call("/api/account/access", {
    method: "POST",
    body: JSON.stringify({ email: "stepan@advantage-agency.co", access: "admin" })
  });
  assert.equal(promoted.body.user.id, grant.body.user.id, "the same person, not a second profile");
  assert.equal(promoted.body.user.role, "admin");

  const withdrawn = await workspace.call("/api/account/access", {
    method: "POST",
    body: JSON.stringify({ email: "stepan@advantage-agency.co", access: "none" })
  });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.user.status, "disabled");

  // Spend and time are recorded against the id, so withdrawal must not remove
  // it: the row stays, marked, and can be switched back on.
  const after = await workspace.call("/api/account/directory");
  const row = after.body.people.find((person) => person.email === "stepan@advantage-agency.co");
  assert.equal(row.access, "", "no access");
  assert.equal(row.disabled, true, "but still known");
  assert.equal(after.body.withAccess, 1);
});

test("an admin cannot switch off their own access", async (t) => {
  const supabase = await startFakeSupabase();
  const workspace = await startWorkspace(supabase.port);
  t.after(async () => { await workspace.stop(); supabase.service.close(); });

  const { status, body } = await workspace.call("/api/account/access", {
    method: "POST",
    body: JSON.stringify({ email: "developer@localhost", access: "none" })
  });
  assert.equal(status, 400);
  assert.match(body.error, /Свій власний доступ/);
});

test("access is only ever one of three words", async (t) => {
  const supabase = await startFakeSupabase();
  const workspace = await startWorkspace(supabase.port);
  t.after(async () => { await workspace.stop(); supabase.service.close(); });

  const { status, body } = await workspace.call("/api/account/access", {
    method: "POST",
    body: JSON.stringify({ email: "stepan@advantage-agency.co", access: "owner" })
  });
  assert.equal(status, 400);
  assert.match(body.error, /admin, seller або none/);
});
