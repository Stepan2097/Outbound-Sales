// Листи → «Звіти» (ESP 16): щодня по відправнику й домену, по кампанії — з
// внеском кожного кроку, темою, версією тексту й джерелом ліда; CSV для таблиць.
// Внизу — строк зберігання: скільки неактивних лідів чекають анонімізації.
//
// Відкриттів і кліків тут немає й не буде: листи без пікселя й переписаних
// посилань (ESP 2), тож будь-яке таке число було б вигадане.

import { api, escapeHtml, onScreen, refreshIcons } from "../core.js";

onScreen("email", { open: () => void loadEspReports() });

const VIEWS = { senders: "Відправники", domains: "Домени", campaigns: "Кампанії" };
const PERIODS = { 7: "7 днів", 30: "30 днів", 90: "90 днів" };

export const espReportsState = { view: "senders", days: 7, daily: null, campaigns: null, retention: null, error: "", notice: "", busy: false };

const fromDate = (days) => new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
const pct = (value) => `${String(value).replace(".", ",")}%`;
const codes = (map) => Object.entries(map || {}).map(([code, count]) => `${escapeHtml(code)}×${count}`).join(" ") || "—";

export async function loadEspReports() {
  if (!document.getElementById("espReportsBody")) return;
  const state = espReportsState;
  try {
    const [daily, campaigns, retention] = await Promise.all([
      api(`/api/esp/reports/senders?from=${fromDate(state.days)}`),
      api("/api/esp/reports/campaigns"),
      api("/api/esp/retention").catch(() => null)
    ]);
    Object.assign(state, { daily, campaigns: campaigns.campaigns, retention, error: "" });
  } catch (error) {
    state.error = error?.status === 403 ? "Звіти бачить команда з правом читати відповіді." : error?.message || "Звіти не прочиталися.";
  }
  renderEspReports();
}

function dailyTable(rows, by) {
  if (!rows.length) return `<p class="esp-subtle">За цей період листів не було.</p>`;
  const totals = rows.reduce((sum, row) => {
    for (const key of ["sent", "bounces", "replies", "positive", "unsubscribes"]) sum[key] = (sum[key] || 0) + row[key];
    return sum;
  }, {});
  return `<div class="table-wrap"><table class="esp-report-table">
    <thead><tr><th>День</th><th>${by === "domains" ? "Домен" : "Відправник"}</th><th>Надіслано</th><th>Bounce</th><th>Коди</th><th>Відповіді</th><th>Позитивні</th><th>Автовідп.</th><th>Відписки</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td>${escapeHtml(row.day)}</td>
      <td>${escapeHtml(by === "domains" ? `${row.domain} (${row.senders})` : row.sender)}</td>
      <td>${row.sent}<span class="esp-report-sub"> · ${row.firsts}+${row.followups}</span></td>
      <td class="${row.bounceRate >= 3 ? "is-bad" : ""}">${row.bounces}<span class="esp-report-sub"> · ${pct(row.bounceRate)}</span></td>
      <td class="esp-report-codes">${codes(row.bounceCodes)}</td>
      <td>${row.replies}</td><td>${row.positive}</td><td>${row.autoreplies}</td><td>${row.unsubscribes}</td>
    </tr>`).join("")}</tbody>
    <tfoot><tr><td>Разом</td><td></td><td>${totals.sent}</td><td>${totals.bounces}</td><td></td><td>${totals.replies}</td><td>${totals.positive}</td><td></td><td>${totals.unsubscribes}</td></tr></tfoot>
  </table></div>
  <p class="esp-subtle">«Надіслано» — перші листи + фолоуапи. Bounce вище 3% за день підсвічено.</p>`;
}

function splitTable(title, rows, key) {
  if (rows.length < 2) return "";
  return `<div class="esp-report-split"><h4>${title}</h4><table class="esp-report-table is-compact">
    <thead><tr><th></th><th>Людей</th><th>Відповіли</th><th>Позитивні</th></tr></thead>
    <tbody>${rows.map((row) => `<tr><td>${escapeHtml(row[key])}</td><td>${row.people}</td><td>${row.replied} · ${pct(row.replyRate)}</td><td>${row.positive} · ${pct(row.positiveRate)}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function campaignsHtml(campaigns) {
  if (!campaigns.length) return `<p class="esp-subtle">Жодна кампанія ще не надіслала листів.</p>`;
  return campaigns.map((campaign) => `<article class="esp-report-campaign">
    <header>
      <strong>${escapeHtml(campaign.name)}</strong>
      <span class="esp-subtle">${campaign.people} людей · відповіли ${campaign.replied} (${pct(campaign.replyRate)}) · позитивні ${campaign.positive} (${pct(campaign.positiveRate)}) · hard bounce ${campaign.bounced} · відписались ${campaign.unsubscribed}</span>
    </header>
    <table class="esp-report-table is-compact">
      <thead><tr><th>Лист</th><th>Надіслано</th><th>Відповіли на нього</th><th>Позитивні</th><th>Частка всіх відповідей</th></tr></thead>
      <tbody>${campaign.steps.map((step) => `<tr><td>${step.step}-й</td><td>${step.sent}</td><td>${step.replied} · ${pct(step.replyRate)}</td><td>${step.positive}</td>
        <td><span class="esp-report-bar"><span style="width:${Math.min(100, step.shareOfReplies)}%"></span></span> ${pct(step.shareOfReplies)}</td></tr>`).join("")}</tbody>
    </table>
    <div class="esp-report-splits">
      ${splitTable("Тема першого листа", campaign.bySubject, "subject")}
      ${splitTable("Версія тексту", campaign.byVariant, "variant")}
      ${splitTable("Джерело ліда", campaign.bySource, "source")}
    </div>
  </article>`).join("");
}

function retentionHtml(retention) {
  if (!retention) return "";
  const last = retention.last
    ? `востаннє ${escapeHtml(new Date(retention.last.at).toLocaleDateString("uk-UA"))}, анонімізовано ${retention.last.count}`
    : "ще не запускався";
  return `<div class="esp-report-retention">
    <div>
      <strong>Строк зберігання — ${retention.days} днів</strong>
      <p class="esp-subtle">Завершені й зупинені ланцюжки без руху довше за строк знеособлюються щодня: адреса стає хешем, ім'я, компанія й посада зникають, лишаються країна й джерело для звітів. Виключення (відписки, «ні», hard bounce) — назавжди. Зараз чекають: <b>${retention.due}</b>; ${last}.</p>
    </div>
    ${retention.canRun ? `<button type="button" class="text-button" data-esp-retention-run${espReportsState.busy || !retention.due ? " disabled" : ""}><i data-lucide="eraser"></i><span>Знеособити зараз</span></button>` : ""}
  </div>`;
}

export function renderEspReports() {
  const root = document.getElementById("espReportsBody");
  if (!root) return;
  const state = espReportsState;
  if (state.error && !state.daily) { root.innerHTML = `<div class="empty-state">${escapeHtml(state.error)}</div>`; return; }
  if (!state.daily) { root.innerHTML = '<div class="empty-state">Рахуємо звіти...</div>'; return; }
  const csv = state.view === "campaigns"
    ? "/api/esp/reports/campaigns?format=csv"
    : `/api/esp/reports/senders?format=csv&by=${state.view === "domains" ? "domain" : "sender"}&from=${fromDate(state.days)}`;
  root.innerHTML = `
    ${state.notice ? `<p class="esp-notice ${state.error ? "is-bad" : ""}">${escapeHtml(state.notice)}</p>` : ""}
    <div class="esp-report-bar-row">
      <div class="esp-report-tabs" role="tablist">${Object.entries(VIEWS).map(([key, label]) => `<button type="button" role="tab" aria-selected="${state.view === key}" data-esp-report-view="${key}">${label}</button>`).join("")}</div>
      ${state.view === "campaigns" ? "" : `<div class="esp-report-tabs">${Object.entries(PERIODS).map(([days, label]) => `<button type="button" aria-pressed="${state.days === Number(days)}" data-esp-report-days="${days}">${label}</button>`).join("")}</div>`}
      <a class="text-button esp-report-csv" href="${csv}" download><i data-lucide="download"></i><span>CSV</span></a>
    </div>
    ${state.view === "campaigns" ? campaignsHtml(state.campaigns || []) : dailyTable(state.daily[state.view] || [], state.view)}
    ${retentionHtml(state.retention)}`;
  refreshIcons();
}

document.getElementById("espReportsBody")?.addEventListener("click", async (event) => {
  const state = espReportsState;
  const view = event.target.closest("[data-esp-report-view]")?.dataset.espReportView;
  if (view) { state.view = view; renderEspReports(); return; }
  const days = event.target.closest("[data-esp-report-days]")?.dataset.espReportDays;
  if (days) { state.days = Number(days); await loadEspReports(); return; }
  if (!event.target.closest("[data-esp-retention-run]")) return;
  state.busy = true;
  renderEspReports();
  try {
    const result = await api("/api/esp/retention/run", { method: "POST", body: "{}" });
    state.notice = `Знеособлено: ${result.anonymized}.`;
    state.error = "";
  } catch (error) {
    state.error = error?.message || "Не вдалося.";
    state.notice = state.error;
  } finally {
    state.busy = false;
    await loadEspReports();
  }
});
