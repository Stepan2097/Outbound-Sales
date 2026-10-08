import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileOnceSync } from "../state/atomic-write.mjs";

// Ключ шифрування секретів — один файл, який створюється раз. Обрізаний ключ
// завантажувач відкидає, і сервер не стартує, доки файл не приберуть руками, тож
// створення має бути цілим або ніяким. А «хто перший створив, того й ключ»
// лишається: другий процес бачить EEXIST і читає чужий файл.

const key = "ab".repeat(32);

test("the key file is created whole, private, and leaves no temp file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-keyfile-"));
  try {
    const path = join(directory, ".secrets.key");
    createFileOnceSync(path, key, { mode: 0o600 });
    assert.equal(await readFile(path, "utf8"), key);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), [".secrets.key"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a file that already exists is not touched: EEXIST, and the first key stays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-keyfile-"));
  try {
    const path = join(directory, ".secrets.key");
    await writeFile(path, key);
    assert.throws(() => createFileOnceSync(path, "cd".repeat(32)), (error) => error.code === "EEXIST");
    assert.equal(await readFile(path, "utf8"), key);
    assert.deepEqual(await readdir(directory), [".secrets.key"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write that dies half-way leaves no key file at all, not a cut one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-keyfile-"));
  try {
    const path = join(directory, ".secrets.key");
    const full = {
      ...nodeFs,
      writeFileSync: (fd, data) => {
        nodeFs.writeSync(fd, String(data).slice(0, 10));
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
    };
    assert.throws(() => createFileOnceSync(path, key, { fs: full }), /ENOSPC/);
    assert.deepEqual(await readdir(directory), [], "ні ключа, ні тимчасового залишку");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a filesystem without hard links still gets its key, through the plain exclusive create", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-keyfile-"));
  try {
    const path = join(directory, ".secrets.key");
    const noLinks = { ...nodeFs, linkSync: () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); } };
    createFileOnceSync(path, key, { fs: noLinks });
    assert.equal(await readFile(path, "utf8"), key);
    assert.deepEqual(await readdir(directory), [".secrets.key"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
