import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { knowledgeExcerptsForPrompt, knowledgeFilesForProduct, loadKnowledgeLibrary } from "../knowledge/library.mjs";

const port = 43211;
const origin = `http://127.0.0.1:${port}`;
const briefPort = 43212;
const briefOrigin = `http://127.0.0.1:${briefPort}`;

test("the knowledge library seeds two products, shares one file, and keeps files on disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-knowledge-test-"));
  const statePath = join(directory, "state.json");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), STATE_FILE_PATH: statePath, AUTH_DEV_BYPASS: "1" },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));

  try {
    await waitForHealth();

    // The workspace sells two things, and the chooser says so.
    const workspace = await getJson("/api/state");
    assert.deepEqual(
      workspace.products.map((product) => product.id).sort(),
      ["adaction-value-exchange-ua", "black-affiliate"]
    );
    assert.deepEqual(
      workspace.products.map((product) => product.name).sort(),
      ["AdAction", "advantage-course"]
    );

    const seeded = await getJson("/api/knowledge/library");
    const shared = seeded.files.find((file) => file.name === "Outbound-knowledge-base.md");
    const faq = seeded.files.find((file) => file.name.startsWith("FAQ"));
    // The playbook is one file for both products, not two copies that drift apart.
    assert.deepEqual(shared.productIds.slice().sort(), ["adaction-value-exchange-ua", "black-affiliate"]);
    assert.deepEqual(faq.productIds, ["black-affiliate"]);

    const created = await postJson("/api/knowledge/library/files", {
      name: "Тон",
      productIds: ["adaction-value-exchange-ua"],
      content: "# Тон\nКоротко і без пафосу."
    });
    assert.equal(created.file.name, "Тон.md");
    // The document itself is a file on disk, readable without this app.
    const onDisk = await readFile(join(directory, "knowledge", "files", `${created.file.id}.md`), "utf8");
    assert.match(onDisk, /Коротко і без пафосу/);

    const edited = await postJson(`/api/knowledge/library/files/${created.file.id}`, {
      content: "# Тон\nОновлено.",
      productIds: ["adaction-value-exchange-ua", "black-affiliate"]
    });
    assert.equal(edited.file.content, "# Тон\nОновлено.");
    assert.equal(
      await readFile(join(directory, "knowledge", "files", `${created.file.id}.md`), "utf8"),
      "# Тон\nОновлено."
    );

    // A file has to belong to a product, or nothing would ever read it, and a
    // product that does not exist is not one.
    for (const productIds of [[], ["no-such-product"]]) {
      const refused = await fetch(`${origin}/api/knowledge/library/files/${created.file.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds })
      });
      assert.equal(refused.status, 400);
    }

    const removed = await postJson(`/api/knowledge/library/files/${created.file.id}/delete`, {});
    assert.equal(removed.deletedFileId, created.file.id);
    assert.ok(removed.library.files.some((file) => file.name === "Outbound-knowledge-base.md"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("agents get passages from every file of their product, within a budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-knowledge-prompt-"));
  try {
    await loadKnowledgeLibrary(
      join(directory, "state.json"),
      () => ["adaction-value-exchange-ua", "black-affiliate"]
    );

    assert.deepEqual(
      knowledgeFilesForProduct("adaction-value-exchange-ua").map((file) => file.name),
      ["Outbound-knowledge-base.md"]
    );
    assert.equal(knowledgeFilesForProduct("black-affiliate").length, 2);
    // A product with no files of its own gets nothing, rather than somebody else's rules.
    assert.deepEqual(knowledgeExcerptsForPrompt("some-other-product", "anything"), []);

    const lead = { name: "Marcus Bell", title: "Head of User Acquisition", company: "Fleetify", notes: "facebook creatives, pwa funnel, deposits" };
    const excerpts = knowledgeExcerptsForPrompt("black-affiliate", lead);
    assert.equal(excerpts.length, 2, "both files of the course must be represented");
    for (const file of excerpts) {
      assert.ok(file.passages.length >= 1);
      // Whole documents are tens of thousands of characters; a prompt gets passages.
      assert.ok(file.passages.join("").length < 6000);
    }
    const total = excerpts.reduce((sum, file) => sum + file.passages.join("").length, 0);
    assert.ok(total <= 6000, `budget respected, got ${total}`);
    assert.ok(total > 2000, `enough context to be useful, got ${total}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the product brief is what the rest of the workspace reads a product from", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-brief-test-"));
  const statePath = join(directory, "state.json");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(briefPort), STATE_FILE_PATH: statePath, AUTH_DEV_BYPASS: "1" },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));

  try {
    await waitForHealth(briefOrigin);

    const saved = await postJson("/api/products/brief", {
      productId: "adaction-value-exchange-ua",
      name: "AdAction",
      brief: {
        offer: "Реклама value-exchange для застосунків. Платимо за подію, не за покази.",
        icp: "Студії мобільних ігор, 20+ людей\nРинки: US, UK, DACH",
        buyers: "Head of UA — вартість інсталу\nCMO — передбачуваність бюджету",
        pain: "Канали вигоряють, CPI росте\nЗагострюється після релізу",
        proof: "Студія на 60 людей: 40% інсталів за два квартали",
        firstStep: "Тест на одну країну і одну подію",
        objections: "«Rewarded гірший» — розділяємо платіжну подію і якість",
        limits: "Не працюємо з дитячими застосунками\nНе обіцяємо ROAS"
      }
    }, briefOrigin);

    const product = saved.products.find((item) => item.id === "adaction-value-exchange-ua");
    // Eight answers in, and everything the writing and scoring paths already
    // read comes back out of them.
    assert.match(product.positioning, /value-exchange/i);
    assert.deepEqual(product.targetPersonas, ["Head of UA — вартість інсталу", "CMO — передбачуваність бюджету"]);
    assert.deepEqual(product.proofPoints, ["Студія на 60 людей: 40% інсталів за два квартали"]);
    assert.deepEqual(product.memory.segments.idealCustomers, ["Студії мобільних ігор, 20+ людей", "Ринки: US, UK, DACH"]);
    // One answer guards two different things in the prompts.
    assert.deepEqual(product.memory.segments.exclusions, product.memory.segments.claimsToAvoid);
    assert.equal(product.memory.status, "trained");
    assert.equal(product.memory.confidence, 100);

    // An empty brief is a refusal, not a product wiped clean.
    const refused = await fetch(`${briefOrigin}/api/products/brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: "adaction-value-exchange-ua", brief: {} })
    });
    assert.equal(refused.status, 400);

    await waitForFile(statePath);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    const persistedProduct = persisted.products.find((item) => item.id === "adaction-value-exchange-ua");
    assert.match(persistedProduct.brief.offer, /value-exchange/i);
    // The three demo products the first version shipped with are gone for good.
    assert.deepEqual(persisted.products.map((item) => item.id).sort(), ["adaction-value-exchange-ua", "black-affiliate"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  // Written is not the same as restored. A restore that throws is caught and
  // logged, and the workspace silently opens on seed data with every answer
  // gone — so the brief is asked for again from a second process.
  const second = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(briefPort), STATE_FILE_PATH: statePath, AUTH_DEV_BYPASS: "1" },
    stdio: "ignore"
  });
  const secondExit = new Promise((resolve) => second.once("exit", resolve));
  try {
    await waitForHealth(briefOrigin);
    const restored = await fetch(`${briefOrigin}/api/state`).then((response) => response.json());
    const product = restored.products.find((item) => item.id === "adaction-value-exchange-ua");
    assert.match(product.brief.offer, /value-exchange/i, "the brief must survive a restart");
    assert.equal(product.memory.status, "trained");
    assert.ok(
      restored.events.every((event) => !/could not be loaded/i.test(event.text)),
      "the saved workspace must load without an error event"
    );
  } finally {
    if (second.exitCode === null && second.signalCode === null) second.kill("SIGTERM");
    await Promise.race([secondExit, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function getJson(path) {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function postJson(path, body, base = origin) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.ok(response.ok, `${path} answered ${response.status}`);
  return response.json();
}

async function waitForHealth(base = origin) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
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
      const saved = JSON.parse(await readFile(path, "utf8"));
      if (Array.isArray(saved.products)) return;
    } catch {
      // Still being written.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Persistent state was not written.");
}
