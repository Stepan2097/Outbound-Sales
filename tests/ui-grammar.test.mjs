import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Граматика інтерфейсу (таск 9180724e, 17.10): відступи зі шкали, п'ять типів блоків,
// бірюзовий — лише дія, стан — свої тони; картка автозапитів — усе всередині.

const read = (path) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");
const html = read("index.html");

test("правила підключені після базових стилів: шкала відступів, типи блоків, тони стану", () => {
  assert.ok(html.indexOf("/styles/grammar.css") > html.indexOf("/styles/base.css"));
  const css = read("styles/grammar.css");
  for (const token of ["--sp-1", "--sp-6", "--state-run", ".blk-queue", ".blk-settings", ".blk-metrics", ".blk-list", ".blk-ref", ".kv", ".progress-bar"]) {
    assert.ok(css.includes(token), token);
  }
});

test("кожна основна панель LinkedIn має свій тип", () => {
  for (const [id, type] of [["leadCampaignPanel", "blk-settings"], ["workspaceSpinePanel", "blk-ref"], ["warmupCampaignPanel", "blk-settings"], ["warmupFunnelPanel", "blk-metrics"], ["warmupStrategyPanel", "blk-settings"]]) {
    assert.match(html, new RegExp(`class="panel ${type}[^"]*"[^>]*id="${id}"`), id);
  }
  assert.match(html, /class="panel blk-list warmup-list-panel/);
  assert.match(html, /class="panel blk-queue warmup-inbox-panel/);
  assert.match(read("screens/today.js"), /<section class="panel blk-queue today">/);
});

test("картка автозапитів: поля з підписами й прогрес смугою, стан — тоном стану, а не бірюзою дії", () => {
  const js = read("screens/warmup-campaign.js");
  assert.match(js, /<dl class="kv">/);
  assert.match(js, /class="progress-bar"/);
  assert.match(js, /"Папка CRM"/);
  assert.match(js, /campaign\.state === "running" \? "state-run"/);
  assert.doesNotMatch(js, /warmupTickedAccountsLine\(campaign\)/, "«Ведуть: …» більше не висить під карткою");
});

// Суддя, коло 1 (17.10): решта екранів — ті самі типи через їхні класи.
test("Головна (нові контакти), По днях, Смисли, Кампанії пошти й Контакти мають типи блоків", () => {
  const css = read("styles/grammar.css");
  for (const [selector, label] of [
    [".work-plan::before", "Робоча черга"], [".triage-card::before", "Робоча черга"],
    [".work-stats::before", "Показники"], [".work-team::before", "Список"], [".work-list::before", "Список"],
    [".pitch-side::before", "Список"], [".mc-list-main::before", "Список"], [".triage-recent::before", "Список"]
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(css, new RegExp(`${escaped} \\{ content: "${label}`), selector);
  }
  assert.match(css, /\.work-toolbar,\s*\.mc-toolbar,\s*\.triage-toolbar \{/, "смуги фільтрів — один тихий вигляд");
  assert.match(css, /\.panel\.pitch-intro,/, "вступ «Смислів» — довідка");
  assert.match(html, /class="panel blk-settings contact-card-panel"/, "картка контакту — налаштування (поля)");
});
