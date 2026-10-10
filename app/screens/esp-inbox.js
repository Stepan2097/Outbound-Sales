// Листи → «Що прийшло в скриньки» (ESP 7): відповіді, автовідповіді, bounce з
// кодами, відписки й тривоги по сендерах — з журналу, найновіше вгорі.
// Приблизно Unibox Snov (Inbox / Bounced), але лише події холодної пошти;
// спільна вхідна з відповіддю звідси — ESP 14.

import { api, escapeHtml, onScreen, refreshIcons, setHtml } from "../core.js";

onScreen("email", { open: () => void loadEspInbox() });

const KIND = {
  "message.replied": ["відповів", "tone-live"],
  "message.autoreplied": ["автовідповідь", "tone-muted"],
  "message.bounced": ["bounce", "tone-warn"],
  "contact.unsubscribed": ["відписався", "tone-warn"],
  "sender.alert": ["тривога по сендеру", "tone-bad"]
};

function bounceMeaning(code) {
  if (/^5\.1\.1/.test(code)) return "адреси немає — у виключення";
  if (/^5\.7\./.test(code)) return "відмова за політикою — тривога по сендеру";
  if (/^4\./.test(code)) return "тимчасово — рахується окремо, ланцюжок іде далі";
  return "постійна відмова — ланцюжок зупинено";
}

function detail(event) {
  if (event.type === "message.bounced") return `${escapeHtml(event.code)} · ${escapeHtml(bounceMeaning(event.code || ""))}`;
  if (event.type === "message.autoreplied") return event.returnDate ? `повернеться ${escapeHtml(event.returnDate)} — наступний лист після того` : "наступний лист перенесено на 3 робочі дні";
  if (event.type === "contact.unsubscribed") return escapeHtml(event.via === "mailto" ? "через List-Unsubscribe (mailto)" : event.via === "one-click" || event.via === "page" ? "посилання відписки" : `відповіддю: «${event.text || ""}»`);
  if (event.type === "sender.alert") return `${escapeHtml(event.code || "")} · ${escapeHtml(event.contact || "")}`;
  return event.text ? `«${escapeHtml(event.text)}»` : "";
}

export async function loadEspInbox() {
  if (!document.getElementById("espInboxBody")) return;
  try {
    const answer = await api("/api/esp/inbox");
    const rows = answer.events.length
      ? `<ul class="esp-inbox-list">${answer.events.map((event) => {
          const [label, tone] = KIND[event.type] || [event.type, "tone-muted"];
          return `<li>
            <span class="pill ${tone}">${label}</span>
            <div><strong>${escapeHtml(event.type === "sender.alert" ? event.sender || "" : event.contact || "")}</strong>
              <small>${event.sender && event.type !== "sender.alert" ? `→ ${escapeHtml(event.sender)} · ` : ""}${escapeHtml(new Date(event.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }))}</small>
              <p>${detail(event)}</p></div>
          </li>`;
        }).join("")}</ul>`
      : '<div class="empty-state">У скриньки ще нічого не приходило.</div>';
    const note = answer.polling ? "Скриньки читаються кожні 5 хвилин." : "Автоматичне читання вимкнено (ESP_SEQUENCE) — лише кнопкою.";
    setHtml("espInboxBody", `<p class="esp-limits-rules">${escapeHtml(note)}</p>${rows}`);
  } catch (error) {
    setHtml("espInboxBody", `<div class="empty-state">${escapeHtml(error.status === 403 ? "Вхідні холодної пошти бачить команда з правом replies.read." : error.message)}</div>`);
  }
  refreshIcons();
}

document.getElementById("espInboxPoll")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api("/api/esp/inbox/poll", { method: "POST", body: "{}" });
  } catch {
    // Said by the list below, which reloads either way.
  }
  button.disabled = false;
  await loadEspInbox();
});
