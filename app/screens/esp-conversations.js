// Вхідні → «Пошта (холодні листи)» (ESP 14): спільна вхідна команди — усі
// розмови скриньок-відправників з людьми, з міткою відповіді й швидкою
// відповіддю від того ж сендера в тому ж треді. Приблизно Unibox Snov
// (фільтри, список розмов, відповідь), у стилі цього екрана. Реальна відправка
// заблокована до приймання ESP 11 — і екран так і каже.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, setHtml } from "../core.js";

onScreen("inbox", { open: () => void loadEspConversations() });

const LABEL_TONE = { positive: "tone-live", negative: "tone-warn", referral: "tone-done", neutral: "tone-muted" };
const KIND_LABEL = { sent: "ми написали", replied: "відповідь", autoreplied: "автовідповідь", bounced: "bounce", unsubscribed: "відписка" };

const espInbox = { conversations: [], labels: {}, filters: { label: "", q: "" }, openKey: null, notice: "", liveSend: false, mode: "stub", replyOnStub: false, error: "" };

export async function loadEspConversations() {
  if (!document.getElementById("espConversationsBody")) return;
  const params = new URLSearchParams();
  if (espInbox.filters.label) params.set("label", espInbox.filters.label);
  if (espInbox.filters.q) params.set("q", espInbox.filters.q);
  try {
    const answer = await api(`/api/esp/conversations?${params}`);
    Object.assign(espInbox, { conversations: answer.conversations, labels: answer.labels, liveSend: answer.liveSend, mode: answer.mode, replyOnStub: answer.replyOnStub, error: "" });
    const panel = document.getElementById("espConversationsPanel");
    if (panel) panel.hidden = false;
  } catch (error) {
    // Без права бачити відповіді блоку просто немає.
    const panel = document.getElementById("espConversationsPanel");
    if (panel) panel.hidden = true;
    return;
  }
  renderEspConversations();
}

function labelPill(label) {
  return label ? `<span class="pill ${LABEL_TONE[label] || "tone-muted"}">${escapeHtml(espInbox.labels[label] || label)}</span>` : "";
}

function listHtml() {
  if (!espInbox.conversations.length) return '<div class="empty-state">Відповідей на холодні листи ще немає.</div>';
  return `<ul class="esp-conv-list">${espInbox.conversations.map((row) => {
    const last = row.messages.at(-1);
    return `<li><button type="button" class="esp-conv-row ${row.key === espInbox.openKey ? "is-open" : ""}" data-esp-conv="${escapeAttr(row.key)}">
      <strong>${escapeHtml(row.contact)}</strong>${labelPill(row.label)}
      <span>${escapeHtml(last?.text ? String(last.text).slice(0, 90) : KIND_LABEL[last?.kind] || "")}</span>
      <small>${escapeHtml(row.sender)}${row.campaignName ? ` · ${escapeHtml(row.campaignName)}` : ""} · ${escapeHtml(new Date(row.lastAt).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }))}</small>
    </button></li>`;
  }).join("")}</ul>`;
}

function threadHtml() {
  const row = espInbox.conversations.find((item) => item.key === espInbox.openKey);
  if (!row) return '<div class="empty-state">Вибери розмову зліва.</div>';
  const messages = row.messages.map((message) => `
    <li class="esp-conv-message is-${message.direction}">
      <small>${escapeHtml(KIND_LABEL[message.kind] || message.kind)}${message.code ? ` ${escapeHtml(message.code)}` : ""} · ${escapeHtml(new Date(message.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }))}${message.step != null ? ` · лист ${message.step + 1}` : ""}</small>
      ${message.text ? `<pre>${escapeHtml(message.text)}</pre>` : ""}
      ${message.kind === "replied" && message.gmailId ? `<div class="esp-conv-labels">${Object.entries(espInbox.labels).map(([key, text]) => `<button type="button" class="pill ${message.label === key ? LABEL_TONE[key] : "tone-muted"} esp-label-btn" data-esp-label="${escapeAttr(key)}" data-gmail="${escapeAttr(message.gmailId)}">${escapeHtml(text)}</button>`).join("")}${message.labelBy && message.labelBy !== "rule" ? `<small>мітку виправив ${escapeHtml(message.labelBy)}</small>` : ""}</div>` : ""}
    </li>`).join("");
  return `
    <div class="esp-conv-head"><strong>${escapeHtml(row.contact)}</strong> <small>з ${escapeHtml(row.sender)} · «${escapeHtml(row.subject || "")}»</small></div>
    <ul class="esp-conv-thread">${messages}</ul>
    <form class="esp-conv-reply" id="espConvReply">
      <textarea id="espConvReplyText" rows="4" placeholder="Відповідь піде з ${escapeAttr(row.sender)} у цьому ж треді, простим текстом із підписом."></textarea>
      <div class="esp-editor-actions">
        <small>${espInbox.mode === "stub"
          ? (espInbox.replyOnStub ? "Тестовий цикл на заглушці: відповідь запишеться, у мережу не піде." : "Пошту ще не підключено — відповідь не піде.")
          : espInbox.liveSend ? "Надішле справжній лист." : "Відправка вимкнена до приймання ESP 11 — відповідь буде відхилена шлюзом."}</small>
        <button class="primary-button" type="submit"><i data-lucide="send"></i><span>Відповісти</span></button>
      </div>
    </form>
    ${espInbox.notice ? `<p class="esp-notice">${escapeHtml(espInbox.notice)}</p>` : ""}`;
}

export function renderEspConversations() {
  const filters = `<div class="esp-conv-filters">
    <select id="espConvLabel"><option value="">Усі відповіді</option>${Object.entries(espInbox.labels).map(([key, text]) => `<option value="${escapeAttr(key)}" ${espInbox.filters.label === key ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select>
    <input id="espConvSearch" type="search" placeholder="Пошук у листах" value="${escapeAttr(espInbox.filters.q)}" />
  </div>`;
  setHtml("espConversationsBody", `${filters}<div class="esp-conv-layout"><div>${listHtml()}</div><div>${threadHtml()}</div></div>`);
  refreshIcons();
}

const root = () => document.getElementById("espConversationsBody");

root()?.addEventListener("click", async (event) => {
  const open = event.target.closest("[data-esp-conv]");
  if (open) {
    espInbox.openKey = open.dataset.espConv;
    espInbox.notice = "";
    return renderEspConversations();
  }
  const label = event.target.closest("[data-esp-label]");
  if (label) {
    await api("/api/esp/conversations/label", { method: "POST", body: JSON.stringify({ gmailId: label.dataset.gmail, label: label.dataset.espLabel }) }).catch((error) => { espInbox.notice = error.message; });
    return loadEspConversations();
  }
});

root()?.addEventListener("change", (event) => {
  if (event.target.id === "espConvLabel") {
    espInbox.filters.label = event.target.value;
    void loadEspConversations();
  }
});

let espSearchTimer = null;
root()?.addEventListener("input", (event) => {
  if (event.target.id !== "espConvSearch") return;
  window.clearTimeout(espSearchTimer);
  espSearchTimer = window.setTimeout(() => { espInbox.filters.q = event.target.value.trim(); void loadEspConversations(); }, 350);
});

root()?.addEventListener("submit", async (event) => {
  if (event.target.id !== "espConvReply") return;
  event.preventDefault();
  const text = document.getElementById("espConvReplyText")?.value || "";
  try {
    const answer = await api("/api/esp/conversations/reply", { method: "POST", body: JSON.stringify({ key: espInbox.openKey, text }) });
    espInbox.notice = answer.stub ? "Записано як надіслане через заглушку — у мережу не пішло." : "Надіслано.";
  } catch (error) {
    espInbox.notice = error.message;
  }
  await loadEspConversations();
});
