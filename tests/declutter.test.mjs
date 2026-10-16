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

test("По днях: нульові плитки й колонки не показуються, головні — завжди", () => {
  const work = read("screens/work.js");
  assert.match(work, /core\.has\(icon\) \|\| Number\(value\) > 0/);
  assert.match(work, /always \|\| data\.byUser\.some/);
});

test("Налаштування: домени й відправники згорнуті з лічильником; прогрів пошт — пояснення згорнуто", () => {
  assert.match(read("screens/esp-registry.js"), /<details class="esp-fold" data-esp-fold="senders"/);
  assert.match(read("screens/mail-warmup.js"), /<details class="warmup-mail-about">/);
});
