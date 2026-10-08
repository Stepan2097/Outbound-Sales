// The warm-up screens' pure decisions live in their own module so node can
// test them; this file reads `window` as it loads and only a browser runs it.
import {
  autoFeedFor, autoFeedLine, campaignFeedStart, campaignStateNote, inviteAttentionText, inviteCancelQuestion,
  queueAfterFailedClaim, queueAnswerIsCurrent
} from "./warmup-view.js";

let state = null;
let busyAction = "";
let busyMessage = "";
let uiNotice = "";
let authState = null;
let authMode = "login";
// Контакти CRM. Папка на двадцять дві тисячі людей не їздить у /api/state, тож
// сторінка тримає свою сторінку списку, вибрану людину і написані їй чернетки.
let contactFolders = [];
let contactFoldersLoaded = false;
let contactFolderId = null;
let crmContactRows = [];
let contactTotal = 0;
let contactOffset = 0;
let contactSearch = "";
let selectedContactId = null;
let contactRecord = null;
let contactDrafts = null;
let contactProspectId = null;
// Та сама стрічка, що й «Історія» на Панелі: запит, наші повідомлення і
// відповіді. Читається з прогріву окремо від картки, бо картка — з CRM, і одна
// не має чекати на другу.
let contactHistory = null;
let contactHistoryFor = "";
let contactHistoryNotice = "";
let contactsLoading = false;
let contactsError = "";
// Вкладка «Користувачі» живе нижче по файлу, а `await bootApplication()` ділить
// модуль надвоє: усе, оголошене після нього, під час завантаження ще в TDZ.
// Тому ці змінні стоять тут — інакше перезавантаження на цій вкладці валить
// увесь застосунок, а не лише її.
let profileData = null;
let profileTabId = null;
// Чию картку зараз відкрито. Порожньо — свою власну.
let profileUserId = "";
let teamDirectory = null;

const views = [...document.querySelectorAll(".view")];
const navItems = [...document.querySelectorAll(".nav-item")];

/**
 * Українська множина: 1 контакт, 2 контакти, 5 контактів. Англійський оригінал
 * обходився одним "s", тут без трьох форм виходить безграмотно.
 */
const uaPlural = (count, one, few, many) => {
  const number = Math.abs(Math.trunc(Number(count) || 0));
  const mod10 = number % 10;
  const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== "/api/auth/status" && !path.startsWith("/api/auth/")) {
      authState = { authenticated: false, bootstrapRequired: Boolean(body.bootstrapRequired) };
      showAuthGate();
    }
    const failure = new Error(body.error || `Request failed with ${response.status}`);
    failure.status = response.status;
    failure.payload = body;
    throw failure;
  }
  return response.json();
}

async function refresh() {
  state = await api("/api/state");
  render();
}

function render() {
  renderTopbar();
  renderAccount();
  renderSidebarUser();
  refreshIcons();
}

function renderTopbar() {
  // Цей рядок під заголовком — місце для того, що зараз відбувається: прогрес
  // довгої дії або підсумок останньої. Коли не відбувається нічого, він зникає
  // замість того, щоб показувати лічильники, які й так видно на своїх екранах.
  const meta = document.getElementById("workspaceMeta");
  const line = busyMessage || uiNotice || "";
  meta.textContent = line;
  meta.hidden = !line;
}

async function bootApplication() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  if (hash.get("type") === "recovery" && hash.get("access_token")) {
    authMode = "reset";
    window.sessionStorage.setItem("outboundRecoveryToken", hash.get("access_token"));
  }
  authState = await api("/api/auth/status");
  if (!authState.authenticated) {
    if (authState.bootstrapRequired) authMode = "bootstrap";
    showAuthGate();
    return;
  }
  await enterWorkspace();
}

function showAuthGate() {
  document.getElementById("authGate").hidden = false;
  document.getElementById("appShell").hidden = true;
  renderAuthForm();
  refreshIcons();
}

async function enterWorkspace() {
  document.getElementById("authGate").hidden = true;
  document.getElementById("appShell").hidden = false;
  authState = await api("/api/auth/status");
  await refresh();
  startActivityHeartbeat();
  const saved = rememberedView();
  setView(saved || "warmup");
}

function renderAuthForm() {
  const bootstrap = authMode === "bootstrap";
  const recover = authMode === "recover";
  const reset = authMode === "reset";
  // Реєстрація просить те саме, що й створення власника, але дає інше: акаунт,
  // а не доступ. Пускає підтвердження в CRM, і форма каже це до того, як
  // людина натисне, а не після.
  const register = authMode === "register";
  const named = bootstrap || register;
  setText("authEyebrow", bootstrap ? "Створення власника робочого простору" : register ? "Новий акаунт" : recover || reset ? "Відновлення доступу" : "Захищений робочий простір");
  setText("authTitle", bootstrap ? "Налаштувати Outbound OS" : register ? "Реєстрація" : recover ? "Відновити пароль" : reset ? "Вибери новий пароль" : "Вхід");
  setText("authDescription", bootstrap
    ? "Створи перший адміністраторський акаунт для своєї команди."
    : register
      ? "Створи робочий акаунт. Вхід відкриється, коли акаунт підтвердять — якщо його вже підтверджено, ти зайдеш одразу."
      : recover ? "Запитаємо в Supabase захищене посилання для скидання пароля."
        : reset ? "Задай новий пароль для свого акаунта." : "Заходь робочим акаунтом компанії.");
  document.querySelector(".auth-name-field").hidden = !named;
  document.querySelector(".auth-email-field").hidden = reset;
  document.querySelector(".auth-password-field").hidden = recover;
  document.querySelector(".auth-confirm-field").hidden = !named && !reset;
  document.getElementById("authEmailInput").required = !reset;
  document.getElementById("authPasswordInput").required = !recover;
  document.getElementById("authConfirmInput").required = named || reset;
  document.getElementById("authNameInput").required = bootstrap;
  document.getElementById("authPasswordInput").autocomplete = named || reset ? "new-password" : "current-password";
  setText("authSubmitBtn", "");
  document.getElementById("authSubmitBtn").innerHTML = `<i data-lucide="${recover ? "mail" : reset ? "key-round" : bootstrap ? "shield-check" : register ? "user-plus" : "log-in"}"></i><span>${recover ? "Надіслати посилання" : reset ? "Зберегти новий пароль" : bootstrap ? "Створити робочий простір" : register ? "Створити акаунт" : "Увійти"}</span>`;
  const modeButton = document.getElementById("authModeBtn");
  modeButton.hidden = bootstrap || reset;
  modeButton.textContent = recover || register ? "Назад до входу" : "Забув пароль?";
  // Під час створення власника реєстрація не пропонується: перший акаунт має
  // бути адміністраторським, і другий вхід у ту саму мить лише заплутав би.
  const registerButton = document.getElementById("authRegisterBtn");
  registerButton.hidden = bootstrap || reset || register || recover;
}

function renderAccount() {
  const user = authState?.user;
  if (!user) return;
  document.getElementById("teamCreatePanel").hidden = user.role !== "admin";
}

/**
 * Хто зараз у застосунку — внизу сайдбара, там, де раніше стояв технічний
 * статус провайдера («mock_ready»). Продавцеві потрібні дві речі: пересвідчитись,
 * що він під своїм акаунтом, і вийти; стан AI-провайдера має свій екран.
 */
function renderSidebarUser() {
  const user = authState?.user;
  // Пошта, а не ім'я: під чиїм акаунтом ти сидиш — питання про адресу, і саме
  // її людина звіряє. Ім'я і роль стоять у title, бо місця тут на два рядки.
  setText("sidebarUserEmail", user?.email || user?.name || "Не увійдено");
  const button = document.getElementById("sidebarUserBtn");
  // Пошта в сайдбарі обрізається — місця там на сто тридцять пікселів, — тож
  // ціла вона тут, під курсором, разом із роллю.
  if (button) {
    button.title = user
      ? `${[user.name, user.email].filter(Boolean).join(" · ")}${user.role === "admin" ? " · адміністратор" : " · продавець"} — відкрити свою картку`
      : "Відкрити свою картку";
  }
  const logout = document.getElementById("sidebarLogoutBtn");
  if (logout) logout.hidden = !user;
}

/**
 * База користувачів одна — та, що в CRM.
 *
 * Цей застосунок нікого не запрошує: хто є в CRM і підтверджений там, той
 * входить своїм акаунтом CRM. Картка тут — це запис (обрана модель, витрати,
 * час), а не пропуск. Єдине, що ставиться в цьому списку, — роль у цьому
 * застосунку; кого пускати, відповідає CRM.
 *
 * Список — вхід у картку: рядок відкриває людину нижче, і саме там для неї
 * вибирається модель. Кожному свою, бо витрати теж рахуються кожному свої.
 */
const ROLE_LABEL = { admin: "Адміністратор", seller: "Продавець" };

/**
 * Ім'я, тільки якщо воно ім'я. Уламок адреси ним не є: «pavlo.work.101» над
 * «pavlo.work.101@gmail.com» — це одна адреса, написана двічі. А «Stepan» на
 * stepan@… — ім'я, яке просто збіглося з адресою, і воно лишається.
 */
function personDisplayName(name, email) {
  const clean = String(name || "").trim().toLowerCase();
  const address = String(email || "").trim().toLowerCase();
  const local = address.split("@")[0];
  if (!clean || clean === address) return "";
  if (clean === local && /[._\-\d]/.test(local)) return "";
  return String(name).trim();
}

function teamRowHtml(person, selfEmail, { canSetRole = false } = {}) {
  const self = person.email === selfEmail;
  const name = personDisplayName(person.name, person.email);
  const facts = [
    person.blocked,
    (person.aliases || []).length ? `та сама скринька, що ${person.aliases.join(", ")}` : "",
    person.crmRole ? `у CRM ${person.crmRole}` : "",
    person.signedInHere ? "" : "тут ще не заходив",
    // `warmupAgo` поїхала разом із блоком прогріву в d210867, а цей рядок її
    // кликати не перестав — відтоді вкладка «Користувачі» не могла показати
    // команду взагалі, бо весь список падав на першому ж рядку. Та сама
    // відповідь уже є в `relativeTime`, і вона не належить прогріву.
    person.lastSignInAt ? `вхід ${relativeTime(person.lastSignInAt)}` : "жодного входу"
  ].filter(Boolean).join(" · ");
  const options = ["admin", "seller"].map((value) =>
    `<option value="${value}"${value === person.role ? " selected" : ""}>${ROLE_LABEL[value]}</option>`
  ).join("");
  const open = String(person.id || "") === String(profileUserId || "");
  // Дві цифри, заради яких на цей список і дивляться: скільки людина витратила
  // і скільки тут пробула. Обидві за ті самі 30 днів, що й графіки в картці.
  const stats = `<div class="team-stats">
      <span class="team-stat${person.costUsd > 0 ? " has-value" : ""}">
        <strong>${escapeHtml(formatMoney(person.costUsd))}</strong>
        <small>${person.requests ? `${person.requests} ${uaPlural(person.requests, "запит", "запити", "запитів")}` : "без запитів"}</small>
      </span>
      <span class="team-stat${person.seconds > 0 ? " has-value" : ""}">
        <strong>${escapeHtml(formatSeconds(person.seconds))}</strong>
        <small>${person.activeDays ? `${person.activeDays} ${uaPlural(person.activeDays, "день", "дні", "днів")}` : "не заходив"}</small>
      </span>
    </div>`;
  return `<article class="team-row${person.blocked ? " team-row-outside" : ""}${open ? " team-row-open" : ""}" data-team-user="${escapeAttr(person.id || "")}" tabindex="0" role="button" aria-pressed="${open ? "true" : "false"}">
    <div class="team-who">
      <strong>${escapeHtml(name || person.email)}${self ? " · це ти" : ""}</strong>
      ${name ? `<span>${escapeHtml(person.email)}</span>` : ""}
      ${facts ? `<span>${escapeHtml(facts)}</span>` : ""}
    </div>
    ${stats}
    <span class="team-model">${person.modelLabel ? escapeHtml(person.modelLabel) : "модель робочого простору"}</span>
    ${canSetRole
      ? `<select class="team-access" data-email="${escapeAttr(person.email)}"${self ? " disabled title=\"Свою роль змінює інший адміністратор\"" : ""}>${options}</select>`
      : `<span class="team-model">${escapeHtml(ROLE_LABEL[person.role] || person.role || "")}</span>`}
    ${canSetRole && !self
      ? `<button class="icon-button danger-button" type="button" data-remove-user="${escapeAttr(person.id || "")}" data-remove-email="${escapeAttr(person.email)}" title="Прибрати акаунт назовсім" aria-label="Прибрати акаунт ${escapeAttr(person.email)}"><i data-lucide="trash-2"></i></button>`
      : ""}
  </article>`;
}

/**
 * Адміністратор бачить усю базу CRM; продавець — себе, бо чужі витрати не його
 * справа, а вкладка без жодного рядка була б порожньою сторінкою замість
 * власної картки.
 */
async function loadTeamDirectory() {
  const user = authState?.user;
  if (!user) return;
  const selfEmail = String(user.email || "").toLowerCase();
  const showSelfOnly = (note) => {
    setHtml("teamUserList", teamRowHtml(selfDirectoryRow(user), selfEmail));
    setText("teamUserNote", note);
  };
  if (user.role !== "admin") {
    showSelfOnly("Своя картка: обрана модель, витрачені кредити і час у застосунку.");
    return;
  }
  try {
    teamDirectory = await api("/api/account/directory");
    // Усі, одним списком. Ті, кого CRM не пускає, стоять у кінці й підписані
    // чому — але вони тут: список користувачів, який когось не показує, змушує
    // шукати зниклих деінде.
    setHtml("teamUserList", teamDirectory.people
      .map((person) => teamRowHtml(person, selfEmail, { canSetRole: true }))
      .join(""));
    const total = teamDirectory.people.length;
    const blocked = total - teamDirectory.canSignIn;
    setText("teamUserNote", [
      `${total} ${uaPlural(total, "користувач", "користувачі", "користувачів")}`,
      blocked ? `${teamDirectory.canSignIn} ${uaPlural(teamDirectory.canSignIn, "може", "можуть", "можуть")} увійти, решту тримає CRM` : "усі можуть увійти",
      `кредити і час — за ${teamDirectory.days || 30} днів`,
      teamDirectory.adminApi ? "" : "список із бази CRM: акаунтів Supabase без профілю в CRM тут не видно (потрібен сервісний ключ)"
    ].filter(Boolean).join(" · "));
  } catch (error) {
    // Список приходить із Supabase, і без нього тут була б порожня вкладка. Своя
    // картка є завжди — вона лежить у цьому ж застосунку.
    teamDirectory = null;
    showSelfOnly(`Список команди зараз недоступний: ${error.message}`);
  }
  refreshIcons();
}

function selfDirectoryRow(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    modelLabel: profileData?.user?.id === user.id ? modelChoiceLabelFromView(profileData) : "",
    signedInHere: true,
    blocked: "",
    crmRole: "",
    lastSignInAt: user.lastLoginAt || null
  };
}

/** Підпис моделі з уже завантаженої картки — для рядка самого себе. */
function modelChoiceLabelFromView(view) {
  const chosen = view?.model?.modelId || "";
  if (!chosen) return "";
  return view.model.options?.find((option) => option.id === chosen)?.label || chosen;
}

document.getElementById("teamUserList")?.addEventListener("click", (event) => {
  if (event.target.closest("select")) return;
  // Єдина незворотна кнопка в цьому списку, тож вона питає — і питає адресою,
  // а не «ви впевнені?»: підтверджувати треба те, що саме зникне.
  const remove = event.target.closest("[data-remove-user]");
  if (remove) {
    event.stopPropagation();
    const email = remove.dataset.removeEmail || "цей акаунт";
    if (!window.confirm(`Прибрати акаунт ${email} назовсім? Це не відкотити.`)) return;
    void removeTeamUser(remove);
    return;
  }
  const row = event.target.closest("[data-team-user]");
  if (!row) return;
  void loadProfileFor(row.dataset.teamUser);
});

async function removeTeamUser(button) {
  button.disabled = true;
  try {
    const result = await api("/api/account/users/remove", {
      method: "POST",
      body: JSON.stringify({ userId: button.dataset.removeUser, email: button.dataset.removeEmail })
    });
    // Рядок у CRM цей застосунок не чіпає: то чужа система обліку. Якщо він
    // лишився — про це сказано прямо, бо піввидалення, про яке мовчать, потім
    // виглядає як «воно не спрацювало».
    setText("teamUserNote", result.crmProfileRemains
      ? `Акаунт ${result.email || ""} прибрано. Рядок у CRM лишився — прибери його там, якщо він більше не потрібен.`
      : `Акаунт ${result.email || ""} прибрано.`);
    await loadTeamDirectory();
  } catch (error) {
    setText("teamUserNote", error.message || "Не вдалося прибрати акаунт.");
    button.disabled = false;
  }
  refreshIcons();
}

document.getElementById("teamUserList")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("[data-team-user]");
  if (!row) return;
  event.preventDefault();
  void loadProfileFor(row.dataset.teamUser);
});

document.getElementById("teamUserList")?.addEventListener("change", async (event) => {
  const select = event.target.closest(".team-access");
  if (!select) return;
  select.disabled = true;
  try {
    await api("/api/account/role", {
      method: "POST",
      body: JSON.stringify({ email: select.dataset.email, role: select.value })
    });
  } catch (error) {
    setText("teamUserNote", error.message);
  }
  await loadTeamDirectory();
});

/* ── The note on a request ─────────────────────────────────────────────────
 *
 * The note is no longer pre-filled from the AI draft. That draft is written to
 * LinkedIn's 300-character limit, and the warm-up allows no note at all on days
 * 4–10 and at most three words, without a link, from day 11 on — so the
 * pre-filled text was exactly the note the plan forbids.
 *
 * The functions below mirror `noteWordCount`, `noteHasLink` and
 * `noteUnderRule` in warmup/strategy.mjs. The server decides, when it hands
 * the request to the agent, by the rule of the day it actually goes out; this
 * copy only lets the form say so while the note is typed. Change one, change
 * the other: tests/warmup-note-parity.test.mjs reads these functions out of
 * this file and runs both copies over the same cases, so a copy that drifts
 * fails there. Keep each one a top-level declaration ending in a `}` or `};`
 * at the start of a line — that is how the test finds it.
 */

const INVITE_NOTE_DROPPED = {
  notes_off: "у цій фазі прогріву записки не можна",
  too_many_words: "задовга для цієї фази",
  has_link: "у ній посилання"
};

/* ── Історія по людині ─────────────────────────────────────────────────────
 *
 * Питання, яке продавець ставить перед розмовою: що цій людині взагалі
 * писали — з будь-якого акаунта, будь-яким каналом, і що вона відповіла.
 * Тред — це одна розмова на одному акаунті; тут ключ інший, людина.
 */

const HISTORY_EVENT_LABEL = {
  "invite.requested": "Запит поставлено в чергу",
  "invite.sent": "Запит надіслано",
  "invite.cancelled": "Запит скасовано",
  "invite.reassigned": "Запит перекинуто на інший акаунт",
  "invite.failed": "Запит не вдалося надіслати",
  // The folder let the person go and will not offer them again; a seller can
  // still queue them by hand.
  "campaign.skipped": "Автопідбір більше не братиме цю людину"
};

function historyEntryHtml(entry) {
  const when = entry.at ? relativeTime(entry.at) : "";
  const exact = entry.at ? new Date(entry.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }) : "";

  if (entry.kind === "invite") {
    return `
      <li class="history-entry is-invite">
        <div class="history-when" title="${escapeAttr(exact)}">${escapeHtml(when)}</div>
        <div class="history-body">
          <strong>${escapeHtml(HISTORY_EVENT_LABEL[entry.event] || entry.event)}</strong>
          ${entry.meta?.source === "campaign" ? `<small class="is-muted">з папки${entry.meta.campaignName ? ` «${escapeHtml(entry.meta.campaignName)}»` : ""}</small>` : ""}
          ${entry.meta?.note ? `<pre>${escapeHtml(entry.meta.note)}</pre>` : ""}
          ${entry.meta?.by ? `<small class="is-muted">${entry.meta.by === "agent" ? "надіслав агент" : "надіслано вручну"}${entry.meta.overQuota ? " · понад денну норму" : ""}${entry.meta.duringPause ? " · під час паузи, у норму не зараховано" : ""}${entry.meta.noteDropped ? ` · без записки: ${escapeHtml(INVITE_NOTE_DROPPED[entry.meta.noteDropped] || entry.meta.noteDropped)}` : ""}</small>` : ""}
          ${entry.meta?.outcome ? `<small class="is-muted">${escapeHtml(entry.meta.outcome)}</small>` : ""}
        </div>
      </li>
    `;
  }

  const mine = entry.direction === "out";
  return `
    <li class="history-entry ${mine ? "is-out" : "is-in"}">
      <div class="history-when" title="${escapeAttr(exact)}">${escapeHtml(when)}</div>
      <div class="history-body">
        <strong>${mine ? "Ми написали" : "Прийшло у відповідь"}</strong>
        <pre>${escapeHtml(entry.body || "")}</pre>
        <small class="is-muted">${[
          entry.accountLabel ? `${mine ? "з" : "на"} ${escapeHtml(entry.accountLabel)}` : "",
          entry.truncated ? "обрізано" : "",
          entry.matchedBy === "name_or_slug" ? "збіг за імʼям" : ""
        ].filter(Boolean).join(" · ")}</small>
      </div>
    </li>
  `;
}

/* ── Опис клієнта і підходи ────────────────────────────────────────────────
 *
 * Те, заради чого натискають «Збагатити»: хто ця людина, що для неї зараз
 * важливо і з чого почати розмову. Усе інше на цій сторінці — джерела під це.
 */

function fillSelect(select, items, valueFn, labelFn, selectedValue) {
  select.innerHTML = items
    .map((item) => {
      const value = valueFn(item);
      return `<option value="${escapeAttr(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(labelFn(item))}</option>`;
    })
    .join("");
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setHtml(id, html) {
  const element = document.getElementById(id);
  if (element) element.innerHTML = html;
}

async function runUiAction(actionName, message, work) {
  if (busyAction) return;
  busyAction = actionName;
  busyMessage = message;
  uiNotice = "";
  renderTopbar();
  refreshIcons();
  try {
    await work();
    uiNotice = {
      "contact-drafts": "Чернетки готові. Перечитай їх перед відправкою — надсилає людина, не система."
    }[actionName] || "Готово.";
  } catch (error) {
    uiNotice = error?.message || "Не вдалося. Спробуй ще раз.";
  } finally {
    busyAction = "";
    busyMessage = "";
    render();
  }
}

const VIEW_MEMORY_KEY = "outboundActiveView";

/**
 * The tab survives a reload. Reopening on the dashboard threw away where
 * somebody was working, and the longer the tab takes to be useful — the warm-up
 * reloads two databases — the more that costs.
 *
 * Wrapped because storage throws in a private window and when site data is
 * blocked, and a workspace that cannot remember a tab must still open on one.
 */
function rememberView(viewName) {
  try { window.localStorage.setItem(VIEW_MEMORY_KEY, viewName); } catch {}
}

function rememberedView() {
  let saved = null;
  try { saved = window.localStorage.getItem(VIEW_MEMORY_KEY); } catch {}
  // Only a tab that still exists: a view removed in an update must not leave
  // somebody staring at a blank shell with no way back.
  return saved && document.getElementById(`view-${saved}`) ? saved : null;
}

function setView(viewName) {
  views.forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  document.getElementById("pageTitle").textContent =
    {
      warmup: "Прогрів LinkedIn",
      inbox: "Вхідні",
      contacts: "Контакти з CRM",
      account: "Налаштування"
    }[viewName] || "Outbound Sales OS";
  rememberView(viewName);

  // Loaded when the tab is opened rather than at boot: it talks to a different
  // database, and a workspace that never warms an account should not pay for it.
  if (viewName === "account") {
    loadProfileScreen();
  }

  if (viewName === "warmup") {
    loadWarmup();
  }

  if (viewName === "inbox") {
    loadWarmupInbox();
  }

  // Те саме для контактів: CRM опитується, коли на неї дивляться.
  if (viewName === "contacts") {
    void loadContactFolders().catch(() => {});
  }

}

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function linkIfUrl(value) {
  const text = String(value || "");
  if (/^https?:\/\//i.test(text)) {
    return `<a href="${escapeAttr(text)}" target="_blank" rel="noreferrer">${escapeHtml(shortUrl(text))}</a>`;
  }
  return escapeHtml(text);
}

function contactLinkedInLink(value) {
  const text = String(value || "").trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text.replace(/^\/\//, "")}`);
    if (!["http:", "https:"].includes(url.protocol) || !(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))) return "—";
    return `<a href="${escapeAttr(url.href)}" target="_blank" rel="noopener noreferrer">Відкрити LinkedIn</a>`;
  } catch { return "—"; }
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 64);
  } catch {
    return value;
  }
}

function relativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "невідомо";
  const diffMs = Date.now() - timestamp;
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return "щойно";
  if (minutes < 60) return `${minutes} хв тому`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} год тому`;
  return `${Math.round(hours / 24)} дн тому`;
}

navItems.forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

document.getElementById("authModeBtn").addEventListener("click", () => {
  // З входу веде до відновлення, звідусіль інде — назад до входу. Напис на
  // кнопці каже саме це, і раніше з реєстрації вона повела б у відновлення.
  authMode = authMode === "login" ? "recover" : "login";
  setText("authMessage", "");
  renderAuthForm();
  refreshIcons();
});

document.getElementById("authRegisterBtn").addEventListener("click", () => {
  authMode = "register";
  setText("authMessage", "");
  renderAuthForm();
  refreshIcons();
});

document.getElementById("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("authEmailInput").value;
  const password = document.getElementById("authPasswordInput").value;
  const confirmation = document.getElementById("authConfirmInput").value;
  try {
    if (["bootstrap", "register", "reset"].includes(authMode) && password !== confirmation) throw new Error("Паролі не збігаються.");
    if (authMode === "register") {
      const result = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ name: document.getElementById("authNameInput").value, email, password })
      });
      // Акаунт створено, доступу ще немає — це половина справи, а не збій.
      // Повертаємо на вхід, щоб людина не реєструвалася вдруге, і лишаємо
      // пояснення на екрані.
      if (result.pending) {
        authMode = "login";
        renderAuthForm();
        refreshIcons();
        setText("authMessage", result.message || "Акаунт створено. Вхід відкриється після підтвердження.");
        return;
      }
      authState = result.auth;
      await enterWorkspace();
      return;
    }
    if (authMode === "recover") {
      const result = await api("/api/auth/recover", { method: "POST", body: JSON.stringify({ email }) });
      setText("authMessage", result.message || "Посилання для скидання запитано.");
      return;
    }
    if (authMode === "reset") {
      await api("/api/auth/complete-recovery", { method: "POST", body: JSON.stringify({ accessToken: window.sessionStorage.getItem("outboundRecoveryToken"), password }) });
      window.sessionStorage.removeItem("outboundRecoveryToken");
      window.history.replaceState({}, "", window.location.pathname);
      authMode = "login";
      setText("authMessage", "Пароль змінено. Увійди з новим паролем.");
      renderAuthForm();
      return;
    }
    const endpoint = authMode === "bootstrap" ? "/api/auth/bootstrap" : "/api/auth/login";
    const result = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ name: document.getElementById("authNameInput").value, email, password })
    });
    authState = result.auth;
    await enterWorkspace();
  } catch (error) {
    setText("authMessage", error.message || "Не вдалося увійти.");
  }
});

document.getElementById("accountPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("accountPasswordInput").value;
  if (password !== document.getElementById("accountPasswordConfirmInput").value) {
    uiNotice = "Паролі не збігаються.";
    renderTopbar();
    return;
  }
  await api("/api/account/password", { method: "POST", body: JSON.stringify({ password }) });
  event.currentTarget.reset();
  uiNotice = "Пароль змінено.";
  renderTopbar();
});

document.getElementById("teamUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("/api/account/users", { method: "POST", body: JSON.stringify({ name: document.getElementById("teamUserNameInput").value, email: document.getElementById("teamUserEmailInput").value, password: document.getElementById("teamUserPasswordInput").value, role: document.getElementById("teamUserRoleInput").value }) });
  event.currentTarget.reset();
  authState = await api("/api/auth/status");
  uiNotice = result.existingAccount
    ? "Наявний робочий акаунт додано. Продавець заходить своїм поточним паролем або відновлює його."
    : "Акаунт продавця створено.";
  render();
});

async function signOut() {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  authState = { authenticated: false, bootstrapRequired: false };
  authMode = "login";
  showAuthGate();
}

document.getElementById("logoutBtn").addEventListener("click", signOut);
document.getElementById("sidebarLogoutBtn").addEventListener("click", signOut);

document.getElementById("sidebarUserBtn").addEventListener("click", () => {
  setView("account");
  loadProfileScreen();
});

/**
 * Чи може ключ цього середовища оновити рядок у wl_events.
 *
 * Від відповіді залежить, яким шляхом іти в дедуплікації історії: оновлювати
 * тимчасовий рядок на місці чи назавжди тримати два і ховати один при показі.
 * Перевірити можна лише там, де є ключі — тобто на розгорнутому сервері, — тож
 * це кнопка в застосунку, а не скрипт, який нікому не запустити.
 */
document.getElementById("warmupProbeBtn").addEventListener("click", async () => {
  const note = document.getElementById("warmupProbeNote");
  const button = document.getElementById("warmupProbeBtn");
  note.hidden = false;
  note.className = "warmup-probe-note";
  note.textContent = "Перевіряємо...";
  button.disabled = true;
  try {
    const { probe } = await warmupApi("/diagnostics/event-write", { method: "POST", body: "{}" });
    // A step that was never attempted is not a refusal. Painting `null` red
    // with "ні — без пояснення" destroyed the one distinction this probe was
    // rebuilt to make: no keys here, versus the key is not allowed to.
    const line = (label, step) => {
      if (!step) return `<li class="is-skipped">${escapeHtml(label)}: не пробували</li>`;
      return `<li class="${step.ok ? "is-ok" : "is-bad"}">${escapeHtml(label)}: ${step.ok ? "так" : `ні — ${escapeHtml(step.error || "без пояснення")}`}</li>`;
    };
    const verdict = {
      full: "Ключ уміє все три дії. Дедуплікацію історії можна робити оновленням рядка на місці.",
      no_update: "Ключ пише, але не оновлює. Дедуплікацію доведеться робити придушенням під час показу — два рядки лишаться в базі назавжди.",
      no_delete: "Ключ пише й оновлює, але не прибирає. Оновлення на місці доступне; тестовий рядок треба прибрати руками.",
      cannot_write: "Ключ не пише в wl_events узагалі. Це ламає не лише дедуплікацію, а й усю історію — розбирайся з цього.",
      not_configured: "У цьому середовищі немає ключів до бази Anty, тож питати нема в кого. Перевіряй там, де вони є."
    }[probe.verdict] || "Невідомий результат.";
    note.className = `warmup-probe-note ${probe.canUpdate ? "is-ok" : "is-bad"}`;
    note.innerHTML = `
      <strong>${escapeHtml(verdict)}</strong>
      <ul>${line("Запис", probe.insert)}${line("Оновлення", probe.update)}${line("Прибирання", probe.remove)}</ul>
      ${probe.probeId ? `<small>Тестовий рядок лишився в базі: <code>${escapeHtml(probe.probeId)}</code></small>` : ""}
    `;
  } catch (error) {
    note.className = "warmup-probe-note is-bad";
    note.textContent = error.message || "Перевірка не пройшла.";
  } finally {
    button.disabled = false;
    refreshIcons();
  }
});

/**
 * What gets taught. One box, because the server only ever saw one string: the
 * six structured fields were concatenated into this same text under headings,
 * and on edit they were filled with the product own derived positioning,
 * personas and proof — so saving fed the analysis its own output back as input.
 */

/** The text this product was taught from, which is the only thing to edit. */

function setFormValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value || "";
}

/**
 * Контакти: папки CRM, людина в них, і три чернетки під три канали.
 *
 * CRM — чужа база, тож сторінка нічого в ній не змінює: читає папку, читає
 * картку і показує те, що написав AI. У робочий простір контакт потрапляє лише
 * тоді, коли його свідомо беруть у ліди.
 *
 * Стан тримається тут, а не в /api/state: папка на двадцять дві тисячі людей не
 * має їздити в кожній відповіді сервера.
 */
const CONTACT_PAGE_SIZE = 25;

function renderContacts() {
  const folderList = document.getElementById("contactFolderList");
  if (!folderList) return;

  if (contactsError) {
    folderList.innerHTML = `<div class="empty-state">${escapeHtml(contactsError)}</div>`;
  } else {
    folderList.innerHTML = contactFolders.length
      ? contactFolders.map((folder) => `
          <article class="contact-folder-row ${folder.id === contactFolderId ? "active" : ""}" data-contact-folder="${escapeAttr(folder.id)}">
            <strong>${escapeHtml(folder.name || "Без назви")}</strong>
            <span>${folder.contactCount} ${uaPlural(folder.contactCount, "контакт", "контакти", "контактів")}</span>
          </article>
        `).join("")
      : `<div class="empty-state">${contactsLoading ? "Читаємо CRM..." : "Папок не знайдено"}</div>`;
  }

  const folder = contactFolders.find((item) => item.id === contactFolderId);
  setText("contactListTitle", folder ? folder.name : "Контакти");
  setText(
    "contactListSubtitle",
    folder
      ? `${contactTotal} ${uaPlural(contactTotal, "контакт", "контакти", "контактів")}${contactSearch ? ` за запитом «${contactSearch}»` : ""}`
      : "Вибери папку, щоб побачити людей"
  );

  setHtml("crmContactList", crmContactRows.length
    ? crmContactRows.map((contact) => `
        <article class="contact-row ${contact.id === selectedContactId ? "active" : ""}" data-contact="${escapeAttr(contact.id)}">
          <strong>${escapeHtml(contact.name || "Без імені")}</strong>
          <span>${escapeHtml([contact.position, contact.company].filter(Boolean).join(" · ") || "посада і компанія невідомі")}</span>
          <small>${escapeHtml([contact.country, contact.lead_status].filter(Boolean).join(" · "))}${contactChannelHint(contact)}</small>
        </article>
      `).join("")
    : `<div class="empty-state">${contactsLoading ? "Читаємо контакти..." : contactFolderId ? "У цій папці нічого не знайшлося" : "Папку не вибрано"}</div>`);

  const from = contactTotal ? contactOffset + 1 : 0;
  const to = Math.min(contactOffset + CONTACT_PAGE_SIZE, contactTotal);
  setHtml("contactPager", contactTotal > CONTACT_PAGE_SIZE
    ? `
      <button type="button" id="contactPrevBtn" ${contactOffset === 0 ? "disabled" : ""}><i data-lucide="chevron-left"></i><span>Назад</span></button>
      <span>${from}–${to} з ${contactTotal}</span>
      <button type="button" id="contactNextBtn" ${to >= contactTotal ? "disabled" : ""}><span>Далі</span><i data-lucide="chevron-right"></i></button>
    `
    : "");

  renderContactCard();
  renderContactDrafts();
}

/** Якими каналами до цієї людини взагалі можна дотягнутися. */
function contactChannelHint(contact = {}) {
  const channels = [
    contact.email ? "пошта" : "",
    contact.linkedin ? "LinkedIn" : "",
    contact.telegram ? "Telegram" : "",
    contact.phone ? "телефон" : ""
  ].filter(Boolean);
  return channels.length ? ` · ${escapeHtml(channels.join(", "))}` : "";
}

const contactFieldLabels = {
  company: "Компанія",
  position: "Посада",
  country: "Країна",
  category: "Категорія",
  lead_status: "Статус ліда",
  lifecycle_stage: "Стадія",
  email: "Пошта",
  phone: "Телефон",
  telegram: "Telegram",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
  twitter: "Twitter",
  website: "Сайт",
  created_at: "Доданий у CRM"
};

function renderContactCard() {
  const contact = contactRecord;
  if (!contact) {
    setText("contactCardTitle", "Контакт не вибрано");
    setText("contactCardSubtitle", "");
    setText("contactCardPill", "—");
    setHtml("contactCardBody", `<div class="empty-state">Контакт не вибрано.</div>`);
    return;
  }

  setText("contactCardTitle", contact.name || "Без імені");
  setText("contactCardSubtitle", [contact.position, contact.company].filter(Boolean).join(" · ") || "посада і компанія невідомі");
  setText("contactCardPill", contactProspectId ? "уже в лідах" : "тільки в CRM");

  const rows = Object.entries(contactFieldLabels)
    .map(([key, label]) => {
      const value = contact[key];
      if (!value) return "";
      const text = key === "created_at" ? new Date(value).toLocaleDateString([], { dateStyle: "medium" }) : String(value);
      return `<div><dt>${escapeHtml(label)}</dt><dd>${key === "linkedin" ? contactLinkedInLink(text) : linkIfUrl(text)}</dd></div>`;
    })
    .filter(Boolean)
    .join("");

  const custom = contact.custom_fields && typeof contact.custom_fields === "object" && Object.keys(contact.custom_fields).length
    ? `<details class="contact-custom"><summary>Додаткові поля CRM</summary><pre>${escapeHtml(JSON.stringify(contact.custom_fields, null, 2))}</pre></details>`
    : "";

  setHtml("contactCardBody", `
    <dl class="contact-fields">${rows || `<div><dt>Порожньо</dt><dd>CRM не знає про цю людину нічого, крім імені</dd></div>`}</dl>
    ${contact.description ? `<div class="contact-note"><strong>Нотатка з CRM</strong><p>${escapeHtml(contact.description)}</p></div>` : ""}
    ${custom}
    ${contactHistoryFor && contactHistoryFor === String(contact.id) ? contactConversationHtml() : ""}
  `);
}

function renderContactDrafts() {
  const productSelect = document.getElementById("contactProductSelect");
  if (productSelect) {
    fillSelect(productSelect, state?.products || [], (product) => product.id, (product) => product.name, productSelect.value || state?.selectedProductId);
  }
  const form = document.getElementById("contactDraftForm");
  if (form) form.hidden = !contactRecord;

  const drafts = contactDrafts;
  setText("contactDraftsPill", drafts ? (drafts.provider === "openrouter" ? "AI" : "чернетка з брифу") : "немає");

  if (!drafts) {
    setHtml("contactDraftList", contactRecord
      ? `<div class="empty-state">Ще не згенеровано. AI прочитає картку контакту, опис продукту й файли — і напише лист, повідомлення в Telegram і LinkedIn.</div>`
      : `<div class="empty-state">Вибери контакт, щоб згенерувати повідомлення.</div>`);
    return;
  }

  const emailText = [drafts.email?.subject ? `Тема: ${drafts.email.subject}` : "", drafts.email?.body || ""].filter(Boolean).join("\n\n");
  setHtml("contactDraftList", `
    <article class="contact-draft">
      <header>
        <div><strong>Пошта</strong><span>${escapeHtml(drafts.email?.subject || "без теми")}</span></div>
        <button data-copy-text="${escapeAttr(emailText)}" data-copy-channel="email" data-copy-label="Лист для контакту"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(drafts.email?.body || "")}</pre>
      <small>${wordCountLabel(drafts.email?.body)}</small>
    </article>
    <article class="contact-draft">
      <header>
        <div><strong>Telegram</strong><span>${escapeHtml(contactRecord?.telegram || "юзернейм невідомий")}</span></div>
        <button data-copy-text="${escapeAttr(drafts.telegram?.body || "")}" data-copy-channel="telegram" data-copy-label="Telegram для контакту"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(drafts.telegram?.body || "")}</pre>
      <small>${wordCountLabel(drafts.telegram?.body)}</small>
    </article>
    <article class="contact-draft">
      <header>
        <div><strong>LinkedIn · запрошення</strong><span>до 300 символів, без пропозиції</span></div>
        <button data-copy-text="${escapeAttr(drafts.linkedin?.invite || "")}" data-copy-channel="linkedin" data-copy-label="Запрошення в LinkedIn"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(drafts.linkedin?.invite || "")}</pre>
      <small>${String(drafts.linkedin?.invite || "").length} символів</small>
    </article>
    <article class="contact-draft">
      <header>
        <div><strong>LinkedIn · перше повідомлення</strong><span>після прийняття запрошення</span></div>
        <button data-copy-text="${escapeAttr(drafts.linkedin?.body || "")}" data-copy-channel="linkedin" data-copy-label="Повідомлення в LinkedIn"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(drafts.linkedin?.body || "")}</pre>
      <small>${wordCountLabel(drafts.linkedin?.body)}</small>
    </article>
    <div class="contact-draft-meta">
      <span>${escapeHtml(drafts.productName || "продукт")} · ${escapeHtml(drafts.modelUsed || "локально")} · ${relativeTime(drafts.generatedAt)}</span>
      ${(drafts.grounding || []).length ? `<div><strong>На чому тримається</strong><ul>${drafts.grounding.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
      ${(drafts.verifyBeforeSending || []).length ? `<div class="contact-draft-warning"><strong>Перевір перед відправкою</strong><ul>${drafts.verifyBeforeSending.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
    </div>
  `);
}

function wordCountLabel(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean).length;
  return `${words} ${uaPlural(words, "слово", "слова", "слів")}`;
}

/**
 * Папки CRM, прочитані один раз на дві сторінки.
 *
 * Їх питають і «Контакти», і «Панель», і це той самий список — тримати дві
 * копії означало б показувати різні папки на сусідніх вкладках.
 */
async function fetchContactFolders({ force = false } = {}) {
  if (contactFoldersLoaded && !force) return contactFolders;
  const payload = await api("/api/contacts/folders");
  contactFolders = payload.folders || [];
  contactFoldersLoaded = true;
  // Порожня CRM і CRM, прочитана не тим ключем, виглядають однаково — сервер
  // розрізняє їх за нас, і сторінка повторює це словами.
  contactsError = contactFolders.length ? "" : payload.warning || "";
  return contactFolders;
}

async function loadContactFolders({ force = false } = {}) {
  // Панель читає той самий список папок одразу після входу, тож «завантажено»
  // буває правдою ще до того, як цей екран його намалював. Малюємо наявне,
  // а не лишаємо порожній список до натискання «Оновити».
  if (contactFoldersLoaded && !force) {
    if (!contactFolderId && contactFolders.length) await selectContactFolder(contactFolders[0].id);
    else renderContacts();
    return;
  }
  contactsLoading = true;
  contactsError = "";
  renderContacts();
  try {
    await fetchContactFolders({ force });
    if (!contactFolderId && contactFolders.length) {
      await selectContactFolder(contactFolders[0].id);
      return;
    }
  } catch (error) {
    contactsError = error.message || "CRM не відповіла.";
  } finally {
    contactsLoading = false;
    renderContacts();
    refreshIcons();
  }
}

async function loadContactPage() {
  if (!contactFolderId) return;
  contactsLoading = true;
  renderContacts();
  try {
    const params = new URLSearchParams({
      folderId: contactFolderId,
      limit: String(CONTACT_PAGE_SIZE),
      offset: String(contactOffset)
    });
    if (contactSearch) params.set("search", contactSearch);
    const page = await api(`/api/contacts?${params}`);
    crmContactRows = page.contacts || [];
    contactTotal = page.total || 0;
    contactsError = "";
  } catch (error) {
    crmContactRows = [];
    contactTotal = 0;
    contactsError = error.message || "CRM не відповіла.";
  } finally {
    contactsLoading = false;
    renderContacts();
    refreshIcons();
  }
}

async function selectContactFolder(folderId) {
  contactFolderId = folderId;
  contactOffset = 0;
  await loadContactPage();
}

async function openContact(contactId) {
  selectedContactId = contactId;
  contactRecord = null;
  contactDrafts = null;
  contactProspectId = null;
  void loadContactHistory(contactId);
  renderContacts();
  try {
    const payload = await api(`/api/contacts/${encodeURIComponent(contactId)}`);
    contactRecord = payload.contact;
    contactDrafts = payload.drafts;
    contactProspectId = payload.prospectId;
    // Мова й продукт беруться з того, що вже писали цій людині, щоб повтор не
    // починався з чужих налаштувань.
    if (payload.drafts?.language) setFormValue("contactLanguageSelect", payload.drafts.language);
    if (payload.drafts?.productId) setFormValue("contactProductSelect", payload.drafts.productId);
  } catch (error) {
    contactsError = error.message || "Не вдалося прочитати контакт.";
  }
  renderContacts();
  refreshIcons();
}

/**
 * Листування з людиною для картки контакту — той самий маршрут, що й вкладка
 * «Історія». Прогрів — окрема база: якщо він не відповів, картка з CRM
 * лишається на місці, а замість стрічки — одне речення чому.
 */
async function loadContactHistory(contactId) {
  contactHistoryFor = contactId;
  contactHistory = null;
  contactHistoryNotice = "";
  try {
    const payload = await warmupApi(`/history?crmContactId=${encodeURIComponent(contactId)}`);
    // Людину могли перемкнути, поки відповідь ішла.
    if (contactHistoryFor !== contactId) return;
    contactHistory = payload.entries || [];
  } catch (error) {
    if (contactHistoryFor !== contactId) return;
    contactHistoryNotice = error.message || "Прогрів не відповів.";
  }
  renderContactCard();
  refreshIcons();
}

function contactConversationHtml() {
  const body = contactHistoryNotice
    ? `<p>Листування не прочиталося: ${escapeHtml(contactHistoryNotice)}</p>`
    : !contactHistory
      ? `<p>Читаємо листування...</p>`
      : !contactHistory.length
        ? `<p>Ще нічого.</p>`
        : `<ol class="history-feed">${contactHistory.map(historyEntryHtml).join("")}</ol>`;
  return `
    <section class="contact-history">
      <strong>Листування в LinkedIn</strong>
      ${body}
    </section>
  `;
}

document.getElementById("contactFolderList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-contact-folder]");
  if (!row || row.dataset.contactFolder === contactFolderId) return;
  await selectContactFolder(row.dataset.contactFolder);
});

document.getElementById("contactFoldersRefreshBtn").addEventListener("click", async () => {
  await loadContactFolders({ force: true });
  await loadContactPage();
});

document.getElementById("crmContactList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-contact]");
  if (!row) return;
  await openContact(row.dataset.contact);
});

document.getElementById("contactPager").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  contactOffset = button.id === "contactPrevBtn"
    ? Math.max(0, contactOffset - CONTACT_PAGE_SIZE)
    : contactOffset + CONTACT_PAGE_SIZE;
  await loadContactPage();
});

// Пошук чекає, поки людина допише: кожна літера — це запит у CRM.
let contactSearchTimer = null;
document.getElementById("contactSearchInput").addEventListener("input", (event) => {
  const value = event.target.value.trim();
  window.clearTimeout(contactSearchTimer);
  contactSearchTimer = window.setTimeout(async () => {
    contactSearch = value;
    contactOffset = 0;
    await loadContactPage();
  }, 350);
});

document.getElementById("contactDraftForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedContactId) return;
  await runUiAction("contact-drafts", "AI читає контакт, продукт і файли та пише чернетки...", async () => {
    const payload = await api(`/api/contacts/${encodeURIComponent(selectedContactId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        productId: document.getElementById("contactProductSelect").value,
        language: document.getElementById("contactLanguageSelect").value,
        instruction: document.getElementById("contactInstructionInput").value
      })
    });
    contactDrafts = payload.drafts;
  });
  renderContacts();
  refreshIcons();
});

/* ── LinkedIn warm-up ──────────────────────────────────────────────────────
 *
 * The list is Anty's profiles with this app's warm-up joined on, never the
 * other way round. Every number shown here — today's quota, what is left, when
 * the next session is due — comes from the server rather than being recomputed
 * in the browser, so the figure on screen is the figure an action is checked
 * against.
 */

const warmupState = {
  config: null,
  dashboard: null,
  profiles: [],
  selectedAccountId: null,
  selectedProfileId: null,
  detail: null,
  busy: false,
  error: "",
  // The warm-up schedule itself: one strategy for every account, held as the
  // server sends it and edited as `strategyDraft`, day by day. The draft is
  // null until somebody opens the editor, so an open panel with no edits and a
  // panel nobody opened are the same thing to everything else here.
  strategy: null,
  strategyDraft: null,
  strategyOpen: false,
  strategyBusy: false,
  strategyError: "",
  strategyNotice: "",
  // Campaigns: a folder, the filters that narrow it, the accounts that work it
  // and a product, each with the server's forecast for that combination. The
  // forecast is never recomputed here — a second copy of that arithmetic is a
  // second answer.
  folders: [],
  foldersReady: false,
  campaigns: [],
  campaignsReady: false,
  campaignsError: "",
  campaignNotice: "",
  selectedCampaignId: null,
  // The form is open on exactly one thing at a time: a new campaign (id null)
  // or an existing one. Nothing is a draft in two places.
  formOpen: false,
  formCampaignId: null,
  savingCampaign: false,
  pendingAccountIds: null,
  // Per account: what is claimed to it now, or the server's sentence saying why
  // nothing is. An empty box is never the answer here.
  queues: {},
  queueBusy: {},
  leads: [],
  leadsTotal: null,
  leadsTargeting: null,
  leadsPrompt: "",
  leadsError: "",
  leadsReady: false,
  // The inbox. `ready` is "the endpoint answered", `available` is "this server
  // has the endpoint at all" — a portal built before the inbox landed should
  // say so rather than claim nobody has written.
  inbox: {
    threads: [],
    // One entry per account that holds a thread: how much it holds, how much of
    // it is unread. The list groups by this and the accounts table reads the
    // same numbers, so the two can never tell a seller different things.
    accounts: [],
    unread: 0,
    sync: null,
    ready: false,
    available: true,
    error: "",
    unreadOnly: false,
    showAll: false,
    // The open thread, held as account + thread because a thread key is only
    // unique within the account it arrived on.
    openAccountId: null,
    openThreadKey: null,
    open: null,
    openError: "",
    openBusy: false
  },
  // Null is "not asked yet", which is not the same as zero: a badge that has
  // never been told a number must not claim there is nothing to read.
  unreadReplies: null
};

function warmupApi(path, options) {
  return api(`/api/warmup${path}`, options);
}

const WARMUP_STATUS_TONE = {
  warming: "tone-live",
  working: "tone-live",
  paused: "tone-warn",
  blocked: "tone-bad",
  needs_attention: "tone-warn",
  finished: "tone-done",
  excluded: "tone-muted",
  off: "tone-muted"
};

const WARMUP_STATUS_LABEL = {
  warming: "Прогрівається",
  // Past the last phase an account does not stop; it settles into working mode.
  working: "Робочий режим",
  paused: "На паузі",
  blocked: "Заблоковано",
  needs_attention: "Потребує уваги",
  finished: "Завершено",
  excluded: "Виключено",
  off: "Вимкнено"
};

function warmupRelativeTime(iso) {
  if (!iso) return "—";
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (!Number.isFinite(minutes)) return "—";
  const time = new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (minutes <= 0) return time;
  if (minutes < 60) return `${time} · через ${minutes} хв`;
  return `${time} · через ${Math.round(minutes / 60)} год`;
}

/** What the "next session" cell says, which follows the quota and not the clock. */
function warmupNextSessionCell(profile) {
  const next = profile.nextSession;
  if (profile.isRunningNow) return '<span class="warmup-due">відкрита зараз</span>';
  if (!next) return "—";
  if (next.overdue) return '<span class="warmup-due">час настав</span>';
  if (next.today) return warmupRelativeTime(next.at);
  return `завтра ${new Date(next.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function warmupConnectionsCell(profile) {
  const { today = 0, total = 0, quota = 0, startsDay = null } = profile.connections || {};
  const week = profile.connections?.weekly;
  const all = `title="${total} за весь час${week ? ` · ${week.done}/${week.limit} за 7 днів` : ""}"`;
  if (quota > 0) return `<span ${all}>${today}/${quota}</span>`;
  if (startsDay) return `<span class="warmup-subtle" ${all}>з ${startsDay}-го дня</span>`;
  return `<span class="warmup-subtle" ${all}>${total}</span>`;
}

function renderWarmupConfigNote() {
  const note = document.getElementById("warmupConfigNote");
  if (!note) return;
  const config = warmupState.config;
  const problems = [];

  if (warmupState.error) problems.push(escapeHtml(warmupState.error));
  if (config && !config.configured) {
    problems.push(`База Anty не налаштована — задай на сервері ${escapeHtml(config.missing.join(", "))}.`);
  }
  if (config?.configured && !config.teamConfigured) {
    problems.push("ANTY_TEAM_ID не заданий, тому в списку профілі всіх команд.");
  }
  if (config?.configured && !config.crmConfigured) {
    problems.push(`Черга лідів вимкнена — задай ${escapeHtml(config.crmMissing.join(", "))}, щоб надсилати запити на контакт конкретним людям.`);
  }
  if (config?.configured && !config.secretsConfigured) {
    problems.push("LINKEDIN_SECRET_KEY не заданий, тому паролі акаунтів нікуди зберігати.");
  }

  note.hidden = problems.length === 0;
  note.innerHTML = problems.map((problem) => `<p>${problem}</p>`).join("");
}

function renderWarmupStats() {
  const strip = document.getElementById("warmupStatsStrip");
  if (!strip) return;
  const dashboard = warmupState.dashboard;
  if (!dashboard) {
    strip.innerHTML = "";
    return;
  }

  const { totals, todayProgress } = dashboard;
  const window = warmupState.config?.window;
  const cards = [
    { label: "Прогріваються", value: totals.warming },
    { label: "Робочий режим", value: totals.working ?? 0 },
    { label: "На паузі", value: totals.paused },
    // The standard strategy never finishes any more — day 15 is working mode —
    // so this card only appears when there is something to count.
    ...(totals.completed ? [{ label: "Завершені", value: totals.completed }] : []),
    { label: "Не почали", value: totals.idle },
    { label: "Сьогодні", value: `${todayProgress.done}/${todayProgress.planned}` },
    { label: "Вікно сесій", value: window ? `${window.label}${window.open ? "" : " · зачинене"}` : "—" }
  ];

  strip.innerHTML = cards
    .map((card) => `<div class="warmup-stat"><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(String(card.value))}</strong></div>`)
    .join("");
}

/* ── Campaigns ─────────────────────────────────────────────────────────────
 *
 * A campaign is a folder, the filters that narrow it, the accounts that work it
 * and a product. The list is not the point of this panel; the sentence under
 * the selected row is. A folder of 22 088 contacts at about 22 requests a day
 * is three years of work, and a screen that shows that as "0 of 22 088" in a
 * table cell has presented three years as a progress bar. So the forecast keeps
 * the whole width it had when there was only one form, and every number on it
 * comes from the server.
 *
 * A campaign proposes; the warm-up disposes. Nothing here sets a pace — the
 * numbers are what the accounts' own warm-up days already allow.
 */

const WARMUP_EMPTY_FILTERS = { country: "", position: "", leadStatus: "", ownerId: "" };

/**
 * З якого дня прогріву кампанія сама годує акаунти зі своєї папки. Сім —
 * бо дні 4–6 для своїх і перевірених, яких ставлять вручну з картки ліда.
 * Сервер має те саме число (`DEFAULT_FROM_DAY`); тут воно лише для форми.
 */
const WARMUP_DEFAULT_FROM_DAY = 7;

/** День із поля форми, як рядок: перевіряє його сервер і каже реченням, що не так. */
function warmupFromDayValue() {
  return (document.getElementById("warmupCampaignFromDay")?.value || "").trim();
}

const WARMUP_CAMPAIGN_TONE = {
  draft: "tone-muted",
  running: "tone-live",
  paused: "tone-warn",
  done: "tone-done"
};

/** Стан кампанії — це дані; те, що видно в пігулці, — це текст. */
const WARMUP_CAMPAIGN_STATE_LABEL = {
  draft: "чернетка",
  running: "працює",
  paused: "на паузі",
  done: "завершена"
};

function warmupFilterInputs() {
  return {
    country: document.getElementById("warmupFilterCountry"),
    position: document.getElementById("warmupFilterPosition"),
    leadStatus: document.getElementById("warmupFilterStatus"),
    ownerId: document.getElementById("warmupFilterOwner")
  };
}

/** What the form says right now, which is not always what is saved. */
function warmupFormValues() {
  const filters = { ...WARMUP_EMPTY_FILTERS };
  for (const [key, input] of Object.entries(warmupFilterInputs())) {
    filters[key] = (input?.value || "").trim();
  }
  return {
    name: (document.getElementById("warmupCampaignName")?.value || "").trim(),
    folderId: document.getElementById("warmupFolderSelect")?.value || "",
    productId: document.getElementById("warmupCampaignProduct")?.value || "",
    fromDay: warmupFromDayValue(),
    filters
  };
}

function warmupCampaignById(id) {
  return warmupState.campaigns.find((campaign) => campaign.id === id) || null;
}

function warmupSelectedCampaign() {
  return warmupCampaignById(warmupState.selectedCampaignId);
}

/** The campaign the open form is editing, or null when it is a new one. */
function warmupEditingCampaign() {
  return warmupState.formOpen ? warmupCampaignById(warmupState.formCampaignId) : null;
}

function warmupCampaignSaved(campaign) {
  return {
    name: campaign?.name || "",
    folderId: campaign?.folderId || "",
    productId: campaign?.productId || "",
    fromDay: String(campaign?.fromDay || WARMUP_DEFAULT_FROM_DAY),
    filters: { ...WARMUP_EMPTY_FILTERS, ...(campaign?.filters || {}) }
  };
}

/** Does the open form differ from the campaign it is editing? */
function warmupFormDirty() {
  if (!warmupState.formOpen || !warmupState.foldersReady) return false;
  const editing = warmupEditingCampaign();
  if (!editing) return true;
  const form = warmupFormValues();
  const saved = warmupCampaignSaved(editing);
  if (form.name !== saved.name || form.folderId !== saved.folderId || form.productId !== saved.productId) return true;
  if (form.fromDay !== saved.fromDay) return true;
  return Object.keys(WARMUP_EMPTY_FILTERS).some((key) => form.filters[key] !== saved.filters[key]);
}

/** The accounts ticked against one campaign — the tick column follows this. */
function warmupCampaignAccountIds(campaign) {
  return new Set(campaign?.accountIds || []);
}

/** 12 038 rather than 12038: these are counts somebody has to weigh. */
function warmupCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return Math.round(number).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** A thousand days is not a figure anybody can feel; "2.7 years" is. */
function warmupDuration(days) {
  const number = Number(days);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number < 45) return `${Math.round(number)} ${uaPlural(Math.round(number), "день", "дні", "днів")}`;
  if (number < 365) return `${Math.round(number / 30)} ${uaPlural(Math.round(number / 30), "місяць", "місяці", "місяців")}`;
  return `${(number / 365).toFixed(1)} року`;
}

function warmupFolderName(folderId) {
  if (!folderId) return null;
  const listed = warmupState.folders.find((folder) => folder.id === folderId)?.name;
  if (listed) return listed;
  // A folder the CRM no longer lists is still the folder a campaign is pointed
  // at, and the name stored with the campaign is what answers for it.
  return warmupState.campaigns.find((campaign) => campaign.folderId === folderId && campaign.folderName)?.folderName || null;
}

function warmupProductName(productId) {
  if (!productId) return null;
  return (state?.products || []).find((product) => product.id === productId)?.name || null;
}

function renderWarmupFolderOptions(selectedId) {
  const select = document.getElementById("warmupFolderSelect");
  if (!select) return;
  const signature = `${warmupState.foldersReady}|${warmupState.folders.length}|${selectedId || ""}|${warmupState.campaignsError}`;
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;

  if (!warmupState.foldersReady) {
    select.innerHTML = `<option value="">${escapeHtml(warmupState.campaignsError ? "Папки недоступні" : "Завантажуємо папки...")}</option>`;
    select.disabled = true;
    return;
  }

  select.disabled = false;
  const options = [`<option value="">Обери папку</option>`];
  const known = new Set();
  for (const folder of warmupState.folders) {
    known.add(folder.id);
    const count = warmupCount(folder.contactCount);
    const archived = folder.isArchived ? " · в архіві" : "";
    options.push(`<option value="${escapeAttr(folder.id)}" ${folder.id === selectedId ? "selected" : ""}>${escapeHtml(folder.name)} · ${escapeHtml(count)} контактів${archived}</option>`);
  }
  // A folder the list no longer carries (archived, or renamed away) is still
  // the folder this campaign is pointed at, so it stays selectable rather than
  // silently becoming "none".
  if (selectedId && !known.has(selectedId)) {
    const name = warmupEditingCampaign()?.folderName || warmupFolderName(selectedId) || selectedId;
    options.splice(1, 0, `<option value="${escapeAttr(selectedId)}" selected>${escapeHtml(name)} · немає в списку папок</option>`);
  }
  select.innerHTML = options.join("");
}

/** Products are the workspace's own — one list, not a second copy of it. */
function renderWarmupProductOptions(selectedId) {
  const select = document.getElementById("warmupCampaignProduct");
  if (!select) return;
  const products = state?.products || [];
  const signature = `${products.length}|${selectedId || ""}`;
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;

  const options = [`<option value="" ${selectedId ? "" : "selected"}>Без продукту</option>`];
  const known = new Set();
  for (const product of products) {
    known.add(product.id);
    options.push(`<option value="${escapeAttr(product.id)}" ${product.id === selectedId ? "selected" : ""}>${escapeHtml(product.name)}</option>`);
  }
  if (selectedId && !known.has(selectedId)) {
    options.push(`<option value="${escapeAttr(selectedId)}" selected>${escapeHtml(selectedId)} · немає в цьому робочому просторі</option>`);
  }
  select.innerHTML = options.join("");
}

/**
 * The forecast, in the words Phase 1 settled on. Four shapes: no API, nothing
 * targeted, a folder the ticked accounts can finish, and — the one that matters
 * — a folder they cannot. Returns the tone and the markup so a campaign can be
 * handed its own verdict without this being recomputed per row.
 */
function warmupForecastHtml(campaign, { stale = "" } = {}) {
  const forecast = campaign?.forecast || null;

  if (!forecast) {
    const reason = campaign?.forecastError
      || (campaign?.folderId ? "Для цієї папки прогноз не повернувся." : "У цієї кампанії ще немає папки.");
    return {
      tone: "is-muted",
      html: `<p class="warmup-forecast-line">${escapeHtml(reason)}</p>${stale}`
    };
  }

  const matching = Number(forecast.matching) || 0;
  const approached = Number(forecast.alreadyApproached) || 0;
  const remaining = Number(forecast.remaining) || 0;
  const perMonth = Number(forecast.reachedThisMonth) || 0;
  const peak = Number(forecast.perDayAtPeak) || 0;
  const now = Number(forecast.perDayNow) || 0;
  const chosen = Number(forecast.accountsChosen) || 0;
  const fullPass = warmupDuration(forecast.daysToFinish);

  const parts = [
    `<span>${warmupCount(matching)} у папці</span>`,
    `<span>${warmupCount(approached)} вже звертались</span>`,
    `<strong>${warmupCount(peak)} на день</strong>`,
    // Today only when it differs: the average can hide a morning when nobody
    // may send yet.
    peak && now < peak ? `<span>сьогодні ${warmupCount(now)}</span>` : "",
    remaining === 0
      ? `<span>усіх охоплено</span>`
      : fullPass
        ? `<span>~${escapeHtml(fullPass)} до кінця</span>`
        : `<span>не закінчиться</span>`
  ].filter(Boolean);

  let tone = "is-ok";
  let hint = "";

  // A folder that matches nobody and a folder worked to the end are both "0
  // left", and they need opposite things done about them — so only a problem
  // gets a sentence, and one short one.
  if (matching === 0) {
    tone = "is-bad";
    hint = "Під фільтри не підпадає ніхто.";
  } else if (chosen === 0) {
    tone = "is-bad";
    hint = "Не позначено жодного акаунта — познач їх у Профілях.";
  } else if (peak === 0) {
    tone = "is-bad";
    hint = "Позначені акаунти не мають квоти на запити.";
  } else if (remaining === 0) {
    tone = "is-muted";
  } else if (remaining > perMonth * 3) {
    tone = "is-bad";
    hint = "Папка завелика для цих акаунтів — звузь фільтри.";
  } else if (remaining > perMonth) {
    tone = "is-warn";
  }

  return {
    tone,
    html: `
      <p class="warmup-forecast-line">${parts.join('<span class="warmup-forecast-dot" aria-hidden="true">·</span>')}</p>
      ${hint ? `<p class="warmup-forecast-hint">${hint}</p>` : ""}
      ${stale}`
  };
}

function warmupTickedAccountsLine(campaign) {
  const ids = warmupCampaignAccountIds(campaign);
  if (!ids.size) return "";
  const names = [];
  for (const profile of warmupState.profiles) {
    if (profile.account && ids.has(profile.account.id)) names.push(profile.name);
  }
  const hidden = ids.size - names.length;
  if (!names.length) return `Ведуть ${ids.size} ${uaPlural(ids.size, "акаунт", "акаунти", "акаунтів")}`;
  const listed = escapeHtml(names.slice(0, 4).join(", "));
  const more = names.length > 4 ? ` +${names.length - 4} ще` : "";
  return `Ведуть: ${listed}${more}${hidden > 0 ? ` +${hidden}` : ""}`;
}

/**
 * One row. It carries the scale of the campaign — sent of what is left — and
 * the tone of its forecast, so a folder nobody can finish is visible in the
 * list too. The sentence that says why still lives under the selected row.
 */
function warmupCampaignRowHtml(campaign, rank) {
  const selected = campaign.id === warmupState.selectedCampaignId;
  const { tone } = warmupForecastHtml(campaign);
  const progress = campaign.progress || {};
  const sent = Number(progress.sent) || 0;
  const queued = Number(progress.queued) || 0;
  const remaining = campaign.forecast ? Number(campaign.forecast.remaining) || 0 : null;
  const accounts = (campaign.accountIds || []).length;
  const folder = campaign.folderName || warmupFolderName(campaign.folderId) || (campaign.folderId ? "папка, якої CRM не показує" : "без папки");
  const product = warmupProductName(campaign.productId);

  const feedStart = campaignFeedStart(campaign, WARMUP_DEFAULT_FROM_DAY);
  const meta = [
    escapeHtml(folder),
    `${accounts} ${uaPlural(accounts, "акаунт", "акаунти", "акаунтів")}`,
    product ? escapeHtml(product) : "",
    feedStart ? `<span title="${escapeAttr(feedStart.title)}">${escapeHtml(feedStart.text)}</span>` : ""
  ].filter(Boolean);

  const controls = [];
  // The order is the only thing deciding which campaign an account actually
  // serves — the first running one with work takes the whole quota. So the rank
  // is not a tooltip on a label somebody cannot change; it is the readout of
  // the two arrows that set it.
  const index = warmupState.campaigns.indexOf(campaign);
  const rankLabel = rank
    ? `<strong title="Порядок: спільні акаунти першою заповнює кампанія вище">#${rank}</strong>`
    : `<em title="Стане в порядок після запуску">—</em>`;
  controls.push(`<span class="warmup-campaign-move">
    <button class="text-button" type="button" data-warmup-campaign-move="up" ${index <= 0 ? "disabled" : ""} title="Вище" aria-label="Підняти ${escapeAttr(campaign.name || "цю кампанію")} вище в порядку"><i data-lucide="chevron-up"></i></button>
    ${rankLabel}
    <button class="text-button" type="button" data-warmup-campaign-move="down" ${index < 0 || index >= warmupState.campaigns.length - 1 ? "disabled" : ""} title="Нижче" aria-label="Опустити ${escapeAttr(campaign.name || "цю кампанію")} нижче в порядку"><i data-lucide="chevron-down"></i></button>
  </span>`);
  if (campaign.state === "running") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="paused" title="Зупинити: акаунти перестануть брати людей із папки"><i data-lucide="pause"></i><span>Пауза</span></button>`);
  } else if (campaign.state !== "done") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="running" title="Запустити: акаунти почнуть брати людей із папки"><i data-lucide="play"></i><span>Старт</span></button>`);
  }
  if (campaign.state !== "done") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="done" title="Більше нікого не брати"><i data-lucide="check"></i><span>Завершити</span></button>`);
  } else {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="running" title="Запустити знову"><i data-lucide="rotate-ccw"></i><span>Відкрити знову</span></button>`);
  }
  controls.push(`<button class="text-button" type="button" data-warmup-campaign-edit><i data-lucide="pencil"></i><span>Редагувати</span></button>`);
  controls.push(`<button class="text-button warmup-campaign-delete" type="button" data-warmup-campaign-delete><i data-lucide="trash-2"></i><span>Видалити</span></button>`);

  const count = remaining === null
    ? `<span class="warmup-campaign-count-unknown">${warmupCount(sent)} надіслано</span>`
    : `<strong>${warmupCount(sent)}</strong><span>надіслано · ${warmupCount(remaining)} лишилось</span>`;

  return `
    <article class="warmup-campaign-row ${tone} ${selected ? "is-selected" : ""}" data-warmup-campaign="${escapeAttr(campaign.id)}">
      <div class="warmup-campaign-who">
        <div class="warmup-campaign-name">
          <button class="warmup-campaign-select" type="button" data-warmup-campaign-select aria-pressed="${selected}">${escapeHtml(campaign.name || "Кампанія без назви")}</button>
          <span class="pill ${WARMUP_CAMPAIGN_TONE[campaign.state] || "tone-muted"}">${escapeHtml(WARMUP_CAMPAIGN_STATE_LABEL[campaign.state] || campaign.state || "чернетка")}</span>
        </div>
        <div class="warmup-campaign-meta">${meta.join('<span class="warmup-forecast-dot" aria-hidden="true">·</span>')}</div>
      </div>
      <div class="warmup-campaign-count">
        ${count}
        ${queued ? `<span class="warmup-campaign-claimed">${warmupCount(queued)} у черзі</span>` : ""}
        ${campaign.progressApproximate
          ? '<span class="warmup-campaign-approx" title="Інша кампанія ділить із цією акаунт і папку — їхні числа змішані">приблизно</span>'
          : ""}
      </div>
      <div class="warmup-campaign-actions">${controls.join("")}</div>
    </article>`;
}

function renderWarmupCampaignList() {
  const host = document.getElementById("warmupCampaignList");
  if (!host) return;

  if (warmupState.campaignsError) {
    host.innerHTML = `<div class="warmup-leads-prompt is-bad"><strong>${escapeHtml(warmupState.campaignsError)}</strong>
      <span>Поки сервер не відповідає, ніщо на цій панелі не зберігається, і акаунти далі закріплюють людей звідти, куди їх спрямували раніше.</span></div>`;
    refreshIcons();
    return;
  }

  if (!warmupState.campaignsReady) {
    host.innerHTML = '<div class="empty-state">Завантажуємо кампанії...</div>';
    return;
  }

  if (!warmupState.campaigns.length) {
    host.innerHTML = `<div class="warmup-leads-prompt"><strong>Кампаній поки немає.</strong>
      <span>Кампанія — це одна папка, акаунти, які її ведуть, і продукт. Створи одну, і ця панель скаже, у що вона насправді виллється, ще до першого надсилання.</span></div>`;
    refreshIcons();
    return;
  }

  let rank = 0;
  host.innerHTML = warmupState.campaigns
    .map((campaign) => warmupCampaignRowHtml(campaign, campaign.state === "running" ? ++rank : 0))
    .join("");
  refreshIcons();
}

/**
 * The selected campaign's verdict, at the width it had when there was one form.
 * This is the part of the panel that must not shrink into a table cell.
 */
function renderWarmupCampaignDetail() {
  const host = document.getElementById("warmupCampaignDetail");
  if (!host) return;

  const campaign = warmupSelectedCampaign();
  if (!campaign) {
    host.innerHTML = warmupState.campaignsReady && warmupState.campaigns.length
      ? '<div class="empty-state">Обери кампанію, щоб побачити, у що вона виллється.</div>'
      : "";
    return;
  }

  // The form is allowed to disagree with the campaign it is editing; the
  // forecast belongs to what is saved, and says so rather than looking current.
  const stale = warmupState.formOpen && warmupState.formCampaignId === campaign.id && warmupFormDirty()
    ? '<p class="warmup-forecast-stale">Ці числа — для збереженої кампанії. Збережи, щоб порахувати те, що на екрані.</p>'
    : "";

  const { tone, html } = warmupForecastHtml(campaign, { stale });
  const note = campaignStateNote(campaign, WARMUP_DEFAULT_FROM_DAY);

  host.innerHTML = `
    <div class="warmup-forecast ${tone}">${html}</div>
    <div class="warmup-campaign-detail-foot">
      <p class="warmup-campaign-accounts">${warmupState.campaignNotice
        ? `<em class="warmup-campaign-problem">${escapeHtml(warmupState.campaignNotice)}</em>`
        : warmupTickedAccountsLine(campaign)}</p>
      ${note ? `<p class="warmup-campaign-state-note">${escapeHtml(note)}</p>` : ""}
    </div>`;
  refreshIcons();
}

function renderWarmupCampaignForm({ resetForm = false } = {}) {
  const form = document.getElementById("warmupCampaignForm");
  const saveButton = document.getElementById("warmupCampaignSaveBtn");
  const note = document.getElementById("warmupCampaignFormNote");
  if (!form || !saveButton) return;

  form.hidden = !warmupState.formOpen;
  if (!warmupState.formOpen) return;

  const editing = warmupEditingCampaign();
  const saved = warmupCampaignSaved(editing);
  if (resetForm) {
    const nameInput = document.getElementById("warmupCampaignName");
    if (nameInput) nameInput.value = saved.name;
    for (const [key, input] of Object.entries(warmupFilterInputs())) {
      if (input) input.value = saved.filters[key] || "";
    }
    const fromDayInput = document.getElementById("warmupCampaignFromDay");
    if (fromDayInput) fromDayInput.value = saved.fromDay;
    // A new campaign starts on the product this workspace is already working.
    renderWarmupProductOptions(editing ? saved.productId : (state?.selectedProductId || ""));
    renderWarmupFolderOptions(saved.folderId);
  } else {
    renderWarmupProductOptions(document.getElementById("warmupCampaignProduct")?.value || saved.productId);
    renderWarmupFolderOptions(document.getElementById("warmupFolderSelect")?.value || saved.folderId);
  }

  for (const input of Object.values(warmupFilterInputs())) {
    if (input) input.disabled = !warmupState.foldersReady;
  }
  const fromDayInput = document.getElementById("warmupCampaignFromDay");
  if (fromDayInput) fromDayInput.disabled = !warmupState.foldersReady;

  saveButton.disabled = !warmupState.campaignsReady || warmupState.savingCampaign;
  saveButton.querySelector("span").textContent = warmupState.savingCampaign
    ? "Зберігаємо..."
    : (editing ? "Зберегти зміни" : "Створити кампанію");

  if (note) {
    note.innerHTML = warmupState.campaignNotice
      ? `<em class="warmup-campaign-problem">${escapeHtml(warmupState.campaignNotice)}</em>`
      : (editing
        ? escapeHtml(`Редагуємо: ${editing.name || "ця кампанія"}. Які акаунти її ведуть — позначається нижче, у Профілях, а не тут.`)
        : "Нова кампанія починається як чернетка, останньою в черзі. Познач унизу, у Профілях, акаунти, які її ведуть, і запусти її.");
  }
}

function renderWarmupCampaigns({ resetForm = false } = {}) {
  const pill = document.getElementById("warmupCampaignsPill");
  const newButton = document.getElementById("warmupCampaignNewBtn");

  if (pill) {
    if (!warmupState.campaignsReady) {
      pill.hidden = false;
      pill.className = "pill tone-muted";
      pill.textContent = warmupState.campaignsError ? "недоступно" : "завантаження";
    } else {
      // The list under it already shows every campaign and its state.
      pill.className = "pill tone-muted";
      pill.textContent = "";
      pill.hidden = true;
    }
  }
  if (newButton) newButton.disabled = !warmupState.campaignsReady || !warmupState.foldersReady;

  renderWarmupCampaignForm({ resetForm });
  renderWarmupCampaignList();
  renderWarmupCampaignDetail();
  refreshIcons();
}

/* ── The queue ─────────────────────────────────────────────────────────────
 *
 * What is claimed to each account of the selected campaign right now. An
 * account whose connection quota has not opened yet — which this week is every
 * account — gets an empty list and a sentence saying why. The sentence is the
 * server's own; an empty box here would be the screen refusing to answer the
 * one question somebody opened it with.
 */

function warmupQueueState(accountId) {
  return warmupState.queues[accountId] || null;
}

function warmupQueueRowHtml(row, accountId, campaignId) {
  const link = warmupLeadLink(row.linkedin);
  const where = [row.position, row.company].filter(Boolean).join(" · ");
  const name = row.name || "Контакт без імені";
  // A queue belongs to an account, not to a campaign: an account that works two
  // campaigns holds both their claims in one list. Saying which campaign a
  // person came from is the difference between a list and a claim about where
  // these people are from.
  const elsewhere = row.campaignId && campaignId && row.campaignId !== campaignId
    ? `<span class="warmup-queue-elsewhere" title="Закріплено іншою кампанією, яку цей акаунт теж веде">${escapeHtml(row.campaignName || "інша кампанія")}</span>`
    : "";
  return `<li>
    <div class="warmup-lead-who">
      <strong>${escapeHtml(name)}</strong>
      ${where ? `<span class="warmup-subtle">${escapeHtml(where)}</span>` : ""}
      ${elsewhere}
    </div>
    ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">профіль</a>` : '<span class="warmup-subtle">без посилання на профіль</span>'}
    <button class="text-button warmup-queue-send" type="button"
      data-warmup-take="${escapeAttr(row.crmContactId || "")}"
      data-warmup-take-account="${escapeAttr(accountId)}"
      data-warmup-take-name="${escapeAttr(name)}"
      ${row.crmContactId ? "" : "disabled"}
      title="Фіксує запит до цієї людини. Одна людина — один захід, назавжди.">Надіслав запит</button>
  </li>`;
}

function warmupQueueAccountHtml(accountId, campaignId) {
  const profile = warmupState.profiles.find((item) => item.account?.id === accountId) || null;
  const identity = profile?.identity || profile?.account?.identity || null;
  const queue = warmupQueueState(accountId);
  const busy = Boolean(warmupState.queueBusy[accountId]);

  const day = profile?.day ? `день ${profile.day}` : null;
  const connections = profile?.connections || {};
  const quotaLine = connections.quota > 0
    ? `${connections.today || 0}/${connections.quota} сьогодні`
    : (connections.startsDay ? `запити з ${connections.startsDay}-го дня` : "без запитів сьогодні");
  const meta = [day, quotaLine].filter(Boolean).join(" · ");

  // Only what the campaign on screen is doing: the cache is keyed by account,
  // and another campaign ticking the same account loaded it just as well.
  const feedLine = warmupAutoFeedHtml(autoFeedFor(queue, campaignId));
  const waitingList = warmupQueueWaitingHtml(queue?.waiting || []);

  let body = "";
  if (!queue) {
    body = '<div class="empty-state">Завантажуємо...</div>';
  } else if (queue.unavailable) {
    body = `<p class="warmup-queue-reason is-muted">${escapeHtml(queue.unavailable)}</p>`;
  } else if (queue.error) {
    body = `<p class="warmup-queue-reason is-bad">${escapeHtml(queue.error)}</p>`;
  } else if (queue.rows?.length) {
    body = `<ul class="warmup-leads warmup-queue-list">${queue.rows.map((row) => warmupQueueRowHtml(row, accountId, campaignId)).join("")}</ul>`;
  } else if (queue.reason && !feedLine) {
    // The server's sentence, verbatim — but only when the feed line has not
    // already said why nothing is held: two answers to one question is noise.
    body = `<p class="warmup-queue-reason">${escapeHtml(queue.reason)}</p>`;
  }

  const released = Number(queue?.released) || 0;
  const releasedNote = released
    ? `<p class="warmup-queue-released">${warmupCount(released)} ${uaPlural(released, "закріплення", "закріплення", "закріплень")} повернулось у пул</p>`
    : "";

  return `<article class="warmup-queue-account" data-warmup-queue-account="${escapeAttr(accountId)}">
    <header>
      <div class="warmup-queue-who">
        <strong>${escapeHtml(profile?.name || "Акаунт")}</strong>
        ${identity?.name ? `<span class="warmup-identity"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}</span></span>` : ""}
        ${meta ? `<span class="warmup-subtle">${escapeHtml(meta)}</span>` : ""}
      </div>
      <button class="text-button" type="button" data-warmup-claim="${escapeAttr(accountId)}" ${busy ? "disabled" : ""} title="Закріпити людей для ручного надсилання">
        <i data-lucide="hand"></i><span>${busy ? "Закріплюємо..." : "Закріпити"}</span>
      </button>
    </header>
    ${feedLine}
    ${waitingList}
    ${releasedNote}
    ${body}
  </article>`;
}

/** Чи годує ця кампанія акаунт сама — одним реченням; слова в `autoFeedLine`. */
function warmupAutoFeedHtml(feed) {
  const line = autoFeedLine(feed, WARMUP_DEFAULT_FROM_DAY);
  if (!line) return "";
  return `<p class="warmup-queue-feed ${line.tone}"><i data-lucide="${line.icon}"></i><span>${escapeHtml(line.text)}</span></p>`;
}

/**
 * Хто чекає, поки агент надішле запит, — і хто з них із папки, а кого
 * поставили вручну. Кнопок тут немає: це черга агента, не людини.
 */
function warmupQueueWaitingHtml(rows) {
  if (!rows.length) return "";
  const fromFolder = rows.filter((row) => row.fromFolder).length;
  const items = rows.map((row) => {
    const link = warmupLeadLink(row.linkedin);
    const where = [row.position, row.company].filter(Boolean).join(" · ");
    const source = row.fromFolder
      ? `<span class="pill tone-muted" title="${escapeAttr(row.campaignName ? `Із папки кампанії «${row.campaignName}»` : "Із папки кампанії")}">з папки</span>`
      : '<span class="pill tone-live" title="Поставлено вручну з картки ліда — піде першим">вручну</span>';
    // A block page on this request: the agent is not handed it until
    // somebody moves or cancels it on the card.
    const attention = row.parked
      ? `<span class="pill tone-warn" title="${escapeAttr(inviteAttentionText({ status: "waiting", parked: true }))}">потребує уваги</span>`
      : "";
    return `<li>
      <div class="warmup-lead-who">
        <strong>${escapeHtml(row.name || "Контакт без імені")}</strong>
        ${where ? `<span class="warmup-subtle">${escapeHtml(where)}</span>` : ""}
      </div>
      ${source}
      ${attention}
      ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">профіль</a>` : ""}
    </li>`;
  }).join("");
  const parked = rows.filter((row) => row.parked).length;
  return `<details class="warmup-queue-waiting"${parked ? " open" : ""}>
    <summary>Чекають агента: ${warmupCount(rows.length)}${fromFolder ? ` · з папки ${warmupCount(fromFolder)}` : ""}${parked ? ` · потребують уваги ${warmupCount(parked)}` : ""}</summary>
    <ul class="warmup-leads warmup-queue-list">${items}</ul>
  </details>`;
}

function renderWarmupQueue() {
  const title = document.getElementById("warmupQueueTitle");
  const subtitle = document.getElementById("warmupQueueSubtitle");
  const body = document.getElementById("warmupQueueBody");
  if (!title || !subtitle || !body) return;

  const campaign = warmupSelectedCampaign();
  title.textContent = campaign ? `Черга · ${campaign.name || "Кампанія без назви"}` : "Черга";

  if (!campaign) {
    subtitle.textContent = "";
    body.innerHTML = '<div class="empty-state">Обери кампанію вгорі.</div>';
    return;
  }

  const accountIds = campaign.accountIds || [];
  if (!accountIds.length) {
    subtitle.textContent = "";
    body.innerHTML = `<div class="warmup-leads-prompt"><strong>Не позначено жодного акаунта.</strong>
      <span>Познач їх нижче, у Профілях.</span></div>`;
    refreshIcons();
    return;
  }

  // A queue is an account's, so what is counted here is everything these
  // accounts hold — this campaign's claims and any other campaign's.
  const claimed = accountIds.reduce((total, id) => total + (warmupQueueState(id)?.rows?.length || 0), 0);
  subtitle.textContent = claimed ? `${warmupCount(claimed)} закріплено вручну` : "";

  body.innerHTML = `<div class="warmup-queue-accounts">${accountIds.map((id) => warmupQueueAccountHtml(id, campaign.id)).join("")}</div>`;
  refreshIcons();
}

function warmupLeadLink(url) {
  const value = String(url || "");
  return /^https?:\/\//i.test(value) ? value : null;
}

function renderWarmupLeads() {
  const title = document.getElementById("warmupLeadsTitle");
  const subtitle = document.getElementById("warmupLeadsSubtitle");
  const body = document.getElementById("warmupLeadsBody");
  if (!title || !subtitle || !body) return;

  // The header names the folder: a queue that does not say where it comes from
  // is a list of strangers.
  const targeting = warmupState.leadsTargeting;
  const folderName = targeting?.folderName || warmupFolderName(targeting?.folderId);
  // A queue answering "nothing is targeted" must not carry a folder name in
  // its header — that would be two answers to the same question.
  title.textContent = folderName && !warmupState.leadsPrompt ? `Черга лідів · ${folderName}` : "Черга лідів";

  if (warmupState.leadsPrompt) {
    subtitle.textContent = "Ціль ще не задана";
    body.innerHTML = `<div class="warmup-leads-prompt">
      <strong>${escapeHtml(warmupState.leadsPrompt)}</strong>
      <span>Створи кампанію вгорі й запусти її — цей список і є те, що підпадає під її папку й фільтри, ще до закріплення за акаунтом.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (warmupState.leadsError) {
    subtitle.textContent = "Чергу не вдалося прочитати";
    body.innerHTML = `<div class="warmup-leads-prompt is-bad"><strong>${escapeHtml(warmupState.leadsError)}</strong>
      <span>«CRM не відповідає» і «більше нікого немає» — це різні відповіді; тут перша.</span></div>`;
    refreshIcons();
    return;
  }

  if (!warmupState.leadsReady) {
    subtitle.textContent = "Черги лідів на цьому сервері ще немає";
    body.innerHTML = '<div class="empty-state">Показувати нічого, поки ендпоїнт черги не відповість.</div>';
    return;
  }

  subtitle.textContent = Number.isFinite(warmupState.leadsTotal)
    ? `Наступні ${warmupState.leads.length} з ${warmupCount(warmupState.leadsTotal)}`
    : "";

  if (!warmupState.leads.length) {
    body.innerHTML = '<div class="empty-state">У папці більше нікого немає.</div>';
    return;
  }

  body.innerHTML = `<ul class="warmup-leads">${warmupState.leads
    .map((lead) => {
      const link = warmupLeadLink(lead.linkedin);
      const where = [lead.position, lead.company].filter(Boolean).join(" · ");
      return `<li>
        <div class="warmup-lead-who">
          <strong>${escapeHtml(lead.name || "Контакт без імені")}</strong>
          ${where ? `<span class="warmup-subtle">${escapeHtml(where)}</span>` : ""}
        </div>
        <span class="warmup-subtle">${escapeHtml(lead.country || "—")}</span>
        ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">профіль</a>` : '<span class="warmup-subtle">без посилання на профіль</span>'}
      </li>`;
    })
    .join("")}</ul>`;
  refreshIcons();
}

/**
 * The waiting replies on this account, said next to its name.
 *
 * The nav badge counts every account at once, which answers "is anyone waiting"
 * but never "on which login" — and that is the question in front of somebody
 * looking at five profiles. Clicking it opens that account's group in the inbox
 * below rather than filtering, because the number and the threads it counts
 * should be one gesture apart.
 */
function warmupAccountUnreadHtml(accountId) {
  const unread = warmupInboxUnreadFor(accountId);
  if (!unread) return "";
  const label = `${warmupCount(unread)} ${uaPlural(unread, "нова відповідь", "нові відповіді", "нових відповідей")}`;
  return `<button class="warmup-account-unread" type="button" data-warmup-inbox-jump="${escapeAttr(accountId)}"
    title="${escapeAttr(`${label} на цьому акаунті — показати їх у вхідних`)}"><i data-lucide="mail"></i><span>${escapeHtml(label)}</span></button>`;
}

function renderWarmupProfiles() {
  const body = document.getElementById("warmupProfileTableBody");
  if (!body) return;

  if (!warmupState.profiles.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state">Профілів за цим запитом немає.</div></td></tr>';
    renderWarmupCampaignDetail();
    return;
  }

  // The tick column belongs to the selected campaign: an account works a
  // campaign, not "the targeting", and there is no second place that answers
  // which folder an account is on.
  const campaign = warmupSelectedCampaign();
  const ticked = warmupCampaignAccountIds(campaign);
  const tickable = Boolean(campaign) && warmupState.campaignsReady;
  const tickTitle = campaign
    ? `Вести «${campaign.name || "цю кампанію"}» з цього акаунта`
    : "Спочатку обери кампанію вгорі, потім познач акаунти, які її ведуть";

  body.innerHTML = warmupState.profiles
    .map((profile) => {
      const status = profile.status;
      const account = profile.account;
      // The person the browser is actually signed in as, which is not the same
      // string as the profile label somebody typed in Anty.
      const identity = profile.identity || account?.identity || null;
      return `
        <tr data-warmup-profile="${escapeHtml(profile.id)}" class="${profile.id === warmupState.selectedProfileId ? "is-selected" : ""}">
          <td class="warmup-tick">
            ${account
              ? `<input type="checkbox" data-warmup-account-tick="${escapeAttr(account.id)}" ${ticked.has(account.id) ? "checked" : ""} ${tickable ? "" : "disabled"} aria-label="Вести вибрану кампанію з акаунта ${escapeAttr(profile.name)}" title="${escapeAttr(tickTitle)}" />`
              : '<span class="warmup-subtle" title="Ще не на прогріві, тож із нього не можна надсилати">—</span>'}
          </td>
          <td>
            <strong>${escapeHtml(profile.name)}</strong>
            ${account ? warmupAccountUnreadHtml(account.id) : ""}
            ${identity?.name
              ? `<div class="warmup-identity" title="На останньому вході агента залогінений як ця особа"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}${identity.slug ? ` · ${escapeHtml(identity.slug)}` : ""}</span></div>`
              : ""}
            <div class="warmup-subtle">${escapeHtml(profile.owner || "—")}${profile.proxy ? " · через проксі" : " · без проксі"}</div>
          </td>
          <td><span class="pill ${WARMUP_STATUS_TONE[status] || "tone-muted"}">${escapeHtml(WARMUP_STATUS_LABEL[status] || status)}</span></td>
          <td>${escapeHtml(profile.day || "—")}</td>
          <td>${warmupConnectionsCell(profile)}</td>
          <td>${warmupNextSessionCell(profile)}</td>
          <td class="warmup-row-actions">
            ${account
              ? '<button class="text-button" type="button" data-warmup-open>Відкрити</button>'
              : '<button class="primary-button" type="button" data-warmup-adopt>Прогріти</button>'}
          </td>
        </tr>`;
    })
    .join("");

  renderWarmupCampaignDetail();
  refreshIcons();
}

function renderWarmupDetail() {
  const title = document.getElementById("warmupDetailTitle");
  const subtitle = document.getElementById("warmupDetailSubtitle");
  const body = document.getElementById("warmupDetailBody");
  if (!title || !body) return;

  const detail = warmupState.detail;
  if (!detail) {
    title.textContent = "Профіль";
    subtitle.textContent = "";
    body.innerHTML = '<div class="empty-state">Вибери профіль зі списку.</div>';
    refreshIcons();
    return;
  }

  const account = detail.account;
  const warmup = account.warmup;
  title.textContent = account.label;
  subtitle.textContent = warmup
    ? warmup.working
      ? `${warmup.strategyName} · робочий режим · день ${warmup.day}`
      : `${warmup.strategyName} · день ${warmup.day} з ${warmup.totalDays}${warmup.phase ? ` · ${warmup.phase}` : ""}`
    : "Ще не прогрівається";

  const actionRows = warmup && !warmup.finished
    ? (warmupState.config?.actionKinds || [])
        .map(({ kind, label }) => {
          const quota = warmup.quotas[kind] ?? 0;
          const done = warmup.done[kind] ?? 0;
          // A kind with no quota today is forbidden, not merely finished, so it
          // gets no button rather than a disabled-looking one.
          if (quota === 0) {
            return `<div class="warmup-action is-off"><span>${escapeHtml(label)}</span><em>сьогодні не можна</em></div>`;
          }
          return `
            <div class="warmup-action">
              <span>${escapeHtml(label)}</span>
              <strong>${done}/${quota}</strong>
              <button class="text-button" type="button" data-warmup-record="${escapeHtml(kind)}" ${done >= quota ? "disabled" : ""}>Записати одну</button>
            </div>`;
        })
        .join("")
    : "";

  const controls = [];
  if (account.status === "excluded") {
    controls.push('<button class="text-button" type="button" data-warmup-control="include">Повернути в список</button>');
  } else if (!warmup || warmup.state === "completed" || !warmup.runId) {
    controls.push('<button class="primary-button" type="button" data-warmup-control="start">Почати прогрів</button>');
    controls.push('<button class="text-button" type="button" data-warmup-control="exclude">Виключити</button>');
  } else if (warmup.state === "paused") {
    // The pause ends by itself; this is for ending it early.
    controls.push('<button class="primary-button" type="button" data-warmup-control="resume" title="Продовжити зараз, не чекаючи кінця паузи">Продовжити</button>');
    controls.push('<button class="danger-button" type="button" data-warmup-control="stop">Зупинити</button>');
  } else {
    controls.push('<button class="text-button" type="button" data-warmup-control="warning">Прилетіло попередження</button>');
    controls.push('<button class="danger-button" type="button" data-warmup-control="stop">Зупинити</button>');
  }

  const healthOptions = (warmupState.config?.healthValues || [])
    .map(({ value, label }) => `<option value="${escapeHtml(value)}" ${account.health === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");

  const rules = warmup?.rules?.length
    ? `<ul class="warmup-rules">${warmup.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}</ul>`
    : "";

  const sessions = detail.sessions.length
    ? detail.sessions
        .slice(0, 8)
        .map((session) => {
          const did = Object.entries(session.actions || {}).map(([kind, count]) => `${kind}: ${count}`).join(", ");
          return `<li><strong>${new Date(session.startedAt).toLocaleString()}</strong> · ${
            session.endedAt ? `${session.durationMin} хв` : "відкрита"
          } · ${escapeHtml(session.source)}${did ? ` · ${escapeHtml(did)}` : ""}</li>`;
        })
        .join("")
    : "<li>Сесій ще не записано.</li>";

  const events = detail.events.length
    ? detail.events
        .slice(0, 12)
        .map((event) => `<li class="level-${escapeHtml(event.level)}"><span>${new Date(event.created_at).toLocaleString()}</span> ${escapeHtml(event.message)}</li>`)
        .join("")
    : "<li>У лозі ще порожньо.</li>";

  body.innerHTML = `
    <div class="warmup-detail-controls">${controls.join("")}</div>
    ${warmup?.state === "paused" && warmup.pausedUntil ? `<p class="warmup-paused">На паузі після попередження: до ${escapeHtml(warmup.pausedUntil)} включно акаунт нічого не робить. Далі прогрів продовжиться сам, а дні паузи в нього не рахуються.</p>` : ""}
    ${actionRows ? `<div class="warmup-actions">${actionRows}</div>` : ""}
    ${rules}
    <div class="warmup-health">
      <label for="warmupHealthSelect">Стан</label>
      <select id="warmupHealthSelect">${healthOptions}</select>
      <input id="warmupHealthNote" type="text" placeholder="Що ти побачив?" value="${escapeHtml(account.healthNote || "")}" />
      <button class="text-button" type="button" data-warmup-health>Зберегти</button>
    </div>
    <h3>Сесії</h3>
    <ul class="warmup-sessions">${sessions}</ul>
    <h3>Лог</h3>
    <ul class="warmup-events">${events}</ul>
  `;
  refreshIcons();
}

/**
 * Folders and the campaigns, in one round. Both are allowed to be missing —
 * the server may not carry them yet — and the panel says so rather than
 * pretending there are no campaigns.
 */
async function loadWarmupCampaigns({ resetForm = true } = {}) {
  const [folders, campaigns] = await Promise.allSettled([
    warmupApi("/folders"),
    warmupApi("/campaigns")
  ]);

  const problems = [];
  if (folders.status === "fulfilled") {
    warmupState.folders = folders.value.folders || [];
    warmupState.foldersReady = true;
  } else {
    warmupState.foldersReady = false;
    problems.push(folders.reason?.status === 404
      ? "Цей сервер ще не віддає список папок, тож тут не вибрати папку."
      : `Список папок не вдалося прочитати: ${folders.reason?.message}`);
  }

  if (campaigns.status === "fulfilled") {
    warmupState.campaigns = campaigns.value.campaigns || [];
    warmupState.campaignsReady = true;
  } else {
    warmupState.campaignsReady = false;
    warmupState.campaigns = [];
    problems.push(campaigns.reason?.status === 404
      ? "Цей сервер ще не тримає кампаній, тож створене тут не збережеться."
      : `Кампанії не вдалося прочитати: ${campaigns.reason?.message}`);
  }
  warmupState.campaignsError = problems.join(" ");

  // A selection that no longer exists is not a selection. Falling back to the
  // first campaign keeps the forecast on screen rather than emptying the panel.
  if (!warmupCampaignById(warmupState.selectedCampaignId)) {
    warmupState.selectedCampaignId = warmupState.campaigns[0]?.id || null;
  }
  if (warmupState.formOpen && warmupState.formCampaignId && !warmupCampaignById(warmupState.formCampaignId)) {
    warmupState.formOpen = false;
    warmupState.formCampaignId = null;
  }

  renderWarmupCampaigns({ resetForm });
  renderWarmupProfiles();
}

/**
 * Show one campaign's own answer immediately. It is not the whole answer:
 * `progressApproximate` and the order ranks are about how campaigns relate to
 * each other, so a write that can change a folder or an account is followed by
 * a reload of the list rather than left as one fresh row among stale ones.
 */
function spliceWarmupCampaign(campaign) {
  if (!campaign?.id) return;
  const index = warmupState.campaigns.findIndex((item) => item.id === campaign.id);
  if (index === -1) warmupState.campaigns.push(campaign);
  else warmupState.campaigns[index] = campaign;
}

function openWarmupCampaignForm(campaignId = null) {
  const moved = Boolean(campaignId) && warmupState.selectedCampaignId !== campaignId;
  warmupState.formOpen = true;
  warmupState.formCampaignId = campaignId;
  warmupState.campaignNotice = "";
  if (campaignId) warmupState.selectedCampaignId = campaignId;
  renderWarmupCampaigns({ resetForm: true });
  renderWarmupProfiles();
  renderWarmupQueue();
  // «Редагувати» on another campaign selects it, and the queue and the pool
  // below have to follow — they were loaded for the one selected before.
  if (moved) {
    loadWarmupQueues();
    loadWarmupLeads();
  }
  document.getElementById("warmupCampaignName")?.focus();
}

function closeWarmupCampaignForm() {
  warmupState.formOpen = false;
  warmupState.formCampaignId = null;
  warmupState.campaignNotice = "";
  renderWarmupCampaigns();
}

async function saveWarmupCampaignForm() {
  if (!warmupState.campaignsReady || warmupState.savingCampaign) return;
  const form = warmupFormValues();
  const editing = warmupEditingCampaign();

  if (!form.folderId) {
    warmupState.campaignNotice = "Спочатку обери папку — кампанії треба звідкись брати людей.";
    renderWarmupCampaigns();
    return;
  }
  if (!form.name) {
    warmupState.campaignNotice = "Дай їй назву — список кампаній без назв ніхто не прочитає.";
    renderWarmupCampaigns();
    return;
  }

  warmupState.savingCampaign = true;
  warmupState.campaignNotice = "";
  renderWarmupCampaigns();

  let saved = false;
  try {
    const body = {
      name: form.name,
      folderId: form.folderId,
      filters: form.filters,
      productId: form.productId || null,
      // Порожнє поле — це «як було» для збереженої кампанії і сім для нової;
      // решту перевіряє сервер і відповідає реченням, яке видно у формі.
      ...(form.fromDay === "" ? {} : { fromDay: form.fromDay })
    };
    const payload = editing
      ? await warmupApi("/campaigns", { method: "PATCH", body: JSON.stringify({ id: editing.id, ...body }) })
      : await warmupApi("/campaigns", { method: "POST", body: JSON.stringify(body) });
    const campaign = payload.campaign;
    if (campaign) {
      spliceWarmupCampaign(campaign);
      warmupState.selectedCampaignId = campaign.id;
    }
    saved = true;
  } catch (error) {
    // Kept in the panel rather than the page-wide note: this is about the
    // campaign somebody just wrote, not about the warm-up being broken.
    warmupState.campaignNotice = error.message;
  } finally {
    warmupState.savingCampaign = false;
  }

  if (saved) {
    warmupState.formOpen = false;
    warmupState.formCampaignId = null;
  }
  renderWarmupCampaigns({ resetForm: true });
  renderWarmupProfiles();
  if (saved) await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
  if (saved) await loadWarmupLeads();
}

/** Start, pause, reopen, mark done — all one PATCH of `state`. */
async function setWarmupCampaignState(campaignId, nextState) {
  const campaign = warmupCampaignById(campaignId);
  if (!campaign || campaign.state === nextState) return;
  try {
    const payload = await warmupApi("/campaigns", {
      method: "PATCH",
      body: JSON.stringify({ id: campaignId, state: nextState })
    });
    if (payload.campaign) spliceWarmupCampaign(payload.campaign);
    warmupState.campaignNotice = "";
  } catch (error) {
    warmupState.campaignNotice = error.message;
  }
  // The order ranks are relative, so one campaign starting renumbers the rest.
  await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
  await loadWarmupLeads();
}

/**
 * Moving a campaign one place up or down the order.
 *
 * `order` is a position, not a number to be compared: PATCHing it puts the
 * campaign at that index and renumbers the rest around it, so one write does
 * the whole move and the list stays a dense 0..n-1 with nothing sharing a
 * place. Past either end is that end, so a move from the last row needs no
 * clamping beyond the disabled button.
 *
 * Every other row's position changes too, which is why this reloads the list
 * rather than splicing the one campaign that came back.
 */
async function moveWarmupCampaign(campaignId, direction) {
  const index = warmupState.campaigns.findIndex((item) => item.id === campaignId);
  const target = index + (direction === "up" ? -1 : 1);
  if (index === -1 || target < 0 || target >= warmupState.campaigns.length) return;
  if (warmupState.savingCampaign) return;

  warmupState.savingCampaign = true;
  renderWarmupCampaigns();

  try {
    await warmupApi("/campaigns", {
      method: "PATCH",
      body: JSON.stringify({ id: campaignId, order: target })
    });
    warmupState.campaignNotice = "";
  } catch (error) {
    warmupState.campaignNotice = error.message;
  } finally {
    warmupState.savingCampaign = false;
  }

  await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
  await loadWarmupLeads();
}

/**
 * Deleting releases every claim its accounts hold; what was already sent stays,
 * because history is not the campaign's to delete. Both halves are said before
 * anything is removed.
 */
async function deleteWarmupCampaign(campaignId) {
  const campaign = warmupCampaignById(campaignId);
  if (!campaign) return;
  const queued = Number(campaign.progress?.queued) || 0;
  const sent = Number(campaign.progress?.sent) || 0;
  const consequence = [
    queued ? `${warmupCount(queued)} закріплених, але не надісланих, ${uaPlural(queued, "людина повертається", "людини повертаються", "людей повертаються")} в пул` : "",
    sent ? `${warmupCount(sent)} уже надісланих ${uaPlural(sent, "лишається", "лишаються", "лишаються")} в історії` : ""
  ].filter(Boolean).join(", ");
  if (!window.confirm(`Видалити «${campaign.name || "цю кампанію"}»?${consequence ? `\n\n${consequence}.` : ""}`)) return;

  try {
    const payload = await warmupApi(`/campaigns?id=${encodeURIComponent(campaignId)}`, { method: "DELETE" });
    warmupState.campaigns = warmupState.campaigns.filter((item) => item.id !== campaignId);
    const released = Number(payload?.released) || 0;
    warmupState.campaignNotice = released
      ? `${warmupCount(released)} закріплених ${uaPlural(released, "людина знову в пулі", "людини знову в пулі", "людей знову в пулі")}.`
      : "";
    if (warmupState.selectedCampaignId === campaignId) {
      warmupState.selectedCampaignId = warmupState.campaigns[0]?.id || null;
    }
    if (warmupState.formCampaignId === campaignId) {
      warmupState.formOpen = false;
      warmupState.formCampaignId = null;
    }
  } catch (error) {
    warmupState.campaignNotice = error.message;
  }
  renderWarmupCampaigns();
  renderWarmupProfiles();
  await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
  await loadWarmupLeads();
}

function selectWarmupCampaign(campaignId) {
  if (warmupState.selectedCampaignId === campaignId) return;
  warmupState.selectedCampaignId = campaignId;
  warmupState.campaignNotice = "";
  // Editing one campaign while another is selected would leave the tick column
  // answering for a campaign the form is not about.
  if (warmupState.formOpen && warmupState.formCampaignId !== campaignId) {
    warmupState.formOpen = false;
    warmupState.formCampaignId = null;
  }
  renderWarmupCampaigns();
  renderWarmupProfiles();
  loadWarmupQueues();
  loadWarmupLeads();
}

/** Ticking an account is itself a save: the forecast has to follow the tick. */
function toggleWarmupAccount(accountId, on) {
  const campaign = warmupSelectedCampaign();
  if (!campaign) {
    warmupState.campaignNotice = "Спочатку обери кампанію вгорі — акаунт веде кампанію, а не окрему папку.";
    renderWarmupCampaigns();
    renderWarmupProfiles();
    return;
  }
  const ids = warmupCampaignAccountIds(campaign);
  if (on) ids.add(accountId);
  else ids.delete(accountId);
  const accountIds = Array.from(ids);

  // Shown before it is saved, then corrected by whatever comes back: a tick
  // that waits for a round trip reads as a click that did not land.
  spliceWarmupCampaign({ ...campaign, accountIds });
  saveWarmupCampaignAccounts(campaign.id, accountIds);
}

async function saveWarmupCampaignAccounts(campaignId, accountIds) {
  // A second tick while the first save is still in flight is not a lost click,
  // it is the next thing to save — otherwise ticking two accounts quickly
  // leaves the second one on screen and absent from the server.
  if (warmupState.savingCampaign) {
    warmupState.pendingAccountIds = { campaignId, accountIds };
    renderWarmupCampaigns();
    renderWarmupProfiles();
    return;
  }

  warmupState.savingCampaign = true;
  warmupState.campaignNotice = "";
  renderWarmupCampaigns();
  renderWarmupProfiles();

  try {
    const payload = await warmupApi("/campaigns", {
      method: "PATCH",
      body: JSON.stringify({ id: campaignId, accountIds })
    });
    if (payload.campaign) spliceWarmupCampaign(payload.campaign);
  } catch (error) {
    warmupState.campaignNotice = error.message;
    // Put back whatever the server still believes, rather than leaving a tick
    // on screen that nothing behind it agrees with.
    await loadWarmupCampaigns({ resetForm: false });
  } finally {
    warmupState.savingCampaign = false;
  }

  renderWarmupCampaigns();
  renderWarmupProfiles();

  if (warmupState.pendingAccountIds) {
    const next = warmupState.pendingAccountIds;
    warmupState.pendingAccountIds = null;
    await saveWarmupCampaignAccounts(next.campaignId, next.accountIds);
    return;
  }
  // An account joining a campaign can make another campaign's count
  // approximate, so the whole list is re-read once the ticks have settled.
  await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
}

/* ── Claiming ──────────────────────────────────────────────────────────────
 *
 * A claim allocates a person to an account; it spends no quota, and it is not
 * a send. What comes back when nothing can be claimed is a sentence, and that
 * sentence is the answer — it gets rendered where the list would have been.
 */

async function loadWarmupQueue(accountId) {
  // The campaign on screen, so the server answers whether *this* one feeds
  // the account by itself today, and from which day it will.
  const campaignId = warmupState.selectedCampaignId || "";
  try {
    const payload = await warmupApi(`/queue?accountId=${encodeURIComponent(accountId)}${campaignId ? `&campaignId=${encodeURIComponent(campaignId)}` : ""}`);
    // Somebody picked another campaign while this was on its way: its answer
    // is about the old one, and the new one's request is already out.
    if (!queueAnswerIsCurrent(campaignId, warmupState.selectedCampaignId)) return;
    warmupState.queues[accountId] = {
      rows: payload.queue || payload.claimed || [],
      reason: payload.reason || "",
      waiting: payload.waiting || [],
      autoFeed: payload.autoFeed || null,
      error: "",
      unavailable: ""
    };
  } catch (error) {
    if (!queueAnswerIsCurrent(campaignId, warmupState.selectedCampaignId)) return;
    warmupState.queues[accountId] = {
      rows: [],
      reason: "",
      // A 409 is the server refusing this account outright — excluded, not
      // warming, paused. That is an answer too, and it carries only `error`.
      error: error.status === 404 ? "" : error.message,
      unavailable: error.status === 404
        ? "Цей сервер ще не тримає черги закріплень, тож звідси нічого не закріпити."
        : ""
    };
  }
}

async function loadWarmupQueues() {
  const campaign = warmupSelectedCampaign();
  const accountIds = campaign?.accountIds || [];
  if (!accountIds.length) {
    renderWarmupQueue();
    return;
  }
  await Promise.all(accountIds.map((id) => loadWarmupQueue(id)));
  renderWarmupQueue();
}

async function claimWarmupQueue(accountId) {
  if (warmupState.queueBusy[accountId]) return;
  warmupState.queueBusy[accountId] = true;
  renderWarmupQueue();

  try {
    const payload = await warmupApi("/campaigns/claim", {
      method: "POST",
      body: JSON.stringify({ accountId })
    });
    const claimed = payload.claimed || [];
    const existing = warmupState.queues[accountId]?.rows || [];
    warmupState.queues[accountId] = {
      ...(warmupState.queues[accountId] || {}),
      // Oldest first, as the queue itself is ordered.
      rows: existing.concat(claimed),
      reason: payload.reason || "",
      // Every claim first releases what expired. If that moved anything, the
      // queue just shrank under somebody's feet and they should hear why.
      released: Number(payload.released) || 0,
      error: "",
      unavailable: ""
    };
  } catch (error) {
    // Everything the card already showed stays: the auto-feed line and who is
    // waiting for the agent are still true when a claim fails.
    warmupState.queues[accountId] = queueAfterFailedClaim(warmupState.queues[accountId], error);
  } finally {
    warmupState.queueBusy[accountId] = false;
  }

  renderWarmupQueue();
  // Claiming changes what is left and what is held, so the row above has to
  // follow it.
  await loadWarmupCampaigns({ resetForm: false });
  renderWarmupQueue();
}

/**
 * The one place a request is recorded. It marks a real person as approached,
 * once and for good, so it asks first and says who.
 */
async function takeWarmupQueueLead(accountId, crmContactId, name) {
  if (!accountId || !crmContactId) return;
  if (!window.confirm(`Записати запит на контакт до ${name || "цього контакту"}?\n\nЦе назавжди позначає, що до цієї людини вже зверталися — для кожного акаунта й кожної кампанії.`)) return;

  try {
    await warmupApi("/leads/take", {
      method: "POST",
      body: JSON.stringify({ accountId, crmContactId })
    });
    const queue = warmupState.queues[accountId];
    if (queue) {
      queue.rows = (queue.rows || []).filter((row) => row.crmContactId !== crmContactId);
    }
  } catch (error) {
    if (warmupState.queues[accountId]) warmupState.queues[accountId].error = error.message;
    else warmupState.queues[accountId] = { rows: [], reason: "", error: error.message, unavailable: "" };
  }

  renderWarmupQueue();
  await loadWarmup({ full: false });
}

async function loadWarmupLeads() {
  try {
    // The pool belongs to the campaign on screen. Left to itself the server
    // answers for the first running one, which is a different folder from the
    // one somebody is looking at as soon as there are two campaigns.
    const campaignId = warmupState.selectedCampaignId;
    const params = new URLSearchParams({ limit: "10" });
    if (campaignId) params.set("campaignId", campaignId);
    const payload = await warmupApi(`/leads?${params}`);
    warmupState.leads = payload.leads || [];
    warmupState.leadsTotal = Number.isFinite(payload.queueTotal) ? payload.queueTotal : null;
    warmupState.leadsTargeting = payload.campaign || payload.targeting || null;
    warmupState.leadsPrompt = "";
    warmupState.leadsError = "";
    warmupState.leadsReady = true;
  } catch (error) {
    warmupState.leads = [];
    warmupState.leadsTotal = null;
    warmupState.leadsPrompt = "";
    warmupState.leadsError = "";
    // 409 is the server saying there is no campaign yet. That is a prompt, and
    // drawing it in red would be calling the user's unfinished setup a fault.
    if (error.payload?.needsCampaign || error.payload?.needsTargeting || error.status === 409) {
      warmupState.leadsReady = true;
      warmupState.leadsPrompt = error.message || "Створи кампанію, перш ніж тягнути лідів";
    } else if (error.status === 404) {
      warmupState.leadsReady = false;
    } else {
      warmupState.leadsReady = true;
      warmupState.leadsError = error.message;
    }
  }
  renderWarmupLeads();
}

async function loadWarmupProfiles() {
  const search = document.getElementById("warmupSearchInput")?.value.trim() || "";
  const platform = document.getElementById("warmupPlatformSelect")?.value || "linkedin";
  const params = new URLSearchParams({ platform });
  if (search) params.set("q", search);

  const payload = await warmupApi(`/profiles?${params}`);
  warmupState.profiles = payload.profiles;
  renderWarmupProfiles();
}

async function loadWarmupAccountDetail(accountId) {
  if (!accountId) {
    warmupState.detail = null;
    renderWarmupDetail();
    return;
  }
  const [accountPayload, sessionsPayload, eventsPayload] = await Promise.all([
    warmupApi(`/accounts?id=${encodeURIComponent(accountId)}`),
    warmupApi(`/sessions?accountId=${encodeURIComponent(accountId)}`),
    warmupApi(`/events?accountId=${encodeURIComponent(accountId)}&limit=30`)
  ]);
  warmupState.detail = {
    account: accountPayload.account,
    sessions: sessionsPayload.sessions,
    events: eventsPayload.events
  };
  renderWarmupDetail();
}

/* ── The schedule ──────────────────────────────────────────────────────────
 *
 * One strategy governs every account, and until now it was only readable as
 * the number in the Day column and whatever the agent happened to do. This is
 * the same thing as a table: fourteen days, and for each of them how many
 * profile views, likes and connection requests are allowed, plus whether a
 * request may carry a note.
 *
 * Two things this panel must not pretend.
 *
 * A quota is a range, not a number: the agent picks within it, seeded on the
 * account and the day, so that four accounts do not perform the same five
 * views every morning. The editor therefore edits two numbers per action, and
 * calls them «від» and «до».
 *
 * And an edit does not reach the accounts already warming. A run keeps the
 * snapshot of the strategy it started under, which is what stops a change today
 * from rewriting what an account halfway through was working to. The panel says
 * so where somebody is about to save, not in a tooltip.
 */

/** The three actions this system actually performs. Others are kept, not shown. */
const WARMUP_EDITABLE_KINDS = ["profile_view", "like", "connect"];

const WARMUP_KIND_LABEL = {
  profile_view: "Перегляди профілів",
  like: "Лайки",
  connect: "Запити в друзі"
};

function warmupStrategyDays() {
  return warmupState.strategyDraft || warmupState.strategy?.days || [];
}

/** Has anything been moved since this draft was opened? */
function warmupStrategyDirty() {
  if (!warmupState.strategyDraft || !warmupState.strategy) return false;
  return JSON.stringify(warmupState.strategyDraft) !== JSON.stringify(warmupState.strategy.days || []);
}

function warmupQuotaCell(day, kind) {
  const [low = 0, high = 0] = day.quotas?.[kind] || [];
  const disabled = warmupState.strategyBusy ? "disabled" : "";
  return `<td class="warmup-day-quota">
    <input type="number" min="0" max="99" value="${Number(low) || 0}" ${disabled}
      data-warmup-day="${day.day}" data-warmup-kind="${escapeAttr(kind)}" data-warmup-bound="low"
      aria-label="${escapeAttr(`${WARMUP_KIND_LABEL[kind]}, день ${day.day}, від`)}" />
    <span aria-hidden="true">–</span>
    <input type="number" min="0" max="99" value="${Number(high) || 0}" ${disabled}
      data-warmup-day="${day.day}" data-warmup-kind="${escapeAttr(kind)}" data-warmup-bound="high"
      aria-label="${escapeAttr(`${WARMUP_KIND_LABEL[kind]}, день ${day.day}, до`)}" />
  </td>`;
}

function warmupStrategyRowHtml(day, previous) {
  // A phase is a run of days that say the same thing, so the label is printed
  // where it changes and left out where it repeats — the table then shows the
  // phases without being built out of them.
  const opens = !previous || previous.label !== day.label;
  const note = day.connectionNote && typeof day.connectionNote === "object";
  const allowsConnect = (day.quotas?.connect || [0, 0])[1] > 0;

  return `<tr class="${opens ? "is-phase-start" : ""}">
    <th scope="row">
      <strong>День ${day.day}</strong>
      ${opens ? `<span class="warmup-subtle">${escapeHtml(day.label || "без назви")}</span>` : ""}
    </th>
    ${WARMUP_EDITABLE_KINDS.map((kind) => warmupQuotaCell(day, kind)).join("")}
    <td class="warmup-day-note">
      <label title="${escapeAttr(allowsConnect
        ? "Чи можна цього дня додавати коротку нотатку до запиту"
        : "Цього дня запитів немає, тож нотатці нема на чому їхати")}">
        <input type="checkbox" ${note ? "checked" : ""} ${warmupState.strategyBusy || !allowsConnect ? "disabled" : ""}
          data-warmup-day="${day.day}" data-warmup-note="1"
          aria-label="${escapeAttr(`Нотатка до запиту, день ${day.day}`)}" />
        <span>${note ? `до ${Number(day.connectionNote.maxWords) || 3} слів` : "без нотатки"}</span>
      </label>
    </td>
  </tr>`;
}

function renderWarmupStrategy() {
  const pill = document.getElementById("warmupStrategyPill");
  const subtitle = document.getElementById("warmupStrategySubtitle");
  const toggle = document.getElementById("warmupStrategyToggleBtn");
  const body = document.getElementById("warmupStrategyBody");
  if (!body || !pill || !toggle) return;

  const strategy = warmupState.strategy;
  const days = warmupStrategyDays();

  if (toggle) {
    toggle.hidden = !strategy;
    toggle.innerHTML = warmupState.strategyOpen
      ? '<i data-lucide="chevron-up"></i><span>Згорнути</span>'
      : '<i data-lucide="chevron-down"></i><span>Відкрити деталі</span>';
  }

  if (warmupState.strategyError && !strategy) {
    pill.className = "pill tone-bad";
    pill.textContent = "недоступно";
    body.hidden = false;
    body.innerHTML = `<div class="warmup-leads-prompt is-bad"><strong>${escapeHtml(warmupState.strategyError)}</strong>
      <span>Доки так, розклад звідси не змінити. Акаунти, які вже прогріваються, працюють за тим, з яким почали.</span></div>`;
    refreshIcons();
    return;
  }

  if (!strategy) {
    pill.className = "pill tone-muted";
    pill.textContent = "завантаження";
    body.hidden = true;
    body.innerHTML = "";
    return;
  }

  const phases = new Set(days.map((day) => day.label)).size;
  pill.className = "pill tone-live";
  pill.textContent = `${days.length} ${uaPlural(days.length, "день", "дні", "днів")} · ${phases} ${uaPlural(phases, "фаза", "фази", "фаз")}`;
  if (subtitle) {
    subtitle.textContent = strategy.name
      ? `${strategy.name} — одна на всі акаунти: скільки чого дозволено кожного дня`
      : "Одна на всі акаунти: скільки чого дозволено кожного дня";
  }

  body.hidden = !warmupState.strategyOpen;
  if (!warmupState.strategyOpen) {
    body.innerHTML = "";
    return;
  }

  const dirty = warmupStrategyDirty();
  const notice = warmupState.strategyNotice
    ? `<p class="warmup-strategy-notice">${escapeHtml(warmupState.strategyNotice)}</p>`
    : "";
  const problem = warmupState.strategyError
    ? `<p class="warmup-strategy-problem">${escapeHtml(warmupState.strategyError)}</p>`
    : "";

  body.innerHTML = `
    <p class="warmup-strategy-lead">Кожна цифра — це діапазон: агент щодня бере число всередині нього, окреме для кожного акаунта, щоб чотири акаунти не робили щоранку однакові п'ять переглядів. Нуль означає, що цього дня така дія заборонена.</p>
    <div class="table-wrap">
      <table class="warmup-strategy-table">
        <thead>
          <tr>
            <th>День</th>
            ${WARMUP_EDITABLE_KINDS.map((kind) => `<th>${escapeHtml(WARMUP_KIND_LABEL[kind])}</th>`).join("")}
            <th>Нотатка до запиту</th>
          </tr>
        </thead>
        <tbody>${days.map((day, index) => warmupStrategyRowHtml(day, days[index - 1])).join("")}</tbody>
      </table>
    </div>
    ${problem}${notice}
    <div class="warmup-strategy-foot">
      <button class="primary-button" type="button" id="warmupStrategySaveBtn" ${dirty && !warmupState.strategyBusy ? "" : "disabled"}>
        <i data-lucide="save"></i><span>${warmupState.strategyBusy ? "Зберігаємо..." : "Зберегти розклад"}</span>
      </button>
      <button class="text-button" type="button" id="warmupStrategyResetBtn" ${dirty && !warmupState.strategyBusy ? "" : "disabled"}>
        <i data-lucide="undo-2"></i><span>Скасувати зміни</span>
      </button>
      <p class="warmup-strategy-warning">Зміни діють на прогони, які почнуться після збереження. Акаунт, який уже прогрівається, доживе свої дні за тим розкладом, з яким стартував, — інакше правки сьогодні переписували б те, під що він уже працював.</p>
    </div>`;
  refreshIcons();
}

/** One number moved in the draft, without touching what is saved. */
function editWarmupStrategyDay(day, apply) {
  if (!warmupState.strategyDraft) {
    warmupState.strategyDraft = JSON.parse(JSON.stringify(warmupState.strategy?.days || []));
  }
  const row = warmupState.strategyDraft.find((entry) => entry.day === day);
  if (!row) return;
  apply(row);
  warmupState.strategyError = "";
  warmupState.strategyNotice = "";
}

async function loadWarmupStrategy() {
  try {
    const payload = await warmupApi("/strategies");
    const list = Array.isArray(payload.strategies) ? payload.strategies : [];
    // The default is the one every account runs unless somebody pointed it
    // elsewhere; with none marked, the first is the only candidate there is.
    warmupState.strategy = list.find((row) => row.isDefault) || list[0] || null;
    warmupState.strategyError = warmupState.strategy ? "" : "Цей сервер не має жодної стратегії прогріву.";
  } catch (error) {
    warmupState.strategy = null;
    warmupState.strategyError = error.message || "Стратегію не вдалося прочитати.";
  }
  warmupState.strategyDraft = null;
  renderWarmupStrategy();
}

async function saveWarmupStrategy() {
  const strategy = warmupState.strategy;
  const days = warmupState.strategyDraft;
  if (!strategy || !days || warmupState.strategyBusy) return;

  warmupState.strategyBusy = true;
  warmupState.strategyError = "";
  warmupState.strategyNotice = "";
  renderWarmupStrategy();

  try {
    // Days go up, phases come back: folding neighbouring days into phases is
    // the server's half, and doing it here too would be a second answer.
    const payload = await warmupApi("/strategies", {
      method: "PATCH",
      body: JSON.stringify({
        id: strategy.id,
        name: strategy.name,
        description: strategy.description,
        pauseDays: strategy.pauseDays,
        days
      })
    });
    warmupState.strategy = { ...payload.strategy, days, totalDays: days.length };
    warmupState.strategyDraft = null;
    warmupState.strategyNotice = "Розклад збережено. Він діє на прогони, які почнуться далі.";
    // Re-read rather than trust the echo: the fold may have merged days, and
    // what the next account starts on is whatever the server now holds.
    await loadWarmupStrategy();
    warmupState.strategyNotice = "Розклад збережено. Він діє на прогони, які почнуться далі.";
  } catch (error) {
    warmupState.strategyError = error.message || "Розклад не зберігся.";
  } finally {
    warmupState.strategyBusy = false;
    renderWarmupStrategy();
  }
}

document.getElementById("warmupStrategyToggleBtn")?.addEventListener("click", () => {
  warmupState.strategyOpen = !warmupState.strategyOpen;
  renderWarmupStrategy();
});

document.getElementById("warmupStrategyBody")?.addEventListener("change", (event) => {
  const field = event.target.closest("[data-warmup-day]");
  if (!field) return;
  const day = Number(field.dataset.warmupDay);

  if (field.dataset.warmupNote) {
    editWarmupStrategyDay(day, (row) => {
      row.connectionNote = field.checked ? { maxWords: 3, allowLinks: false } : false;
    });
    renderWarmupStrategy();
    return;
  }

  const kind = field.dataset.warmupKind;
  const bound = field.dataset.warmupBound;
  const value = Math.max(0, Math.min(99, Math.round(Number(field.value) || 0)));
  editWarmupStrategyDay(day, (row) => {
    const [low = 0, high = 0] = row.quotas?.[kind] || [];
    const next = bound === "low" ? [value, Math.max(value, high)] : [Math.min(low, value), value];
    row.quotas = { ...row.quotas };
    // Zero to zero is "not allowed today", and it is stored as the absence of
    // the action rather than as a range of nothing — the same shape the shipped
    // strategy uses for a day that forbids something.
    if (next[0] === 0 && next[1] === 0) delete row.quotas[kind];
    else row.quotas[kind] = next;
    if (!row.quotas.connect) row.connectionNote = false;
  });
  renderWarmupStrategy();
});

document.getElementById("warmupStrategyBody")?.addEventListener("click", (event) => {
  if (event.target.closest("#warmupStrategySaveBtn")) {
    saveWarmupStrategy();
    return;
  }
  if (event.target.closest("#warmupStrategyResetBtn")) {
    warmupState.strategyDraft = null;
    warmupState.strategyError = "";
    warmupState.strategyNotice = "";
    renderWarmupStrategy();
  }
});

async function loadWarmup({ full = true } = {}) {
  if (warmupState.busy) return;
  warmupState.busy = true;
  warmupState.error = "";
  try {
    if (full || !warmupState.config) {
      warmupState.config = await warmupApi("/config");
    }
    renderWarmupConfigNote();
    if (Number.isFinite(warmupState.config?.unreadReplies)) setWarmupUnread(warmupState.config.unreadReplies);
    if (!warmupState.config.configured) {
      warmupState.profiles = [];
      warmupState.foldersReady = false;
      warmupState.campaignsReady = false;
      warmupState.campaignsError = "Прогрів на цьому сервері не налаштований, тож немає папок, на яких будувати кампанію.";
      // The schedule lives in the Anty database too, so it is unreachable for
      // the same reason — and has to say so. Left alone it sat on its loading
      // text for good, which reads as a panel that is still trying.
      warmupState.strategy = null;
      warmupState.strategyDraft = null;
      warmupState.strategyError = "Розклад лежить у базі Anty, а цей сервер до неї не підключений — тож і днів тут показати нізвідки.";
      // Nothing can have arrived on accounts this server cannot even reach, and
      // the config note above already says why. An inbox promising otherwise
      // would be a second, softer answer to the same question.
      warmupState.inbox.available = false;
      renderWarmupProfiles();
      renderWarmupStats();
      renderWarmupInbox();
      renderWarmupStrategy();
      renderWarmupCampaigns();
      renderWarmupQueue();
      return;
    }

    // Reconciling Anty's "profile is running" flag with the sessions table is
    // what makes the Sessions column true; it is cheap and idempotent, so the
    // screen does it on every load rather than relying on somebody remembering.
    await warmupApi("/sync", { method: "POST" }).catch(() => null);

    warmupState.dashboard = await warmupApi("/dashboard");
    renderWarmupStats();
    // The inbox before the plan: it is the top panel, it depends on nothing
    // else here, and it is the one thing on this screen somebody else wrote.
    await loadWarmupInbox();
    // The schedule every account runs on. It depends on nothing else here and
    // nothing here depends on it, so it is read once and left alone.
    await loadWarmupStrategy();
    // Campaigns first: the tick column in the profiles table is drawn from the
    // selected one, and the queue below is drawn from its accounts.
    await loadWarmupCampaigns({ resetForm: full });
    await loadWarmupProfiles();
    await loadWarmupQueues();
    await loadWarmupLeads();
    if (warmupState.selectedAccountId) await loadWarmupAccountDetail(warmupState.selectedAccountId);
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  } finally {
    warmupState.busy = false;
    refreshIcons();
  }
}

async function warmupControl(action, extra = {}) {
  if (!warmupState.selectedAccountId) return;
  try {
    await warmupApi("/control", {
      method: "POST",
      body: JSON.stringify({ accountId: warmupState.selectedAccountId, action, ...extra })
    });
    await loadWarmup({ full: false });
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  }
}

async function selectWarmupProfile(profileId) {
  const profile = warmupState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  warmupState.selectedProfileId = profileId;
  warmupState.selectedAccountId = profile.account?.id || null;
  renderWarmupProfiles();
  await loadWarmupAccountDetail(warmupState.selectedAccountId);
}

/** Put a profile on warm-up: create its account, then start the run. */
async function adoptWarmupProfile(profileId) {
  const profile = warmupState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  try {
    const created = await warmupApi("/accounts", {
      method: "POST",
      body: JSON.stringify({ label: profile.name, profileRemoteId: profile.id })
    });
    warmupState.selectedProfileId = profile.id;
    warmupState.selectedAccountId = created.account.id;
    await warmupControl("start");
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  }
}

document.getElementById("warmupRefreshBtn")?.addEventListener("click", () => loadWarmup());
document.getElementById("warmupPlatformSelect")?.addEventListener("change", () => loadWarmupProfiles());
document.getElementById("warmupSearchInput")?.addEventListener("input", () => {
  clearTimeout(warmupState.searchTimer);
  warmupState.searchTimer = setTimeout(() => loadWarmupProfiles(), 250);
});

document.getElementById("warmupProfileTableBody")?.addEventListener("change", (event) => {
  const tick = event.target.closest("[data-warmup-account-tick]");
  if (!tick) return;
  toggleWarmupAccount(tick.dataset.warmupAccountTick, tick.checked);
});

document.getElementById("warmupProfileTableBody")?.addEventListener("click", (event) => {
  // Ticking an account is not the same gesture as opening it.
  if (event.target.closest("[data-warmup-account-tick]")) return;
  const jump = event.target.closest("[data-warmup-inbox-jump]");
  if (jump) {
    event.stopPropagation();
    showWarmupInboxAccount(jump.dataset.warmupInboxJump);
    return;
  }
  const row = event.target.closest("[data-warmup-profile]");
  if (!row) return;
  const profileId = row.dataset.warmupProfile;
  if (event.target.closest("[data-warmup-adopt]")) {
    adoptWarmupProfile(profileId);
    return;
  }
  selectWarmupProfile(profileId);
});

document.getElementById("warmupDetailBody")?.addEventListener("click", (event) => {
  const control = event.target.closest("[data-warmup-control]");
  if (control) {
    warmupControl(control.dataset.warmupControl);
    return;
  }
  const record = event.target.closest("[data-warmup-record]");
  if (record) {
    warmupControl("record", { kind: record.dataset.warmupRecord });
    return;
  }
  if (event.target.closest("[data-warmup-health]")) {
    const health = document.getElementById("warmupHealthSelect")?.value;
    const note = document.getElementById("warmupHealthNote")?.value || "";
    warmupApi("/accounts/health", {
      method: "POST",
      body: JSON.stringify({ accountId: warmupState.selectedAccountId, health, note })
    })
      .then(() => loadWarmup({ full: false }))
      .catch((error) => {
        warmupState.error = error.message;
        renderWarmupConfigNote();
      });
  }
});

/* The form only ever redraws the detail: it is what says the numbers on screen
   are for the saved campaign, not for what is being typed. */
function warmupCampaignFormTouched() {
  warmupState.campaignNotice = "";
  renderWarmupCampaignDetail();
  renderWarmupCampaignForm();
}

document.getElementById("warmupFolderSelect")?.addEventListener("change", warmupCampaignFormTouched);
document.getElementById("warmupCampaignProduct")?.addEventListener("change", warmupCampaignFormTouched);
document.getElementById("warmupCampaignName")?.addEventListener("input", warmupCampaignFormTouched);

for (const id of ["warmupFilterCountry", "warmupFilterPosition", "warmupFilterStatus", "warmupFilterOwner", "warmupCampaignFromDay"]) {
  document.getElementById(id)?.addEventListener("input", warmupCampaignFormTouched);
}

document.getElementById("warmupCampaignNewBtn")?.addEventListener("click", () => openWarmupCampaignForm(null));
document.getElementById("warmupCampaignCancelBtn")?.addEventListener("click", () => closeWarmupCampaignForm());
document.getElementById("warmupCampaignForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveWarmupCampaignForm();
});

document.getElementById("warmupCampaignList")?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-warmup-campaign]");
  if (!row) return;
  const campaignId = row.dataset.warmupCampaign;

  const move = event.target.closest("[data-warmup-campaign-move]");
  if (move) {
    moveWarmupCampaign(campaignId, move.dataset.warmupCampaignMove);
    return;
  }

  const stateButton = event.target.closest("[data-warmup-campaign-state]");
  if (stateButton) {
    setWarmupCampaignState(campaignId, stateButton.dataset.warmupCampaignState);
    return;
  }
  if (event.target.closest("[data-warmup-campaign-edit]")) {
    openWarmupCampaignForm(campaignId);
    return;
  }
  if (event.target.closest("[data-warmup-campaign-delete]")) {
    deleteWarmupCampaign(campaignId);
    return;
  }
  selectWarmupCampaign(campaignId);
});

document.getElementById("warmupQueueBody")?.addEventListener("click", (event) => {
  const claim = event.target.closest("[data-warmup-claim]");
  if (claim) {
    claimWarmupQueue(claim.dataset.warmupClaim);
    return;
  }
  const take = event.target.closest("[data-warmup-take]");
  if (take) {
    takeWarmupQueueLead(take.dataset.warmupTakeAccount, take.dataset.warmupTake, take.dataset.warmupTakeName);
  }
});

document.getElementById("warmupQueueRefreshBtn")?.addEventListener("click", () => loadWarmupQueues());

document.getElementById("warmupLeadsRefreshBtn")?.addEventListener("click", () => loadWarmupLeads());

/* ── The inbox ─────────────────────────────────────────────────────────────
 *
 * Everything else on this screen is outbound: who will be approached, at what
 * rate, for how long. This panel is the only part that is somebody else
 * talking, which is why it sits above the campaigns rather than below them.
 *
 * Two rules govern it.
 *
 * The first is that message bodies are text typed by strangers on the
 * internet, and this is the one place in the app where hostile input arrives.
 * Every body, name and headline reaches the DOM through `escapeHtml`, and line
 * breaks are kept by CSS rather than by turning newlines into markup — so a
 * reply containing a script tag is read as the characters somebody typed and
 * can never be anything else.
 *
 * The second is that an empty inbox has two meanings that want opposite
 * reactions. Nothing arrived is fine. No account has synced means the agent is
 * not running, every reply on every account is currently invisible, and the
 * operator needs to know today. `lastSyncedAt` is what tells them apart, so a
 * panel that cannot read it says that too rather than guessing the calm one.
 */

/** A run is roughly daily, so a gap longer than this is a stopped agent. */
const WARMUP_SYNC_STALE_HOURS = 36;

/**
 * How many threads the panel shows before it offers the rest. The inbox leads
 * this screen; it is not supposed to swallow it. Twenty-two conversations at
 * full height push the campaigns panel and its forecast off the bottom of the
 * page, which is the same harm as shrinking them by a different route. Unread
 * sorts first, so the ones above the fold are the ones that were waiting.
 */
const WARMUP_INBOX_PREVIEW = 8;

/** Статус — це дані; пігулка на екрані — це текст. */
/**
 * Статуси аутрічу українською — єдине місце, де вони стають словами.
 *
 * Мапа була написана під статуси, яких сервер ніколи не писав («replied»,
 * «skipped», «failed»), і не мала трьох, які він пише. Невідомий статус падав
 * сюди англійським рядком посеред українського екрана. Тут рівно той набір, що
 * існує в OUTREACH_STATUSES плюс дві машинні черги.
 */
const WARMUP_OUTREACH_LABEL = {
  waiting: "у черзі на запит",
  queued: "закріплено",
  pending: "запит надіслано",
  accepted: "прийняв(ла)",
  connected: "відповів(ла)",
  declined: "не прийняв(ла)",
  withdrawn: "запит зник"
};

const WARMUP_OUTREACH_TONE = {
  waiting: "tone-warn",
  queued: "tone-muted",
  pending: "tone-muted",
  accepted: "tone-live",
  connected: "tone-live",
  declined: "tone-bad",
  withdrawn: "tone-bad"
};

/** How long ago, said the way a person would say it. */
function warmupAgo(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 0) return new Date(then).toLocaleString();
  if (minutes < 1) return "щойно";
  if (minutes < 60) return `${minutes} хв тому`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.round(hours / 24);
  if (days === 1) return "вчора";
  if (days < 30) return `${days} дн тому`;
  return new Date(then).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/** The same moment in full, for the tooltip behind the short version. */
function warmupStamp(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  return Number.isFinite(then) ? new Date(then).toLocaleString() : "";
}

function warmupHoursSince(iso) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 3600000;
}

/**
 * A stranger's message, escaped. The return value is HTML, so there is no
 * version of this text that reaches the DOM unescaped: newlines survive
 * because `.warmup-message-body` is `white-space: pre-wrap`, not because
 * anything here builds tags out of what was typed.
 */
function warmupBodyHtml(body) {
  return escapeHtml(String(body ?? ""));
}

/** The first line of a message, for a list row that has one line to spend. */
function warmupPreviewHtml(body, limit = 150) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return '<em class="warmup-subtle">у цьому повідомленні немає тексту</em>';
  const chars = Array.from(text);
  const clipped = chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
  // Quoted, because the row is half app copy and half somebody's words, and
  // without the quotes a reply reads as a sentence this screen is saying.
  return `«${escapeHtml(clipped)}»`;
}

/**
 * A LinkedIn link built from a slug somebody else supplied. Anything that is
 * not plainly a slug or an http(s) URL gets no link at all — a person's own
 * profile is not worth inventing a destination for.
 */
function warmupProfileUrl(slug) {
  const value = String(slug || "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  return `https://www.linkedin.com/in/${value}`;
}

/**
 * The strings that are not names. The server folds all of these to "Unknown"
 * before they reach here and its matcher refuses that sentinel from both sides,
 * which is where the rule with teeth lives — a thread that cannot name somebody
 * must never be filed against a CRM contact. This list is the display half of
 * the same idea, kept because an older server, or one whose normaliser is
 * bypassed, would otherwise have "LinkedIn Member" printed as a surname on ten
 * rows that are ten different people. Whole string, trimmed, case-insensitive:
 * "Linda Memberly" is a person.
 */
const WARMUP_UNNAMED = new Set([
  "unknown",
  "linkedin member",
  "linkedin user",
  "deleted member",
  "deleted user",
  "member"
]);

function warmupParticipantUnnamed(participant) {
  // Runs of whitespace are collapsed before the comparison: the agent reads
  // these strings out of the DOM, where "LinkedIn Member" can arrive as
  // "LinkedIn\n      Member". Collapsing cannot swallow a real name — "Linda
  // Memberly" is still not in the set however it was spaced.
  const name = String(participant?.name || "").replace(/\s+/g, " ").trim();
  return !name || WARMUP_UNNAMED.has(name.toLowerCase());
}

/** Who wrote, or an honest admission that nobody here knows. */
function warmupParticipantName(participant) {
  if (warmupParticipantUnnamed(participant)) return "Хтось, кого цей тред не називає";
  return String(participant.name).trim();
}

/**
 * Why there is no name, which has two ordinary causes that look identical by
 * the time they reach this screen: LinkedIn withholding it on a restricted or
 * out-of-network profile, and the agent failing to read it. Worth saying,
 * because only the second one is a fault.
 */
function warmupParticipantNameAttr(participant) {
  return warmupParticipantUnnamed(participant)
    ? ' title="LinkedIn не показав імені цієї людини — зазвичай це закритий профіль або профіль поза мережею, іноді невдале зчитування. Цей тред навмисно не зіставлено ні з ким у CRM."'
    : "";
}

/**
 * Which account a thread arrived on, by the person the browser is signed in as
 * rather than by the label somebody typed into Anty. When only the label is
 * known the row says that, because "arrived on Profile 7" and "arrived on Anna
 * Kovalenko" are not the same claim.
 */
function warmupThreadAccount(thread) {
  const identity = thread?.accountIdentity;
  const name = typeof identity === "string" ? identity.trim() : String(identity?.name || "").trim();
  if (name) return { name, exact: true };
  const label = String(thread?.accountLabel || "").trim();
  if (label) return { name: label, exact: false };
  return { name: "акаунт, який цей портал не може назвати", exact: false };
}

/**
 * What is known about syncing, from wherever it landed. The server carries the
 * summary at the top level — the only place it can be read when there are no
 * threads at all — and the contract also puts `lastSyncedAt` on each thread.
 * Read both, so the two halves of this phase can land in either order.
 */
function warmupInboxSync() {
  const inbox = warmupState.inbox;
  const sync = inbox.sync && typeof inbox.sync === "object" ? inbox.sync : null;

  let lastSyncedAt = sync?.lastSyncedAt || null;
  let fromThreads = false;
  for (const thread of inbox.threads) {
    const seen = thread?.lastSyncedAt;
    if (!seen) continue;
    if (!lastSyncedAt || Date.parse(seen) > Date.parse(lastSyncedAt)) {
      lastSyncedAt = seen;
      fromThreads = true;
    }
  }

  const accountsTotal = Number.isFinite(sync?.accountsTotal) ? sync.accountsTotal : null;
  const accountsSynced = Number.isFinite(sync?.accountsSynced) ? sync.accountsSynced : null;

  // "Never synced" is a claim, and it can only be made when the server actually
  // reports on syncing. Without that, the honest answer is that this is not
  // known — which is itself worth saying rather than dressing up as calm.
  const known = Boolean(sync) || fromThreads;
  const hours = warmupHoursSince(lastSyncedAt);

  return {
    known,
    lastSyncedAt,
    accountsTotal,
    accountsSynced,
    stale: Number.isFinite(hours) && hours > WARMUP_SYNC_STALE_HOURS
  };
}

/** The accounts that have never been read, said as a sentence or not at all. */
function warmupSyncGapHtml(sync) {
  if (sync.accountsTotal === null || sync.accountsSynced === null) return "";
  if (sync.accountsSynced >= sync.accountsTotal) return "";
  const missing = sync.accountsTotal - sync.accountsSynced;
  return `<div class="warmup-inbox-note is-warn">
    <strong>${warmupCount(missing)} з ${warmupCount(sync.accountsTotal)} ${uaPlural(sync.accountsTotal, "акаунта", "акаунтів", "акаунтів")} ще не читали — їхніх відповідей тут немає</strong>
  </div>`;
}

/**
 * The empty inbox, which is the screen this panel will show most often until
 * the agent runs against real LinkedIn — so it is the part that has to be
 * right. Each branch says which of the two empties this is.
 */
function warmupInboxEmptyHtml() {
  const inbox = warmupState.inbox;

  if (inbox.unreadOnly) {
    return `<div class="warmup-inbox-note is-calm">
      <strong>Непрочитаного немає.</strong>
      <span>Усе, що надійшло, уже відкривали. <button class="warmup-inbox-link" type="button" data-warmup-inbox-showall>Показати всі треди</button>, щоб перечитати.</span>
    </div>`;
  }

  const sync = warmupInboxSync();

  if (!sync.known) {
    return `<div class="warmup-inbox-note is-warn">
      <strong>Відповідей немає, але невідомо, коли вхідні читали востаннє.</strong>
    </div>`;
  }

  if (!sync.lastSyncedAt) {
    return `<div class="warmup-inbox-note is-bad">
      <strong>Вхідні ще жодного разу не читали.</strong>
      <span>Перевір, що агент працює і його токен заданий.</span>
    </div>`;
  }

  if (sync.stale) {
    return `<div class="warmup-inbox-note is-warn">
      <strong>Вхідні не читали ${escapeHtml(warmupAgo(sync.lastSyncedAt))} — схоже, агент зупинився.</strong>
    </div>`;
  }

  return `<div class="warmup-inbox-note is-calm">
    <strong>Нових відповідей немає.</strong>
    <span>Читали ${escapeHtml(warmupAgo(sync.lastSyncedAt))}.</span>
  </div>`;
}

function warmupThreadRowHtml(thread) {
  const participant = thread.participant || {};
  const name = warmupParticipantName(participant);
  const account = warmupThreadAccount(thread);
  const last = thread.lastMessage || {};
  const inbound = last.direction !== "out";
  // No "на <account>" here any more: the rows sit under a heading that names
  // the account, and repeating it on every row is what made a thread look like
  // it belonged to whoever was printed last.
  return `
    <button class="warmup-thread ${thread.unread ? "is-unread" : ""}" type="button"
      data-warmup-thread="${escapeAttr(thread.threadKey || "")}"
      data-warmup-thread-account="${escapeAttr(thread.accountId || "")}"
      aria-label="${escapeAttr(`Розмова з ${name}, акаунт ${account.name}${thread.unread ? ", непрочитане" : ""}`)}">
      <span class="warmup-thread-mark" aria-hidden="true"></span>
      <span class="warmup-thread-who">
        <strong${warmupParticipantNameAttr(participant)}>${escapeHtml(name)}</strong>
        ${participant.headline ? `<span class="warmup-subtle">${escapeHtml(participant.headline)}</span>` : ""}
      </span>
      <span class="warmup-thread-preview">
        <span class="warmup-thread-from">${inbound ? "Написали нам" : "Писали ми"}:</span>
        ${warmupPreviewHtml(last.body)}
      </span>
      <span class="warmup-thread-meta">
        <time datetime="${escapeAttr(last.sentAt || "")}" title="${escapeAttr(warmupStamp(last.sentAt))}">${escapeHtml(warmupAgo(last.sentAt) || "—")}</time>
      </span>
    </button>`;
}

/**
 * The account a group of threads arrived on, taken from the server's summary
 * when it is there and from the threads themselves when it is not — an older
 * server that answers without the summary still groups correctly.
 */
function warmupInboxAccount(accountId, threads) {
  const summary = warmupState.inbox.accounts.find((account) => account.accountId === accountId);
  if (summary?.identity) return { name: summary.identity, exact: true };
  if (summary?.label) return { name: summary.label, exact: false };
  return warmupThreadAccount(threads[0] || { accountId });
}

/** How many of this account's threads are unread, whatever the list is filtering. */
function warmupInboxUnreadFor(accountId) {
  const summary = warmupState.inbox.accounts.find((account) => account.accountId === accountId);
  if (summary) return Number(summary.unread) || 0;
  return warmupState.inbox.threads.filter((thread) => thread.accountId === accountId && thread.unread).length;
}

/**
 * The list, grouped by the account each reply arrived on.
 *
 * Which login somebody answered is the first thing a seller needs and the last
 * thing the flat list gave them: five accounts' conversations interleaved by
 * time, each naming its account in small print under a stranger's name. A
 * heading per account says it once, and carries that account's unread count so
 * the fresh reply is visible before any row is read.
 */
function warmupThreadGroupsHtml(threads) {
  const order = [];
  const byAccount = new Map();
  for (const thread of threads) {
    const id = thread.accountId || "";
    if (!byAccount.has(id)) {
      byAccount.set(id, []);
      order.push(id);
    }
    byAccount.get(id).push(thread);
  }

  return order.map((accountId) => {
    const held = byAccount.get(accountId);
    const account = warmupInboxAccount(accountId, held);
    const unread = warmupInboxUnreadFor(accountId);
    const title = account.exact
      ? "Особа, під якою залогінений цей акаунт"
      : "Назва профілю в Anty — цей портал не знає, під ким залогінений цей акаунт";

    return `<section class="warmup-thread-group" id="${escapeAttr(warmupInboxAnchor(accountId))}">
      <h3 class="warmup-thread-group-head">
        <span class="warmup-identity" title="${escapeAttr(title)}">
          <i data-lucide="${account.exact ? "badge-check" : "circle-help"}"></i>
          <span>${escapeHtml(account.name)}</span>
        </span>
        ${unread
          ? `<span class="warmup-group-unread">${warmupCount(unread)} ${uaPlural(unread, "нова відповідь", "нові відповіді", "нових відповідей")}</span>`
          : '<span class="warmup-subtle">усе прочитано</span>'}
      </h3>
      <div class="warmup-threads">${held.map((thread) => warmupThreadRowHtml(thread)).join("")}</div>
    </section>`;
  }).join("");
}

/** The id a group heading carries, so the accounts table can jump to it. */
function warmupInboxAnchor(accountId) {
  return `warmupInboxAccount-${String(accountId || "none").replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function warmupMessageHtml(message, participantName, accountName) {
  const inbound = message.direction !== "out";
  const who = inbound ? (participantName || "Вони") : accountName;
  return `<li class="warmup-message ${inbound ? "is-in" : "is-out"}">
    <div class="warmup-message-head">
      <strong>${escapeHtml(who)}</strong>
      <time datetime="${escapeAttr(message.sentAt || "")}" title="${escapeAttr(warmupStamp(message.sentAt))}">${escapeHtml(warmupAgo(message.sentAt) || "—")}</time>
    </div>
    <div class="warmup-message-body">${warmupBodyHtml(message.body)}</div>
  </li>`;
}

/**
 * One conversation, oldest first. Above it the things that make a reply
 * actionable: who wrote, where to find them, which account holds the thread,
 * and where that person stands in the outreach they were part of.
 */
function warmupThreadViewHtml() {
  const inbox = warmupState.inbox;
  const back = '<button class="text-button warmup-thread-back" type="button" data-warmup-inbox-back><i data-lucide="arrow-left"></i><span>Усі відповіді</span></button>';

  if (inbox.openError) {
    return `${back}<div class="warmup-inbox-note is-bad">
      <strong>${escapeHtml(inbox.openError)}</strong>
      <span>Розмову не вдалося прочитати. У списку — останнє, що цьому порталу про неї сказали.</span>
    </div>`;
  }
  if (!inbox.open) {
    return `${back}<div class="empty-state">Відкриваємо розмову...</div>`;
  }

  const thread = inbox.open.thread || {};
  const participant = thread.participant || {};
  const name = warmupParticipantName(participant);
  const account = warmupThreadAccount(thread);
  const link = warmupProfileUrl(participant.slug);
  const status = String(thread.outreachStatus || "").trim();
  const messages = Array.isArray(inbox.open.messages) ? inbox.open.messages : [];
  const accountTitle = account.exact
    ? "Особа, під якою залогінений цей акаунт"
    : "Назва профілю в Anty — цей портал не знає, під ким залогінений цей акаунт";

  const head = `
    <div class="warmup-thread-head">
      ${back}
      <div class="warmup-thread-head-who">
        <strong${warmupParticipantNameAttr(participant)}>${escapeHtml(name)}</strong>
        ${participant.headline ? `<span class="warmup-subtle">${escapeHtml(participant.headline)}</span>` : ""}
        ${link
          ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer noopener"><i data-lucide="external-link"></i><span>їхній LinkedIn</span></a>`
          : '<span class="warmup-subtle">з цим тредом не прийшло посилання на профіль</span>'}
      </div>
      <div class="warmup-thread-head-meta">
        <span class="warmup-identity" title="${escapeAttr(accountTitle)}">
          <i data-lucide="${account.exact ? "badge-check" : "circle-help"}"></i>
          <span>надійшло на ${escapeHtml(account.name)}</span>
        </span>
        ${status
          ? `<span class="pill ${WARMUP_OUTREACH_TONE[status] || "tone-muted"}">${escapeHtml(WARMUP_OUTREACH_LABEL[status] || status)}</span>`
          : '<span class="warmup-subtle">не зіставлено ні з ким, до кого цей акаунт звертався</span>'}
      </div>
    </div>`;

  if (!messages.length) {
    return `${head}<div class="warmup-inbox-note is-warn">
      <strong>У цьому треді не збережено жодного повідомлення.</strong>
      <span>Розмову побачили, але нічого в ній не прочитали — на боці агента так виглядає протухлий селектор.</span>
    </div>`;
  }

  return `${head}
    <ol class="warmup-messages">${messages.map((message) => warmupMessageHtml(message, name, account.name)).join("")}</ol>
    <p class="warmup-thread-foot">Тут можна тільки читати. Відповідь іде з живого акаунта живій людині, тож потребує власного поводження з квотою — у цій фазі її немає, відповідай із самого акаунта.</p>`;
}

function renderWarmupInbox() {
  const title = document.getElementById("warmupInboxTitle");
  const subtitle = document.getElementById("warmupInboxSubtitle");
  const pill = document.getElementById("warmupInboxPill");
  const toggleLabel = document.getElementById("warmupInboxUnreadLabel");
  const toggle = document.getElementById("warmupInboxUnreadOnly");
  const body = document.getElementById("warmupInboxBody");
  if (!body || !title || !subtitle) return;

  const inbox = warmupState.inbox;
  if (toggle) toggle.checked = inbox.unreadOnly;
  renderWarmupNavBadge();

  // A thread is open: the panel becomes that conversation, and the controls
  // that belong to the list step out of the way rather than filter nothing.
  if (inbox.openThreadKey !== null) {
    const open = inbox.open?.thread?.participant;
    title.textContent = open ? `Вхідні · ${warmupParticipantName(open)}` : "Вхідні · одна розмова";
    subtitle.textContent = "Розмова такою, як її прочитав агент, від найстарішого";
    if (toggleLabel) toggleLabel.hidden = true;
    if (pill) pill.hidden = true;
    body.innerHTML = warmupThreadViewHtml();
    refreshIcons();
    return;
  }

  title.textContent = "Вхідні";
  if (toggleLabel) toggleLabel.hidden = false;
  if (pill) pill.hidden = false;

  if (pill) {
    if (!inbox.available) {
      pill.className = "pill tone-muted";
      pill.textContent = "немає на цьому сервері";
    } else if (inbox.error) {
      pill.className = "pill tone-bad";
      pill.textContent = "недоступно";
    } else if (!inbox.ready) {
      pill.className = "pill tone-muted";
      pill.textContent = "завантаження";
    } else if (inbox.unread > 0) {
      pill.className = "pill tone-live";
      pill.textContent = `${warmupCount(inbox.unread)} ${uaPlural(inbox.unread, "непрочитана", "непрочитані", "непрочитаних")}`;
    } else {
      // With nothing unread the pill stops counting and starts reporting on the
      // reading, because "nothing yet" beside a panel saying nothing has ever
      // looked is the calm half of the very distinction this panel exists for.
      const state = warmupInboxSync();
      if (state.known && !state.lastSyncedAt) {
        pill.className = "pill tone-bad";
        pill.textContent = "жодного разу не читали";
      } else if (state.stale) {
        pill.className = "pill tone-warn";
        pill.textContent = "давно не читали";
      } else if (!state.known && !inbox.threads.length) {
        pill.className = "pill tone-warn";
        pill.textContent = "невідомо, чи читали";
      } else {
        pill.className = "pill tone-muted";
        pill.textContent = inbox.threads.length ? "усе прочитано" : "поки нічого";
      }
    }
  }

  if (!inbox.available) {
    subtitle.textContent = "Вхідних на цьому сервері ще немає";
    body.innerHTML = `<div class="warmup-inbox-note is-warn">
      <strong>На цьому сервері немає ендпоїнта вхідних.</strong>
      <span>З акаунтами все гаразд — просто цей портал старший за вхідні. Нічия відповідь не губиться, але й ніхто її не читає.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (inbox.error) {
    subtitle.textContent = "Вхідні не вдалося прочитати";
    body.innerHTML = `<div class="warmup-inbox-note is-bad">
      <strong>${escapeHtml(inbox.error)}</strong>
      <span>«Вхідні не відповідають» і «ніхто не написав» — це різні відповіді; тут перша.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (!inbox.ready) {
    subtitle.textContent = "Читаємо, що прийшло";
    body.innerHTML = '<div class="empty-state">Завантажуємо вхідні...</div>';
    return;
  }

  const sync = warmupInboxSync();
  // Three answers, not two: read at a time, never read, and not reported. The
  // subtitle must not turn the third into the second.
  const read = sync.lastSyncedAt
    ? `читали ${warmupAgo(sync.lastSyncedAt)}`
    : (sync.known ? "ще не читали" : "");

  if (!inbox.threads.length) {
    subtitle.textContent = inbox.unreadOnly ? "Тільки непрочитані" : read;
    body.innerHTML = warmupInboxEmptyHtml();
    refreshIcons();
    return;
  }

  // The groups below already name each account and count what is new; the
  // subtitle only says when the inbox was last read.
  subtitle.textContent = read;

  const shown = inbox.showAll ? inbox.threads : inbox.threads.slice(0, WARMUP_INBOX_PREVIEW);
  const hidden = inbox.threads.length - shown.length;
  // Collapsing must never hide a waiting reply quietly, so the button says how
  // many of what it is holding back are still unread.
  const hiddenUnread = hidden > 0
    ? inbox.threads.slice(shown.length).filter((thread) => thread.unread).length
    : 0;
  const more = hidden > 0
    ? `<button class="warmup-inbox-more" type="button" data-warmup-inbox-expand>Показати ще ${warmupCount(hidden)} ${uaPlural(hidden, "розмову", "розмови", "розмов")}${hiddenUnread ? ` · ${warmupCount(hiddenUnread)} досі непрочитаних` : ""}</button>`
    : (inbox.showAll && inbox.threads.length > WARMUP_INBOX_PREVIEW
      ? '<button class="warmup-inbox-more" type="button" data-warmup-inbox-collapse>Показати менше</button>'
      : "");

  body.innerHTML = `${warmupSyncGapHtml(sync)}
    ${warmupThreadGroupsHtml(shown)}
    ${more}`;
  refreshIcons();
}

/* ── The badge ─────────────────────────────────────────────────────────────
 *
 * The count on the Warm-up nav item is the entire notification this phase
 * ships: the workspace's notification settings have channels for email and
 * Slack, none of them are wired to anything, and a badge that is true beats a
 * channel that silently does nothing.
 *
 * Which means it cannot wait for somebody to open the tab — a reply nobody is
 * told about is the problem being solved. So the count is read once at boot and
 * then on a slow timer, but only while the window is actually in front, and
 * never again on a server that says it has no warm-up configured.
 */

const WARMUP_BADGE_POLL_MS = 120000;
let warmupBadgeTimer = null;

function renderWarmupNavBadge() {
  const badge = document.getElementById("warmupNavBadge");
  if (!badge) return;
  const count = warmupState.unreadReplies;
  if (!Number.isFinite(count) || count <= 0) {
    badge.hidden = true;
    badge.textContent = "";
    return;
  }
  badge.hidden = false;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.title = `${count} ${uaPlural(count, "непрочитана відповідь", "непрочитані відповіді", "непрочитаних відповідей")}`;
  badge.setAttribute("aria-label", badge.title);
}

function setWarmupUnread(count) {
  warmupState.unreadReplies = Number.isFinite(count) ? Math.max(0, count) : null;
  renderWarmupNavBadge();
}

function stopWarmupBadgePoll() {
  if (warmupBadgeTimer) clearInterval(warmupBadgeTimer);
  warmupBadgeTimer = null;
}

async function refreshWarmupBadge() {
  if (!authState?.authenticated) return;
  if (document.visibilityState === "hidden") return;
  try {
    const config = await warmupApi("/config");
    // A server with no warm-up will never have an unread reply, and should not
    // be asked again for the rest of the session.
    if (config && config.configured === false) {
      setWarmupUnread(0);
      stopWarmupBadgePoll();
      return;
    }
    if (Number.isFinite(config?.unreadReplies)) setWarmupUnread(config.unreadReplies);
  } catch (error) {
    // A portal without the count is not a portal with a wrong count: leave the
    // badge as it was, and stop pestering a server that has no such route.
    if (error?.status === 404) stopWarmupBadgePoll();
  }
}

function startWarmupBadge() {
  stopWarmupBadgePoll();
  warmupBadgeTimer = setInterval(() => refreshWarmupBadge(), WARMUP_BADGE_POLL_MS);
  refreshWarmupBadge();
}

/* ── Loading and opening ───────────────────────────────────────────────── */

async function loadWarmupInbox() {
  const inbox = warmupState.inbox;
  const params = new URLSearchParams();
  if (inbox.unreadOnly) params.set("unread", "1");
  const query = params.toString();

  try {
    const payload = await warmupApi(`/inbox${query ? `?${query}` : ""}`);
    inbox.threads = Array.isArray(payload.threads) ? payload.threads : [];
    inbox.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    inbox.unread = Number.isFinite(payload.unread) ? payload.unread : 0;
    inbox.sync = payload.sync && typeof payload.sync === "object" ? payload.sync : null;
    inbox.available = true;
    inbox.ready = true;
    inbox.error = "";
    setWarmupUnread(inbox.unread);
  } catch (error) {
    inbox.threads = [];
    inbox.accounts = [];
    inbox.sync = null;
    if (error?.status === 404) {
      // The endpoint is not built here. That is a different sentence from "the
      // inbox is empty", and drawing the empty one would be a lie.
      inbox.available = false;
      inbox.ready = false;
      inbox.error = "";
    } else {
      inbox.available = true;
      inbox.ready = true;
      inbox.error = error.message || "Вхідні не вдалося прочитати.";
    }
  }
  renderWarmupInbox();
  // The accounts table carries the same unread numbers, and it was drawn before
  // this answer arrived — so it is redrawn with it rather than sitting there
  // saying nothing is waiting.
  if (warmupState.profiles.length) renderWarmupProfiles();
}

function warmupThreadIsOpen(accountId, threadKey) {
  const inbox = warmupState.inbox;
  return inbox.openAccountId === accountId && inbox.openThreadKey === threadKey;
}

/** Opening a thread marks it read — that is what opening it means. */
async function markWarmupThreadRead(accountId, threadKey) {
  const thread = warmupState.inbox.threads.find(
    (row) => row.threadKey === threadKey && row.accountId === accountId
  );
  if (thread && !thread.unread) return;

  let payload = null;
  try {
    payload = await warmupApi("/inbox/read", {
      method: "POST",
      body: JSON.stringify({ threadKey, accountId })
    });
  } catch (error) {
    // Failing to mark it read leaves it unread, which is the safe direction: a
    // reply shown twice costs a glance, a reply hidden costs the reply.
    return;
  }

  if (thread) thread.unread = false;
  warmupState.inbox.unread = Math.max(0, (warmupState.inbox.unread || 0) - 1);
  // The account this thread arrived on is one reply less busy, on the heading
  // above it and on its row in the table alike.
  const summary = warmupState.inbox.accounts.find((account) => account.accountId === accountId);
  if (summary) summary.unread = Math.max(0, (Number(summary.unread) || 0) - 1);
  if (warmupState.profiles.length) renderWarmupProfiles();
  // The mark comes back with the new global count, so the badge is the server's
  // number rather than this screen's arithmetic about it.
  if (Number.isFinite(payload?.unread)) {
    setWarmupUnread(payload.unread);
  } else if (Number.isFinite(warmupState.unreadReplies)) {
    setWarmupUnread(warmupState.unreadReplies - 1);
  }
}

async function openWarmupThread(accountId, threadKey) {
  const inbox = warmupState.inbox;
  inbox.openAccountId = accountId;
  inbox.openThreadKey = threadKey;
  inbox.open = null;
  inbox.openError = "";
  inbox.openBusy = true;
  renderWarmupInbox();

  try {
    const payload = await warmupApi(
      `/inbox/thread?threadKey=${encodeURIComponent(threadKey)}&accountId=${encodeURIComponent(accountId)}`
    );
    // The reader may have gone back, or opened something else, while this was
    // in flight. Whatever is open now wins.
    if (!warmupThreadIsOpen(accountId, threadKey)) return;
    inbox.open = { thread: payload.thread || {}, messages: payload.messages || [] };
    inbox.openError = "";
  } catch (error) {
    if (!warmupThreadIsOpen(accountId, threadKey)) return;
    // A 404 here means the thread, not the route — a row can be listed and then
    // be gone by the time somebody clicks it. Unless the list never answered
    // either, in which case it is the route after all.
    inbox.openError = error?.status === 404
      ? (inbox.available
        ? "Цієї розмови вже немає на сервері."
        : "Цей сервер ще не вміє відкривати окремий тред.")
      : (error.message || "Розмову не вдалося прочитати.");
  } finally {
    if (warmupThreadIsOpen(accountId, threadKey)) {
      inbox.openBusy = false;
      renderWarmupInbox();
    }
  }

  if (warmupThreadIsOpen(accountId, threadKey) && !inbox.openError) {
    await markWarmupThreadRead(accountId, threadKey);
    if (warmupThreadIsOpen(accountId, threadKey)) renderWarmupInbox();
  }
}

function closeWarmupThread() {
  const inbox = warmupState.inbox;
  inbox.openAccountId = null;
  inbox.openThreadKey = null;
  inbox.open = null;
  inbox.openError = "";
  inbox.openBusy = false;
  renderWarmupInbox();
}

/**
 * Show one account's replies in the inbox below, from the badge on its row.
 *
 * Nothing is filtered away: the other accounts stay where they are, the list is
 * expanded so the group cannot be one of the ones collapsing hid, and the page
 * is moved to it. A seller who clicks "2 нові відповіді" should land on those
 * two threads without losing the rest of the screen.
 */
function showWarmupInboxAccount(accountId) {
  if (!accountId) return;
  const inbox = warmupState.inbox;
  if (inbox.openThreadKey !== null) closeWarmupThread();
  inbox.showAll = true;
  renderWarmupInbox();

  const group = document.getElementById(warmupInboxAnchor(accountId));
  if (!group) return;
  group.scrollIntoView({ behavior: "smooth", block: "start" });
  // A brief mark, because a smooth scroll ending on one of several headings
  // does not by itself say which one was asked for.
  group.classList.add("is-called");
  setTimeout(() => group.classList.remove("is-called"), 2000);
}

document.getElementById("warmupInboxRefreshBtn")?.addEventListener("click", () => {
  const inbox = warmupState.inbox;
  if (inbox.openThreadKey !== null) {
    openWarmupThread(inbox.openAccountId, inbox.openThreadKey);
    return;
  }
  loadWarmupInbox();
});

document.getElementById("warmupInboxUnreadOnly")?.addEventListener("change", (event) => {
  warmupState.inbox.unreadOnly = Boolean(event.target.checked);
  warmupState.inbox.ready = false;
  renderWarmupInbox();
  loadWarmupInbox();
});

document.getElementById("warmupInboxBody")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-warmup-inbox-back]")) {
    closeWarmupThread();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-expand]")) {
    warmupState.inbox.showAll = true;
    renderWarmupInbox();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-collapse]")) {
    warmupState.inbox.showAll = false;
    renderWarmupInbox();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-showall]")) {
    warmupState.inbox.unreadOnly = false;
    warmupState.inbox.ready = false;
    renderWarmupInbox();
    loadWarmupInbox();
    return;
  }
  // A link inside a row is the link, not the row.
  if (event.target.closest("a")) return;
  const row = event.target.closest("[data-warmup-thread]");
  if (!row) return;
  openWarmupThread(row.dataset.warmupThreadAccount, row.dataset.warmupThread);
});

startWarmupBadge();

/* ── Профіль: модель, витрати, час ─────────────────────────────────────────
 *
 * Усе на цьому екрані читається з одного запиту. Кошики приходять уже
 * порізані по днях і завжди на всі 30 — включно з порожніми, бо місяць із
 * трьома робочими днями має виглядати як місяць із трьома робочими днями, а
 * не як три дні поспіль.
 */

function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours && minutes) return `${hours} год ${minutes} хв`;
  if (hours) return `${hours} год`;
  if (minutes) return `${minutes} хв`;
  return total ? `${total} с` : "—";
}

function formatMoney(value) {
  const amount = Number(value) || 0;
  return amount >= 1 ? `$${amount.toFixed(2)}` : amount > 0 ? `$${amount.toFixed(4)}` : "$0";
}

/**
 * Один стовпчик на день. Порожній день лишається стовпчиком нульової висоти,
 * щоб пропуск було видно як пропуск, а не як зсув.
 */
function profileChartHtml(buckets, valueOf, labelOf) {
  const peak = Math.max(...buckets.map(valueOf), 0);
  return buckets
    .map((bucket) => {
      const value = valueOf(bucket);
      const height = peak > 0 ? Math.round((value / peak) * 100) : 0;
      const day = String(bucket.date || "").slice(8);
      return `<div class="profile-bar${value > 0 ? " has-value" : ""}" title="${escapeAttr(`${bucket.date}: ${labelOf(bucket)}`)}">
        <span style="height:${Math.max(height, value > 0 ? 4 : 0)}%"></span>
        <small>${escapeHtml(day)}</small>
      </div>`;
    })
    .join("");
}

function renderProfileScreen() {
  if (!profileData) return;
  const { model, spend, time, user } = profileData;

  // Пошта показується один раз: як заголовок, коли імені немає, і як підпис,
  // коли ім'я є.
  const displayName = personDisplayName(user?.name, user?.email);
  setText("profileName", displayName || user?.email || "Профіль");
  const emailLine = document.getElementById("profileEmail");
  emailLine.textContent = displayName ? user?.email || "" : "";
  emailLine.hidden = !emailLine.textContent;
  setText("accountRolePill", ROLE_LABEL[user?.role] || user?.role || "seller");
  // Пароль і вихід — завжди про того, хто зараз у застосунку. Коли відкрито
  // чужу картку, їм там не місце: адміністратор не змінює чужий пароль звідси.
  document.getElementById("accountSelfPanel").hidden = profileData.self === false;

  // Price in the option itself: a choice made without it is a choice made
  // before the invoice rather than with it. Curated pairs first, then the rest.
  const optionHtml = (option) => {
    const id = typeof option === "string" ? option : option.id;
    const base = typeof option === "string" ? option : option.label || option.id;
    const price = option.inputPrice != null && option.outputPrice != null
      ? ` — ${option.inputPrice}/${option.outputPrice} за 1М`
      : "";
    return `<option value="${escapeAttr(id)}"${id === model.modelId ? " selected" : ""}>${escapeHtml(base + price)}</option>`;
  };
  const curated = (model.options || []).filter((option) => option.curated).map(optionHtml);
  const rest = (model.options || []).filter((option) => !option.curated).map(optionHtml);
  const options = curated.length
    ? [`<optgroup label="Відібрані">${curated.join("")}</optgroup>`, `<optgroup label="Решта каталогу">${rest.join("")}</optgroup>`]
    : rest;
  setHtml("profileModelSelect", `<option value=""${model.modelId ? "" : " selected"}>За замовчуванням робочого простору</option>${options.join("")}`);
  setText("profileModelNote", model.source === "user"
    ? `Обрано для цього користувача. Аналіз: ${model.effective?.analysisModel || "—"}, написання: ${model.effective?.writingModel || "—"}.`
    : `Своєї моделі не обрано, тож працює модель робочого простору — аналіз: ${model.effective?.analysisModel || "—"}, написання: ${model.effective?.writingModel || "—"}.`);

  setText("profileSpendTotal", formatMoney(spend.totalCostUsd));
  setHtml("profileSpendChart", profileChartHtml(
    spend.buckets || [],
    (b) => Number(b.costUsd) || 0,
    (b) => `${formatMoney(b.costUsd)} · ${b.requests || 0} ${uaPlural(b.requests || 0, "запит", "запити", "запитів")}`
  ));
  setText("profileSpendNote", spend.requests
    ? `${spend.requests} ${uaPlural(spend.requests, "запит", "запити", "запитів")} за 30 днів · за весь час ${formatMoney(spend.allTimeCostUsd)}`
    : profileData.signedInHere === false
      ? "Ця людина ще жодного разу не заходила сюди — витрат за нею немає."
      : "За 30 днів жодного запиту до моделі з цього акаунта.");

  setText("profileTimeTotal", formatSeconds(time.totalSeconds));
  setHtml("profileTimeChart", profileChartHtml(
    time.buckets || [],
    (b) => Number(b.seconds) || 0,
    (b) => formatSeconds(b.seconds)
  ));
  setText("profileTimeNote", time.activeDays
    ? `Сьогодні ${formatSeconds(time.todaySeconds)} · активних днів ${time.activeDays} · у середньому ${formatSeconds(time.averageSecondsPerActiveDay)} на день`
    : profileData.signedInHere === false
      ? "Ця людина ще жодного разу не заходила сюди."
      : "Час рахується з моменту, коли це запрацювало — попередніх днів у нас просто немає.");
}

/** Відкриває картку однієї людини. Порожній id — свою власну. */
async function loadProfileFor(userId) {
  profileUserId = String(userId || "");
  try {
    const query = profileUserId ? `?user=${encodeURIComponent(profileUserId)}` : "";
    profileData = await api(`/api/account/profile${query}`);
    profileUserId = profileData.user?.id || profileUserId;
    renderProfileScreen();
    await loadTeamDirectory();
    refreshIcons();
  } catch (error) {
    setText("profileModelNote", error.message);
  }
}

async function loadProfileScreen() {
  await loadProfileFor(profileUserId || authState?.user?.id || "");
}

document.getElementById("profileModelSelect")?.addEventListener("change", async (event) => {
  try {
    await api("/api/account/model", {
      method: "POST",
      body: JSON.stringify({ modelId: event.target.value, userId: profileUserId || authState?.user?.id || "" })
    });
    await loadProfileFor(profileUserId);
  } catch (error) {
    setText("profileModelNote", error.message);
  }
});

/**
 * Б'ється лише поки вкладку видно. Скільки з цього зарахувати — вирішує
 * сервер; тут немає жодного припущення про час.
 */
function startActivityHeartbeat() {
  try {
    profileTabId = window.sessionStorage.getItem("outboundTabId");
    if (!profileTabId) {
      profileTabId = crypto.randomUUID();
      window.sessionStorage.setItem("outboundTabId", profileTabId);
    }
  } catch {
    profileTabId = "default";
  }
  const beat = () => {
    if (document.visibilityState !== "visible") return;
    api("/api/account/heartbeat", { method: "POST", body: JSON.stringify({ tabId: profileTabId }) }).catch(() => {});
  };
  beat();
  setInterval(beat, 60000);
}

/**
 * Старт — останнім рядком модуля, і це не косметика.
 *
 * `await` на верхньому рівні спиняє виконання модуля: усе, що оголошено
 * нижче, до його завершення лежить у «мертвій зоні». Коли старт стояв
 * посеред файлу, `enterWorkspace` відновлював збережену вкладку, і та з них,
 * що вантажить прогрів, чіпала `warmupState`, оголошений на десять рядків
 * нижче, — сторінка падала з `ReferenceError` у кожного, хто востаннє
 * дивився «Прогрів». Заразом не реєструвалася жодна подія нижче за старт,
 * тобто половина застосунку лишалася мертвою.
 *
 * Звідси правило: спершу оголошення і обробники, і лише потім — перший
 * запит до сервера.
 */
await bootApplication();
