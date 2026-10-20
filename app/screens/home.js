// Головна — для адміна й менеджера (Марко 20.10, таск f50d24e9: «Головна все таки більше
// для адмінів і менеджерів, щоб слідкувати за робочим процесом лідгенів»).
//
//   · «До роботи сьогодні»: смуга дня з чотирьох частин (відповісти, прострочені, нагадати,
//     перші повідомлення) — кожна частина й підпис відкривають Вхідні → «В роботі» з цим
//     фільтром, — і кнопка «Почати з відповідей». Адмін бачить команду, лідген — себе.
//   · «По лідгенах — зараз» (адмін): у кого скільки відповідей чекає, прострочених, кому
//     сьогодні написав і скільки відповів у розмовах.
//   · «Потребує уваги» — лише справжні проблеми, рядками на м'якому тлі.
//
// Нові контакти — у Вхідні → «Нові»; історія за дні — у «По днях».

import { api, authState, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural } from "../core.js";
import { openTodayBlock } from "./today.js";
import { warmupApi } from "./warmup-accounts.js";

onScreen("home", { open: () => void openHome() });

const SYNC_STALE_HOURS = 36;
const OLD_PING_WORKING_DAYS = 2;
// Порядок — порядок роботи.
const PLAN = [
  ["replies", "відповісти", "var(--teal)"],
  ["overdue", "прострочені", "var(--state-warn)"],
  ["today", "нагадати", "var(--state-run)"],
  ["first", "перші повідомлення", "var(--muted)"]
];
const START_LABEL = { replies: "Почати з відповідей", overdue: "Почати з прострочених", today: "Почати з нагадувань", first: "Почати з перших повідомлень" };

const home = { today: null, warmup: null, day: null, errors: [], loading: false };

const isAdmin = () => authState?.user?.role === "admin";
const scope = () => (isAdmin() ? "all" : "mine");

async function openHome() {
  home.loading = true;
  render();
  const errors = [];
  const read = (promise, what) => promise.catch((error) => { if (error?.name !== "AbortError") errors.push(`${what}: ${error.message || "не прочиталось"}`); return null; });
  const [today, warmup, day] = await Promise.all([
    read(api(`/api/today?scope=${scope()}`), "пінги"),
    read(warmupApi("/home"), "прогрів"),
    isAdmin() ? read(api("/api/work/day?user=all"), "робота команди") : Promise.resolve(null)
  ]);
  Object.assign(home, { today, warmup, day, errors, loading: false });
  render();
}

/* ── пульт: смуга дня й головна кнопка ─────────────────────────────────── */

function planHtml() {
  const data = home.today;
  if (data?.configured === false) return "";
  const counts = PLAN.map(([key, label, color]) => ({ key, label, color, count: (data?.blocks?.[key] || []).length }));
  const total = counts.reduce((sum, part) => sum + part.count, 0);
  const first = counts.find((part) => part.count);
  const bar = total
    ? `<div class="home-bar" role="group" aria-label="З чого складається робота дня">${counts.filter((part) => part.count).map((part) => `<button type="button" class="home-bar-part" data-home-go="${part.key}" style="flex-grow:${part.count};--part:${part.color}" title="${escapeAttr(`${part.count} — ${part.label}`)}" aria-label="${escapeAttr(`${part.label}: ${part.count}`)}"></button>`).join("")}</div>`
    : `<div class="home-bar is-empty"></div>`;
  const legend = counts.map((part) => `<button type="button" class="home-legend-item${part.count ? "" : " is-zero"}" data-home-go="${part.key}" style="--part:${part.color}"><b>${part.count}</b> ${escapeHtml(part.label)}</button>`).join("");
  return `<section class="panel blk-metrics home-plan">
    <div class="home-plan-head">
      <div><h2>До роботи сьогодні <b>${total}</b></h2><p>${isAdmin() ? "Уся команда" : "Ваші пінги"} · натисніть частину, щоб відкрити саме її</p></div>
      ${first ? `<button type="button" class="primary-button" data-home-go="${first.key}"><span>${START_LABEL[first.key]}</span><i data-lucide="arrow-right"></i></button>` : `<span class="home-plan-done">Усе розібрано</span>`}
    </div>
    ${bar}
    <div class="home-legend">${legend}</div>
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
  for (const entry of warmup?.attention || []) items.push({ text: entry.text, go: entry.kind === "account" || entry.kind === "campaign" ? "warmup" : "" });
  const synced = Date.parse(warmup?.inbox?.lastSyncedAt || "");
  if (Number.isFinite(synced) && (now - synced) / 3600000 > SYNC_STALE_HOURS) {
    items.push({ text: `Вхідні LinkedIn не оновлювались ${Math.floor((now - synced) / 3600000)} год — агент не читає акаунти.`, go: "warmup" });
  }
  const old = (today?.blocks?.overdue || []).filter((item) => workingDaysBetween(item.dueDay, today.today) > OLD_PING_WORKING_DAYS);
  if (old.length) items.push({ text: `${old.length} ${uaPlural(old.length, "пінг прострочено", "пінги прострочено", "пінгів прострочено")} понад ${OLD_PING_WORKING_DAYS} робочі дні.`, go: "overdue" });
  return items;
}

function attentionHtml() {
  const items = attentionItems(home);
  if (!items.length) return "";
  return `<section class="panel home-attention" aria-label="Потребує уваги">
    <h2>Потребує уваги</h2>
    <div class="home-attention-list">${items.map((item) => item.go
      ? `<button type="button" class="home-attention-item" data-home-go="${escapeAttr(item.go)}"><i data-lucide="circle-alert"></i><span>${escapeHtml(item.text)}</span></button>`
      : `<p class="home-attention-item"><i data-lucide="circle-alert"></i><span>${escapeHtml(item.text)}</span></p>`).join("")}</div>
  </section>`;
}

/* ── по лідгенах — зараз (адмін) ───────────────────────────────────────── */

/** Пінги команди по виконавцях і що кожен зробив сьогодні (журнал роботи «По днях»). */
export function teamRows(today, day) {
  const rows = new Map();
  const row = (email) => {
    const key = String(email || "").toLowerCase();
    if (!rows.has(key)) rows.set(key, { email: key, name: "", replies: 0, overdue: 0, people: 0, answered: 0 });
    return rows.get(key);
  };
  for (const block of ["replies", "overdue"]) for (const item of today?.blocks?.[block] || []) if (item.assignee) row(item.assignee)[block] += 1;
  for (const person of day?.byUser || []) {
    const entry = row(person.user);
    entry.name = person.name || "";
    entry.people = Number(person.counts?.contacts) || 0;
    entry.answered = Number(person.counts?.replied) || 0;
  }
  return [...rows.values()].filter((entry) => entry.email)
    .sort((left, right) => (right.replies + right.overdue) - (left.replies + left.overdue) || left.email.localeCompare(right.email));
}

function teamHtml() {
  if (!isAdmin()) return "";
  const rows = teamRows(home.today, home.day);
  if (!rows.length) return "";
  return `<section class="panel blk-list home-team">
    <div class="panel-heading"><div><h2>По лідгенах — зараз</h2><p>Що чекає на кожного і що він зробив сьогодні. Історія — у «По днях».</p></div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Хто</th><th title="Лід написав — чекає відповіді">Відповісти</th><th title="Дата пінгу минула">Прострочені</th><th title="Унікальні люди, яким сьогодні написав чи надіслав запит">Людям сьогодні</th><th title="Відповідей у розмовах сьогодні">Відповів у розмовах</th></tr></thead>
      <tbody>${rows.map((entry) => `<tr>
        <td><b>${escapeHtml(entry.name || entry.email.split("@")[0])}</b>${entry.name ? `<small>${escapeHtml(entry.email)}</small>` : ""}</td>
        <td class="${entry.replies ? "is-hot" : ""}">${entry.replies}</td><td class="${entry.overdue ? "is-warn" : ""}">${entry.overdue}</td><td>${entry.people}</td><td>${entry.answered}</td>
      </tr>`).join("")}</tbody>
    </table></div>
  </section>`;
}

function render() {
  const root = document.getElementById("homeRoot");
  if (!root) return;
  if (home.loading && !home.today) {
    root.innerHTML = `<section class="panel blk-metrics home-plan"><p class="home-subtle">Збираю план дня…</p></section>`;
    return;
  }
  root.innerHTML = `${planHtml()}${teamHtml()}${attentionHtml()}
    ${home.errors.length ? `<p class="home-subtle">Не все прочиталось: ${escapeHtml(home.errors.join("; "))}.</p>` : ""}`;
  refreshIcons(root);
}

document.getElementById("homeRoot")?.addEventListener("click", (event) => {
  const go = event.target.closest("[data-home-go]")?.dataset.homeGo;
  if (!go) return;
  if (PLAN.some(([key]) => key === go)) return void openTodayBlock(go, { scope: scope() });
  if (go === "warmup") document.querySelector('.nav-item[data-view="warmup"]')?.click();
});
