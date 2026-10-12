// Ліди (ESP-UI 5, як екрани Snov 07 і 01). Зліва — списки лідів із лічильниками,
// «Усі ліди», виключення й запит про дані. Праворуч — таблиця списку: хто,
// адреса з крапкою верифікації, країна, джерело, у яких кампаніях. Звідси людей
// додають вставкою з таблиці й відправляють у кампанію — через ті самі перевірки
// перед листом (ESP 6). Клік по імені відкриває картку: деталі зліва, хронологія
// всього, що було з людиною, і нотатки — справа. Відкриттів і кліків немає.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";
import { showPrivacyFor } from "../screens/esp-privacy.js";

const EXCLUSIONS = "exclusions";
const PRIVACY = "privacy";
const TONE_WORD = { valid: "перевірена", risky: "ризикова", invalid: "недійсна", unknown: "невідомо", none: "не перевірялась" };
const ENROLL_WORD = { active: "у ланцюжку", paused: "на паузі", stopped: "зупинено", done: "завершено", uncertain: "невідомо" };
const ENROLL_TONE = { active: "tone-live", paused: "tone-warn", stopped: "tone-muted", done: "tone-done", uncertain: "tone-warn" };
const LABEL_WORD = { positive: "позитивна", negative: "негативна", referral: "переадресація", neutral: "нейтральна" };
// Why a person did not go into the campaign, when it is the campaign's own rule (ESP 5).
const CAMPAIGN_SKIP = {
  already_in_campaign: () => "уже в цій кампанії",
  in_other_campaign: (row) => `уже в іншій кампанії${row.campaign ? ` «${row.campaign}»` : ""} — одна людина пише лише з однієї`
};
const LABEL_TONE = { positive: "tone-live", negative: "tone-warn", referral: "tone-done", neutral: "tone-muted" };

export const leadsState = {
  view: "",          // "" — усі ліди; id списку; EXCLUSIONS; PRIVACY
  meta: null,        // списки, лічильники, кампанії
  page: null,
  q: "",
  offset: 0,
  selected: new Set(),
  adding: false,
  addText: "",
  creating: false,
  renaming: false,
  notice: "",
  error: "",
  busy: false,
  card: null,        // { email, data, events, tab }
  noteText: ""
};

onScreen("leads", { open: () => void openLeads() });

async function openLeads() {
  if (!document.getElementById("leadsPage")) return;
  renderLeads();
  await loadMeta();
  if (!leadsState.card && leadsState.view !== EXCLUSIONS && leadsState.view !== PRIVACY) await loadPage();
}

async function loadMeta() {
  try {
    leadsState.meta = await api("/api/esp/leads/lists");
    if (leadsState.view && ![EXCLUSIONS, PRIVACY].includes(leadsState.view) && !leadsState.meta.lists.some((row) => row.id === leadsState.view)) leadsState.view = "";
    leadsState.error = "";
  } catch (error) {
    leadsState.error = error?.status === 403 ? "Лідів бачить команда з правом читати відповіді — його дає адміністратор." : error?.message || "Списки не прочиталися.";
  }
  renderLeads();
}

async function loadPage() {
  const params = new URLSearchParams({ offset: String(leadsState.offset) });
  if (leadsState.view) params.set("list", leadsState.view);
  if (leadsState.q) params.set("q", leadsState.q);
  try {
    leadsState.page = await api(`/api/esp/leads?${params}`);
    leadsState.offset = leadsState.page.offset;
  } catch (error) {
    leadsState.notice = error?.message || "Список не прочитався.";
  }
  renderLeads();
}

async function openCard(email) {
  leadsState.card = { email, data: null, events: null, tab: "all" };
  leadsState.notice = "";
  renderLeads();
  try {
    const [data, timeline] = await Promise.all([
      api(`/api/esp/leads/card?email=${encodeURIComponent(email)}`),
      api(`/api/esp/contacts/timeline?email=${encodeURIComponent(email)}`).catch(() => ({ events: [] }))
    ]);
    Object.assign(leadsState.card, { data, events: timeline.events || [], anonymized: timeline.anonymized });
  } catch (error) {
    leadsState.card = null;
    leadsState.notice = error?.message || "Картка не відкрилась.";
  }
  renderLeads();
}

// ── малювання ─────────────────────────────────────────────────────────────

const when = (value, options = { dateStyle: "medium", timeStyle: "short" }) => (value ? new Date(value).toLocaleString("uk-UA", options) : "");
const day = (value) => when(value, { day: "numeric", month: "short", year: "numeric" });

function sideHtml() {
  const meta = leadsState.meta;
  const item = (view, icon, text, count) => {
    const active = !leadsState.card && leadsState.view === view;
    return `<button type="button" class="${active ? "is-active" : ""}" data-leads-view="${escapeAttr(view)}"${active ? ' aria-current="page"' : ""}><i data-lucide="${icon}"></i><span>${escapeHtml(text)}</span>${count != null ? `<b>${count}</b>` : ""}</button>`;
  };
  const lists = (meta?.lists || []).map((list) => item(list.id, "folder", list.name, list.count)).join("");
  return `
    <div class="mail-side-head">
      <span class="mail-side-title">Списки</span>
      <button type="button" class="icon-button" data-leads-create aria-label="Новий список" title="Новий список"><i data-lucide="folder-plus"></i></button>
    </div>
    ${leadsState.creating ? `<form class="leads-new-list" id="leadsNewList"><input name="name" placeholder="Назва списку" maxlength="80" required autofocus /><button type="submit" class="primary-button">Створити</button></form>` : ""}
    ${lists || (meta ? '<p class="leads-side-empty">Списків ще немає — створіть перший.</p>' : "")}
    <div class="mail-side-sep"></div>
    ${item("", "users", "Усі ліди", meta?.total ?? null)}
    ${item(EXCLUSIONS, "ban", "Виключення", meta?.excluded ?? null)}
    ${item(PRIVACY, "shield-check", "Запит про дані", null)}`;
}

function chipsHtml(counts) {
  if (!counts) return "";
  return `<div class="leads-chips" aria-label="Верифікація адрес">${["valid", "risky", "invalid", "unknown", "none"].filter((tone) => counts[tone]).map((tone) => `<span class="leads-chip" title="${TONE_WORD[tone]}"><i class="leads-dot is-${tone}"></i>${counts[tone]}</span>`).join("")}</div>`;
}

function listHtml() {
  const meta = leadsState.meta;
  if (leadsState.error && !meta) return `<div class="empty-state">${escapeHtml(leadsState.error)}</div>`;
  const list = meta?.lists.find((row) => row.id === leadsState.view) || null;
  const page = leadsState.page;
  const rows = page?.rows || [];
  const picked = rows.filter((row) => leadsState.selected.has(row.id));
  const allChecked = rows.length > 0 && rows.every((row) => leadsState.selected.has(row.id));
  const title = list ? list.name : "Усі ліди";
  const campaigns = meta?.campaigns || [];
  const head = `
    <div class="leads-head">
      ${leadsState.renaming && list
        ? `<form class="leads-rename" id="leadsRename"><input name="name" value="${escapeAttr(list.name)}" maxlength="80" required autofocus /><button type="submit" class="primary-button">Зберегти</button><button type="button" class="text-button" data-leads-rename-cancel>Скасувати</button></form>`
        : `<h2>${escapeHtml(title)}</h2>${list ? `<button type="button" class="icon-button" data-leads-rename aria-label="Перейменувати" title="Перейменувати"><i data-lucide="pencil"></i></button><button type="button" class="icon-button" data-leads-delete aria-label="Видалити список" title="Видалити список"><i data-lucide="trash-2"></i></button>` : ""}`}
    </div>`;
  const toolbar = `
    <div class="leads-toolbar">
      <button type="button" class="primary-button" data-leads-add${list ? "" : ' disabled title="Спершу виберіть або створіть список"'}><i data-lucide="user-plus"></i><span>Додати лідів</span></button>
      <form class="leads-send" id="leadsSend">
        <select name="campaignId" aria-label="Кампанія"${picked.length && campaigns.length ? "" : " disabled"}>${campaigns.length ? campaigns.map((row) => `<option value="${escapeAttr(row.id)}">${escapeHtml(row.name)}</option>`).join("") : "<option>Кампаній немає</option>"}</select>
        <button type="submit" class="text-button"${picked.length && campaigns.length ? "" : " disabled"}><i data-lucide="send"></i><span>Надіслати в кампанію${picked.length ? ` (${picked.length})` : ""}</span></button>
      </form>
      ${list ? `<button type="button" class="text-button" data-leads-remove${picked.length ? "" : " disabled"}><i data-lucide="user-minus"></i><span>Прибрати зі списку</span></button>` : ""}
      ${chipsHtml(page?.verification)}
    </div>`;
  const adding = leadsState.adding && list ? `
    <form class="leads-add" id="leadsAdd">
      <label for="leadsAddText">Вставте рядки з таблиці — перший рядок може бути заголовком: <code>email, name, company, position, country, source, source_date, verification, verified_at</code></label>
      <textarea id="leadsAddText" name="text" rows="6" placeholder="email,name,company,country,source,source_date,verification,verified_at&#10;olena@northwind.co.uk,Olena Kovalenko,Northwind,UK,Apollo,2026-10-01,valid,2026-10-05">${escapeHtml(leadsState.addText)}</textarea>
      <div class="leads-add-bar"><button type="submit" class="primary-button"${leadsState.busy ? " disabled" : ""}><i data-lucide="plus"></i><span>${leadsState.busy ? "Додаю..." : `Додати в «${escapeHtml(list.name)}»`}</span></button><button type="button" class="text-button" data-leads-add-cancel>Скасувати</button></div>
    </form>` : "";
  const notice = leadsState.notice ? `<p class="esp-notice ${leadsState.error ? "is-bad" : ""}">${escapeHtml(leadsState.notice)}</p>` : "";
  const from = page?.total ? page.offset + 1 : 0;
  const to = (page?.offset || 0) + rows.length;
  const bar = `
    <div class="mail-list-bar">
      <input type="checkbox" id="leadsAll" aria-label="Вибрати всіх на сторінці"${allChecked ? " checked" : ""}${rows.length ? "" : " disabled"} />
      <label class="mail-search leads-search"><i data-lucide="search"></i><input type="search" id="leadsSearch" placeholder="Ім'я, адреса, компанія, країна, джерело" value="${escapeAttr(leadsState.q)}" autocomplete="off" /></label>
      <div class="mail-pager">
        <span>${from}–${to} з ${page?.total ?? 0}</span>
        <button type="button" class="icon-button" data-leads-page="-1" aria-label="Попередня сторінка"${page?.offset > 0 ? "" : " disabled"}><i data-lucide="chevron-left"></i></button>
        <button type="button" class="icon-button" data-leads-page="1" aria-label="Наступна сторінка"${page && to < page.total ? "" : " disabled"}><i data-lucide="chevron-right"></i></button>
      </div>
    </div>`;
  const empty = !page ? '<div class="empty-state">Читаємо список...</div>'
    : !rows.length ? `<div class="empty-state">${leadsState.q ? "Нікого не знайдено." : list ? "У списку нікого немає — «Додати лідів»." : meta?.lists.length ? "Лідів ще немає." : "Створіть список і додайте в нього лідів."}</div>` : "";
  const table = rows.length ? `
    <div class="table-wrap"><table class="leads-table">
      <thead><tr><th></th><th>Лід (${page.total})</th><th>Адреса</th><th>Країна</th><th>Джерело</th><th>Кампанії</th><th>Додано</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr class="${leadsState.selected.has(row.id) ? "is-picked" : ""}">
          <td><input type="checkbox" data-leads-pick="${escapeAttr(row.id)}" aria-label="Вибрати ${escapeAttr(row.name || row.email)}"${leadsState.selected.has(row.id) ? " checked" : ""} /></td>
          <td class="leads-who"><button type="button" class="leads-name" data-leads-open="${escapeAttr(row.email)}">${escapeHtml(row.name || row.email.split("@")[0])}</button><small>${escapeHtml([row.company, row.position].filter(Boolean).join(" · "))}</small></td>
          <td class="leads-email"><i class="leads-dot is-${row.tone}" title="${escapeAttr(TONE_WORD[row.tone])}${row.verifiedAt ? `, ${escapeAttr(row.verifiedAt)}` : ""}"></i>${escapeHtml(row.email)}${row.excluded ? ` <span class="pill tone-warn" title="${escapeAttr(row.excluded.note || "")}">виключено</span>` : ""}</td>
          <td>${escapeHtml(row.country || "—")}</td>
          <td>${escapeHtml(row.source || "—")}${row.sourceDate ? `<small>${escapeHtml(row.sourceDate)}</small>` : ""}</td>
          <td>${row.campaigns.length ? `<div class="leads-campaigns">${row.campaigns.map((item) => `<span class="pill ${ENROLL_TONE[item.status] || "tone-muted"}" title="${escapeAttr(item.name)}: ${escapeAttr(ENROLL_WORD[item.status] || item.status)}">${escapeHtml(item.name)}</span>`).join("")}</div>` : "—"}</td>
          <td class="leads-date">${escapeHtml(day(row.addedAt))}</td>
        </tr>`).join("")}</tbody>
    </table></div>` : "";
  return `${head}${toolbar}${adding}${notice}<div class="mail-main">${bar}${empty}${table}</div>`;
}

function timelineItem(event, card) {
  const data = event.data || {};
  const lead = card.data?.lead || {};
  const name = lead.name || card.email;
  const campaigns = new Map((card.data?.campaigns || []).map((row) => [row.id, row.name]));
  const campaign = data.campaignId ? campaigns.get(data.campaignId) || "" : "";
  const meta = (text) => `<div class="leads-event-meta">${escapeHtml(when(event.at))}${text ? ` · ${text}` : ""}</div>`;
  const body = (text) => (text ? `<details class="leads-event-body"${event.type === "message.replied" ? " open" : ""}><summary>${escapeHtml(String(text).split("\n")[0].slice(0, 120))}</summary><pre>${escapeHtml(text)}</pre></details>` : "");
  if (event.type === "message.sending") {
    return { kind: "email", icon: "mail", html: `<div class="leads-event-card">
      <p><strong>${escapeHtml(data.from || "")}</strong> надіслав лист: <strong>${escapeHtml(data.subject || "")}</strong></p>
      ${meta(`Від: ${escapeHtml(data.from || "")} → Кому: ${escapeHtml(card.email)}`)}
      ${data.redacted ? '<p class="esp-subtle">Текст прибрано: людину знеособлено за строком зберігання.</p>' : body(data.text)}
      ${campaign || data.step != null ? `<div class="leads-event-foot">${campaign ? `Кампанія: <b>${escapeHtml(campaign)}</b>` : ""}${data.step != null ? ` · лист ${Number(data.step) + 1}` : ""}${event.failed ? ' · <span class="pill tone-warn">не пішов</span>' : ""}</div>` : ""}
    </div>` };
  }
  if (event.type === "message.replied") {
    return { kind: "email", icon: "mail-check", html: `<div class="leads-event-card is-in">
      <p><strong>${escapeHtml(name)}</strong> відповів(ла)${data.subject ? `: <strong>${escapeHtml(data.subject)}</strong>` : ""} ${data.label ? `<span class="pill ${LABEL_TONE[data.label] || "tone-muted"}">${escapeHtml(LABEL_WORD[data.label] || data.label)}</span>` : ""}</p>
      ${meta(`Від: ${escapeHtml(card.email)} → Кому: ${escapeHtml(data.sender || "")}`)}
      ${data.redacted ? '<p class="esp-subtle">Текст прибрано: людину знеособлено за строком зберігання.</p>' : body(data.text)}
    </div>` };
  }
  if (event.type === "contact.note") {
    return { kind: "note", icon: "sticky-note", html: `<div class="leads-event-card is-note"><pre>${escapeHtml(data.text || "")}</pre>${meta(escapeHtml(event.actor || ""))}</div>` };
  }
  const line = {
    "message.autoreplied": `Автовідповідь${data.returnDate ? ` — повернеться ${escapeHtml(data.returnDate)}` : ""}: крок перенесено`,
    "message.bounced": `Лист не доставлено — код ${escapeHtml(data.code || "?")}`,
    "contact.unsubscribed": "Відписалась(вся) — більше не пишемо",
    "contact.skipped": `Лист не пішов: ${escapeHtml(data.label || data.reason || "перевірка перед відправкою")}`,
    "message.failed": `Помилка відправки: ${escapeHtml(String(data.error || "").slice(0, 160))}`
  }[event.type];
  if (!line) return null;
  return { kind: event.type === "message.bounced" || event.type === "message.autoreplied" ? "email" : "other", icon: event.type === "message.bounced" ? "mail-x" : "circle-dot", html: `<div class="leads-event-line"><p>${line}</p>${meta(escapeHtml(event.actor && event.actor !== "system" ? event.actor : ""))}</div>` };
}

function cardHtml() {
  const card = leadsState.card;
  if (!card.data) return '<div class="empty-state">Відкриваємо картку...</div>';
  const { lead, lists, campaigns, excluded, email } = card.data;
  const failed = new Set((card.events || []).filter((event) => event.type === "message.failed").map((event) => event.data?.sendingSeq));
  const items = (card.events || [])
    .filter((event) => event.type !== "message.sent")
    .map((event) => timelineItem(event.type === "message.sending" ? { ...event, failed: failed.has(event.seq) } : event, card))
    .filter(Boolean)
    .reverse();
  const counts = { all: items.length, email: items.filter((item) => item.kind === "email").length, note: items.filter((item) => item.kind === "note").length };
  const shown = card.tab === "all" ? items : items.filter((item) => item.kind === card.tab);
  const detail = (label, value) => `<div class="leads-detail"><span>${label}</span><b>${value || "—"}</b></div>`;
  return `
    <div class="mail-list-bar leads-card-bar">
      <button type="button" class="text-button" data-leads-back><i data-lucide="arrow-left"></i><span>До списку</span></button>
    </div>
    <div class="leads-card">
      <aside class="leads-card-side">
        <h2>${escapeHtml(lead.name || email)}</h2>
        <p class="leads-card-sub">${escapeHtml([lead.position, lead.company].filter(Boolean).join(" · "))}</p>
        ${excluded ? `<p class="mail-banner"><i data-lucide="ban"></i><span>У виключеннях назавжди: ${escapeHtml(excluded.category)}${excluded.note ? ` — ${escapeHtml(excluded.note)}` : ""}. Листів не буде.</span></p>` : ""}
        <div class="leads-details">
          ${detail("Email", `<i class="leads-dot is-${escapeAttr(lead.verification ? (lead.verification === "valid" ? "valid" : lead.verification === "invalid" ? "invalid" : "risky") : "none")}"></i>${escapeHtml(email)}`)}
          ${detail("Верифікація", escapeHtml([lead.verification, lead.verifiedAt].filter(Boolean).join(", ")))}
          ${detail("Компанія", escapeHtml(lead.company || ""))}
          ${detail("Посада", escapeHtml(lead.position || ""))}
          ${detail("Країна", escapeHtml(lead.country || ""))}
          ${detail("Часовий пояс", escapeHtml(lead.timezone || ""))}
          ${detail("Джерело", escapeHtml([lead.source, lead.sourceDate].filter(Boolean).join(", ")))}
          ${detail("Списки", lists.map((row) => `<span class="pill tone-muted">${escapeHtml(row.name)}</span>`).join(" "))}
        </div>
        <h3 class="leads-card-title">Кампанії</h3>
        ${campaigns.length ? campaigns.map((row) => `<div class="leads-detail"><span>${escapeHtml(row.name)}</span><b><span class="pill ${ENROLL_TONE[row.status] || "tone-muted"}">${escapeHtml(ENROLL_WORD[row.status] || row.status)}</span> лист ${Number(row.step || 0) + 1} · з ${escapeHtml(row.sender || "")}</b></div>`).join("") : '<p class="esp-subtle">Ще в жодній кампанії.</p>'}
        <button type="button" class="text-button" data-leads-privacy="${escapeAttr(email)}"><i data-lucide="shield-check"></i><span>Дані людини: файл або видалення</span></button>
      </aside>
      <section class="leads-card-main">
        <form class="leads-note" id="leadsNote">
          <textarea name="text" rows="2" placeholder="Нотатка про людину: дзвінок, домовленість, що врахувати">${escapeHtml(leadsState.noteText)}</textarea>
          <button type="submit" class="primary-button"><i data-lucide="sticky-note"></i><span>Додати нотатку</span></button>
        </form>
        <div class="leads-tabs" role="tablist">
          ${[["all", "Усе"], ["email", "Листи"], ["note", "Нотатки"]].map(([key, text]) => `<button type="button" role="tab" aria-selected="${card.tab === key}" data-leads-tab="${key}">${text} (${counts[key]})</button>`).join("")}
          <button type="button" class="icon-button" data-leads-reload aria-label="Оновити" title="Оновити"><i data-lucide="refresh-cw"></i></button>
        </div>
        ${leadsState.notice ? `<p class="esp-notice">${escapeHtml(leadsState.notice)}</p>` : ""}
        ${shown.length ? `<ol class="leads-timeline">${shown.map((item) => `<li class="is-${item.kind}"><span class="leads-timeline-icon"><i data-lucide="${item.icon}"></i></span>${item.html}</li>`).join("")}</ol>` : `<div class="empty-state">${card.tab === "note" ? "Нотаток ще немає." : "Листів цій людині ще не було."}</div>`}
      </section>
    </div>`;
}

export function renderLeads() {
  const side = document.getElementById("leadsSide");
  const main = document.getElementById("leadsMain");
  const exclusions = document.getElementById("leadsExclusions");
  const privacyPane = document.getElementById("leadsPrivacy");
  if (!side || !main || !exclusions || !privacyPane) return;
  const typing = document.activeElement?.id === "leadsSearch" ? document.activeElement.selectionStart : null;
  side.innerHTML = sideHtml();
  const pane = leadsState.card ? "card" : leadsState.view === EXCLUSIONS ? EXCLUSIONS : leadsState.view === PRIVACY ? PRIVACY : "list";
  exclusions.hidden = pane !== EXCLUSIONS;
  privacyPane.hidden = pane !== PRIVACY;
  main.hidden = pane === EXCLUSIONS || pane === PRIVACY;
  if (!main.hidden) main.innerHTML = pane === "card" ? cardHtml() : listHtml();
  if (typing !== null) {
    const search = document.getElementById("leadsSearch");
    search?.focus();
    search?.setSelectionRange(typing, typing);
  }
  refreshIcons(document.getElementById("leadsPage"));
}

// ── дії ───────────────────────────────────────────────────────────────────

async function act(work) {
  leadsState.busy = true;
  renderLeads();
  try {
    leadsState.notice = (await work()) || "";
    leadsState.error = "";
  } catch (error) {
    leadsState.error = error?.status === 403 ? "На це потрібне право «Запускати кампанії» — його дає адміністратор." : error?.message || "Не вдалося.";
    leadsState.notice = leadsState.error;
  } finally {
    leadsState.busy = false;
  }
  renderLeads();
}

function showView(view) {
  Object.assign(leadsState, { view, card: null, offset: 0, adding: false, renaming: false, notice: "", error: "" });
  leadsState.selected.clear();
  renderLeads();
  if (view !== EXCLUSIONS && view !== PRIVACY) void loadPage();
}

const root = () => document.getElementById("leadsPage");

root()?.addEventListener("click", async (event) => {
  const target = event.target;
  const view = target.closest("[data-leads-view]");
  if (view) return showView(view.dataset.leadsView);
  if (target.closest("[data-leads-create]")) { leadsState.creating = !leadsState.creating; return renderLeads(); }
  if (target.closest("[data-leads-add]")) { leadsState.adding = true; renderLeads(); document.getElementById("leadsAddText")?.focus(); return; }
  if (target.closest("[data-leads-add-cancel]")) { leadsState.adding = false; return renderLeads(); }
  if (target.closest("[data-leads-rename]")) { leadsState.renaming = true; return renderLeads(); }
  if (target.closest("[data-leads-rename-cancel]")) { leadsState.renaming = false; return renderLeads(); }
  if (target.closest("[data-leads-delete]")) {
    const list = leadsState.meta?.lists.find((row) => row.id === leadsState.view);
    if (!list || !window.confirm(`Видалити список «${list.name}» і ${list.count} людей у ньому? У кампаніях вони лишаться.`)) return;
    return act(async () => {
      const { removed } = await api("/api/esp/leads/lists/delete", { method: "POST", body: JSON.stringify({ id: list.id }) });
      leadsState.view = "";
      await loadMeta();
      await loadPage();
      return `Список «${list.name}» видалено разом із ${removed} людьми.`;
    });
  }
  if (target.closest("[data-leads-remove]")) {
    const ids = [...leadsState.selected];
    return act(async () => {
      const { removed } = await api("/api/esp/leads/remove", { method: "POST", body: JSON.stringify({ ids }) });
      leadsState.selected.clear();
      await loadMeta();
      await loadPage();
      return `Прибрано зі списку: ${removed}.`;
    });
  }
  const page = target.closest("[data-leads-page]")?.dataset.leadsPage;
  if (page) {
    leadsState.offset = Math.max(0, leadsState.offset + Number(page) * (leadsState.page?.limit || 50));
    leadsState.selected.clear();
    return loadPage();
  }
  const open = target.closest("[data-leads-open]")?.dataset.leadsOpen;
  if (open) return openCard(open);
  if (target.closest("[data-leads-back]")) { leadsState.card = null; leadsState.notice = ""; renderLeads(); return loadPage(); }
  const tab = target.closest("[data-leads-tab]")?.dataset.leadsTab;
  if (tab && leadsState.card) { leadsState.card.tab = tab; return renderLeads(); }
  if (target.closest("[data-leads-reload]") && leadsState.card) return openCard(leadsState.card.email);
  const privacy = target.closest("[data-leads-privacy]")?.dataset.leadsPrivacy;
  if (privacy) {
    showView(PRIVACY);
    return showPrivacyFor(privacy);
  }
});

root()?.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "leadsAll") {
    for (const row of leadsState.page?.rows || []) target.checked ? leadsState.selected.add(row.id) : leadsState.selected.delete(row.id);
    return renderLeads();
  }
  const pick = target.dataset?.leadsPick;
  if (pick) {
    target.checked ? leadsState.selected.add(pick) : leadsState.selected.delete(pick);
    renderLeads();
  }
});

let searchTimer = null;
root()?.addEventListener("input", (event) => {
  if (event.target.id === "leadsAddText") { leadsState.addText = event.target.value; return; }
  if (event.target.name === "text" && event.target.closest("#leadsNote")) { leadsState.noteText = event.target.value; return; }
  if (event.target.id !== "leadsSearch") return;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    leadsState.q = event.target.value.trim();
    leadsState.offset = 0;
    void loadPage();
  }, 300);
});

root()?.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!["leadsNewList", "leadsRename", "leadsAdd", "leadsSend", "leadsNote"].includes(form.id)) return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  if (form.id === "leadsNewList") {
    return act(async () => {
      const { list } = await api("/api/esp/leads/lists", { method: "POST", body: JSON.stringify({ name: values.name }) });
      leadsState.creating = false;
      Object.assign(leadsState, { view: list.id, offset: 0, adding: true });
      await loadMeta();
      await loadPage();
      return `Список «${list.name}» створено — додайте в нього лідів.`;
    });
  }
  if (form.id === "leadsRename") {
    return act(async () => {
      await api("/api/esp/leads/lists/rename", { method: "POST", body: JSON.stringify({ id: leadsState.view, name: values.name }) });
      leadsState.renaming = false;
      await loadMeta();
      return "";
    });
  }
  if (form.id === "leadsAdd") {
    return act(async () => {
      const result = await api("/api/esp/leads/add", { method: "POST", body: JSON.stringify({ listId: leadsState.view, text: values.text }) });
      Object.assign(leadsState, { adding: false, addText: "" });
      await loadMeta();
      await loadPage();
      return `Додано: ${result.added}${result.updated ? `, доповнено: ${result.updated}` : ""}${result.rejected.length ? `; рядків без адреси: ${result.rejected.length} (рядки ${result.rejected.map((row) => row.line).join(", ")})` : ""}.`;
    });
  }
  if (form.id === "leadsSend") {
    const ids = [...leadsState.selected];
    const name = leadsState.meta?.campaigns.find((row) => row.id === values.campaignId)?.name || "";
    return act(async () => {
      const result = await api("/api/esp/leads/to-campaign", { method: "POST", body: JSON.stringify({ ids, campaignId: values.campaignId }) });
      leadsState.selected.clear();
      await loadPage();
      const skipped = result.skipped.map((row) => `${row.email} — ${CAMPAIGN_SKIP[row.reason] ? CAMPAIGN_SKIP[row.reason](row) : result.labels[row.email] || row.reason}`);
      return `У «${name}» додано: ${result.added}.${skipped.length ? ` Не додано: ${skipped.join("; ")}.` : ""}${result.waiting.length ? ` Чекають даних (не підуть, доки їх не доповнять): ${result.waiting.map((row) => `${row.email} — ${row.label}`).join("; ")}.` : ""}`;
    });
  }
  if (form.id === "leadsNote") {
    const email = leadsState.card?.email;
    if (!email || !String(values.text || "").trim()) return;
    try {
      await api("/api/esp/leads/note", { method: "POST", body: JSON.stringify({ email, text: values.text }) });
    } catch (error) {
      leadsState.notice = error?.status === 403 ? "Нотатки пише той, хто має право відповідати на листи." : error?.message || "Нотатка не збереглась.";
      return renderLeads();
    }
    leadsState.noteText = "";
    await openCard(email);
    if (leadsState.card) leadsState.card.tab = "note";
    return renderLeads();
  }
});
