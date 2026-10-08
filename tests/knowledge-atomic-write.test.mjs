import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createKnowledgeFile,
  deleteKnowledgeFile,
  loadKnowledgeLibrary,
  readKnowledgeFile,
  updateKnowledgeFile
} from "../knowledge/library.mjs";

// Бібліотека знань — індекс і по файлу на документ. Індекс, обірваний
// посередині, не читається, завантажувач бере це за свіжий простір і засіває
// поверх — а всі файли, які написала команда, лишаються на диску без жодного
// рядка, що на них вказує. Тому кожен запис тут атомарний: у теці не буває
// тимчасових залишків, а індекс і файли завжди читаються цілими.

test("creating, editing and deleting a document leaves a whole index and no temp files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-knowledge-atomic-"));
  try {
    await loadKnowledgeLibrary(join(directory, "state.json"), () => ["p1"]);
    const created = await createKnowledgeFile({ name: "Умови", productIds: ["p1"], content: "перша версія", updatedBy: "тест" });
    await updateKnowledgeFile(created.id, { content: "друга версія" });
    const doomed = await createKnowledgeFile({ name: "Зайве", productIds: ["p1"], content: "зникне" });
    await deleteKnowledgeFile(doomed.id);

    const filesDir = join(directory, "knowledge", "files");
    const index = JSON.parse(await readFile(join(directory, "knowledge", "index.json"), "utf8"));
    assert.ok(index.files.some((file) => file.id === created.id), "створений документ є в індексі");
    assert.ok(!index.files.some((file) => file.id === doomed.id), "видалений документ з індексу пішов");
    assert.equal(await readFile(join(filesDir, `${created.id}.md`), "utf8"), "друга версія");
    assert.equal(readKnowledgeFile(created.id).content, "друга версія");

    const leftovers = [
      ...(await readdir(join(directory, "knowledge"))),
      ...(await readdir(filesDir))
    ].filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "після записів тимчасових файлів у теці немає");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
