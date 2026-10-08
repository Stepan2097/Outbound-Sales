import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readSavedState } from "./saved-state.mjs";

const run = promisify(execFile);

// Скрипт прибирає профілі з файлу стану, який тримає сервер. Файл він
// переписує цілком, тож пише його так само атомарно, як сервер, а перед цим
// лишає поруч копію попереднього стану.

test("removing a profile rewrites the state whole, keeps a backup and leaves no temp file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-remove-users-"));
  const statePath = join(directory, "state.json");
  try {
    const before = {
      version: 1,
      users: [
        { id: "u-admin", email: "boss@example.com", role: "admin" },
        { id: "u-typo", email: "typo@exmple.com", role: "member" }
      ],
      userActivity: { "u-typo": { seconds: 5 } }
    };
    await writeFile(statePath, JSON.stringify(before));

    await run(process.execPath, ["scripts/remove-workspace-users.mjs", "typo@exmple.com"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, STATE_FILE_PATH: statePath }
    });

    const after = await readSavedState(statePath);
    assert.deepEqual(after.users.map((user) => user.email), ["boss@example.com"]);
    assert.equal(after.userActivity["u-typo"], undefined);

    const names = await readdir(directory);
    assert.equal(names.filter((name) => name.endsWith(".tmp")).length, 0, "тимчасового файлу не лишилось");
    const backup = names.find((name) => name.startsWith("state.json.backup-"));
    assert.ok(backup, "копія попереднього стану лежить поруч");
    assert.deepEqual(JSON.parse(await readFile(join(directory, backup), "utf8")), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
