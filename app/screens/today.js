// «Сьогодні» — Головна лідгена (етап 1/6 плану кампаній і пінгів, 16.10.2026).
//
// Кожен живий діалог має пінг — задачу CRM з датою наступного дотику. Тут вони в
// тому порядку, в якому їх робити: відповіді → прострочені → на сьогодні →
// перші повідомлення. Нові контакти з папки (home-triage.js) — лише коли
// відповідей і прострочених немає.
//
// Робоче місце — один лід за раз: хто це, уся переписка, чернетка, «Погодити й
// надіслати» → наступний. Пінг можна перенести (+1 день, +3, тиждень, дата) чи
// зробити дзвінком. Надсилає не ця сторінка: повідомлення стає в чергу акаунта
// тими самими маршрутами, що й «Вхідні» та Головна, а сервер звіряє пінги —
// закриває цей і ставить наступний (через 3 робочі дні).

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";
import { openTriage } from "./home-triage.js";
import { warmupGoesOutText } from "./inbox.js";

onScreen("home", { open: () => void openToday() });

const SCOPE_KEY = "outbound.today.scope";
const BLOCKS = [
  ["replies", "Відповіді", "Лід написав — відповісти"],
  ["overdue", "Прострочені", "Дата пінгу минула"],
  ["today", "На сьогодні", "Пінги на сьогодні"],
  ["first", "Перші повідомлення", "Прийняли запит — написати першими"]
];
const DRAFT_LABEL = { reply: "Чернетка відповіді", "follow-up": "Нагадування", first: "Перше повідомлення" };

const today = {
  data: null, error: "", loading: false,
  scope: readScope(),
  // Чіп блоку в шапці (аудит 16.10): показати лише «Прострочені», «На сьогодні»… — порожньо = усі.
  blockFilter: "", statusSaving: false,
  selected: "", detail: null, detailError: "", detailLoading: false,
  draftLoading: false, draftNote: "", sending: false, notice: "", tone: "", text: "", textFor: "",
  // Етап 2/6: відкриті діалоги з 01.08 (адмін).
  imports: null, importOpen: false, importError: "", importPick: new Set(), importEdits: new Map(), importAssignee: "", importBusy: false, importTimer: null
};

function readScope() {
  try { return window.localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "mine"; } catch { return "mine"; }
}

const root = () => document.getElementById("todayRoot");
const triageRoot = () => document.getElementById("triageRoot");

function dayLabel(day, todayDay) {
  if (!day) return "";
  if (day === todayDay) return "сьогодні";
  const [y, m, d] = day.split("-");
  return day < todayDay ? `з ${d}.${m}` : `${d}.${m}.${y.slice(2)}`;
}

function allItems() {
  const blocks = today.data?.blocks || {};
  return BLOCKS.flatMap(([key]) => blocks[key] || []);
}

async function openToday({ keepSelection = false } = {}) {
  today.loading = true;
  render();
  try {
    today.data = await api(`/api/today?scope=${today.scope}`);
    today.error = "";
  } catch (error) {
    if (error?.name === "AbortError") return;
    today.error = error.message || "Не вдалося завантажити пінги.";
  } finally {
    today.loading = false;
  }
  const items = allItems();
  if (!keepSelection || !items.some((item) => item.pingId === today.selected)) today.selected = items[0]?.pingId || "";
  render();
  if (today.selected) void loadDetail(today.selected);
  else today.detail = null;
  // Нові контакти — лише коли живі діалоги розібрано (або пінги ще не налаштовані).
  const allowed = !today.data || today.data.newContactsAllowed !== false;
  triageRoot().hidden = !allowed;
  if (allowed) void openTriage();
}

async function loadDetail(pingId) {
  today.detailLoading = true;
  today.detailError = "";
  render();
  try {
    const detail = await api(`/api/today/item?pingId=${encodeURIComponent(pingId)}`);
    if (today.selected !== pingId) return;
    today.detail = detail;
    if (today.textFor !== pingId) {
      today.text = detail.draft?.text || "";
      today.textFor = pingId;
    }
    // Відповідь, яку відкрили тут, прочитана — як у «Вхідних».
    const item = detail.item;
    if (item.channel === "thread" && item.block === "replies") {
      void api("/api/warmup/inbox/read", { method: "POST", body: JSON.stringify({ accountId: item.accountId, threadKey: item.threadKey }) }).catch(() => {});
    }
    if (!today.text && (item.channel === "thread" || item.channel === "first")) void writeDraft(false);
  } catch (error) {
    if (error?.name === "AbortError") return;
    today.detailError = error.message || "Не вдалося відкрити пінг.";
  } finally {
    today.detailLoading = false;
    render();
  }
}

async function writeDraft(force) {
  const item = today.detail?.item;
  if (!item) return;
  today.draftLoading = true;
  render();
  try {
    let text = "";
    if (item.channel === "first") {
      const payload = await api("/api/warmup/first-messages/draft", { method: "POST", body: JSON.stringify({ outreachId: item.outreachId, force }) });
      text = payload.draft?.text || "";
    } else {
      const payload = await api("/api/today/draft", { method: "POST", body: JSON.stringify({ pingId: item.pingId, force }) });
      text = payload.draft?.text || "";
    }
    if (today.selected === item.pingId && (force || !today.text)) {
      today.text = text;
      // Біля поля, а не в загальному рядку: там може стояти «погоджено, піде…» про попереднього ліда.
      today.draftNote = text ? "" : "Модель зараз не написала чернетку — напишіть самі.";
    }
  } catch (error) {
    if (error?.name !== "AbortError") today.draftNote = error.message || "Чернетка не вийшла — напишіть самі.";
  } finally {
    today.draftLoading = false;
    render();
  }
}

function say(text, tone = "is-ok") {
  today.notice = text;
  today.tone = tone;
}

async function send() {
  const item = today.detail?.item;
  const text = today.text.trim();
  if (!item || !text || today.sending) return;
  today.sending = true;
  say("");
  render();
  try {
    let reply;
    if (item.channel === "first") {
      reply = await api("/api/warmup/first-messages/send", { method: "POST", body: JSON.stringify({ outreachId: item.outreachId, text }) });
    } else {
      const followUp = today.detail.messages.at(-1)?.direction !== "in";
      reply = await api("/api/warmup/inbox/reply", { method: "POST", body: JSON.stringify({ accountId: item.accountId, threadKey: item.threadKey, text, followUp }) });
    }
    // Пінг закривається, наступний ставиться — звірка на сервері.
    await api("/api/today/refresh", { method: "POST", body: "{}" }).catch(() => {});
    const goes = warmupGoesOutText(reply);
    const name = item.name;
    today.text = "";
    today.textFor = "";
    today.draftNote = "";
    await openToday();
    say(`${name}: погоджено, піде ${goes}. Наступний пінг — через 3 робочі дні.`);
    render();
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося поставити в чергу.", "is-error");
    render();
  } finally {
    today.sending = false;
    render();
  }
}

async function movePing(when, call = false) {
  const item = today.detail?.item;
  if (!item) return;
  try {
    const result = await api("/api/today/ping", { method: "POST", body: JSON.stringify({ pingId: item.pingId, when, call }) });
    const name = item.name;
    await openToday({ keepSelection: true });
    say(`${name}: ${call ? "дзвінок" : "пінг"} на ${dayLabel(result.dueDay, today.data?.today)}.`);
    render();
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося перенести.", "is-error");
    render();
  }
}

/* ── відкриті діалоги з 01.08 (етап 2/6) ───────────────────────────────── */

const STEP = { reply: "Відповісти", silent: "Нагадати", call: "Дзвінок" };
const PRIORITY_LABEL = { high: "високий", normal: "звичайний", low: "низький" };

async function loadImports() {
  try {
    today.imports = await api("/api/today/open-dialogs");
    today.importError = "";
    if (!today.importAssignee) today.importAssignee = today.imports.defaultAssignee || "";
    // Нові кандидати вибрані одразу; зняте людиною лишається знятим.
    for (const item of today.imports.items) if (!today.importEdits.has(item.contactId) && !today.importPick.has(`x:${item.contactId}`)) today.importPick.add(item.contactId);
  } catch (error) {
    if (error?.name !== "AbortError") today.importError = error.message || "Не вдалося прочитати відкриті діалоги.";
  }
  clearTimeout(today.importTimer);
  if (today.importOpen && today.imports?.job?.running) today.importTimer = setTimeout(() => void loadImports(), 3000);
  render();
}

function importValue(item, field) {
  return today.importEdits.get(item.contactId)?.[field] ?? item[field];
}

function importHtml() {
  const data = today.imports;
  if (today.importError) return `<p class="today-empty is-error">${escapeHtml(today.importError)}</p>`;
  if (!data) return `<p class="today-empty">Збираю відкриті діалоги з CRM…</p>`;
  const picked = data.items.filter((item) => today.importPick.has(item.contactId));
  const job = data.job;
  const ai = job?.running ? `AI думає: ${job.done} з ${job.total}…` : job ? `AI переглянув ${job.done}${job.failed ? `, без відповіді ${job.failed} — за правилом` : ""}` : "";
  return `
    <div class="today-import-bar">
      <p>${data.items.length ? `${data.items.length} відкритих діалогів без пінга. Дати розкладено до ${data.perDay} на робочий день, важливіші — раніше.` : "Відкритих діалогів без пінга немає."}</p>
      <div class="today-import-actions">
        <button type="button" data-today="import-ai" ${job?.running || !data.items.length ? "disabled" : ""}><i data-lucide="sparkles"></i><span>${job ? "Спитати AI ще раз" : "Спитати AI про кожного"}</span></button>
        ${ai ? `<span class="today-hint">${escapeHtml(ai)}</span>` : ""}
      </div>
    </div>
    ${data.items.length ? `<div class="today-import-accept">
      <label><span>Кому пінги</span><select data-today-import="assignee">
        <option value="">— оберіть —</option>
        ${(data.people || []).map((person) => `<option value="${escapeAttr(person.id)}"${person.id === today.importAssignee ? " selected" : ""}>${escapeHtml(person.email)}</option>`).join("")}
      </select></label>
      <button type="button" data-today="import-all">${picked.length === data.items.length ? "Зняти всі" : "Вибрати всі"}</button>
      <button type="button" class="primary-button" data-today="import-accept" ${!picked.length || !today.importAssignee || today.importBusy ? "disabled" : ""}><i data-lucide="check"></i><span>${today.importBusy ? "Ставлю пінги…" : `Прийняти вибрані (${picked.length})`}</span></button>
    </div>
    <div class="table-wrap today-import-table"><table>
      <thead><tr><th></th><th>Хто</th><th>Останній дотик</th><th>Крок</th><th>Дата</th><th>Чому</th></tr></thead>
      <tbody>${data.items.map((item) => {
        const last = item.timeline.at(-1);
        return `<tr>
          <td><input type="checkbox" data-today-import="pick" data-id="${escapeAttr(item.contactId)}" ${today.importPick.has(item.contactId) ? "checked" : ""} aria-label="Вибрати"></td>
          <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml([item.position, item.company].filter(Boolean).join(" · "))}</span><span class="pill tone-muted">${escapeHtml(item.status)}</span></td>
          <td><span>${escapeHtml(item.lastBy === "them" ? "Лід" : "Ми")} · ${escapeHtml(item.lastAt ? new Date(item.lastAt).toLocaleDateString("uk-UA") : "")}</span><span class="today-import-snippet">${escapeHtml(String(last?.text || "").replace(/^LinkedIn · [^\n]*\n/, "").slice(0, 160))}</span></td>
          <td><select data-today-import="reason" data-id="${escapeAttr(item.contactId)}">${Object.entries(STEP).map(([value, label]) => `<option value="${value}"${importValue(item, "reason") === value ? " selected" : ""}>${label}</option>`).join("")}</select></td>
          <td><input type="date" data-today-import="due" data-id="${escapeAttr(item.contactId)}" value="${escapeAttr(importValue(item, "due"))}"></td>
          <td><span>${escapeHtml(item.why || "")}</span><span class="today-hint">${item.by === "ai" ? "AI" : "правило"} · пріоритет ${escapeHtml(PRIORITY_LABEL[item.priority] || item.priority)}</span></td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>` : ""}`;
}

async function acceptImports() {
  const data = today.imports;
  const items = data.items.filter((item) => today.importPick.has(item.contactId)).map((item) => ({
    contactId: item.contactId, reason: importValue(item, "reason"), due: importValue(item, "due"), why: item.why, priority: item.priority
  }));
  today.importBusy = true;
  render();
  try {
    const result = await api("/api/today/open-dialogs/accept", { method: "POST", body: JSON.stringify({ items, assignee: today.importAssignee }) });
    say(`Пінги поставлено: ${result.created}${result.skipped ? `, пропущено (уже мали пінг): ${result.skipped}` : ""}.`);
    today.importEdits.clear();
    await loadImports();
    await openToday({ keepSelection: true });
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося поставити пінги.", "is-error");
  } finally {
    today.importBusy = false;
    render();
  }
}

/* ── малювання ──────────────────────────────────────────────────────────── */

// Розвантаження (аудит 16.10, D1): лідген під кожним пінгом — лише коли в списку їх кілька, і коротко.
const shortName = (email) => String(email || "").split("@")[0];
function mixedAssignees() {
  return new Set(allItems().map((item) => item.assignee).filter(Boolean)).size > 1;
}

function queueItem(item) {
  const preview = item.preview?.body ? `${item.preview.direction === "in" ? "" : "Ви: "}${item.preview.body}` : item.reasonTitle;
  return `<button type="button" class="today-item${item.pingId === today.selected ? " active" : ""}" data-today="select" data-id="${escapeAttr(item.pingId)}">
    <span class="today-item-top"><strong>${escapeHtml(item.name)}</strong><span class="today-due">${escapeHtml(dayLabel(item.dueDay, today.data.today))}</span></span>
    <span class="today-item-sub">${escapeHtml([item.position, item.company].filter(Boolean).join(" · "))}</span>
    <span class="today-item-preview">${escapeHtml(preview)}</span>
    ${today.scope === "all" && item.assignee && mixedAssignees() ? `<span class="today-item-who">${escapeHtml(shortName(item.assignee))}</span>` : ""}
  </button>`;
}

function queueHtml() {
  const data = today.data;
  const blocks = BLOCKS.map(([key, title, hint]) => {
    const items = data.blocks[key] || [];
    if (!items.length || (today.blockFilter && today.blockFilter !== key)) return "";
    return `<section class="today-block today-block-${key}">
      <h3 title="${escapeAttr(hint)}">${escapeHtml(title)}${data.blocks && Object.values(data.blocks).filter((list) => list.length).length > 1 ? "" : ` <span class="today-count">${items.length}</span>`}</h3>
      ${items.map(queueItem).join("")}
    </section>`;
  }).join("");
  const later = data.later?.length && !today.blockFilter
    ? `<details class="today-later"><summary>Далі за планом <span class="today-count">${data.later.length}</span></summary>
        ${data.later.map((item) => `<div class="today-later-row"><span>${escapeHtml(item.name)}</span><span>${escapeHtml(item.reasonTitle)} · ${escapeHtml(dayLabel(item.dueDay, data.today))}</span></div>`).join("")}
      </details>`
    : "";
  if (blocks || later) return `${blocks}${later}`;
  // Адмін у «Мої» з порожнім списком — пінги команди лежать в «Усі» (аудит 16.10, P2).
  if (data.canSeeAll && today.scope === "mine") {
    return `<p class="today-empty">Ваших пінгів сьогодні немає. Пінги лідгенів — у «Усі». <button type="button" data-today="scope" data-scope="all">Показати пінги команди</button></p>`;
  }
  return `<p class="today-empty">Сьогодні все розібрано.</p>`;
}

function messagesHtml(messages) {
  if (!messages.length) return "";
  return `<ol class="today-thread">${messages.slice(-15).map((message) => `
    <li class="today-msg ${message.direction === "in" ? "is-them" : "is-us"}">
      <span class="today-msg-body">${escapeHtml(message.body)}</span>
      <span class="today-msg-at">${escapeHtml(message.sentAt ? new Date(message.sentAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "")}</span>
    </li>`).join("")}</ol>`;
}

function workHtml() {
  if (today.detailLoading && !today.detail) return `<p class="today-empty">Відкриваю…</p>`;
  if (today.detailError) return `<p class="today-empty is-error">${escapeHtml(today.detailError)}</p>`;
  const detail = today.detail;
  if (!detail) return `<p class="today-empty">Оберіть пінг ліворуч.</p>`;
  const item = detail.item;
  const kind = item.channel === "first" ? "first" : detail.messages.at(-1)?.direction === "in" ? "reply" : "follow-up";
  const canWrite = item.channel === "thread" || item.channel === "first";
  const waiting = (detail.pending || []).filter((entry) => entry.state === "waiting");
  return `
    <header class="today-work-head">
      <div>
        <h3>${escapeHtml(item.name)}</h3>
        <p>${escapeHtml([item.position, item.company].filter(Boolean).join(" · "))}</p>
      </div>
      <span class="pill today-reason today-reason-${escapeAttr(item.block)}">${escapeHtml(item.reasonTitle)} · ${escapeHtml(dayLabel(item.dueDay, today.data?.today))}</span>
    </header>
    <p class="today-work-meta">
      ${item.campaign ? `<b>${escapeHtml(item.campaign.name || "без назви")}</b> · ` : ""}${item.accountName ? `<span title="Акаунт LinkedIn, з якого йде розмова">${escapeHtml(item.accountName)}</span>` : "LinkedIn"}
      ${item.crmUrl ? ` · <a href="${escapeAttr(item.crmUrl)}" target="_blank" rel="noopener noreferrer">Відкрити в CRM</a>` : ""}
      ${item.assignee && today.scope === "all" && mixedAssignees() ? ` · ${escapeHtml(shortName(item.assignee))}` : ""}
    </p>
    ${item.reassigned ? `<p class="today-note today-note-moved">Перепризначено з ${escapeHtml(item.reassigned.from)} на ${escapeHtml(item.reassigned.to)} (${escapeHtml(new Date(item.reassigned.at).toLocaleDateString("uk-UA"))}): старий акаунт заблоковано${item.channel === "moved" ? `; запит у друзі піде з ${escapeHtml(item.reassigned.to)}, і коли прийме — тут буде «Перше повідомлення»` : ""}.</p>` : ""}
    ${item.channel === "first" ? `<p class="today-note">Прийняв запит${detail.acceptedAt ? ` ${escapeHtml(new Date(detail.acceptedAt).toLocaleDateString("uk-UA"))}` : ""} — розмови ще немає, це перше повідомлення.</p>` : ""}
    ${messagesHtml(detail.messages)}
    ${waiting.length ? `<p class="today-note">У черзі · ще не надіслано: ${waiting.map((entry) => `«${escapeHtml(entry.body.slice(0, 80))}${entry.body.length > 80 ? "…" : ""}»`).join(", ")}</p>` : ""}
    ${today.notice ? `<p class="today-notice ${today.tone}" role="status">${escapeHtml(today.notice)}</p>` : ""}
    ${canWrite ? `
      <div class="today-draft">
        <div class="today-draft-head">
          <span>${DRAFT_LABEL[kind]}</span>
          <button type="button" data-today="rewrite" ${today.draftLoading ? "disabled" : ""}><i data-lucide="refresh-cw"></i><span>${today.draftLoading ? "Пишу…" : "Переписати"}</span></button>
        </div>
        ${today.draftNote ? `<p class="today-draft-note">${escapeHtml(today.draftNote)}</p>` : ""}
        <textarea id="todayText" rows="6" placeholder="${today.draftLoading ? "Модель пише чернетку…" : "Текст повідомлення"}">${escapeHtml(today.text)}</textarea>
        <div class="today-actions">
          <button type="button" class="primary-button" data-today="send" title="Піде з цього акаунта в найближчу сесію. Наступний пінг — через 3 робочі дні." ${today.sending || !today.text.trim() ? "disabled" : ""}><i data-lucide="send"></i><span>${today.sending ? "Ставлю в чергу…" : "Погодити й надіслати"}</span></button>
        </div>
      </div>` : item.channel === "moved" ? "" : `<p class="today-note">Переписки з цим контактом тут немає — відкрийте його в CRM або перенесіть пінг.</p>`}
    ${statusHtml(item)}
    <div class="today-move">
      <span>Перенести:</span>
      <button type="button" data-today="move" data-when="+1" title="На завтра (робочий день)">+1</button>
      <button type="button" data-today="move" data-when="+3" title="Через 3 робочі дні">+3</button>
      <button type="button" data-today="move" data-when="+7" title="Через тиждень">+7</button>
      <input type="date" id="todayMoveDate" aria-label="Перенести на дату" title="Вибір дати одразу переносить пінг" min="${escapeAttr(today.data?.today || "")}" />
      <button type="button" data-today="call" class="${today.callMode ? "active" : ""}" aria-pressed="${Boolean(today.callMode)}" title="Дзвінок: натисніть і оберіть дату"><i data-lucide="phone"></i><span>${today.callMode ? "Дзвінок — оберіть дату" : "Дзвінок"}</span></button>
    </div>`;
}

/** Статус і причина виходу — ті самі, що в CRM, і записуються в CRM (етап 5/6). */
function statusHtml(item) {
  const data = today.data;
  if (!data?.statuses || !item.contactId) return "";
  const current = today.statusDraft?.pingId === item.pingId ? today.statusDraft : { status: item.status || "new", exitReason: item.exitReason || "" };
  const closing = (data.closing || []).includes(current.status);
  return `<div class="today-status">
    <label title="Зберігається в CRM одразу при виборі"><span>Статус у CRM</span><select data-today-status="status">${data.statuses.map(([key, label]) => `<option value="${escapeAttr(key)}"${key === current.status ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
    ${closing ? `<label><span>Причина виходу</span><select data-today-status="exit"><option value="">— оберіть —</option>${data.exitReasons.map(([key, label]) => `<option value="${escapeAttr(key)}"${key === current.exitReason ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>` : ""}
    ${today.statusSaving ? `<span class="today-hint">Зберігаю в CRM…</span>` : closing && !current.exitReason ? `<span class="today-hint">Оберіть причину — статус збережеться одразу, пінги контакту закриються.</span>` : closing ? `<span class="today-hint">Вихід із воронки — пінги цього контакту закриються.</span>` : current.status === "booked_call" ? `<span class="today-hint">«Дзвінок» — у CRM з'явиться угода, якщо її ще немає.</span>` : ""}
  </div>`;
}

async function saveStatus() {
  const item = today.detail?.item;
  const draft = today.statusDraft;
  if (!item || !draft || today.statusSaving) return;
  today.statusSaving = true;
  render();
  try {
    const result = await api("/api/today/status", { method: "POST", body: JSON.stringify({ contactId: item.contactId, status: draft.status, exitReason: draft.exitReason }) });
    const label = today.data.statuses.find(([key]) => key === result.status)?.[1] || result.status;
    today.statusDraft = null;
    const name = item.name;
    await openToday({ keepSelection: true });
    say(`${name}: статус «${label}» у CRM${result.closedPings ? `, пінгів закрито: ${result.closedPings}` : ""}${result.dealId ? ", угоду створено" : ""}.`);
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося змінити статус.", "is-error");
  } finally {
    today.statusSaving = false;
  }
  render();
}

function render() {
  const host = root();
  if (!host) return;
  if (today.loading && !today.data) {
    host.innerHTML = `<section class="panel blk-queue today"><p class="today-empty">Збираю пінги…</p></section>`;
    return;
  }
  if (today.error && !today.data) {
    host.innerHTML = `<section class="panel blk-queue today"><p class="today-empty is-error">${escapeHtml(today.error)} <button type="button" data-today="reload">Спробувати ще раз</button></p></section>`;
    return;
  }
  const data = today.data;
  if (!data || data.configured === false) {
    host.innerHTML = "";
    return;
  }
  const counts = BLOCKS.map(([key, title]) => [key, title, (data.blocks[key] || []).length]).filter(([, , count]) => count);
  if (today.blockFilter && !counts.some(([key]) => key === today.blockFilter)) today.blockFilter = "";
  // Лічильники — це й фільтри: клік показує лише цей блок (аудит 16.10, P2).
  const chips = counts.length > 1
    ? `<div class="today-chips" role="group" aria-label="Який блок показати">
        <button type="button" data-today="block" data-block="" class="${today.blockFilter ? "" : "active"}">Усі ${counts.reduce((sum, [, , count]) => sum + count, 0)}</button>
        ${counts.map(([key, title, count]) => `<button type="button" data-today="block" data-block="${escapeAttr(key)}" class="${today.blockFilter === key ? "active" : ""}">${escapeHtml(title)} ${count}</button>`).join("")}
      </div>`
    : "";
  host.innerHTML = `
    <section class="panel blk-queue today">
      <header class="today-head">
        <div>
          <h2>Сьогодні</h2>
          ${chips || `<p>${counts.length ? counts.map(([, title, count]) => `${escapeHtml(title)}: ${count}`).join(" · ") : "Живих діалогів, що чекають, немає"}</p>`}
        </div>
        <div class="today-head-actions">
          ${data.canSeeAll ? `<div class="today-scope" role="group" aria-label="Чиї пінги">
            <button type="button" data-today="scope" data-scope="mine" class="${today.scope === "mine" ? "active" : ""}">Мої</button>
            <button type="button" data-today="scope" data-scope="all" class="${today.scope === "all" ? "active" : ""}">Усі</button>
          </div>` : ""}
          ${data.canSeeAll ? (today.importOpen
            ? `<button type="button" data-today="import-toggle">До пінгів</button>`
            : `<button type="button" class="icon-button" data-today="import-toggle" title="Відкриті діалоги з 01.08 — підтягнути в пінги" aria-label="Відкриті діалоги з 01.08"><i data-lucide="history"></i></button>`) : ""}
          <button type="button" class="icon-button" data-today="reload" title="Оновити" aria-label="Оновити"><i data-lucide="refresh-cw"></i></button>
        </div>
      </header>
      ${today.importOpen ? `${today.notice ? `<p class="today-notice ${today.tone}" role="status">${escapeHtml(today.notice)}</p>` : ""}<div class="today-import">${importHtml()}</div>` : allItems().length ? `<div class="today-layout">
        <aside class="today-queue">${queueHtml()}</aside>
        <article class="today-work">${workHtml()}</article>
      </div>` : `${today.notice ? `<p class="today-notice ${today.tone}" role="status">${escapeHtml(today.notice)}</p>` : ""}<div class="today-queue today-queue-solo">${queueHtml()}</div>`}
      ${data.newContactsAllowed ? "" : `<p class="today-gate">Нові контакти з папки — коли розберете відповіді й прострочені.</p>`}
    </section>`;
  refreshIcons(host);
}

/* ── дії ─────────────────────────────────────────────────────────────────── */

document.addEventListener("input", (event) => {
  if (event.target?.id === "todayText") {
    today.text = event.target.value;
    const sendButton = document.querySelector('#todayRoot [data-today="send"]');
    if (sendButton) sendButton.disabled = today.sending || !today.text.trim();
  }
});

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("#todayRoot [data-today]");
  if (!target) return;
  const act = target.dataset.today;
  if (act === "reload") return void openToday({ keepSelection: true });
  if (act === "block") {
    today.blockFilter = target.dataset.block || "";
    return render();
  }
  if (act === "scope") {
    today.scope = target.dataset.scope === "all" ? "all" : "mine";
    try { window.localStorage.setItem(SCOPE_KEY, today.scope); } catch {}
    return void openToday();
  }
  if (act === "select") {
    if (today.text.trim() && today.textFor && today.textFor !== target.dataset.id && today.text !== (today.detail?.draft?.text || "")
      && !window.confirm("Текст ще не надіслано. Перейти до іншого ліда?")) return;
    today.selected = target.dataset.id;
    today.callMode = false;
    today.detail = null;
    today.text = "";
    today.textFor = "";
    today.draftNote = "";
    say("");
    render();
    // На вузькому екрані робоче місце під чергою — показуємо його, а не лишаємо внизу.
    if (window.matchMedia("(max-width: 900px)").matches) document.querySelector("#todayRoot .today-work")?.scrollIntoView({ block: "start" });
    return void loadDetail(today.selected);
  }
  if (act === "import-toggle") {
    today.importOpen = !today.importOpen;
    say("");
    render();
    if (today.importOpen) void loadImports();
    return;
  }
  if (act === "import-ai") {
    return void api("/api/today/open-dialogs/suggest", { method: "POST", body: "{}" })
      .then(() => loadImports())
      .catch((error) => { say(error.message || "AI зараз недоступний.", "is-warn"); render(); });
  }
  if (act === "import-all") {
    const all = today.imports?.items || [];
    const everyPicked = all.every((item) => today.importPick.has(item.contactId));
    for (const item of all) {
      if (everyPicked) { today.importPick.delete(item.contactId); today.importPick.add(`x:${item.contactId}`); }
      else { today.importPick.add(item.contactId); today.importPick.delete(`x:${item.contactId}`); }
    }
    return render();
  }
  if (act === "import-accept") return void acceptImports();
  if (act === "rewrite") return void writeDraft(true);
  if (act === "send") return void send();
  if (act === "move") return void movePing(target.dataset.when);
  if (act === "call") {
    // «Дзвінок» вмикає режим: наступний вибір дати ставить дзвінок, а не просто переносить пінг.
    today.callMode = !today.callMode;
    render();
    const input = document.getElementById("todayMoveDate");
    input?.focus();
    try { if (today.callMode) input?.showPicker?.(); } catch {}
    return;
  }
});

// D5: вибір дати сам переносить пінг — без окремої кнопки «На дату».
document.addEventListener("change", (event) => {
  if (event.target?.id !== "todayMoveDate" || !event.target.value) return;
  const call = Boolean(today.callMode);
  today.callMode = false;
  void movePing(event.target.value, call);
});

document.addEventListener("change", (event) => {
  const field = event.target.closest?.("#todayRoot [data-today-import]");
  if (!field) return;
  const kind = field.dataset.todayImport;
  const id = field.dataset.id;
  if (kind === "assignee") today.importAssignee = field.value;
  if (kind === "pick") {
    if (field.checked) { today.importPick.add(id); today.importPick.delete(`x:${id}`); }
    else { today.importPick.delete(id); today.importPick.add(`x:${id}`); }
  }
  if (kind === "reason" || kind === "due") today.importEdits.set(id, { ...(today.importEdits.get(id) || {}), [kind]: field.value });
  render();
});

document.addEventListener("change", (event) => {
  const field = event.target.closest?.("#todayRoot [data-today-status]");
  const item = today.detail?.item;
  if (!field || !item) return;
  const base = today.statusDraft?.pingId === item.pingId ? today.statusDraft : { pingId: item.pingId, status: item.status || "new", exitReason: item.exitReason || "" };
  const draft = { ...base, [field.dataset.todayStatus === "exit" ? "exitReason" : "status"]: field.value };
  // Закриваючий статус без причини бере причину за замовчуванням (Не ICP → не ICP, Без відповіді → не відповідає).
  if (field.dataset.todayStatus === "status") draft.exitReason = (today.data?.closing || []).includes(draft.status) ? (today.data?.defaultExit?.[draft.status] || "") : "";
  today.statusDraft = draft;
  // Зберігається одразу при виборі (аудит 16.10, P2): окремої кнопки «Зберегти статус» більше немає.
  // Закриваючий статус — коли є причина виходу.
  const closing = (today.data?.closing || []).includes(draft.status);
  const changed = draft.status !== (item.status || "new") || (draft.exitReason || "") !== (item.exitReason || "");
  if (changed && (!closing || draft.exitReason)) return void saveStatus();
  render();
});
