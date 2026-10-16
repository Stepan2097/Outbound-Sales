import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readSavedState } from "./saved-state.mjs";
import { listeningOrigin } from "./server-origin.mjs";

// Збагачення лідів через Anthropic напряму (власник 16.10 купив кредити).
//
// Правила, які тут перевіряються:
//   • є ANTHROPIC_API_KEY — етапи збагачення (кваліфікація, досьє, опис
//     клієнта) йдуть на api.anthropic.com з x-api-key і anthropic-version,
//     модель — ANTHROPIC_ENRICH_MODEL або claude-haiku-5-5;
//   • ключа немає — OpenRouter, рівно як і було;
//   • письмо й інші функції лишаються на OpenRouter навіть із ключем;
//   • Anthropic відповів помилкою, а OpenRouter є — лід однаково збагачується.

const STUB = fileURLToPath(new URL("./stub-network.mjs", import.meta.url));

const LEAD = {
  id: "lead-claude",
  name: "Olena Test",
  company: "Harbor Interactive",
  title: "Head of User Acquisition",
  website: "harborinteractive.example",
  score: 60,
  status: "new"
};

const MODEL_JSON = JSON.stringify({ summary: "Stub summary", account_summary: "Stub account", fit_score: 70 });

async function startServer(env = {}) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-anthropic-test-"));
  const statePath = join(directory, "state.json");
  const logPath = join(directory, "network.log");
  await writeFile(statePath, JSON.stringify({ version: 1, prospects: [LEAD], interactions: [] }), "utf8");
  await writeFile(logPath, "", "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${STUB}`,
      STUB_NETWORK_LOG: logPath,
      STUB_OPENROUTER_JSON: MODEL_JSON,
      OPENROUTER_BASE_URL: "http://stub.invalid/v1",
      PORT: "0",
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      // Нічого з оточення того, хто запускає тести.
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_ENRICH_MODEL: "",
      OPENROUTER_API_KEY: "",
      ...env
    },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = await listeningOrigin(child);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break;
    } catch { /* ще піднімається */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    async post(path, body) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {})
      });
      return { status: response.status, payload: await response.json() };
    },
    async saved() {
      return readSavedState(statePath);
    },
    async calls() {
      const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
      return {
        anthropic: lines.filter((line) => line.startsWith("anthropic ")),
        openrouterChat: lines.filter((line) => line === "openrouter chat"),
        unexpected: lines.filter((line) => line.startsWith("НЕОЧІКУВАНА"))
      };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function analyze(server) {
  const result = await server.post("/api/prospects/intelligence/analyze", { prospectId: LEAD.id, force: true });
  assert.equal(result.status, 200, JSON.stringify(result.payload).slice(0, 300));
  return result;
}

test("з ANTHROPIC_API_KEY збагачення йде на api.anthropic.com, модель за замовчуванням — claude-haiku-5-5", async () => {
  const server = await startServer({ ANTHROPIC_API_KEY: "test-anthropic-key" });
  try {
    await analyze(server);
    const calls = await server.calls();
    assert.deepEqual(calls.unexpected, []);
    assert.equal(calls.openrouterChat.length, 0, "OpenRouter не мав викликатись");
    assert.equal(calls.anthropic.length, 1, `очікувався один виклик Anthropic: ${calls.anthropic.join(" | ")}`);
    const line = calls.anthropic[0];
    assert.match(line, /model=claude-haiku-5-5 /);
    assert.match(line, /version=2023-06-01 /);
    assert.match(line, /key=present /);
    // Системний промпт — окремим полем, а в messages лише user/assistant.
    assert.match(line, /system=yes roles=user /);
    // Haiku 5.5 відхиляє нестандартну temperature — її не шлемо.
    assert.match(line, /temperature=none$/);
    const saved = await server.saved();
    assert.equal(saved.prospects[0].leadIntelligence?.model?.provider, "anthropic");
    assert.equal(saved.prospects[0].leadIntelligence?.model?.model, "claude-haiku-5-5");
  } finally {
    await server.stop();
  }
});

test("ANTHROPIC_ENRICH_MODEL міняє модель збагачення", async () => {
  const server = await startServer({ ANTHROPIC_API_KEY: "test-anthropic-key", ANTHROPIC_ENRICH_MODEL: "claude-sonnet-5-5" });
  try {
    await analyze(server);
    const calls = await server.calls();
    assert.equal(calls.anthropic.length, 1);
    assert.match(calls.anthropic[0], /model=claude-sonnet-5-5 /);
  } finally {
    await server.stop();
  }
});

test("без ANTHROPIC_API_KEY збагачення йде через OpenRouter, як і раніше", async () => {
  const server = await startServer({ OPENROUTER_API_KEY: "test-openrouter-key" });
  try {
    const health = await server.post("/api/openrouter/test", {});
    assert.equal(health.payload.providerHealth.status, "healthy");
    await analyze(server);
    const calls = await server.calls();
    assert.deepEqual(calls.unexpected, []);
    assert.equal(calls.anthropic.length, 0);
    assert.equal(calls.openrouterChat.length, 1);
    assert.equal((await server.saved()).prospects[0].leadIntelligence?.model?.provider, "openrouter");
  } finally {
    await server.stop();
  }
});

test("з ключем Anthropic інші функції (AI-оператор) лишаються на OpenRouter", async () => {
  const server = await startServer({ ANTHROPIC_API_KEY: "test-anthropic-key", OPENROUTER_API_KEY: "test-openrouter-key" });
  try {
    const health = await server.post("/api/openrouter/test", {});
    assert.equal(health.payload.providerHealth.status, "healthy");
    const result = await server.post("/api/assistant/task", { instruction: "наведи лад у лідах", scope: "all" });
    assert.equal(result.status, 200);
    const calls = await server.calls();
    assert.equal(calls.anthropic.length, 0, `не-збагачення пішло в Anthropic: ${calls.anthropic.join(" | ")}`);
    assert.ok(calls.openrouterChat.length >= 1);
  } finally {
    await server.stop();
  }
});

test("Anthropic відповів 401, а OpenRouter є — лід однаково збагачується через OpenRouter", async () => {
  const server = await startServer({
    ANTHROPIC_API_KEY: "bad-anthropic-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
    STUB_ANTHROPIC_STATUS: "401"
  });
  try {
    const health = await server.post("/api/openrouter/test", {});
    assert.equal(health.payload.providerHealth.status, "healthy");
    await analyze(server);
    const calls = await server.calls();
    assert.equal(calls.anthropic.length, 1);
    assert.equal(calls.openrouterChat.length, 1);
    assert.equal((await server.saved()).prospects[0].leadIntelligence?.model?.provider, "openrouter");
  } finally {
    await server.stop();
  }
});
