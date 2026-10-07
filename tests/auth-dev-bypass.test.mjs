import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// AUTH_DEV_BYPASS віддає права admin будь-кому без входу. Локально це зручно,
// на проді — відчинені двері в CRM. Тест тримає обидві половини правила.

async function startServer(port, extraEnv) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dev-bypass-"));
  const env = { ...process.env, PORT: String(port), STATE_FILE_PATH: join(directory, "state.json"), AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1" };
  delete env.APP_ENV;
  delete env.NODE_ENV;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    get: (path) => fetch(`http://127.0.0.1:${port}${path}`),
    stderr: () => stderr,
    stop: async () => {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("in production AUTH_DEV_BYPASS is ignored and the start logs why", async () => {
  const server = await startServer(43311, { NODE_ENV: "production" });
  try {
    const response = await server.get("/api/account/profile");
    assert.equal(response.status, 401, "an anonymous request must not get in");
    assert.match(server.stderr(), /AUTH_DEV_BYPASS=1 is ignored in production/);
  } finally {
    await server.stop();
  }
});

test("APP_ENV=production closes it too, whatever NODE_ENV says", async () => {
  const server = await startServer(43312, { APP_ENV: "production", NODE_ENV: "development" });
  try {
    assert.equal((await server.get("/api/account/profile")).status, 401);
  } finally {
    await server.stop();
  }
});

test("locally AUTH_DEV_BYPASS still signs every request in as admin", async () => {
  const server = await startServer(43313, {});
  try {
    const response = await server.get("/api/account/profile");
    assert.equal(response.status, 200);
    assert.doesNotMatch(server.stderr(), /AUTH_DEV_BYPASS=1 is ignored/);
  } finally {
    await server.stop();
  }
});
