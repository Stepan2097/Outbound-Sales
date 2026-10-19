import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * Головна — пульт (Марко 19.10, варіант А, таск fb4d413c): план дня, що потребує уваги,
 * воронка, кампанії. Робота — не тут: черга пінгів у «Вхідних» → «До роботи», нові
 * контакти — у WorkSpace → «Нові контакти».
 */

const home = readFileSync(new URL("../app/screens/home.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const uaPlural = (count, one, few, many) => (count % 10 === 1 && count % 100 !== 11 ? one : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? few : many);
const { get } = loadMain(["SYNC_STALE_HOURS", "OLD_PING_WORKING_DAYS", "workingDaysBetween", "attentionItems"], { uaPlural, Date });

test("working days skip the weekend", () => {
  const between = get("workingDaysBetween");
  assert.equal(between("2026-10-16", "2026-10-19"), 1, "пт → пн: один робочий день");
  assert.equal(between("2026-10-08", "2026-10-19"), 7);
  assert.equal(between("2026-10-19", "2026-10-19"), 0);
});

test("«Потребує уваги» names only real problems, and is empty when there are none", () => {
  const items = get("attentionItems");
  const now = Date.parse("2026-10-19T12:00:00Z");
  const calm = items({ now, today: { today: "2026-10-19", blocks: { overdue: [{ dueDay: "2026-10-16" }] } }, warmup: { attention: [], inbox: { lastSyncedAt: "2026-10-19T10:00:00Z" } } });
  assert.equal(calm.length, 0, "свіжі вхідні, пінг прострочено на 1 робочий день — нічого");

  const busy = items({
    now,
    today: { today: "2026-10-19", blocks: { overdue: [{ dueDay: "2026-10-08" }, { dueDay: "2026-10-09" }, { dueDay: "2026-10-16" }] } },
    warmup: { attention: [{ kind: "account", text: "Profile 48: потрібен вхід" }], inbox: { lastSyncedAt: "2026-10-17T12:00:00Z" } }
  }).map((item) => item.text);
  assert.deepEqual([...busy], [
    "Profile 48: потрібен вхід",
    "Вхідні LinkedIn не оновлювались 48 год — агент не читає акаунти.",
    "2 пінги прострочено понад 2 робочі дні."
  ]);
});

test("every number of the plan leads where the work is", () => {
  for (const key of ["replies", "overdue", "today", "first"]) assert.match(home, new RegExp(`\\["${key}", `));
  assert.match(home, /openTodayBlock\(go, \{ scope: scope\(\) \}\)/);
  assert.match(home, /data-home-go="contacts"/);
  assert.match(home, /if \(go === "contacts"\) return void showNewContacts\(\)/);
});

test("the funnel and the campaigns are the same numbers as «Прогрів» and «Порівняння кампаній»", () => {
  assert.match(home, /import \{ homeFunnelHtml \} from "\.\/warmup-funnel\.js"/);
  assert.match(home, /warmupApi\("\/home"\)/);
  assert.match(home, /api\("\/api\/campaign-report"\)/);
});

test("Головна is its own page: no ping queue and no conveyor in it", () => {
  const start = html.indexOf('id="view-home"');
  const view = html.slice(start, html.indexOf('<section class="view"', start + 10));
  assert.match(view, /id="homeRoot"/);
  assert.doesNotMatch(view, /todayRoot|triageRoot/);
});
