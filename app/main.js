let state = null;
let selectedTaskType = "COLD_EMAIL";
let selectedProspectId = null;
let busyAction = "";
let busyMessage = "";
let uiNotice = "";
let activeLeadSectionId = "dashboard-client";
// Панель працює папку CRM по черзі: вибрана папка, місце в ній, скільки там
// людей і що сервер сказав про це місце. Позиція — не фільтр і не пошук: це
// рівно те, на кому продавець зупинився, тому вона переживає перезавантаження.
let panelFolderId = window.localStorage.getItem("outbound.panel.folder") || "";
let panelIndex = Number(window.localStorage.getItem("outbound.panel.index") || 0) || 0;
let panelTotal = 0;
let panelContact = null;
let panelQueueNotice = "";
let panelQueueBusy = false;
// Чий вибір зараз стоїть у селекторах повідомлень. Порожньо — ліда змінили.
let messageControlsLeadId = "";
// Запрошення в друзі. Дані живуть у базі прогріву, а не в /api/state, тож
// сторінка тримає їх окремо і перечитує, коли відкривають іншого ліда.
let inviteAccounts = [];
let inviteAccountsLoaded = false;
let inviteState = null;
let inviteLoadedFor = "";
let inviteNotice = "";
let authState = null;
let authMode = "login";
let activeResearchJob = null;
// Продукти і база знань. І опис продукту, і файли живуть на сервері, тож тут —
// тільки те, що зараз відкрито: список файлів, чернетка файлу в редакторі та
// продукт, з якого востаннє заповнювали форму опису.
let knowledgeLibrary = { files: [] };
let knowledgeLibraryLoaded = false;
let knowledgeFileId = null;
let knowledgeDraft = null;
let knowledgeEditorNeedsFill = false;
let productBriefLoadedFor = null;
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

const formatUsd = (value) => `$${Number(value || 0).toFixed(4)}`;
const formatPct = (value) => `${Math.round((value || 0) * 100)}%`;
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

const titleCase = (value) =>
  value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

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
  renderProductContext();
  renderAccount();
  renderSidebarUser();
  renderProductWorkspace();
  renderPanelSource();
  renderProspects();
  renderLeadsPage();
  renderAssistant();
  renderAgents();
  renderOverview();
  renderModels();
  renderRouting();
  renderBudgets();
  renderPrivacy();
  renderEvaluation();
  renderBusyState();
  renderResearchProgress();
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
  setText("healthPill", state.providerHealth.status);
  document.getElementById("keyState").textContent = state.hasOpenRouterKey
    ? `Версія ключа ${state.keyMetadata.keyVersion} · ${state.keyMetadata.environment}`
    : "Ключ не налаштовано";
  fillSelect(document.getElementById("productSelect"), state.products, (product) => product.id, (product) => product.name, state.selectedProductId);
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
  if (saved) setView(saved);
  else setView("prospects");
}

function renderAuthForm() {
  const bootstrap = authMode === "bootstrap";
  const recover = authMode === "recover";
  const reset = authMode === "reset";
  setText("authEyebrow", bootstrap ? "Створення власника робочого простору" : recover || reset ? "Відновлення доступу" : "Захищений робочий простір");
  setText("authTitle", bootstrap ? "Налаштувати Outbound OS" : recover ? "Відновити пароль" : reset ? "Вибери новий пароль" : "Вхід");
  setText("authDescription", bootstrap ? "Створи перший адміністраторський акаунт для своєї команди." : recover ? "Запитаємо в Supabase захищене посилання для скидання пароля." : reset ? "Задай новий пароль для свого акаунта." : "Заходь робочим акаунтом компанії.");
  document.querySelector(".auth-name-field").hidden = !bootstrap;
  document.querySelector(".auth-email-field").hidden = reset;
  document.querySelector(".auth-password-field").hidden = recover;
  document.querySelector(".auth-confirm-field").hidden = !bootstrap && !reset;
  document.getElementById("authEmailInput").required = !reset;
  document.getElementById("authPasswordInput").required = !recover;
  document.getElementById("authConfirmInput").required = bootstrap || reset;
  document.getElementById("authNameInput").required = bootstrap;
  document.getElementById("authPasswordInput").autocomplete = bootstrap || reset ? "new-password" : "current-password";
  setText("authSubmitBtn", "");
  document.getElementById("authSubmitBtn").innerHTML = `<i data-lucide="${recover ? "mail" : reset ? "key-round" : bootstrap ? "shield-check" : "log-in"}"></i><span>${recover ? "Надіслати посилання" : reset ? "Зберегти новий пароль" : bootstrap ? "Створити робочий простір" : "Увійти"}</span>`;
  const modeButton = document.getElementById("authModeBtn");
  modeButton.hidden = bootstrap || reset;
  modeButton.textContent = recover ? "Назад до входу" : "Забув пароль?";
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
    person.lastSignInAt ? `вхід ${warmupAgo(person.lastSignInAt)}` : "жодного входу"
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
  const row = event.target.closest("[data-team-user]");
  if (!row) return;
  void loadProfileFor(row.dataset.teamUser);
});

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

function renderProductContext() {
  const selected = state.prospects?.find((prospect) => prospect.id === selectedProspectId);
  setHtml("companyBriefContent", companyBriefRows(selected));
  setText("companyConfidencePill", companyConfidenceLabel(selected));
  setText("companyBriefMeta", selected?.company ? `Контекст акаунта ${selected.company} для продукту ${state.selectedProduct?.name || "вибраного"}` : "Чим займається компанія, кому вона продає і чому цей лід може бути вартим уваги");
}


function renderAssistant() {
  const runtime = state.aiRuntime?.mode === "openrouter" ? "OpenRouter активний" : "Мок-AI";
  document.getElementById("aiRuntimePill").textContent = runtime;
  document.getElementById("crmImportStatus").innerHTML = crmImportStatusRows();
  document.getElementById("assistantActionList").innerHTML = (state.aiActions || []).length
    ? state.aiActions.map(assistantActionRow).join("")
    : `<div class="empty-state">Жодної AI-дії ще не виконано</div>`;
}

function crmImportStatusRows() {
  const supabase = state.integrations?.supabase;
  const crm = state.integrations?.crm;
  return `
    <div class="connector-status-grid">
      <div><span>Supabase</span><strong>${escapeHtml(supabase?.status || "not_configured")}</strong></div>
      <div><span>CRM API</span><strong>${escapeHtml(crm?.status || "not_configured")}</strong></div>
      <div><span>Завантажено лідів</span><strong>${state.prospects?.length || 0}</strong></div>
    </div>
  `;
}

function assistantActionRow(action) {
  const results = (action.results || [])
    .slice(0, 8)
    .map((result) => `<li><strong>${escapeHtml(result.type || "дія")}</strong><span>${escapeHtml(result.message || result.status || "")}</span></li>`)
    .join("");
  const warnings = (action.warnings || [])
    .map((warning) => `<span class="warning-chip">${escapeHtml(warning)}</span>`)
    .join("");
  return `
    <article class="assistant-action-card">
      <div class="assistant-action-heading">
        <div>
          <strong>${escapeHtml(action.summary || "AI-дія")}</strong>
          <span>${new Date(action.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${escapeHtml(action.status || "завершено")}</span>
        </div>
        <span class="pill">${escapeHtml(action.modelUsed || "локально")}</span>
      </div>
      <p>${escapeHtml(action.instruction || "")}</p>
      <ul>${results}</ul>
      <div class="warning-row">${warnings}</div>
    </article>
  `;
}

function renderAgents() {
  const select = document.getElementById("agentSelect");
  if (!select) return;
  fillSelect(select, state.agents || [], (agent) => agent.id, (agent) => agent.name, select.value || "orchestrate-outbound");
  document.getElementById("agentGrid").innerHTML = (state.agents || [])
    .map((agent) => `
      <article class="agent-card">
        <div>
          <strong>${escapeHtml(agent.name)}</strong>
          <span>${escapeHtml(agent.id)}</span>
        </div>
        <p>${escapeHtml(agent.purpose)}</p>
        <div class="cap-list">
          <span class="cap">${escapeHtml(agent.model)}</span>
          <span class="cap">${escapeHtml(agent.approval)}</span>
        </div>
      </article>
    `)
    .join("");
}


function listItems(items, emptyText) {
  return (items || []).length
    ? items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : `<li>${escapeHtml(emptyText)}</li>`;
}


function renderOverview() {
  const summary = state.usageSummary;
  document.getElementById("totalCost").textContent = formatUsd(summary.totalCostUsd);
  document.getElementById("tokenVolume").textContent = summary.totalTokens.toLocaleString();
  document.getElementById("avgLatency").textContent = `${summary.avgLatencyMs.toLocaleString()} мс`;
  document.getElementById("fallbackRate").textContent = formatPct(summary.fallbackRate);
  document.getElementById("schemaRate").textContent = formatPct(summary.schemaRate);
  document.getElementById("budgetMeter").style.width = `${Math.min(100, summary.budgetUsedPercent)}%`;

  const eventList = document.getElementById("eventList");
  eventList.innerHTML = state.events
    .map(
      (event) => `
        <div class="event">
          <time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          <strong>${event.type}</strong>
          <span>${escapeHtml(event.text)}</span>
        </div>
      `
    )
    .join("");

  drawTrafficChart();
}

function drawTrafficChart() {
  const canvas = document.getElementById("trafficChart");
  const ctx = canvas.getContext("2d");
  const mode = document.getElementById("chartMode").value;
  const width = canvas.width;
  const height = canvas.height;
  const padding = 38;
  const data = state.usage
    .slice(0, 14)
    .reverse()
    .map((item) => ({
      label: new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      value: mode === "latency" ? item.latencyMs : mode === "tokens" ? item.inputTokens + item.outputTokens : item.costUsd
    }));

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#071426";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(143, 177, 207, 0.18)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const y = padding + ((height - padding * 2) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }

  const max = Math.max(...data.map((item) => item.value), 1);
  const barWidth = (width - padding * 2) / data.length - 10;
  data.forEach((item, index) => {
    const x = padding + index * ((width - padding * 2) / data.length) + 5;
    const barHeight = Math.max(4, ((height - padding * 2) * item.value) / max);
    const y = height - padding - barHeight;
    ctx.fillStyle = index % 3 === 0 ? "#28d4bf" : index % 3 === 1 ? "#4f8cff" : "#f4bd50";
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.fillStyle = "#94a9be";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(item.label, x - 4, height - 14);
  });
}

function renderModels() {
  const search = document.getElementById("modelSearch").value.trim().toLowerCase();
  const tier = document.getElementById("modelTierFilter").value;
  const models = state.models.filter((model) => {
    const matchesTier = tier === "all" || model.tier === tier;
    const matchesSearch = !search || `${model.id} ${model.displayName} ${model.provider}`.toLowerCase().includes(search);
    return matchesTier && matchesSearch;
  });

  document.getElementById("modelTable").innerHTML = models
    .map(
      (model) => `
        <tr>
          <td><strong>${escapeHtml(model.displayName)}</strong><span>${escapeHtml(model.id)}</span></td>
          <td><span class="pill">${model.tier}</span></td>
          <td>${Number(model.contextWindow).toLocaleString()}</td>
          <td><div class="cap-list">${capabilities(model).map((cap) => `<span class="cap">${cap}</span>`).join("")}</div></td>
          <td><strong>$${model.inputPrice} / $${model.outputPrice}</strong><span>вхід / вихід</span></td>
          <td>${model.qualityScore}%</td>
          <td>
            <button class="toggle" data-model-toggle="${escapeAttr(model.id)}" data-enabled="${!model.enabled}">
              <i data-lucide="${model.enabled ? "toggle-right" : "toggle-left"}"></i>
              <span>${model.enabled ? "Увімкнено" : "Вимкнено"}</span>
            </button>
          </td>
        </tr>
      `
    )
    .join("");
}

function renderRouting() {
  const models = state.models.filter((model) => model.enabled);
  const selected = state.tasks.find((task) => task.taskType === selectedTaskType) || state.tasks[0];
  selectedTaskType = selected.taskType;

  document.getElementById("taskList").innerHTML = state.tasks
    .map(
      (task) => `
        <button class="task-row ${task.taskType === selectedTaskType ? "active" : ""}" data-task-row="${task.taskType}">
          <div>
            <strong>${titleCase(task.taskType)}</strong>
            <span>${task.primaryModel} · ${task.privacyLevel}</span>
          </div>
          <span class="pill">${task.qualityTier}</span>
        </button>
      `
    )
    .join("");

  fillSelect(document.getElementById("taskSelect"), state.tasks, (task) => task.taskType, (task) => titleCase(task.taskType), selected.taskType);
  fillSelect(document.getElementById("primaryModelSelect"), models, (model) => model.id, (model) => model.displayName, selected.primaryModel);
  const fallbackSelect = document.getElementById("fallbackModelSelect");
  fallbackSelect.innerHTML = models
    .map((model) => `<option value="${escapeAttr(model.id)}" ${selected.fallbackModels.includes(model.id) ? "selected" : ""}>${escapeHtml(model.displayName)}</option>`)
    .join("");
  document.getElementById("taskCostInput").value = selected.maxCostUsd;
  document.getElementById("taskLatencyInput").value = selected.maxLatencyMs;
  document.getElementById("taskPrivacySelect").value = selected.privacyLevel;
  document.getElementById("selectedTaskTier").textContent = selected.qualityTier;

  fillSelect(document.getElementById("runTaskSelect"), state.tasks, (task) => task.taskType, (task) => titleCase(task.taskType), selectedTaskType);
  document.getElementById("runPreferredModelSelect").innerHTML =
    `<option value="">Автоматична маршрутизація</option>` +
    state.models
      .filter((model) => model.enabled)
      .map((model) => `<option value="${escapeAttr(model.id)}">${escapeHtml(model.displayName)}</option>`)
      .join("");
}

function renderBudgets() {
  document.getElementById("monthlyBudgetInput").value = state.budgets.monthlyWorkspaceBudgetUsd;
  document.getElementById("dailyBudgetInput").value = state.budgets.dailyWorkspaceBudgetUsd;
  document.getElementById("userBudgetInput").value = state.budgets.perUserMonthlyBudgetUsd;
  document.getElementById("thresholdInput").value = state.budgets.warningThresholdPercent;
  document.getElementById("hardLimitInput").checked = state.budgets.hardLimitEnabled;

  const spend = Object.entries(state.usageSummary.spendByModel).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...spend.map(([, value]) => value), 1);
  document.getElementById("spendBars").innerHTML = spend
    .map(
      ([modelId, value]) => `
        <div class="bar-item">
          <div class="bar-meta"><strong>${escapeHtml(modelId)}</strong><span>${formatUsd(value)}</span></div>
          <div class="bar-track"><span style="width:${Math.max(4, (value / max) * 100)}%"></span></div>
        </div>
      `
    )
    .join("");
}

function renderPrivacy() {
  document.getElementById("providerPolicyInput").value = state.providerRule.policy;
  document.getElementById("providerFallbackInput").checked = state.providerRule.allowProviderFallbacks;
  document.getElementById("noTrainingInput").checked = state.providerRule.requireNoTraining;
  document.getElementById("zeroRetentionInput").checked = state.providerRule.requireZeroRetention;
}

function renderEvaluation() {
  const models = state.models.filter((model) => model.enabled).slice(0, 3);
  document.getElementById("comparisonGrid").innerHTML = models
    .map(
      (model, index) => `
        <article class="comparison-card">
          <div>
            <strong>${escapeHtml(model.displayName)}</strong>
            <p>${comparisonCopy(index)}</p>
          </div>
          <div>
            <div class="score-line"><span>Комерційна релевантність</span><strong>${model.qualityScore}%</strong></div>
            <div class="score-line"><span>Затримка</span><strong>${model.latencyMs || 880} мс</strong></div>
            <div class="score-line"><span>Вартість</span><strong>$${model.inputPrice}/${model.outputPrice}</strong></div>
          </div>
        </article>
      `
    )
    .join("");
}

/* ── Папка як черга ────────────────────────────────────────────────────────
 *
 * Панель не дає гортати папку — вона веде по ній. Продавець вибирає продукт і
 * папку, а далі кожен наступний контакт відкривається на весь екран сам, по
 * порядку, і єдина навігація — «Назад» і «Далі». Позиція живе в localStorage,
 * бо це не стан робочого простору, а те, на кому зупинився конкретний продавець
 * у конкретному браузері.
 *
 * Контакт при відкритті потрапляє в чергу лідів — інакше досліджувати, писати
 * й фіксувати в CRM було б нічого.
 */

function renderPanelSource() {
  const productSelect = document.getElementById("panelProductSelect");
  if (productSelect) {
    fillSelect(productSelect, state?.products || [], (product) => product.id, (product) => product.name, state?.selectedProductId);
  }

  const folderSelect = document.getElementById("panelFolderSelect");
  if (folderSelect) {
    const options = [`<option value="">${contactFoldersLoaded ? "Папку не вибрано" : "Читаємо папки CRM..."}</option>`];
    for (const folder of contactFolders) {
      const count = Number(folder.contactCount) || 0;
      options.push(`<option value="${escapeAttr(folder.id)}" ${folder.id === panelFolderId ? "selected" : ""}>${escapeHtml(folder.name || "Без назви")} · ${count} ${uaPlural(count, "контакт", "контакти", "контактів")}</option>`);
    }
    // Папка, якої CRM більше не показує, все одно лишається тією, з якою людина
    // працює: прибрати її зі списку — це мовчки перекинути чергу в іншу папку.
    if (panelFolderId && !contactFolders.some((folder) => folder.id === panelFolderId)) {
      options.push(`<option value="${escapeAttr(panelFolderId)}" selected>Папка, якої CRM не показує</option>`);
    }
    folderSelect.innerHTML = options.join("");
    folderSelect.disabled = panelQueueBusy;
  }

  const position = panelFolderId && panelTotal
    ? `Контакт ${Math.min(panelIndex + 1, panelTotal)} з ${panelTotal}`
    : panelFolderId
      ? (panelQueueBusy ? "Читаємо папку..." : "У цій папці немає контактів")
      : "Вибери папку — далі люди йдуть по черзі";
  setText("panelQueuePosition", panelQueueNotice ? `${position} · ${panelQueueNotice}` : position);

  const meter = document.getElementById("panelQueueMeter");
  if (meter) meter.style.width = `${panelTotal ? Math.round(((Math.min(panelIndex + 1, panelTotal)) / panelTotal) * 100) : 0}%`;

  const refreshButton = document.getElementById("panelFoldersRefreshBtn");
  if (refreshButton) refreshButton.disabled = panelQueueBusy;
}

function rememberPanelPosition() {
  try {
    window.localStorage.setItem("outbound.panel.folder", panelFolderId);
    window.localStorage.setItem("outbound.panel.index", String(panelIndex));
  } catch {
    // Приватне вікно без localStorage — позиція просто не переживе перезавантаження.
  }
}

async function loadPanelFolders({ force = false } = {}) {
  panelQueueBusy = true;
  renderPanelSource();
  try {
    await fetchContactFolders({ force });
    if (panelFolderId && contactFolders.length && !contactFolders.some((folder) => folder.id === panelFolderId)) {
      panelQueueNotice = "";
    }
  } catch (error) {
    panelQueueNotice = error.message || "CRM не відповіла.";
  } finally {
    panelQueueBusy = false;
    renderPanelSource();
    refreshIcons();
  }
  if (panelFolderId && !panelTotal) await openPanelPosition(panelIndex);
}

/**
 * Відкрити людину, яка стоїть у папці на цьому місці.
 *
 * Сервер за одним запитом і дістає контакт, і бере його в чергу лідів, і віддає
 * весь стан робочого простору — щоб між «Далі» і карткою на екрані не було
 * проміжного стану, в якому лід уже вибраний, а даних про нього ще немає.
 */
async function openPanelPosition(index) {
  if (!panelFolderId || panelQueueBusy) return;
  const wanted = Math.max(0, Math.trunc(index));
  panelQueueBusy = true;
  panelQueueNotice = "";
  renderPanelSource();
  try {
    const payload = await api("/api/contacts/queue", {
      method: "POST",
      body: JSON.stringify({ folderId: panelFolderId, index: wanted })
    });
    const queue = payload.queue || {};
    state = payload;
    panelTotal = Number(queue.total) || 0;
    panelContact = queue.contact || null;
    if (!queue.contact) {
      panelQueueNotice = queue.warning || "Далі в цій папці нікого немає.";
      panelIndex = panelTotal ? Math.min(wanted, panelTotal - 1) : 0;
    } else {
      panelIndex = Number(queue.index) || 0;
      // Контакт без компанії — не лід: досліджувати нема по чому. Черга на
      // ньому не спиняється, але й мовчки його не пропускає.
      panelQueueNotice = queue.warning ? `${queue.contact.name || "Цей контакт"}: ${queue.warning}` : "";
      if (queue.prospectId) {
        selectedProspectId = queue.prospectId;
        if (activeResearchJob?.prospectId !== selectedProspectId) activeResearchJob = null;
        activeLeadSectionId = "dashboard-client";
      }
    }
    rememberPanelPosition();
    render();
    if (queue.contact) scrollLeadWorkspaceToTop();
  } catch (error) {
    panelQueueNotice = error.message || "CRM не відповіла.";
  } finally {
    panelQueueBusy = false;
    renderPanelSource();
    refreshIcons();
  }
}

/** «Назад» і «Далі»: по папці, коли папка вибрана, інакше по локальній черзі. */
function movePanel(direction) {
  // Поки йде збагачення, наступний контакт не відкривається: дослідження
  // дописує саме того ліда, який зараз на екрані, і підмінити його на півдорозі
  // означало б показати результат не про ту людину.
  if (busyAction) return;
  if (!panelFolderId) {
    moveSelectedProspect(direction);
    return;
  }
  const next = panelIndex + direction;
  if (next < 0) {
    panelQueueNotice = "Це перший контакт у папці.";
    renderPanelSource();
    return;
  }
  if (panelTotal && next >= panelTotal) {
    panelQueueNotice = "Папку пройдено до кінця.";
    renderPanelSource();
    return;
  }
  void openPanelPosition(next);
}

function renderProspects() {
  if (!state.prospects?.length) {
    selectedProspectId = null;
  } else if (!selectedProspectId || !state.prospects.some((prospect) => prospect.id === selectedProspectId)) {
    selectedProspectId = state.prospects[0].id;
  }

  const search = document.getElementById("prospectSearch").value.trim().toLowerCase();
  const status = document.getElementById("prospectStatusFilter").value;
  const filtered = (state.prospects || []).filter((prospect) => {
    const haystack = `${prospect.name} ${prospect.title} ${prospect.company} ${prospect.location} ${prospect.notes}`.toLowerCase();
    const matchesSearch = !search || haystack.includes(search);
    const matchesStatus = status === "all" || prospect.status === status;
    return matchesSearch && matchesStatus;
  });

  document.getElementById("prospectCount").textContent = `${filtered.length} ${uaPlural(filtered.length, "запис", "записи", "записів")}`;
  document.getElementById("prospectList").innerHTML = filtered.length
    ? filtered.map((prospect) => prospectCard(prospect)).join("")
    : `<div class="empty-state">Немає проспектів під цей фільтр</div>`;

  const selected = state.prospects?.find((prospect) => prospect.id === selectedProspectId);
  renderSelectedProspect(selected);
}

function prospectCard(prospect) {
  return `
    <article class="prospect-queue-row ${prospect.id === selectedProspectId ? "active" : ""}">
      <button class="prospect-card" data-prospect-id="${escapeAttr(prospect.id)}">
        <div class="avatar">${initials(prospect.name)}</div>
        <div>
          <strong>${escapeHtml(prospect.name)}</strong>
          <span>${escapeHtml([prospect.title, prospect.company].filter(Boolean).join(" · "))}</span>
          <small>${escapeHtml(prospect.location || "Без локації")} · ${escapeHtml(prospect.status)} · досяжність ${prospect.analysis?.reachProbability ?? 0}%</small>
        </div>
        <b>${prospect.score}</b>
      </button>
      <button class="icon-button queue-remove danger-button" type="button" data-remove-prospect-id="${escapeAttr(prospect.id)}" title="Прибрати з черги" aria-label="Прибрати з черги">
        <i data-lucide="trash-2"></i>
      </button>
    </article>
  `;
}

function renderSelectedProspect(prospect) {
  const enrichButton = document.getElementById("enrichProspectBtn");
  const prepareButton = document.getElementById("prepareOutreachBtn");
  const analyzeButton = document.getElementById("analyzeIntelligenceBtn");
  const refreshButton = document.getElementById("refreshIntelligenceBtn");
  const analyzeQuickButton = document.getElementById("analyzeIntelligenceQuick");
  if (enrichButton) enrichButton.disabled = !prospect;
  if (prepareButton) prepareButton.disabled = !prospect;
  if (analyzeButton) analyzeButton.disabled = !prospect;
  if (refreshButton) refreshButton.disabled = !prospect;
  if (analyzeQuickButton) analyzeQuickButton.disabled = !prospect;

  if (!prospect) {
    document.getElementById("selectedProspectName").textContent = "Вибери проспекта";
    document.getElementById("selectedProspectMeta").textContent = "Пошук контактів і AI-аутріч";
    document.getElementById("selectedProspectScore").textContent = "0";
    document.getElementById("selectedProspectStatus").textContent = "порожньо";
    document.getElementById("profileFields").innerHTML = "";
    document.getElementById("contactList").innerHTML = `<div class="empty-state">Проспекта не вибрано</div>`;
    document.getElementById("outreachContent").innerHTML = `<div class="empty-state">Аутріч не підготовлено</div>`;
    document.getElementById("leadAnalytics").innerHTML = "";
    document.getElementById("interactionList").innerHTML = `<div class="empty-state">Взаємодій не зафіксовано</div>`;
    setHtml("taskInteractionList", `<div class="empty-state">Взаємодій не зафіксовано</div>`);
    document.getElementById("taskNotificationList").innerHTML = `<div class="empty-state">Фолоу-апів немає</div>`;
    document.getElementById("outreachModel").textContent = "не підготовлено";
    renderLeadWorkspaceExtras(null);
    return;
  }

  document.getElementById("selectedProspectName").textContent = prospect.name;
  document.getElementById("selectedProspectMeta").textContent = [prospect.title, prospect.company, prospect.location].filter(Boolean).join(" · ");
  document.getElementById("selectedProspectScore").textContent = `${prospect.score}`;
  document.getElementById("selectedProspectStatus").textContent = prospect.status;
  document.getElementById("contactPolicy").textContent = prospect.contactDiscovery?.policy || "перевірка публічних джерел";
  document.getElementById("profileFields").innerHTML = profileFieldRows(prospect);
  document.getElementById("contactList").innerHTML = contactRows(prospect);
  document.getElementById("leadAnalytics").innerHTML = analyticsRows(prospect);
  document.getElementById("interactionList").innerHTML = interactionRows(prospect);
  setHtml("taskInteractionList", interactionRows(prospect));
  document.getElementById("taskNotificationList").innerHTML = taskNotificationRows(prospect);
  document.getElementById("outreachContent").innerHTML = outreachRows(prospect);
  document.getElementById("outreachModel").textContent = prospect.outreach?.modelUsed || "не підготовлено";
  renderLeadWorkspaceExtras(prospect);
}

function renderLeadWorkspaceExtras(prospect) {
  const prospects = state.prospects || [];
  const index = prospect ? prospects.findIndex((item) => item.id === prospect.id) : -1;
  const analysis = prospect?.analysis || { reachProbability: 0, closeProbability: 0, recommendedAction: "Запусти дослідження", reasoning: [] };
  const confidence = bestContactConfidence(prospect);
  const latest = prospect?.updatedAt ? `Оновлено ${relativeTime(prospect.updatedAt)}` : "Дослідження не запускалося";

  // Коли Панель веде папку, рахунок іде по папці, а не по локальній черзі:
  // «Лід 3 з 4» під час проходу дванадцяти тисяч контактів — це не той рахунок,
  // який людині потрібен.
  const folderName = contactFolders.find((folder) => folder.id === panelFolderId)?.name;
  setText("leadWorkspaceQueue", panelFolderId && panelTotal
    ? `${folderName || "Папка"} · ${Math.min(panelIndex + 1, panelTotal)} з ${panelTotal}`
    : prospects.length ? `Лід ${index + 1 || 1} з ${prospects.length}` : "Лідів не завантажено");
  setText("selectedLeadAvatar", prospect ? initials(prospect.name) : "OS");
  setText("leadWorkspaceCompany", prospect ? prospect.company || "Акаунт невідомий" : "Відкрий ліда, щоб почати");
  setText("leadWorkspacePosition", prospect ? [prospect.title, prospect.location, prospect.website].filter(Boolean).join(" · ") || "Деталей профілю ще немає" : "Додай посилання на LinkedIn, завантаж лідів або витягни їх із CRM. Система підготує бриф, контакти, повідомлення, записи в CRM і наступні дії — нічого не надсилаючи самостійно.");
  setText("leadWorkspaceFit", prospect ? `Відповідність: ${titleCase(analysis.productFit || "невідомо")}` : "Оцінки відповідності ще немає");
  setText("leadWorkspaceUpdated", latest);
  setText("leadWorkspaceConfidence", prospect ? `${confidence}% впевненості в найкращому контакті` : "Чекаємо на підтвердження");
  setText("committeeCount", prospect ? `${committeeForProspect(prospect).length} ${uaPlural(committeeForProspect(prospect).length, "контакт", "контакти", "контактів")}` : "0 контактів");

  renderMessageControls(prospect);
  renderInvite(prospect);
  // Стан запрошення живе в базі прогріву, тож його читають окремо — і лише
  // коли відкрили іншу людину, а не на кожне перемальовування.
  void loadInviteContext(prospect).catch(() => {});
  setHtml("clientProfileContent", clientProfileRows(prospect));
  setText("clientProfilePill", clientProfileStatusLabel(prospect));
  setText("clientProfileMeta", prospect
    ? `${prospect.name}${prospect.company ? ` · ${prospect.company}` : ""} — під продукт ${state.selectedProduct?.name || "вибраний"}`
    : "Хто це, що для нього важливо і з чого почати розмову");
  setHtml("companyBriefContent", companyBriefRows(prospect));
  setText("companyConfidencePill", companyConfidenceLabel(prospect));
  setText("companyBriefMeta", prospect?.company ? `Контекст акаунта ${prospect.company} для продукту ${state.selectedProduct?.name || "вибраного"}` : "Чим займається компанія, кому вона продає і чому цей лід може бути вартим уваги");
  setHtml("buyingCommitteeList", buyingCommitteeRows(prospect));
  setHtml("scoreBreakdown", scoreBreakdownRows(prospect));
  setHtml("nextActionSummary", nextActionRows(prospect));
  setHtml("salesCycleList", salesCycleRows(prospect));
  setHtml("intelligenceContent", intelligenceRows(prospect));
  setHtml("prospectingStrategyContent", prospectingStrategyRows(prospect));
  setText("intelligenceStatusPill", intelligenceStatusLabel(prospect));
  renderLeadSectionTabs();
  updateQuickCopies(prospect);
}

function renderLeadSectionTabs() {
  const sections = [...document.querySelectorAll(".lead-main-stack .lead-section")];
  if (!sections.some((section) => section.id === activeLeadSectionId)) activeLeadSectionId = "dashboard-account";
  document.querySelectorAll("[data-lead-tab]").forEach((button) => {
    const active = button.dataset.leadTab === activeLeadSectionId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    // Смужка вкладок — один рядок із горизонтальним скролом, і з одинадцятою
    // вкладкою активна регулярно опиняється за екраном: видно, що розділ
    // змінився, і не видно який.
    if (active && typeof button.scrollIntoView === "function") {
      button.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  });
  sections.forEach((section) => {
    const active = section.id === activeLeadSectionId;
    section.classList.toggle("active", active);
    section.setAttribute("aria-hidden", active ? "false" : "true");
  });
  const mobileSelect = document.getElementById("mobileLeadSectionSelect");
  if (mobileSelect) mobileSelect.value = activeLeadSectionId;
}

function renderLeadsPage() {
  const prospects = state.prospects || [];
  const ready = prospects.filter((prospect) => ["intelligence_ready", "outreach_ready", "linkedin_ready"].includes(prospect.status)).length;
  const active = prospects.filter((prospect) => ["contacted", "engaged", "follow_up_due", "meeting_booked"].includes(prospect.status)).length;
  const due = state.followUpTasks?.filter((task) => task.status !== "done").length || 0;
  setHtml("leadStatsStrip", `
    <div><span>Усього лідів</span><strong>${prospects.length}</strong></div>
    <div><span>Готові до контакту</span><strong>${ready}</strong></div>
    <div><span>Активні розмови</span><strong>${active}</strong></div>
    <div><span>Фолоу-апи</span><strong>${due}</strong></div>
  `);
  setHtml("leadTableBody", prospects.length
    ? prospects.map(leadTableRow).join("")
    : `<tr><td colspan="6"><div class="empty-state">Лідів ще немає. Витягни їх із CRM або додай ціль з LinkedIn на Панелі.</div></td></tr>`);
}

function leadTableRow(prospect) {
  const analysis = prospect.analysis || {};
  return `
    <tr>
      <td><strong>${escapeHtml(prospect.name)}</strong><span>${escapeHtml([prospect.title, prospect.company].filter(Boolean).join(" · "))}</span></td>
      <td><span class="pill">${escapeHtml(titleCase(prospect.status || "new"))}</span></td>
      <td><strong>${prospect.score || 0}</strong></td>
      <td><strong>${analysis.reachProbability || 0}%</strong></td>
      <td><span>${escapeHtml(analysis.recommendedAction || "Запусти дослідження")}</span></td>
      <td>
        <div class="table-action-row">
          <button type="button" data-open-prospect-id="${escapeAttr(prospect.id)}"><i data-lucide="arrow-up-right"></i><span>Відкрити</span></button>
          <button class="icon-button danger-button" type="button" data-remove-prospect-id="${escapeAttr(prospect.id)}" title="Видалити ліда" aria-label="Видалити ліда"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    </tr>
  `;
}

/* ── Запрошення в друзі ────────────────────────────────────────────────────
 *
 * Механічне робить машина, слова пише людина. Тут — механічне: вибрати акаунт,
 * поставити людину в чергу і показати, що з цього вийшло. Квота не списується
 * при постановці в чергу: рахується те, що справді вийшло з акаунта, а це знає
 * лише агент у момент відправки.
 *
 * Прив'язка — до контакту в CRM, а не до ліда: рядок аутрічу живе в базі
 * прогріву і переживає і ліда, і кампанію, через яку його взяли.
 */

const INVITE_STATUS_LABEL = {
  waiting: "У черзі",
  queued: "Закріплено кампанією",
  pending: "Надіслано",
  accepted: "Прийняв(ла)",
  connected: "Відповів(ла)",
  declined: "Відхилив(ла)",
  withdrawn: "Запит зник"
};

function crmContactIdOf(prospect) {
  return prospect?.crmSource?.contact_id || "";
}

async function loadInviteContext(prospect, { force = false } = {}) {
  const contactId = crmContactIdOf(prospect);
  if (!contactId) {
    inviteState = null;
    inviteLoadedFor = "";
    // Помилка попереднього ліда не є станом цього: без скидання картка людини
    // без LinkedIn підписувалася «невідомо» через збій, якого на ній не було.
    inviteNotice = "";
    renderInvite(prospect);
    return;
  }
  if (inviteLoadedFor === contactId && !force) return;
  inviteLoadedFor = contactId;
  inviteState = null;
  inviteNotice = "";
  renderInvite(prospect);
  try {
    const [invite, accounts] = await Promise.all([
      warmupApi(`/invites?crmContactId=${encodeURIComponent(contactId)}`),
      inviteAccountsLoaded && !force ? Promise.resolve(null) : warmupApi("/invites/accounts")
    ]);
    if (accounts) {
      inviteAccounts = accounts.accounts || [];
      inviteAccountsLoaded = true;
    }
    // Ліда могли перемкнути, поки відповідь ішла — тоді ця відповідь уже не про
    // ту людину, і показати її означало б збрехати про те, кого запросили.
    if (inviteLoadedFor !== contactId) return;
    inviteState = invite.invite || null;
  } catch (error) {
    inviteNotice = error.message || "Прогрів не відповів.";
  }
  renderInvite(state.prospects?.find((item) => item.id === selectedProspectId));
  refreshIcons();
}

function renderInvite(prospect) {
  const content = document.getElementById("inviteContent");
  if (!content) return;
  const contactId = crmContactIdOf(prospect);
  const invite = inviteState;

  // «Не надсилали» — це твердження, і після невдалого читання воно неправдиве:
  // ми не знаємо. Помилка має лишатися помилкою, а не ставати відповіддю.
  const unknown = !prospect || !prospect.linkedin || !contactId;
  setText("invitePill", unknown ? "—" : inviteNotice && !invite ? "невідомо" : invite ? INVITE_STATUS_LABEL[invite.status] || invite.status : "не надсилали");
  setText("inviteMeta", prospect?.linkedin
    ? "Щоб написати в LinkedIn, спершу треба бути в контактах"
    : "У цього ліда немає LinkedIn");

  if (!prospect) {
    content.innerHTML = `<div class="empty-state">Відкрий ліда.</div>`;
    return;
  }
  if (!prospect.linkedin) {
    content.innerHTML = `<div class="empty-state">У цього ліда немає посилання на LinkedIn — запрошення нема куди слати. Додай його в CRM або знайди профіль через «Контактні дані».</div>`;
    return;
  }
  if (!contactId) {
    // Лід із вставленого посилання або імпорту не має рядка в CRM, а запрошення
    // прив'язується саме до нього — інакше нічим тримати людину від того, щоб
    // її взяла кампанія.
    content.innerHTML = `<div class="empty-state">Цей лід не з CRM, а запрошення прив'язується до контакту в CRM. Відкрий людину з папки на Панелі, щоб надіслати запит.</div>`;
    return;
  }

  const notice = inviteNotice ? `<div class="outreach-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(inviteNotice)}</span></div>` : "";

  if (!invite) {
    content.innerHTML = `${notice}${inviteFormHtml(prospect)}`;
    return;
  }
  content.innerHTML = `${notice}${inviteStateHtml(invite, prospect)}`;
}

function inviteFormHtml(prospect) {
  const options = inviteAccounts.map((account) => {
    const left = account.canSend ? `${account.connectsLeft} з ${account.connectQuota} на сьогодні` : account.reason;
    return `<option value="${escapeAttr(account.id)}" ${account.canSend ? "" : "disabled"}>${escapeHtml(account.label)} · ${escapeHtml(left)}</option>`;
  }).join("");
  const usable = inviteAccounts.filter((account) => account.canSend);
  const note = suggestedInviteNote(prospect);

  // Читання впало — причина вже стоїть повідомленням вище, і дублювати її
  // формою, яка вдає, що досі вантажиться, гірше за порожнє місце.
  if (inviteNotice && !inviteAccounts.length) return "";
  if (!inviteAccountsLoaded) {
    return `<div class="empty-state">Читаємо акаунти прогріву...</div>`;
  }
  if (!inviteAccounts.length) {
    return `<div class="empty-state">Немає жодного акаунта LinkedIn. Додай його у вкладці «Прогрів».</div>`;
  }

  return `
    <div class="invite-form">
      <label class="lead-source-field">
        <span>З якого акаунта</span>
        <select id="inviteAccountSelect" aria-label="Акаунт LinkedIn">${options}</select>
      </label>
      <label class="lead-source-field">
        <span>Записка до запиту · до 300 символів, без продажу</span>
        <textarea id="inviteNoteInput" rows="3" maxlength="300">${escapeHtml(note)}</textarea>
      </label>
      ${usable.some((account) => account.connectsLeft > 0)
        ? ""
        : `<p class="is-muted">Сьогоднішню квоту вибрано на всіх акаунтах — запит стане в чергу і піде завтра.</p>`}
      <div class="invite-actions">
        <button class="primary-button" id="inviteSendBtn" type="button"><i data-lucide="user-plus"></i><span>Додати в друзі</span></button>
        <button id="inviteByHandBtn" type="button" title="Я вже натиснув Connect у своєму браузері"><i data-lucide="check"></i><span>Я надіслав сам</span></button>
      </div>
    </div>
  `;
}

/**
 * Текст записки, узятий із того, що модель уже написала для LinkedIn.
 *
 * Не вигадується тут заново: правила каналу (до 300 символів, без пропозиції)
 * живуть в одному місці, і другий автор із власним уявленням про них — це те,
 * через що два екрани починають слати різні речі.
 */
function suggestedInviteNote(prospect) {
  const invite = (prospect?.outreach?.messages || []).find((message) => message.channel === "linkedin_invite" && !message.hold);
  if (invite?.body) return String(invite.body).slice(0, 300);
  const approach = (prospect?.clientProfile?.approaches || []).find((item) => item.channel === "linkedin");
  return String(approach?.opener || "").slice(0, 300);
}

function inviteStateHtml(invite, prospect) {
  const account = inviteAccounts.find((item) => item.id === invite.accountId);
  const accountName = account?.label || invite.sentBy || "акаунт";
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" }) : "");

  const line = {
    waiting: `В черзі на акаунті «${accountName}»${invite.waitingDays ? ` · чекає ${invite.waitingDays} ${uaPlural(invite.waitingDays, "день", "дні", "днів")}` : " · піде найближчою сесією"}`,
    queued: `Цю людину закріпила кампанія на акаунті «${accountName}»`,
    pending: `Надіслано ${when(invite.sentAt || invite.heldAt)} з акаунта «${accountName}»${invite.sentByWhom === "seller" ? " · вручну" : ""}`,
    accepted: `Прийняв(ла) — можна писати. Запит ішов з акаунта «${accountName}»`,
    connected: `Уже відповів(ла)${invite.respondedAt ? ` ${when(invite.respondedAt)}` : ""} — дивись переписку у «Прогрів → Вхідні»`,
    declined: `Не прийняв(ла) запит із акаунта «${accountName}»`,
    withdrawn: `Запит більше не висить у надісланих — або відкликано, або профіль зник`
  }[invite.status] || `Статус: ${invite.status}`;

  const stale = invite.status === "waiting" && invite.waitingDays >= 7
    ? `<div class="outreach-warning"><i data-lucide="triangle-alert"></i><span>Чекає понад тиждень. Акаунт «${escapeHtml(accountName)}» міг перестати гріти — перекинь на інший або скасуй.</span></div>`
    : "";

  const movable = inviteAccounts.filter((item) => item.canSend && item.id !== invite.accountId);
  const actions = invite.status === "waiting"
    ? `
      <div class="invite-actions">
        ${movable.length ? `<select id="inviteMoveSelect" aria-label="Перекинути на інший акаунт">${movable.map((item) => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.label)} · ${item.connectsLeft} на сьогодні</option>`).join("")}</select>
        <button id="inviteMoveBtn" type="button"><i data-lucide="arrow-right-left"></i><span>Перекинути</span></button>` : ""}
        <button id="inviteByHandBtn" type="button"><i data-lucide="check"></i><span>Я надіслав сам</span></button>
        <button class="danger-button" id="inviteCancelBtn" type="button"><i data-lucide="x"></i><span>Скасувати</span></button>
      </div>`
    : "";

  const draft = invite.status === "accepted"
    ? inviteFirstMessageHtml(prospect)
    : "";

  return `
    ${stale}
    <div class="invite-state">
      <strong>${escapeHtml(INVITE_STATUS_LABEL[invite.status] || invite.status)}</strong>
      <span>${escapeHtml(line)}</span>
      ${invite.note ? `<pre>${escapeHtml(invite.note)}</pre>` : ""}
      ${invite.overQuota ? `<small class="is-muted">Записано понад денну норму акаунта — видно в його історії.</small>` : ""}
      ${invite.lastCheckedAt ? `<small class="is-muted">Востаннє перевіряли ${relativeTime(invite.lastCheckedAt)}</small>` : ""}
    </div>
    ${actions}
    ${draft}
  `;
}

/** Прийняли — час писати, і пише людина. Тут лише чернетка і кнопка копіювати. */
function inviteFirstMessageHtml(prospect) {
  const message = (prospect?.outreach?.messages || []).find((item) => item.channel === "linkedin_follow_up" && !item.hold);
  if (!message?.body) {
    return `<div class="empty-state">Чернетки першого повідомлення ще немає — натисни «Збагатити», і вона з'явиться у «Повідомленнях».</div>`;
  }
  return `
    <article class="message-card">
      <div class="message-heading">
        <span class="pill">Перше повідомлення</span>
        <button data-copy-text="${escapeAttr(message.body)}" data-copy-channel="linkedin" data-copy-label="Перше повідомлення в LinkedIn"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </div>
      <pre>${escapeHtml(message.body)}</pre>
      <small class="message-basis">Надсилає людина зі свого акаунта — платформа цього не робить.</small>
    </article>
  `;
}

/* ── Опис клієнта і підходи ────────────────────────────────────────────────
 *
 * Те, заради чого натискають «Збагатити»: хто ця людина, що для неї зараз
 * важливо і з чого почати розмову. Усе інше на цій сторінці — джерела під це.
 */

const clientChannelLabels = {
  email: "Пошта",
  linkedin: "LinkedIn",
  telegram: "Telegram",
  phone: "Телефон"
};

function clientProfileRows(prospect) {
  if (!prospect) {
    return `<div class="empty-state">Вибери папку з контактами — перша людина відкриється сама.</div>`;
  }
  const profile = prospect.clientProfile;
  if (!profile) {
    return `<div class="empty-state">Цю людину ще не збагачували. Тисни «Збагатити»: модель знайде все доступне про неї і про компанію, запише знайдене в базу — і на цьому місці з'явиться опис клієнта та підходи до розмови.</div>`;
  }

  const approaches = (profile.approaches || []).map((approach, index) => {
    // Той самий замок, що й на картках каналів: скопійований рядок одразу
    // лягає в історію як дотик цим каналом, тож копіювати пошту людини, чию
    // пошту ще ніхто не схвалив, — це запис про дію, якої не можна робити.
    const canUse = approvedChannel(prospect, approach.channel || "");
    return `
    <article class="client-approach">
      <header>
        <div>
          <span class="pill">${escapeHtml(clientChannelLabels[approach.channel] || approach.channel || "канал не вибрано")}</span>
          <strong>${escapeHtml(approach.angle || `Підхід ${index + 1}`)}</strong>
        </div>
        <button data-copy-text="${canUse ? escapeAttr(approach.opener || "") : ""}" data-copy-channel="${escapeAttr(approach.channel || "")}" data-copy-label="Підхід: ${escapeAttr(approach.angle || "")}" title="${canUse ? "Копіювати" : "Спочатку схвали контакт у розділі «Контакти»"}" ${canUse ? "" : "disabled"}><i data-lucide="${canUse ? "copy" : "lock-keyhole"}"></i><span>Копіювати</span></button>
      </header>
      <p class="client-approach-opener">${escapeHtml(approach.opener || "")}</p>
      ${approach.why ? `<p class="client-approach-why"><strong>Чому має спрацювати.</strong> ${escapeHtml(approach.why)}</p>` : ""}
      ${approach.risk ? `<p class="client-approach-risk"><strong>Чим може не зайти.</strong> ${escapeHtml(approach.risk)}</p>` : ""}
    </article>
  `;
  }).join("");

  const list = (title, items, empty) => {
    const rows = (items || []).filter(Boolean);
    if (!rows.length && !empty) return "";
    return `<section class="client-profile-list">
      <h3>${escapeHtml(title)}</h3>
      ${rows.length ? `<ul>${rows.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="is-muted">${escapeHtml(empty)}</p>`}
    </section>`;
  };

  const research = profile.companyResearch;
  const memoryNote = research
    ? research.reused
      ? `Компанію не шукали заново — узято з бази, дослідження від ${relativeTime(research.researchedAt)}.`
      : `Компанію досліджено ${relativeTime(research.researchedAt)} і записано в базу — наступний контакт із неї піде без пошуку.`
    : "";
  const productNote = profile.productId && state?.selectedProductId && profile.productId !== state.selectedProductId
    ? `<div class="outreach-warning"><i data-lucide="triangle-alert"></i><span>Цей опис написано під продукт «${escapeHtml(profile.productName || "інший")}». Щоб отримати його під вибраний зараз продукт, збагати ще раз.</span></div>`
    : "";

  return `
    ${productNote}
    <p class="client-profile-description">${escapeHtml(profile.description || "")}</p>
    <div class="client-profile-split">
      <section><h3>Людина</h3><p>${escapeHtml(profile.person || "—")}</p></section>
      <section><h3>Компанія</h3><p>${escapeHtml(profile.company || "—")}</p></section>
    </div>
    ${list("Що для нього зараз важливо", profile.whatMatters)}
    <section class="client-approach-list">
      <h3>Підходи до розмови</h3>
      ${approaches || `<p class="is-muted">Підходів не згенеровано.</p>`}
    </section>
    ${list("Про що спитати", profile.questions)}
    ${list("Чого не робити", profile.avoid)}
    ${list("Чого нам бракує", profile.unknowns)}
    ${(profile.warnings || []).length ? `<div class="outreach-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(profile.warnings.join(" "))}</span></div>` : ""}
    <div class="client-profile-meta">
      <span>${escapeHtml(profile.productName || "продукт")} · ${escapeHtml(profile.modelUsed || "локально")} · ${relativeTime(profile.generatedAt)}</span>
      ${memoryNote ? `<span>${escapeHtml(memoryNote)}</span>` : ""}
    </div>
  `;
}

function clientProfileStatusLabel(prospect) {
  if (!prospect) return "ліда не вибрано";
  if (!prospect.clientProfile) return "ще не збагачено";
  return prospect.clientProfile.companyResearch?.reused ? "збагачено · компанія з бази" : "збагачено";
}

function companyConfidenceLabel(prospect) {
  if (!prospect) return "без дослідження";
  const profile = prospect.companyProfile || prospect.leadIntelligence?.company_context;
  if (!profile) return "потрібне дослідження";
  const confidence = Number(profile.confidence || 0);
  if (confidence >= 75) return `${confidence}% впевненості`;
  if (confidence >= 45) return `${confidence}% — треба перевірити`;
  return "мало даних про компанію";
}

function companyBriefRows(prospect) {
  if (!prospect) return `<div class="empty-state">Відкрий ліда і запусти дослідження, щоб зібрати контекст компанії.</div>`;
  const profile = prospect.companyProfile || prospect.leadIntelligence?.company_context || {};
  const confidence = Number(profile.confidence || 0);
  const description = profile.description || `${prospect.company || "Цей акаунт"} потребує дослідження компанії, перш ніж аутріч можна вважати впевненим.`;
  const cards = [
    ["Чим займаються", description],
    ["Розмір компанії", profile.size_estimate || "Невідомо"],
    ["Аудиторія", profile.audience || "Невідомо"],
    ["Бізнес-модель", profile.business_model || "Невідомо"],
    ["Категорія", profile.category || "Потрібне дослідження"],
    ["Чому релевантно", profile.why_relevant || prospect.analysis?.reasoning?.[0] || "Запусти дослідження, щоб знайти кут заходу."]
  ];
  const priorities = detailChipList(profile.likely_priorities, "Пріоритетів поки не видно");
  const growth = detailChipList(profile.growth_signals, "Сигналів росту поки немає");
  const stack = detailChipList(profile.tech_stack, "Технологічний стек поки не знайдено");
  const unknowns = detailChipList(profile.unknowns, "Відкритих прогалин по компанії немає");
  const links = (profile.research_links || []).slice(0, 4).map((item) => {
    const url = typeof item === "string" ? item : item.url;
    const label = typeof item === "string" ? shortUrl(item) : item.label || item.title || shortUrl(item.url || "");
    return url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>` : "";
  }).filter(Boolean).join("");
  const apps = profile.app_portfolio?.apps || prospect.appPortfolio?.apps || [];
  const appEvidence = profile.app_portfolio?.evidence || prospect.appPortfolio?.evidence || [];
  const appRows = apps.length ? apps.map((app) => `
    <article class="app-title-row">
      <div><strong>${escapeHtml(app.title)}</strong><span>${escapeHtml([app.os, app.category, app.publisher].filter(Boolean).join(" · "))}</span></div>
      <div class="app-facts"><span>${escapeHtml(app.geo || "GEO не підтверджено")}</span><span>${escapeHtml(app.monetization || "Монетизацію не підтверджено")}</span><span>${escapeHtml(app.recentRelease ? new Date(app.recentRelease).toLocaleDateString() : "Дата релізу невідома")}</span></div>
      ${evidenceLinks(appEvidence.filter((source) => (app.evidenceSourceIds || []).includes(source.source_id)))}
    </article>
  `).join("") : `<div class="empty-state">Жодного застосунку в сторі не зіставлено впевнено. Дослідження записує це як прогалину, а не вигадує назву.</div>`;

  return `
    <div class="company-summary">
      ${cards.map(([label, value]) => `
        <article>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          ${companyClaimEvidence(profile, label, prospect)}
        </article>
      `).join("")}
    </div>
    <div class="company-detail-grid">
      <section>
        <strong>Ймовірні пріоритети</strong>
        <div class="cap-list">${priorities}</div>
      </section>
      <section>
        <strong>Сигнали росту</strong>
        <div class="cap-list">${growth}</div>
      </section>
      <section>
        <strong>Технології та інструменти</strong>
        <div class="cap-list">${stack}</div>
      </section>
      <section>
        <strong>Що треба перевірити</strong>
        <div class="cap-list">${unknowns}</div>
      </section>
    </div>
    <section class="app-portfolio-section">
      <div class="subpanel-heading"><h3>Застосунки та останні релізи</h3><span>назва · OS · GEO · монетизація · докази</span></div>
      <div class="app-title-list">${appRows}</div>
    </section>
    <div class="company-research-footer">
      <span>Впевненість у контексті компанії: ${confidence}%</span>
      <div>${links || `<span>Посилань на джерела ще немає</span>`}</div>
    </div>
  `;
}

function companyClaimEvidence(profile, label, prospect) {
  const mapping = { "Чим займаються": "Company description", "Розмір компанії": "Company size", "Аудиторія": "Audience and business model", "Бізнес-модель": "Audience and business model", "Категорія": "Company category", "Чому релевантно": "Product relevance" };
  const claim = (profile.claim_evidence || []).find((item) => item.claim === mapping[label]);
  if (!claim) return "";
  const sources = [...(prospect.leadIntelligence?.sources || []), ...(prospect.appPortfolio?.evidence || [])]
    .filter((source) => (claim.source_ids || []).includes(source.source_id));
  return `<div class="claim-evidence"><i data-lucide="link-2"></i><span>${Number(claim.confidence || 0)}%</span>${evidenceLinks(sources, true)}</div>`;
}

function evidenceLinks(sources = [], compact = false) {
  const links = sources.slice(0, compact ? 2 : 5).map((source) => source.url
    ? `<a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer" title="${escapeAttr(source.excerpt || source.evidence_excerpt || "")}">${escapeHtml(source.title || shortUrl(source.url))}</a>`
    : `<span title="${escapeAttr(source.excerpt || source.evidence_excerpt || "")}">${escapeHtml(source.title || source.source_id || "Внутрішнє джерело")}</span>`
  ).join("");
  return links ? `<div class="evidence-links">${links}</div>` : `<span class="evidence-missing">Докази ще не зібрані</span>`;
}

function detailChipList(items, emptyText) {
  const values = (items || []).filter(Boolean).slice(0, 6);
  return values.length
    ? values.map((item) => `<span class="cap">${escapeHtml(item)}</span>`).join("")
    : `<span class="cap muted">${escapeHtml(emptyText)}</span>`;
}

function accountSignalRows(prospect) {
  if (!prospect) return `<div class="empty-state">Запусти дослідження, щоб побачити сигнали по акаунту</div>`;
  const analysis = prospect.analysis || {};
  const publicNote = publicLeadNote(prospect.notes);
  const signals = [
    publicNote ? { label: "Контекст ліда", value: publicNote, confidence: 78 } : null,
    prospect.contactDiscovery?.scraperNote ? { label: "Пошук контактів", value: prospect.contactDiscovery.scraperNote, confidence: 70 } : null,
    ...(analysis.reasoning || []).map((value) => ({ label: "Міркування AI", value, confidence: 74 }))
  ].filter(Boolean);
  return signals.length
    ? signals.map((signal) => `
      <article class="research-signal">
        <i data-lucide="radar"></i>
        <div>
          <strong>${escapeHtml(signal.label)}</strong>
          <span>${escapeHtml(signal.value)}</span>
        </div>
        <b>${signal.confidence}%</b>
      </article>
    `).join("")
    : `<div class="empty-state">Сигналів по акаунту ще немає</div>`;
}

function buyingCommitteeRows(prospect) {
  if (!prospect) return `<div class="empty-state">Відкрий ліда, щоб зібрати комітет із закупівлі</div>`;
  const committee = committeeForProspect(prospect);
  return `${companyPeopleDirectoryCard(prospect)}${committee.map((member) => `
    <article class="committee-card">
      <div class="avatar">${initials(member.name)}</div>
      <div>
        <strong>${member.linkedin ? `<a href="${escapeAttr(member.linkedin)}" target="_blank" rel="noreferrer">${escapeHtml(member.name)}</a>` : escapeHtml(member.name)}</strong>
        <span>${escapeHtml([member.title, member.context].filter(Boolean).join(" · "))}</span>
      </div>
      <span class="pill">${escapeHtml(member.confidence ? `${member.confidence}%` : titleCase(member.role))}</span>
    </article>
  `).join("")}`;
}

function companyPeopleDirectoryCard(prospect) {
  const url = companyLinkedInPeopleUrlForProspect(prospect);
  if (!url) return "";
  const storedSource = prospect.publicCompanyResearch?.linkedinCompanySource || "";
  const source = storedSource === "inferred_company_slug" || (!prospect.publicCompanyResearch?.linkedinPeopleUrl && !prospect.companyLinkedin)
    ? "виведено з назви компанії"
    : "LinkedIn компанії";
  return `
    <article class="committee-directory-card">
      <div>
        <strong>Люди компанії в LinkedIn</strong>
        <span>${escapeHtml(source)} · відкрий, переглянь співробітників і вибери 1-2 релевантні цілі</span>
      </div>
      <a class="mini-button" href="${escapeAttr(url)}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i><span>Відкрити людей</span></a>
    </article>
  `;
}

function committeeForProspect(prospect) {
  if (!prospect) return [];
  const sameCompany = (state.prospects || []).filter((item) => item.company?.toLowerCase() === prospect.company?.toLowerCase());
  const known = sameCompany.filter((item) => isNamedPersonLead(item));
  const rows = known.map((item) => ({
    name: item.name,
    title: item.title || "Посада невідома",
    role: committeeRole(item.title),
    context: item.id === prospect.id ? "поточний лід" : "вже є в черзі",
    linkedin: item.linkedin || "",
    confidence: item.id === prospect.id ? 88 : 78
  }));
  rows.push(...(prospect.companyPeople || []).map((person) => ({
    name: person.name,
    title: person.title || "Посада невідома",
    role: person.role || committeeRole(person.title),
    context: person.context || "знайдено під час скрейпу компанії",
    linkedin: person.linkedin || "",
    confidence: person.confidence || 64
  })));
  const suggestedBuyer = /adaction/i.test(state.selectedProduct?.name || "")
    ? "Хтось із UA, Growth, Monetization або Product"
    : /black affiliate/i.test(state.selectedProduct?.name || "")
      ? "Хтось із Affiliates, Partnerships або Acquisition"
      : "Покупець, релевантний продукту";
  rows.push({ name: suggestedBuyer, title: "Кого варто дослідити наступним", role: "suggested", context: "ще не знайдено", confidence: 45 });
  return mergeCommitteeRows(rows).slice(0, 8);
}

function mergeCommitteeRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (!row.name) continue;
    const key = row.linkedin?.toLowerCase() || `${row.name}:${row.title}`.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || Number(row.confidence || 0) > Number(existing.confidence || 0)) byKey.set(key, row);
  }
  return [...byKey.values()].sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0));
}

function committeeRole(title) {
  const text = String(title || "").toLowerCase();
  if (/founder|ceo|owner|president/.test(text)) return "economic_buyer";
  if (/vp|head|chief|revenue|sales|growth/.test(text)) return "decision_maker";
  if (/ops|operations|revops|crm/.test(text)) return "champion";
  if (/finance|legal|procurement|security/.test(text)) return "approver";
  return "influencer";
}

function scoreBreakdownRows(prospect) {
  if (!prospect) return `<div class="empty-state">Скоринг з'явиться після вибору ліда</div>`;
  const analysis = prospect.analysis || {};
  const inputs = analysis.scoreInputs || {};
  const rows = [
    ["Бал ліда", prospect.score || 0, "final"],
    ["Готовність", inputs.readiness || 0, "driver"],
    ["Досяжність", analysis.reachProbability || 0, "probability"],
    ["Шанс закрити", analysis.closeProbability || 0, "probability"],
    ["Контекст компанії", inputs.companyContext || 0, "driver"],
    ["Підтвердження контакту", inputs.contactEvidence || bestContactConfidence(prospect), "driver"],
    ["Тригер за часом", inputs.trigger || 0, "driver"],
    ["Відповідність продукту", inputs.fit || 0, "driver"],
    ["Штраф", inputs.penalty || 0, "penalty"]
  ];
  const scoreRows = rows.map(([label, value, type]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${type === "penalty" ? `-${value}` : `${value}%`}</strong>
      <div class="meter compact ${type === "penalty" ? "penalty" : ""}"><span style="width:${Math.max(0, Math.min(100, Number(value) || 0))}%"></span></div>
    </div>
  `).join("");
  const model = state.scoringModel || {};
  return `${scoreRows}
    <article class="scoring-learning-card">
      <div><span>Навчання на результатах CRM</span><strong>${escapeHtml(titleCase(model.status || "insufficient_data"))}</strong></div>
      <p>${Number(model.sampleSize || 0)} з ${Number(model.minimumSamples || 20)} закритих лідів · ${Number(model.positiveOutcomes || 0)} позитивних · ${Number(model.negativeOutcomes || 0)} негативних</p>
      <button type="button" id="retrainScoringBtn"><i data-lucide="refresh-cw"></i><span>Перерахувати ваги</span></button>
    </article>`;
}

function nextActionRows(prospect) {
  if (!prospect) return `<div class="empty-state">Вибери ліда, щоб побачити наступну дію</div>`;
  const analysis = prospect.analysis || {};
  const plan = prospect.nextActionPlan;
  const channel = prospect.outreach?.recommendedChannel || preferredChannel(prospect);
  if (plan) {
    const preTouch = (plan.preTouchActions || []).slice(0, 4).map((action) => `<span class="cap">${escapeHtml(action)}</span>`).join("");
    const channelOrder = (plan.channelOrder || []).slice(0, 7).map((item) => `<span>${escapeHtml(titleCase(item))}</span>`).join("");
    return `
      <article class="next-action-card">
        <i data-lucide="sparkles"></i>
        <div>
          <strong>${escapeHtml(plan.primaryAction || analysis.recommendedAction || "Запусти дослідження і підготуй аутріч")}</strong>
          <span>Найкращий канал: ${escapeHtml(plan.bestChannel || channel)} · Досяжність ${plan.score?.reachProbability || analysis.reachProbability || 0}% · Закрити ${plan.score?.closeProbability || analysis.closeProbability || 0}%</span>
          <p>${escapeHtml(plan.reason || (analysis.reasoning || []).join(" "))}</p>
          ${preTouch ? `<div class="next-action-caps">${preTouch}</div>` : ""}
          <div class="next-action-follow">
            <strong>${escapeHtml(plan.followUp?.label || "Фолоу-ап")}</strong>
            <span>${escapeHtml(plan.followUp?.trigger || "через 2-3 дні після запиту")} · ${plan.followUp?.due ? escapeHtml(new Date(plan.followUp.due).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })) : "заплановано"}</span>
          </div>
          ${channelOrder ? `<div class="channel-order">${channelOrder}</div>` : ""}
        </div>
      </article>
    `;
  }
  return `
    <article class="next-action-card">
      <i data-lucide="sparkles"></i>
      <div>
        <strong>${escapeHtml(analysis.recommendedAction || "Запусти дослідження і підготуй аутріч")}</strong>
        <span>Найкращий канал: ${escapeHtml(channel)} · Досяжність ${analysis.reachProbability || 0}% · Закрити ${analysis.closeProbability || 0}%</span>
        <p>${escapeHtml((analysis.reasoning || []).join(" "))}</p>
      </div>
    </article>
  `;
}

function salesCycleRows(prospect) {
  if (!prospect) return `<div class="empty-state">Ліда не вибрано</div>`;
  const baseItems = [
    { label: "Додано в чергу", value: relativeTime(prospect.createdAt), state: "done" },
    { label: "Дослідження", value: prospect.contactDiscovery ? "виконано" : "не запускалося", state: prospect.contactDiscovery ? "done" : "pending" },
    { label: "Аутріч підготовлено", value: prospect.outreach ? relativeTime(prospect.outreach.preparedAt || prospect.updatedAt) : "очікує", state: prospect.outreach ? "done" : "pending", type: "outreach_prepared" },
    { label: "Остання дія в CRM", value: (prospect.interactions || [])[0]?.type ? titleCase(prospect.interactions[0].type) : "нічого не зафіксовано", state: (prospect.interactions || []).length ? "done" : "pending" }
  ];
  const cadenceItems = (prospect.salesCadence?.steps || []).slice(0, 5).map((step) => ({
    label: step.label,
    value: [step.day, step.channel, step.messageChannel ? `копія ${titleCase(step.messageChannel)}` : ""].filter(Boolean).join(" · "),
    state: (prospect.interactions || []).some((interaction) => interaction.type === step.type) ? "done" : "pending",
    type: step.type
  }));
  const items = [...baseItems, ...cadenceItems];
  return items.map((item) => `
    <article class="cycle-row ${item.state}">
      <span></span>
      <div>
        <strong>${escapeHtml(item.label)}</strong>
        <small>${escapeHtml(item.value)}</small>
      </div>
      ${item.type && item.state !== "done" ? `<button type="button" data-interaction-type="${escapeAttr(item.type)}"><i data-lucide="check"></i><span>Готово</span></button>` : ""}
    </article>
  `).join("");
}

function sourceAuditRows(prospect) {
  if (!prospect) return `<div class="empty-state">Джерела з'являться після імпорту профілю і дослідження</div>`;
  const productSources = state.selectedProduct?.mcpContext?.sources || [];
  const contactSources = prospect.contactDiscovery?.candidates || [];
  const intelSources = prospect.leadIntelligence?.sources || [];
  const researchRows = (prospect.researchHistory || []).slice(0, 5).map((record) => ({
    source: `Пам'ять досліджень · ${titleCase(record.stage || "дослідження")}`,
    claim: `${record.summary || "Дослідження ліда збережено."} ${record.contactSnapshot ? `Контактів: ${record.contactSnapshot.candidates || 0}, найкраща впевненість: ${record.contactSnapshot.bestConfidence || 0}%` : ""}`.trim(),
    confidence: record.analysis?.reachProbability || record.score || 0,
    status: record.at ? `збережено ${relativeTime(record.at)}` : "збережено"
  }));
  const rows = [
    { source: "Завантажений профіль або CRM", claim: [prospect.name, prospect.company, prospect.title].filter(Boolean).join(" · "), confidence: 82, status: "дані робочого простору" },
    ...researchRows,
    ...productSources.map((source) => ({ source: source.name, claim: source.type, confidence: source.confidence, status: "контекст продукту" })),
    ...intelSources.slice(0, 8).map((source) => ({ source: source.title || source.source_id, claim: source.evidence_excerpt || source.source_type, confidence: source.quality === "high" ? 90 : source.quality === "medium" ? 70 : 45, status: `${source.source_type || "джерело"} · ${source.claim_type || "твердження"}` })),
    ...contactSources.map((candidate) => ({ source: candidate.source, claim: `${candidate.type}: ${candidate.value}`, confidence: candidate.confidence, status: candidate.status })),
    ...(prospect.contactDiscovery?.warnings || []).map((warning) => ({ source: "Попередження збагачення", claim: warning, confidence: 0, status: "потрібна перевірка" }))
  ];
  return rows.map((row) => `
    <article class="source-row">
      <div>
        <strong>${escapeHtml(row.source || "Джерело невідоме")}</strong>
        <span>${escapeHtml(row.claim || "Без твердження")}</span>
      </div>
      <small>${escapeHtml(row.status || "перевірка")} · ${row.confidence || 0}%</small>
    </article>
  `).join("");
}

function intelligenceStatusLabel(prospect) {
  const intel = prospect?.leadIntelligence;
  if (!prospect) return "ліда немає";
  if (!intel) return "не проаналізовано";
  return `${titleCase(intel.status || "готово")} · ${intel.priority_wave || "без хвилі"}`;
}

function intelligenceRows(prospect) {
  if (!prospect) {
    return `<div class="empty-state">Вибери ліда, щоб проаналізувати відповідність акаунта, джерела, прогалини, повідомлення й наступну дію.</div>`;
  }
  const intel = prospect.leadIntelligence;
  if (!intel) {
    return `
      <div class="intelligence-empty">
        <i data-lucide="brain-circuit"></i>
        <div>
          <strong>Брифу по акаунту ще немає</strong>
          <span>Проаналізуй один раз — дослідження акаунта збережеться і підтягнеться, коли повернешся до цього ліда або до іншого контакту з тієї ж компанії.</span>
        </div>
        <button class="primary-button" type="button" data-intel-analyze="fresh"><i data-lucide="sparkles"></i><span>Зібрати бриф</span></button>
      </div>
    `;
  }

  const warnings = (intel.warnings || []).map((warning) => `<span class="warning-chip">${escapeHtml(warning)}</span>`).join("");
  const profile = [intel.analysis_profile_name, intel.schema_version, intel.prompt_version].filter(Boolean).join(" · ");
  const refreshed = intel.last_refreshed_at ? `Оновлено ${relativeTime(intel.last_refreshed_at)}` : "Збережено";
  const scores = [
    ["Відповідність", intel.fit_score || 0],
    ["Пріоритет", intel.priority_score || 0],
    ["Впевненість", intel.overall_confidence || 0],
    ["Легкість дзвінка", 100 - ((Number(intel.call_difficulty || 3) - 1) * 20)]
  ];
  const scoreCards = scores.map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${Math.max(0, Math.min(100, Math.round(value)))}%</strong>
      <div class="meter compact"><span style="width:${Math.max(0, Math.min(100, Math.round(value)))}%"></span></div>
    </div>
  `).join("");
  const scoringInputs = (intel.scoring_inputs || []).map((input) => {
    const pct = input.max ? Math.round((Number(input.value || 0) / Number(input.max || 1)) * 100) : 0;
    return `
      <article class="intel-input-row ${input.penalty ? "penalty" : ""}">
        <div>
          <strong>${escapeHtml(input.label || input.key)}</strong>
          <span>${escapeHtml(input.rationale || "")}</span>
        </div>
        <b>${escapeHtml(input.penalty ? `-${input.value}` : `${input.value}/${input.max}`)}</b>
        <div class="meter compact"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>
      </article>
    `;
  }).join("");
  const nextSteps = (intel.next_steps || []).slice(0, 4).map((step, index) => `
    <article class="intel-step ${step.priority === "high" ? "urgent" : ""}">
      <div>
        <strong>${escapeHtml(step.action)}</strong>
        <span>${escapeHtml([step.priority, step.owner, step.rationale].filter(Boolean).join(" · "))}</span>
      </div>
      <button type="button" data-intel-task-index="${index}"><i data-lucide="bell-plus"></i><span>Завдання</span></button>
    </article>
  `).join("");
  const gaps = (intel.research_gaps || []).slice(0, 5).map((gap) => `
    <article class="intel-gap ${gap.status === "resolved" ? "resolved" : ""}">
      <div>
        <strong>${escapeHtml(gap.missing_field)}</strong>
        <span>${escapeHtml(gap.why_it_matters)}</span>
        <small>${escapeHtml(gap.recommended_resolution || "")}</small>
      </div>
      <button type="button" data-intel-review-action="mark_gap_resolved" data-intel-target-id="${escapeAttr(gap.id)}"><i data-lucide="check-circle-2"></i><span>Закрити</span></button>
    </article>
  `).join("");
  const messages = (intel.contact_personalization?.messages || intel.messages || []).slice(0, 5).map((message) => `
    <article class="message-card intel-message">
      <div class="message-heading">
        <span class="pill">${escapeHtml(titleCase(message.channel || "чернетка"))}</span>
        ${message.subject ? `<strong>${escapeHtml(message.subject)}</strong>` : ""}
        <button data-copy-text="${escapeAttr(message.body || "")}" data-copy-channel="${escapeAttr(message.channel || "draft")}" data-copy-label="Повідомлення з брифу" title="Копіювати" aria-label="Копіювати"><i data-lucide="copy"></i></button>
      </div>
      <pre>${escapeHtml(message.body || "")}</pre>
      <small>${escapeHtml((message.personalization_basis || []).slice(0, 3).join(" · "))}</small>
    </article>
  `).join("");
  const contacts = (intel.recommended_contacts || []).slice(0, 4).map((contact) => `
    <article class="intel-contact">
      <strong>${escapeHtml(contact.full_name || contact.target_role || "Цільова роль")}</strong>
      <span>${escapeHtml([contact.role, contact.persona, contact.verification_status].filter(Boolean).join(" · "))}</span>
      <small>${escapeHtml(contact.why_target || "")}</small>
    </article>
  `).join("");
  const objections = (intel.objections || []).slice(0, 4).map((item) => `
    <article class="intel-objection">
      <strong>${escapeHtml(item.objection)}</strong>
      <span>${escapeHtml(item.recommended_response)}</span>
      <small>${escapeHtml(item.qualification_question || item.proof_required || "")}</small>
    </article>
  `).join("");
  return `
    <div class="intelligence-hero">
      <div>
        <span class="pill">${escapeHtml(intel.priority_wave || "Хвиля")}</span>
        <h3>${escapeHtml(intel.executive_summary || "Бриф готовий")}</h3>
        <p>${escapeHtml(profile)} · ${escapeHtml(refreshed)}${intel.reusedFromAccount ? " · перевикористано з акаунта" : ""}</p>
      </div>
      <div class="intelligence-score-grid">${scoreCards}</div>
    </div>
    ${warnings ? `<div class="warning-row">${warnings}</div>` : ""}
    <div class="intelligence-grid">
      <section class="intel-card span-wide">
        <div class="intel-card-heading"><strong>Що формує бал</strong><span>Зважено за доказами, під конкретний продукт</span></div>
        <div class="intel-input-list">${scoringInputs || `<div class="empty-state">Вхідних даних для скорингу немає</div>`}</div>
      </section>
      <section class="intel-card">
        <div class="intel-card-heading"><strong>Наступні кроки</strong><span>Тільки дії продавця</span></div>
        <div class="intel-list">${nextSteps || `<div class="empty-state">Наступних кроків немає</div>`}</div>
      </section>
      <section class="intel-card">
        <div class="intel-card-heading"><strong>Прогалини в дослідженні</strong><span>Закрий їх, перш ніж писати впевнено</span></div>
        <div class="intel-list">${gaps || `<div class="empty-state">Відкритих прогалин немає</div>`}</div>
      </section>
      <section class="intel-card span-wide">
        <div class="intel-card-heading"><strong>Чернетки повідомлень</strong><span>Перед відправкою мусить перечитати людина</span></div>
        <div class="message-list">${messages || `<div class="empty-state">Чернеток немає</div>`}</div>
      </section>
      <section class="intel-card">
        <div class="intel-card-heading"><strong>Шлях до рішення</strong><span>До кого йти далі</span></div>
        <div class="intel-list">${contacts || `<div class="empty-state">Рекомендованих контактів немає</div>`}</div>
      </section>
      <section class="intel-card">
        <div class="intel-card-heading"><strong>Заперечення</strong><span>Ймовірні блокери</span></div>
        <div class="intel-list">${objections || `<div class="empty-state">Заперечень не зібрано</div>`}</div>
      </section>
    </div>
  `;
}

function prospectingStrategyRows(prospect) {
  if (!prospect) return `<div class="empty-state">Відкрий ліда і запусти дослідження, щоб зібрати стратегію по акаунту.</div>`;
  const strategy = prospect.leadIntelligence?.prospecting_strategy;
  if (!strategy) return `<div class="intelligence-empty"><i data-lucide="route"></i><div><strong>Стратегії по акаунту ще немає</strong><span>Запусти дослідження, щоб зібрати бриф A-M, маршрути до стейкхолдерів, повідомлення й план розмови.</span></div><button class="primary-button" type="button" data-intel-analyze="fresh"><i data-lucide="sparkles"></i><span>Проаналізувати</span></button></div>`;

  const decision = strategy.decision_summary || {};
  const assessment = strategy.executive_assessment || {};
  const gate = strategy.internal_readiness_gate || {};
  const channelStrategy = strategy.channel_strategy || {};
  const decisionRows = [
    ["Основний", decision.primary_contact],
    ["Запасний шлях", decision.secondary_contact],
    ["Гачок для розмови", decision.best_conversation_hook || decision.best_title],
    ["Кандидат на пілот", decision.best_pilot_candidate || decision.best_title],
    ["Найкраще питання", decision.best_question]
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "Потрібне дослідження")}</strong></div>`).join("");
  const gateChecks = (gate.checks || []).map((item) => `<div><span>${escapeHtml(item.check)}</span><strong>${escapeHtml(titleCase(item.status || "перевірити"))}</strong></div>`).join("");
  const gateActions = gate.policy_sensitive || gate.regulated_category ? `<div class="strategy-gate-actions"><button type="button" data-policy-decision="approved_conditions"><i data-lucide="shield-check"></i><span>Затвердити умови</span></button><button class="danger-button" type="button" data-policy-decision="parked"><i data-lucide="pause-circle"></i><span>Відкласти акаунт</span></button></div>` : "";
  const knownFacts = (assessment.known_facts || []).map((item) => `<article class="strategy-row"><div><span class="claim-label fact">Відомий факт</span><strong>${escapeHtml(item.statement)}</strong>${strategyEvidence(prospect, item.source_ids)}</div></article>`).join("");
  const signals = (strategy.recent_signals || []).map((item) => `<article class="strategy-row"><div><span class="claim-label ${item.claim_type === "known_fact" ? "fact" : "hypothesis"}">${escapeHtml(titleCase(item.claim_type || "гіпотеза"))}</span><strong>${escapeHtml(item.signal)}</strong><p>${escapeHtml(item.commercial_meaning || "")}</p>${strategyEvidence(prospect, item.source_ids)}</div><small>${escapeHtml(item.date_window || "Дата невідома")} · ${Number(item.confidence || 0)}%</small></article>`).join("");
  const titles = (strategy.title_analysis || []).map((item) => `<article class="strategy-title-row"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml([item.os, item.geo, item.monetization].filter(Boolean).join(" · "))}</span></div><dl><div><dt>Мета</dt><dd>${escapeHtml(item.likely_objective || "Невідомо")}</dd></div><div><dt>KPI</dt><dd>${escapeHtml(item.likely_kpi || "Невідомо")}</dd></div><div><dt>Ризик</dt><dd>${escapeHtml(item.main_risk || "Невідомо")}</dd></div><div><dt>Питання</dt><dd>${escapeHtml(item.discovery_question || "")}</dd></div></dl>${strategyEvidence(prospect, item.source_ids)}</article>`).join("");
  const hypotheses = (strategy.growth_hypotheses || []).map((item, index) => `<article class="strategy-hypothesis"><header><span>Гіпотеза ${index + 1}</span><b>${Number(item.confidence || 0)}%</b></header><strong>${escapeHtml(item.hypothesis)}</strong><p><b>Докази:</b> ${escapeHtml(item.evidence || "Ще не підтверджено")}</p><p><b>Чому це важливо:</b> ${escapeHtml(item.why_it_matters || "")}</p><p><b>Питання:</b> ${escapeHtml(item.validation_question || "")}</p><p><b>Кут AdAction:</b> ${escapeHtml(item.adaction_angle || "")}</p>${strategyEvidence(prospect, item.source_ids)}</article>`).join("");
  const stakeholders = (strategy.stakeholder_map || []).map((item, index) => `<article class="strategy-stakeholder"><header><span>${index + 1}</span><div><strong>${escapeHtml(item.full_name || item.target_role || "Стейкхолдера не визначено")}</strong><small>${escapeHtml([item.role, titleCase(item.deal_role || "")].filter(Boolean).join(" · "))}</small></div></header><dl><div><dt>Навіщо</dt><dd>${escapeHtml(item.learn || item.why_contact || "")}</dd></div><div><dt>Особистий гачок</dt><dd>${escapeHtml(item.personal_hook || "Потрібне дослідження")}</dd></div><div><dt>Бізнес-гачок</dt><dd>${escapeHtml(item.business_hook || "")}</dd></div><div><dt>CTA</dt><dd>${escapeHtml(item.cta || "")}</dd></div><div><dt>Поки не пітчити</dt><dd>${escapeHtml(item.do_not_pitch_yet || "")}</dd></div></dl>${strategyEvidence(prospect, item.source_ids)}</article>`).join("");
  const firstTouch = strategy.recommended_first_touch || {};
  const messages = [firstTouch.linkedin ? ["LinkedIn", firstTouch.linkedin] : null, firstTouch.email ? ["Email", firstTouch.email] : null].filter(Boolean).map(([label, item]) => {
    const copyButton = gate.outreach_allowed
      ? `<button data-copy-text="${escapeAttr([item.subject, item.body].filter(Boolean).join("\n\n"))}" data-copy-channel="${label.toLowerCase()}" data-copy-label="Стратегія · ${label}" title="Копіювати" aria-label="Копіювати"><i data-lucide="copy"></i></button>`
      : `<button type="button" disabled aria-disabled="true" title="Спочатку закрий гейт готовності, потім копіюй"><i data-lucide="lock-keyhole"></i></button>`;
    return `<article class="strategy-message ${gate.outreach_allowed ? "" : "blocked"}"><header><span class="pill">${label}</span><strong>${escapeHtml(item.subject || item.angle || "Перший дотик")}</strong>${copyButton}</header><pre>${escapeHtml(item.body || "")}</pre>${(item.evidence || []).map((entry) => `<div class="message-evidence"><span class="claim-label ${entry.claim_type === "hypothesis" ? "hypothesis" : "fact"}">${escapeHtml(titleCase(entry.claim_type || "контекст"))}</span><p>${escapeHtml(entry.line)}</p>${strategyEvidence(prospect, entry.source_ids)}</div>`).join("") || strategyEvidence(prospect, item.source_ids)}</article>`;
  }).join("");
  const conversation = (strategy.conversation_tree || []).map((item) => `<article class="strategy-branch"><strong>Якщо: ${escapeHtml(item.if_they_say)}</strong><p>${escapeHtml(item.respond_with)}</p><span>Наступне питання: ${escapeHtml(item.next_question)}</span></article>`).join("");
  const transition = strategy.adaction_transition || {};
  const cta = strategy.consultation_cta || {};
  const sequence = (strategy.multi_thread_sequence || []).map((item) => `<article class="strategy-sequence-row"><b>${escapeHtml(item.day || "Далі")}</b><div><strong>${escapeHtml(item.full_name || item.target_role || "Наступний стейкхолдер")}</strong><span>${escapeHtml(item.purpose || "")}</span><small>${escapeHtml([item.channel, item.thesis].filter(Boolean).join(" · "))}</small></div></article>`).join("");
  const risks = (strategy.risks || []).map((item) => `<article class="strategy-row"><div><strong>${escapeHtml(item.risk)}</strong><p>${escapeHtml(item.why_it_matters || "")}</p><span>${escapeHtml(item.handling || "")}</span>${strategyEvidence(prospect, item.source_ids)}</div></article>`).join("");
  const scores = Object.entries(strategy.account_scores || {}).map(([key, item]) => `<article class="strategy-score"><div><span>${escapeHtml(titleCase(key))}</span><strong>${Number(item.score || 0)}/10</strong></div><p>${escapeHtml(item.rationale || "")}</p></article>`).join("");

  return `<div class="strategy-decision-grid">${decisionRows}</div>
    <article class="strategy-gate ${gate.outreach_allowed ? "approved" : "blocked"}"><header><div><span>Внутрішній гейт готовності</span><strong>${escapeHtml(titleCase(gate.status || "стандартна перевірка"))}</strong></div><b>${gate.outreach_allowed ? "Аутріч дозволено" : "Аутріч на паузі"}</b></header><p>${escapeHtml(gate.reason || "")}</p><div class="strategy-gate-checks">${gateChecks}</div>${strategyEvidence(prospect, gate.source_ids)}${gateActions}</article>
    <details class="strategy-section" open><summary><span>A</span><strong>Управлінська оцінка акаунта</strong></summary><div class="strategy-section-body"><h3>${escapeHtml(assessment.summary || "Оцінка ще не готова")}</h3><p>${escapeHtml(assessment.why_now || "")}</p>${knownFacts || `<div class="empty-state">Жодного факту про акаунт із підтвердженим джерелом.</div>`}<article class="strategy-channel"><span>Стратегія каналів</span><strong>${escapeHtml(channelStrategy.primary_route || "Обери після перегляду контактів")}</strong><p>${escapeHtml(channelStrategy.reason || "")}</p><small>${escapeHtml(channelStrategy.stop_rule || "")}</small></article></div></details>
    <details class="strategy-section"><summary><span>B</span><strong>Сигнали за останні 30-90 днів</strong></summary><div class="strategy-section-body strategy-list">${signals || `<div class="empty-state">Жодного датованого сигналу не підтверджено.</div>`}</div></details>
    <details class="strategy-section"><summary><span>C</span><strong>Аналіз застосунків і назв</strong></summary><div class="strategy-section-body strategy-list">${titles || `<div class="empty-state">Жодної назви не підтверджено.</div>`}</div></details>
    <details class="strategy-section"><summary><span>D</span><strong>Гіпотези росту</strong></summary><div class="strategy-section-body strategy-hypothesis-grid">${hypotheses || `<div class="empty-state">Гіпотез не підготовлено.</div>`}</div></details>
    <details class="strategy-section"><summary><span>E-F</span><strong>Стейкхолдери й кути під конкретну людину</strong></summary><div class="strategy-section-body strategy-stakeholder-grid">${stakeholders || `<div class="empty-state">Іменованих стейкхолдерів не знайдено.</div>`}</div></details>
    <details class="strategy-section"><summary><span>G</span><strong>Рекомендований перший дотик</strong></summary><div class="strategy-section-body strategy-message-grid">${messages}</div></details>
    <details class="strategy-section"><summary><span>H</span><strong>Дерево подальшої розмови</strong></summary><div class="strategy-section-body strategy-branch-grid">${conversation}</div></details>
    <details class="strategy-section"><summary><span>I-J</span><strong>Перехід до AdAction і CTA на консультацію</strong></summary><div class="strategy-section-body strategy-transition-grid"><article><span>Коли переходити</span><p>${escapeHtml(transition.when_to_use || "")}</p><strong>${escapeHtml(transition.language || "")}</strong><small>${escapeHtml(transition.commercial_framework || "")}</small>${strategyEvidence(prospect, transition.source_ids)}</article><article><span>${escapeHtml(cta.positioning || "Консультація")}</span><strong>${escapeHtml(cta.ask || "")}</strong><p>${escapeHtml(cta.agenda || "")}</p></article></div></details>
    <details class="strategy-section"><summary><span>K</span><strong>Послідовність у кількох тредах</strong></summary><div class="strategy-section-body strategy-list">${sequence}</div></details>
    <details class="strategy-section"><summary><span>L</span><strong>Ризики й заперечення</strong></summary><div class="strategy-section-body strategy-list">${risks}</div></details>
    <details class="strategy-section"><summary><span>M</span><strong>Загальний бал акаунта</strong></summary><div class="strategy-section-body strategy-score-grid">${scores}</div></details>`;
}

function strategyEvidence(prospect, sourceIds = []) {
  const ids = new Set(sourceIds || []);
  const sources = [...(prospect?.leadIntelligence?.sources || []), ...(prospect?.appPortfolio?.evidence || [])]
    .filter((source) => ids.has(source.source_id));
  return sources.length ? evidenceLinks(sources, true) : `<span class="evidence-missing">Гіпотеза або докази ще не зібрані</span>`;
}

function bestContactConfidence(prospect) {
  if (!isNamedPersonLead(prospect)) return 0;
  const candidates = prospect?.contactDiscovery?.candidates || [];
  return candidates.length ? Math.max(...candidates.map((candidate) => Number(candidate.confidence) || 0)) : 0;
}

function isNamedPersonLead(prospect = {}) {
  const name = String(prospect?.name || "").trim();
  const company = String(prospect?.company || "").trim();
  const linkedin = String(prospect?.linkedin || "");
  if (!name || (company && name.toLowerCase() === company.toLowerCase())) return false;
  if (/linkedin\.com\/company\//i.test(linkedin)) return false;
  return /linkedin\.com\/in\//i.test(linkedin) || name.split(/\s+/).filter(Boolean).length >= 2;
}

function preferredChannel(prospect) {
  const candidates = prospect?.contactDiscovery?.candidates || [];
  if (prospect?.linkedin || candidates.some((candidate) => candidate.type === "linkedin")) return "linkedin";
  if (approvedChannel(prospect || {}, "email")) return "email";
  if (approvedChannel(prospect || {}, "phone")) return "phone";
  return "linkedin";
}

function updateQuickCopies(prospect) {
  const messages = prospect?.outreach?.messages || [];
  const variations = prospect?.outreach?.linkedinVariations || [];
  setCopyText("copyLinkedinQuick", messages.find((message) => /linkedin_invite/i.test(message.channel))?.body || variations[0]?.body || messages.find((message) => /linkedin/i.test(message.channel))?.body || "", "linkedin", "Швидка копія LinkedIn");
  setCopyText("copyEmailQuick", approvedChannel(prospect || {}, "email") ? messages.find((message) => /email/i.test(message.channel))?.body || "" : "", "email", "Швидка копія email");
  setCopyText("copySmsQuick", approvedChannel(prospect || {}, "sms") ? messages.find((message) => /^sms$/i.test(message.channel))?.body || "" : "", "sms", "Швидка копія SMS");
  setCopyText("copyWhatsappQuick", approvedChannel(prospect || {}, "whatsapp") ? messages.find((message) => /whatsapp/i.test(message.channel))?.body || "" : "", "whatsapp", "Швидка копія WhatsApp");
  setCopyText("copyTelegramQuick", approvedChannel(prospect || {}, "telegram") ? messages.find((message) => /telegram/i.test(message.channel))?.body || "" : "", "telegram", "Швидка копія Telegram");
}

function analyticsRows(prospect) {
  const analysis = prospect.analysis || { reachProbability: 0, closeProbability: 0, reasoning: [] };
  return `
    <article class="analysis-card">
      <div>
        <span>Досяжність</span>
        <strong>${analysis.reachProbability}%</strong>
        <div class="meter compact"><span style="width:${analysis.reachProbability}%"></span></div>
      </div>
      <div>
        <span>Шанс закрити</span>
        <strong>${analysis.closeProbability}%</strong>
        <div class="meter compact accent"><span style="width:${analysis.closeProbability}%"></span></div>
      </div>
      <div class="analysis-reason">
        <span>Наступний хід за AI</span>
        <strong>${escapeHtml(analysis.recommendedAction || "Підготувати аутріч")}</strong>
        <small>${(analysis.reasoning || []).map(escapeHtml).join(" ")}</small>
      </div>
    </article>
  `;
}

function profileFieldRows(prospect) {
  const publicNote = publicLeadNote(prospect.notes);
  const rows = [
    ["Посада", prospect.title],
    ["Компанія", prospect.company],
    ["Локація", prospect.location],
    ["Сайт", prospect.website],
    ["LinkedIn", prospect.linkedin],
    ["Email", prospect.email],
    ["Телефон", prospect.phone],
    ["Нотатки", publicNote]
  ].filter(([, value]) => value);
  return rows
    .map(
      ([label, value]) => `
        <dt>${escapeHtml(label)}</dt>
        <dd>${linkIfUrl(value)}</dd>
      `
    )
    .join("");
}

function contactRows(prospect) {
  const discovery = prospect.contactDiscovery;
  if (!discovery?.candidates?.length) {
    return `<div class="empty-state">Пошук контактів ще не запускався</div>`;
  }

  const candidates = discovery.candidates
    .map(
      (candidate) => {
        const approvalRequired = contactApprovalRequired(candidate.type);
        const approved = candidate.approvalStatus === "approved";
        const rejected = candidate.approvalStatus === "rejected";
        const canApprove = candidate.approvalStatus === "pending";
        return `
        <article class="contact-card">
          <div>
            <span class="contact-type">${escapeHtml(candidate.type)}</span>
            <strong>${linkIfUrl(candidate.value)}</strong>
            <small>${escapeHtml(candidate.source)} · ${escapeHtml(candidate.status)}</small>
            ${approvalRequired ? `<span class="approval-state ${escapeAttr(candidate.approvalStatus || "verification_required")}">${escapeHtml(approved ? "Схвалено для аутрічу" : rejected ? "Відхилено" : canApprove ? "Потрібне схвалення продавця" : "Потрібна перевірка")}</span>` : ""}
            ${candidate.evidence?.length ? `<div class="evidence-row">${candidate.evidence.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
          </div>
          <div class="confidence">
            <span>${candidate.confidence}%</span>
            ${approvalRequired && !approved ? `<div class="approval-actions">${canApprove ? `<button type="button" data-contact-decision="approved" data-contact-type="${escapeAttr(candidate.type)}" data-contact-value="${escapeAttr(candidate.value)}"><i data-lucide="check"></i><span>Схвалити</span></button>` : ""}<button class="icon-button danger-button" type="button" data-contact-decision="rejected" data-contact-type="${escapeAttr(candidate.type)}" data-contact-value="${escapeAttr(candidate.value)}" title="Відхилити"><i data-lucide="x"></i></button></div>` : ""}
            <button data-copy-text="${approved || !approvalRequired ? escapeAttr(candidate.value) : ""}" data-copy-channel="${escapeAttr(candidate.type || "contact")}" data-copy-label="Контактні дані" title="${approved || !approvalRequired ? "Копіювати" : "Спочатку схвали"}" aria-label="Копіювати" ${approved || !approvalRequired ? "" : "disabled"}><i data-lucide="copy"></i></button>
          </div>
        </article>
      `;
      }
    )
    .join("");

  const warnings = discovery.warnings
    .map((warning) => `<span class="warning-chip">${escapeHtml(warning)}</span>`)
    .join("");
  return `${candidates}<div class="warning-row">${warnings}</div>`;
}

function contactApprovalRequired(type = "") {
  return ["email", "phone", "sms", "whatsapp", "whatsapp_link", "telegram", "telegram_link"].includes(String(type).toLowerCase());
}

function approvedChannel(prospect, channel) {
  if (/linkedin/.test(channel)) return true;
  const normalized = channel === "sms" || channel === "call" ? "phone" : channel;
  return (prospect.contactDiscovery?.candidates || []).some((candidate) =>
    (candidate.type === normalized || candidate.type === `${normalized}_link` || candidate.type === `${normalized}_presence`)
      && candidate.approvalStatus === "approved"
      && !/not_found|rejected/i.test(String(candidate.status || ""))
  );
}

function outreachRows(prospect) {
  const outreach = prospect.outreach;
  if (!outreach) {
    return `<div class="empty-state">Підготуй аутріч, щоб з'явилися повідомлення й дії</div>`;
  }

  const messageCard = (message) => {
    const channel = String(message.channel || "").toLowerCase();
    const basis = (message.personalization_basis || message.basis || []).slice(0, 4).join(" · ");
    const canUse = approvedChannel(prospect, channel);
    // Пошта копіюється разом із темою — окремо скопійований лист без теми
    // доводиться доскладати руками саме тоді, коли поспішаєш.
    const copyText = channel === "email" && message.subject
      ? `Тема: ${message.subject}\n\n${message.body || ""}`
      : message.body || "";
    return `
      <article class="message-card">
        <div class="message-heading">
          <span class="pill">${escapeHtml(channelLabels[channel] || message.channel || "канал")}</span>
          ${message.subject ? `<strong>${escapeHtml(message.subject)}</strong>` : ""}
          <button data-copy-text="${canUse ? escapeAttr(copyText) : ""}" data-copy-channel="${escapeAttr(channel || "draft")}" data-copy-label="${escapeAttr(channelLabels[channel] || "Повідомлення")}" title="${canUse ? "Копіювати" : "Спочатку схвали контакт у розділі «Контакти»"}" aria-label="Копіювати" ${canUse ? "" : "disabled"}><i data-lucide="${canUse ? "copy" : "lock-keyhole"}"></i></button>
        </div>
        <pre>${escapeHtml(message.body || "")}</pre>
        <small class="message-basis">${escapeHtml(wordCountLabel(message.body))}${canUse ? "" : " · канал заблоковано, поки контакт не схвалено"}${basis ? ` · ${escapeHtml(basis)}` : ""}</small>
        ${evidenceLinks(message.evidence || [])}
      </article>
    `;
  };

  // Три канали, якими справді пишуть із цієї Панелі, — нагорі. Решта нікуди не
  // зникає, але й не відсуває їх униз екрана.
  const byChannel = (outreach.messages || []).filter(isSendableMessage);
  const primary = PRIMARY_MESSAGE_CHANNELS
    .map((channel) => byChannel.find((message) => String(message.channel || "").toLowerCase() === channel))
    .filter(Boolean);
  const secondary = byChannel.filter((message) => !PRIMARY_MESSAGE_CHANNELS.includes(String(message.channel || "").toLowerCase()));
  const messages = primary.map(messageCard).join("");
  const otherMessages = secondary.length
    ? `<details class="optional-fields"><summary>Інші канали (${secondary.length})</summary><div class="message-list">${secondary.map(messageCard).join("")}</div></details>`
    : "";

  const variations = (outreach.linkedinVariations || [])
    .map(
      (variation) => `
        <article class="message-card linkedin-variation">
          <div class="message-heading">
            <span class="pill">${escapeHtml(variation.label)}</span>
            <strong>Варіант для LinkedIn</strong>
            <button data-copy-text="${escapeAttr(variation.body)}" data-copy-channel="linkedin" data-copy-label="Варіант для LinkedIn" title="Копіювати" aria-label="Копіювати"><i data-lucide="copy"></i></button>
          </div>
          <pre>${escapeHtml(variation.body)}</pre>
        </article>
      `
    )
    .join("");
  const angles = (outreach.messageAngles || []).map((angle, index) => `
    <article class="message-angle-card ${index === 0 ? "recommended" : ""}">
      <div class="message-angle-heading"><div><span class="pill">${index === 0 ? "Рекомендовано" : escapeHtml(angle.label)}</span><strong>${escapeHtml(angle.label)}</strong></div><span class="angle-score">${Number(angle.score || 0)}/100</span></div>
      <p>${escapeHtml(angle.strategy || "")}</p>
      <pre>${escapeHtml(angle.body || "")}</pre>
      <div class="angle-footer"><span>${escapeHtml(angle.scoreReason || "")}</span><button data-copy-text="${escapeAttr(angle.body || "")}" data-copy-channel="linkedin" data-copy-label="${escapeAttr(angle.label || "Кут повідомлення")}"><i data-lucide="copy"></i><span>Копіювати</span></button></div>
      ${evidenceLinks(angle.evidence || [])}
    </article>
  `).join("");

  const actions = (outreach.actions || [])
    .map(
      (action) => `
        <button class="action-row" data-interaction-type="${escapeAttr(action.type)}">
          <i data-lucide="circle-dot"></i>
          <span>${escapeHtml(action.label)}</span>
          <strong>${escapeHtml(action.due)}</strong>
        </button>
      `
    )
    .join("");
  const warmupActions = (outreach.warmupActions || [])
    .map(
      (action) => `
        <article class="warmup-row">
          <i data-lucide="${warmupIcon(action.channel)}"></i>
          <div>
            <strong>${escapeHtml(action.label)}</strong>
            <span>${escapeHtml(action.channel)} · ${escapeHtml(action.due)} · ${escapeHtml(action.priority)}</span>
          </div>
        </article>
      `
    )
    .join("");
  const fallbackWarning = outreach.fallbackReason
    ? `<div class="outreach-warning"><i data-lucide="triangle-alert"></i><span>Спрацював фолбек живого AI. ${escapeHtml(outreach.fallbackReason)}</span></div>`
    : "";
  const qualityWarnings = (outreach.qualityWarnings || [])
    .map((warning) => `<span>${escapeHtml(warning)}</span>`)
    .join("");
  const qualityWarningBlock = qualityWarnings
    ? `<div class="outreach-warning"><i data-lucide="shield-alert"></i><div>${qualityWarnings}</div></div>`
    : "";

  // Затримка по відповідності більше не означає «текстів немає»: тексти є, але
  // вони ставлять питання замість пропозиції — і на екрані має бути видно, чому.
  const holdBlock = outreach.fitHold
    ? `<div class="outreach-warning"><i data-lucide="shield-alert"></i><div>
        <span>Відповідність продукту не підтверджена, тому це перший дотик із питанням, а не пропозиція. ${escapeHtml(outreach.fitHold.reason || "")}</span>
        ${(outreach.fitHold.unverified || []).map((item) => `<span>Не підтверджено: ${escapeHtml(item)}</span>`).join("")}
      </div></div>`
    : "";
  const complianceBlock = (outreach.complianceChecks || []).length
    ? `<details class="optional-fields"><summary>Перевір перед відправкою (${outreach.complianceChecks.length})</summary><ul class="compliance-list">${outreach.complianceChecks.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : item.label || item.check || JSON.stringify(item))}</li>`).join("")}</ul></details>`
    : "";

  return `
    <div class="qualification-strip">
      <div><span>Продукт</span><strong>${escapeHtml(outreach.productName || state.selectedProduct?.name || "")}</strong></div>
      <div><span>Мова</span><strong>${escapeHtml(languageLabels[outreach.language] || "не задано")}</strong></div>
      <div><span>Підхід</span><strong>${escapeHtml(outreach.usedApproach || "без підходу")}</strong></div>
      <div><span>Канал</span><strong>${escapeHtml(outreach.recommendedChannel)}</strong></div>
    </div>
    ${holdBlock}
    ${fallbackWarning}
    ${qualityWarningBlock}
    <div class="message-list">${messages || `<div class="empty-state">${escapeHtml(noMessagesReason(outreach))}</div>`}</div>
    ${otherMessages}
    ${complianceBlock}
    ${variations ? `<details class="optional-fields"><summary>Варіанти для LinkedIn</summary><div class="message-list">${variations}</div></details>` : ""}
    ${angles ? `<details class="optional-fields"><summary>Інші кути заходу</summary><div class="message-angle-grid">${angles}</div></details>` : ""}
    ${warmupActions ? `<div class="warmup-list">${warmupActions}</div>` : ""}
    <div class="action-list">${actions}</div>
  `;
}

/**
 * Вибір, з якого виростають тексти: підхід і мова.
 *
 * Обидва селекти показують те, чим писали минулого разу, а не свої
 * замовчування — інакше кожне відкриття ліда пропонує переписати його наново
 * чужими налаштуваннями.
 */
function renderMessageControls(prospect) {
  const approachSelect = document.getElementById("messageApproachSelect");
  const languageSelect = document.getElementById("messageLanguageSelect");
  const writeButton = document.getElementById("writeMessagesBtn");
  // Один вираз на обидві причини: кнопка мертва і без ліда, і поки щось іде.
  // Рендер черги викликається і з місць, які не чіпають renderBusyState, тож
  // інакше кнопка під час збагачення виглядала б активною і ковтала кліки.
  if (writeButton) writeButton.disabled = !prospect || Boolean(busyAction);

  // Перемальовування не повинно скасовувати вибір. Копіювання чи схвалення
  // контакту перерендерює цю область — і мова, виставлена секунду тому, зникала
  // б рівно перед тим, як її збираються застосувати.
  const sameLead = messageControlsLeadId === (prospect?.id || "");
  messageControlsLeadId = prospect?.id || "";

  if (approachSelect) {
    const approaches = prospect?.clientProfile?.approaches || [];
    const used = approaches.findIndex((approach) => approach.angle === prospect?.outreach?.usedApproach);
    const keep = sameLead ? approachSelect.value : "";
    approachSelect.innerHTML = approaches.length
      ? approaches.map((approach, index) => `<option value="${index}">${escapeHtml(approach.angle || `Підхід ${index + 1}`)}</option>`).join("")
      : `<option value="">Спершу збагати ліда</option>`;
    const wanted = keep !== "" && Number(keep) < approaches.length ? keep : String(Math.max(used, 0));
    if (approaches.length) approachSelect.value = wanted;
    approachSelect.disabled = !approaches.length;
  }

  if (languageSelect) {
    const keep = sameLead ? languageSelect.value : "";
    languageSelect.value = keep || prospect?.outreach?.language || prospect?.clientProfile?.openerLanguage || "uk";
  }
}

// Канали, заради яких на цю вкладку заходять. Порядок — порядок на екрані.
const PRIMARY_MESSAGE_CHANNELS = ["linkedin_invite", "linkedin_follow_up", "email", "telegram"];

const channelLabels = {
  linkedin_invite: "LinkedIn · запрошення",
  linkedin_follow_up: "LinkedIn · перше повідомлення",
  email: "Пошта",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  sms: "SMS",
  call: "Перша фраза для дзвінка"
};

const languageLabels = { uk: "Українською", en: "English", ru: "Русский" };

/** Чому в списку порожньо — різні причини, і продавцю важлива саме його. */
function noMessagesReason(outreach = {}) {
  if (outreach.fitHold?.writing === false) {
    return `${outreach.fitHold.reason || "По цьому акаунту вже ухвалено рішення."} Щоб тексти готувалися, зніми рішення в розділі «Стратегія».`;
  }
  if (outreach.modelUsed === "product-fit-guard") {
    return "Тексти під затримкою пише модель, а вона зараз недоступна. Підключи OpenRouter у Налаштуваннях — або підтверди відповідність продукту, і тексти напишуться звичайним шляхом.";
  }
  if (outreach.provider === "fallback") {
    return `Модель не відповіла (${outreach.fallbackReason || "причина невідома"}). Спробуй «Переписати тексти».`;
  }
  return "Жодного тексту не повернулося. Спробуй «Переписати тексти».";
}

/**
 * Повідомлення, яке справді є повідомленням.
 *
 * Під затримкою шаблонні білдери кладуть у канал вказівку продавцю («Do not
 * contact … yet»), а не чернетку. Сервер позначає такі рядки прапорцем `hold`:
 * упізнавати їх за англійським формулюванням тут означало б пропустити кожен
 * канал, сформульований інакше, і викинути справжній текст, що почався
 * схожими словами.
 */
function isSendableMessage(message = {}) {
  if (message.hold) return false;
  return String(message.body || "").trim().length > 8;
}

function warmupIcon(channel) {
  if (channel === "facebook") return "badge-check";
  if (channel === "phone") return "phone";
  if (channel === "email") return "mail";
  if (channel === "whatsapp") return "message-circle";
  if (channel === "telegram") return "send";
  if (channel === "sms") return "message-square-text";
  return "mouse-pointer-click";
}


function knowledgeIcon(type) {
  const icons = {
    link: "link",
    lesson: "book-open-check",
    product_context_update: "file-pen-line",
    platform_note: "panel-top",
    screenshot: "image",
    faq: "circle-help",
    case_study: "badge-check",
    objection: "shield-question",
    competitor: "swords"
  };
  return icons[type] || "file-text";
}

function interactionRows(prospect) {
  const interactions = prospect.interactions || [];
  if (!interactions.length) {
    return `<div class="empty-state">Взаємодій не зафіксовано</div>`;
  }

  return interactions
    .map(
      (interaction) => {
        const crmSync = interaction.crmSync?.status ? ` · CRM ${interaction.crmSync.status.replace(/_/g, " ")}` : "";
        return `
        <article class="timeline-item">
          <div class="timeline-dot"></div>
          <div>
            <strong>${titleCase(interaction.type)}</strong>
            <span>${escapeHtml(interaction.channel)} · ${escapeHtml(interaction.outcome)} · ${relativeTime(interaction.at)}${escapeHtml(crmSync)}</span>
            <small>${escapeHtml(interaction.note || "")}</small>
          </div>
        </article>
      `;
      }
    )
    .join("");
}

function callAnalysisRows(prospect) {
  const analysis = prospect.callAnalysis;
  if (!analysis) {
    return `<div class="empty-state">Встав транскрипт дзвінка — отримаєш розбір, шаблони наступних кроків і фолоу-ап</div>`;
  }

  const tips = (analysis.improvementTips || []).map((tip) => `<li>${escapeHtml(tip)}</li>`).join("");
  const templates = (analysis.nextStepTemplates || [])
    .map(
      (template) => `
        <article class="message-card">
          <div class="message-heading">
            <span class="pill">${escapeHtml(template.channel)}</span>
            <strong>${escapeHtml(template.label)}</strong>
            <button data-copy-text="${escapeAttr(template.body)}" data-copy-channel="${escapeAttr(template.channel || "follow_up")}" data-copy-label="${escapeAttr(template.label || "Шаблон фолоу-апу")}" title="Копіювати" aria-label="Копіювати"><i data-lucide="copy"></i></button>
          </div>
          <pre>${escapeHtml(template.body)}</pre>
        </article>
      `
    )
    .join("");

  return `
    <div class="call-score-row">
      <div><span>Якість дзвінка</span><strong>${analysis.qualityScore}%</strong></div>
      <div><span>Настрій</span><strong>${escapeHtml(analysis.sentiment)}</strong></div>
      <div><span>Продукт</span><strong>${escapeHtml(analysis.productName)}</strong></div>
    </div>
    <p class="call-summary">${escapeHtml(analysis.summary)}</p>
    <ul class="tip-list">${tips}</ul>
    <div class="message-list">${templates}</div>
  `;
}

function taskNotificationRows(prospect) {
  const tasks = (state.followUpTasks || []).filter((task) => task.prospectId === prospect?.id);
  if (!tasks.length) {
    return `<div class="empty-state">Домовленого фолоу-апу поки не видно</div>`;
  }

  return tasks
    .map(
      (task) => `
        <article class="task-alert ${task.status === "done" ? "done" : ""}">
          <i data-lucide="bell-ring"></i>
          <div>
            <strong>${escapeHtml(task.label)}</strong>
            <span>${new Date(task.due).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${escapeHtml(task.status)}</span>
          </div>
          ${task.status === "done" ? "" : `<button type="button" data-task-complete-id="${escapeAttr(task.id)}"><i data-lucide="check"></i><span>Готово</span></button>`}
        </article>
      `
    )
    .join("");
}

function capabilities(model) {
  return [
    model.structuredOutput ? "JSON" : "",
    model.toolCalling ? "Інструменти" : "",
    model.streaming ? "Стрім" : "",
    model.promptCaching ? "Кеш" : "",
    model.zeroRetention ? "ZDR" : model.noTraining ? "Без навчання" : ""
  ].filter(Boolean);
}

function comparisonCopy(index) {
  return [
    "Стислий дешевий варіант із передбачуваною структурою для рутинного аутрічу.",
    "Збалансована чернетка: більше персоналізації, обережніші твердження.",
    "Стратегічніша подача для складних акаунтів і керівної аудиторії."
  ][index % 3];
}

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

function setCopyText(id, value, channel = "", label = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.dataset.copyText = value || "";
  if (channel) element.dataset.copyChannel = channel;
  if (label) element.dataset.copyLabel = label;
  element.disabled = !value;
}

function renderBusyState() {
  const anyBusy = Boolean(busyAction);
  setBusyButton("quickPrepareBtn", "research", "Виконується...");
  setBusyButton("runResearchTopBtn", "research", "Виконується...");
  setBusyButton("enrichLeadBtn", "research", "Збагачуємо...");
  setBusyButton("writeMessagesBtn", "messages", "Пишемо...");
  setBusyButton("refreshCompanyBtn", "research", "Шукаємо...");
  setBusyButton("prepareOutreachBtn", "research", "Виконується...");
  setBusyButton("analyzeIntelligenceBtn", "intelligence", "Аналізуємо...");
  setBusyButton("refreshIntelligenceBtn", "intelligence", "Оновлюємо...");
  setBusyButton("analyzeIntelligenceQuick", "intelligence", "Аналізуємо...");
  setBusyButton("enrichProspectBtn", "enrich", "Оновлюємо...");
  setBusyButton("removeLeadQuick", "remove", "Видаляємо...");
  setBusyButton("addLinkedinTargetBtn", "linkedin-import", "Додаємо...");
  setBusyButton("crmImportBtn", "crm-import", "Тягнемо...");
  setBusyButton("productTeachBtn", "product", "Вивчаємо...");
  document.querySelectorAll("[data-interaction-type], [data-task-complete-id], [data-remove-prospect-id]").forEach((button) => {
    button.disabled = anyBusy;
  });
}

function renderResearchProgress() {
  const panel = document.getElementById("researchProgressPanel");
  if (!panel) return;
  const savedJob = activeResearchJob || (state?.researchJobs || []).find((job) =>
    job.prospectId === selectedProspectId && ["queued", "running", "failed"].includes(job.status)
  );
  if (!savedJob) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  const stages = (savedJob.stages || []).map((stage) => `
    <div class="research-stage ${escapeAttr(stage.status || "pending")}">
      <i data-lucide="${stage.status === "complete" ? "check" : stage.status === "running" ? "loader-circle" : stage.status === "failed" ? "triangle-alert" : "circle"}"></i>
      <div><strong>${escapeHtml(stage.label)}</strong><span>${escapeHtml(stage.detail || titleCase(stage.status || "очікує"))}</span></div>
    </div>
  `).join("");
  panel.innerHTML = `
    <div class="research-progress-heading">
      <div><span class="eyebrow">Фонове дослідження</span><strong>${escapeHtml(savedJob.productName || "Вибраний продукт")} · ${escapeHtml(savedJob.prospectName || "Лід")}</strong></div>
      <span class="pill">${Number(savedJob.progress || 0)}%</span>
    </div>
    <div class="meter"><span style="width:${Number(savedJob.progress || 0)}%"></span></div>
    <div class="research-stage-list">${stages}</div>
    ${savedJob.error ? `<div class="outreach-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(savedJob.error)}</span></div>` : ""}
  `;
}

function setBusyButton(id, actionName, activeText) {
  const button = document.getElementById(id);
  if (!button) return;
  if (!button.dataset.defaultHtml) button.dataset.defaultHtml = button.innerHTML;
  const active = busyAction === actionName;
  button.disabled = active || (Boolean(busyAction) && ["research", "intelligence", "enrich", "messages", "remove", "linkedin-import", "crm-import", "product"].includes(actionName));
  button.classList.toggle("is-loading", active);
  if (active) {
    const icon = actionName === "remove" ? "loader-circle" : "loader-circle";
    button.innerHTML = `<i data-lucide="${icon}"></i><span>${escapeHtml(activeText)}</span>`;
  } else {
    button.innerHTML = button.dataset.defaultHtml;
  }
}

async function runUiAction(actionName, message, work) {
  if (busyAction) return;
  busyAction = actionName;
  busyMessage = message;
  uiNotice = "";
  renderBusyState();
  refreshIcons();
  try {
    await work();
    uiNotice = {
      invite: "Готово. Що сталося із запитом, видно тут же — статус оновлюється, коли агент його надішле або перевірить.",
      messages: "Тексти переписано. Копіюй з картки каналу — копія одразу лягає в історію по ліду.",
      research: "Збагачено. Опис клієнта і підходи до розмови — у першому блоці; компанію записано в базу, вдруге її вже не шукатимемо.",
      enrich: "Контактні дані оновлено. Перевір впевненість, перш ніж брати телефон чи соцмережу в роботу.",
      "linkedin-import": "Ліда додано в чергу. Запусти Дослідження, коли будеш готовий збагатити його й підготувати аутріч.",
      "crm-import": "Лідів із CRM підтягнуто в чергу.",
      product: "Пам'ять продукту збережено. Система використає оновлений контекст для скорингу й аутрічу.",
      remove: "Ліда прибрано з черги.",
      "contact-drafts": "Чернетки готові. Перечитай їх перед відправкою — надсилає людина, не система.",
      "contact-import": "Контакт у черзі лідів. Дослідження і фолоу-апи для нього тепер доступні на вкладці «Ліди»."
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
      prospects: "Панель",
      leads: "Ліди",
      contacts: "Контакти з CRM",
      warmup: "Прогрів LinkedIn",
      ai: "AI-оператор",
      products: "Продукти і база знань",
      account: "Користувачі",
      overview: "Керування AI-оркестрацією",
      models: "Реєстр моделей",
      routing: "Маршрутизація задач",
      budgets: "Контроль бюджету",
      privacy: "Політика приватності",
      evaluation: "Оцінка моделей"
    }[viewName] || "Outbound Sales OS";
  rememberView(viewName);

  if (viewName === "overview") {
    drawTrafficChart();
  }
  // Loaded when the tab is opened rather than at boot: it talks to a different
  // database, and a workspace that never warms an account should not pay for it.
  if (viewName === "account") {
    loadProfileScreen();
  }

  if (viewName === "warmup") {
    loadWarmup();
  }

  // Файли читаються з сервера, а не з /api/state: вкладку, яку ніхто не
  // відкриває, не варто вантажити на кожен рефреш.
  if (viewName === "products") {
    void loadKnowledgeLibrary().catch(() => {});
  }

  // Те саме для контактів: CRM опитується, коли на неї дивляться.
  if (viewName === "contacts") {
    void loadContactFolders().catch(() => {});
  }

  // Панель теж читає папки CRM — але тільки список, без сторінки контактів:
  // людину з папки вона бере по одній, за позицією.
  if (viewName === "prospects") {
    void loadPanelFolders().catch(() => {});
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

function companyLinkedInPeopleUrlForProspect(prospect = {}) {
  return prospect.publicCompanyResearch?.linkedinPeopleUrl
    || linkedInCompanyPeopleUrl(prospect.companyLinkedin)
    || linkedInCompanyPeopleUrl(inferredLinkedInCompanyUrl(prospect.company));
}

function inferredLinkedInCompanyUrl(company) {
  const slug = String(company || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `https://www.linkedin.com/company/${slug}/` : "";
}

function normalizeLinkedInCompanyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    const companyIndex = parts.indexOf("company");
    if (companyIndex < 0 || !parts[companyIndex + 1]) return "";
    return `https://www.linkedin.com/company/${parts[companyIndex + 1]}/`;
  } catch {
    return "";
  }
}

function linkedInCompanyPeopleUrl(value) {
  const companyUrl = normalizeLinkedInCompanyUrl(value);
  return companyUrl ? `${companyUrl}people/` : "";
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 64);
  } catch {
    return value;
  }
}

function publicLeadNote(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/\b(crm|folder|page\s+\d+|status|owner|imported|advantage|netlify|api token|api key|endpoint|uuid|id[:=])\b/i.test(raw)) return "";
  return raw
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\b[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{13,}\b/g, "")
    .trim()
    .slice(0, 180);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Не вдалося прочитати файл."));
    reader.readAsDataURL(file);
  });
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
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

function parseProfiles(text, fileName = "") {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (fileName.endsWith(".json") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const rows = parseCsv(trimmed);
  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return rows
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index] || ""]))
    );
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function moveSelectedProspect(direction) {
  const prospects = state.prospects || [];
  if (!prospects.length) return;
  const currentIndex = Math.max(0, prospects.findIndex((prospect) => prospect.id === selectedProspectId));
  const nextIndex = (currentIndex + direction + prospects.length) % prospects.length;
  selectedProspectId = prospects[nextIndex].id;
  if (activeResearchJob?.prospectId !== selectedProspectId) activeResearchJob = null;
  activeLeadSectionId = "dashboard-client";
  render();
  scrollLeadWorkspaceToTop();
}

function scrollLeadWorkspaceToTop() {
  document.getElementById("dashboard-overview")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

navItems.forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

document.getElementById("mobileLeadSectionSelect").addEventListener("change", (event) => {
  activeLeadSectionId = event.target.value || "dashboard-account";
  renderLeadSectionTabs();
  document.querySelector(".lead-section-nav")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("accountMenuBtn").addEventListener("click", () => setView("account"));

document.getElementById("authModeBtn").addEventListener("click", () => {
  authMode = authMode === "recover" ? "login" : "recover";
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
    if ((authMode === "bootstrap" || authMode === "reset") && password !== confirmation) throw new Error("Паролі не збігаються.");
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

document.addEventListener("click", async (event) => {
  const contactDecision = event.target.closest("[data-contact-decision]");
  if (contactDecision && selectedProspectId) {
    await runUiAction("contact-approval", "Перевіряємо докази контакту й доступ до каналу...", async () => {
      state = await api("/api/prospects/contacts/approval", { method: "POST", body: JSON.stringify({ prospectId: selectedProspectId, type: contactDecision.dataset.contactType, value: contactDecision.dataset.contactValue, decision: contactDecision.dataset.contactDecision }) });
    });
    return;
  }
  if (event.target.closest("#retrainScoringBtn")) {
    state = await api("/api/scoring/retrain", { method: "POST", body: "{}" });
    render();
  }
});

document.getElementById("chartMode").addEventListener("change", drawTrafficChart);
document.getElementById("modelSearch").addEventListener("input", renderModels);
document.getElementById("modelTierFilter").addEventListener("change", renderModels);
document.getElementById("prospectSearch").addEventListener("input", renderProspects);
document.getElementById("prospectStatusFilter").addEventListener("change", renderProspects);
document.getElementById("productSelect").addEventListener("change", async (event) => {
  await runUiAction("product", "Перемикаємо контекст продукту...", async () => {
    state = await api("/api/products/select", {
      method: "POST",
      body: JSON.stringify({ productId: event.target.value })
    });
  });
});


document.getElementById("syncMcpBtn").addEventListener("click", async () => {
  state = await api("/api/products/sync-mcp", { method: "POST", body: "{}" });
  render();
});

document.getElementById("quickPrepareBtn").addEventListener("click", async () => {
  await runUiAction("research", "Шукаємо все про людину і компанію, пишемо опис і підходи...", () => researchAndPrepareSelected());
});

document.getElementById("runResearchTopBtn").addEventListener("click", async () => {
  await runUiAction("research", "Шукаємо все про людину і компанію, пишемо опис і підходи...", () => researchAndPrepareSelected());
});

document.getElementById("analyzeIntelligenceBtn").addEventListener("click", async () => {
  await runUiAction("intelligence", "Збираємо бриф по акаунту...", () => analyzeLeadIntelligence(false));
});

document.getElementById("refreshIntelligenceBtn").addEventListener("click", async () => {
  await runUiAction("intelligence", "Оновлюємо бриф по акаунту...", () => analyzeLeadIntelligence(true));
});

document.getElementById("analyzeIntelligenceQuick").addEventListener("click", async () => {
  await runUiAction("intelligence", "Збираємо бриф по акаунту...", () => analyzeLeadIntelligence(false));
});

document.getElementById("prevLeadBtn").addEventListener("click", () => {
  movePanel(-1);
});

document.getElementById("nextLeadBtn").addEventListener("click", () => {
  movePanel(1);
});

document.getElementById("nextLeadRailBtn").addEventListener("click", () => {
  movePanel(1);
});

document.getElementById("panelFolderSelect").addEventListener("change", async (event) => {
  panelFolderId = event.target.value;
  panelIndex = 0;
  panelTotal = 0;
  panelContact = null;
  panelQueueNotice = "";
  rememberPanelPosition();
  if (!panelFolderId) {
    renderPanelSource();
    return;
  }
  await openPanelPosition(0);
});

document.getElementById("panelProductSelect").addEventListener("change", async (event) => {
  await runUiAction("product", "Перемикаємо контекст продукту...", async () => {
    state = await api("/api/products/select", {
      method: "POST",
      body: JSON.stringify({ productId: event.target.value })
    });
  });
});

document.getElementById("panelFoldersRefreshBtn").addEventListener("click", async () => {
  await loadPanelFolders({ force: true });
});

document.getElementById("enrichLeadBtn").addEventListener("click", async () => {
  await runUiAction("research", "Шукаємо все про людину і компанію, пишемо опис і підходи...", () => researchAndPrepareSelected());
});

/**
 * Чи може ключ цього середовища оновити рядок у wl_events.
 *
 * Від відповіді залежить, яким шляхом іти в дедуплікації історії: оновлювати
 * тимчасовий рядок на місці чи назавжди тримати два і ховати один при
 * показі. Перевірити можна лише там, де є ключі — тобто на розгорнутому
 * сервері, — тож це кнопка в застосунку, а не скрипт, який нікому не запустити.
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
    const line = (label, step) => `<li class="${step?.ok ? "is-ok" : "is-bad"}">${escapeHtml(label)}: ${step?.ok ? "так" : `ні — ${escapeHtml(step?.error || "без пояснення")}`}</li>`;
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

document.getElementById("inviteContent").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const prospect = state?.prospects?.find((item) => item.id === selectedProspectId);
  const crmContactId = crmContactIdOf(prospect);
  if (!crmContactId) return;

  const run = async (message, work) => {
    await runUiAction("invite", message, work);
    await loadInviteContext(prospect, { force: true });
  };

  if (button.id === "inviteSendBtn") {
    const accountId = document.getElementById("inviteAccountSelect")?.value || "";
    const note = document.getElementById("inviteNoteInput")?.value || "";
    if (!accountId) return;
    await run("Ставимо запит у чергу...", async () => {
      const answer = await warmupApi("/invites", { method: "POST", body: JSON.stringify({ accountId, crmContactId, note }) });
      inviteState = answer.invite;
    });
    return;
  }

  if (button.id === "inviteByHandBtn") {
    const accountId = document.getElementById("inviteAccountSelect")?.value || inviteState?.accountId || "";
    if (!accountId) return;
    await run("Записуємо, що запит уже надіслано...", async () => {
      const answer = await warmupApi("/invites/sent-by-hand", {
        method: "POST",
        body: JSON.stringify({ accountId, crmContactId, note: document.getElementById("inviteNoteInput")?.value || "" })
      });
      inviteState = answer.invite;
      if (answer.overQuota) uiNotice = "Записано. Це понад денну норму акаунта — видно в його історії.";
    });
    return;
  }

  if (button.id === "inviteMoveBtn") {
    const accountId = document.getElementById("inviteMoveSelect")?.value || "";
    if (!accountId || !inviteState) return;
    await run("Перекидаємо на інший акаунт...", async () => {
      const answer = await warmupApi("/invites/reassign", {
        method: "POST",
        body: JSON.stringify({ outreachId: inviteState.outreachId, accountId })
      });
      inviteState = answer.invite;
    });
    return;
  }

  if (button.id === "inviteCancelBtn" && inviteState) {
    if (!window.confirm("Скасувати запит і відпустити людину назад у пул?")) return;
    await run("Скасовуємо запит...", async () => {
      await warmupApi("/invites/cancel", { method: "POST", body: JSON.stringify({ outreachId: inviteState.outreachId }) });
      inviteState = null;
    });
  }
});

document.getElementById("writeMessagesBtn").addEventListener("click", async () => {
  if (!selectedProspectId) return;
  const approachValue = document.getElementById("messageApproachSelect")?.value ?? "";
  await runUiAction("messages", "Пишемо тексти під вибраний підхід...", async () => {
    // Це один виклик моделі, а не сім стадій дослідження: компанію, людей і бал
    // ми вже маємо, переписати треба лише самі тексти.
    state = await api("/api/prospects/prepare", {
      method: "POST",
      body: JSON.stringify({
        prospectId: selectedProspectId,
        profile: document.getElementById("outreachProfileSelect").value,
        language: document.getElementById("messageLanguageSelect")?.value || "uk",
        approachIndex: approachValue === "" ? undefined : Number(approachValue),
        useIntelligenceAi: false
      })
    });
  });
  activeLeadSectionId = "dashboard-outreach";
  renderLeadSectionTabs();
  refreshIcons();
});

document.getElementById("refreshCompanyBtn").addEventListener("click", async () => {
  await runUiAction("research", "Шукаємо компанію заново, не читаючи збережене...", () => researchAndPrepareSelected({ force: true }));
});

document.addEventListener("click", async (event) => {
  const viewLink = event.target.closest("[data-view-link]");
  if (viewLink) {
    setView(viewLink.dataset.viewLink);
    return;
  }

  const leadTab = event.target.closest("[data-lead-tab]");
  if (leadTab) {
    activeLeadSectionId = leadTab.dataset.leadTab || "dashboard-account";
    renderLeadSectionTabs();
    document.querySelector(".lead-section-nav")?.scrollIntoView({ behavior: "smooth", block: "start" });
    refreshIcons();
    return;
  }

  const openProspect = event.target.closest("[data-open-prospect-id]");
  if (openProspect) {
    selectedProspectId = openProspect.dataset.openProspectId;
    if (activeResearchJob?.prospectId !== selectedProspectId) activeResearchJob = null;
    activeLeadSectionId = "dashboard-client";
    setView("prospects");
    render();
    scrollLeadWorkspaceToTop();
    return;
  }

  const assistantTemplate = event.target.closest("[data-assistant-template]");
  if (assistantTemplate) {
    document.getElementById("assistantTaskInput").value = assistantTemplate.dataset.assistantTemplate || "";
    setView("ai");
    return;
  }

  const inlineAnalyze = event.target.closest("[data-intel-analyze]");
  if (inlineAnalyze) {
    await runUiAction("intelligence", "Збираємо бриф по акаунту...", () => analyzeLeadIntelligence(inlineAnalyze.dataset.intelAnalyze === "refresh"));
    return;
  }

  const intelligenceTask = event.target.closest("[data-intel-task-index]");
  if (intelligenceTask && selectedProspectId) {
    await runUiAction("task", "Створюємо фолоу-ап...", async () => {
      state = await api("/api/prospects/intelligence/create-task", {
        method: "POST",
        body: JSON.stringify({ prospectId: selectedProspectId, stepIndex: Number(intelligenceTask.dataset.intelTaskIndex || 0) })
      });
    });
    return;
  }

  const intelligenceReview = event.target.closest("[data-intel-review-action]");
  if (intelligenceReview && selectedProspectId) {
    await runUiAction("task", "Зберігаємо оновлення перевірки...", async () => {
      state = await api("/api/prospects/intelligence/review", {
        method: "POST",
        body: JSON.stringify({
          prospectId: selectedProspectId,
          action: intelligenceReview.dataset.intelReviewAction,
          targetId: intelligenceReview.dataset.intelTargetId
        })
      });
    });
    return;
  }

  const policyDecision = event.target.closest("[data-policy-decision]");
  if (policyDecision && selectedProspectId) {
    const status = policyDecision.dataset.policyDecision;
    const label = status === "parked" ? "Відкладаємо акаунт..." : "Зберігаємо затверджені умови...";
    await runUiAction("policy-decision", label, async () => {
      state = await api("/api/prospects/policy-decision", {
        method: "POST",
        body: JSON.stringify({ prospectId: selectedProspectId, status })
      });
    });
    uiNotice = status === "parked"
      ? "Акаунт відкладено. Дослідження й аутріч лишаються на паузі."
      : "Умови затверджено. Запусти дослідження ще раз, щоб перебудувати стратегію під ці умови.";
    renderTopbar();
    return;
  }

  const removeProspect = event.target.closest("[data-remove-prospect-id]");
  if (removeProspect) {
    await removeProspectById(removeProspect.dataset.removeProspectId);
    return;
  }

  const prospectCardButton = event.target.closest("[data-prospect-id]");
  if (prospectCardButton) {
    selectedProspectId = prospectCardButton.dataset.prospectId;
    if (activeResearchJob?.prospectId !== selectedProspectId) activeResearchJob = null;
    activeLeadSectionId = "dashboard-client";
    renderProspects();
    renderLeadWorkspaceExtras(state.prospects?.find((prospect) => prospect.id === selectedProspectId));
    refreshIcons();
  }

  const copyButton = event.target.closest("[data-copy-text]");
  if (copyButton) {
    const copiedText = copyButton.dataset.copyText || "";
    await navigator.clipboard.writeText(copiedText);
    const originalHtml = copyButton.dataset.copyDefaultHtml || copyButton.innerHTML;
    copyButton.dataset.copyDefaultHtml = originalHtml;
    copyButton.innerHTML = `<i data-lucide="check"></i><span>Скопійовано</span>`;
    refreshIcons();
    void logCopiedActivity(copyButton, copiedText);
    window.setTimeout(() => {
      copyButton.innerHTML = originalHtml;
      refreshIcons();
    }, 900);
    return;
  }

  const actionInteraction = event.target.closest("[data-interaction-type]");
  if (actionInteraction && selectedProspectId) {
    await logInteraction(actionInteraction.dataset.interactionType);
    return;
  }

  const completeTask = event.target.closest("[data-task-complete-id]");
  if (completeTask) {
    await runUiAction("task", "Закриваємо фолоу-ап...", async () => {
      state = await api("/api/follow-up-tasks/complete", {
        method: "POST",
        body: JSON.stringify({ taskId: completeTask.dataset.taskCompleteId })
      });
    });
    return;
  }

  const toggle = event.target.closest("[data-model-toggle]");
  if (toggle) {
    state = await api("/api/models/toggle", {
      method: "POST",
      body: JSON.stringify({ modelId: toggle.dataset.modelToggle, enabled: toggle.dataset.enabled === "true" })
    });
    render();
  }

  const taskRow = event.target.closest("[data-task-row]");
  if (taskRow) {
    selectedTaskType = taskRow.dataset.taskRow;
    renderRouting();
    refreshIcons();
  }
});

document.getElementById("sampleProspectsBtn").addEventListener("click", async () => {
  const prospects = [
    {
      name: "Nina Patel",
      title: "Director of Growth",
      company: "HelioGrid Energy",
      location: "Denver, CO",
      website: "heliogrid.example",
      notes: "Building a partner-sourced pipeline motion across regional energy installers."
    },
    {
      name: "Owen Miller",
      title: "Chief Commercial Officer",
      company: "SlateBridge Finance",
      location: "New York, NY",
      website: "slatebridge.example",
      notes: "Announced new SMB lending product and expanded account executive hiring."
    }
  ];
  state = await api("/api/prospects/import", {
    method: "POST",
    body: JSON.stringify({ prospects })
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  render();
});

document.getElementById("linkedinTargetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await runUiAction("linkedin-import", "Додаємо ціль з LinkedIn у чергу...", async () => {
    state = await api("/api/prospects/linkedin-target", {
      method: "POST",
      body: JSON.stringify({
        linkedinUrl: document.getElementById("linkedinTargetUrlInput").value,
        name: document.getElementById("linkedinTargetNameInput").value,
        company: document.getElementById("linkedinTargetCompanyInput").value
      })
    });
    selectedProspectId = state.prospects[0]?.id || selectedProspectId;
    document.getElementById("linkedinTargetUrlInput").value = "";
    document.getElementById("linkedinTargetNameInput").value = "";
    document.getElementById("linkedinTargetCompanyInput").value = "";
  });
});

document.getElementById("assistantTaskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("assistantTaskInput");
  await runAssistantTask({
    instruction: input.value,
    scope: document.getElementById("assistantScopeSelect").value,
    limit: Number(document.getElementById("assistantLimitInput").value),
    selectedProspectId
  });
  input.value = "";
});

document.getElementById("crmLeadPullForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    source: document.getElementById("crmPullSourceInput").value,
    resource: document.getElementById("crmPullResourceInput").value,
    limit: Number(document.getElementById("crmPullLimitInput").value),
    linkedinField: document.getElementById("crmPullLinkedInFieldInput").value
  };
  await runUiAction("crm-import", "Тягнемо лідів із CRM...", async () => {
    state = await api("/api/crm/import-leads", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  });
});

document.getElementById("agentRunForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/agents/run", {
    method: "POST",
    body: JSON.stringify({
      agentId: document.getElementById("agentSelect").value,
      scope: document.getElementById("agentScopeSelect").value,
      limit: Number(document.getElementById("agentLimitInput").value),
      selectedProspectId,
      instruction: document.getElementById("agentInstructionInput").value
    })
  });
  render();
});

document.getElementById("runPipelineBtn").addEventListener("click", async () => {
  state = await api("/api/agents/pipeline", {
    method: "POST",
    body: JSON.stringify({
      scope: document.getElementById("agentScopeSelect").value,
      limit: Number(document.getElementById("agentLimitInput").value),
      selectedProspectId,
      instruction: document.getElementById("agentInstructionInput").value
    })
  });
  render();
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
 * Продукти: вісім відповідей про продукт і файли, які агенти читають перед тим,
 * як писати повідомлення. Одна сторінка, бо це одна відповідь на одне питання —
 * що система знає про те, що ми продаємо.
 *
 * Файли й відповіді лежать на сервері; тут — тільки списки, редактор і чернетка
 * того, що зараз відкрито. Чернетка потрібна, бо render() смикається з десятка
 * місць (кожна відповідь /api/state його викликає), і перемальовування textarea
 * під час набору стерло б недописаний абзац.
 */
const productBriefQuestions = ["offer", "icp", "buyers", "pain", "proof", "firstStep", "objections", "limits"];

function renderProductWorkspace() {
  const picker = document.getElementById("productPickerList");
  if (!picker) return;

  const products = [...(state.products || [])].sort((left, right) => left.name.localeCompare(right.name, "uk"));
  const files = knowledgeLibrary.files || [];
  const selectedId = state.selectedProductId;

  picker.innerHTML = products.length
    ? products.map((product) => {
        const fileCount = files.filter((file) => (file.productIds || []).includes(product.id)).length;
        const answered = productBriefQuestions.filter((field) => String(product.brief?.[field] || "").trim()).length;
        return `
          <article class="product-picker-row ${product.id === selectedId ? "active" : ""}" data-product="${escapeAttr(product.id)}">
            <strong>${escapeHtml(product.name)}</strong>
            <span>${answered}/8 ${uaPlural(answered, "відповідь", "відповіді", "відповідей")} · ${fileCount} ${uaPlural(fileCount, "файл", "файли", "файлів")}</span>
          </article>
        `;
      }).join("")
    : `<div class="empty-state">Продуктів ще немає</div>`;

  renderProductBrief();
  renderKnowledgeFiles();
  renderKnowledgeEditor();
}

function renderProductBrief() {
  const product = state.selectedProduct;
  const form = document.getElementById("productBriefForm");
  if (!form || !product) return;

  const answered = productBriefQuestions.filter((field) => String(product.brief?.[field] || "").trim()).length;
  setText("productBriefTitle", product.name || "Продукт");
  setText("productBriefPill", `${answered}/8`);
  setText(
    "productBriefMeta",
    product.brief?.updatedAt
      ? `Оновлено ${relativeTime(product.brief.updatedAt)}`
      : "Ще не заповнено — AI поки спирається лише на файли"
  );

  // Поля заповнюються тільки коли змінився продукт: інакше кожен render() під
  // час набору повертав би текст до збереженої версії.
  if (productBriefLoadedFor !== product.id) {
    setFormValue("productNameInput", product.name || "");
    for (const field of productBriefQuestions) {
      setFormValue(`brief-${field}`, product.brief?.[field] || "");
    }
    productBriefLoadedFor = product.id;
  }
}

function renderKnowledgeFiles() {
  const product = state.selectedProduct;
  const files = (knowledgeLibrary.files || []).filter((file) => (file.productIds || []).includes(product?.id));
  setText("knowledgeFilesTitle", product ? `Файли · ${product.name}` : "Файли");
  setText(
    "knowledgeFilesSubtitle",
    product
      ? `Агенти читають ці файли, коли пишуть для «${product.name}»`
      : "Агенти читають ці файли перед тим, як писати повідомлення"
  );

  setHtml("knowledgeFileList", files.length
    ? files.map((file) => `
        <article class="knowledge-file-row ${file.id === knowledgeFileId ? "active" : ""}" data-knowledge-file="${escapeAttr(file.id)}">
          <div class="knowledge-file-heading">
            <strong>${escapeHtml(file.name)}</strong>
            ${(file.productIds || []).length > 1 ? `<span class="pill">спільний</span>` : ""}
          </div>
          <p>${escapeHtml(file.excerpt || "Порожній файл")}</p>
          <small>${Math.max(1, Math.round((file.bytes || 0) / 1024))} КБ · оновлено ${relativeTime(file.updatedAt)}</small>
        </article>
      `).join("")
    : `<div class="empty-state">Для цього продукту ще немає файлів</div>`);
}

function renderKnowledgeEditor() {
  const form = document.getElementById("knowledgeEditorForm");
  const empty = document.getElementById("knowledgeEditorEmpty");
  if (!form || !empty) return;

  if (!knowledgeDraft) {
    form.hidden = true;
    empty.hidden = false;
    setText("knowledgeEditorTitle", "Файл не вибрано");
    setText("knowledgeEditorSubtitle", "Вибери файл зліва або створи новий");
    setText("knowledgeEditorPill", "готово");
    return;
  }

  form.hidden = false;
  empty.hidden = true;
  setText("knowledgeEditorTitle", knowledgeDraft.id ? knowledgeDraft.name : "Новий файл");
  setText(
    "knowledgeEditorSubtitle",
    knowledgeDraft.id
      ? "Зміни зберігаються на сервері й одразу стають доступними агентам"
      : "Файл з'явиться в бібліотеці після збереження"
  );
  setText("knowledgeEditorPill", knowledgeDraft.id ? "редагування" : "новий");
  setText(
    "knowledgeEditorMeta",
    knowledgeDraft.id
      ? `Оновлено ${relativeTime(knowledgeDraft.updatedAt)}${knowledgeDraft.updatedBy ? ` · ${knowledgeDraft.updatedBy}` : ""}`
      : ""
  );
  const deleteButton = document.getElementById("knowledgeDeleteFileBtn");
  if (deleteButton) deleteButton.hidden = !knowledgeDraft.id;

  setHtml("knowledgeFileProductPicker", (state.products || []).map((product) => `
    <label class="knowledge-product-checkbox">
      <input type="checkbox" value="${escapeAttr(product.id)}" ${knowledgeDraft.productIds.includes(product.id) ? "checked" : ""} />
      <span>${escapeHtml(product.name)}</span>
    </label>
  `).join(""));

  if (knowledgeEditorNeedsFill) {
    setFormValue("knowledgeFileNameInput", knowledgeDraft.name || "");
    setFormValue("knowledgeFileContentInput", knowledgeDraft.content || "");
    knowledgeEditorNeedsFill = false;
  }
}

async function loadKnowledgeLibrary({ force = false } = {}) {
  if (knowledgeLibraryLoaded && !force) return;
  knowledgeLibrary = await api("/api/knowledge/library");
  knowledgeLibraryLoaded = true;
  renderProductWorkspace();
  refreshIcons();
}

async function openKnowledgeFile(fileId) {
  const { file } = await api(`/api/knowledge/library/files/${encodeURIComponent(fileId)}`);
  knowledgeFileId = file.id;
  knowledgeDraft = {
    id: file.id,
    name: file.name,
    productIds: [...(file.productIds || [])],
    content: file.content || "",
    updatedAt: file.updatedAt,
    updatedBy: file.updatedBy
  };
  knowledgeEditorNeedsFill = true;
  renderProductWorkspace();
  refreshIcons();
}

function startNewKnowledgeFile() {
  if (!state.selectedProductId) return;
  knowledgeFileId = null;
  knowledgeDraft = {
    id: "",
    name: "",
    productIds: [state.selectedProductId],
    content: "",
    updatedAt: new Date().toISOString(),
    updatedBy: ""
  };
  knowledgeEditorNeedsFill = true;
  renderProductWorkspace();
  refreshIcons();
  document.getElementById("knowledgeFileNameInput")?.focus();
}

function selectedKnowledgeProductIds() {
  return [...document.querySelectorAll("#knowledgeFileProductPicker input[type=checkbox]")]
    .filter((input) => input.checked)
    .map((input) => input.value);
}

document.getElementById("productPickerList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-product]");
  if (!row || row.dataset.product === state.selectedProductId) return;
  await runUiAction("product", "Перемикаємо контекст продукту...", async () => {
    state = await api("/api/products/select", {
      method: "POST",
      body: JSON.stringify({ productId: row.dataset.product })
    });
    // Відкритий файл належить попередньому продукту — редактор закривається,
    // щоб ніхто не зберіг чужий файл у чужому контексті.
    knowledgeDraft = null;
    knowledgeFileId = null;
  });
});

document.getElementById("productBriefForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const brief = Object.fromEntries(
    productBriefQuestions.map((field) => [field, document.getElementById(`brief-${field}`).value])
  );
  if (!productBriefQuestions.some((field) => brief[field].trim())) {
    window.alert("Заповни хоча б одну відповідь про продукт.");
    return;
  }
  await runUiAction("product", "Зберігаємо опис продукту...", async () => {
    state = await api("/api/products/brief", {
      method: "POST",
      body: JSON.stringify({
        productId: state.selectedProductId,
        name: document.getElementById("productNameInput").value,
        brief
      })
    });
    // Перечитуємо збережене: сервер міг почистити назву або порожні рядки.
    productBriefLoadedFor = null;
  });
});

document.getElementById("knowledgeFileList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-knowledge-file]");
  if (!row) return;
  await openKnowledgeFile(row.dataset.knowledgeFile);
});

document.getElementById("knowledgeNewFileBtn").addEventListener("click", () => {
  startNewKnowledgeFile();
});

document.getElementById("knowledgeEditorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!knowledgeDraft) return;
  const name = document.getElementById("knowledgeFileNameInput").value;
  const content = document.getElementById("knowledgeFileContentInput").value;
  const productIds = selectedKnowledgeProductIds();
  if (!productIds.length) {
    window.alert("Признач файл хоча б одному продукту — інакше його ніхто не прочитає.");
    return;
  }
  await runUiAction("knowledge-file", "Зберігаємо файл на сервері...", async () => {
    const result = knowledgeDraft.id
      ? await api(`/api/knowledge/library/files/${encodeURIComponent(knowledgeDraft.id)}`, {
          method: "POST",
          body: JSON.stringify({ name, content, productIds })
        })
      : await api("/api/knowledge/library/files", {
          method: "POST",
          body: JSON.stringify({ name, content, productIds })
        });
    knowledgeLibrary = result.library;
    knowledgeFileId = result.file.id;
    knowledgeDraft = {
      id: result.file.id,
      name: result.file.name,
      productIds: [...result.file.productIds],
      content: result.file.content ?? content,
      updatedAt: result.file.updatedAt,
      updatedBy: result.file.updatedBy
    };
    knowledgeEditorNeedsFill = true;
  });
});

document.getElementById("knowledgeDeleteFileBtn").addEventListener("click", async () => {
  if (!knowledgeDraft?.id) return;
  if (!window.confirm(`Видалити файл «${knowledgeDraft.name}» із сервера? Агенти більше не читатимуть його.`)) return;
  const result = await api(`/api/knowledge/library/files/${encodeURIComponent(knowledgeDraft.id)}/delete`, { method: "POST", body: "{}" });
  knowledgeLibrary = result.library;
  knowledgeDraft = null;
  knowledgeFileId = null;
  renderProductWorkspace();
  refreshIcons();
});

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
    setText("contactCardSubtitle", "Вибери папку зліва, потім людину — і побачиш усе, що про неї знає CRM");
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
      return `<div><dt>${escapeHtml(label)}</dt><dd>${linkIfUrl(text)}</dd></div>`;
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
  if (contactFoldersLoaded && !force) return;
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

document.getElementById("contactImportBtn").addEventListener("click", async () => {
  if (!selectedContactId) return;
  await runUiAction("contact-import", "Додаємо контакт у чергу лідів...", async () => {
    const payload = await api(`/api/contacts/${encodeURIComponent(selectedContactId)}/import`, { method: "POST", body: "{}" });
    contactProspectId = payload.prospectId;
    selectedProspectId = payload.prospectId || selectedProspectId;
    state = payload;
  });
  renderContacts();
  refreshIcons();
});

document.getElementById("profileFileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const prospects = parseProfiles(text, file.name);
  state = await api("/api/prospects/import", {
    method: "POST",
    body: JSON.stringify({ prospects })
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  event.target.value = "";
  render();
});

document.getElementById("pasteProfilesForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const textarea = document.getElementById("profilesTextInput");
  const prospects = parseProfiles(textarea.value);
  state = await api("/api/prospects/import", {
    method: "POST",
    body: JSON.stringify({ prospects })
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  textarea.value = "";
  render();
});

document.getElementById("enrichProspectBtn").addEventListener("click", async () => {
  if (!selectedProspectId) return;
  await runUiAction("enrich", "Оновлюємо контакти й месенджери...", async () => {
    state = await api("/api/prospects/enrich", {
      method: "POST",
      body: JSON.stringify({ prospectId: selectedProspectId, force: true })
    });
  });
});

document.getElementById("prepareOutreachBtn").addEventListener("click", async () => {
  await runUiAction("research", "Шукаємо все про людину і компанію, пишемо опис і підходи...", () => researchAndPrepareSelected());
});

async function analyzeLeadIntelligence(force = false) {
  if (!selectedProspectId) return;
  activeLeadSectionId = "dashboard-intelligence";
  state = await api("/api/prospects/intelligence/analyze", {
    method: "POST",
    body: JSON.stringify({
      prospectId: selectedProspectId,
      force,
      refreshReason: force ? "manual_refresh" : "seller_requested_brief"
    })
  });
  render();
  document.querySelector(".lead-section-nav")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * «Збагатити»: одна дія від «ось людина» до «ось з чого з нею почати».
 *
 * `force` — це «шукай компанію заново»: за замовчуванням дослідження читає вже
 * збережений досьє компанії і не платить за ті самі відповіді вдруге.
 */
async function researchAndPrepareSelected({ force = false } = {}) {
  if (!selectedProspectId) return;
  const profile = document.getElementById("outreachProfileSelect").value;
  const payload = await api("/api/research/jobs", {
    method: "POST",
    body: JSON.stringify({
      prospectId: selectedProspectId,
      profile,
      force,
      language: document.getElementById("messageLanguageSelect")?.value || ""
    })
  });
  activeResearchJob = payload.job;
  renderResearchProgress();
  refreshIcons();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (["queued", "running"].includes(activeResearchJob.status) && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    const update = await api(`/api/research/jobs/${encodeURIComponent(activeResearchJob.id)}`);
    activeResearchJob = update.job;
    const runningStage = activeResearchJob.stages?.find((stage) => stage.status === "running");
    busyMessage = runningStage ? `${runningStage.label} · ${activeResearchJob.progress}%` : `Дослідження · ${activeResearchJob.progress}%`;
    renderTopbar();
    renderResearchProgress();
    refreshIcons();
  }
  if (activeResearchJob.status !== "complete") {
    throw new Error(activeResearchJob.error || "Дослідження не завершилося за п'ять хвилин.");
  }
  await refresh();
  activeLeadSectionId = "dashboard-client";
  render();
}

async function runAssistantTask(payload) {
  if (!payload.instruction?.trim()) {
    document.getElementById("assistantActionList").innerHTML = `<div class="empty-state">Напиши задачу для AI-оператора</div>`;
    return;
  }
  state = await api("/api/assistant/task", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  render();
}

async function logInteraction(type) {
  if (!selectedProspectId || !type) return;
  await runUiAction("task", "Фіксуємо дію по цьому ліду...", async () => {
    state = await api("/api/prospects/interaction", {
      method: "POST",
      body: JSON.stringify({ prospectId: selectedProspectId, type })
    });
  });
}

async function logCopiedActivity(button, copiedText) {
  if (!selectedProspectId || !String(copiedText || "").trim()) return;
  const channel = normalizeCopyChannel(button.dataset.copyChannel || inferCopyChannel(copiedText));
  const type = copiedInteractionType(channel);
  const label = copyLabelText(button.dataset.copyLabel);
  const preview = cleanCopyPreview(copiedText);
  try {
    state = await api("/api/prospects/interaction", {
      method: "POST",
      body: JSON.stringify({
        prospectId: selectedProspectId,
        type,
        channel,
        outcome: "copied",
        note: `${label}: ${titleCase(channel)} скопійовано в Outbound OS.`,
        source: "copy-button",
        metadata: {
          uiLabel: label,
          messagePreview: preview,
          copiedLength: String(copiedText || "").length
        }
      })
    });
    renderLeadWorkspaceExtras(state.prospects?.find((prospect) => prospect.id === selectedProspectId));
  } catch (error) {
    console.warn("Copy activity was not logged", error);
  }
}

/**
 * `data-copy-label` у розмітці — ключ, а не текст: атрибути `data-*` розмітка не
 * перекладає. Тост, який його показує, будується тут, тому переклад теж тут.
 */
const COPY_LABEL_UA = {
  "LinkedIn quick copy": "Швидка копія LinkedIn",
  "Email quick copy": "Швидка копія email",
  "SMS quick copy": "Швидка копія SMS",
  "WhatsApp quick copy": "Швидка копія WhatsApp",
  "Telegram quick copy": "Швидка копія Telegram"
};

function copyLabelText(value) {
  const text = String(value || "").trim();
  return COPY_LABEL_UA[text] || text || "Скопійований аутріч";
}

function normalizeCopyChannel(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("linkedin")) return "linkedin";
  if (text.includes("email")) return "email";
  if (text.includes("whatsapp")) return "whatsapp";
  if (text.includes("telegram")) return "telegram";
  if (text.includes("sms") || text.includes("phone")) return text.includes("phone") ? "phone" : "sms";
  if (text.includes("call")) return "phone";
  if (text.includes("facebook")) return "facebook";
  return "outreach";
}

function copiedInteractionType(channel) {
  if (channel === "linkedin") return "linkedin_message_copied";
  if (channel === "email") return "email_message_copied";
  if (channel === "sms") return "sms_message_copied";
  if (channel === "whatsapp") return "whatsapp_message_copied";
  if (channel === "telegram") return "telegram_message_copied";
  if (channel === "phone") return "phone_script_copied";
  return "outreach_message_copied";
}

function inferCopyChannel(value) {
  const text = String(value || "").toLowerCase();
  if (/linkedin\.com|connect on linkedin|connection/.test(text)) return "linkedin";
  if (/whatsapp|wa\.me/.test(text)) return "whatsapp";
  if (/telegram|t\.me/.test(text)) return "telegram";
  if (/@/.test(text)) return "email";
  if (/\+?\d[\d\s().-]{7,}/.test(text)) return "phone";
  return "outreach";
}

function cleanCopyPreview(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function removeProspectById(prospectId = selectedProspectId) {
  if (!prospectId) return;
  await runUiAction("remove", "Прибираємо ліда з черги...", async () => {
    state = await api("/api/prospects/remove", {
      method: "POST",
      body: JSON.stringify({ prospectId })
    });
    if (selectedProspectId === prospectId) {
      selectedProspectId = state.prospects?.[0]?.id || null;
    }
  });
}

document.getElementById("logInteractionBtn").addEventListener("click", async () => {
  if (!selectedProspectId) return;
  await logInteraction(document.getElementById("interactionTypeSelect").value);
});

document.getElementById("taskLogInteractionBtn").addEventListener("click", async () => {
  if (!selectedProspectId) return;
  await logInteraction(document.getElementById("taskInteractionTypeSelect").value);
});

document.getElementById("removeLeadQuick").addEventListener("click", async () => {
  await removeProspectById(selectedProspectId);
});

document.getElementById("keyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiKey = document.getElementById("apiKeyInput").value;
  const environment = document.getElementById("environmentInput").value;
  state = await api("/api/openrouter/key", {
    method: "POST",
    body: JSON.stringify({ apiKey, environment })
  });
  document.getElementById("apiKeyInput").value = "";
  render();
});

document.getElementById("testConnectionBtn").addEventListener("click", async () => {
  state = await api("/api/openrouter/test", { method: "POST", body: "{}" });
  render();
});

document.getElementById("revokeKeyBtn").addEventListener("click", async () => {
  state = await api("/api/openrouter/revoke", { method: "POST", body: "{}" });
  render();
});

document.getElementById("syncModelsBtn").addEventListener("click", async () => {
  state = await api("/api/openrouter/sync", { method: "POST", body: "{}" });
  render();
});

document.getElementById("taskSelect").addEventListener("change", (event) => {
  selectedTaskType = event.target.value;
  renderRouting();
  refreshIcons();
});

document.getElementById("routingForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fallbackSelect = document.getElementById("fallbackModelSelect");
  const fallbackModels = [...fallbackSelect.selectedOptions].map((option) => option.value);
  state = await api("/api/tasks/update", {
    method: "POST",
    body: JSON.stringify({
      taskType: document.getElementById("taskSelect").value,
      primaryModel: document.getElementById("primaryModelSelect").value,
      fallbackModels,
      maxCostUsd: Number(document.getElementById("taskCostInput").value),
      maxLatencyMs: Number(document.getElementById("taskLatencyInput").value),
      privacyLevel: document.getElementById("taskPrivacySelect").value
    })
  });
  selectedTaskType = document.getElementById("taskSelect").value;
  render();
});

document.getElementById("budgetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/budgets/update", {
    method: "POST",
    body: JSON.stringify({
      monthlyWorkspaceBudgetUsd: Number(document.getElementById("monthlyBudgetInput").value),
      dailyWorkspaceBudgetUsd: Number(document.getElementById("dailyBudgetInput").value),
      perUserMonthlyBudgetUsd: Number(document.getElementById("userBudgetInput").value),
      warningThresholdPercent: Number(document.getElementById("thresholdInput").value),
      hardLimitEnabled: document.getElementById("hardLimitInput").checked
    })
  });
  render();
});

document.getElementById("privacyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/provider-rule/update", {
    method: "POST",
    body: JSON.stringify({
      policy: document.getElementById("providerPolicyInput").value,
      allowProviderFallbacks: document.getElementById("providerFallbackInput").checked,
      requireNoTraining: document.getElementById("noTrainingInput").checked,
      requireZeroRetention: document.getElementById("zeroRetentionInput").checked
    })
  });
  render();
});

document.getElementById("runTaskBtn").addEventListener("click", () => {
  document.getElementById("runDialog").showModal();
  refreshIcons();
});

document.getElementById("runForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") {
    return;
  }
  event.preventDefault();
  const payload = await api("/api/tasks/run", {
    method: "POST",
    body: JSON.stringify({
      taskType: document.getElementById("runTaskSelect").value,
      profile: document.getElementById("runProfileSelect").value,
      preferredModel: document.getElementById("runPreferredModelSelect").value
    })
  });
  state = payload;
  document.getElementById("runOutput").textContent = payload.run.ok
    ? `Використано ${payload.run.modelUsed} через ${payload.run.provider}. Вартість ${formatUsd(payload.run.usage.costUsd)}.`
    : payload.run.message;
  render();
});

document.getElementById("compareBtn").addEventListener("click", () => {
  renderEvaluation();
});

await bootApplication();

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
  paused: "tone-warn",
  blocked: "tone-bad",
  needs_attention: "tone-warn",
  finished: "tone-done",
  excluded: "tone-muted",
  off: "tone-muted"
};

const WARMUP_STATUS_LABEL = {
  warming: "Прогрівається",
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
  if (quota > 0) return `${today}/${quota} <span class="warmup-subtle">· ${total} за весь час</span>`;
  if (startsDay) return `<span class="warmup-subtle">з ${startsDay}-го дня</span>`;
  return `<span class="warmup-subtle">${total} за весь час</span>`;
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
    { label: "На паузі", value: totals.paused },
    { label: "Завершені", value: totals.completed },
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

const WARMUP_CAMPAIGN_TONE = {
  draft: "tone-muted",
  running: "tone-live",
  paused: "tone-warn",
  done: "tone-done"
};

/** What a campaign in this state is doing, said once rather than implied. */
const WARMUP_CAMPAIGN_STATE_NOTE = {
  draft: "Чернетка не закріплює нікого. Запусти її — і її акаунти почнуть брати людей із цієї папки.",
  running: "Працює: усе, що лишається від сьогоднішньої квоти, пропонується цій кампанії в порядку нижче.",
  paused: "На паузі. Її акаунти витрачають квоту на кампанії, що нижче; уже закріплене нікуди не дівається.",
  done: "Позначена завершеною. З неї більше нічого не закріплюється, а надіслане лишається історією."
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
      html: `<p class="warmup-forecast-line">${escapeHtml(reason)}</p>
        <p class="warmup-forecast-hint">${campaign?.folderId
          ? "Поки сервер не порахує, ніщо не скаже, скільки ця папка займе, — тож вважай цю кампанію неперевіреною."
          : "Відредагуй її й обери папку — доти їй нізвідки брати людей."}</p>${stale}`
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
    `<span>до ${warmupCount(approached)} уже зверталися</span>`,
    `<strong>${warmupCount(peak)} на день</strong>`,
    `<span>~${warmupCount(perMonth)} за місяць</span>`,
    remaining === 0
      ? `<span>опрацьовувати більше нікого</span>`
      : fullPass
        ? `<span>повний прохід ~${escapeHtml(fullPass)}</span>`
        : `<span>повний прохід не завершиться ніколи</span>`
  ];

  let tone = "is-ok";
  let hint = "";

  // A folder that matches nobody and a folder worked to the end are both "0
  // left", and they need opposite things done about them.
  if (matching === 0) {
    tone = "is-bad";
    hint = "Під ці фільтри в папці не підпадає ніхто, тож цій кампанії немає з ким працювати взагалі. Розшир фільтри або спрямуй її на іншу папку.";
  } else if (chosen === 0) {
    tone = "is-bad";
    hint = `Цю кампанію ніхто не веде, тож із ${warmupCount(remaining)}, що лишились, не дійде черга ні до кого. Познач унизу, у Профілях, акаунти, які мають з неї надсилати.`;
  } else if (peak === 0) {
    tone = "is-bad";
    hint = `${chosen === 1 ? "Позначений акаунт не має" : `${chosen} позначених акаунтів не мають`} квоти на запити навіть на піку, тож ця кампанія ніколи не зрушить. Познач акаунт, який справді прогрівається.`;
  } else if (remaining === 0) {
    tone = "is-muted";
    hint = "До всіх, кого ця кампанія знаходить, уже зверталися. Розшир фільтри або спрямуй її на іншу папку.";
  } else if (remaining > perMonth * 3) {
    tone = "is-bad";
    hint = `Такими темпами ця папка — це ${escapeHtml(fullPass || "більше роботи, ніж ці акаунти колись подужають")} роботи: за перший місяць черга дійде до ${warmupCount(perMonth)} із ${warmupCount(remaining)}, що лишились, а решта просто лежатиме. Відредагуй кампанію і звузь її за країною, посадою чи статусом ліда, поки не лишиться список, який ці акаунти справді закінчать.`;
  } else if (remaining > perMonth) {
    tone = "is-warn";
    hint = `${warmupCount(remaining)}, що лишились, — це більше ніж місяць надсилань. Закінчиться приблизно за ${escapeHtml(fullPass || "невідомо скільки")} — звузь фільтри, якщо це довше за саму кампанію.`;
  }

  // Today and at peak are different promises, and the panel should not let the
  // better one stand for both.
  let today = "";
  if (peak && now === 0) {
    today = `<p class="warmup-forecast-today"><strong>Сьогодні не піде нічого.</strong> Жодному з позначених акаунтів ще не можна надсилати запит на контакт — стратегія притримує їх перші дні, — тож <strong>${warmupCount(peak)} на день</strong> це те, до чого вони дійдуть, коли прогріється кожен, а не те, що буде сьогодні.</p>`;
  } else if (peak && now !== peak) {
    today = `<p class="warmup-forecast-today">Сьогодні це <strong>${warmupCount(now)} на день</strong>, а не ${warmupCount(peak)}: решта позначених акаунтів ще набирають обертів, стоять на паузі або взагалі не прогріваються.</p>`;
  }

  return {
    tone,
    html: `
      <p class="warmup-forecast-line">${parts.join('<span class="warmup-forecast-dot" aria-hidden="true">·</span>')}</p>
      ${hint ? `<p class="warmup-forecast-hint">${hint}</p>` : ""}
      ${today}
      ${stale}`
  };
}

function warmupTickedAccountsLine(campaign) {
  const ids = warmupCampaignAccountIds(campaign);
  if (!ids.size) return "Не позначено жодного акаунта, тож ця кампанія нічого не надсилає.";
  const names = [];
  for (const profile of warmupState.profiles) {
    if (profile.account && ids.has(profile.account.id)) names.push(profile.name);
  }
  const hidden = ids.size - names.length;
  if (!names.length) return `Її ведуть ${ids.size} ${uaPlural(ids.size, "акаунт", "акаунти", "акаунтів")}, яких цей список не показує.`;
  const listed = escapeHtml(names.slice(0, 4).join(", "));
  const more = names.length > 4 ? ` +${names.length - 4} ще` : "";
  return `Ведуть: ${listed}${more}${hidden > 0 ? ` · ще ${hidden} немає у списку нижче` : ""}`;
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

  const meta = [
    escapeHtml(folder),
    `${accounts} ${uaPlural(accounts, "акаунт", "акаунти", "акаунтів")}`,
    product ? escapeHtml(product) : "без продукту"
  ];

  const controls = [];
  // The order is the only thing deciding which campaign an account actually
  // serves — the first running one with work takes the whole quota. So the rank
  // is not a tooltip on a label somebody cannot change; it is the readout of
  // the two arrows that set it.
  const index = warmupState.campaigns.indexOf(campaign);
  const rankLabel = rank
    ? `<strong title="Квота її акаунтів пропонується активним кампаніям у цьому порядку, і бере її перша, у якої є робота.">#${rank} у черзі</strong>`
    : `<em title="Її місце в порядку. У чергу вона стає, коли запрацює.">поза чергою</em>`;
  controls.push(`<span class="warmup-campaign-move">
    <button class="text-button" type="button" data-warmup-campaign-move="up" ${index <= 0 ? "disabled" : ""} title="Пропонувати цій кампанії квоту її акаунтів раніше" aria-label="Підняти ${escapeAttr(campaign.name || "цю кампанію")} вище в порядку"><i data-lucide="chevron-up"></i></button>
    ${rankLabel}
    <button class="text-button" type="button" data-warmup-campaign-move="down" ${index < 0 || index >= warmupState.campaigns.length - 1 ? "disabled" : ""} title="Пропонувати цій кампанії квоту її акаунтів пізніше" aria-label="Опустити ${escapeAttr(campaign.name || "цю кампанію")} нижче в порядку"><i data-lucide="chevron-down"></i></button>
  </span>`);
  if (campaign.state === "running") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="paused" title="Припинити закріплення з цієї кампанії"><i data-lucide="pause"></i><span>Пауза</span></button>`);
  } else if (campaign.state !== "done") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="running" title="Дозволити її акаунтам закріплювати людей із цієї кампанії"><i data-lucide="play"></i><span>Старт</span></button>`);
  }
  if (campaign.state !== "done") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="done" title="З неї більше нічого не закріплюється"><i data-lucide="check"></i><span>Завершити</span></button>`);
  } else {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="running" title="Знову дозволити її акаунтам закріплювати з неї"><i data-lucide="rotate-ccw"></i><span>Відкрити знову</span></button>`);
  }
  controls.push(`<button class="text-button" type="button" data-warmup-campaign-edit><i data-lucide="pencil"></i><span>Редагувати</span></button>`);
  controls.push(`<button class="text-button warmup-campaign-delete" type="button" data-warmup-campaign-delete><i data-lucide="trash-2"></i><span>Видалити</span></button>`);

  const count = remaining === null
    ? `<span class="warmup-campaign-count-unknown">${warmupCount(sent)} надіслано · скільки лишилось, порахувати не вдалося</span>`
    : `<strong>${warmupCount(sent)}</strong><span>надіслано з ${warmupCount(remaining)}, що лишились</span>`;

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
        ${queued ? `<span class="warmup-campaign-claimed">${warmupCount(queued)} закріплено й не надіслано</span>` : ""}
        ${campaign.progressApproximate
          ? '<span class="warmup-campaign-approx" title="Інша кампанія ділить із цією акаунт і цю папку, тож її рядки рахуються тут теж. Щоб їх розрізнити, потрібна колонка, якої в wl_outreach немає.">рахується разом зі спільним акаунтом</span>'
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
  const note = WARMUP_CAMPAIGN_STATE_NOTE[campaign.state] || "";

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
      pill.className = "pill tone-muted";
      pill.textContent = warmupState.campaignsError ? "недоступно" : "завантаження";
    } else {
      const running = warmupState.campaigns.filter((campaign) => campaign.state === "running").length;
      pill.className = running ? "pill tone-live" : "pill tone-muted";
      pill.textContent = warmupState.campaigns.length
        ? `${warmupState.campaigns.length} ${uaPlural(warmupState.campaigns.length, "кампанія", "кампанії", "кампаній")} · ${running} ${uaPlural(running, "працює", "працюють", "працюють")}`
        : "поки жодної";
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
    : (connections.startsDay ? `запити з ${connections.startsDay}-го дня` : "сьогодні квоти на запити немає");
  const meta = [day, quotaLine].filter(Boolean).join(" · ");

  let body;
  if (!queue) {
    body = '<div class="empty-state">Завантажуємо...</div>';
  } else if (queue.unavailable) {
    body = `<p class="warmup-queue-reason is-muted">${escapeHtml(queue.unavailable)}</p>`;
  } else if (queue.error) {
    body = `<p class="warmup-queue-reason is-bad">${escapeHtml(queue.error)}</p>`;
  } else if (queue.rows?.length) {
    body = `<ul class="warmup-leads warmup-queue-list">${queue.rows.map((row) => warmupQueueRowHtml(row, accountId, campaignId)).join("")}</ul>`;
  } else if (queue.reason) {
    // The server's sentence, verbatim. "Day 2 of 14 — connection requests start
    // on day 4" is the answer; an empty box is not.
    body = `<p class="warmup-queue-reason">${escapeHtml(queue.reason)}</p>`;
  } else {
    body = '<p class="warmup-queue-reason is-muted">За цим акаунтом нічого не закріплено, і сервер не сказав чому.</p>';
  }

  const released = Number(queue?.released) || 0;
  const releasedNote = released
    ? `<p class="warmup-queue-released">${warmupCount(released)} ${uaPlural(released, "закріплення протухло, і його відпущено", "закріплення протухли, і їх відпущено", "закріплень протухло, і їх відпущено")} — ці люди знову в пулі.</p>`
    : "";

  return `<article class="warmup-queue-account" data-warmup-queue-account="${escapeAttr(accountId)}">
    <header>
      <div class="warmup-queue-who">
        <strong>${escapeHtml(profile?.name || "Акаунт, якого цей список не показує")}</strong>
        ${identity?.name ? `<span class="warmup-identity"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}</span></span>` : ""}
        ${meta ? `<span class="warmup-subtle">${escapeHtml(meta)}</span>` : ""}
      </div>
      <button class="text-button" type="button" data-warmup-claim="${escapeAttr(accountId)}" ${busy ? "disabled" : ""}>
        <i data-lucide="hand"></i><span>${busy ? "Закріплюємо..." : "Закріпити зараз"}</span>
      </button>
    </header>
    ${releasedNote}
    ${body}
  </article>`;
}

function renderWarmupQueue() {
  const title = document.getElementById("warmupQueueTitle");
  const subtitle = document.getElementById("warmupQueueSubtitle");
  const body = document.getElementById("warmupQueueBody");
  if (!title || !subtitle || !body) return;

  const campaign = warmupSelectedCampaign();
  title.textContent = campaign ? `Черга · ${campaign.name || "Кампанія без назви"}` : "Черга";

  if (!campaign) {
    subtitle.textContent = "Кампанію не вибрано";
    body.innerHTML = '<div class="empty-state">Обери кампанію вгорі, щоб побачити, що тримають її акаунти.</div>';
    return;
  }

  const accountIds = campaign.accountIds || [];
  if (!accountIds.length) {
    subtitle.textContent = "Цю кампанію поки ніхто не веде";
    body.innerHTML = `<div class="warmup-leads-prompt"><strong>До цієї кампанії не позначено жодного акаунта.</strong>
      <span>Познач акаунт нижче, у Профілях, — акаунт може закріплювати людей лише з тієї кампанії, яку веде.</span></div>`;
    refreshIcons();
    return;
  }

  // A queue is an account's, so what is counted here is everything these
  // accounts hold — this campaign's claims and any other campaign's.
  const claimed = accountIds.reduce((total, id) => total + (warmupQueueState(id)?.rows?.length || 0), 0);
  const held = `${warmupCount(claimed)} на руках у ${accountIds.length} ${uaPlural(accountIds.length, "акаунта", "акаунтів", "акаунтів")}`;
  subtitle.textContent = campaign.state === "running"
    ? `${held} · закріплення тримає людину, воно нічого не надсилає`
    : `Ця кампанія — ${WARMUP_CAMPAIGN_STATE_LABEL[campaign.state] || campaign.state}, тож нічого нового з неї не закріплюється. ${held}.`;

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
    ? `${warmupCount(warmupState.leadsTotal)} ${uaPlural(warmupState.leadsTotal, "підпадає", "підпадають", "підпадають")} під цю папку й фільтри · показані наступні ${warmupState.leads.length}, без тих, до кого вже зверталися з будь-якого акаунта`
    : "Наступні люди з цієї папки, без тих, до кого вже зверталися з будь-якого акаунта";

  if (!warmupState.leads.length) {
    body.innerHTML = '<div class="empty-state">Під цими фільтрами в цій папці більше нікого немає.</div>';
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
    title.textContent = "Профіль не вибрано";
    subtitle.textContent = "Обери профіль, щоб побачити його день, сьогоднішню квоту і його власний лог";
    body.innerHTML = '<div class="empty-state">Вибери профіль зі списку.</div>';
    refreshIcons();
    return;
  }

  const account = detail.account;
  const warmup = account.warmup;
  title.textContent = account.label;
  subtitle.textContent = warmup
    ? `${warmup.strategyName} · день ${warmup.day} з ${warmup.totalDays}${warmup.phase ? ` · ${warmup.phase}` : ""}`
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
    controls.push('<button class="primary-button" type="button" data-warmup-control="resume">Продовжити</button>');
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
    ${warmup?.pausedUntil ? `<p class="warmup-paused">На паузі після попередження до ${escapeHtml(warmup.pausedUntil)}.</p>` : ""}
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
  warmupState.formOpen = true;
  warmupState.formCampaignId = campaignId;
  warmupState.campaignNotice = "";
  if (campaignId) warmupState.selectedCampaignId = campaignId;
  renderWarmupCampaigns({ resetForm: true });
  renderWarmupProfiles();
  renderWarmupQueue();
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
      productId: form.productId || null
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
  try {
    const payload = await warmupApi(`/queue?accountId=${encodeURIComponent(accountId)}`);
    warmupState.queues[accountId] = {
      rows: payload.queue || payload.claimed || [],
      reason: payload.reason || "",
      error: "",
      unavailable: ""
    };
  } catch (error) {
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
    warmupState.queues[accountId] = {
      rows: warmupState.queues[accountId]?.rows || [],
      reason: "",
      error: error.status === 404
        ? "Цей сервер ще не вміє закріплювати."
        : error.message,
      unavailable: ""
    };
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
      // Nothing can have arrived on accounts this server cannot even reach, and
      // the config note above already says why. An inbox promising otherwise
      // would be a second, softer answer to the same question.
      warmupState.inbox.available = false;
      renderWarmupProfiles();
      renderWarmupStats();
      renderWarmupInbox();
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

for (const id of ["warmupFilterCountry", "warmupFilterPosition", "warmupFilterStatus", "warmupFilterOwner"]) {
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
  return escapeHtml(clipped);
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
    <strong>${warmupCount(missing)} ${uaPlural(missing, "акаунт із", "акаунти із", "акаунтів із")} ${warmupCount(sync.accountsTotal)} не читали жодного разу.</strong>
    <span>Те, що надійшло ${missing === 1 ? "на нього" : "на них"}, не показане нижче і не враховане — цей список повний рівно настільки, наскільки агент справді відкривав акаунти.</span>
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
      <strong>Відповідей немає — і цей сервер не каже, коли акаунти читали востаннє.</strong>
      <span>Тому тут не відрізнити порожні вхідні від агента, який жодного разу не заглядав, а це не те саме: у першому випадку просто тихий тиждень, у другому — кожна відповідь на кожному акаунті лишається непоміченою. Розрізняє їх саме час останнього читання.</span>
    </div>`;
  }

  if (!sync.lastSyncedAt) {
    return `<div class="warmup-inbox-note is-bad">
      <strong>Жодного акаунта ще не читали. Це не порожні вхідні — це агент, який жодного разу не заглядав.</strong>
      <span>Наприкінці кожного прогону агент прогріву відкриває повідомлення LinkedIn і складає знайдене сюди. Сюди не склали ще нічого, тож відповідь на будь-якому з цих акаунтів не бачить ніхто, крім того, хто відкриє акаунт руками. Перевір, що агент працює, дивиться саме на цей портал і що його токен заданий з обох боків.</span>
    </div>`;
  }

  if (sync.stale) {
    return `<div class="warmup-inbox-note is-warn">
      <strong>Нічого не надходило, а востаннє сюди заглядали ${escapeHtml(warmupAgo(sync.lastSyncedAt))}.</strong>
      <span>Останнє читання — ${escapeHtml(warmupStamp(sync.lastSyncedAt))}. Агент читає акаунти наприкінці кожного прогону, тож така пауза — це радше зупинений агент, ніж тихий тиждень: вхідні, яких ніхто не читає, виглядають точно так само, як вхідні, куди ніхто не написав.</span>
    </div>`;
  }

  const coverage = sync.accountsTotal !== null && sync.accountsSynced !== null
    ? ` Прочитано всі ${warmupCount(sync.accountsSynced)} із ${warmupCount(sync.accountsTotal)} ${uaPlural(sync.accountsTotal, "акаунта", "акаунтів", "акаунтів")}.`
    : "";

  return `<div class="warmup-inbox-note is-calm">
    <strong>Нічого не надходило.</strong>
    <span>Акаунти востаннє читали ${escapeHtml(warmupAgo(sync.lastSyncedAt))}, і відтоді ніхто не написав у відповідь.${escapeHtml(coverage)} Це порожні вхідні, а не непрочитані.</span>
  </div>`;
}

function warmupThreadRowHtml(thread) {
  const participant = thread.participant || {};
  const name = warmupParticipantName(participant);
  const account = warmupThreadAccount(thread);
  const last = thread.lastMessage || {};
  const inbound = last.direction !== "out";
  const count = Number(thread.messageCount) || 0;
  const status = String(thread.outreachStatus || "").trim();
  const accountTitle = account.exact
    ? "Особа, під якою залогінений цей акаунт"
    : "Назва профілю в Anty — цей портал не знає, під ким залогінений цей акаунт";

  return `
    <button class="warmup-thread ${thread.unread ? "is-unread" : ""}" type="button"
      data-warmup-thread="${escapeAttr(thread.threadKey || "")}"
      data-warmup-thread-account="${escapeAttr(thread.accountId || "")}">
      <span class="warmup-thread-mark" aria-hidden="true"></span>
      <span class="warmup-thread-who">
        <strong${warmupParticipantNameAttr(participant)}>${escapeHtml(name)}</strong>
        ${participant.headline ? `<span class="warmup-subtle">${escapeHtml(participant.headline)}</span>` : ""}
        <span class="warmup-identity" title="${escapeAttr(accountTitle)}">
          <i data-lucide="${account.exact ? "badge-check" : "circle-help"}"></i>
          <span>на ${escapeHtml(account.name)}</span>
        </span>
      </span>
      <span class="warmup-thread-preview">
        <span class="warmup-thread-from">${inbound ? "Вони" : "Ти"}:</span>
        ${warmupPreviewHtml(last.body)}
      </span>
      <span class="warmup-thread-meta">
        <time datetime="${escapeAttr(last.sentAt || "")}" title="${escapeAttr(warmupStamp(last.sentAt))}">${escapeHtml(warmupAgo(last.sentAt) || "—")}</time>
        <span class="warmup-subtle">${warmupCount(count)} ${uaPlural(count, "повідомлення", "повідомлення", "повідомлень")}</span>
        ${status ? `<span class="pill ${WARMUP_OUTREACH_TONE[status] || "tone-muted"}">${escapeHtml(WARMUP_OUTREACH_LABEL[status] || status)}</span>` : ""}
        ${thread.unread ? '<span class="warmup-thread-unread">непрочитане</span>' : ""}
      </span>
    </button>`;
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
    ? `акаунти востаннє читали ${warmupAgo(sync.lastSyncedAt)}`
    : (sync.known ? "жодного акаунта ще не читали" : "цей сервер не каже, коли акаунти читали востаннє");

  if (!inbox.threads.length) {
    subtitle.textContent = inbox.unreadOnly ? "Тільки непрочитані" : read;
    body.innerHTML = warmupInboxEmptyHtml();
    refreshIcons();
    return;
  }

  subtitle.textContent = `${warmupCount(inbox.threads.length)} ${uaPlural(inbox.threads.length, "розмова", "розмови", "розмов")}${inbox.unreadOnly ? " непрочитаних" : ""} · ${read}`;

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
    <div class="warmup-threads">${shown.map((thread) => warmupThreadRowHtml(thread)).join("")}</div>
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
    inbox.unread = Number.isFinite(payload.unread) ? payload.unread : 0;
    inbox.sync = payload.sync && typeof payload.sync === "object" ? payload.sync : null;
    inbox.available = true;
    inbox.ready = true;
    inbox.error = "";
    setWarmupUnread(inbox.unread);
  } catch (error) {
    inbox.threads = [];
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
