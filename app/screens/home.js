// Головна (Марко 19.10, таск ca978070): «Пульт зверху, конвеєр під ним».
//
//   · Пульт — «До роботи сьогодні»: смуга прогресу дня з чотирьох частин (відповісти,
//     прострочені, нагадати, перші повідомлення; Г2) — кожна частина й підпис відкривають
//     Вхідні → «До роботи» з цим блоком, — і одна головна кнопка «Почати з відповідей» (Г1).
//   · «Потребує уваги» — лише справжні проблеми, рядками на м'якому тлі: увага прогріву,
//     вхідні не читались понад 36 год, пінги прострочені понад 2 робочі дні.
//   · Під пультом — «Нові контакти»: конвеєр Павла (workspace.js → openNewContactsOnHome,
//     на Головній без умови «спершу розмови» — власник 19.10, 86b69f3).
//
// Воронки й кампаній тут немає: їхні числа — на «Прогріві» й у WorkSpace.

import { api, authState, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural } from "../core.js";
import { openTodayBlock } from "./today.js";
import { openNewContactsOnHome } from "./workspace.js";
import { warmupApi } from "./warmup-accounts.js";

onScreen("home", { open: () => { void openHome(); void openNewContactsOnHome({ gate: false }); } });

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

const home = { today: null, warmup: null, errors: [], loading: false };

const isAdmin = () => authState?.user?.role === "admin";
const scope = () => (isAdmin() ? "all" : "mine");

async function openHome() {
  home.loading = true;
  render();
  const errors = [];
  const read = (promise, what) => promise.catch((error) => { if (error?.name !== "AbortError") errors.push(`${what}: ${error.message || "не прочиталось"}`); return null; });
  const [today, warmup] = await Promise.all([
    read(api(`/api/today?scope=${scope()}`), "пінги"),
    read(warmupApi("/home"), "прогрів")
  ]);
  Object.assign(home, { today, warmup, errors, loading: false });
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

function render() {
  const root = document.getElementById("homeRoot");
  if (!root) return;
  if (home.loading && !home.today) {
    root.innerHTML = `<section class="panel blk-metrics home-plan"><p class="home-subtle">Збираю план дня…</p></section>`;
    return;
  }
  root.innerHTML = `${planHtml()}${attentionHtml()}
    ${home.errors.length ? `<p class="home-subtle">Не все прочиталось: ${escapeHtml(home.errors.join("; "))}.</p>` : ""}
    <div class="home-contacts-head"><span class="eyebrow">Нові контакти</span><p>Люди з папки CRM, яким ще ніхто не писав: по одному, з готовим листом чи повідомленням.</p></div>`;
  refreshIcons(root);
}

document.getElementById("homeRoot")?.addEventListener("click", (event) => {
  const go = event.target.closest("[data-home-go]")?.dataset.homeGo;
  if (!go) return;
  if (PLAN.some(([key]) => key === go)) return void openTodayBlock(go, { scope: scope() });
  if (go === "warmup") document.querySelector('.nav-item[data-view="warmup"]')?.click();
});
