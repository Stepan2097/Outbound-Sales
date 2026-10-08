import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { loadMain, mainSource, declaration } from "./app-main-excerpt.mjs";

/**
 * Панель «Стратегія прогріву»: розклад по днях, який можна відкрити й правити.
 *
 * Її вже раз губили. 22.09 вона з'явилась (1b8861b) і переїхала всередину
 * «Кампаній» (a44265e); 02.10 злиття f20ee6d склало гілку з нею й гілку
 * Linux-інтеграції, де її не було, і конфлікт у index.html та main.js тихо
 * розв'язався на користь другої. Сервер усе це час віддавав і приймав дні
 * (`GET/PATCH /api/warmup/strategies`), усі 400 тестів були зелені — просто
 * екрана, з якого це можна було побачити, більше не існувало. Тому перші три
 * тести тут не про логіку, а про присутність: розмітка, стилі й виклик із
 * loadWarmup мають бути на місці, і наступне злиття, що їх з'їсть, упаде тут.
 */

const INDEX = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const STYLES_DIR = new URL("../app/styles/", import.meta.url);
const STYLES = readdirSync(STYLES_DIR).filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(new URL(name, STYLES_DIR), "utf8")).join("\n");

test("розмітка панелі лежить усередині «Кампаній», під деталями кампанії", () => {
  for (const id of ["warmupStrategyPill", "warmupStrategySubtitle", "warmupStrategyToggleBtn", "warmupStrategyBody"]) {
    assert.equal(INDEX.split(`id="${id}"`).length - 1, 1, `у index.html має бути рівно один #${id}`);
  }
  const campaigns = INDEX.indexOf("warmup-campaigns-panel");
  const detail = INDEX.indexOf('id="warmupCampaignDetail"');
  const section = INDEX.indexOf("warmup-strategy-section");
  const queue = INDEX.indexOf("warmup-queue-panel");
  assert.ok(campaigns > 0 && campaigns < detail, "панель кампаній зникла або зсунулась");
  assert.ok(detail < section && section < queue, "розклад мусить стояти після деталей кампанії й до черги, в одному блоці з кампаніями");
  assert.match(INDEX, /<h3>Стратегія прогріву<\/h3>/);
});

test("стилі таблиці розкладу на місці", () => {
  for (const selector of [".warmup-strategy-section", ".warmup-strategy-table", ".warmup-day-quota input", ".warmup-strategy-foot"]) {
    assert.ok(STYLES.includes(selector), `у стилях немає ${selector}`);
  }
  // Межа між фазами — єдина структура таблиці; без неї дні читаються як каша.
  assert.match(STYLES, /tr\.is-phase-start/);
});

test("loadWarmup читає розклад, а на сервері без прогріву каже, чому його нема", () => {
  const load = declaration(mainSource(), "loadWarmup");
  assert.match(load, /await loadWarmupStrategy\(\)/, "loadWarmup більше не читає розклад");

  const offline = load.slice(load.indexOf("if (!warmupState.config.configured)"), load.indexOf("// Reconciling"));
  assert.match(offline, /warmupState\.strategy = null/);
  assert.match(offline, /strategyError = "Розклад лежить у базі Anty/);
  // Без цього виклику панель лишається на «завантаження» назавжди й виглядає як та, що ще пробує.
  assert.match(offline, /renderWarmupStrategy\(\)/);
});

// ── поведінка ──────────────────────────────────────────────────────────────

const NAMES = [
  "uaPlural", "escapeHtml", "escapeAttr", "WARMUP_EDITABLE_KINDS", "WARMUP_KIND_LABEL",
  "warmupStrategyDays", "warmupStrategyDirty", "warmupQuotaCell", "warmupStrategyRowHtml",
  "renderWarmupStrategy", "editWarmupStrategyDay", "loadWarmupStrategy", "saveWarmupStrategy"
];

function element() {
  return { className: "", textContent: "", innerHTML: "", hidden: false };
}

/** Стратегія, якою її віддає сервер: два дні розігріву й один робочий, на третій є запити. */
function serverStrategy() {
  return {
    id: "strategy-1",
    name: "Стандартний прогрів",
    description: "",
    pauseDays: 2,
    isDefault: true,
    days: [
      { day: 1, label: "Розігрів", quotas: { profile_view: [3, 5], like: [1, 2] }, connectionNote: false },
      { day: 2, label: "Розігрів", quotas: { profile_view: [3, 5], like: [1, 2] }, connectionNote: false },
      { day: 3, label: "Робочий", quotas: { profile_view: [4, 6], like: [2, 3], connect: [2, 4] }, connectionNote: { maxWords: 3, allowLinks: false } }
    ]
  };
}

function panel({ api, strategy = serverStrategy(), open = true, extra = {} } = {}) {
  const els = {
    warmupStrategyPill: element(),
    warmupStrategySubtitle: element(),
    warmupStrategyToggleBtn: element(),
    warmupStrategyBody: element()
  };
  const warmupState = {
    strategy, strategyDraft: null, strategyOpen: open, strategyBusy: false, strategyError: "", strategyNotice: "", ...extra
  };
  const main = loadMain(NAMES, {
    warmupState,
    warmupApi: api || (async () => { throw new Error("warmupApi не мав викликатись"); }),
    document: { getElementById: (id) => els[id] || null },
    refreshIcons: () => {}
  });
  return { els, warmupState, main, render: main.get("renderWarmupStrategy"), edit: main.get("editWarmupStrategyDay") };
}

const rows = (html) => (html.match(/<tr class="/g) || []).length;

test("таблиця — рядок на день, а назва фази друкується лише там, де вона змінюється", () => {
  const { els, render } = panel();
  render();
  assert.equal(els.warmupStrategyBody.hidden, false);
  assert.equal(rows(els.warmupStrategyBody.innerHTML), 3);
  assert.equal(els.warmupStrategyBody.innerHTML.split("Розігрів").length - 1, 1, "«Розігрів» двічі: назву фази треба друкувати там, де вона відкривається");
  assert.equal(els.warmupStrategyBody.innerHTML.split("Робочий").length - 1, 1);
  assert.equal(els.warmupStrategyPill.textContent, "3 дні · 2 фази");
  assert.match(els.warmupStrategySubtitle.textContent, /^Стандартний прогрів — одна на всі акаунти/);
});

test("згорнута панель каже лише скільки днів і фаз, і не тримає таблицю в розмітці", () => {
  const { els, render } = panel({ open: false });
  render();
  assert.equal(els.warmupStrategyBody.hidden, true);
  assert.equal(els.warmupStrategyBody.innerHTML, "");
  assert.equal(els.warmupStrategyPill.textContent, "3 дні · 2 фази");
  assert.match(els.warmupStrategyToggleBtn.innerHTML, /Відкрити деталі/);
});

test("нотатку до запиту не можна ввімкнути в день, коли запитів немає", () => {
  const { els, render } = panel();
  render();
  const html = els.warmupStrategyBody.innerHTML;
  // Дні 1–2 без запитів: чекбокс заблокований. День 3 з запитами — ні.
  const checkbox = (day) => new RegExp(`<input type="checkbox"[^>]*data-warmup-day="${day}" data-warmup-note="1"`).exec(html)[0];
  assert.match(checkbox(1), /disabled/);
  assert.doesNotMatch(checkbox(3), /disabled/);
  assert.match(checkbox(3), /checked/);
});

test("правка йде в чернетку, збережене не чіпається, і «Зберегти» вмикається лише з правкою", () => {
  const { els, warmupState, render, edit } = panel();
  render();
  assert.match(els.warmupStrategyBody.innerHTML, /id="warmupStrategySaveBtn" disabled/);

  edit(2, (row) => { row.quotas = { ...row.quotas, profile_view: [6, 9] }; });
  render();
  assert.deepEqual(warmupState.strategy.days[1].quotas.profile_view, [3, 5], "правка дісталась збереженого, а не чернетки");
  assert.deepEqual(warmupState.strategyDraft[1].quotas.profile_view, [6, 9]);
  assert.doesNotMatch(els.warmupStrategyBody.innerHTML, /id="warmupStrategySaveBtn" disabled/);
});

test("зберігання відправляє дні, а не фази, і перечитує те, що сервер склав", async () => {
  const calls = [];
  const folded = serverStrategy();
  const api = async (path, options) => {
    calls.push({ path, method: options?.method || "GET", body: options?.body ? JSON.parse(options.body) : null });
    if (path === "/strategies" && options?.method === "PATCH") return { success: true, strategy: { ...folded } };
    return { strategies: [folded] };
  };
  const { warmupState, main, render, edit } = panel({ api });
  render();
  edit(1, (row) => { row.quotas = { ...row.quotas, like: [2, 4] }; });
  await main.get("saveWarmupStrategy")();

  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.body.id, "strategy-1");
  assert.equal(patch.body.days.length, 3);
  assert.deepEqual(patch.body.days[0].quotas.like, [2, 4]);
  assert.ok(!("phases" in patch.body), "фази складає сервер; друга відповідь у браузері була б другою правдою");
  // Після збереження — перечитування, чернетка знята, людина бачить, що вийшло.
  assert.ok(calls.some((call) => call.method === "GET"), "після збереження розклад не перечитано");
  assert.equal(warmupState.strategyDraft, null);
  assert.match(warmupState.strategyNotice, /Розклад збережено/);
  assert.equal(warmupState.strategyBusy, false);
});

test("розклад, що не зберігся, лишає правки людини на місці й каже чому", async () => {
  const api = async () => { throw new Error("Стратегія не пройшла перевірку"); };
  const { warmupState, els, render, edit, main } = panel({ api });
  render();
  edit(3, (row) => { row.quotas = { ...row.quotas, connect: [9, 9] }; });
  await main.get("saveWarmupStrategy")();

  assert.equal(warmupState.strategyError, "Стратегія не пройшла перевірку");
  assert.ok(warmupState.strategyDraft, "невдале збереження стерло те, що людина щойно ввела");
  assert.equal(warmupState.strategyDraft[2].quotas.connect[0], 9);
  assert.match(els.warmupStrategyBody.innerHTML, /Стратегія не пройшла перевірку/);
  assert.equal(warmupState.strategyBusy, false, "кнопка лишилась заблокованою після помилки");
});

test("коли розклад не прочитався, панель каже це, а не висить на «завантаженні»", async () => {
  const api = async () => { throw new Error("база Anty не відповідає"); };
  const { els, warmupState, main } = panel({ api, strategy: null });
  await main.get("loadWarmupStrategy")();

  assert.equal(warmupState.strategy, null);
  assert.equal(els.warmupStrategyPill.textContent, "недоступно");
  assert.match(els.warmupStrategyBody.innerHTML, /база Anty не відповідає/);
  assert.equal(els.warmupStrategyBody.hidden, false);
});
