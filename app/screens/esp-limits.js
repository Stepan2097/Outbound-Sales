// Листи → «Ліміти сьогодні» (ESP 4): скільки кожен сендер і домен уже надіслав
// за день проти свого ліміту, і правила, за якими йде відправка. Лише читає.

import { api, escapeHtml, onScreen, setHtml } from "../core.js";

onScreen("email", { open: () => void loadEspLimits() });

export async function loadEspLimits() {
  if (!document.getElementById("espLimitsBody")) return;
  try {
    renderEspLimits(await api("/api/esp/limits"));
  } catch (error) {
    setHtml("espLimitsBody", `<div class="empty-state">${escapeHtml(error.status === 403 ? "Ліміти бачить адміністратор." : error.message)}</div>`);
  }
}

const SENDER_STATE = { active: "надсилає", paused: "на паузі", retired: "виведений", held: "чекає домену" };

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "—");

function renderEspLimits(limits) {
  const rules = `Сендер — етап рампи (5 → 35) на день сумарно по всіх кампаніях · домен — до ${limits.domainLimit} на день · Пн–Пт ${String(limits.window.startHour).padStart(2, "0")}:00–${limits.window.endHour}:00 за часом одержувача · ${limits.gapMinutes.min}–${limits.gapMinutes.max} хв між листами сендера · без доганяння`;
  const senders = limits.senders.length
    ? `<div class="table-wrap"><table class="esp-limits-table">
        <thead><tr><th>Відправник</th><th>Стан</th><th>Сьогодні</th><th>Останній лист</th></tr></thead>
        <tbody>${limits.senders.map((sender) => `
          <tr>
            <td>${escapeHtml(sender.email)}</td>
            <td>${escapeHtml(SENDER_STATE[sender.status] || sender.status)}</td>
            <td><span class="pill ${sender.today >= sender.limit ? "tone-warn" : "tone-muted"}">${sender.today} / ${sender.limit}</span></td>
            <td>${escapeHtml(time(sender.lastAt))}</td>
          </tr>`).join("")}</tbody>
      </table></div>`
    : '<div class="empty-state">У реєстрі ще немає відправників.</div>';
  const domains = limits.domains.length
    ? `<p class="esp-limits-domains">${limits.domains.map((domain) => `${escapeHtml(domain.domain)}: ${domain.today} / ${domain.limit}`).join(" · ")}</p>`
    : "";
  setHtml("espLimitsBody", `<p class="esp-limits-rules">${escapeHtml(rules)}</p>${senders}${domains}`);
}
