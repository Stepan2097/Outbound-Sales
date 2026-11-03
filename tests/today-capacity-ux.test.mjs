import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Таск cdfe0440: шапка «Сьогодні» з навантаженням, «Не лід ▾» у картці будь-якої відповіді,
// бекліг старих відповідей для адміністратора.

const TODAY = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");
const API = readFileSync(new URL("../triage/today.mjs", import.meta.url), "utf8");

test("шапка показує навантаження на 5 робочих днів проти ємності", () => {
  assert.match(TODAY, /\$\{threads \? "" : loadHtml\(\)\}/, "у «В роботі», не в «Усіх розмовах»");
  assert.match(TODAY, /з \$\{load\.capacity\} \$\{isToday \? "на сьогодні"/);
  assert.match(TODAY, /перенесено далі/);
  assert.match(API, /load: \{ capacity, days: loadAhead\(/);
});

test("«Не лід ▾» — у картці будь-якої відповіді, не лише без кампанії, з підставою", () => {
  assert.match(TODAY, /\$\{kind === "reply" && item\.contactId \? notLeadMenuHtml\("not-lead-basis"\) : ""\}/);
  assert.match(TODAY, /api\("\/api\/today\/not-lead", \{ method: "POST", body: JSON\.stringify\(\{ contactId: item\.contactId, basis \}\) \}\)/);
  for (const label of ["Вендор", "Рекрутер", "Шукає роботу", "Системне повідомлення"]) assert.match(API, new RegExp(label));
  assert.match(TODAY, /act\("not-lead"\)\} title="Знайомий, рекрутер/, "стара «Не лід» для ліда без кампанії лишилась (207ffbc1)");
});

test("бекліг: лише адміністратор, вибрати кілька → «Не лід» з підставою або перенести", () => {
  assert.match(TODAY, /\$\{today\.data\?\.canSeeAll \? item\("backlog", "Бекліг", backlog\) : ""\}/);
  assert.match(TODAY, /today\.data\?\.canSeeAll \? \(today\.data\.blocks\?\.replies \|\| \[\]\)\.filter\(\(item\) => item\.stale\)/);
  assert.match(TODAY, /contactIds: picked\.map\(\(item\) => item\.contactId\), basis/);
  assert.match(TODAY, /pingIds: picked\.map\(\(item\) => item\.pingId\), when/);
  assert.match(API, /if \(ids\.length > 1 && !isAdmin\) throw refuse\("Пачкою розбирає адміністратор\.", 403\)/);
  assert.match(API, /path === "\/api\/today\/postpone"\) \{\n      if \(!isAdmin\)/);
});
