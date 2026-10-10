import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * Усе, що сервер і скрипти пишуть на диск як стан, пишеться атомарно.
 *
 * `writeFile` спершу обрізає файл, тож обрив посередині — рестарт контейнера,
 * OOM, повний диск — лишає половину JSON. Для стану робочого простору це втрата
 * всього, для індексу бібліотеки знань — втрата зв'язку з усіма файлами.
 * Атомарний запис живе в state/atomic-write.mjs (сервер) і
 * agent/lib/atomic-write.mjs (агент, який збирається в окремий образ).
 *
 * Новий прямий запис у цих теках червонить збірку. Якщо файл і справді не стан
 * — як звіт одного запуску, — він іде в перелік нижче з причиною.
 */

const ROOT = new URL("../", import.meta.url);
const WRITE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(/;

/** Місця, де прямий запис залишено свідомо, і чому. */
const ALLOWED = {
  "agent/run-account.mjs": "result.json — звіт одного запуску, його перезаписує наступний, читача в коді немає",
  "agent/launchagent.mjs": "plist для launchd — одноразова команда, яку можна просто запустити ще раз"
};

function sources() {
  const found = ["server.mjs"];
  for (const folder of ["knowledge", "contacts", "warmup", "scripts", "state", "agent", "agent/lib", "esp"]) {
    for (const name of readdirSync(new URL(`${folder}/`, ROOT))) {
      if (!name.endsWith(".mjs")) continue;
      if (/\.(test|probe)\.mjs$/.test(name) || name === "atomic-write.mjs") continue;
      found.push(`${folder}/${name}`);
    }
  }
  return found;
}

test("жоден файл стану не пишеться напряму через writeFile", () => {
  const files = sources();
  assert.ok(files.length > 30, `знайдено лише ${files.length} файлів — перевірка, схоже, зламалась`);
  const offenders = [];
  const used = new Set();
  for (const file of files) {
    readFileSync(new URL(file, ROOT), "utf8").split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || !WRITE.test(line)) return;
      if (ALLOWED[file]) used.add(file);
      else offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "Пиши через writeFileAtomic (state/atomic-write.mjs) або writeFileAtomicSync (agent/lib/atomic-write.mjs)."
  );
  assert.deepEqual([...used].sort(), Object.keys(ALLOWED).sort(), "у переліку винятків лишився файл, де прямого запису вже немає");
});
