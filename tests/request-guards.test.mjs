import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Вхід, реєстрація й вебхуки відкриті без сесії — тож їх тримають межі:
// розмір тіла, кількість спроб, токен транскриптів за сталий час.

async function startServer(port, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-guards-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), STATE_FILE_PATH: join(directory, "state.json"), WARMUP_SCHEDULER_DISABLED: "1", AUTH_DEV_BYPASS: "0", ...extraEnv },
    stdio: "ignore"
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const post = (path, body, headers = {}) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  return {
    post,
    stop: async () => {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("a body over the limit is refused with 413", async () => {
  const server = await startServer(43321);
  try {
    const huge = JSON.stringify({ email: "a@b.c", password: "x".repeat(6 * 1024 * 1024) });
    const response = await server.post("/api/auth/login", huge);
    assert.equal(response.status, 413);
  } finally {
    await server.stop();
  }
});

test("sign-in attempts from one address are capped with 429 and Retry-After", async () => {
  const server = await startServer(43322);
  try {
    const statuses = [];
    for (let i = 0; i < 21; i += 1) {
      statuses.push((await server.post("/api/auth/login", { email: `user${i}@example.com`, password: "wrong" })).status);
    }
    assert.ok(statuses.slice(0, 20).every((status) => status !== 429), "the first 20 attempts are not throttled");
    const last = await server.post("/api/auth/login", { email: "late@example.com", password: "wrong" });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get("retry-after")) > 0);
  } finally {
    await server.stop();
  }
});

test("registrations from one address are capped with 429", async () => {
  const server = await startServer(43323);
  try {
    for (let i = 0; i < 10; i += 1) {
      assert.notEqual((await server.post("/api/auth/register", { email: `new${i}@example.com`, password: "secret123" })).status, 429);
    }
    assert.equal((await server.post("/api/auth/register", { email: "one-more@example.com", password: "secret123" })).status, 429);
  } finally {
    await server.stop();
  }
});

test("the call-transcript webhook checks its token and still lets the right one in", async () => {
  // Налаштувати токен можна лише з сесією — тут локальний обхід входу.
  const server = await startServer(43324, { AUTH_DEV_BYPASS: "1" });
  try {
    const configured = await server.post("/api/integrations/transcripts/configure", { provider: "custom", apiToken: "transcript-secret-123" });
    assert.equal(configured.status, 200);
    const call = { prospectId: "no-such-prospect", transcript: "x".repeat(60) };
    assert.equal((await server.post("/api/webhooks/call-transcript", call)).status, 401);
    assert.equal((await server.post("/api/webhooks/call-transcript", call, { "x-webhook-token": "transcript-secret-12" })).status, 401);
    assert.equal((await server.post("/api/webhooks/call-transcript", call, { "x-webhook-token": "transcript-secret-1234" })).status, 401);
    // Правильний токен проходить перевірку: далі вже 404 «немає такого проспекта».
    assert.equal((await server.post("/api/webhooks/call-transcript", call, { Authorization: "Bearer transcript-secret-123" })).status, 404);
  } finally {
    await server.stop();
  }
});
