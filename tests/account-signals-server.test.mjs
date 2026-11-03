import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listeningOrigin } from "./server-origin.mjs";

// Таск 92abd9df, суддя 03.11 (кр. 2): продукт кампанії доходить до пошуку
// сигналів і для нового ліда, і для «Збагатити»; досьє, шукане під інший тип
// продукту, перешукується. Лід — без жодного слова про гемблінг у назві чи галузі.

const STUB = fileURLToPath(new URL("./stub-network.mjs", import.meta.url));
const LEAD = { id: "lead-kindred", name: "Anna Lind", company: "Kindred Group", title: "Head of Acquisition", score: 60, status: "new" };

async function startServer() {
  const directory = await mkdtemp(join(tmpdir(), "outbound-signals-test-"));
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
      STUB_ANTHROPIC_JSON: '{"signals":[]}',
      OPENROUTER_BASE_URL: "http://stub.invalid/v1",
      PORT: "0",
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      ANTHROPIC_ENRICH_MODEL: "",
      OPENROUTER_API_KEY: "",
      APIFY_API_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = await listeningOrigin(child);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* ще піднімається */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    async enrich(body) {
      const response = await fetch(`${origin}/api/prospects/enrich`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prospectId: LEAD.id, force: true, ...body }) });
      assert.equal(response.status, 200);
    },
    async briefs() {
      return (await readFile(logPath, "utf8")).split("\n").filter((line) => line.startsWith("anthropic web_search brief="));
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("a lead with no gambling word is searched for the campaign's product; a product of another kind searches again", async () => {
  const server = await startServer();
  try {
    // No product chosen: the team's «Смисли» catalogue (iGaming) decides — licences, affiliate hiring, SiGMA.
    await server.enrich({});
    let briefs = await server.briefs();
    assert.equal(briefs.length, 1, "one signal search");
    assert.match(briefs[0], /Kindred Group/);
    assert.match(briefs[0], /licen/i);
    assert.match(briefs[0], /affiliate manager/);
    assert.match(briefs[0], /SiGMA/);
    assert.doesNotMatch(briefs[0], /IDFA|AppsFlyer/);

    // «FB аудит» is not an operator product: searched again, for that.
    await server.enrich({ productId: "fb-audit" });
    briefs = await server.briefs();
    assert.equal(briefs.length, 2, "the product changed kind — searched again");
    assert.doesNotMatch(briefs[1], /licen/i);

    // Back to an iGaming product: the generic signals do not fit — searched again, for operators.
    await server.enrich({ productId: "google-playbook" });
    briefs = await server.briefs();
    assert.equal(briefs.length, 3);
    assert.match(briefs[2], /licen/i);
  } finally {
    await server.stop();
  }
});
