import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { knowledgeExcerptsForPrompt, knowledgeFilesForProduct, loadKnowledgeLibrary } from "../knowledge/library.mjs";

const port = 43211;
const origin = `http://127.0.0.1:${port}`;

test("the knowledge library seeds two projects, shares one file, and keeps files on disk", async () => {
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

    const seeded = await getJson("/api/knowledge/library");
    assert.deepEqual(seeded.projects.map((project) => project.name), ["AdAction", "advantage-course"]);
    const shared = seeded.files.find((file) => file.name === "Outbound-knowledge-base.md");
    const faq = seeded.files.find((file) => file.name.startsWith("FAQ"));
    // The playbook is one file in two projects, not two copies that drift apart.
    assert.deepEqual(shared.projectIds.sort(), ["adaction", "advantage-course"]);
    assert.deepEqual(faq.projectIds, ["advantage-course"]);

    const created = await postJson("/api/knowledge/library/files", {
      name: "Тон",
      projectIds: ["adaction"],
      content: "# Тон\nКоротко і без пафосу."
    });
    assert.equal(created.file.name, "Тон.md");
    // The document itself is a file on disk, readable without this app.
    const onDisk = await readFile(join(directory, "knowledge", "files", `${created.file.id}.md`), "utf8");
    assert.match(onDisk, /Коротко і без пафосу/);

    const edited = await postJson(`/api/knowledge/library/files/${created.file.id}`, {
      content: "# Тон\nОновлено.",
      projectIds: ["adaction", "advantage-course"]
    });
    assert.equal(edited.file.content, "# Тон\nОновлено.");
    assert.equal(
      await readFile(join(directory, "knowledge", "files", `${created.file.id}.md`), "utf8"),
      "# Тон\nОновлено."
    );

    // A file has to belong somewhere, or nothing would ever read it.
    const orphaned = await fetch(`${origin}/api/knowledge/library/files/${created.file.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: [] })
    });
    assert.equal(orphaned.status, 400);

    const project = (await postJson("/api/knowledge/library/projects", { name: "Разовий", productId: "outbound-sales-os" })).project;
    await postJson("/api/knowledge/library/files", { name: "тільки тут", projectIds: [project.id], content: "x" });
    const afterDelete = await postJson(`/api/knowledge/library/projects/${project.id}/delete`, {});
    // Deleting a project takes only the files that belonged to nothing else.
    assert.equal(afterDelete.deletedFileIds.length, 1);
    assert.ok(afterDelete.library.files.some((file) => file.name === "Outbound-knowledge-base.md"));
    assert.ok(afterDelete.library.files.some((file) => file.id === created.file.id));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("agents get passages from every file of their product's projects, within a budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-knowledge-prompt-"));
  try {
    await loadKnowledgeLibrary(join(directory, "state.json"));

    assert.deepEqual(
      knowledgeFilesForProduct("adaction-value-exchange-ua").map((file) => file.name),
      ["Outbound-knowledge-base.md"]
    );
    assert.equal(knowledgeFilesForProduct("black-affiliate").length, 2);
    // A product no project points at gets nothing, rather than somebody else's rules.
    assert.deepEqual(knowledgeExcerptsForPrompt("ai-revops-copilot", "anything"), []);

    const lead = { name: "Marcus Bell", title: "Head of User Acquisition", company: "Fleetify", notes: "facebook creatives, pwa funnel, deposits" };
    const excerpts = knowledgeExcerptsForPrompt("black-affiliate", lead);
    assert.equal(excerpts.length, 2, "both files of the course project must be represented");
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

async function getJson(path) {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.ok(response.ok, `${path} answered ${response.status}`);
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
