import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeFileAtomic } from "../state/atomic-write.mjs";

// Стан робочого простору — один JSON-файл. Обрив посередині запису не має
// лишати його обрізаним: на місці завжди або стара, або нова версія.

const previous = JSON.stringify({ version: 1, prospects: [{ id: "kept" }] });

test("a write that fails half-way leaves the previous state and no temp file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-atomic-"));
  const path = join(directory, "state.json");
  try {
    await writeFile(path, previous);
    const failingFs = {
      open: async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith(".tmp")) {
          // Пишемо половину і «падаємо» — як закінчене місце на диску.
          handle.writeFile = async (data) => {
            await handle.write(String(data).slice(0, Math.floor(String(data).length / 2)));
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          };
        }
        return handle;
      },
      rename,
      unlink
    };
    await assert.rejects(writeFileAtomic(path, JSON.stringify({ version: 1, prospects: new Array(500).fill({ id: "new" }) }), { fs: failingFs }), /ENOSPC/);
    assert.equal(await readFile(path, "utf8"), previous);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a process killed mid-write leaves a state that still parses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-atomic-kill-"));
  const path = join(directory, "state.json");
  try {
    await writeFile(path, previous);
    // Окремий процес безперервно пише великий стан; вбиваємо його SIGKILL —
    // так само, як рестарт контейнера посеред запису.
    const writer = spawn(process.execPath, ["--input-type=module", "-e", `
      import { writeFileAtomic } from ${JSON.stringify(new URL("../state/atomic-write.mjs", import.meta.url).href)};
      const big = JSON.stringify({ version: 1, prospects: Array.from({ length: 200000 }, (_, i) => ({ id: "p" + i, note: "x".repeat(40) })) });
      process.stdout.write("ready\\n");
      for (;;) await writeFileAtomic(${JSON.stringify(path)}, big);
    `], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => writer.stdout.once("data", resolve));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const exited = new Promise((resolve) => writer.once("exit", resolve));
    writer.kill("SIGKILL");
    await exited;
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.version, 1);
    assert.ok(saved.prospects.length === 1 || saved.prospects.length === 200000, "either the old or the new state, never a cut one");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a successful write replaces the file and leaves nothing behind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-atomic-ok-"));
  const path = join(directory, "state.json");
  try {
    await writeFile(path, previous);
    await writeFileAtomic(path, JSON.stringify({ version: 1, prospects: [] }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).prospects, []);
    assert.deepEqual(await readdir(directory), ["state.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Docker image copies every local folder server.mjs imports", async () => {
  const root = new URL("..", import.meta.url);
  const server = await readFile(new URL("server.mjs", root), "utf8");
  const dockerfile = await readFile(new URL("Dockerfile", root), "utf8");
  const folders = new Set([...server.matchAll(/from "\.\/([^/"]+)\//g)].map((match) => match[1]));
  for (const folder of folders) {
    assert.match(dockerfile, new RegExp(`^COPY ${folder} \\./${folder}$`, "m"), `Dockerfile does not copy ./${folder}`);
  }
});
