import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * Тест не читає файл стану голим JSON.parse(readFile(...)).
 *
 * Колись сервер перезаписував файл через writeFile, який спершу обнуляє його, і
 * читач, що потрапив у цю мить, падав на «Unexpected end of JSON input». Тепер
 * запис атомарний (state/atomic-write.mjs), але читання лишається через
 * readSavedState (tests/saved-state.mjs), яка перечитує, доки файл не стане
 * цілим: так тест не залежить від того, як саме файл було записано.
 */

const DIR = new URL(".", import.meta.url);

test("жоден тест не парсить файл стану прямим читанням", () => {
  const offenders = [];
  for (const name of readdirSync(DIR).filter((item) => item.endsWith(".mjs") && item !== "no-racy-state-reads.test.mjs")) {
    readFileSync(new URL(name, DIR), "utf8").split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/JSON\.parse\(await readFile\(\s*[\w.]*[sS]tatePath\b/.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], "Читай стан через readSavedState(statePath) з ./saved-state.mjs.");
});
