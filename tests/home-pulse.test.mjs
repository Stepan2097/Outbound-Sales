import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * Головна (Марко 19.10, таск ca978070): «Пульт зверху, конвеєр під ним» — смуга прогресу
 * дня (Г2), «Почати з відповідей» (Г1), «Потребує уваги»; під ними конвеєр нових контактів
 * Павла (86b69f3), на Головній без умови «спершу розмови».
 */

const home = readFileSync(new URL("../app/screens/home.js", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/screens/workspace.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const uaPlural = (count, one, few, many) => (count % 10 === 1 && count % 100 !== 11 ? one : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? few : many);
const { get } = loadMain(["SYNC_STALE_HOURS", "OLD_PING_WORKING_DAYS", "workingDaysBetween", "attentionItems"], { uaPlural, Date });

test("the pulse is on top and the conveyor under it", () => {
  const start = html.indexOf('id="view-home"');
  const view = html.slice(start, html.indexOf("</section>", start));
  assert.ok(view.indexOf('id="homeRoot"') > -1 && view.indexOf('id="homeRoot"') < view.indexOf('id="homeContacts"'));
  assert.doesNotMatch(view, /todayRoot/, "черги пінгів на Головній немає");
  assert.match(home, /openNewContactsOnHome\(\{ gate: false \}\)/);
});

test("the day is one progress bar of four parts and one start button, each leading to its block", () => {
  for (const key of ["replies", "overdue", "today", "first"]) assert.match(home, new RegExp(`\\["${key}", `));
  assert.match(home, /class="home-bar-part" data-home-go=/);
  assert.match(home, /START_LABEL\[first\.key\]/);
  assert.match(home, /replies: "Почати з відповідей"/);
  assert.match(home, /openTodayBlock\(go, \{ scope: scope\(\) \}\)/);
});

test("working days skip the weekend", () => {
  const between = get("workingDaysBetween");
  assert.equal(between("2026-10-16", "2026-10-19"), 1);
  assert.equal(between("2026-10-08", "2026-10-19"), 7);
});

test("«Потребує уваги» names only real problems, and is empty when there are none", () => {
  const items = get("attentionItems");
  const now = Date.parse("2026-10-19T12:00:00Z");
  assert.equal(items({ now, today: { today: "2026-10-19", blocks: { overdue: [{ dueDay: "2026-10-16" }] } }, warmup: { attention: [], inbox: { lastSyncedAt: "2026-10-19T10:00:00Z" } } }).length, 0);
  const busy = items({
    now,
    today: { today: "2026-10-19", blocks: { overdue: [{ dueDay: "2026-10-08" }, { dueDay: "2026-10-09" }] } },
    warmup: { attention: [{ kind: "account", text: "Profile 48: потрібен вхід" }], inbox: { lastSyncedAt: "2026-10-17T12:00:00Z" } }
  }).map((item) => item.text);
  assert.deepEqual([...busy], ["Profile 48: потрібен вхід", "Вхідні LinkedIn не оновлювались 48 год — агент не читає акаунти.", "2 пінги прострочено понад 2 робочі дні."]);
});

test("WorkSpace keeps the same conveyor with the «conversations first» rule", () => {
  assert.match(workspace, /gate = useGate \? await api\("\/api\/today\/gate"\) : null/);
});
