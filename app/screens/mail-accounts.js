// «Скриньки» → «Скриньки для розсилки» (власник 13.10): як «Email accounts» в
// Instantly і Snov — кнопка «Додати скриньку», вибір способу, вікно Google,
// «Дозволити», і скринька в списку зі своїм станом. Пароля платформа не бачить:
// Google віддає дозвіл на одну скриньку, сервер тримає його зашифрованим
// (esp/google-oauth.mjs, маршрути — esp/mailbox-connect.mjs).
//
// Повернення з Google — адреса «#mail-settings/mailbox/ok/<скринька>» або
// «…/error/<що не так>»: сторінка показує це плашкою й прибирає з адресного рядка.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

onScreen("mail-settings", { open: () => void openMailAccounts() });

const accounts = { data: null, error: "", adding: false, busy: "", notice: "", tone: "", checks: {} };

const rootEl = () => document.getElementById("mailAccountsBody");
const when = (iso) => (iso ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

/** What Google's redirect brought back, once. */
function readReturn() {
  const parts = window.location.hash.replace(/^#/, "").split("/");
  if (parts[0] !== "mail-settings" || parts[1] !== "mailbox") return;
  const value = decodeURIComponent(parts.slice(3).join("/") || "");
  if (parts[2] === "ok") Object.assign(accounts, { notice: `Скриньку ${value} підключено. Вона вже у відправниках; ліміт росте рампою з 5 листів на день.`, tone: "is-ok" });
  if (parts[2] === "error") Object.assign(accounts, { notice: value || "Не вдалося підключити скриньку.", tone: "is-bad", adding: true });
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#mail-settings`);
}

async function openMailAccounts() {
  readReturn();
  await load();
}

async function load() {
  try {
    accounts.data = await api("/api/esp/oauth/google");
    accounts.error = "";
  } catch (error) {
    accounts.error = error.message || "Не вдалося прочитати скриньки.";
  }
  render();
}

function setupHtml(data) {
  if (data.configured) return "";
  if (!data.canManage) return '<p class="mail-acc-muted">Адміністратор ще не налаштував вхід через Google на сервері — кнопка запрацює, щойно він це зробить.</p>';
  return `<details class="mail-acc-setup" open>
    <summary>Що зробити один раз, щоб кнопка запрацювала</summary>
    <ol>
      <li><b>console.cloud.google.com</b> → проєкт → «APIs &amp; Services» → «Library» → увімкнути <b>Gmail API</b>.</li>
      <li>«OAuth consent screen» → тип <b>Internal</b> (скриньки вашого Workspace підключаються без перевірки Google) → назва, пошта підтримки → зберегти.</li>
      <li>«Credentials» → «Create credentials» → «OAuth client ID» → тип <b>Web application</b> → у «Authorized redirect URIs» вставити:
        <code class="mail-acc-code">${escapeHtml(data.redirectUri || "(адреса з'явиться, коли сервер знатиме свою публічну адресу)")}</code></li>
      <li>Client ID і Client secret — у змінні сервера <code>ESP_GOOGLE_OAUTH_CLIENT_ID</code> і <code>ESP_GOOGLE_OAUTH_CLIENT_SECRET</code> (передайте їх у чат розробки — їх покладуть у Coolify, не в код).</li>
      <li>Скриньки з <i>іншого</i> Workspace: їхній адміністратор у admin.google.com → «Безпека» → «Елементи керування API» → «Керувати доступом застосунків» → Client ID → «Довірений». Як для Instantly.</li>
    </ol>
    <p class="mail-acc-muted">Не вистачає: ${escapeHtml(data.missing.join(", "))}.</p>
  </details>`;
}

function addHtml(data) {
  if (!accounts.adding) return "";
  const google = data.configured
    ? `<form class="mail-acc-google" data-acc-form="google">
        <input type="email" name="mailbox" placeholder="скринька@домен.com (необов'язково)" autocomplete="off" aria-label="Яку скриньку підключити" />
        <button type="submit" class="primary-button" ${accounts.busy === "start" ? "disabled" : ""}><i data-lucide="log-in"></i><span>${accounts.busy === "start" ? "Відкриваю Google…" : "Увійти через Google"}</span></button>
      </form>
      <p class="mail-acc-muted">Відкриється вікно Google: оберіть скриньку й натисніть «Дозволити» на всіх пунктах — надсилання, читання відповідей, мітки (для прогріву).</p>`
    : setupHtml(data);
  return `<div class="mail-acc-add">
    <div class="mail-acc-option is-main">
      <header><i data-lucide="mail"></i><div><b>Gmail / Google Workspace</b><span class="pill tone-live">рекомендовано</span></div></header>
      ${google}
    </div>
    <div class="mail-acc-option is-later">
      <header><i data-lucide="key-round"></i><div><b>Інша пошта — пароль застосунку (SMTP/IMAP)</b><span class="pill tone-muted">наступним кроком</span></div></header>
      <p class="mail-acc-muted">Особистий @gmail.com, Zoho, пошта хостингу: адреса й 16-значний пароль застосунку.</p>
    </div>
    <div class="mail-acc-option is-later">
      <header><i data-lucide="building-2"></i><div><b>Microsoft 365 / Outlook</b><span class="pill tone-muted">пізніше</span></div></header>
      <p class="mail-acc-muted">Вхід через Microsoft — так само кнопкою.</p>
    </div>
  </div>`;
}

function stateHtml(row) {
  if (row.status === "broken") return `<span class="mail-acc-state is-bad" title="${escapeAttr(row.error || "")}"><i data-lucide="unplug"></i>доступ втрачено</span>`;
  const sender = row.sender;
  if (sender && sender.effectiveStatus !== "active") return `<span class="mail-acc-state is-warn"><i data-lucide="pause"></i>${sender.effectiveStatus === "retired" ? "виведено" : "на паузі"}</span>`;
  return '<span class="mail-acc-state is-ok"><i data-lucide="check"></i>підключено</span>';
}

function rowHtml(row, data) {
  const check = accounts.checks[row.email];
  const mayDrop = row.connectedBy === data.me || data.canManage;
  return `<tr>
    <td><b>${escapeHtml(row.email)}</b>${row.name ? `<small>${escapeHtml(row.name)}</small>` : ""}
      ${row.status === "broken" ? `<small class="mail-acc-error">${escapeHtml(row.error || "")}</small>` : ""}
      ${check ? `<small class="${check.ok ? "mail-acc-okline" : "mail-acc-error"}">${escapeHtml(check.ok ? `Перевірено: доступ є${check.messagesTotal ? `, листів у скриньці — ${check.messagesTotal}` : ""}.` : check.error || "Google відмовив.")}</small>` : ""}
      ${row.canModify ? "" : '<small class="mail-acc-muted">без дозволу на мітки — прогрів не виймає листи зі спаму</small>'}</td>
    <td>${stateHtml(row)}</td>
    <td>${row.sender ? `${row.sender.rampStage} / день` : "—"}</td>
    <td>${escapeHtml(row.connectedBy || "—")}<small>${escapeHtml(when(row.connectedAt))}</small></td>
    <td><div class="mail-acc-actions">
      ${row.status === "broken"
        ? `<button type="button" class="primary-button" data-acc-reconnect="${escapeAttr(row.email)}"><i data-lucide="log-in"></i><span>Увійти знову</span></button>`
        : `<button type="button" data-acc-check="${escapeAttr(row.email)}" ${accounts.busy === row.email ? "disabled" : ""}><i data-lucide="mail-check"></i><span>${accounts.busy === row.email ? "Перевіряю…" : "Перевірити"}</span></button>`}
      ${mayDrop ? `<button type="button" class="text-button" data-acc-drop="${escapeAttr(row.email)}"><i data-lucide="unplug"></i><span>Відключити</span></button>` : ""}
    </div></td>
  </tr>`;
}

function render() {
  const root = rootEl();
  if (!root) return;
  const data = accounts.data;
  const addButton = document.getElementById("mailAccountsAdd");
  if (addButton) addButton.classList.toggle("is-on", accounts.adding);
  if (accounts.error) { root.innerHTML = `<p class="esp-notice is-bad">${escapeHtml(accounts.error)}</p>`; return; }
  if (!data) { root.innerHTML = '<p class="mail-acc-muted">Читаю скриньки…</p>'; return; }
  const rows = data.mailboxes || [];
  root.innerHTML = `
    ${accounts.notice ? `<p class="esp-notice ${accounts.tone}">${escapeHtml(accounts.notice)}</p>` : ""}
    ${addHtml(data)}
    ${data.liveSend ? "" : '<p class="mail-acc-muted"><i data-lucide="lock"></i> Справжня відправка на сервері поки вимкнена (ESP_LIVE_SEND): скриньки вже можна підключати й перевіряти, листи підуть, щойно її ввімкнуть.</p>'}
    ${rows.length ? `<div class="mail-acc-table"><table>
      <thead><tr><th>Скринька</th><th>Стан</th><th>Ліміт</th><th>Хто підключив</th><th></th></tr></thead>
      <tbody>${rows.map((row) => rowHtml(row, data)).join("")}</tbody>
    </table></div>` : `<div class="mail-acc-empty"><i data-lucide="inbox"></i><p>Ще жодної підключеної скриньки. «Додати скриньку» → «Увійти через Google».</p></div>`}`;
  refreshIcons(root);
}

async function startGoogle(mailbox = "") {
  accounts.busy = "start";
  render();
  try {
    const answer = await api("/api/esp/oauth/google/start", { method: "POST", body: JSON.stringify({ mailbox }) });
    window.location.assign(answer.url);
  } catch (error) {
    Object.assign(accounts, { busy: "", notice: error.message || "Не вдалося почати вхід.", tone: "is-bad" });
    render();
  }
}

async function check(mailbox) {
  accounts.busy = mailbox;
  render();
  try {
    const answer = await api("/api/esp/oauth/google/check", { method: "POST", body: JSON.stringify({ mailbox }) });
    accounts.checks[mailbox] = answer;
    if (answer.mailboxes) accounts.data.mailboxes = answer.mailboxes;
  } catch (error) {
    accounts.checks[mailbox] = { ok: false, error: error.message };
  }
  accounts.busy = "";
  render();
}

async function drop(mailbox) {
  if (!window.confirm(`Відключити ${mailbox}? Листи з неї перестануть іти, доступ у Google буде відкликано. Підключити знову можна тією ж кнопкою.`)) return;
  try {
    const answer = await api("/api/esp/oauth/google/disconnect", { method: "POST", body: JSON.stringify({ mailbox }) });
    accounts.data.mailboxes = answer.mailboxes || [];
    Object.assign(accounts, { notice: `Скриньку ${mailbox} відключено.`, tone: "" });
  } catch (error) {
    Object.assign(accounts, { notice: error.message || "Не вдалося відключити.", tone: "is-bad" });
  }
  render();
}

document.addEventListener("click", (event) => {
  if (event.target.closest("#mailAccountsAdd")) {
    accounts.adding = !accounts.adding;
    accounts.notice = accounts.tone === "is-bad" ? accounts.notice : "";
    return render();
  }
  const root = rootEl();
  if (!root || !root.contains(event.target)) return;
  const target = event.target.closest("[data-acc-check], [data-acc-drop], [data-acc-reconnect]");
  if (!target) return;
  if (target.dataset.accCheck) return void check(target.dataset.accCheck);
  if (target.dataset.accDrop) return void drop(target.dataset.accDrop);
  if (target.dataset.accReconnect) return void startGoogle(target.dataset.accReconnect);
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest?.('[data-acc-form="google"]');
  if (!form || !rootEl()?.contains(form)) return;
  event.preventDefault();
  void startGoogle(String(new FormData(form).get("mailbox") || "").trim());
});
