import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Розвантаження інтерфейсу (аудит 16.10, другий прохід, таск 57bc1f99): пояснення — у підказках,
// повтори прибрані, рідкісні дії згорнуті. Тести тримають, щоб шум не повертався непомітно.

const read = (path) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");

test("Сьогодні: лідген під пінгом — лише коли їх кілька; перенесення — «+1 · +3 · +7 · дата · Дзвінок»", () => {
  const today = read("screens/today.js");
  assert.match(today, /item\.assignee && mixedAssignees\(\)/);
  assert.doesNotMatch(today, />На дату</, "окремої кнопки «На дату» немає: вибір дати сам переносить");
  assert.doesNotMatch(today, /<span class="today-hint">Піде з цього акаунта/, "пояснення — у підказці кнопки");
  assert.match(today, /today\.callMode/);
});

test("Вхідні: без дублю заголовка й пігулки непрочитаних; коротка підказка під відповіддю", () => {
  const html = read("index.html");
  assert.match(html, /<div class="warmup-inbox-heading" hidden>/);
  const inbox = read("screens/inbox.js");
  assert.match(inbox, /pill\.hidden = Boolean\(inbox\.ready && !inbox\.error/);
  assert.doesNotMatch(inbox, /не одразу, а \$\{warmupGoesOutText/);
});

test("Смисли: форми додавання — за кнопками «+ Посилання / + Файл / + Апдейт»", () => {
  const pitch = read("screens/pitch.js");
  assert.match(pitch, /data-form="link" hidden/);
  assert.match(pitch, /data-form="update" hidden/);
  assert.match(pitch, /if \(act === "reveal"\)/);
});

test("Звіт команди: дії кнопками — одним рядком і лише ненульові; старих плиток і таблиці журналу немає", () => {
  const work = read("screens/work.js");
  assert.match(work, /\.filter\(\(\[key\]\) => Number\(total\?\.\[key\]\) > 0\)/);
  assert.doesNotMatch(work, /function statsHtml|function teamHtml/, "плитки й таблиця журналу замінені зведенням і таблицею по лідгенах");
});

test("прогрів пошт — пояснення згорнуто; поштових блоків у «Налаштуваннях» немає (власник 27.10: «прибери це все»)", () => {
  assert.match(read("screens/mail-warmup.js"), /<details class="warmup-mail-about">/);
  const html = read("index.html");
  for (const id of ["espRegistryPanel", "espAccessPanel", "espMailPanel"]) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
});
