import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { blockOf, newContactsAllowed } from "../triage/pings.mjs";

// Таск 85ea1e97 (Марко 29.10): «в прострочені попадають контакти, з якими немає ще діалогу,
// просто додались взаїмно в контакти… мають бути лише просрочені пінги або відповіді».

const TODAY = "2026-10-29";
const TODAY_JS = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");
const API = readFileSync(new URL("../triage/today.mjs", import.meta.url), "utf8");

/** Правило до 29.10 — дослівно, для порівняння. */
function oldBlockOf({ reason, dueDay, awaitingUs }, today) {
  if (dueDay && dueDay > today) return "later";
  if (awaitingUs || reason === "reply") return "replies";
  if (dueDay && dueDay < today) return "overdue";
  if (reason === "first") return "first";
  return "today";
}

const REASONS = ["first", "silent", "reply", "manual", "later"];
const DAYS = ["", "2026-09-30", "2026-10-15", "2026-10-28", TODAY, "2026-10-30", "2026-11-20"];

function* cases() {
  for (const reason of REASONS) for (const dueDay of DAYS) for (const awaitingUs of [false, true]) {
    for (const dialog of [true, false, undefined]) yield { reason, dueDay, awaitingUs, dialog };
  }
}

test("контакт без жодного повідомлення (лише взаємне додавання) не потрапляє в «Прострочені»", () => {
  let checked = 0;
  for (const item of cases()) {
    if (item.dialog !== false || item.awaitingUs || item.reason === "reply") continue;
    checked += 1;
    assert.notEqual(blockOf(item, TODAY), "overdue", JSON.stringify(item));
  }
  assert.ok(checked >= 28);
  assert.equal(blockOf({ reason: "first", dueDay: "2026-10-15", dialog: false }, TODAY), "first", "прийняв запит тиждень тому — у «Перших повідомленнях»");
});

test("що старе правило показувало як справжнє прострочення (є розмова), нове теж показує; відповіді — як були", () => {
  let overdue = 0;
  for (const item of cases()) {
    const before = oldBlockOf(item, TODAY);
    const after = blockOf(item, TODAY);
    if (before === "replies" || before === "later") assert.equal(after, before, JSON.stringify(item));
    if (before === "overdue" && item.dialog === true) { overdue += 1; assert.equal(after, "overdue", JSON.stringify(item)); }
    // Стану прогріву немає — правило як раніше: збій звірки не відкриває конвеєр.
    if (item.dialog === undefined && item.reason !== "first") assert.equal(after, before, JSON.stringify(item));
  }
  assert.ok(overdue > 10);
  assert.equal(blockOf({ reason: "silent", dueDay: "2026-10-20", dialog: true }, TODAY), "overdue", "мовчун з минулим пінгом");
  assert.equal(blockOf({ reason: "reply", dueDay: "2026-10-20", awaitingUs: true, dialog: true }, TODAY), "replies", "лід відповів, ми ні");
});

test("лічильник, «Спершу розмови» й конвеєр — з тих самих блоків, тож контакт без розмови не стримує нових", () => {
  const blocks = { replies: [], overdue: [], today: [], first: [] };
  const item = { reason: "first", dueDay: "2026-10-15", dialog: false };
  blocks[blockOf(item, TODAY)].push(item);
  assert.equal(blocks.overdue.length, 0);
  assert.equal(newContactsAllowed(blocks), true);
  assert.match(API, /dialog: state \? Boolean\(thread\) \|\| Boolean\(state\.pending\?\.length\) : undefined/);
  assert.match(API, /const overdue = list\.blocks\.overdue\.length;/, "конвеєр рахує той самий блок, що й список");
});

test("перехід між лідами зберігає ненадісланий текст мовчки, без вікна з питанням", () => {
  assert.doesNotMatch(TODAY_JS, /window\.confirm/, "у «Вхідних» немає вікна «Текст ще не надіслано»");
  assert.match(TODAY_JS, /if \(act === "select"\) \{\n    keepDraft\(\);/);
  assert.match(TODAY_JS, /today\.text = today\.drafts\.get\(pingId\) \|\| detail\.draft\?\.text \|\| "";/, "повернення до ліда — збережений текст");
  assert.match(TODAY_JS, /today\.drafts\.delete\(item\.pingId\);\n    today\.text = "";\n    today\.textFor = "";\n    today\.draftNote = "";\n    await openToday\(\);/, "надіслане з пам'яті прибирається");
});
