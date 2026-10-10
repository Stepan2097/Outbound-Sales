import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { listeningOrigin } from "./server-origin.mjs";
import { readSavedState } from "./saved-state.mjs";

const productId = "adaction-value-exchange-ua";
const prospect = (id, name) => ({
  id, name, company: "Northwind Games", title: "Head of Growth", website: "northwind.example",
  linkedin: `https://www.linkedin.com/in/${id}`,
  researchHistory: [{ productId, stage: "completed", at: "2025-01-01T00:00:00.000Z" }]
});
const interaction = (id, prospectId, at, type = "note_added") => ({ id, prospectId, at, type, outcome: "", note: id });
const ids = (rows) => rows.map((row) => row.id);
const lead = (state, id) => state.prospects.find((row) => row.id === id);

async function boot(t, saved) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-public-state-"));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({ version: 1, ...saved }));
  const child = spawn(process.execPath, ["--import", new URL("./stub-network.mjs", import.meta.url).pathname, "server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env, PORT: "0", STATE_FILE_PATH: statePath, AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1",
      OPENROUTER_API_KEY: "", OPENROUTER_ANALYSIS_MODEL: "", OPENROUTER_WRITING_MODEL: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  const origin = await listeningOrigin(child);
  return {
    file: () => readSavedState(statePath),
    async request(path, body) {
      const response = await fetch(origin + path, body ? {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      } : undefined);
      const payload = await response.json();
      assert.equal(response.status, 200, `${JSON.stringify(payload)} ${errors}`);
      return payload;
    }
  };
}

test("public state groups each lead's history newest first without reordering the journal, and includes the next interaction immediately", async (t) => {
  // Intentionally mixed and unsorted, including equal timestamps and an orphan.
  // Grouping the projection must not sort or drop rows in the source journal.
  const journal = [
    interaction("a-old", "lead-a", "2025-01-01T09:00:00.000Z"),
    interaction("b-new", "lead-b", "2025-01-03T09:00:00.000Z", "linkedin_profile_viewed"),
    interaction("a-new", "lead-a", "2025-01-04T09:00:00.000Z"),
    interaction("b-old", "lead-b", "2025-01-02T09:00:00.000Z"),
    interaction("orphan", "removed-lead", "2025-01-05T09:00:00.000Z"),
    interaction("a-tie", "lead-a", "2025-01-04T09:00:00.000Z")
  ];
  const server = await boot(t, { prospects: [prospect("lead-a", "Olena Kravets"), prospect("lead-b", "Ihor Sydir")], interactions: journal });
  const first = await server.request("/api/state");
  assert.deepEqual(ids(lead(first, "lead-a").interactions), ["a-new", "a-tie", "a-old"]);
  assert.deepEqual(ids(lead(first, "lead-b").interactions), ["b-new", "b-old"]);
  assert.deepEqual(ids(first.interactions), ids(journal));
  assert.equal(lead(first, "lead-a").analysis.scoreInputs.engagement, 0);
  const otherEngagement = lead(first, "lead-b").analysis.scoreInputs.engagement;
  assert.ok(otherEngagement > 0, "The researched lead must exercise analysis, not the pending-research placeholder");

  const changed = await server.request("/api/prospects/interaction", {
    prospectId: "lead-a", type: "linkedin_reply", channel: "linkedin", outcome: "replied", note: "Fresh reply", syncCrm: false
  });
  const made = changed.interactions[0];
  assert.equal(made.note, "Fresh reply");
  assert.equal(made.prospectId, "lead-a");
  assert.deepEqual(ids(lead(changed, "lead-a").interactions), [made.id, "a-new", "a-tie", "a-old"]);
  assert.ok(lead(changed, "lead-a").analysis.scoreInputs.engagement > 0, "Analysis reused the previous projection's interaction group");
  assert.deepEqual(ids(lead(changed, "lead-b").interactions), ["b-new", "b-old"]);
  assert.equal(lead(changed, "lead-b").analysis.scoreInputs.engagement, otherEngagement);
  assert.deepEqual(ids(changed.interactions), [made.id, ...ids(journal)]);

  const again = await server.request("/api/state");
  assert.deepEqual(ids(lead(again, "lead-a").interactions), ids(lead(changed, "lead-a").interactions));
  assert.deepEqual(ids(lead(again, "lead-b").interactions), ["b-new", "b-old"]);
  assert.deepEqual(ids(again.interactions), [made.id, ...ids(journal)]);
  assert.deepEqual(ids((await server.file()).interactions), [made.id, ...ids(journal)], "Projection sorting changed the persisted journal");
});

test("a failed projection cannot leave a partial interaction lookup active for later analysis", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const declaration = (name) => {
    const start = source.indexOf(`\nfunction ${name}(`);
    assert.ok(start >= 0, `Missing ${name}`);
    const end = source.indexOf("\n}", start);
    return source.slice(start + 1, end + 2);
  };
  const badRow = { at: "2025-01-01T00:00:00.000Z", get prospectId() { throw new Error("Cannot read interaction owner"); } };
  const state = { interactions: [badRow] };
  const context = vm.createContext({ state });
  vm.runInContext(`let publicInteractionGroups = null;\n${declaration("publicState")}\n${declaration("interactionsForProspect")}`, context);
  assert.throws(() => vm.runInContext("publicState()", context), /Cannot read interaction owner/);
  // This uses the real consumer after the failure: it must see today's state,
  // not an empty or partially built lookup left by the unsuccessful response.
  state.interactions = [interaction("fresh", "lead-a", "2025-01-02T00:00:00.000Z")];
  assert.deepEqual(Array.from(vm.runInContext("interactionsForProspect('lead-a')", context), (row) => row.id), ["fresh"]);
});
