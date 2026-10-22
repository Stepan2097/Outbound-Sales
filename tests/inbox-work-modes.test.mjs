import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * «Вхідні» LinkedIn — дві частини (Марко 19.10, таск 81f4efc4: «поточний функціонал
 * вкладки Головна перенести в Вхідні і грамотно поєднати»): «До роботи» — черга пінгів,
 * що була на Головній, і «Усі розмови» — месенджер. Нічого з обох не губиться.
 */

const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const today = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");
const inbox = readFileSync(new URL("../app/screens/inbox.js", import.meta.url), "utf8");

function viewOf(id) {
  const start = html.indexOf(`id="view-${id}"`);
  const end = html.indexOf('<section class="view"', start + 10);
  return html.slice(start, end === -1 ? undefined : end);
}

// 20.10 (Марко, таск f50d24e9): одна вкладка розмов «В роботі» (черга + фільтр «Усі розмови»)
// і «Нові» — конвеєр нових контактів.
test("«Вхідні» — «В роботі» (черга й усі розмови фільтром) і «Нові»", () => {
  const view = viewOf("inbox");
  assert.match(view, /data-inbox-tab="work"[^>]*>В роботі/);
  assert.match(view, /data-inbox-tab="new"[^>]*>Нові/);
  assert.doesNotMatch(view, /data-inbox-mode=/);
  assert.match(view, /id="todayRoot" data-inbox-pane="work all"/);
  assert.match(view, /data-inbox-pane="all"/);
  // Марко 22.10 (таск 4c945837): фільтри — один список; «Усі розмови» — пункт «Перевіряти».
  assert.match(today, /item\("threads", "Усі розмови", totalThreads, "threads"\)/);
  for (const id of ["warmupInboxBody", "warmupInboxThread", "warmupInboxReply", "warmupInboxSearch"]) assert.match(view, new RegExp(`id="${id}"`));
  assert.doesNotMatch(viewOf("home"), /todayRoot/, "Головна більше не показує чергу пінгів");
});

test("the queue registers on «Вхідні» and keeps everything it did on Головна", () => {
  assert.match(today, /onScreen\("inbox"/);
  assert.doesNotMatch(today, /onScreen\("home"/);
  for (const act of ["send", "rewrite", "move", "call", "scope", "block", "import-toggle", "import-accept"]) {
    assert.match(today, new RegExp(`act === "${act}"`), `дія ${act} на місці`);
  }
  assert.match(today, /\/api\/today\/status/, "статус у CRM");
});

test("«Усі розмови» never opens a ping card: opening a reply would mark it read", () => {
  assert.match(today, /if \(inboxMode !== "work"\) return void renderWarmupInbox\(\);\n  if \(today\.selected\) void loadDetail/);
});

test("one full dialogue in the card (Марко 22.10, таск 56123f07: «лишимо лише один повний діалог»); a conversation with a ping leads to work", () => {
  assert.doesNotMatch(today, /data-today="thread"/, "кнопки «Уся розмова» в картці немає");
  assert.doesNotMatch(today, />Уся розмова</);
  assert.doesNotMatch(today, /act === "thread"/);
  assert.match(inbox, /data-inbox-to-work="\$\{escapeAttr\(ping\.pingId\)\}"/);
  assert.match(today, /connectInboxWork\(\{ showAll: showAllConversations, pingFor, loaded: \(\) => render\(\), opened: \(open\) => void openThreadSide\(open\) \}\)/);
});

test("links from other screens to one conversation land on «Усі розмови», not on the queue", () => {
  for (const name of ["showWarmupInboxAccount", "showWarmupInboxThread"]) {
    const body = inbox.slice(inbox.indexOf(`export function ${name}`), inbox.indexOf("\n}\n", inbox.indexOf(`export function ${name}`)));
    assert.ok(body.indexOf("inboxWork.showAll()") > -1 && body.indexOf("inboxWork.showAll()") < body.indexOf("goToWorkspace()"), `${name}: спершу «Усі розмови», потім перехід`);
  }
});

test("В1 (Марко 19.10): «До роботи» на компонентах «Усіх розмов» — акаунт, пошук, рядок, шапка, бульбашки, черга відправки", () => {
  assert.match(today, /class="warmup-thread today-item/);
  assert.match(today, /class="warmup-thread-head today-work-head"/);
  assert.match(today, /warmupMessageHtml\(message, name, accountName \|\| "Ми"\)/);
  assert.match(today, /data-today="cancel-reply"/);
  assert.match(today, /chip\("", "Усі акаунти", allItems\(\)\.length\)/);
  assert.match(today, /id="todaySearch"/);
  assert.match(inbox, /const INBOX_ALL_ACCOUNTS = "\*";/);
  // 20.10: AI-чернетку можна взяти, переписати або стерти й написати своє.
  assert.match(today, /data-today="own-text"/);
  assert.match(today, /Переписати AI/);
});

test("правка Марка 20.10: без рядка про нові під чергою, «Усі розмови» з числом розмов, низ розмови стоїть", () => {
  assert.doesNotMatch(today, /today-gate/);
  assert.match(html, /id="inboxNewHint"/);
  assert.match(today, /hint\.textContent = today\.data\?\.configured && today\.data\.newContactsAllowed === false \? "після розмов" : ""/);
  assert.match(today, /threads: totalThreads \}\[key\]/, "«Усі розмови» з числом розмов, а не непрочитаних");
  const css = readFileSync(new URL("../app/styles/today.css", import.meta.url), "utf8");
  assert.match(css, /\.today-main > \.today-thread \{ flex: 1 1 auto; min-height: 80px; max-height: none; overflow-y: auto; \}/);
  const inboxCss = readFileSync(new URL("../app/styles/inbox.css", import.meta.url), "utf8");
  assert.match(inboxCss, /#view-inbox\[data-mode="all"\] \.warmup-inbox-panel > \.panel-heading \{ display: none; \}/);
});

test("Марко 22.10 (таск 4c945837, варіант A): фільтри одним списком з поясненнями, «?», «Без відповіді», колонка дій", () => {
  for (const key of ['""', "replies", "overdue", "today", "first", "silent", "threads"]) assert.match(today, new RegExp(`\\n  ${key === '""' ? '""' : key}: \\["`), `пояснення фільтра ${key}`);
  assert.match(today, /Щодня — по черзі/);
  assert.match(today, /Перевіряти час від часу/);
  assert.match(today, /data-today="help-toggle"/);
  assert.match(today, /\.filter\(\(item\) => item\.reason === "silent"\)/, "«Без відповіді» — усі «Нагадати», і далі за планом");
  for (const title of ["Статус у CRM", "Наступний пінг", "Кампанія", "Посилання"]) assert.match(today, new RegExp(`sideBox\\("${title}"`));
  assert.match(today, /data-today="bad-timing"/);
  assert.match(today, /status: "bad_timing", exitReason: today\.data\?\.defaultExit\?\.bad_timing \|\| "not_now"/);
  assert.match(today, /item\.crmUrl \? `<a href=/, "«CRM» веде в CRM");
  assert.match(today, />Картка контакту</);
  assert.doesNotMatch(today, /<span>Відкрити в CRM<\/span>/, "кнопка, що вела в «Контакти» порталу, більше так не називається");
});

test("Марко 22.10 (таск 4c945837): «Усі розмови» мають ту саму колонку дій — за контактом, і з пінгом, і без", () => {
  assert.match(html, /<aside class="today-side inbox-side" id="warmupInboxSide" aria-label="Дії з лідом" hidden><\/aside>/);
  assert.match(inbox, /inboxWork\.opened\?\.\(open && inbox\.open \?/);
  assert.match(today, /api\(`\/api\/today\/contact\?contactId=\$\{encodeURIComponent\(side\.contactId\)\}`\)/);
  assert.match(today, /pingId: side\.data\?\.ping\?\.mine \? side\.data\.ping\.pingId : "", contactId: side\.contactId/, "немає пінга — ставиться новий за контактом");
  assert.match(today, /data-side="bad-timing"/);
  const api = readFileSync(new URL("../triage/today.mjs", import.meta.url), "utf8");
  assert.match(api, /path === "\/api\/today\/contact"/);
  const css = readFileSync(new URL("../app/styles/inbox.css", import.meta.url), "utf8");
  assert.match(css, /#view-inbox\[data-mode="all"\] \.inbox-split\.has-side \{ grid-template-columns: minmax\(250px, 320px\) minmax\(0, 1fr\) 200px; \}/);
});

test("Марко 22.10 (таск de18b7b2): «Уся розмова» ↔ «До роботи» на Workspace — на місці, без перечитування й блимання", () => {
  assert.match(inbox, /function goToWorkspace\(\) \{\n  if \(document\.getElementById\("view-inbox"\)\?\.classList\?\.contains\("active"\)\) return;/);
  assert.match(today, /if \(onInboxView\(\)\) return applyInboxMode\(\{ refresh: false \}\);/);
  assert.match(today, /if \(refresh \|\| !today\.data \|\| Date\.now\(\) - \(today\.loadedAt \|\| 0\) > FRESH_MS\) return void openToday/);
  assert.match(today, /if \(today\.detail\?\.item\?\.pingId !== pingId\) \{\n[\s\S]{0,200}?today\.detail = null;\n    today\.detailLoading = true;/, "той самий лід — картка лишається");
});

test("Богдан 22.10 (таск b0eb7c3a): акаунт, що просить увійти чи капчу, попереджає у Workspace; заблокований — ні", () => {
  assert.match(inbox, /filter\(\(account\) => !account\.retired && \["needs_login", "captcha"\]\.includes\(account\.health\)\)/);
  assert.match(today, /\$\{accountAlertsHtml\(\)\}/);
  assert.match(today, /не читається\$\{escapeHtml\(since\)\}/);
  assert.match(today, /доки хтось не увійде в LinkedIn у профілі AnyBrowser цього акаунта/);
  const api = readFileSync(new URL("../warmup/api.mjs", import.meta.url), "utf8");
  assert.match(api, /health: healthOf\.get\(account\.accountId\)\?\.health \|\| null,/);
  assert.match(api, /select\("id,label,status,health,health_changed_at"\)/);
});
