import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listeningOrigin } from "./server-origin.mjs";

// Ключ, введений у Settings, має пережити рестарт (а на проді — деплой).
// Раніше ключ шифрування генерувався на кожному старті, а самі сховища в
// стан не писались, тож після рестарту інтеграція мовчки лишалась без ключа.

async function startServer(directory, extraEnv = {}) {
  const env = { ...process.env };
  for (const name of ["OUTBOUND_SECRETS_KEY", "NODE_ENV", "APP_ENV", "FULLENRICH_API_KEY", "FULLENRICH_WEBHOOK_SECRET"]) delete env[name];
  Object.assign(env, { PORT: "0", STATE_FILE_PATH: join(directory, "state.json"), AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1" }, extraEnv);
  const child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "ignore"] });
  // Порт дає ОС; справжню адресу сервер друкує, коли почав слухати.
  const origin = await listeningOrigin(child);
  return {
    origin,
    post: (path, body, headers = {}) => fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    }),
    stop: async () => {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
  };
}

async function savedState(directory, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      if (predicate(saved)) return saved;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("state was not written");
}

test("a key entered in Settings still works after a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-secrets-"));
  const call = { prospectId: "no-such-prospect", transcript: "x".repeat(60) };
  try {
    const first = await startServer(directory);
    assert.equal((await first.post("/api/integrations/transcripts/configure", { provider: "custom", apiToken: "transcript-secret-123" })).status, 200);
    const saved = await savedState(directory, (state) => state.secretVaults?.transcriptVault);
    // На диску — лише шифротекст.
    assert.doesNotMatch(JSON.stringify(saved), /transcript-secret-123/);
    await first.stop();

    const keyFile = await stat(join(directory, ".secrets.key"));
    assert.equal(keyFile.mode & 0o777, 0o600);

    const second = await startServer(directory);
    try {
      assert.equal((await second.post("/api/webhooks/call-transcript", call, { "x-webhook-token": "wrong" })).status, 401);
      // Після рестарту той самий ключ проходить перевірку (далі 404 — немає проспекта).
      assert.equal((await second.post("/api/webhooks/call-transcript", call, { "x-webhook-token": "transcript-secret-123" })).status, 404);
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keys that come from env are not written to disk and keep working", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-secrets-env-"));
  try {
    const server = await startServer(directory, { FULLENRICH_API_KEY: "env-api-key", FULLENRICH_WEBHOOK_SECRET: "env-webhook-secret", FULLENRICH_WEBHOOK_BASE_URL: "https://outbound.example" });
    try {
      assert.equal((await server.post("/api/integrations/transcripts/configure", { provider: "custom", apiToken: "transcript-secret-456" })).status, 200);
      const saved = await savedState(directory, (state) => state.secretVaults?.transcriptVault);
      assert.equal(saved.secretVaults.contactEnrichmentVault, undefined);
      assert.equal(saved.secretVaults.contactEnrichmentWebhookVault, undefined);
      const webhook = await server.post("/api/webhooks/fullenrich", { id: "env-check", data: [] }, { "x-webhook-token": "env-webhook-secret" });
      assert.equal(webhook.status, 200);
    } finally {
      await server.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OUTBOUND_SECRETS_KEY from env replaces the key file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-secrets-envkey-"));
  try {
    const server = await startServer(directory, { OUTBOUND_SECRETS_KEY: "an-operator-provided-key" });
    await server.stop();
    await assert.rejects(stat(join(directory, ".secrets.key")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
