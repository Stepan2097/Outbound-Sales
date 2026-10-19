// Головна — пульт (Марко 19.10, варіант А, таск fb4d413c). Не робоче місце, а стан:
//
//   · «План дня» — скільки чекає роботи; кожна цифра відкриває, де з нею працюють:
//     відповіді, прострочені, нагадати, перші повідомлення → Вхідні → «До роботи»
//     (today.js), нові контакти → WorkSpace → «Нові контакти» (home-triage.js);
//   · «Потребує уваги» — лише справжні проблеми: акаунт без входу, з капчею, заблокований
//     чи на паузі, вхідні давно не читались, пінги старші за 2 робочі дні. Нічого — блоку немає;
//   · «Воронка LinkedIn» — ті самі числа, що на «Прогріві» (warmup-funnel.js, /api/warmup/home);
//   · «Кампанії» — кампанії лідгенів (ті самі числа, що «Порівняння кампаній») і автозапити.
//
// Історія по днях і по людях — не тут, а у «По днях» (звіт команди): пульт про «зараз».

import { api, authState, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural } from "../core.js";
import { openAllConversations, openTodayBlock } from "./today.js";
import { openNewContactsOnHome, showNewContacts } from "./workspace.js";
import { homeFunnelHtml } from "./warmup-funnel.js";
import { warmupApi } from "./warmup-accounts.js";

onScreen("home", { open: () => void openHome() });

const SYNC_STALE_HOURS = 36;
const OLD_PING_WORKING_DAYS = 2;
const PLAN = [
  ["replies", "Відповісти", "Лід написав — відповісти"],
  ["overdue", "Прострочені", "Дата пінгу минула"],
  ["today", "Нагадати", "Пінги на сьогодні"],
  ["first", "Перші повідомлення", "Прийняли запит — написати першими"]
];
const CAMPAIGN_STATE = { active: "іде", running: "іде", paused: "пауза", done: "завершена", draft: "чернетка" };

const home = { today: null, gate: null, warmup: null, report: null, errors: [], loading: false };

const isAdmin = () => authState?.user?.role === "admin";
const scope = () => (isAdmin() ? "all" : "mine");

async function openHome() {
  home.loading = true;
  render();
  // Під пультом — нові контакти з листами (власник 19.10).
  void openNewContactsOnHome();
  const errors = [];
  const read = (promise, what) => promise.catch((error) => { if (error?.name !== "AbortError") errors.push(`${what}: ${error.message || "не прочиталось"}`); return null; });
  const [today, gate, warmup, report] = await Promise.all([
    read(api(`/api/today?scope=${scope()}`), "пінги"),
    read(api("/api/today/gate"), "нові контакти"),
    read(warmupApi("/home"), "прогрів"),
    read(api("/api/campaign-report"), "кампанії")
  ]);
  Object.assign(home, { today, gate, warmup, report, errors, loading: false });
  render();
}

/* ── план дня ───────────────────────────────────────────────────────────── */

/** Ворота нових контактів — завжди свої (у адміна план дня командний, а конвеєр — його власний). */
function newContactsTile(gate) {
  if (!gate) return { value: "—", note: "" };
  if (!gate.allowed) return { value: "0", note: "спершу ваші розмови" };
  if (gate.busy && gate.mode === "limit") return { value: `${gate.used} з ${gate.limit}`, note: "ваша норма на сьогодні" };
  return { value: "відкрито", note: gate.busy ? "без обмеження" : "ваші розмови розібрано" };
}

function planHtml() {
  const data = home.today;
  const blocks = data?.blocks || {};
  const tiles = PLAN.map(([key, label, hint]) => {
    const count = (blocks[key] || []).length;
    return `<button type="button" class="home-tile${count ? "" : " is-zero"}" data-home-go="${key}" title="${escapeAttr(hint)}">
      <b>${data?.configured === false ? "—" : count}</b><span>${escapeHtml(label)}</span>
    </button>`;
  });
  const fresh = newContactsTile(home.gate);
  tiles.push(`<button type="button" class="home-tile" data-home-go="contacts" title="WorkSpace → Нові контакти: папка CRM, людина за людиною">
    <b>${escapeHtml(fresh.value)}</b><span>Нові контакти${fresh.note ? ` · ${escapeHtml(fresh.note)}` : ""}</span>
  </button>`);
  return `<section class="panel blk-metrics home-plan">
    <div class="panel-heading"><div><h2>План дня</h2><p>${isAdmin() ? "Уся команда" : "Ваші пінги"} · натисніть цифру, щоб працювати</p></div></div>
    <div class="home-tiles">${tiles.join("")}</div>
  </section>`;
}

/* ── потребує уваги ─────────────────────────────────────────────────────── */

/** Скільки робочих днів (пн–пт) минуло від `from` до `to` (обидва — YYYY-MM-DD). */
export function workingDaysBetween(from, to) {
  if (!from || !to || from >= to) return 0;
  let days = 0;
  const day = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (day < end) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days += 1;
  }
  return days;
}

export function attentionItems({ today, warmup, now = Date.now() }) {
  const items = [];
  for (const entry of warmup?.attention || []) items.push({ text: entry.text, go: entry.kind === "account" ? "warmup" : entry.kind === "campaign" ? "warmup" : "" });
  const synced = Date.parse(warmup?.inbox?.lastSyncedAt || "");
  if (Number.isFinite(synced) && (now - synced) / 3600000 > SYNC_STALE_HOURS) {
    items.push({ text: `Вхідні LinkedIn не оновлювались ${Math.floor((now - synced) / 3600000)} год — агент не читає акаунти.`, go: "inbox-all" });
  }
  const old = (today?.blocks?.overdue || []).filter((item) => workingDaysBetween(item.dueDay, today.today) > OLD_PING_WORKING_DAYS);
  if (old.length) items.push({ text: `${old.length} ${uaPlural(old.length, "пінг прострочено", "пінги прострочено", "пінгів прострочено")} понад ${OLD_PING_WORKING_DAYS} робочі дні.`, go: "overdue" });
  return items;
}

function attentionHtml() {
  const items = attentionItems(home);
  if (!items.length) return "";
  return `<section class="panel home-attention">
    <div class="panel-heading"><div><h2>Потребує уваги</h2></div></div>
    <ul class="home-attention-list">${items.map((item) => `<li>${item.go
      ? `<button type="button" class="text-button" data-home-go="${escapeAttr(item.go)}">${escapeHtml(item.text)}</button>`
      : escapeHtml(item.text)}</li>`).join("")}</ul>
  </section>`;
}

/* ── воронка й кампанії ─────────────────────────────────────────────────── */

function funnelHtml() {
  if (!home.warmup?.funnel) return "";
  return `<section class="panel blk-metrics home-funnel-panel">
    <div class="panel-heading"><div><h2 title="Ті самі числа, що на «Прогріві» → «Як іде розсилка»">Воронка LinkedIn</h2><p>Автозапити прогріву: від черги до відповіді</p></div>
      <button type="button" class="text-button" data-home-go="warmup"><span>Прогрів</span><i data-lucide="arrow-right"></i></button></div>
    ${homeFunnelHtml(home.warmup)}
  </section>`;
}

function campaignsHtml() {
  const lead = home.report?.campaigns || [];
  const auto = home.warmup?.campaigns || [];
  if (!lead.length && !auto.length) return "";
  const leadRows = lead.map((row) => `<div class="home-campaign">
      <span class="home-campaign-name"><b>${escapeHtml(row.name || "без назви")}</b><em>кампанія лідгенів · ${escapeHtml(CAMPAIGN_STATE[row.state] || row.state || "")}</em></span>
      <span class="home-campaign-nums"><span><b>${row.written}</b> написали</span><span><b>${row.replied}</b> відповіли</span><span><b>${row.qualified}</b> кваліфіковані</span><span><b>${row.calls}</b> ${uaPlural(row.calls, "дзвінок", "дзвінки", "дзвінків")}</span></span>
    </div>`);
  const autoRows = auto.map((row) => `<div class="home-campaign">
      <span class="home-campaign-name"><b>${escapeHtml(row.name || "без назви")}</b><em>автозапити · ${escapeHtml(CAMPAIGN_STATE[row.state] || row.state || "")}</em></span>
      <span class="home-campaign-nums"><span>${escapeHtml(row.folderName || "папку не вибрано")}</span><span><b>${row.accounts}</b> ${uaPlural(row.accounts, "акаунт", "акаунти", "акаунтів")}</span></span>
    </div>`);
  return `<section class="panel blk-list home-campaigns">
    <div class="panel-heading"><div><h2>Кампанії</h2></div>
      <button type="button" class="text-button" data-home-go="campaigns" title="WorkSpace → Кампанії: порівняння, сценарії"><span>Порівняння кампаній</span><i data-lucide="arrow-right"></i></button></div>
    <div class="home-campaign-list">${[...leadRows, ...autoRows].join("")}</div>
  </section>`;
}

function render() {
  const root = document.getElementById("homeRoot");
  if (!root) return;
  if (home.loading && !home.today && !home.warmup) {
    root.innerHTML = `<section class="panel blk-metrics"><p class="home-subtle">Збираю стан…</p></section>`;
    return;
  }
  root.innerHTML = `<div class="home-layout">
    ${planHtml()}
    ${attentionHtml()}
    ${funnelHtml()}
    ${campaignsHtml()}
    ${home.errors.length ? `<p class="home-subtle">Не все прочиталось: ${escapeHtml(home.errors.join("; "))}.</p>` : ""}
  </div>`;
  refreshIcons(root);
}

document.getElementById("homeRoot")?.addEventListener("click", (event) => {
  const go = event.target.closest("[data-home-go]")?.dataset.homeGo;
  if (!go) return;
  if (PLAN.some(([key]) => key === go)) return void openTodayBlock(go, { scope: scope() });
  if (go === "contacts") return void document.getElementById("homeContacts")?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (go === "campaigns") return void showNewContacts("campaigns");
  if (go === "inbox-all") return void openAllConversations();
  if (go === "warmup") document.querySelector('.nav-item[data-view="warmup"]')?.click();
});
