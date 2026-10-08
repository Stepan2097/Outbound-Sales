import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * Тести не беруть портів із голови.
 *
 * Фіксовані порти 43xxx били два чати, що ганяли npm test одночасно, і давали
 * хибні червоні — «збагачення не шукається вдруге» падало через тест вебхука,
 * який взяв те саме число (так сталося двічі за один день, і двічі це були
 * обидва чати, що вибрали «наступний вільний номер»). Тепер кожен тест
 * запускає сервер з PORT=0 і читає справжню адресу з його виводу
 * (tests/server-origin.mjs). Цей файл не дає старому звичаю повернутись:
 * новий тест із фіксованим портом червонить збірку, а не чекає чергової
 * збіжності.
 */

const DIR = new URL(".", import.meta.url);
const SELF = "no-fixed-ports.test.mjs";

const files = readdirSync(DIR)
  .filter((name) => name.endsWith(".mjs") && name !== SELF)
  .map((name) => ({ name, text: readFileSync(new URL(name, DIR), "utf8") }));

test("жоден тест не містить фіксованого порту", () => {
  assert.ok(files.length > 20, `знайдено лише ${files.length} файлів тестів — перевірка, схоже, зламалась`);
  const offenders = [];
  for (const { name, text } of files) {
    text.split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\b43\d{3}\b/.test(line)) offenders.push(`${name}:${index + 1}: число з діапазону 43xxx — ${line.trim().slice(0, 80)}`);
      if (/(?:127\.0\.0\.1|localhost):\d{4,5}\b/.test(line)) offenders.push(`${name}:${index + 1}: адреса з портом — ${line.trim().slice(0, 80)}`);
      if (/\bPORT:\s*String\(/.test(line)) offenders.push(`${name}:${index + 1}: PORT береться з числа — ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "Запускай сервер з PORT: \"0\" і бери адресу з listeningOrigin(child) (tests/server-origin.mjs)."
  );
});

test("кожен сервер, який запускає тест, просить порт у ОС і чекає, поки той почне слухати", () => {
  const checked = [];
  for (const { name, text } of files) {
    const spawns = (text.match(/spawn\(process\.execPath, \["server\.mjs"\]/g) || []).length;
    if (!spawns) continue;
    checked.push(name);
    const zero = (text.match(/\bPORT: "0"/g) || []).length;
    const origins = (text.match(/await listeningOrigin\(/g) || []).length;
    assert.equal(zero, spawns, `${name}: серверів ${spawns}, а PORT: "0" лише ${zero}`);
    assert.equal(origins, spawns, `${name}: серверів ${spawns}, а адреса з listeningOrigin лише ${origins}`);
    assert.match(text, /from "\.\/server-origin\.mjs"/, `${name}: не імпортує listeningOrigin`);
  }
  assert.ok(checked.length >= 15, `серверів у ${checked.length} файлах — перевірка, схоже, зламалась`);
});
