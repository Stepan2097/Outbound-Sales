// «Статистика» — та сама, що в CRM (власник 23.10): показники з порівнянням із
// попереднім періодом, воронка обробки лідів, угоди, навантаження команди й по
// днях. Сервер кличе ті самі функції бази CRM (triage/crm-stats.mjs), тож числа
// збігаються з CRM.

import { api, authState, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

const PERIODS = [["this_week", "Цей тиждень"], ["prev_week", "Минулий тиждень"], ["this_month", "Цей місяць"], ["prev_month", "Минулий місяць"]];
const STEP_COLOR = { invited: "#64748b", accepted: "#8b5cf6", wrote: "#0a66c2", replied: "#10b981", qualified: "#14b8a6", booked_call: "#f59e0b", deal: "#ec4899" };
const CHANNELS = [["email", "Email", "emails_count", "emails_replied"], ["linkedin", "LinkedIn", "linkedin_count", "linkedin_replied"], ["whatsapp", "WhatsApp", "whatsapp_count", "whatsapp_replied"]];

const stats = { preset: "this_week", from: "", to: "", user: "all", data: null, error: "", loading: false, open: null };

onScreen("stats", { open: () => void loadStats() });

async function loadStats() {
  stats.loading = true;
  render();
  const params = new URLSearchParams(stats.from && stats.to ? { from: stats.from, to: stats.to } : { preset: stats.preset });
  if (stats.user !== "all") params.set("user", stats.user);
  try {
    stats.data = await api(`/api/stats?${params}`);
    stats.error = "";
  } catch (error) {
    stats.error = error?.message || "Статистика не прочиталась.";
  }
  stats.loading = false;
  render();
}

const number = (value) => Number(value || 0).toLocaleString("uk-UA");
const money = (value) => `$${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

function headHtml() {
  const range = stats.data?.range;
  return `<div class="stats-head">
    <div>
      <h2>Загальна статистика продажів</h2>
      <p>${range ? `${escapeHtml(dayLabel(range.from))} — ${escapeHtml(dayLabel(range.to))} · ` : ""}Таймзона аналітики: Europe/Warsaw</p>
    </div>
    <div class="stats-controls">
      <form class="stats-dates" id="statsDates">
        <input type="date" name="from" value="${escapeAttr(stats.from || range?.from || "")}" aria-label="Від" />
        <span>—</span>
        <input type="date" name="to" value="${escapeAttr(stats.to || range?.to || "")}" aria-label="До" />
        <button type="submit" class="text-button">Показати</button>
      </form>
      <div class="view-tabs stats-periods" role="tablist">${PERIODS.map(([key, word]) => `<button type="button" role="tab" class="${!stats.from && stats.preset === key ? "is-active" : ""}" data-stats-preset="${key}">${word}</button>`).join("")}</div>
    </div>
  </div>`;
}

function kpisHtml(kpis) {
  return `<div class="stats-kpis">${kpis.map((item) => `<div class="panel stats-kpi">
    <p>${escapeHtml(item.label)}</p>
    <b>${item.money ? money(item.value) : item.percent ? `${item.value}%` : number(item.value)}</b>
    <small class="${item.delta >= 0 ? "is-up" : "is-down"}">${item.delta > 0 ? "+" : ""}${item.delta}% до попереднього періоду</small>
  </div>`).join("")}</div>`;
}

/**
 * Воронка роботи за період (власник 30.10: «дуже дивні цифри … бо в одного
 * богдана сотні»): не контакти, створені в ці дні, як у CRM, а що з людьми
 * зроблено в ці дні (triage/crm-stats.mjs, workFunnel). Відсоток — від
 * попереднього кроку, де він не більший.
 */
function funnelHtml(steps, people) {
  const top = Math.max(...steps.map((step) => step.count), 1);
  return `<section class="stats-section">
    <div class="stats-section-head"><h3>1. Воронка роботи за період</h3>
      <select id="statsUser" aria-label="Лідген"><option value="all">Усі лідгени</option>${people.map((person) => `<option value="${escapeAttr(person.id)}"${stats.user === person.id ? " selected" : ""}>${escapeHtml(person.email)}</option>`).join("")}</select>
    </div>
    <div class="panel stats-funnel">
      ${steps.map((step) => {
        const width = step.count ? Math.max((step.count / top) * 100, 1.2) : 0;
        return `<div class="stats-funnel-row">
          <span class="stats-funnel-label" data-tip="${escapeAttr(step.hint)}">${escapeHtml(step.label)}</span>
          <div class="stats-funnel-track">${step.count ? `<div class="stats-funnel-bar" style="width:${width}%;background:${STEP_COLOR[step.key]}">${number(step.count)}</div>` : '<span class="stats-zero">0</span>'}</div>
          <span class="stats-funnel-rate">${step.rate === null ? "" : `${step.rate}%`}</span>
        </div>`;
      }).join("")}
      <div class="stats-funnel-foot">Кожен крок — люди, а не повідомлення; відсоток — від попереднього кроку.</div>
    </div>
  </section>`;
}

function dealsHtml(deals) {
  const tile = (label, value, tone = "") => `<div class="panel stats-deal"><p>${label}</p><b class="${tone}">${value}</b></div>`;
  return `<section class="stats-section"><h3>2. Угоди та результат</h3>
    <div class="stats-deals">${tile("Won", number(deals.won), "is-up")}${tile("Lost", number(deals.lost), "is-down")}${tile("Сума Won", money(deals.revenue))}${tile("Середній чек Won", money(deals.average))}</div>
  </section>`;
}

function channelHint(details, sent) {
  if (!details) return "";
  const lines = sent
    ? [["Повідомлень", details.sent_messages], ["Людям", details.sent_people], ["Перше повідомлення людині", details.sent_first], ["Друге", details.sent_second], ["Третє й далі", details.sent_third_plus]]
    : [["Людей відписало", details.replied_people], ...(details.sent_people ? [["Від тих, кому писали", `≈ ${Math.round((details.replied_people / details.sent_people) * 100)}%`]] : []), ["Уперше", details.replied_first_time], ["Вже відписували раніше", details.replied_repeat], ["Після 1-го повідомлення", details.replied_after_1], ["Після 2-го", details.replied_after_2], ["Після 3-го й далі", details.replied_after_3_plus]];
  return lines.map(([label, value]) => `${label}: ${value}`).join("\n");
}

function teamHtml(team) {
  const cell = (value, title = "", kind = "") => `<td class="is-number${value ? ` ${kind}` : " stats-zero"}"${title ? ` data-tip="${escapeAttr(title)}"` : ""}>${number(value)}</td>`;
  const totalTitle = (row) => [["Всього дій", row.total_activities], ["LinkedIn повідомлення", row.linkedin_count], ["Email повідомлення", row.emails_count], ["WhatsApp повідомлення", row.whatsapp_count], ["Нотатки", row.notes_count], ["Сейлз", row.calls_count], ["Відповіді контактів", row.incoming_count], ["Зустрічі", row.meeting_activities], ["Забуковані дзвінки", row.booked_calls]]
    .filter(([, value], index) => index === 0 || value).map(([label, value]) => `${label}: ${value}`).join("\n") + "\n«Відписало» рахує людей, а не дії, тому в суму не входить.";
  return `<div class="panel stats-table-panel"><div class="table-wrap"><table class="stats-table">
    <thead>
      <tr><th rowspan="2">Користувач</th>${CHANNELS.map(([, label]) => `<th colspan="2" class="stats-group">${label}</th>`).join("")}<th rowspan="2" class="is-number">Meeting</th><th rowspan="2" class="is-number">Всього дій</th><th rowspan="2" class="is-number">Угоди</th></tr>
      <tr>${CHANNELS.map(() => '<th class="is-number stats-group">написали</th><th class="is-number">відписало</th>').join("")}</tr>
    </thead>
    <tbody>${team.map((row) => `<tr>
      <td>${escapeHtml(row.email)}</td>
      ${CHANNELS.map(([key, , sent, replied]) => `${cell(row[sent], channelHint(row.channels?.[key], true))}${cell(row[replied], channelHint(row.channels?.[key], false), "is-replied")}`).join("")}
      ${cell(row.meetings_count)}${cell(row.total_activities, row.total_activities ? totalTitle(row) : "", "is-total")}${cell(row.deals_created)}
    </tr>`).join("")}</tbody>
  </table></div></div>`;
}

const hours = (minutes) => (minutes ? `${Math.floor(minutes / 60)} год ${String(minutes % 60).padStart(2, "0")} хв` : "0");

/**
 * Години (власник 23.10: «а де години?»): час роботи — один на CRM і Outbound,
 * відрізки, що перекриваються, не додаються (triage/crm-sessions.mjs); дій на
 * годину — «Всього дій» на цей час. Як у CRM — лише для адміністратора.
 */
function trackerHtml(team) {
  if (authState?.user?.role !== "admin") return "";
  const rows = [...team].filter((row) => row.minutes || row.total_activities).sort((left, right) => right.minutes - left.minutes || String(left.email).localeCompare(String(right.email)));
  return `<div class="panel stats-table-panel"><h4>Ефективність по трекеру: дій на годину і час роботи</h4>
    <p class="stats-subtle stats-note">Час роботи — вкладки CRM і Outbound, поки людина ними користується (рух миші чи клавіші за останні 3 хв), і її дії: LinkedIn через розширення CRM, нотатки, статуси, угоди, задачі, листи й відповіді з Outbound. Дії, між якими не більше 3 хв, — одна безперервна робота; відправлене агентом не рахується; що перекривається, рахується раз.</p>
    <div class="table-wrap"><table class="stats-table">
      <thead><tr><th>Користувач</th><th class="is-number">Дій / год</th><th class="is-number">Час роботи</th><th class="is-number" data-tip="Дій людини, з яких рахується час">Дій</th><th class="is-number">Всього дій</th></tr></thead>
      <tbody>${rows.length ? rows.map((row) => `<tr data-tip="${escapeAttr((row.weekdayMinutes || []).filter((day) => day.minutes).map((day) => `${day.label}: ${hours(day.minutes)}`).join("\n"))}">
        <td>${escapeHtml(row.email)}</td><td class="is-number">${row.actionsPerHour ? row.actionsPerHour.toLocaleString("uk-UA") : "—"}</td>
        <td class="is-number">${hours(row.minutes)}</td><td class="is-number">${number(row.actions)}</td><td class="is-number">${number(row.total_activities)}</td>
      </tr>`).join("") : '<tr><td colspan="5" class="stats-subtle">За цей період ніхто не працював.</td></tr>'}</tbody>
    </table></div></div>`;
}

function dailyHtml(daily) {
  if (!daily.length) return '<div class="panel"><p class="stats-subtle">За цей період нічого не додано й не зроблено.</p></div>';
  return `<div class="panel stats-table-panel"><h4>По кожному користувачу за день: додані контакти та сейлз активності</h4><div class="table-wrap stats-daily"><table class="stats-table">
    <thead><tr><th>День</th><th>Користувач</th><th class="is-number">Додано контактів</th><th class="is-number">Сейлз активності</th></tr></thead>
    <tbody>${daily.map((row) => `<tr><td>${escapeHtml(dayLabel(row.day))}</td><td>${escapeHtml(row.email)}</td><td class="is-number">${number(row.contactsAdded)}</td><td class="is-number">${number(row.salesActivities)}</td></tr>`).join("")}</tbody>
  </table></div></div>`;
}

function render() {
  const root = document.getElementById("statsRoot");
  if (!root) return;
  const data = stats.data;
  if (!data) {
    root.innerHTML = `${headHtml()}<div class="panel"><p class="stats-subtle">${escapeHtml(stats.error || "Рахую…")}</p></div>`;
    return;
  }
  root.innerHTML = `${headHtml()}
    ${stats.error ? `<p class="esp-notice is-bad">${escapeHtml(stats.error)}</p>` : ""}
    <div class="${stats.loading ? "stats-busy" : ""}">
      ${kpisHtml(data.kpis)}
      ${funnelHtml(data.work || [], data.people || [])}
      ${dealsHtml(data.deals)}
      <section class="stats-section"><h3>3. Навантаження команди</h3>${teamHtml(data.team)}${trackerHtml(data.team)}${dailyHtml(data.daily)}</section>
    </div>`;
  refreshIcons(root);
}

const root = () => document.getElementById("statsRoot");

root()?.addEventListener("click", (event) => {
  const preset = event.target.closest("[data-stats-preset]")?.dataset.statsPreset;
  if (!preset) return;
  Object.assign(stats, { preset, from: "", to: "" });
  void loadStats();
});

// Підказки — одразу при наведенні (власник 30.10: «ця підказка має зявлятися
// одразу при наведенні»), а не через секунду, як title. Одна плаваюча на
// сторінку: таблиці прокручуються й обрізали б підказку всередині себе.
const tip = document.createElement("div");
tip.className = "stats-tip";
tip.hidden = true;
document.body.append(tip);

root()?.addEventListener("mouseover", (event) => {
  const target = event.target.closest("[data-tip]");
  if (!target?.dataset.tip) return void (tip.hidden = true);
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left), window.innerWidth - tip.offsetWidth - 8);
  const below = box.bottom + 6 + tip.offsetHeight <= window.innerHeight;
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? box.bottom + 6 : Math.max(8, box.top - tip.offsetHeight - 6)}px`;
});
root()?.addEventListener("mouseleave", () => { tip.hidden = true; });
window.addEventListener("scroll", () => { tip.hidden = true; }, true);

root()?.addEventListener("change", (event) => {
  if (event.target.id !== "statsUser") return;
  stats.user = event.target.value || "all";
  void loadStats();
});

root()?.addEventListener("submit", (event) => {
  if (event.target.id !== "statsDates") return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target).entries());
  if (!values.from || !values.to || values.from > values.to) return;
  Object.assign(stats, { from: values.from, to: values.to });
  void loadStats();
});
