// Підключення пошт — частина сторінки «Прогрів пошт» (власник 15.10: «сторінка
// "пошти" не потрібна, просто перенеси її функціонал на сторінку прогрів
// пошти»). Тут те, що була сторінка «Пошти»: «Додати пошту» (вікно вибору,
// «Увійти через Google»), стан підключення кожної пошти, «Перевірити»,
// «Увійти знову», «Відключити» й теги. Малює це mail-warmup.js у своїй таблиці;
// цей модуль дає шматки й дії. Пароля платформа не бачить: Google віддає дозвіл
// на одну пошту, сервер тримає його зашифрованим (esp/google-oauth.mjs,
// маршрути — esp/mailbox-connect.mjs).
//
// Повернення з Google — «#mail-warmup/mailbox/ok/<пошта>» або «…/error/<що не так>».

import { api, escapeAttr, escapeHtml } from "../core.js";

export const accounts = { data: null, error: "", busy: "", notice: "", tone: "", checks: {}, dialog: false, dialogError: "", picked: "", tagging: "" };

let rerender = () => {};
/** The page that shows all this — redrawn after every change here. */
export function onAccountsChange(fn) { rerender = fn; }

const tagPills = (tags = []) => tags.map((tag) => `<span class="acc-tag${tag === "Прогрів" ? " is-warm" : tag === "Розсилка" ? " is-send" : ""}">${escapeHtml(tag)}</span>`).join("");

/** What Google's redirect brought back, once. */
export function readAccountsReturn() {
  const parts = window.location.hash.replace(/^#/, "").split("/");
  if (parts[0] !== "mail-warmup" || parts[1] !== "mailbox") return;
  const value = decodeURIComponent(parts.slice(3).join("/") || "");
  // A successful sign-in needs no sentence: the mailbox is simply in the table (owner 15.10).
  if (parts[2] === "error") Object.assign(accounts, { notice: value || "Не вдалося додати пошту.", tone: "is-bad" });
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#mail-warmup`);
}

export async function loadAccounts() {
  try {
    accounts.data = await api("/api/esp/oauth/google");
    accounts.error = "";
  } catch (error) {
    accounts.error = error.message || "Не вдалося прочитати підключення пошт.";
  }
}

const accountOf = (email) => (accounts.data?.mailboxes || []).find((row) => row.email === email) || null;

function stateOf(row) {
  if (!row) return null;
  if (row.status === "broken") return { tone: "is-bad", icon: "unplug", text: "доступ втрачено", hint: row.error || "" };
  if (row.status === "not_signed_in") {
    return accounts.data?.domainKey
      ? { tone: "is-ok", icon: "key-round", text: "через ключ домену", hint: "Працює через ключ адміністратора домену" }
      : { tone: "is-warn", icon: "log-in", text: "не підключено", hint: "Пошта є у відправниках, але не увійшла через Google — листи з неї не підуть" };
  }
  return null;
}

/** Under the address: a word when the connection is not fine, the last check, the team's tags. */
export function accountNotesHtml(email) {
  const row = accountOf(email);
  const state = stateOf(row);
  const check = accounts.checks[email];
  return [
    state ? `<span class="acc-state ${state.tone}" title="${escapeAttr(state.hint)}"><i data-lucide="${state.icon}"></i>${escapeHtml(state.text)}</span>` : "",
    row?.status === "broken" && row.error ? `<small class="acc-note is-bad">${escapeHtml(row.error)}</small>` : "",
    check ? `<small class="acc-note ${check.ok ? "is-ok" : "is-bad"}">${escapeHtml(check.ok ? `Доступ є${check.messagesTotal ? ` · листів у пошті: ${check.messagesTotal}` : ""}` : check.error || "Google відмовив.")}</small>` : "",
    row && row.via === "google" && row.status !== "broken" && !row.canModify ? '<small class="acc-note">без дозволу на мітки — прогрів не виймає листи зі спаму; «Увійти знову» й дозвольте все</small>' : ""
  ].join("");
}

/** The connection's own buttons for a row: sign in again, check, tags, disconnect. */
export function accountActionsHtml(email) {
  const data = accounts.data;
  const row = accountOf(email);
  if (!data || !row) return "";
  const buttons = [];
  if (row.status === "broken" || (row.status === "not_signed_in" && !data.domainKey)) {
    buttons.push(`<button type="button" class="icon-button acc-icon is-signin" data-acc-signin="${escapeAttr(email)}" title="${row.status === "broken" ? "Увійти знову через Google" : "Увійти через Google"}" aria-label="Увійти через Google ${escapeAttr(email)}" ${data.configured ? "" : "disabled"}><i data-lucide="log-in"></i></button>`);
  } else if (row.via === "google") {
    buttons.push(`<button type="button" class="icon-button acc-icon" data-acc-check="${escapeAttr(email)}" title="Перевірити доступ" aria-label="Перевірити ${escapeAttr(email)}" ${accounts.busy === email ? "disabled" : ""}><i data-lucide="${accounts.busy === email ? "loader" : "mail-check"}"></i></button>`);
  }
  if (row.sender && data.canTag) buttons.push(`<button type="button" class="icon-button acc-icon" data-acc-tags="${escapeAttr(email)}" title="Теги" aria-label="Теги ${escapeAttr(email)}"><i data-lucide="tag"></i></button>`);
  if (row.via === "google" && (row.connectedBy === data.me || data.canManage)) buttons.push(`<button type="button" class="icon-button acc-icon is-danger" data-acc-drop="${escapeAttr(email)}" title="Відключити пошту" aria-label="Відключити ${escapeAttr(email)}"><i data-lucide="unplug"></i></button>`);
  return buttons.join("");
}

/** The tags editor for the mailbox being tagged, or nothing. */
export function tagEditorHtml(email) {
  if (accounts.tagging !== email) return "";
  const tags = accountOf(email)?.sender?.tags || [];
  return `<form class="acc-tag-form" data-acc-tag-form="${escapeAttr(email)}">
    ${(accounts.data?.tagCatalog || []).map((tag) => `<label><input type="checkbox" name="tag" value="${escapeAttr(tag)}"${tags.includes(tag) ? " checked" : ""} /> ${escapeHtml(tag)}</label>`).join("")}
    <input name="custom" placeholder="Свій тег, напр. UK або Anna" maxlength="30" />
    <button type="submit" class="primary-button">Зберегти</button>
    <button type="button" class="text-button" data-acc-tags-cancel>Скасувати</button>
  </form>`;
}

export { tagPills as accountTagPills };

/** From another screen («Кампанії»): the warm-up page with the «Додати пошту» window open. */
export function openAddMailbox() {
  Object.assign(accounts, { dialog: true, dialogError: "", picked: "google" });
  document.querySelector('.nav-item[data-view="mail-warmup"]')?.click();
}

export function addButtonHtml() {
  return '<button type="button" class="primary-button" data-acc-add><i data-lucide="plus"></i><span>Додати пошту</span></button>';
}

export function accountsNoticeHtml() {
  return [
    accounts.notice ? `<p class="esp-notice ${accounts.tone}">${escapeHtml(accounts.notice)}</p>` : "",
    accounts.error ? `<p class="esp-notice is-bad">${escapeHtml(accounts.error)}</p>` : ""
  ].join("");
}

// ── the «Додати пошту» window ──────────────────────────────────────────

function setupHtml(data) {
  if (!data.canManage) return '<p class="acc-muted">Вхід через Google ще не налаштовано на сервері — це робить адміністратор один раз. Кнопка запрацює одразу після цього.</p>';
  return `<details class="acc-setup">
    <summary>Вхід через Google ще не налаштовано — що зробити один раз</summary>
    <ol>
      <li><b>console.cloud.google.com</b> → «APIs &amp; Services» → «Library» → увімкнути <b>Gmail API</b>.</li>
      <li>«OAuth consent screen» → тип <b>Internal</b> → назва й пошта підтримки → зберегти.</li>
      <li>«Credentials» → «OAuth client ID» → <b>Web application</b> → у «Authorized redirect URIs»:
        <code>${escapeHtml(data.redirectUri || "—")}</code></li>
      <li>Client ID і Client secret — у чат розробки: їх покладуть у сервер (<code>ESP_GOOGLE_OAUTH_CLIENT_ID</code>, <code>ESP_GOOGLE_OAUTH_CLIENT_SECRET</code>).</li>
    </ol>
  </details>`;
}

// Google's own four-colour «G», for the provider card and the sign-in button.
const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

export function addDialogHtml() {
  const data = accounts.data || {};
  const open = accounts.picked === "google";
  const google = !data.configured ? setupHtml(data) : `
    <button type="button" class="acc-google-signin" data-acc-google ${accounts.busy === "start" ? "disabled" : ""}>
      <span class="acc-google-g">${GOOGLE_G}</span>
      <span>${accounts.busy === "start" ? "Відкриваю Google…" : "Увійти через Google"}</span>
    </button>
    <ul class="acc-google-steps">
      <li><i data-lucide="mouse-pointer-click"></i>оберіть пошту у вікні Google</li>
      <li><i data-lucide="check-check"></i>дозвольте всі пункти — надсилання, відповіді, мітки для прогріву</li>
      <li><i data-lucide="shield-check"></i>пароль платформа не бачить</li>
    </ul>`;
  return `<dialog class="acc-dialog" id="mailAccountsDialog">
    <form method="dialog" class="acc-dialog-head">
      <div>
        <h2>Додати пошту</h2>
        <p class="acc-muted">Де живе пошта?</p>
      </div>
      <button class="icon-button" value="close" aria-label="Закрити"><i data-lucide="x"></i></button>
    </form>
    <div class="acc-providers">
      <div class="acc-provider-wrap ${open ? "is-open" : ""}">
        <button type="button" class="acc-provider is-main" data-acc-pick="google" aria-expanded="${open}">
          <span class="acc-provider-logo is-google">${GOOGLE_G}</span>
          <span class="acc-provider-text"><b>Google</b><span>Gmail / Google Workspace</span></span>
          <i data-lucide="chevron-down" class="acc-provider-chevron"></i>
        </button>
        ${open ? `<div class="acc-provider-body">${google}${accounts.dialogError ? `<p class="esp-notice is-bad">${escapeHtml(accounts.dialogError)}</p>` : ""}</div>` : ""}
      </div>
      <button type="button" class="acc-provider is-later" disabled>
        <span class="acc-provider-logo"><i data-lucide="key-round"></i></span>
        <span class="acc-provider-text"><b>Інша пошта</b><span>SMTP / IMAP — Zoho, хостинг, особистий Gmail</span></span>
        <span class="acc-soon">скоро</span>
      </button>
      <button type="button" class="acc-provider is-later" disabled>
        <span class="acc-provider-logo"><i data-lucide="building-2"></i></span>
        <span class="acc-provider-text"><b>Microsoft</b><span>Outlook / Microsoft 365</span></span>
        <span class="acc-soon">скоро</span>
      </button>
    </div>
  </dialog>`;
}

/** After the page redrew: the window stays open if it was. */
export function afterAccountsRender(wasOpen) {
  if (wasOpen || accounts.dialog) document.getElementById("mailAccountsDialog")?.showModal?.();
}

// ── actions ────────────────────────────────────────────────────────────────

async function startGoogle(mailbox = "") {
  accounts.busy = "start";
  accounts.dialogError = "";
  rerender();
  try {
    const answer = await api("/api/esp/oauth/google/start", { method: "POST", body: JSON.stringify({ mailbox }) });
    window.location.assign(answer.url);
  } catch (error) {
    Object.assign(accounts, { busy: "", dialogError: error.message || "Не вдалося почати вхід.", dialog: true, picked: "google" });
    rerender();
  }
}

async function check(mailbox) {
  accounts.busy = mailbox;
  rerender();
  try {
    const answer = await api("/api/esp/oauth/google/check", { method: "POST", body: JSON.stringify({ mailbox }) });
    accounts.checks[mailbox] = answer;
    if (answer.mailboxes) accounts.data.mailboxes = answer.mailboxes;
  } catch (error) {
    accounts.checks[mailbox] = { ok: false, error: error.message };
  }
  accounts.busy = "";
  rerender();
}

async function drop(mailbox, reload) {
  if (!window.confirm(`Відключити ${mailbox}? Листи з неї перестануть іти, прогрів зупиниться, дозвіл у Google буде відкликано. Додати знову можна кнопкою «Додати пошту».`)) return;
  try {
    await api("/api/esp/oauth/google/disconnect", { method: "POST", body: JSON.stringify({ mailbox }) });
    Object.assign(accounts, { notice: `Пошту ${mailbox} відключено.`, tone: "" });
  } catch (error) {
    Object.assign(accounts, { notice: error.message || "Не вдалося відключити.", tone: "is-bad" });
  }
  await reload();
}

async function saveTags(form, reload) {
  const email = form.dataset.accTagForm;
  const values = new FormData(form);
  const tags = [...values.getAll("tag"), ...String(values.get("custom") || "").split(",")].map((tag) => tag.trim()).filter(Boolean);
  try {
    await api("/api/esp/senders/tags", { method: "POST", body: JSON.stringify({ email, tags }) });
    Object.assign(accounts, { tagging: "", notice: `${email}: теги збережено.`, tone: "is-ok" });
  } catch (error) {
    Object.assign(accounts, { notice: error.message || "Теги не збереглися.", tone: "is-bad" });
  }
  await reload();
}

/**
 * The clicks and forms of all this inside `root` (the warm-up page). `reload`
 * reads the page again after a change that moves rows.
 */
export function bindAccounts(root, reload) {
  if (!root) return;
  root.addEventListener("click", (event) => {
    const tagging = event.target.closest("[data-acc-tags], [data-acc-tags-cancel]");
    if (tagging) {
      accounts.tagging = tagging.dataset.accTags && accounts.tagging !== tagging.dataset.accTags ? tagging.dataset.accTags : "";
      return rerender();
    }
    const target = event.target.closest("[data-acc-add], [data-acc-check], [data-acc-drop], [data-acc-signin], [data-acc-pick], [data-acc-google]");
    if (!target) return;
    if (target.dataset.accPick) {
      accounts.picked = accounts.picked === target.dataset.accPick ? "" : target.dataset.accPick;
      accounts.dialogError = "";
      return rerender();
    }
    if (target.hasAttribute("data-acc-google")) return void startGoogle();
    if (target.hasAttribute("data-acc-add")) {
      Object.assign(accounts, { dialog: true, dialogError: "", picked: "" });
      return rerender();
    }
    if (target.dataset.accCheck) return void check(target.dataset.accCheck);
    if (target.dataset.accDrop) return void drop(target.dataset.accDrop, reload);
    if (target.dataset.accSignin) return void startGoogle(target.dataset.accSignin);
  });
  root.addEventListener("submit", (event) => {
    const form = event.target.closest?.("[data-acc-tag-form]");
    if (!form) return;
    event.preventDefault();
    void saveTags(form, reload);
  });
  document.addEventListener("close", (event) => {
    if (event.target?.id === "mailAccountsDialog") accounts.dialog = false;
  }, true);
}
