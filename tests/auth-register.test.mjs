import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Registration, and the line it must not cross.
//
// Two things look like one and are not: **having an account** and **being let
// in**. Sign-up makes the first. The second is the CRM's decision — a
// `profiles` row marked `approved` — and nothing on the sign-in screen can
// grant it. That separation is why a registration form is safe to put on a
// public URL at all, so it is the thing these tests hold down.

const signedUp = new Map();
const crmProfiles = [];

function accessTokenFor(email) {
  return `token-for-${email}`;
}

/** A Supabase that answers the four questions registration and sign-in ask. */
function startFakeSupabase() {
  return new Promise((resolve) => {
    const service = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      const [path] = request.url.split("?");

      if (path === "/rest/v1/profiles") {
        response.end(JSON.stringify(crmProfiles));
        return;
      }
      if (path === "/auth/v1/admin/users") {
        response.end(JSON.stringify({ users: [...signedUp.values()].map(({ password, ...user }) => user) }));
        return;
      }
      if (path === "/auth/v1/user") {
        const token = String(request.headers.authorization || "").replace(/^Bearer /, "");
        const found = [...signedUp.values()].find((user) => accessTokenFor(user.email) === token);
        if (!found) {
          response.statusCode = 401;
          response.end(JSON.stringify({ msg: "invalid token" }));
          return;
        }
        const { password, ...user } = found;
        response.end(JSON.stringify(user));
        return;
      }

      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const sent = body ? JSON.parse(body) : {};
        const email = String(sent.email || "").toLowerCase();

        if (path === "/auth/v1/signup") {
          if (signedUp.has(email)) {
            response.statusCode = 422;
            response.end(JSON.stringify({ msg: "User already registered" }));
            return;
          }
          signedUp.set(email, {
            id: `u-${signedUp.size + 1}`,
            email,
            password: String(sent.password || ""),
            created_at: new Date().toISOString(),
            last_sign_in_at: null,
            user_metadata: sent.data || {}
          });
          response.end(JSON.stringify({ user: { id: `u-${signedUp.size}`, email } }));
          return;
        }

        if (path === "/auth/v1/token") {
          const account = signedUp.get(email);
          if (!account || account.password !== String(sent.password || "")) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error_description: "Invalid login credentials" }));
            return;
          }
          const { password, ...user } = account;
          response.end(JSON.stringify({ access_token: accessTokenFor(email), refresh_token: `refresh-${email}`, user }));
          return;
        }

        response.statusCode = 404;
        response.end(JSON.stringify({ message: `no stub for ${request.url}` }));
      });
    });
    service.listen(0, "127.0.0.1", () => resolve({ service, port: service.address().port }));
  });
}

// Порт на кожен тест свій, а не випадковий: випадкові з одного діапазону
// зрідка збігалися, і тоді один тест падав через сервер сусіднього. Тест, який
// падає раз на десять прогонів, гірший за відсутній — йому перестають вірити.
let nextPort = 4900;

async function startWorkspace(supabasePort, savedState = null, apiKey = "sb_secret_test") {
  const dir = await mkdtemp(join(tmpdir(), "outbound-register-"));
  const statePath = join(dir, "state.json");
  if (savedState) await writeFile(statePath, JSON.stringify(savedState), "utf8");
  const port = nextPort += 1;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      // Registration has to be reachable without a session, so the bypass that
      // hands every request an admin is exactly what must be off here.
      AUTH_DEV_BYPASS: "0",
      WARMUP_SCHEDULER_DISABLED: "1",
      SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      // Формат ключа — не декорація: за ним вирішується, чи маємо ми право
      // заявляти, що адреси тут немає. Типово — той, що бачить усе.
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
  // Чекаємо, поки процес справді помре, а не лише поки йому надіслано сигнал:
  // сервер, що пережив свій тест, тримає порт і пише у теку, яку вже прибрали.
  return {
    post,
    stop: async () => {
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function withWorkspace(t, { apiKey } = {}) {
  signedUp.clear();
  crmProfiles.length = 0;
  const supabase = await startFakeSupabase();
  const workspace = await startWorkspace(supabase.port, {
    version: 1,
    // Somebody already works here, so the screen is the sign-in screen rather
    // than the "create the first owner" one.
    users: [{ id: "u-owner", email: "owner@example.com", name: "Owner", role: "admin", status: "active", createdAt: new Date().toISOString() }]
  }, apiKey);
  t.after(async () => { await workspace.stop(); supabase.service.close(); });
  return workspace;
}

test("registering makes an account and, on its own, lets nobody in", async (t) => {
  const workspace = await withWorkspace(t);

  const { status, body } = await workspace.post("/api/auth/register", {
    name: "Nova", email: "nova@example.com", password: "correct-horse-battery"
  });

  assert.equal(status, 202, "half done is its own answer, not an error and not a session");
  assert.equal(body.pending, true);
  assert.ok(signedUp.has("nova@example.com"), "the account exists in the user base");
  assert.match(body.message, /Акаунт створено/, "the first thing it says is that the account exists");
  assert.match(body.message, /CRM/, "and the reason names where access is granted");
  assert.equal(body.auth, undefined, "no session comes back");
});

test("somebody the CRM already approved is signed in by the same form", async (t) => {
  const workspace = await withWorkspace(t);
  crmProfiles.push({ id: "u-1", email: "mila@example.com", role: "user", approval_status: "approved" });

  const { status, body } = await workspace.post("/api/auth/register", {
    name: "Mila", email: "mila@example.com", password: "correct-horse-battery"
  });

  assert.equal(status, 201);
  assert.equal(body.auth.authenticated, true);
  assert.equal(body.auth.user.email, "mila@example.com");
  assert.equal(body.auth.user.role, "seller", "role comes from the CRM, not from the form");
});

test("a pending CRM account is told it is pending, not that registration failed", async (t) => {
  const workspace = await withWorkspace(t);
  crmProfiles.push({ id: "u-1", email: "wait@example.com", role: "user", approval_status: "pending" });

  const { status, body } = await workspace.post("/api/auth/register", {
    name: "Wait", email: "wait@example.com", password: "correct-horse-battery"
  });

  assert.equal(status, 202);
  assert.equal(body.pending, true);
  assert.match(body.message, /Акаунт створено/, "not «нічого не вийшло» — the account is there");
  assert.match(body.message, /підтвердж/i, "the word a person needs in order to know what to ask for");
});

test("registering again with the right password signs you in instead of failing", async (t) => {
  const workspace = await withWorkspace(t);
  crmProfiles.push({ id: "u-1", email: "again@example.com", role: "admin", approval_status: "approved" });

  const first = await workspace.post("/api/auth/register", { email: "again@example.com", password: "correct-horse-battery" });
  assert.equal(first.status, 201);

  // Somebody who forgot they already had an account should end up inside, not
  // told off by a form for a mistake with no consequence.
  const second = await workspace.post("/api/auth/register", { email: "again@example.com", password: "correct-horse-battery" });
  assert.equal(second.status, 201);
  assert.equal(second.body.auth.user.role, "admin");
  assert.equal(signedUp.size, 1, "and no second account is made for the same address");
});

test("a password too short to be one is refused before anything is created", async (t) => {
  const workspace = await withWorkspace(t);

  const { status, body } = await workspace.post("/api/auth/register", { email: "short@example.com", password: "12345" });

  assert.equal(status, 400);
  assert.match(body.error, /10 символів/);
  assert.equal(signedUp.size, 0, "a refused form must not leave an account behind");
});

test("an address that is not one is refused, and leaves nothing behind either", async (t) => {
  const workspace = await withWorkspace(t);

  const { status } = await workspace.post("/api/auth/register", { email: "not-an-address", password: "correct-horse-battery" });

  assert.equal(status, 400);
  assert.equal(signedUp.size, 0);
});

test("somebody who just registered is never told their account does not exist", async (t) => {
  const workspace = await withWorkspace(t);

  // No CRM profile: the account is made here and the base has not given it a
  // `profiles` row. That is the ordinary state one second after registering.
  const registered = await workspace.post("/api/auth/register", { email: "fresh@example.com", password: "correct-horse-battery" });
  assert.equal(registered.status, 202);

  // And now the most likely next thing they do: fumble the password they chose
  // thirty seconds ago.
  const { status, body } = await workspace.post("/api/auth/login", { email: "fresh@example.com", password: "wrong-password-entirely" });

  assert.equal(status, 401);
  assert.doesNotMatch(body.error, /тут немає/, "our own form made this account a moment ago — denying it exists is the worst lie available");
  assert.match(body.error, /[Пп]ароль/, "the true half: the address is known, the password is not");
});

test("a key that cannot see everything never says somebody is not here", async (t) => {
  // An anon key reads `profiles` through RLS, so "not found" may only mean
  // "not shown", and `admin/users` refuses it outright. Under such a key the
  // sentence «Акаунта з поштою … тут немає» is a guess dressed as a fact, and
  // the person it lands on is usually the one who just registered.
  const workspace = await withWorkspace(t, { apiKey: "sb_publishable_test" });
  crmProfiles.push({ id: "u-1", email: "known@example.com", role: "user", approval_status: "approved" });
  await workspace.post("/api/auth/register", { email: "known@example.com", password: "correct-horse-battery" });

  // Somebody nobody here has ever heard of — the one case where the sentence
  // would be true, and still must not be said by a key that cannot check.
  const { status, body } = await workspace.post("/api/auth/login", {
    email: "total-stranger@example.com", password: "whatever-goes-here"
  });

  assert.equal(status, 401);
  assert.doesNotMatch(body.error, /тут немає/, "no visibility, no claim about absence");
  assert.match(body.error, /Пошта або пароль не підходять/);
});

test("and with a key that does see everything, the helpful answer is still given", async (t) => {
  const workspace = await withWorkspace(t);

  const { status, body } = await workspace.post("/api/auth/login", {
    email: "total-stranger@example.com", password: "whatever-goes-here"
  });

  assert.equal(status, 401);
  assert.match(body.error, /тут немає/, "a seller who typed their address wrong has nothing else to go on");
});
