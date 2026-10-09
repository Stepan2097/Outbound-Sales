// The shell of the workspace: sign-in, the menu, the header line, the one
// request helper and the small formatting helpers every screen uses. It knows
// the four screens by name only — each screen registers what opening it means
// (`onScreen`), so nothing here imports a screen.

import { forgetScreens } from "./cache.js";

export let state = null;

let busyAction = "";

let busyMessage = "";

export let uiNotice = "";

export let authState = null;

let authMode = "login";

let profileTabId = null;

const views = [...document.querySelectorAll(".view")];

const navItems = [...document.querySelectorAll(".nav-item")];

/**
 * Українська множина: 1 контакт, 2 контакти, 5 контактів. Англійський оригінал
 * обходився одним "s", тут без трьох форм виходить безграмотно.
 */
export const uaPlural = (count, one, few, many) => {
  const number = Math.abs(Math.trunc(Number(count) || 0));
  const mod10 = number % 10;
  const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

export async function api(path, options = {}) {
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

export function render() {
  renderTopbar();
  for (const hooks of screenHooks.values()) hooks.render?.();
  renderSidebarUser();
  refreshIcons();
}

export function renderTopbar() {
  // Цей рядок під заголовком — місце для того, що зараз відбувається: прогрес
  // довгої дії або підсумок останньої. Коли не відбувається нічого, він зникає
  // замість того, щоб показувати лічильники, які й так видно на своїх екранах.
  const meta = document.getElementById("workspaceMeta");
  const line = busyMessage || uiNotice || "";
  meta.textContent = line;
  meta.hidden = !line;
}

export async function bootApplication() {
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
  // Whoever signs in next in this tab starts from their own answers, not from
  // the screens the last person left in memory.
  forgetScreens();
  document.getElementById("authGate").hidden = false;
  document.getElementById("appShell").hidden = true;
  renderAuthForm();
  refreshIcons();
}

async function enterWorkspace() {
  document.getElementById("authGate").hidden = true;
  document.getElementById("appShell").hidden = false;
  // The screen first: it draws from memory at once and starts its own reads,
  // which need nothing from these two. Waiting for them first was half a
  // second of empty page before the screen had even asked for its data.
  const saved = rememberedView();
  setView(saved || "home");
  const [status] = await Promise.all([api("/api/auth/status"), refresh()]);
  authState = status;
  render();
  startActivityHeartbeat();
  for (const hook of enterHooks) {
    try { hook(); } catch { /* a counter that cannot be read must not stop anybody entering */ }
  }
}

/**
 * What to do the moment somebody is inside, whatever screen they land on. The
 * menu item with a counter on it cannot wait until its own screen is opened:
 * a seller who comes back on «Контакти» is exactly the one who needs to see
 * that a reply is waiting.
 */
const enterHooks = [];

export function onWorkspaceEnter(hook) {
  enterHooks.push(hook);
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

export const INVITE_NOTE_DROPPED = {
  notes_off: "у цій фазі прогріву записки не можна",
  too_many_words: "задовга для цієї фази",
  has_link: "у ній посилання"
};

export const HISTORY_EVENT_LABEL = {
  "invite.requested": "Запит поставлено в чергу",
  "invite.sent": "Запит надіслано",
  "invite.cancelled": "Запит скасовано",
  "invite.reassigned": "Запит перекинуто на інший акаунт",
  "invite.failed": "Запит не вдалося надіслати",
  // The folder let the person go and will not offer them again; a seller can
  // still queue them by hand.
  "campaign.skipped": "Автопідбір більше не братиме цю людину"
};

export function fillSelect(select, items, valueFn, labelFn, selectedValue) {
  select.innerHTML = items
    .map((item) => {
      const value = valueFn(item);
      return `<option value="${escapeAttr(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(labelFn(item))}</option>`;
    })
    .join("");
}

export function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

export function setHtml(id, html) {
  const element = document.getElementById(id);
  if (element) element.innerHTML = html;
}

export async function runUiAction(actionName, message, work) {
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

// Versioned: when «Головна» arrived (10.10.2026) everybody was opened on it once,
// whatever tab they had last; from then on the tab they leave is the one they get.
const VIEW_MEMORY_KEY = "outboundActiveView.v2";

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
      home: "Головна",
      warmup: "Прогрів LinkedIn",
      inbox: "Вхідні",
      contacts: "Контакти з CRM",
      account: "Налаштування"
    }[viewName] || "Outbound Sales OS";
  rememberView(viewName);
  screenHooks.get(viewName)?.open?.();
}

/**
 * What each screen does when it is opened and when the workspace redraws.
 *
 * The shell knows the four screens by name only; each screen says for itself
 * what opening it means (`onScreen`), so the shell imports none of them and a
 * screen can change without touching it. Every screen loads its data when it
 * is opened rather than at boot: the warm-up and the CRM are other databases,
 * and a tab nobody opens should not pay for them.
 */
const screenHooks = new Map();

export function onScreen(view, hooks) {
  screenHooks.set(view, { ...screenHooks.get(view), ...hooks });
}

export function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

export function linkIfUrl(value) {
  const text = String(value || "");
  if (/^https?:\/\//i.test(text)) {
    return `<a href="${escapeAttr(text)}" target="_blank" rel="noreferrer">${escapeHtml(shortUrl(text))}</a>`;
  }
  return escapeHtml(text);
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 64);
  } catch {
    return value;
  }
}

export function relativeTime(value) {
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

export async function signOut() {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  authState = { authenticated: false, bootstrapRequired: false };
  authMode = "login";
  showAuthGate();
}

document.getElementById("sidebarLogoutBtn").addEventListener("click", signOut);

document.getElementById("sidebarUserBtn").addEventListener("click", () => setView("account"));

export function setFormValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value || "";
}

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

export function setUiNotice(value) {
  uiNotice = value;
}
export function setAuthState(value) {
  authState = value;
}
