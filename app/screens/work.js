// «По днях» (власник 12.10): за день — кому я написав, і підсвічено тих, хто
// відповів після цього; клік — уся історія діалогу (LinkedIn і пошта) та хто з
// нас що робив. Хто писав — це логін платформи, під яким зайшли. Над списком —
// цифри дня по кожному працівнику: адміністратор бачить будь-кого або всіх.
//
// Сервер: /api/work/day і /api/work/contact (triage/work-log.mjs); сама розмова
// — з /api/warmup/history і /api/esp/contacts/timeline, як у картках лідів.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

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

const work = { date: "", user: "", data: null, loading: false, error: "", filter: "all", open: "", dialog: null, timer: null };

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
    if (!work.date || work.date === work.data?.today) void load({ quiet: true });
  }, 60000);
}

async function load({ quiet = false } = {}) {
  if (!quiet) { work.loading = true; render(); }
  try {
    const query = new URLSearchParams();
    if (work.date) query.set("date", work.date);
    if (work.user) query.set("user", work.user);
    const data = await api(`/api/work/day?${query}`);
    work.data = data;
    work.date = data.date;
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
      <option value="${escapeAttr(data.viewer)}" ${work.user === data.viewer ? "selected" : ""}>Моя</option>
      <option value="all" ${work.user === "all" ? "selected" : ""}>Уся команда</option>
      ${(data.users || []).filter((row) => row.user !== data.viewer).map((row) => `<option value="${escapeAttr(row.user)}" ${work.user === row.user ? "selected" : ""}>${escapeHtml(row.name || row.user)}</option>`).join("")}
    </select></label>` : "";
  return `<div class="work-toolbar">
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

function statsHtml(total) {
  const cards = [
    ["users", "Написали людям", total.contacts, ""],
    ["message-circle-reply", "Відповіли", total.answered, total.fresh ? `${total.fresh} нових` : ""],
    ["message-square", "LinkedIn-повідомлень", total.wroteLinkedin, ""],
    ["mail", "Листів", total.wroteEmail, ""],
    ["user-plus", "Запитів у друзі", total.invited, ""],
    ["reply", "Відповідей у розмовах", total.replied, ""],
    ["eye", "Переглянуто карток", total.viewed, ""],
    ["sparkles", "Збагачено", total.enriched, ""],
    ["file-pen", "Тексти згенеровано", total.drafted, ""],
    ["ban", "Не валідні", total.invalid, ""],
    ["skip-forward", "Пропущено", total.skipped, ""]
  ];
  return `<div class="work-stats">${cards.map(([icon, label, value, note]) => `<div class="work-stat ${icon === "message-circle-reply" && total.fresh ? "is-fresh" : ""}">
    <i data-lucide="${icon}"></i><b>${value || 0}</b><span>${label}</span>${note ? `<em>${escapeHtml(note)}</em>` : ""}</div>`).join("")}</div>`;
}

function teamHtml(data) {
  if (!data.admin || data.user !== "all" || !data.byUser?.length) return "";
  const rate = (counts) => (counts.contacts ? `${Math.round((counts.answered / counts.contacts) * 100)}%` : "—");
  return `<div class="work-team"><table>
    <thead><tr><th>Хто</th><th title="Унікальних людей, яким написали або надіслали запит">Людей</th><th>Відповіли</th><th>% відповідей</th><th>LinkedIn</th><th>Листів</th><th>Запитів</th><th>Відп. у розмовах</th><th>Переглянуто</th><th>Збагачено</th><th>Не валідні</th><th>Пропущено</th></tr></thead>
    <tbody>${data.byUser.map((row) => `<tr data-work-user="${escapeAttr(row.user)}">
      <td><b>${escapeHtml(row.name || row.user)}</b>${row.name ? `<small>${escapeHtml(row.user)}</small>` : ""}</td>
      <td>${row.counts.contacts}</td><td>${row.counts.answered}</td><td>${rate(row.counts)}</td><td>${row.counts.wroteLinkedin}</td><td>${row.counts.wroteEmail}</td>
      <td>${row.counts.invited}</td><td>${row.counts.replied}</td><td>${row.counts.viewed}</td><td>${row.counts.enriched}</td><td>${row.counts.invalid}</td><td>${row.counts.skipped}</td>
    </tr>`).join("")}</tbody></table></div>`;
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

// Заплановані (власник 14.10): кому ми написали в LinkedIn і хто мовчить — завтра
// написати знову; що не встигли — лишається на наступний день, старіші вгорі.
function plannedHtml(data) {
  const planned = data.planned;
  if (!planned) return "";
  const days = (count) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? "день" : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? "дні" : "днів"}`;
  const rows = planned.items.map((item) => `<li class="work-plan-row ${item.carriedDays ? "is-carried" : ""}">
      <div class="work-plan-who">
        <b>${escapeHtml(item.name)}</b>
        ${item.headline ? `<small>${escapeHtml(item.headline)}</small>` : ""}
        <span class="work-plan-last">Ми написали ${escapeHtml(when(item.lastAt))}${item.accountName ? ` · ${escapeHtml(item.accountName)}` : ""}${item.lastText ? `: «${escapeHtml(item.lastText)}»` : ""}</span>
      </div>
      <div class="work-plan-tags">
        ${item.carriedDays ? `<span class="work-status is-bad">перенесено · чекає ${escapeHtml(days(item.carriedDays))}</span>` : '<span class="work-status is-silent">на сьогодні</span>'}
        <span class="work-plan-count">${item.sentInRow} з ${planned.limit} без відповіді</span>
      </div>
      <button type="button" class="primary-button" data-work-write="${escapeAttr(item.accountId)}" data-work-thread="${escapeAttr(item.threadKey)}"><i data-lucide="message-square"></i><span>Написати</span></button>
    </li>`).join("");
  return `<section class="work-plan">
    <header><h3>Заплановані на сьогодні <b>${planned.total}</b></h3>
      <p>Кому ми написали в LinkedIn, а людина мовчить: наступного дня — написати знову. Хто не дочекався — переходить на наступний день. Після ${planned.limit} повідомлень поспіль без відповіді людина зі списку зникає.</p></header>
    ${planned.error ? `<p class="esp-notice is-bad">${escapeHtml(planned.error)}</p>` : ""}
    ${planned.items.length ? `<ol class="work-plan-list">${rows}</ol>${planned.total > planned.items.length ? `<p class="work-muted">Показано ${planned.items.length} з ${planned.total}.</p>` : ""}` : planned.error ? "" : '<p class="work-muted">На сьогодні нікому не треба писати повторно.</p>'}
  </section>`;
}

function listHtml(data) {
  const contacts = data.contacts || [];
  const count = { all: contacts.length, fresh: contacts.filter((item) => item.fresh).length, answered: contacts.filter((item) => item.answer).length, silent: contacts.filter((item) => !item.answer).length };
  const list = shown(contacts);
  return `<div class="work-list">
    <div class="work-filters">${FILTERS.map(([key, label]) => `<button type="button" class="${work.filter === key ? "is-on" : ""} ${key === "fresh" && count.fresh ? "has-fresh" : ""}" data-work-filter="${key}">${label} <b>${count[key]}</b></button>`).join("")}</div>
    ${list.length ? list.map((item) => rowHtml(item, data)).join("") : `<p class="work-empty">${contacts.length ? "Тут нікого." : `${escapeHtml(dayWord(work.date))} нікому не писали${data.user === "all" ? "" : " з цього логіна"}.`}</p>`}
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
    body = `${daysHtml(data)}
      <h2 class="work-title">${escapeHtml(dayWord(data.date))}${data.user === "all" ? " · уся команда" : data.user !== data.viewer ? ` · ${escapeHtml((data.users || []).find((row) => row.user === data.user)?.name || data.user)}` : ""}</h2>
      ${statsHtml(data.total)}
      ${teamHtml(data)}
      ${plannedHtml(data)}
      <div class="work-body">${listHtml(data)}${dialogHtml()}</div>`;
  }
  root.innerHTML = `${toolbarHtml(data)}${body}`;
  refreshIcons(root);
}

function pickDate(date) {
  if (!date || date === work.date) return;
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
  const control = event.target.closest("[data-work], [data-work-day], [data-work-filter], [data-work-open], [data-work-user]");
  if (!control) return;
  if (control.dataset.workDay) return pickDate(control.dataset.workDay);
  if (control.dataset.workFilter) { work.filter = control.dataset.workFilter; return render(); }
  if (control.dataset.workOpen) return void openDialog(control.dataset.workOpen);
  if (control.dataset.workUser) { work.user = control.dataset.workUser; work.open = ""; work.dialog = null; return void load(); }
  const today = work.data?.today;
  const action = control.dataset.work;
  if (action === "prev") pickDate(shiftDay(work.date || today, -1));
  if (action === "next" && work.date < today) pickDate(shiftDay(work.date, 1));
  if (action === "today") pickDate(today);
  if (action === "yesterday") pickDate(shiftDay(today, -1));
  if (action === "reload") void load();
});

document.addEventListener("change", (event) => {
  const root = rootEl();
  if (!root || !root.contains(event.target)) return;
  if (event.target.dataset.work === "date") pickDate(event.target.value);
  if (event.target.dataset.work === "user") { work.user = event.target.value; work.open = ""; work.dialog = null; void load(); }
});
