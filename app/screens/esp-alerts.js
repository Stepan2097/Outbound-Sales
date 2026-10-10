// Листи → банери тривог (ESP 8): що поставлено на паузу саме — сендер чи
// кампанія — і чому. Як жовті банери в Snov про скриньку з помилкою. Паузу
// знімає людина: сендера — в реєстрі, кампанію — кнопкою «Запустити».

import { api, escapeHtml, onScreen, refreshIcons, setHtml } from "../core.js";

onScreen("email", { open: () => void loadEspAlerts() });

export async function loadEspAlerts() {
  if (!document.getElementById("espAlertsBody")) return;
  try {
    const { alerts, telegram } = await api("/api/esp/alerts");
    const panel = document.getElementById("espAlertsPanel");
    if (panel) panel.hidden = !alerts.length;
    setHtml("espAlertsBody", alerts.map((alert) => `
      <div class="esp-alert" role="alert">
        <i data-lucide="triangle-alert"></i>
        <div>
          <strong>${escapeHtml(alert.title)}</strong>
          <p>${escapeHtml(alert.reason)}</p>
          <small>${escapeHtml(new Date(alert.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }))} · ${alert.kind === "pause_sender" ? "зняти паузу — у реєстрі відправників, коли причину усунуто" : alert.kind === "pause_domain" ? "зняти паузу — у реєстрі доменів, коли домен вийшов зі списку" : alert.kind === "alert" ? "нічого не поставлено на паузу — перевірте" : "запустити знову — у списку кампаній, коли джерело перевірено"}${telegram ? " · надіслано в Telegram" : ""}</small>
        </div>
      </div>`).join(""));
  } catch {
    // Alarms the viewer may not see are simply not shown.
  }
  refreshIcons();
}
