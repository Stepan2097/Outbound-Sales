// «Звіт команди» (Марко 21.10, таск 3bc6830a; був «По днях», власник 12.10): хто що
// зробив і з яким результатом — за день чи тиждень, з порівнянням з таким самим
// періодом раніше. Головна — «зараз»; тут — підсумок періоду, нічого з «зараз».
//
// Зверху — зведення (написали → відповіли → кваліфіковані → дзвінки, швидкість
// відповіді) і таблиця по лідгенах (/api/work/report, triage/team-report.mjs).
// У режимі «День» нижче — журнал дня: кому писали, хто відповів; клік — уся історія
// діалогу (LinkedIn і пошта), «Шлях» і хто з нас що робив (/api/work/day і
// /api/work/contact, triage/work-log.mjs; розмова — з /api/warmup/history і
// /api/esp/contacts/timeline, як у картках лідів).

import { api, escapeAttr, escapeHtml, keepScroll, onScreen, refreshIcons } from "../core.js";
import { pathTracks } from "./work-path.js";

onScreen("work", { open: () => void openWork() });

const ZONE = "Europe/Kyiv";
const ACTION_LABEL = {
  invited: "запит у друзі", replied: "відповідь у розмові",
  wroteLinkedin: "повідомлення в LinkedIn", wroteEmail: "лист"
};
const WORK_LABEL = {
  viewed: "переглянув картку", skipped: "пропустив", invalid: "позначив «не валідний»", enriched: "збагатив",
  drafted: "згенерував тексти", invited: "надіслав запит у друзі", wrote: "написав", replied: "відповів у розмові"
};
const FILTERS = [["all", "Усі"], ["fresh", "Нові відповіді"], ["answered", "Відповіли"], ["silent", "Без відповіді"]];

const PERIOD_KEY = "outbound.work.period";
const readPeriod = () => { try { return localStorage.getItem(PERIOD_KEY) === "week" ? "week" : "day"; } catch { return "day"; } };
const work = { period: readPeriod(), date: "", user: "", data: null, report: null, reportError: "", loading: false, error: "", filter: "all", open: "", dialog: null, timer: null };

const rootEl = () => document.getElementById("workRoot");
const visible = () => document.getElementById("view-work")?.classList.contains("active");
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: ZONE }) : "");
const when = (iso) => (iso ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: ZONE }) : "");
const shiftDay = (date, days) => new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
const dayWord = (date) => {
  const today = work.data?.today;
  if (date === today) return "Сьогодні";
  if (today && date === shiftDay(today, -1)) return "Вчора";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("uk-UA", { weekday: "short", day: "numeric", month: "long" });
};

async function openWork() {
  if (!work.data) await load();
  else render();
  clearInterval(work.timer);
  // New answers show up while the page is open: today's list is read again every minute.
  work.timer = setInterval(() => {
    if (!visible()) return clearInterval(work.timer);
    const today = work.report?.today || work.data?.today;
    const live = work.period === "week" ? work.report && today >= work.report.from && today <= work.report.to : !work.date || work.date === today;
    if (live) void load({ quiet: true });
  }, 60000);
}

async function load({ quiet = false } = {}) {
  if (!quiet) { work.loading = true; render(); }
  try {
    const query = new URLSearchParams();
    if (work.date) query.set("date", work.date);
    if (work.user) query.set("user", work.user);
    const asked = new URLSearchParams({ period: work.period });
    if (work.date) asked.set("date", work.date);
    // Тиждень — лише звіт; день — звіт і журнал дня. Кожне — окремо: якщо одне не відповіло,
    // друге однаково показується (таск de89bd49).
    const [report, day] = await Promise.allSettled([
      api(`/api/work/report?${asked}`),
      work.period === "day" || !work.data ? api(`/api/work/day?${query}`) : Promise.resolve(work.data)
    ]);
    if (day.status === "rejected") throw day.reason;
    const data = day.value;
    work.report = report.status === "fulfilled" ? report.value : null;
    work.reportError = report.status === "rejected" ? (report.reason?.message || "Звіт не прочитався.") : "";
    work.data = data;
    work.date = work.date || data.date;
    work.user = data.user;
    work.error = "";
  } catch (error) {
    work.error = error.message || "Не вдалося прочитати день.";
  }
  work.loading = false;
  render();
}

function toolbarHtml(data) {
  const date = work.date || data?.today || "";
  const users = data?.admin ? `<label class="work-user"><span>Чия робота</span><select data-work="user">
      <option value="all" ${work.user === "all" ? "selected" : ""}>Уся команда</option>
      <option value="${escapeAttr(data.viewer)}" ${work.user === data.viewer ? "selected" : ""}>Моя</option>
      ${(data.users || []).filter((row) => row.user !== data.viewer).map((row) => `<option value="${escapeAttr(row.user)}" ${work.user === row.user ? "selected" : ""}>${escapeHtml(row.name || row.user)}</option>`).join("")}
    </select></label>` : "";
  const periods = `<div class="work-periods" role="tablist" aria-label="Період">${[["day", "День"], ["week", "Тиждень"]].map(([key, label]) => `<button type="button" role="tab" aria-selected="${work.period === key}" class="${work.period === key ? "is-on" : ""}" data-work-period="${key}">${label}</button>`).join("")}</div>`;
  if (work.period === "week") {
    const report = work.report;
    const thisWeek = report && data?.today >= report.from && data?.today <= report.to;
    return `<div class="work-toolbar">
      ${periods}
      <div class="work-dates">
        <button type="button" class="icon-button" data-work="prev" title="Попередній тиждень" aria-label="Попередній тиждень"><i data-lucide="chevron-left"></i></button>
        <button type="button" class="${thisWeek ? "is-on" : ""}" data-work="today">Цей тиждень</button>
        <button type="button" class="${report && data?.today && shiftDay(data.today, -7) >= report.from && shiftDay(data.today, -7) <= report.to ? "is-on" : ""}" data-work="yesterday">Минулий</button>
        <button type="button" class="icon-button" data-work="next" title="Наступний тиждень" aria-label="Наступний тиждень" ${!report || thisWeek ? "disabled" : ""}><i data-lucide="chevron-right"></i></button>
      </div>
      <button type="button" data-work="reload" ${work.loading ? "disabled" : ""}><i data-lucide="refresh-cw"></i><span>${work.loading ? "Оновлюю…" : "Оновити"}</span></button>
    </div>`;
  }
  return `<div class="work-toolbar">
    ${periods}
    <div class="work-dates">
      <button type="button" class="icon-button" data-work="prev" title="Попередній день" aria-label="Попередній день"><i data-lucide="chevron-left"></i></button>
      <button type="button" class="${date === data?.today ? "is-on" : ""}" data-work="today">Сьогодні</button>
      <button type="button" class="${data?.today && date === shiftDay(data.today, -1) ? "is-on" : ""}" data-work="yesterday">Вчора</button>
      <input type="date" data-work="date" value="${escapeAttr(date)}" max="${escapeAttr(data?.today || "")}" aria-label="День" />
      <button type="button" class="icon-button" data-work="next" title="Наступний день" aria-label="Наступний день" ${!data || date >= data.today ? "disabled" : ""}><i data-lucide="chevron-right"></i></button>
    </div>
    ${users}
    <button type="button" data-work="reload" ${work.loading ? "disabled" : ""}><i data-lucide="refresh-cw"></i><span>${work.loading ? "Оновлюю…" : "Оновити"}</span></button>
  </div>`;
}

function daysHtml(data) {
  const days = (data?.days || []).slice().reverse();
  if (!days.length) return "";
  const most = Math.max(1, ...days.map((day) => day.contacts));
  const middle = days.findIndex((day) => day.date === work.date);
  return `<div class="work-days" aria-label="Скільком людям писали по днях">${days.map((day, index) => `
    <button type="button" class="work-day ${day.date === work.date ? "is-on" : ""} ${day.future ? "is-future" : ""} ${middle >= 0 && Math.abs(index - middle) > 3 ? "is-far" : ""}" data-work-day="${escapeAttr(day.date)}" title="${escapeAttr(day.future ? `${dayWord(day.date)}: ще попереду` : `${dayWord(day.date)}: ${day.contacts}`)}" ${day.future ? "disabled" : ""}>
      <span class="work-day-bar"><span style="height:${Math.round((day.contacts / most) * 100)}%"></span></span>
      <b>${day.contacts || ""}</b>
      <small>${escapeHtml(new Date(`${day.date}T12:00:00Z`).toLocaleDateString("uk-UA", { day: "numeric", month: "numeric" }))}</small>
    </button>`).join("")}</div>`;
}

const shortDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("uk-UA", { weekday: "short", day: "numeric", month: "numeric" });
const rangeWord = (report) => {
  const from = new Date(`${report.from}T12:00:00Z`);
  const to = new Date(`${report.to}T12:00:00Z`);
  const dayMonth = (date) => date.toLocaleDateString("uk-UA", { day: "numeric", month: "long", timeZone: "UTC" }); // «25 жовтня»
  return from.getUTCMonth() === to.getUTCMonth() ? `${from.getUTCDate()}–${dayMonth(to)}` : `${dayMonth(from)} – ${dayMonth(to)}`;
};
/** Час відповіді: хвилини, години чи дні — як людина сказала б. */
export function durationWord(minutes) {
  if (minutes == null) return "—";
  if (minutes < 60) return `${minutes} хв`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 6) / 10} год`.replace(".", ",");
  return `${Math.round(minutes / 144) / 10} дн`.replace(".", ",");
}

const weekdayWord = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("uk-UA", { weekday: "short" });
/** З чим порівнюємо: день — той самий день тиждень тому; тиждень, що ще йде, — ті самі дні минулого. */
function againstWord(report) {
  if (report.period !== "week") return shortDay(report.prevFrom);
  if (!report.partial) return "мин. тиждень";
  return report.prevFrom === report.prevTo ? `${weekdayWord(report.prevFrom)} мин. тижня` : `${weekdayWord(report.prevFrom)}–${weekdayWord(report.prevTo)} мин. тижня`;
}

/** Порівняння з таким самим періодом раніше: тиждень — з минулим, день — з тим самим днем тиждень тому. */
function deltaHtml(now, before, { lowerBetter = false, minutes = false } = {}) {
  const report = work.report;
  if (!report || now == null || before == null) return "";
  const against = againstWord(report);
  const was = minutes ? durationWord(before) : before;
  const diff = now - before;
  if (!diff) return `<em class="work-delta" title="${escapeAttr(`${against}: ${was}`)}">як ${escapeHtml(against)}</em>`;
  const good = lowerBetter ? diff < 0 : diff > 0;
  const size = minutes ? durationWord(Math.abs(diff)) : Math.abs(diff);
  return `<em class="work-delta ${good ? "is-good" : "is-bad"}" title="${escapeAttr(`${against}: ${was}`)}">${diff > 0 ? "+" : "−"}${escapeHtml(String(size))} до ${escapeHtml(against)}</em>`;
}

function summaryHtml(report) {
  const now = report.total;
  const was = report.previous || {};
  const cards = [
    ["users", "Написали людям", now.written, deltaHtml(now.written, was.written), "Людей, кому за період пішло наше повідомлення в LinkedIn чи лист"],
    ["message-circle-reply", `Відповіли${now.rate != null ? ` · ${now.rate}%` : ""}`, now.replied, deltaHtml(now.replied, was.replied), "Людей, які за період написали нам у LinkedIn чи відповіли на лист"],
    ["badge-check", "Кваліфіковані", now.qualified, deltaHtml(now.qualified, was.qualified), "Відповіді з міткою «Кваліфікована» у Workspace (AI або лідген)"],
    ["phone", "Дзвінки", now.calls, deltaHtml(now.calls, was.calls), "Статус «Дзвінок» поставлено в CRM за період"],
    ["timer", "Медіана нашої відповіді", durationWord(now.responseMedianMinutes), deltaHtml(now.responseMedianMinutes, was.responseMedianMinutes, { lowerBetter: true, minutes: true }), "Від повідомлення людини до нашої відповіді в тій самій розмові. Містить паузу агента, що читає LinkedIn раз на кілька хвилин"],
    ["hourglass", "Відповіли пізніше 24 год", now.slow, deltaHtml(now.slow, was.slow, { lowerBetter: true }), "Повідомлення людей за період, на які ми відповіли пізніше ніж за добу або ще не відповіли"]
  ];
  return `<div class="work-stats work-summary">${cards.map(([icon, label, value, note, title]) => `<div class="work-stat" title="${escapeAttr(title)}">
    <i data-lucide="${icon}"></i><b>${escapeHtml(String(value ?? 0))}</b><span>${escapeHtml(label)}</span>${note}</div>`).join("")}</div>`;
}

/** Тиждень: скільком людям писали кожного дня; клік — журнал цього дня. */
function weekDaysHtml(report) {
  if (report.period !== "week" || !report.days?.length) return "";
  const most = Math.max(1, ...report.days.map((day) => day.written));
  const today = report.today;
  return `<div class="work-days is-week" aria-label="Скільком людям писали по днях тижня">${report.days.map((day) => `
    <button type="button" class="work-day ${day.date > today ? "is-future" : ""}" data-work-open-day="${escapeAttr(day.date)}" title="${escapeAttr(day.date > today ? "ще попереду" : `${shortDay(day.date)}: ${day.written} — відкрити журнал дня`)}" ${day.date > today ? "disabled" : ""}>
      <span class="work-day-bar"><span style="height:${Math.round((day.written / most) * 100)}%"></span></span>
      <b>${day.written || ""}</b>
      <small>${escapeHtml(weekdayWord(day.date))}</small>
      <small>${escapeHtml(new Date(`${day.date}T12:00:00Z`).toLocaleDateString("uk-UA", { day: "numeric", month: "numeric" }))}</small>
    </button>`).join("")}</div>`;
}

/** По лідгенах: результат періоду, у підказці клітинки — той самий показник раніше. */
function leadgensHtml(report) {
  if (!report.admin || !report.rows?.length) return "";
  const columns = [
    ["written", "Написали", (row) => row.written],
    ["replied", "Відповіли", (row) => row.replied],
    ["rate", "% відповідей", (row) => (row.rate == null ? "—" : `${row.rate}%`)],
    ["qualified", "Кваліфіковані", (row) => row.qualified],
    ["calls", "Дзвінки", (row) => row.calls],
    ["responseMedianMinutes", "Медіана відповіді", (row) => durationWord(row.responseMedianMinutes)],
    ["slow", "Пізніше 24 год", (row) => row.slow]
  ];
  const against = againstWord(report);
  const hint = (row, [key, , show]) => (row.previous ? ` title="${escapeAttr(`${against}: ${show(row.previous)}`)}"` : "");
  return `<div class="work-team"><table>
    <thead><tr><th>Хто</th>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead>
    <tbody>${report.rows.map((row) => `<tr ${report.period === "day" && row.key.includes("@") ? `data-work-user="${escapeAttr(row.key)}"` : ""}>
      <td><b>${escapeHtml(row.name || row.key)}</b>${row.name && row.name !== row.key && row.key.includes("@") ? `<small>${escapeHtml(row.key)}</small>` : ""}${row.writtenEmail ? `<small>з них листів: ${row.writtenEmail}</small>` : ""}</td>
      ${columns.map((column) => `<td${hint(row, column)}>${escapeHtml(String(column[2](row)))}</td>`).join("")}
    </tr>`).join("")}</tbody></table></div>`;
}

/** Що зроблено кнопками порталу за день — одним рядком під зведенням, лише ненульове. */
function buttonsLine(total) {
  const parts = [["viewed", "переглянуто карток"], ["enriched", "збагачено"], ["drafted", "згенеровано текстів"], ["invited", "запитів у друзі"], ["invalid", "не валідних"], ["skipped", "пропущено"]]
    .filter(([key]) => Number(total?.[key]) > 0).map(([key, label]) => `${label} ${total[key]}`);
  return parts.length ? `<p class="work-muted work-buttons">Кнопками в порталі: ${escapeHtml(parts.join(" · "))}.</p>` : "";
}

function actionWord(action) {
  if (action.action === "wrote") return ACTION_LABEL[action.channel === "email" ? "wroteEmail" : "wroteLinkedin"];
  return ACTION_LABEL[action.action] || action.action;
}

function shown(contacts) {
  if (work.filter === "fresh") return contacts.filter((item) => item.fresh);
  if (work.filter === "answered") return contacts.filter((item) => item.answer);
  if (work.filter === "silent") return contacts.filter((item) => !item.answer);
  return contacts;
}

function rowHtml(item, data) {
  const showWho = data.user === "all" || item.users.some((user) => user !== data.viewer);
  const did = item.actions.map((action) => `<span class="work-chip is-${action.channel || "linkedin"}">${escapeHtml(actionWord(action))}${action.accountName || action.mailbox ? ` · ${escapeHtml(action.accountName || action.mailbox)}` : ""}<small>${escapeHtml(time(action.at))}${showWho ? ` · ${escapeHtml(action.userName || action.user)}` : ""}</small></span>`).join("");
  let status = '<span class="work-status is-silent">мовчить</span>';
  if (item.answer) {
    status = `<span class="work-status ${item.fresh ? "is-fresh" : "is-answered"}"><i data-lucide="${item.answer.channel === "email" ? "mail" : "message-square"}"></i>${item.fresh ? "нова відповідь" : "відповів"} · ${escapeHtml(when(item.answer.at))}</span>`;
  } else if (item.bounced) status = '<span class="work-status is-bad">лист не дійшов</span>';
  else if (item.accepted) status = `<span class="work-status is-answered"><i data-lucide="user-check"></i>прийняв запит · ${escapeHtml(when(item.accepted))}</span>`;
  return `<button type="button" class="work-row ${item.fresh ? "is-fresh" : ""} ${work.open === item.key ? "is-open" : ""}" data-work-open="${escapeAttr(item.key)}">
    <span class="work-row-head"><b>${escapeHtml(item.name)}</b>${status}</span>
    ${item.company || item.position ? `<span class="work-row-sub">${escapeHtml([item.position, item.company].filter(Boolean).join(" · "))}</span>` : ""}
    ${item.answer?.text ? `<span class="work-row-answer">«${escapeHtml(item.answer.text)}»</span>` : ""}
    <span class="work-chips">${did}</span>
  </button>`;
}

// Блок «Заплановані» прибрано (таск cd1b118c, 21.10): нагадування тим, хто мовчить,
// живуть за одним правилом — пінгами у Вхідні → «В роботі». «По днях» — історія дня.

function listHtml(data) {
  const contacts = data.contacts || [];
  const count = { all: contacts.length, fresh: contacts.filter((item) => item.fresh).length, answered: contacts.filter((item) => item.answer).length, silent: contacts.filter((item) => !item.answer).length };
  const list = shown(contacts);
  return `<div class="work-list">
    <div class="work-filters">${FILTERS.map(([key, label]) => `<button type="button" class="${work.filter === key ? "is-on" : ""} ${key === "fresh" && count.fresh ? "has-fresh" : ""}" data-work-filter="${key}">${label} <b>${count[key]}</b></button>`).join("")}</div>
    ${list.length ? `<div class="work-rows scroll-list">${list.map((item) => rowHtml(item, data)).join("")}</div>` : `<p class="work-empty">${contacts.length ? "Тут нікого." : `${escapeHtml(dayWord(work.date))} нікому не писали${data.user === "all" ? "" : " з цього логіна"}.`}</p>`}
  </div>`;
}

function dialogMessages(dialog) {
  const rows = [];
  for (const entry of dialog.linkedin?.entries || []) {
    if (entry.kind === "invite") {
      rows.push({ at: entry.at, side: "system", channel: "linkedin", text: entry.event === "invite.accepted" ? "прийняв запит у друзі" : "запит у друзі надіслано", via: entry.accountLabel });
    } else rows.push({ at: entry.at, side: entry.direction === "in" ? "in" : "out", channel: "linkedin", text: entry.body, via: entry.accountLabel });
  }
  for (const timeline of dialog.email || []) {
    const sendings = new Map(timeline.events.filter((event) => event.type === "message.sending").map((event) => [event.seq, event]));
    for (const event of timeline.events) {
      if (event.type === "message.sent") {
        const sending = sendings.get(event.data?.sendingSeq);
        rows.push({ at: event.at, side: "out", channel: "email", subject: sending?.data?.subject, text: sending?.data?.text || "", via: event.data?.from || sending?.data?.from });
      } else if (event.type === "message.replied" || event.type === "message.autoreplied") {
        rows.push({ at: event.at, side: "in", channel: "email", subject: event.data?.subject, text: event.data?.text || "", via: event.data?.sender, auto: event.type === "message.autoreplied" });
      } else if (event.type === "message.bounced") rows.push({ at: event.at, side: "system", channel: "email", text: "лист не дійшов", via: event.data?.sender });
      else if (event.type === "contact.unsubscribed") rows.push({ at: event.at, side: "system", channel: "email", text: "відписався від листів" });
    }
  }
  return rows.sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

function dialogHtml() {
  const dialog = work.dialog;
  if (!dialog) return '<aside class="work-dialog is-empty"><i data-lucide="messages-square"></i><p>Оберіть людину — тут буде вся розмова з нею (LinkedIn і пошта) і хто з нас що робив.</p></aside>';
  if (dialog.loading) return '<aside class="work-dialog"><p class="work-muted">Читаю розмову…</p></aside>';
  if (dialog.error) return `<aside class="work-dialog"><p class="esp-notice is-bad">${escapeHtml(dialog.error)}</p></aside>`;
  const contact = dialog.contact || {};
  const item = (work.data?.contacts || []).find((row) => row.key === dialog.key) || {};
  const messages = dialogMessages(dialog);
  const link = (url, label) => (url ? `<a href="${escapeAttr(/^https?:/.test(url) ? url : `https://${url}`)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i>${label}</a>` : "");
  return `<aside class="work-dialog">
    <header>
      <h3>${escapeHtml(contact.name || item.name || "")}</h3>
      <p>${escapeHtml([contact.position || item.position, contact.company || item.company].filter(Boolean).join(" · "))}</p>
      <div class="work-links">${link(contact.linkedin || item.linkedin, "LinkedIn")}${link(contact.website, "Сайт")}${(dialog.emails || []).map((email) => `<span><i data-lucide="mail"></i>${escapeHtml(email)}</span>`).join("")}</div>
    </header>
    ${pathHtml(dialog)}
    <section>
      <h4>Розмова</h4>
      ${messages.length ? `<ol class="work-thread">${messages.map((row) => `<li class="is-${row.side}">
        <span class="work-meta"><i data-lucide="${row.channel === "email" ? "mail" : "message-square"}"></i>${escapeHtml(when(row.at))}${row.via ? ` · ${escapeHtml(row.via)}` : ""}${row.auto ? " · автовідповідь" : ""}</span>
        ${row.subject ? `<strong>${escapeHtml(row.subject)}</strong>` : ""}
        <p>${escapeHtml(row.text || "")}</p>
      </li>`).join("")}</ol>` : '<p class="work-muted">Повідомлень ще немає — або агент ще не забрав їх із LinkedIn.</p>'}
      ${dialog.partial ? `<p class="work-muted">${escapeHtml(dialog.partial)}</p>` : ""}
    </section>
    <section>
      <h4>Хто що робив</h4>
      <ul class="work-log">${(dialog.work || []).map((row) => `<li><span>${escapeHtml(when(row.at))}</span> <b>${escapeHtml(row.userName || row.user)}</b> ${escapeHtml(WORK_LABEL[row.action] || row.action)}${row.channel === "email" ? " (пошта)" : row.action === "wrote" ? " (LinkedIn)" : ""}${row.accountName || row.mailbox ? ` · ${escapeHtml(row.accountName || row.mailbox)}` : ""}${row.detail && row.action !== "wrote" && row.action !== "replied" ? ` <small>${escapeHtml(row.detail)}</small>` : ""}</li>`).join("") || '<li class="work-muted">Записів немає.</li>'}</ul>
    </section>
  </aside>`;
}

/** «Шлях»: from the request to the answer, per channel — what happened, what is waiting, what comes next. */
function pathHtml(dialog) {
  const tracks = pathTracks(dialog);
  if (!tracks.length) return "";
  const stamp = (step) => (step.at ? escapeHtml(when(step.at)) : step.state === "now" ? "чекаємо" : "");
  return `<section class="work-path">
    <h4>Шлях</h4>
    ${tracks.map((track) => `<div class="work-path-track">
      <span class="work-path-channel"><i data-lucide="${track.channel === "email" ? "mail" : "message-square"}"></i>${escapeHtml(track.label)}</span>
      <ol>${track.steps.map((step) => `<li class="is-${step.state} ${step.bad ? "is-bad" : ""}"><b>${escapeHtml(step.label)}</b><small>${step.state === "next" && step.at ? `з ${escapeHtml(when(step.at))}` : stamp(step)}</small></li>`).join("")}</ol>
    </div>`).join("")}
  </section>`;
}

/** From another screen (Головна → «Щойно написали»): today, this person's card open. */
export function openWorkContact(key) {
  setPeriod("day", { quiet: true });
  document.querySelector('.nav-item[data-view="work"]')?.click();
  const today = work.data?.today;
  if (today && work.date !== today) { work.date = today; void load().then(() => openDialog(key)); return; }
  void openDialog(key);
}

async function openDialog(key) {
  work.open = key;
  work.dialog = { key, loading: true };
  render();
  try {
    const answer = await api(`/api/work/contact?key=${encodeURIComponent(key)}`);
    const contactId = key.startsWith("id:") ? key.slice(3) : "";
    const firstEmail = answer.emails?.[0] || "";
    const misses = [];
    const [linkedin, ...email] = await Promise.all([
      (contactId ? api(`/api/warmup/history?crmContactId=${encodeURIComponent(contactId)}`) : firstEmail ? api(`/api/warmup/history?email=${encodeURIComponent(firstEmail)}`) : Promise.resolve(null))
        .catch(() => { misses.push("LinkedIn"); return null; }),
      ...(answer.emails || []).map((address) => api(`/api/esp/contacts/timeline?email=${encodeURIComponent(address)}`).catch(() => { misses.push("пошту"); return null; }))
    ]);
    if (work.open !== key) return;
    work.dialog = { key, contact: answer.contact, emails: answer.emails, work: answer.work, linkedin, email: email.filter(Boolean), partial: misses.length ? `Не вдалося прочитати: ${[...new Set(misses)].join(", ")}.` : "" };
    // Opened is read: the answer stops being new for this login.
    const item = (work.data?.contacts || []).find((row) => row.key === key);
    if (item?.fresh) { item.fresh = false; work.data.total.fresh = Math.max(0, (work.data.total.fresh || 1) - 1); }
  } catch (error) {
    work.dialog = { key, error: error.message || "Не вдалося відкрити." };
  }
  render();
}

function render() {
  const root = rootEl();
  if (!root) return;
  const data = work.data;
  let body = "";
  if (work.error) body = `<p class="esp-notice is-bad">${escapeHtml(work.error)}</p>`;
  else if (!data) body = '<p class="work-muted">Читаю день…</p>';
  else {
    const report = work.report;
    const who = data.user === "all" ? " · уся команда" : data.user !== data.viewer ? ` · ${escapeHtml((data.users || []).find((row) => row.user === data.user)?.name || data.user)}` : "";
    const results = report ? `${summaryHtml(report)}${leadgensHtml(report)}` : work.reportError ? `<p class="esp-notice is-bad">Зведення не прочиталось: ${escapeHtml(work.reportError)} <button type="button" data-work="reload">Ще раз</button></p>` : "";
    body = work.period === "week"
      ? (report ? `<h2 class="work-title">Тиждень · ${escapeHtml(rangeWord(report))}${report.admin ? " · уся команда" : ""}</h2>
        ${weekDaysHtml(report)}
        ${results}
        <p class="work-muted">Журнал людей — по днях: натисніть день у смузі вище.</p>` : results)
      : `${daysHtml(data)}
        <h2 class="work-title">${escapeHtml(dayWord(work.date))}${report?.admin ? " · уся команда" : ""}</h2>
        ${results}
        ${buttonsLine(data.total)}
        <h3 class="work-subtitle">Журнал дня${who}</h3>
        <div class="work-body">${listHtml(data)}${dialogHtml()}</div>`;
  }
  const restore = keepScroll(root, [".work-rows"]);
  root.innerHTML = `${toolbarHtml(data)}${body}`;
  restore();
  refreshIcons(root);
}

/** День чи тиждень — запам'ятовується в цьому браузері. */
function setPeriod(period, { quiet = false } = {}) {
  if (period === work.period || !["day", "week"].includes(period)) return;
  work.period = period;
  try { localStorage.setItem(PERIOD_KEY, period); } catch { /* приватне вікно: просто не запам'ятається */ }
  if (!quiet) void load();
}

function pickDate(date) {
  if (!date || (date === work.date && work.report && work.report.period === work.period)) return;
  work.date = date;
  work.open = "";
  work.dialog = null;
  void load();
}

document.addEventListener("click", (event) => {
  const root = rootEl();
  if (!root || !root.contains(event.target)) return;
  const write = event.target.closest("[data-work-write]");
  if (write) {
    void import("./inbox.js").then((module) => module.showWarmupInboxThread(write.dataset.workWrite, write.dataset.workThread));
    return;
  }
  const control = event.target.closest("[data-work], [data-work-day], [data-work-open-day], [data-work-period], [data-work-filter], [data-work-open], [data-work-user]");
  if (!control) return;
  if (control.dataset.workPeriod) return setPeriod(control.dataset.workPeriod);
  if (control.dataset.workOpenDay) { setPeriod("day", { quiet: true }); return pickDate(control.dataset.workOpenDay); }
  if (control.dataset.workDay) return pickDate(control.dataset.workDay);
  if (control.dataset.workFilter) { work.filter = control.dataset.workFilter; return render(); }
  if (control.dataset.workOpen) return void openDialog(control.dataset.workOpen);
  if (control.dataset.workUser) { work.user = control.dataset.workUser; work.open = ""; work.dialog = null; return void load(); }
  const today = work.data?.today;
  const action = control.dataset.work;
  // Тиждень гортається на 7 днів, день — на один.
  const step = work.period === "week" ? 7 : 1;
  if (action === "prev") pickDate(shiftDay(work.date || today, -step));
  if (action === "next") {
    const next = shiftDay(work.date, step);
    const open = step === 7 ? work.report?.to < today : next <= today;
    if (open) pickDate(next > today ? today : next);
  }
  if (action === "today") pickDate(today);
  if (action === "yesterday") pickDate(shiftDay(today, -step));
  if (action === "reload") void load();
});

document.addEventListener("change", (event) => {
  const root = rootEl();
  if (!root || !root.contains(event.target)) return;
  if (event.target.dataset.work === "date") pickDate(event.target.value);
  if (event.target.dataset.work === "user") { work.user = event.target.value; work.open = ""; work.dialog = null; void load(); }
});
