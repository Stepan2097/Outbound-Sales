import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Removing an account, which is the only action in the team panel that cannot
// be taken back.
//
// It exists because registration is open and the base confirms addresses by
// itself: a typo becomes a real account nobody will ever reach. Until this,
// every such typo was permanent unless somebody opened the Supabase dashboard.

const authUsers = new Map();
const crmProfiles = [];

function startFakeSupabase() {
  return new Promise((resolve) => {
    const service = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      const [path] = request.url.split("?");

      if (path === "/rest/v1/profiles") {
        response.end(JSON.stringify(crmProfiles));
        return;
      }
      if (path.startsWith("/auth/v1/admin/users/") && request.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/auth/v1/admin/users/".length));
        if (!authUsers.has(id)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ msg: "User not found" }));
          return;
        }
        authUsers.delete(id);
        response.end(JSON.stringify({}));
        return;
      }
      if (path === "/auth/v1/admin/users") {
        response.end(JSON.stringify({ users: [...authUsers.values()] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `no stub for ${request.url}` }));
    });
    service.listen(0, "127.0.0.1", () => resolve({ service, port: service.address().port }));
  });
}

let nextPort = 5200;

async function startWorkspace(supabasePort, savedState, apiKey) {
  const dir = await mkdtemp(join(tmpdir(), "outbound-remove-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify(savedState), "utf8");
  const port = nextPort += 1;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      // The bypass signs us in as an admin, which is who this route is for.
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      SUPABASE_API_KEY: apiKey
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
  const post = async (path, payload) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    post,
    statePath,
    stop: async () => {
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function withWorkspace(t, { apiKey = "sb_secret_test" } = {}) {
  authUsers.clear();
  crmProfiles.length = 0;
  authUsers.set("u-typo", {
    id: "u-typo", email: "pavlo.work.101@gmail.com1", created_at: new Date().toISOString(),
    last_sign_in_at: null, user_metadata: {}
  });
  const supabase = await startFakeSupabase();
  const workspace = await startWorkspace(supabase.port, {
    version: 1,
    users: [
      { id: "u-typo", email: "pavlo.work.101@gmail.com1", name: "Typo", role: "seller", status: "active", createdAt: new Date().toISOString() },
      { id: "u-owner", email: "owner@example.com", name: "Owner", role: "admin", status: "active", createdAt: new Date().toISOString() }
    ]
  }, apiKey);
  t.after(async () => { await workspace.stop(); supabase.service.close(); });
  return workspace;
}

test("an admin removes an account and it is gone from the user base", async (t) => {
  const workspace = await withWorkspace(t);

  const { status, body } = await workspace.post("/api/account/users/remove", { userId: "u-typo" });

  assert.equal(status, 200);
  assert.equal(body.removed, true);
  assert.equal(body.email, "pavlo.work.101@gmail.com1");
  assert.equal(authUsers.has("u-typo"), false, "the account itself, not just our note about it");
  assert.equal(body.hadWorkspaceProfile, true, "and the workspace profile went with it");
});

test("a row left behind in the CRM is reported rather than quietly ignored", async (t) => {
  const workspace = await withWorkspace(t);
  // `profiles` belongs to the CRM and this app only reads it. Half a deletion
  // that says nothing later reads as "it did not work".
  crmProfiles.push({ id: "u-typo", email: "pavlo.work.101@gmail.com1", role: "user", approval_status: "pending" });

  const { body } = await workspace.post("/api/account/users/remove", { userId: "u-typo" });

  assert.equal(body.removed, true);
  assert.equal(body.crmProfileRemains, true);
  assert.equal(crmProfiles.length, 1, "somebody else's table is not written to");
});

test("an admin cannot remove their own account", async (t) => {
  const workspace = await withWorkspace(t);

  // Roles are handed out by admins only, so the last one to lock themselves
  // out has nobody left to let them back in.
  const { status, body } = await workspace.post("/api/account/users/remove", { userId: "dev-user" });

  assert.equal(status, 409);
  assert.match(body.error, /іншого адміністратора/);
});

test("a key without admin rights refuses in our words and deletes nothing", async (t) => {
  const workspace = await withWorkspace(t, { apiKey: "sb_publishable_test" });

  const { status, body } = await workspace.post("/api/account/users/remove", { userId: "u-typo" });

  assert.equal(status, 409);
  assert.doesNotMatch(body.error, /User not allowed/, "Supabase's sentence reads as a fault in this app");
  assert.match(body.error, /дашборді Supabase|службовий ключ/, "and the answer says what to do instead");
  assert.equal(authUsers.has("u-typo"), true, "nothing half-happened");
});

test("removing needs an id, and says so instead of guessing", async (t) => {
  const workspace = await withWorkspace(t);

  const { status } = await workspace.post("/api/account/users/remove", { email: "pavlo.work.101@gmail.com1" });

  assert.equal(status, 400);
  assert.equal(authUsers.has("u-typo"), true, "an address is not an identity — two accounts can share a mailbox");
});
