import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listeningOrigin } from "./server-origin.mjs";

// AUTH_DEV_BYPASS віддає права admin будь-кому без входу. Локально це зручно,
// на проді — відчинені двері в CRM. Тест тримає обидві половини правила.

async function startServer(extraEnv) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dev-bypass-"));
  const env = { ...process.env, PORT: "0", STATE_FILE_PATH: join(directory, "state.json"), AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1" };
  delete env.APP_ENV;
  delete env.NODE_ENV;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  // Порт дає ОС; справжню адресу сервер друкує, коли почав слухати.
  const origin = await listeningOrigin(child);
  return {
    get: (path) => fetch(`${origin}${path}`),
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
  const server = await startServer({ NODE_ENV: "production" });
  try {
    const response = await server.get("/api/account/profile");
    assert.equal(response.status, 401, "an anonymous request must not get in");
    assert.match(server.stderr(), /AUTH_DEV_BYPASS=1 is ignored in production/);
  } finally {
    await server.stop();
  }
});

test("APP_ENV=production closes it too, whatever NODE_ENV says", async () => {
  const server = await startServer({ APP_ENV: "production", NODE_ENV: "development" });
  try {
    assert.equal((await server.get("/api/account/profile")).status, 401);
  } finally {
    await server.stop();
  }
});

test("locally AUTH_DEV_BYPASS still signs every request in as admin", async () => {
  const server = await startServer({});
  try {
    const response = await server.get("/api/account/profile");
    assert.equal(response.status, 200);
    assert.doesNotMatch(server.stderr(), /AUTH_DEV_BYPASS=1 is ignored/);
  } finally {
    await server.stop();
  }
});
