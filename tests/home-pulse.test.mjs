import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * Головна (Марко 19.10, ca978070: смуга дня Г2 + «Почати з відповідей» Г1 + «Потребує уваги»;
 * 20.10, f50d24e9: для адміна й менеджера — плюс «По лідгенах — зараз»; нові контакти — у
 * Вхідні → «Нові», не тут).
 */

const home = readFileSync(new URL("../app/screens/home.js", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/screens/workspace.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const uaPlural = (count, one, few, many) => (count % 10 === 1 && count % 100 !== 11 ? one : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? few : many);
const { get } = loadMain(["SYNC_STALE_HOURS", "OLD_PING_WORKING_DAYS", "workingDaysBetween", "attentionItems", "teamRows"], { uaPlural, Date });

test("Головна — пульт без черги й без конвеєра", () => {
  const start = html.indexOf('id="view-home"');
  const view = html.slice(start, html.indexOf("</section>", start));
  assert.match(view, /id="homeRoot"/);
  assert.doesNotMatch(view, /todayRoot|homeContacts|triageRoot/);
  assert.doesNotMatch(home, /openNewContactsOnHome/);
});

test("«По лідгенах — зараз»: пінги кожного і що він зробив сьогодні", () => {
  const rows = get("teamRows")(
    { blocks: { replies: [{ assignee: "B@x.co" }, { assignee: "b@x.co" }, { assignee: "s@x.co" }], overdue: [{ assignee: "b@x.co" }] } },
    { byUser: [{ user: "b@x.co", name: "Bohdan", counts: { contacts: 12, replied: 4 } }, { user: "s@x.co", counts: { contacts: 3, replied: 1 } }] }
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, "b@x.co");
  assert.equal(rows[0].replies, 2);
  assert.equal(rows[0].overdue, 1);
  assert.equal(rows[0].people, 12);
  assert.equal(rows[0].answered, 4);
  assert.match(home, /isAdmin\(\) \? read\(api\("\/api\/work\/day\?user=all"\)/);
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
  assert.deepEqual([...busy], ["Profile 48: потрібен вхід", "Розмови LinkedIn не оновлювались 48 год — агент не читає акаунти.", "2 пінги прострочено понад 2 робочі дні."]);
});

test("WorkSpace — лише кампанії", () => {
  assert.doesNotMatch(workspace, /openTriage|today\/gate|data-ws-tab/);
});

test("суддя 19.10 (ca978070): «Нові контакти» — окрема кнопка під смугою дня, веде у Вхідні → «Нові»", () => {
  assert.match(home, /\$\{newContactsHtml\(\)\}/);
  assert.match(home, /data-home-go="new"><i data-lucide="user-plus"><\/i><span>Нові контакти<\/span>/);
  assert.match(home, /if \(go === "new"\) return void openNewTab\(\);/);
  const today = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");
  assert.match(today, /export function openNewTab\(\) \{\n  setInboxMode\("new"\);/);
});
