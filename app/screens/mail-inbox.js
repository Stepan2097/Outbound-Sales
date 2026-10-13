// Пошта → «Вхідні» = Unibox (ESP-UI 4, як екран Snov 02): усі розмови
// пошт-відправників з людьми — у папках, з пошуком і фільтрами, сторінками
// по 50; розмова відкривається на місці списку, з міткою відповіді й відповіддю
// від тієї ж пошти в тому ж треді. Ліва колонка тримає й журнал пошт
// (ESP 7, app/screens/esp-inbox.js). Відповіді LinkedIn — окремий екран
// LinkedIn → «Вхідні» (app/screens/inbox.js; власник 13.10: «розділити»).
//
// Відкриттів і кліків немає: листи без пікселів і переписаних посилань.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

const CHANNEL_KEY = "unibox:channel";
const LABEL_TONE = { positive: "tone-live", negative: "tone-warn", referral: "tone-done", neutral: "tone-muted" };
const KIND_LABEL = { sent: "Ми написали", replied: "Відповідь", autoreplied: "Автовідповідь", bounced: "Не доставлено", unsubscribed: "Відписка" };
const FOLDER_ICON = { inbox: "inbox", sent: "send", starred: "star", bounced: "mail-x" };

export const unibox = {
  channel: readChannel(),
  folder: "inbox",
  filters: { label: "", campaign: "", sender: "", q: "" },
  offset: 0,
  list: null,
  thread: null,
  openKey: null,
  selected: new Set(),
  notice: "",
  error: "",
  loading: false,
  dismissed: new Set()
};

const CHANNELS = ["mail", "events"];

function readChannel() {
  try { const saved = window.localStorage.getItem(CHANNEL_KEY); return CHANNELS.includes(saved) ? saved : "mail"; } catch { return "mail"; }
}

function saveChannel(channel) {
  try { window.localStorage.setItem(CHANNEL_KEY, channel); } catch { /* лише зручність */ }
}

onScreen("mail-inbox", { open: () => void openUnibox() });

async function openUnibox() {
  if (!document.getElementById("unibox")) return;
  renderUnibox();
  if (unibox.channel === "mail") await loadUniboxList();
}

/** The letters or the mailboxes' journal — the two halves of this screen. */
export function showInboxChannel(channel) {
  unibox.channel = CHANNELS.includes(channel) ? channel : "mail";
  saveChannel(unibox.channel);
  renderUnibox();
}

export async function loadUniboxList() {
  const params = new URLSearchParams({ folder: unibox.folder, offset: String(unibox.offset) });
  for (const [key, value] of Object.entries(unibox.filters)) if (value) params.set(key, value);
  unibox.loading = true;
  try {
    unibox.list = await api(`/api/esp/unibox?${params}`);
    unibox.offset = unibox.list.offset;
    unibox.error = "";
  } catch (error) {
    unibox.error = error?.status === 403 ? "Пошту бачить команда з правом читати відповіді — його дає адміністратор." : error?.message || "Вхідні листи не прочиталися.";
  } finally {
    unibox.loading = false;
  }
  renderUnibox();
}

async function openThread(key) {
  unibox.openKey = key;
  unibox.notice = "";
  try {
    const answer = await api(`/api/esp/unibox/thread?key=${encodeURIComponent(key)}`);
    unibox.thread = answer;
    if (answer.thread.unread) {
      await api("/api/esp/unibox/read", { method: "POST", body: JSON.stringify({ key }) }).catch(() => null);
      const row = unibox.list?.rows.find((item) => item.key === key);
      if (row && row.unread) { row.unread = false; unibox.list.counts.unread = Math.max(0, unibox.list.counts.unread - 1); }
    }
  } catch (error) {
    unibox.openKey = null;
    unibox.notice = error?.message || "Розмова не відкрилась.";
  }
  renderUnibox();
}

function closeThread() {
  unibox.openKey = null;
  unibox.thread = null;
  unibox.notice = "";
  renderUnibox();
}

// ── малювання ─────────────────────────────────────────────────────────────

function shortDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("uk-UA", { day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}

function who(row) {
  return row.name || String(row.contact).split("@")[0];
}

function toolbarHtml() {
  if (unibox.channel !== "mail") return "";
  const list = unibox.list;
  const labels = list?.labels || {};
  const option = (value, text, current) => `<option value="${escapeAttr(value)}"${current === value ? " selected" : ""}>${escapeHtml(text)}</option>`;
  return `
    <label class="mail-search"><i data-lucide="search"></i><input type="search" id="uniboxSearch" placeholder="Пошук у листах: адреса, ім'я, компанія, тема, текст" value="${escapeAttr(unibox.filters.q)}" autocomplete="off" /></label>
    <select id="uniboxLabel" aria-label="Які листи">${option("", "Усі листи", unibox.filters.label)}${option("unread", "Непрочитані", unibox.filters.label)}${Object.entries(labels).map(([key, text]) => option(key, `Відповідь: ${text}`, unibox.filters.label)).join("")}</select>
    <select id="uniboxCampaign" aria-label="Кампанія">${option("", "Усі кампанії", unibox.filters.campaign)}${(list?.campaigns || []).map((row) => option(row.id, row.name, unibox.filters.campaign)).join("")}</select>
    <select id="uniboxSender" aria-label="Пошта">${option("", "Усі пошти", unibox.filters.sender)}${(list?.senders || []).map((email) => option(email, email, unibox.filters.sender)).join("")}</select>`;
}

function sideHtml() {
  const counts = unibox.list?.counts || {};
  const folders = unibox.list?.folders || { inbox: "Вхідні", sent: "Надіслані", starred: "Із зірочкою", bounced: "Bounce" };
  const mail = Object.entries(folders).map(([key, text]) => {
    const count = key === "inbox" ? counts.unread : key === "starred" || key === "bounced" ? counts[key] : null;
    const active = unibox.channel === "mail" && unibox.folder === key;
    return `<button type="button" class="${active ? "is-active" : ""}" data-unibox-folder="${key}"${active ? ' aria-current="page"' : ""}><i data-lucide="${FOLDER_ICON[key]}"></i><span>${escapeHtml(text)}</span>${count ? `<b>${count}</b>` : ""}</button>`;
  }).join("");
  return `
    <div class="mail-side-title">Пошта</div>
    ${mail}
    <button type="button" class="${unibox.channel === "events" ? "is-active" : ""}" data-unibox-events><i data-lucide="list-checks"></i><span>Журнал пошт</span></button>`;
}

function bannerHtml() {
  const problems = (unibox.list?.problems || []).filter((row) => !unibox.dismissed.has(row.code));
  return problems.map((row) => `
    <div class="mail-banner" role="status">
      <i data-lucide="circle-alert"></i>
      <p>${escapeHtml(row.text)}</p>
      <button type="button" class="icon-button" data-unibox-dismiss="${escapeAttr(row.code)}" aria-label="Сховати" title="Сховати"><i data-lucide="x"></i></button>
    </div>`).join("");
}

function labelPill(label) {
  const labels = unibox.list?.labels || unibox.thread?.labels || {};
  return label ? `<span class="pill ${LABEL_TONE[label] || "tone-muted"}">${escapeHtml(labels[label] || label)}</span>` : "";
}

function listHtml() {
  const list = unibox.list;
  if (unibox.error && !list) return `<div class="empty-state">${escapeHtml(unibox.error)}</div>`;
  if (!list) return '<div class="empty-state">Читаємо вхідні листи...</div>';
  const rows = list.rows;
  const allChecked = rows.length > 0 && rows.every((row) => unibox.selected.has(row.key));
  const from = list.total ? list.offset + 1 : 0;
  const to = list.offset + rows.length;
  const picked = [...unibox.selected].filter((key) => rows.some((row) => row.key === key));
  const bar = `
    <div class="mail-list-bar">
      <input type="checkbox" id="uniboxAll" aria-label="Вибрати всі на сторінці"${allChecked ? " checked" : ""}${rows.length ? "" : " disabled"} />
      ${picked.length ? `
        <span class="unibox-picked">Вибрано: ${picked.length}</span>
        <button type="button" class="text-button" data-unibox-bulk="star"><i data-lucide="star"></i><span>Із зірочкою</span></button>
        <button type="button" class="text-button" data-unibox-bulk="unstar"><i data-lucide="star-off"></i><span>Зняти зірочку</span></button>
        <button type="button" class="text-button" data-unibox-bulk="read"><i data-lucide="mail-open"></i><span>Прочитано</span></button>`
        : `<button type="button" class="icon-button" data-unibox-refresh aria-label="Оновити" title="Оновити"><i data-lucide="refresh-cw"></i></button>`}
      <div class="mail-pager">
        <span>${from}–${to} з ${list.total}</span>
        <button type="button" class="icon-button" data-unibox-page="-1" aria-label="Попередня сторінка"${list.offset > 0 ? "" : " disabled"}><i data-lucide="chevron-left"></i></button>
        <button type="button" class="icon-button" data-unibox-page="1" aria-label="Наступна сторінка"${to < list.total ? "" : " disabled"}><i data-lucide="chevron-right"></i></button>
      </div>
    </div>`;
  const notice = unibox.notice ? `<p class="esp-notice">${escapeHtml(unibox.notice)}</p>` : "";
  if (!rows.length) {
    const filtered = Object.values(unibox.filters).some(Boolean);
    const empty = filtered ? "Під ці фільтри листів немає." : unibox.folder === "inbox" ? "Відповідей на холодні листи ще немає." : unibox.folder === "starred" ? "Зірочкою ще нічого не позначено." : unibox.folder === "bounced" ? "Недоставлених листів немає." : "Холодних листів ще не надсилали.";
    return `${bar}${notice}<div class="empty-state">${empty}</div>`;
  }
  return `${bar}${notice}<ul class="unibox-list">${rows.map((row) => `
    <li class="unibox-row${row.unread ? " is-unread" : ""}${unibox.selected.has(row.key) ? " is-picked" : ""}">
      <input type="checkbox" data-unibox-pick="${escapeAttr(row.key)}" aria-label="Вибрати розмову з ${escapeAttr(who(row))}"${unibox.selected.has(row.key) ? " checked" : ""} />
      <button type="button" class="unibox-star${row.starred ? " is-on" : ""}" data-unibox-star="${escapeAttr(row.key)}" aria-pressed="${row.starred}" aria-label="${row.starred ? "Зняти зірочку" : "Позначити зірочкою"}"><i data-lucide="star"></i></button>
      <button type="button" class="unibox-open" data-unibox-open="${escapeAttr(row.key)}">
        <span class="unibox-icon is-${row.bounced && row.lastDirection === "in" ? "bounced" : "mail"}"><i data-lucide="${row.bounced && row.lastDirection === "in" ? "mail-x" : "mail"}"></i></span>
        <span class="unibox-who" title="${escapeAttr(row.contact)}">${escapeHtml(who(row))}<small>${row.count}</small></span>
        <span class="unibox-text"><span class="unibox-subject">${escapeHtml(row.subject || "(без теми)")}</span>${row.snippet ? `<span class="unibox-dot">•</span><span class="unibox-snippet">${escapeHtml(row.snippet)}</span>` : ""}</span>
        <span class="unibox-meta">${labelPill(row.label)}</span>
        <span class="unibox-date" title="${escapeAttr(new Date(row.lastAt).toLocaleString("uk-UA"))}">${escapeHtml(shortDate(row.lastAt))}</span>
      </button>
    </li>`).join("")}</ul>`;
}

function threadHtml() {
  const answer = unibox.thread;
  if (!answer) return '<div class="empty-state">Відкриваємо розмову...</div>';
  const row = answer.thread;
  const labels = answer.labels || {};
  const messages = row.messages.map((message) => `
    <li class="unibox-message is-${message.direction}">
      <div class="unibox-message-head">
        <strong>${message.direction === "out" ? escapeHtml(row.sender) : escapeHtml(row.name ? `${row.name} <${row.contact}>` : row.contact)}</strong>
        <span>${escapeHtml(KIND_LABEL[message.kind] || message.kind)}${message.code ? ` · ${escapeHtml(message.code)}` : ""}${message.step != null ? ` · лист ${message.step + 1}` : ""}</span>
        <time>${escapeHtml(new Date(message.at).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" }))}</time>
      </div>
      ${message.subject && message.subject !== row.subject ? `<p class="unibox-message-subject">${escapeHtml(message.subject)}</p>` : ""}
      ${message.text ? `<pre>${escapeHtml(message.text)}</pre>` : ""}
      ${message.kind === "replied" && message.gmailId ? `<div class="unibox-labels"><span>Мітка:</span>${Object.entries(labels).map(([key, text]) => `<button type="button" class="pill ${message.label === key ? LABEL_TONE[key] : "tone-muted"}" data-unibox-label="${escapeAttr(key)}" data-gmail="${escapeAttr(message.gmailId)}" aria-pressed="${message.label === key}">${escapeHtml(text)}</button>`).join("")}${message.labelBy && message.labelBy !== "rule" ? `<small>виправив ${escapeHtml(message.labelBy)}</small>` : ""}</div>` : ""}
    </li>`).join("");
  const hint = answer.mode === "stub"
    ? (answer.replyOnStub ? "Тестовий цикл на заглушці: відповідь запишеться, у мережу не піде." : "Пошту ще не підключено — відповідь не піде.")
    : answer.liveSend ? `Піде справжній лист із ${row.sender} у цьому ж треді.` : "Відправка вимкнена до приймання ESP 11 — шлюз відповідь відхилить.";
  return `
    <div class="mail-list-bar">
      <button type="button" class="text-button" data-unibox-back><i data-lucide="arrow-left"></i><span>До списку</span></button>
      <button type="button" class="unibox-star${row.starred ? " is-on" : ""}" data-unibox-star="${escapeAttr(row.key)}" aria-pressed="${row.starred}" aria-label="${row.starred ? "Зняти зірочку" : "Позначити зірочкою"}"><i data-lucide="star"></i></button>
    </div>
    <div class="unibox-thread">
      <header>
        <h2>${escapeHtml(row.subject || "(без теми)")}</h2>
        <p>${escapeHtml(row.name || row.contact)}${row.company ? ` · ${escapeHtml(row.company)}` : ""} · ${escapeHtml(row.contact)} · пише ${escapeHtml(row.sender)}${row.campaignName ? ` · кампанія «${escapeHtml(row.campaignName)}»` : ""}</p>
      </header>
      <ul class="unibox-messages">${messages}</ul>
      ${row.unsubscribed ? '<p class="mail-banner"><i data-lucide="ban"></i><span>Людина відписалась — відповідати не можна.</span></p>' : `
      <form class="unibox-reply" id="uniboxReply">
        <textarea id="uniboxReplyText" rows="5" placeholder="Відповідь піде з ${escapeAttr(row.sender)} у цьому ж треді, простим текстом із підписом."></textarea>
        <div class="unibox-reply-bar">
          <small>${escapeHtml(hint)}</small>
          <button class="primary-button" type="submit"><i data-lucide="send"></i><span>Відповісти</span></button>
        </div>
      </form>`}
      ${unibox.notice ? `<p class="esp-notice">${escapeHtml(unibox.notice)}</p>` : ""}
    </div>`;
}

export function renderUnibox() {
  const toolbar = document.getElementById("uniboxToolbar");
  const side = document.getElementById("uniboxSide");
  const mail = document.getElementById("uniboxMail");
  const events = document.getElementById("uniboxEvents");
  if (!toolbar || !side || !mail) return;
  const onMail = unibox.channel === "mail";
  // The search keeps its caret while the list behind it is redrawn.
  const typing = document.activeElement?.id === "uniboxSearch";
  toolbar.hidden = !onMail;
  if (!typing) toolbar.innerHTML = toolbarHtml();
  side.innerHTML = sideHtml();
  if (events) events.hidden = unibox.channel !== "events";
  mail.hidden = !onMail;
  if (onMail) mail.innerHTML = `${bannerHtml()}<div class="mail-main">${unibox.openKey ? threadHtml() : listHtml()}</div>`;
  refreshIcons(document.getElementById("unibox"));
}

// ── дії ───────────────────────────────────────────────────────────────────

async function mark(path, keys, extra = {}) {
  try {
    await api(`/api/esp/unibox/${path}`, { method: "POST", body: JSON.stringify({ keys, ...extra }) });
    unibox.notice = "";
  } catch (error) {
    unibox.notice = error?.status === 403 ? "Зірочки ставить той, хто має право відповідати на листи." : error?.message || "Не вдалося.";
  }
}

const root = () => document.getElementById("unibox");

root()?.addEventListener("click", async (event) => {
  const target = event.target;
  const folder = target.closest("[data-unibox-folder]")?.dataset.uniboxFolder;
  if (folder) {
    Object.assign(unibox, { channel: "mail", folder, offset: 0, openKey: null, thread: null });
    unibox.selected.clear();
    saveChannel("mail");
    renderUnibox();
    return loadUniboxList();
  }
  if (target.closest("[data-unibox-events]")) return showInboxChannel("events");
  const dismiss = target.closest("[data-unibox-dismiss]")?.dataset.uniboxDismiss;
  if (dismiss) { unibox.dismissed.add(dismiss); return renderUnibox(); }
  if (target.closest("[data-unibox-refresh]")) return loadUniboxList();
  const page = target.closest("[data-unibox-page]")?.dataset.uniboxPage;
  if (page) {
    unibox.offset = Math.max(0, unibox.offset + Number(page) * (unibox.list?.limit || 50));
    unibox.selected.clear();
    return loadUniboxList();
  }
  const star = target.closest("[data-unibox-star]");
  if (star) {
    const on = star.getAttribute("aria-pressed") !== "true";
    await mark("star", [star.dataset.uniboxStar], { on });
    if (unibox.openKey) await openThread(unibox.openKey);
    return loadUniboxList();
  }
  const bulk = target.closest("[data-unibox-bulk]")?.dataset.uniboxBulk;
  if (bulk) {
    const keys = [...unibox.selected];
    if (bulk === "read") await mark("read", keys);
    else await mark("star", keys, { on: bulk === "star" });
    unibox.selected.clear();
    return loadUniboxList();
  }
  const open = target.closest("[data-unibox-open]")?.dataset.uniboxOpen;
  if (open) return openThread(open);
  if (target.closest("[data-unibox-back]")) { closeThread(); return loadUniboxList(); }
  const label = target.closest("[data-unibox-label]");
  if (label) {
    try {
      await api("/api/esp/conversations/label", { method: "POST", body: JSON.stringify({ gmailId: label.dataset.gmail, label: label.dataset.uniboxLabel }) });
    } catch (error) {
      unibox.notice = error?.status === 403 ? "Мітку виправляє той, хто має право відповідати на листи." : error?.message || "Мітка не змінилась.";
    }
    return openThread(unibox.openKey);
  }
});

root()?.addEventListener("change", (event) => {
  const target = event.target;
  const filter = { uniboxLabel: "label", uniboxCampaign: "campaign", uniboxSender: "sender" }[target.id];
  if (filter) {
    unibox.filters[filter] = target.value;
    Object.assign(unibox, { offset: 0, openKey: null, thread: null });
    return loadUniboxList();
  }
  if (target.id === "uniboxAll") {
    for (const row of unibox.list?.rows || []) target.checked ? unibox.selected.add(row.key) : unibox.selected.delete(row.key);
    return renderUnibox();
  }
  const pick = target.dataset?.uniboxPick;
  if (pick) {
    target.checked ? unibox.selected.add(pick) : unibox.selected.delete(pick);
    renderUnibox();
  }
});

let searchTimer = null;
root()?.addEventListener("input", (event) => {
  if (event.target.id !== "uniboxSearch") return;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    unibox.filters.q = event.target.value.trim();
    Object.assign(unibox, { offset: 0, openKey: null, thread: null });
    void loadUniboxList();
  }, 300);
});

root()?.addEventListener("submit", async (event) => {
  if (event.target.id !== "uniboxReply") return;
  event.preventDefault();
  const text = document.getElementById("uniboxReplyText")?.value || "";
  const button = event.target.querySelector("button[type=submit]");
  if (button) button.disabled = true;
  try {
    const answer = await api("/api/esp/conversations/reply", { method: "POST", body: JSON.stringify({ key: unibox.openKey, text }) });
    unibox.notice = answer.stub ? "Записано як надіслане через заглушку — у мережу не пішло." : "Надіслано.";
    await openThread(unibox.openKey);
  } catch (error) {
    unibox.notice = error?.message || "Відповідь не пішла.";
    renderUnibox();
    const field = document.getElementById("uniboxReplyText");
    if (field) field.value = text;
  }
});
