import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const port = 43199;
const origin = `http://127.0.0.1:${port}`;

test("FullEnrich webhooks are authenticated, approval-gated, and idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-enrichment-test-"));
  const statePath = join(directory, "state.json");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      FULLENRICH_API_KEY: "test-api-key",
      FULLENRICH_WEBHOOK_SECRET: "test-webhook-secret",
      FULLENRICH_WEBHOOK_BASE_URL: origin
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth();
    const page = await fetch(origin).then((response) => response.text());
    assert.match(page, /Verified Email \+ Phone/);

    const unauthorized = await fetch(`${origin}/api/webhooks/fullenrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [] })
    });
    assert.equal(unauthorized.status, 401);

    const payload = {
      id: "enrichment-test-1",
      data: [{
        custom: { prospect_id: "seed-maya-chen", request_id: "request-test-1" },
        contact: {
          work_emails: [{ email: "maya.chen@northstaranalytics.example", status: "DELIVERABLE" }],
          personal_emails: [{ email: "maya.personal@examplemail.com", status: "DELIVERABLE" }],
          phones: [{ number: "+1 512 555 0147", region: "US" }]
        }
      }]
    };
    const first = await postWebhook(payload);
    assert.deepEqual(first, { ok: true, processed: 1, candidatesAdded: 3, duplicatesIgnored: 0 });
    const duplicate = await postWebhook(payload);
    assert.deepEqual(duplicate, { ok: true, processed: 0, candidatesAdded: 0, duplicatesIgnored: 1 });

    await waitForFile(statePath);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    const prospect = saved.prospects.find((item) => item.id === "seed-maya-chen");
    const candidates = prospect.contactDiscovery.candidates.filter((item) => String(item.source).startsWith("fullenrich"));
    assert.equal(candidates.length, 3);
    assert.equal(candidates.find((item) => item.type === "phone").approvalStatus, "pending");
    assert.equal(candidates.find((item) => item.status === "deliverable_needs_permission_review").approvalStatus, "pending");
    assert.equal(candidates.find((item) => item.status === "personal_address_review").approvalStatus, "verification_required");
    assert.equal(prospect.researchHistory.filter((item) => item.stage === "verified_contact_enrichment").length, 1);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

async function postWebhook(payload) {
  const response = await fetch(`${origin}/api/webhooks/fullenrich?token=test-webhook-secret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start.");
}

async function waitForFile(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error("Persistent state was not written.");
}
