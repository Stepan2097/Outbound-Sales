import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Profile screen is one endpoint over three new pieces of workspace state:
// a model on the profile, a user on every usage row, and seconds per day from
// the heartbeat. The two heartbeat rules are judgement calls, so they are
// tested as rules and not as implementation details.

const devUserId = "dev-user";

function dayKey(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}

function usageRow(overrides = {}) {
  return {
    id: `usage-test-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    taskType: "COLD_EMAIL",
    modelId: "anthropic/claude-haiku-4.5",
    provider: "openrouter",
    userId: devUserId,
    userEmail: "developer@localhost",
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 0.01,
    latencyMs: 700,
    fallback: false,
    schemaValidated: true,
    ...overrides
  };
}

async function startServer({ port, savedState = null, env = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-profile-test-"));
  const statePath = join(directory, "state.json");
  if (savedState) await writeFile(statePath, JSON.stringify(savedState), "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      ...env
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) break;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    origin,
    statePath,
    async get(path) {
      const response = await fetch(`${origin}${path}`);
      const payload = await response.json();
      return { status: response.status, payload };
    },
    async post(path, body) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      const payload = await response.json();
      return { status: response.status, payload };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("daily spend buckets cover thirty days, empty ones included, and only this person's real rows", async () => {
  const server = await startServer({
    port: 43261,
    savedState: {
      version: 1,
      users: [{
        id: devUserId,
        email: "developer@localhost",
        name: "Local Tester",
        role: "admin",
        status: "active",
        modelId: "anthropic/claude-sonnet-5",
        modelChosenAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }],
      usage: [
        usageRow({ at: `${dayKey(0)}T09:00:00.000Z`, costUsd: 0.25 }),
        usageRow({ at: `${dayKey(0)}T11:00:00.000Z`, costUsd: 0.25 }),
        usageRow({ at: `${dayKey(5)}T09:00:00.000Z`, costUsd: 0.5 }),
        // Outside the window: it counts all-time, never in a bucket.
        usageRow({ at: `${dayKey(45)}T09:00:00.000Z`, costUsd: 9 }),
        // Somebody else's spend.
        usageRow({ at: `${dayKey(1)}T09:00:00.000Z`, costUsd: 7, userId: "other-user", userEmail: "other@localhost" }),
        // A row written before usage carried a user at all: unattributed, and
        // readable rather than fatal.
        usageRow({ at: `${dayKey(1)}T10:00:00.000Z`, costUsd: 5, userId: undefined, userEmail: undefined })
      ]
    }
  });

  try {
    const { status, payload } = await server.get("/api/account/profile");
    assert.equal(status, 200);
    const { spend } = payload;

    assert.equal(spend.buckets.length, 30);
    assert.equal(spend.timeZone, "UTC");
    assert.equal(spend.buckets[29].date, dayKey(0));
    assert.equal(spend.buckets[0].date, dayKey(29));
    assert.equal(spend.from, dayKey(29));
    assert.equal(spend.to, dayKey(0));

    // Contiguous, one day apart, with nothing skipped.
    for (let index = 1; index < spend.buckets.length; index += 1) {
      const previous = Date.parse(`${spend.buckets[index - 1].date}T00:00:00.000Z`);
      const current = Date.parse(`${spend.buckets[index].date}T00:00:00.000Z`);
      assert.equal(current - previous, 86400000, `${spend.buckets[index - 1].date} -> ${spend.buckets[index].date}`);
    }

    const byDate = new Map(spend.buckets.map((bucket) => [bucket.date, bucket]));
    assert.equal(byDate.get(dayKey(0)).costUsd, 0.5);
    assert.equal(byDate.get(dayKey(0)).requests, 2);
    assert.equal(byDate.get(dayKey(5)).costUsd, 0.5);

    // The empty days are present and are zeros, not gaps.
    const empty = spend.buckets.filter((bucket) => bucket.requests === 0);
    assert.equal(empty.length, 28);
    for (const bucket of empty) {
      assert.equal(bucket.costUsd, 0);
      assert.equal(bucket.tokens, 0);
    }

    // Another person's row and the unattributed one are in neither the buckets
    // nor the window total.
    assert.equal(spend.totalCostUsd, 1);
    assert.equal(spend.requests, 3);
    assert.equal(spend.allTimeCostUsd, 10);

    // The model saved in workspace state came back with the profile.
    assert.equal(payload.model.modelId, "anthropic/claude-sonnet-5");
    assert.equal(payload.model.source, "user");
  } finally {
    await server.stop();
  }
});

test("a fabricated mock row never lands in a person's spend, even when it is attributed to them", async () => {
  const server = await startServer({ port: 43262 });

  try {
    const before = await server.get("/api/account/profile");
    assert.equal(before.payload.spend.requests, 0);
    assert.equal(before.payload.spend.allTimeCostUsd, 0);

    // A simulated run writes a usage row with provider "mock" while this user
    // is signed in — attributed, fabricated, and still not their money.
    const run = await server.post("/api/tasks/run", { taskType: "COLD_EMAIL", profile: "balanced" });
    assert.equal(run.status, 200);
    assert.equal(run.payload.run.provider, "mock");
    assert.equal(run.payload.run.usage.userId, devUserId);
    // The 18 seeded rows plus the new one are still visible to the workspace.
    assert.ok(run.payload.usage.length >= 19);

    const after = await server.get("/api/account/profile");
    assert.equal(after.payload.spend.requests, 0);
    assert.equal(after.payload.spend.totalCostUsd, 0);
    assert.equal(after.payload.spend.allTimeCostUsd, 0);
    assert.ok(after.payload.spend.buckets.every((bucket) => bucket.costUsd === 0));
  } finally {
    await server.stop();
  }
});

test("a tab left open overnight buys one heartbeat, not a working day", async () => {
  // One second of credit per beat makes the silence in this test stand for a
  // night: any gap longer than the cap is worth exactly the cap.
  const server = await startServer({ port: 43263, env: { ACTIVITY_MAX_CREDIT_SECONDS: "1" } });

  try {
    const first = await server.post("/api/account/heartbeat", { tabId: "tab-a" });
    assert.equal(first.status, 200);
    // The first beat starts the clock and invents nothing.
    assert.equal(first.payload.credited, 0);
    assert.equal(first.payload.seconds, 0);
    assert.equal(first.payload.maxCreditSeconds, 1);

    await new Promise((resolve) => setTimeout(resolve, 2200));

    const second = await server.post("/api/account/heartbeat", { tabId: "tab-a" });
    assert.equal(second.payload.credited, 1, "a 2.2s silence is worth the 1s cap");
    assert.equal(second.payload.seconds, 1);

    const profile = await server.get("/api/account/profile");
    assert.equal(profile.payload.time.todaySeconds, 1);
    assert.equal(profile.payload.time.totalSeconds, 1);
    assert.equal(profile.payload.time.activeDays, 1);
    assert.equal(profile.payload.time.buckets.length, 30);
    assert.equal(profile.payload.time.buckets[29].date, dayKey(0));
    assert.equal(profile.payload.time.buckets[0].seconds, 0);
  } finally {
    await server.stop();
  }
});

test("two open tabs count once, because the clock belongs to the person", async () => {
  const server = await startServer({ port: 43264 });

  try {
    const startedAt = Date.now();
    await server.post("/api/account/heartbeat", { tabId: "tab-a" });
    await server.post("/api/account/heartbeat", { tabId: "tab-b" });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const secondFromA = await server.post("/api/account/heartbeat", { tabId: "tab-a" });
    const secondFromB = await server.post("/api/account/heartbeat", { tabId: "tab-b" });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const thirdFromB = await server.post("/api/account/heartbeat", { tabId: "tab-b" });
    const thirdFromA = await server.post("/api/account/heartbeat", { tabId: "tab-a" });
    const elapsedSeconds = (Date.now() - startedAt) / 1000;

    // The tab that beats second finds the time already claimed.
    assert.ok(secondFromA.payload.credited >= 1, `first tab claimed ${secondFromA.payload.credited}s`);
    assert.ok(secondFromB.payload.credited < 0.25, `second tab claimed ${secondFromB.payload.credited}s`);
    assert.ok(thirdFromB.payload.credited >= 1, `first tab claimed ${thirdFromB.payload.credited}s`);
    assert.ok(thirdFromA.payload.credited < 0.25, `second tab claimed ${thirdFromA.payload.credited}s`);

    // Six beats from two tabs, and the day never exceeds the wall clock.
    assert.equal(thirdFromA.payload.openTabs, 2);
    assert.ok(
      thirdFromA.payload.seconds <= Math.ceil(elapsedSeconds),
      `${thirdFromA.payload.seconds}s counted for ${elapsedSeconds}s elapsed`
    );
    assert.ok(thirdFromA.payload.seconds >= 2);
  } finally {
    await server.stop();
  }
});

test("a user who has chosen no model falls back to the workspace default and can choose, clear, and be refused", async () => {
  const server = await startServer({ port: 43265 });

  try {
    const initial = await server.get("/api/account/profile");
    assert.equal(initial.status, 200);
    assert.equal(initial.payload.user.email, "developer@localhost");
    assert.equal(initial.payload.model.modelId, "");
    assert.equal(initial.payload.model.source, "workspace");
    // Nothing fails for want of a preference: the workspace default answers.
    assert.equal(initial.payload.model.effective.analysisModel, initial.payload.model.workspaceDefaults.analysisModel);
    assert.equal(initial.payload.model.effective.writingModel, initial.payload.model.workspaceDefaults.writingModel);
    assert.ok(initial.payload.model.effective.analysisModel.includes("/"));

    const chosen = await server.post("/api/account/model", { modelId: "openai/gpt-5-mini" });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.payload.model.modelId, "openai/gpt-5-mini");
    assert.equal(chosen.payload.model.source, "user");
    // One choice covers both kinds of call: it is the person's model, not a
    // pair of them.
    assert.equal(chosen.payload.model.effective.analysisModel, "openai/gpt-5-mini");
    assert.equal(chosen.payload.model.effective.writingModel, "openai/gpt-5-mini");

    const afterChoice = await server.get("/api/account/profile");
    assert.equal(afterChoice.payload.user.modelId, "openai/gpt-5-mini");

    const nonsense = await server.post("/api/account/model", { modelId: "не модель" });
    assert.equal(nonsense.status, 400);
    assert.match(nonsense.payload.error, /модель/i);

    // A fabricated model is not something a person can be billed against.
    const mock = await server.post("/api/account/model", { modelId: "mock/economy" });
    assert.equal(mock.status, 400);

    const cleared = await server.post("/api/account/model", { modelId: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.payload.model.modelId, "");
    assert.equal(cleared.payload.model.source, "workspace");
    assert.equal(cleared.payload.model.effective.analysisModel, cleared.payload.model.workspaceDefaults.analysisModel);
  } finally {
    await server.stop();
  }
});
