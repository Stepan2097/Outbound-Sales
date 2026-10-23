// Сповіщення у верхньому куті (Марко 23.10, таск 4e97fa87): «лідгену… приходило сповіщення на
// платформі, що аккаунт потребує уваги… і чітка інструкція». На кожному екрані: значок із числом
// акаунтів лідгена, що чекають людину (потрібен вхід, капча); клік — панель з кроками й кнопкою
// «Перевірити вхід» (той самий запит, що посилання з Telegram-групи). Сервер: /api/account-alerts.

import { api, escapeAttr, escapeHtml, onWorkspaceEnter, refreshIcons } from "../core.js";

const POLL_MS = 5 * 60000;
const WAIT_POLL_MS = 15000;
const alerts = { list: [], open: false, busy: "", notice: "", timer: null };
const host = () => document.getElementById("accountAlerts");
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" }) : "");
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "");
const waiting = (account) => Boolean(account.recheck && !account.recheck.doneAt);

// «Вхід є» після вдалої перевірки лишається, доки людина не натисне «Зрозуміло» (суддя 23.10: інакше
// картка мовчки зникала, бо сервер одразу знімає паузу). Що вже бачили — пам'ятає браузер.
const SEEN_KEY = "outbound.accountAlerts.seen";
const seenKey = (account) => `${account.id}|${account.recheck?.doneAt || ""}`;
function readSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); } catch { return new Set(); }
}
function markSeen(account) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...readSeen(), seenKey(account)].slice(-50))); } catch { /* приватне вікно: побачить ще раз */ }
}
const shownAlerts = () => alerts.list.filter((account) => !account.recovered || !readSeen().has(seenKey(account)));

/** Перечитати сповіщення — і з інших екранів (Workspace після «Перевірити вхід»). */
export async function refreshAccountAlerts() {
  return loadAlerts();
}

async function loadAlerts() {
  try {
    alerts.list = (await api("/api/account-alerts")).alerts || [];
  } catch {
    return; // Без сповіщення — не біда: адмін бачить те саме на Головній.
  }
  render();
  clearTimeout(alerts.timer);
  alerts.timer = setTimeout(loadAlerts, alerts.list.some(waiting) ? WAIT_POLL_MS : POLL_MS);
}

/** Кроки — для лідгена, без слів «health» і «агент»: що відкрити, що натиснути, коли писати. */
function stepsHtml(account) {
  const fix = account.health === "captcha"
    ? "LinkedIn показує капчу — пройди її"
    : "Якщо LinkedIn просить увійти — увійди в акаунт";
  return `<ol class="account-alert-steps">
    <li>Відкрий в AnyBrowser профіль <b>${escapeHtml(account.label || "акаунта")}</b> — саме той, що підключений до порталу.</li>
    <li>${escapeHtml(fix)}. Переконайся, що відкривається стрічка LinkedIn.</li>
    <li>Закрий профіль — так AnyBrowser збереже вхід — і натисни «Перевірити вхід». Перевірка займає до хвилини.</li>
    <li>Не вийшло за 5 хвилин — напиши в чат розробки (Павлу), що саме бачиш у профілі.</li>
  </ol>`;
}

function recheckHtml(account) {
  const check = account.recheck;
  if (!check) return "";
  if (!check.doneAt) return `<p class="account-alert-state">Перевіряю вхід (запит о ${escapeHtml(time(check.requestedAt))})…</p>`;
  return check.signedIn
    ? `<p class="account-alert-state is-ok">Вхід є — акаунт повертається в роботу.</p>`
    : `<p class="account-alert-state is-bad">Вхід ще не видно${check.reason ? `: ${escapeHtml(check.reason)}` : ""}. Перевір, що входив саме в профілі «${escapeHtml(account.label || "")}», закрий його й спробуй ще раз.</p>`;
}

function render() {
  const root = host();
  if (!root) return;
  const shown = shownAlerts();
  const count = shown.length;
  const allGood = count > 0 && shown.every((account) => account.recovered);
  root.hidden = !count;
  if (!count) { alerts.open = false; root.innerHTML = ""; return; }
  const items = shownAlerts().map((account) => {
    const name = account.identity ? `${account.identity} (${account.label})` : account.label;
    if (account.recovered) {
      return `<li class="account-alert is-recovered">
      <p class="account-alert-head"><b>${escapeHtml(name || "Акаунт")}</b> — вхід є${account.recheck?.doneAt ? ` (перевірено о ${escapeHtml(time(account.recheck.doneAt))})` : ""}.</p>
      <p class="account-alert-state is-ok">Акаунт повертається в роботу: нові повідомлення знову підтягуватимуться, відповіді з нього підуть.</p>
      <button type="button" data-alerts-seen="${escapeAttr(account.id)}">Зрозуміло</button>
    </li>`;
    }
    const what = account.health === "captcha" ? "LinkedIn показав капчу" : "LinkedIn просить увійти";
    return `<li class="account-alert">
      <p class="account-alert-head"><b>${escapeHtml(name || "Акаунт")}</b> — ${escapeHtml(what)}${account.since ? ` з ${escapeHtml(day(account.since))}` : ""}. Нові повідомлення з нього не підтягуються, відповіді з нього не йдуть.</p>
      ${stepsHtml(account)}
      ${recheckHtml(account)}
      <button type="button" class="primary-button" data-alerts-recheck="${escapeAttr(account.id)}" ${alerts.busy === account.id || waiting(account) ? "disabled" : ""}><i data-lucide="refresh-cw"></i><span>${waiting(account) ? "Перевіряю…" : "Перевірити вхід"}</span></button>
    </li>`;
  }).join("");
  const title = allGood ? "Вхід відновлено" : count === 1 ? "Акаунт потребує уваги" : "Акаунти потребують уваги";
  root.innerHTML = `<button type="button" class="account-alerts-bell${allGood ? " is-ok" : ""}" data-alerts="toggle" aria-expanded="${alerts.open}" title="Акаунти LinkedIn, які чекають на тебе">
      <i data-lucide="${allGood ? "circle-check" : "triangle-alert"}"></i><b>${count}</b><span>${title}</span>
    </button>
    ${alerts.open ? `<section class="account-alerts-panel" role="dialog" aria-label="${escapeAttr(title)}">
      <header><h2>${escapeHtml(title)}</h2><button type="button" class="icon-button" data-alerts="toggle" aria-label="Закрити"><i data-lucide="x"></i></button></header>
      ${alerts.notice ? `<p class="account-alert-state is-bad">${escapeHtml(alerts.notice)}</p>` : ""}
      <ul>${items}</ul>
    </section>` : ""}`;
  refreshIcons(root);
}

async function recheck(accountId) {
  alerts.busy = accountId;
  alerts.notice = "";
  render();
  try {
    await api("/api/account-alerts/recheck", { method: "POST", body: JSON.stringify({ accountId }) });
  } catch (error) {
    alerts.notice = error?.message || "Не вдалося попросити перевірку.";
  }
  alerts.busy = "";
  await loadAlerts();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("#accountAlerts [data-alerts], #accountAlerts [data-alerts-recheck], #accountAlerts [data-alerts-seen]");
  if (!target) {
    if (alerts.open && !event.target.closest?.("#accountAlerts")) { alerts.open = false; render(); }
    return;
  }
  if (target.dataset.alertsRecheck) return void recheck(target.dataset.alertsRecheck);
  if (target.dataset.alertsSeen) {
    const account = alerts.list.find((row) => row.id === target.dataset.alertsSeen);
    if (account) markSeen(account);
    return render();
  }
  alerts.open = !alerts.open;
  render();
});

onWorkspaceEnter(() => void loadAlerts());
