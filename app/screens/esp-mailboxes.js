// Налаштування → «Пошта для розсилки» (ESP 1): з чим цей сервер ходить у Gmail,
// що вписати в консоль адміністратора Workspace, і чи можна діяти від імені
// конкретної скриньки. Нічого звідси не надсилається — тут лише підключення.

import { api, authState, escapeHtml, onScreen, refreshIcons, setHtml } from "../core.js";

onScreen("account", { open: () => void loadEspConnection() });

let espConnection = null;
let espError = "";
let espCheck = null;
let espChecking = false;
// Скриньки, від імені яких Google перестав пускати (ESP 1): кожна на паузі,
// доки людина не виправить причину й не зніме паузу сама.
let espPaused = [];


export async function loadEspConnection() {
  const panel = document.getElementById("espMailPanel");
  if (!panel) return;
  // Лише адміністратор: продавцеві тут нічого налаштовувати, і сервер йому
  // однаково відмовить.
  panel.hidden = authState?.user?.role !== "admin";
  if (panel.hidden) return;
  try {
    const [connection, paused] = await Promise.all([api("/api/esp/connection"), api("/api/esp/senders/paused")]);
    espConnection = connection;
    espPaused = paused.paused || [];
    espError = "";
  } catch (error) {
    espConnection = null;
    espError = error.message || "Сервер не відповів.";
  }
  renderEspMailPanel();
}

function espConnectionHtml(connection) {
  if (!connection) return `<div class="empty-state">${escapeHtml(espError || "Читаємо підключення...")}</div>`;
  const real = connection.mode === "gmail";
  const rows = [
    ["Підключення", real ? "Gmail API через сервісний акаунт" : "Заглушка — нікуди не надсилає, поки власник не дасть ключ"],
    ...(real ? [["Сервісний акаунт", connection.serviceAccountEmail], ["Client ID для делегування", connection.clientId || "—"]] : []),
    ["Відправка", connection.liveSend ? "увімкнена" : "вимкнена до приймання ESP 11 — справжні листи не йдуть"]
  ];
  return `
    ${connection.keyError ? `<p class="esp-key-error">Ключ дали, але він не читається: ${escapeHtml(connection.keyError)} Працює заглушка.</p>` : ""}
    <dl class="esp-facts">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    <details class="profile-details">
      <summary><span>Scopes для делегування</span><i data-lucide="chevron-down"></i></summary>
      <div class="profile-details-body">
        <p class="profile-chart-note">${escapeHtml(real
          ? "Ці scopes — через кому — у консолі адміністратора Workspace, «Делегування на рівні домену», для Client ID вище."
          : "Ці scopes — через кому — у консолі адміністратора Workspace, «Делегування на рівні домену», для Client ID сервісного акаунта; він з'явиться тут, щойно на сервері буде ключ.")}</p>
        <code class="esp-scopes">${escapeHtml((connection.scopes || []).join(","))}</code>
      </div>
    </details>
  `;
}

function espCheckHtml(check) {
  if (espChecking) return '<p class="esp-check is-busy">Перевіряємо...</p>';
  if (!check) return "";
  if (!check.ok) return `<p class="esp-check is-bad">${escapeHtml(check.mailbox)}: ${escapeHtml(check.error || "Google відмовив.")}</p>`;
  const alias = check.address && check.address !== check.mailbox ? ` Google називає її ${escapeHtml(check.address)} — це псевдонім, відповіді прийдуть туди.` : "";
  return `<p class="esp-check is-ok">${escapeHtml(check.mailbox)}: ${check.stub ? "заглушка приймає цю скриньку (справжньої перевірки не було)." : "доступ є."}${alias}</p>`;
}

/** Як банер у Unibox Snov про відключену скриньку: що сталося, з якого часу, що робити. */
function espPausedHtml(paused) {
  if (!paused.length) return "";
  return paused.map((row) => `
    <div class="esp-paused" role="alert">
      <i data-lucide="mail-warning"></i>
      <div>
        <strong>${escapeHtml(row.mailbox)} на паузі — листи з неї не йдуть.</strong>
        <p>${escapeHtml(row.reason || "Google відмовив у доступі.")}</p>
        <small>з ${escapeHtml(row.at ? new Date(row.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }) : "—")} · спроб не повторюємо, доки ти не знімеш паузу</small>
      </div>
      <button class="text-button" type="button" data-esp-resume="${escapeHtml(row.mailbox)}">Виправлено — зняти паузу</button>
    </div>`).join("");
}

export function renderEspMailPanel() {
  setHtml("espMailBody", `
    ${espPausedHtml(espPaused)}
    ${espConnectionHtml(espConnection)}
    <form class="integration-form esp-check-form" id="espCheckForm">
      <input id="espCheckInput" type="email" placeholder="sender@твій-домен.com" required ${espChecking ? "disabled" : ""} />
      <button type="submit" ${espChecking || !espConnection ? "disabled" : ""}><i data-lucide="mail-check"></i><span>Перевірити доступ</span></button>
    </form>
    ${espCheckHtml(espCheck)}
  `);
  refreshIcons();
}

document.getElementById("espMailBody")?.addEventListener("submit", async (event) => {
  if (event.target.id !== "espCheckForm") return;
  event.preventDefault();
  const mailbox = document.getElementById("espCheckInput")?.value.trim();
  if (!mailbox) return;
  espChecking = true;
  renderEspMailPanel();
  try {
    espCheck = await api("/api/esp/mailboxes/check", { method: "POST", body: JSON.stringify({ mailbox }) });
  } catch (error) {
    espCheck = { ok: false, mailbox, error: error.message };
  } finally {
    espChecking = false;
    renderEspMailPanel();
  }
});

document.getElementById("espMailBody")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-esp-resume]");
  if (!button) return;
  button.disabled = true;
  try {
    const answer = await api("/api/esp/senders/resume", { method: "POST", body: JSON.stringify({ mailbox: button.dataset.espResume }) });
    espPaused = answer.paused || [];
  } catch (error) {
    espError = error.message;
  }
  renderEspMailPanel();
});
