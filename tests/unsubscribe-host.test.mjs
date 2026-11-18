import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listeningOrigin } from "./server-origin.mjs";

// 619e88e4: u.<cold domain> points at this server for the unsubscribe link and
// /privacy. Nothing else of the workspace answers on it — not the sign-in, not the API.

const get = (origin, path, host) => new Promise((resolve, reject) => {
  const url = new URL(path, origin);
  const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { host } }, (response) => {
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, body }));
  });
  req.on("error", reject);
  req.end();
});

test("u.<domain>: /privacy and /u/<token> answer, the app and its API do not", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-uhost-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", STATE_FILE_PATH: join(directory, "state.json"), AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1", ESP_UNSUBSCRIBE_SECRET: "test-unsubscribe-secret-0123456789" },
    stdio: ["ignore", "pipe", "ignore"]
  });
  t.after(async () => { child.kill(); await rm(directory, { recursive: true, force: true }); });
  const origin = await listeningOrigin(child);
  const { signUnsubscribe } = await import("../esp/unsubscribe.mjs");
  const token = signUnsubscribe({ sender: "elena@trafboost.com", recipient: "jo@agency.co.uk" }, "test-unsubscribe-secret-0123456789");
  const host = "u.trafboost.com";
  const privacy = await get(origin, "/privacy", host);
  assert.equal(privacy.status, 200);
  assert.match(privacy.body, /handles your data/);
  const unsubscribe = await get(origin, `/u/${token}`, host);
  assert.equal(unsubscribe.status, 200);
  assert.match(unsubscribe.body, /Stop emails from elena@trafboost\.com to jo@agency\.co\.uk\?/);
  for (const path of ["/", "/api/esp/campaigns", "/index.html"]) assert.equal((await get(origin, path, host)).status, 404, path);
  assert.notEqual((await get(origin, "/", "outbound.example.com")).status, 404, "the workspace's own host is untouched");
});
