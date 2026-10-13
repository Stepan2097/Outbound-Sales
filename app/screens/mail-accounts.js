// Пошта → «Скриньки» (власник 13.10: «там має бути тільки додавання пошт і
// список доданих»). Як «Email accounts» в Instantly: угорі — скільки скриньок,
// пошук і «Додати скриньку»; нижче — список. «Додати скриньку» відкриває вікно
// вибору способу; «Увійти через Google» веде у вікно Google, звідки людина
// повертається сюди ж. Пароля платформа не бачить: Google віддає дозвіл на одну
// скриньку, сервер тримає його зашифрованим (esp/google-oauth.mjs, маршрути —
// esp/mailbox-connect.mjs). Домени, доступи й ключ домену — у «Налаштуваннях».
//
// Повернення з Google — «#mail-settings/mailbox/ok/<скринька>» або
// «…/error/<що не так>»: плашка вгорі, адреса прибирається з рядка.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural } from "../core.js";

onScreen("mail-settings", { open: () => void openMailAccounts() });

const page = { data: null, error: "", loading: false, busy: "", notice: "", tone: "", checks: {}, query: "", dialog: false, dialogError: "" };

const rootEl = () => document.getElementById("mailAccountsRoot");
const when = (iso) => (iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "");

function readReturn() {
  const parts = window.location.hash.replace(/^#/, "").split("/");
  if (parts[0] !== "mail-settings" || parts[1] !== "mailbox") return;
  const value = decodeURIComponent(parts.slice(3).join("/") || "");
  if (parts[2] === "ok") Object.assign(page, { notice: `Скриньку ${value} додано. Ліміт починається з 5 листів на день і росте сам.`, tone: "is-ok" });
  if (parts[2] === "error") Object.assign(page, { notice: value || "Не вдалося додати скриньку.", tone: "is-bad" });
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#mail-settings`);
}

async function openMailAccounts() {
  readReturn();
  await load();
}

async function load() {
  page.loading = !page.data;
  render();
  try {
    page.data = await api("/api/esp/oauth/google");
    page.error = "";
  } catch (error) {
    page.error = error.message || "Не вдалося прочитати скриньки.";
  }
  page.loading = false;
  render();
}

// ── the list ───────────────────────────────────────────────────────────────

function stateOf(row) {
  if (row.status === "broken") return { tone: "is-bad", icon: "unplug", text: "доступ втрачено", hint: row.error || "" };
  if (row.status === "not_signed_in") {
    return page.data?.domainKey
      ? { tone: "is-ok", icon: "key-round", text: "через ключ домену", hint: "Працює через ключ адміністратора домену" }
      : { tone: "is-warn", icon: "log-in", text: "не підключено", hint: "Скринька є у відправниках, але не увійшла через Google — листи з неї не підуть" };
  }
  const sender = row.sender;
  if (sender && sender.effectiveStatus === "retired") return { tone: "is-muted", icon: "archive", text: "виведено", hint: "" };
  if (sender && sender.effectiveStatus !== "active") return { tone: "is-warn", icon: "pause", text: "на паузі", hint: "Причина й зняття паузи — «Налаштування» → «Пошта: домени й відправники»" };
  return { tone: "is-ok", icon: "check", text: "підключено", hint: "" };
}

function rowHtml(row) {
  const data = page.data;
  const state = stateOf(row);
  const check = page.checks[row.email];
  const mine = row.connectedBy === data.me;
  const canDrop = row.via === "google" && (mine || data.canManage);
  const initial = (row.name || row.email).trim().charAt(0).toUpperCase();
  let action = "";
  if (row.status === "broken" || (row.status === "not_signed_in" && !data.domainKey)) {
    action = `<button type="button" class="primary-button" data-acc-signin="${escapeAttr(row.email)}" ${data.configured ? "" : "disabled title=\"Вхід через Google ще не налаштовано\""}><i data-lucide="log-in"></i><span>${row.status === "broken" ? "Увійти знову" : "Увійти через Google"}</span></button>`;
  } else if (row.via === "google") {
    action = `<button type="button" data-acc-check="${escapeAttr(row.email)}" ${page.busy === row.email ? "disabled" : ""}><i data-lucide="mail-check"></i><span>${page.busy === row.email ? "Перевіряю…" : "Перевірити"}</span></button>`;
  }
  const notes = [
    row.status === "broken" && row.error ? `<small class="is-bad">${escapeHtml(row.error)}</small>` : "",
    check ? `<small class="${check.ok ? "is-ok" : "is-bad"}">${escapeHtml(check.ok ? `Доступ є${check.messagesTotal ? ` · листів у скриньці: ${check.messagesTotal}` : ""}` : check.error || "Google відмовив.")}</small>` : "",
    row.via === "google" && row.status !== "broken" && !row.canModify ? '<small>без дозволу на мітки — прогрів не виймає листи зі спаму; «Увійти знову» й дозвольте все</small>' : ""
  ].join("");
  return `<li class="acc-row">
    <span class="acc-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
    <div class="acc-who">
      <b>${escapeHtml(row.email)}</b>
      <span>${escapeHtml([row.name, row.via === "google" ? "Google" : ""].filter(Boolean).join(" · ") || "—")}</span>
      ${notes}
    </div>
    <span class="acc-state ${state.tone}" title="${escapeAttr(state.hint)}"><i data-lucide="${state.icon}"></i>${escapeHtml(state.text)}</span>
    <span class="acc-limit">${row.sender ? `<b>${row.sender.rampStage}</b> / день` : "—"}</span>
    <span class="acc-by">${escapeHtml(row.connectedBy ? (row.connectedBy === data.me ? "ви" : row.connectedBy) : "—")}<small>${escapeHtml(when(row.connectedAt))}</small></span>
    <span class="acc-actions">
      ${action}
      ${canDrop ? `<button type="button" class="icon-button" data-acc-drop="${escapeAttr(row.email)}" title="Відключити" aria-label="Відключити ${escapeAttr(row.email)}"><i data-lucide="trash-2"></i></button>` : ""}
    </span>
  </li>`;
}

function listHtml() {
  const rows = (page.data?.mailboxes || []).filter((row) => !page.query || `${row.email} ${row.name}`.toLowerCase().includes(page.query.toLowerCase()));
  if (!(page.data?.mailboxes || []).length) {
    return `<div class="acc-empty">
      <i data-lucide="mail-plus"></i>
      <h3>Ще жодної скриньки</h3>
      <p>Додайте скриньку, з якої підуть холодні листи: вхід через Google — і вона тут.</p>
      <button type="button" class="primary-button" data-acc-add><i data-lucide="plus"></i><span>Додати скриньку</span></button>
    </div>`;
  }
  if (!rows.length) return '<p class="acc-muted">За цим пошуком скриньок немає.</p>';
  return `<div class="acc-list">
    <div class="acc-head" aria-hidden="true"><span></span><span>Скринька</span><span>Стан</span><span>Ліміт</span><span>Додав</span><span></span></div>
    <ul>${rows.map(rowHtml).join("")}</ul>
  </div>`;
}

// ── the «Додати скриньку» window ──────────────────────────────────────────

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

function dialogHtml() {
  const data = page.data || {};
  return `<dialog class="acc-dialog" id="mailAccountsDialog">
    <form method="dialog" class="acc-dialog-head">
      <h2>Додати скриньку</h2>
      <button class="icon-button" value="close" aria-label="Закрити"><i data-lucide="x"></i></button>
    </form>
    <p class="acc-muted">Оберіть, де живе скринька.</p>
    <div class="acc-providers">
      <div class="acc-provider is-main">
        <span class="acc-provider-logo is-google" aria-hidden="true">G</span>
        <div>
          <b>Google</b>
          <span>Gmail / Google Workspace</span>
        </div>
        <span class="pill tone-live">рекомендовано</span>
      </div>
      ${data.configured ? `<form class="acc-google" data-acc-form="google">
        <input type="email" name="mailbox" placeholder="скринька@домен.com — необов'язково" autocomplete="off" aria-label="Яку скриньку додати" />
        <button type="submit" class="primary-button" ${page.busy === "start" ? "disabled" : ""}><i data-lucide="log-in"></i><span>${page.busy === "start" ? "Відкриваю Google…" : "Увійти через Google"}</span></button>
      </form>
      <p class="acc-muted">У вікні Google оберіть скриньку й дозвольте всі пункти: надсилання, читання відповідей і мітки (для прогріву). Пароль платформа не бачить.</p>` : setupHtml(data)}
      ${page.dialogError ? `<p class="esp-notice is-bad">${escapeHtml(page.dialogError)}</p>` : ""}
      <div class="acc-provider is-later">
        <span class="acc-provider-logo" aria-hidden="true"><i data-lucide="key-round"></i></span>
        <div><b>Інша пошта</b><span>SMTP/IMAP з паролем застосунку: особистий Gmail, Zoho, хостинг</span></div>
        <span class="pill tone-muted">скоро</span>
      </div>
      <div class="acc-provider is-later">
        <span class="acc-provider-logo is-microsoft" aria-hidden="true"><i data-lucide="building-2"></i></span>
        <div><b>Microsoft</b><span>Outlook / Microsoft 365</span></div>
        <span class="pill tone-muted">скоро</span>
      </div>
    </div>
  </dialog>`;
}

function render() {
  const root = rootEl();
  if (!root) return;
  const wasOpen = document.getElementById("mailAccountsDialog")?.open;
  const typing = document.activeElement?.id === "mailAccountsSearch";
  const count = page.data?.mailboxes?.length || 0;
  root.innerHTML = `
    <header class="acc-bar">
      <div>
        <h2>${count ? `${count} ${uaPlural(count, "скринька", "скриньки", "скриньок")}` : "Скриньок ще немає"}</h2>
        <p>З них ідуть холодні листи й прогрів.</p>
      </div>
      ${count ? `<label class="acc-search"><i data-lucide="search"></i><input id="mailAccountsSearch" type="search" placeholder="Пошук скриньки" value="${escapeAttr(page.query)}" autocomplete="off" /></label>` : ""}
      <button type="button" class="primary-button" data-acc-add><i data-lucide="plus"></i><span>Додати скриньку</span></button>
    </header>
    ${page.notice ? `<p class="esp-notice ${page.tone}">${escapeHtml(page.notice)}</p>` : ""}
    ${page.data && !page.data.liveSend ? '<p class="acc-muted acc-lock"><i data-lucide="lock"></i> Справжня відправка на сервері поки вимкнена: скриньки можна додавати й перевіряти, листи підуть, щойно її ввімкнуть.</p>' : ""}
    ${page.error ? `<p class="esp-notice is-bad">${escapeHtml(page.error)}</p>` : page.loading ? '<p class="acc-muted">Читаю скриньки…</p>' : page.data ? listHtml() : ""}
    ${dialogHtml()}`;
  refreshIcons(root);
  if (wasOpen || page.dialog) document.getElementById("mailAccountsDialog")?.showModal?.();
  if (typing) {
    const input = document.getElementById("mailAccountsSearch");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

// ── actions ────────────────────────────────────────────────────────────────

async function startGoogle(mailbox = "") {
  page.busy = "start";
  page.dialogError = "";
  render();
  try {
    const answer = await api("/api/esp/oauth/google/start", { method: "POST", body: JSON.stringify({ mailbox }) });
    window.location.assign(answer.url);
  } catch (error) {
    Object.assign(page, { busy: "", dialogError: error.message || "Не вдалося почати вхід.", dialog: true });
    render();
  }
}

async function check(mailbox) {
  page.busy = mailbox;
  render();
  try {
    const answer = await api("/api/esp/oauth/google/check", { method: "POST", body: JSON.stringify({ mailbox }) });
    page.checks[mailbox] = answer;
    if (answer.mailboxes) page.data.mailboxes = answer.mailboxes;
  } catch (error) {
    page.checks[mailbox] = { ok: false, error: error.message };
  }
  page.busy = "";
  render();
}

async function drop(mailbox) {
  if (!window.confirm(`Відключити ${mailbox}? Листи з неї перестануть іти, дозвіл у Google буде відкликано. Додати знову можна тією ж кнопкою.`)) return;
  try {
    const answer = await api("/api/esp/oauth/google/disconnect", { method: "POST", body: JSON.stringify({ mailbox }) });
    page.data.mailboxes = answer.mailboxes || [];
    Object.assign(page, { notice: `Скриньку ${mailbox} відключено.`, tone: "" });
    // The list still holds it as a sender; read it again so its row says so.
    await load();
    return;
  } catch (error) {
    Object.assign(page, { notice: error.message || "Не вдалося відключити.", tone: "is-bad" });
  }
  render();
}

document.addEventListener("click", (event) => {
  const root = rootEl();
  if (!root || !root.contains(event.target)) return;
  const target = event.target.closest("[data-acc-add], [data-acc-check], [data-acc-drop], [data-acc-signin]");
  if (!target) return;
  if (target.hasAttribute("data-acc-add")) {
    page.dialog = true;
    page.dialogError = "";
    return document.getElementById("mailAccountsDialog")?.showModal?.();
  }
  if (target.dataset.accCheck) return void check(target.dataset.accCheck);
  if (target.dataset.accDrop) return void drop(target.dataset.accDrop);
  if (target.dataset.accSignin) return void startGoogle(target.dataset.accSignin);
});

document.addEventListener("close", (event) => {
  if (event.target?.id === "mailAccountsDialog") page.dialog = false;
}, true);

document.addEventListener("input", (event) => {
  if (event.target?.id !== "mailAccountsSearch") return;
  page.query = event.target.value;
  render();
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest?.('[data-acc-form="google"]');
  if (!form || !rootEl()?.contains(form)) return;
  event.preventDefault();
  void startGoogle(String(new FormData(form).get("mailbox") || "").trim());
});
