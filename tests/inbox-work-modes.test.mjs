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

test("«Вхідні» hold both parts: the ping queue and the messenger, behind two tabs", () => {
  const view = viewOf("inbox");
  assert.match(view, /data-inbox-mode="work"[^>]*>До роботи/);
  assert.match(view, /data-inbox-mode="all"[^>]*>Усі розмови/);
  assert.match(view, /id="todayRoot" data-inbox-pane="work"/);
  assert.match(view, /data-inbox-pane="all"/);
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

test("a ping leads to its whole conversation, and a conversation with a ping leads back to work", () => {
  assert.match(today, /data-today="thread"[^`]*>Уся розмова</);
  assert.match(today, /showWarmupInboxThread\(item\.accountId, item\.threadKey\)/);
  assert.match(inbox, /data-inbox-to-work="\$\{escapeAttr\(ping\.pingId\)\}"/);
  assert.match(today, /connectInboxWork\(\{ showAll: \(\) => setInboxMode\("all"\), pingFor \}\)/);
});

test("links from other screens to one conversation land on «Усі розмови», not on the queue", () => {
  for (const name of ["showWarmupInboxAccount", "showWarmupInboxThread"]) {
    const body = inbox.slice(inbox.indexOf(`export function ${name}`), inbox.indexOf("\n}\n", inbox.indexOf(`export function ${name}`)));
    assert.ok(body.indexOf("inboxWork.showAll()") > -1 && body.indexOf("inboxWork.showAll()") < body.indexOf('data-view="inbox"'), `${name}: спершу «Усі розмови», потім перехід`);
  }
});
