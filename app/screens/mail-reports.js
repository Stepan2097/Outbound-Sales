// Звіти (ESP-UI 6, як екран Snov 06): зверху фільтри — кампанія, скринька,
// період; картки «Надіслано» (перші листи й фолоуапи) і «Доставлено» (і bounce),
// воронка «Написали → Відповіли → Позитивні», відписки й автовідповіді; під ними
// графік по днях, тижнях чи місяцях. Усе — з журналу відправок.
//
// Відкриттів і кліків, як у Snov, тут немає й не буде: листи без пікселя й
// переписаних посилань (ESP 2), тож такі числа були б вигадані — і сторінка
// так і каже («Як рахуємо»).

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural } from "../core.js";

const PERIODS = { 7: "Останні 7 днів", 30: "Останні 30 днів", 90: "Останні 90 днів", 365: "Останній рік", 0: "Увесь час" };
const BUCKETS = { day: "По днях", week: "По тижнях", month: "По місяцях" };
const SERIES = [
  ["sent", "Надіслано", "var(--blue)"],
  ["firsts", "Перші листи", "var(--violet)"],
  ["followups", "Фолоуапи", "var(--teal)"],
  ["replies", "Відповіді", "var(--green)"],
  ["positive", "Позитивні", "#d7f065"],
  ["unsubscribes", "Відписки", "var(--amber)"],
  ["autoreplies", "Автовідповіді", "var(--muted)"],
  ["bounces", "Bounce", "var(--red)"]
];

export const reportsState = {
  filters: { campaign: "", sender: "", days: 30, bucket: "day" },
  shown: new Set(["sent", "replies", "bounces"]),
  data: null,
  error: "",
  explain: false
};

onScreen("reports", { open: () => void loadReports() });

const isoDay = (date) => date.toISOString().slice(0, 10);

function range() {
  const days = Number(reportsState.filters.days);
  if (!days) return { from: "", to: "" };
  const to = new Date();
  return { from: isoDay(new Date(to.getTime() - (days - 1) * 86_400_000)), to: isoDay(to) };
}

export async function loadReports() {
  if (!document.getElementById("reportsTop")) return;
  const { campaign, sender, bucket } = reportsState.filters;
  const params = new URLSearchParams({ bucket, ...range() });
  if (campaign) params.set("campaign", campaign);
  if (sender) params.set("sender", sender);
  try {
    reportsState.data = await api(`/api/esp/reports/summary?${params}`);
    reportsState.error = "";
  } catch (error) {
    reportsState.error = error?.status === 403 ? "Звіти бачить команда з правом читати відповіді — його дає адміністратор." : error?.message || "Звіти не прочиталися.";
  }
  renderReports();
}

// ── малювання ─────────────────────────────────────────────────────────────

const number = (value) => Number(value || 0).toLocaleString("uk-UA");
const pct = (value) => `${String(value ?? 0).replace(".", ",")}%`;

/** A ring of two parts — as Snov's donuts — drawn as two arcs of one circle. */
function ring(parts, icon) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const radius = 34;
  const length = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = total ? parts.map((part) => {
    const size = (part.value / total) * length;
    const arc = `<circle cx="44" cy="44" r="${radius}" fill="none" stroke="${part.color}" stroke-width="12" stroke-dasharray="${size} ${length - size}" stroke-dashoffset="${-offset}" />`;
    offset += size;
    return arc;
  }).join("") : `<circle cx="44" cy="44" r="${radius}" fill="none" stroke="var(--line)" stroke-width="12" />`;
  return `<div class="reports-ring"><svg viewBox="0 0 88 88" aria-hidden="true"><g transform="rotate(-90 44 44)">${arcs}</g></svg><i data-lucide="${icon}"></i></div>`;
}

function filtersHtml(data) {
  const option = (value, text, current) => `<option value="${escapeAttr(value)}"${String(current) === String(value) ? " selected" : ""}>${escapeHtml(text)}</option>`;
  const { campaign, sender, days } = reportsState.filters;
  return `
    <div class="mail-toolbar reports-filters">
      <select id="reportsCampaign" aria-label="Кампанія">${option("", "Усі кампанії", campaign)}${(data?.campaigns || []).map((row) => option(row.id, row.name, campaign)).join("")}</select>
      <select id="reportsSender" aria-label="Скринька">${option("", "Усі скриньки", sender)}${(data?.senders || []).map((email) => option(email, email, sender)).join("")}</select>
      <select id="reportsDays" aria-label="Період">${Object.entries(PERIODS).map(([value, text]) => option(value, text, days)).join("")}</select>
    </div>`;
}

function cardsHtml(data) {
  const { totals, funnel, people } = data;
  const steps = [
    ["Написали людям", funnel.contacted, 100],
    ["Відповіли", funnel.replied, funnel.replyRate],
    ["Позитивні", funnel.positive, funnel.positiveRate]
  ];
  const top = Math.max(1, funnel.contacted);
  return `
    <div class="reports-cards">
      <div class="reports-stack">
        <article class="reports-card">
          <div class="reports-card-head">${ring([{ value: totals.firsts, color: "var(--violet)" }, { value: totals.followups, color: "var(--teal)" }], "mail")}<div><span>Надіслано листів</span><strong>${number(totals.sent)}</strong></div></div>
          <div class="reports-legend"><span><i style="background:var(--violet)"></i>Перші: <b>${pct(totals.firstsRate)}</b> (${number(totals.firsts)})</span><span><i style="background:var(--teal)"></i>Фолоуапи: <b>${pct(totals.followupsRate)}</b> (${number(totals.followups)})</span></div>
        </article>
        <article class="reports-card">
          <div class="reports-card-head">${ring([{ value: totals.delivered, color: "var(--violet)" }, { value: totals.bounced, color: "var(--red)" }], "circle-check")}<div><span>Доставлено</span><strong>${pct(totals.deliveredRate)}</strong></div></div>
          <div class="reports-legend"><span><i style="background:var(--violet)"></i>Доставлено: <b>${pct(totals.deliveredRate)}</b> (${number(totals.delivered)})</span><span><i style="background:var(--red)"></i>Bounce: <b>${pct(totals.bouncedRate)}</b> (${number(totals.bounced)}${totals.hardBounced ? `, з них 5.x.x — ${number(totals.hardBounced)}` : ""})</span></div>
        </article>
      </div>
      <article class="reports-card reports-funnel">
        <h2>Воронка відповідей</h2>
        <p>Скільки людей отримали лист, скільки з них відповіли і скільки — позитивно. Рахується на людину, не на лист.</p>
        <div class="reports-funnel-bars">${steps.map(([label, value, share]) => `
          <div class="reports-funnel-step">
            <span>${label}</span>
            <strong>${number(value)}</strong>
            <div class="reports-funnel-bar"><div style="height:${Math.max(2, Math.round((value / top) * 100))}%"><em>${pct(share)}</em></div></div>
          </div>`).join("")}</div>
      </article>
      <div class="reports-stack">
        <article class="reports-card reports-mini"><span class="reports-mini-icon is-warn"><i data-lucide="mail-x"></i></span><div><span>Відписались</span><strong>${pct(people.unsubscribedRate)}</strong><small>${number(people.unsubscribed)} ${uaPlural(people.unsubscribed, "людина", "людини", "людей")}</small></div></article>
        <article class="reports-card reports-mini"><span class="reports-mini-icon"><i data-lucide="reply"></i></span><div><span>Автовідповіді</span><strong>${pct(people.autorepliedRate)}</strong><small>${number(people.autoreplied)} ${uaPlural(people.autoreplied, "людина", "людини", "людей")}</small></div></article>
        <article class="reports-card reports-mini"><span class="reports-mini-icon is-good"><i data-lucide="thumbs-up"></i></span><div><span>Позитивні відповіді</span><strong>${number(funnel.positive)}</strong><small>${pct(funnel.positiveRate)} від тих, кому писали</small></div></article>
      </div>
    </div>`;
}

const shortPeriod = (period, bucket) => {
  if (bucket === "month") return new Date(`${period}-01T00:00:00Z`).toLocaleDateString("uk-UA", { month: "short", year: "numeric" });
  const date = new Date(`${period}T00:00:00Z`);
  const text = date.toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
  if (bucket !== "week") return text;
  const end = new Date(date.getTime() + 6 * 86_400_000).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
  return `${text} – ${end}`;
};

/** The chart: one area per series that is switched on, on one scale. */
function chartHtml(data) {
  const series = data.series || [];
  const shown = SERIES.filter(([key]) => reportsState.shown.has(key));
  const width = 1000;
  const height = 260;
  const pad = { left: 44, right: 12, top: 12, bottom: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap((row) => shown.map(([key]) => row[key] || 0)));
  const nice = (() => { const step = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / step) * step; })();
  const x = (index) => pad.left + (series.length <= 1 ? plotW / 2 : (index / (series.length - 1)) * plotW);
  const y = (value) => pad.top + plotH - (value / nice) * plotH;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((share) => {
    const value = Math.round(nice * share);
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}" class="reports-grid" /><text x="${pad.left - 8}" y="${y(value) + 4}" class="reports-axis" text-anchor="end">${number(value)}</text>`;
  }).join("");
  const every = Math.max(1, Math.ceil(series.length / 8));
  // The last period always gets its label; the regular one before it gives way when they would touch.
  const ticks = series.map((row, index) => ((index % every === 0 && series.length - 1 - index >= Math.ceil(every / 2)) || index === series.length - 1)
    ? `<text x="${x(index)}" y="${height - 8}" class="reports-axis" text-anchor="middle">${escapeHtml(shortPeriod(row.period, data.bucket))}</text>` : "").join("");
  const areas = shown.map(([key, , color]) => {
    if (!series.length) return "";
    const points = series.map((row, index) => `${x(index).toFixed(1)},${y(row[key] || 0).toFixed(1)}`);
    const area = `M${x(0).toFixed(1)},${y(0)} L${points.join(" L")} L${x(series.length - 1).toFixed(1)},${y(0)} Z`;
    return `<path d="${area}" fill="${color}" fill-opacity="0.18" /><polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" />`;
  }).join("");
  const dots = series.length === 1 ? shown.map(([key, , color]) => `<circle cx="${x(0)}" cy="${y(series[0][key] || 0)}" r="4" fill="${color}" />`).join("") : "";
  const total = (key) => series.reduce((sum, row) => sum + (row[key] || 0), 0);
  return `
    <section class="reports-chart-card">
      <div class="reports-chart-head">
        <div class="reports-tabs" role="tablist">${Object.entries(BUCKETS).map(([key, text]) => `<button type="button" role="tab" aria-selected="${reportsState.filters.bucket === key}" data-reports-bucket="${key}">${text}</button>`).join("")}</div>
      </div>
      ${series.some((row) => shown.some(([key]) => row[key])) ? "" : '<p class="reports-empty">За цей період таких подій не було.</p>'}
      <svg class="reports-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Графік листів за періодами">${grid}${areas}${dots}${ticks}</svg>
      <div class="reports-series">${SERIES.map(([key, text, color]) => `<button type="button" class="${reportsState.shown.has(key) ? "is-on" : ""}" aria-pressed="${reportsState.shown.has(key)}" data-reports-series="${key}"><i style="background:${color}"></i>${text} <small>${number(total(key))}</small></button>`).join("")}</div>
    </section>`;
}

export function renderReports() {
  const root = document.getElementById("reportsTop");
  if (!root) return;
  const data = reportsState.data;
  const { from, to } = range();
  const csv = `/api/esp/reports/senders?format=csv&by=sender${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`;
  const head = `
    <div class="reports-head">
      <button type="button" class="text-button" data-reports-explain aria-expanded="${reportsState.explain}"><i data-lucide="book-open"></i><span>Як рахуємо</span></button>
      <a class="text-button reports-csv" href="${csv}" download><i data-lucide="download"></i><span>Експорт CSV</span></a>
    </div>
    ${reportsState.explain ? `<div class="mail-banner reports-explain"><i data-lucide="info"></i><p>Усе — з журналу відправок. <b>Надіслано</b> — листи, які прийняв Gmail; <b>доставлено</b> — надіслані мінус bounce; <b>воронка</b> рахує людей: скільки отримали хоч один лист, скільки відповіли, скільки відповіли позитивно (мітка відповіді, з правками людей). <b>Відкриттів і кліків немає</b>: листи без пікселя й переписаних посилань, тож такі числа були б вигадані. Період — за датою події в UTC.</p></div>` : ""}`;
  if (reportsState.error && !data) { root.innerHTML = `${head}<div class="empty-state">${escapeHtml(reportsState.error)}</div>`; refreshIcons(root); return; }
  if (!data) { root.innerHTML = `${head}<div class="empty-state">Рахуємо звіти...</div>`; return; }
  root.innerHTML = `${head}${filtersHtml(data)}${cardsHtml(data)}${chartHtml(data)}`;
  refreshIcons(root);
}

// ── дії ───────────────────────────────────────────────────────────────────

const root = () => document.getElementById("reportsTop");

root()?.addEventListener("change", (event) => {
  const filter = { reportsCampaign: "campaign", reportsSender: "sender", reportsDays: "days" }[event.target.id];
  if (!filter) return;
  reportsState.filters[filter] = event.target.value;
  void loadReports();
});

root()?.addEventListener("click", (event) => {
  if (event.target.closest("[data-reports-explain]")) { reportsState.explain = !reportsState.explain; return renderReports(); }
  const bucket = event.target.closest("[data-reports-bucket]")?.dataset.reportsBucket;
  if (bucket) { reportsState.filters.bucket = bucket; return void loadReports(); }
  const series = event.target.closest("[data-reports-series]")?.dataset.reportsSeries;
  if (series) {
    if (reportsState.shown.has(series)) { if (reportsState.shown.size > 1) reportsState.shown.delete(series); }
    else reportsState.shown.add(series);
    renderReports();
  }
});
