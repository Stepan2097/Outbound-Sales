// Налаштування — the people in the workspace, your own card and password.

import {
  api, authState, escapeAttr, escapeHtml, onScreen, refreshIcons, relativeTime, render, renderTopbar, setAuthState, setHtml, setText, setUiNotice, signOut, uaPlural, uiNotice
} from "../core.js";

onScreen("account", { open: () => loadProfileScreen(), render: () => renderAccount() });

// Вкладка «Користувачі» живе нижче по файлу, а `await bootApplication()` ділить
// модуль надвоє: усе, оголошене після нього, під час завантаження ще в TDZ.
// Тому ці змінні стоять тут — інакше перезавантаження на цій вкладці валить
// увесь застосунок, а не лише її.
let profileData = null;

// Чию картку зараз відкрито. Порожньо — свою власну.
let profileUserId = "";

let teamDirectory = null;

export function renderAccount() {
  const user = authState?.user;
  if (!user) return;
  document.getElementById("teamCreatePanel").hidden = user.role !== "admin";
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

document.getElementById("accountPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("accountPasswordInput").value;
  if (password !== document.getElementById("accountPasswordConfirmInput").value) {
    setUiNotice("Паролі не збігаються.");
    renderTopbar();
    return;
  }
  await api("/api/account/password", { method: "POST", body: JSON.stringify({ password }) });
  event.currentTarget.reset();
  setUiNotice("Пароль змінено.");
  renderTopbar();
});

document.getElementById("teamUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("/api/account/users", { method: "POST", body: JSON.stringify({ name: document.getElementById("teamUserNameInput").value, email: document.getElementById("teamUserEmailInput").value, password: document.getElementById("teamUserPasswordInput").value, role: document.getElementById("teamUserRoleInput").value }) });
  event.currentTarget.reset();
  setAuthState(await api("/api/auth/status"));
  setUiNotice(result.existingAccount
    ? "Наявний робочий акаунт додано. Продавець заходить своїм поточним паролем або відновлює його."
    : "Акаунт продавця створено.");
  render();
});

document.getElementById("logoutBtn").addEventListener("click", signOut);

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

export async function loadProfileScreen() {
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
