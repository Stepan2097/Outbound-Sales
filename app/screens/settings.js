// Налаштування — who is in the workspace, and your own password. Every control
// here does something, and says what:
//
//   · роль біля людини (лише адмін)   → /api/account/role: хто керує користувачами тут;
//   · кошик біля людини (лише адмін)  → /api/account/users/remove: людина більше не входить;
//   · «Створити новий акаунт» (адмін) → /api/account/users: для того, кого ще нема в CRM;
//   · «Свій пароль»                   → /api/account/password: вхід самого себе.
//   · «Нові, коли є розмови» (адмін)  → /api/today/new-contact-policy: скільки нових
//     контактів лідген бере з конвеєра, поки в нього є відповіді чи прострочені пінги.
//
// Не тут і більше: вибір моделі, діаграми витрат і часу. У застосунку не лишилось
// нічого, що кликало б модель, тож вибирати було нічого, а витрати стояли б на
// нулі. Дані про активність сервер збирає далі; екрана для них нема.

import {
  api, authState, escapeAttr, escapeHtml, onScreen, refreshIcons, relativeTime, render, renderTopbar, setAuthState, setHtml, setText, setUiNotice, uaPlural
} from "../core.js";
import { recallScreen, rememberScreen } from "../cache.js";

onScreen("account", { open: () => void loadSettingsScreen(), render: () => renderAccount() });

/**
 * База користувачів одна — та, що в CRM.
 *
 * Цей застосунок нікого не запрошує: хто є в CRM і підтверджений там, той
 * входить своїм акаунтом CRM. Єдине, що ставиться в цьому списку, — роль у цьому
 * застосунку; кого пускати, відповідає CRM.
 */
const ROLE_LABEL = { admin: "Адміністратор", seller: "Продавець" };

/**
 * Нові контакти, коли є живі розмови (Марко 19.10: «можемо лише додати десь в
 * налаштуваннях опцію вручну для Богдана або іншого лідгена зняти обмеження, або
 * дозволити обмежену кількість»). Без запису — як завжди: спершу розмови.
 */
const POLICY_LABEL = { gate: "Ні — спершу розмови", limit: "До N на день", open: "Без обмеження" };
let contactPolicies = {};

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

/**
 * Хто ти і чим можеш керувати. Ім'я, пошта й роль уже є в сесії, тож окремого
 * запиту за «карткою» немає; команду бачить і править лише адміністратор —
 * продавцю в цьому списку нічого не належить.
 */
export function renderAccount() {
  const user = authState?.user;
  if (!user) return;
  // Пошта показується один раз: як заголовок, коли імені немає, і як підпис,
  // коли ім'я є.
  const displayName = personDisplayName(user.name, user.email);
  setText("profileName", displayName || user.email || "Профіль");
  const emailLine = document.getElementById("profileEmail");
  emailLine.textContent = displayName ? user.email || "" : "";
  emailLine.hidden = !emailLine.textContent;
  setText("accountRolePill", ROLE_LABEL[user.role] || user.role || "seller");
  document.getElementById("teamPanel").hidden = user.role !== "admin";
}

function teamRowHtml(person, selfEmail) {
  const self = person.email === selfEmail;
  const name = personDisplayName(person.name, person.email);
  const facts = [
    person.blocked,
    (person.aliases || []).length ? `та сама пошта, що ${person.aliases.join(", ")}` : "",
    person.crmRole ? `у CRM ${person.crmRole}` : "",
    person.signedInHere ? "" : "тут ще не заходив",
    // Остання робота — у CRM чи тут (23.10): вхід паролем буває раз на тиждень, робота — щодня.
    person.lastActiveAt ? `активність ${relativeTime(person.lastActiveAt)}` : person.lastSignInAt ? `вхід ${relativeTime(person.lastSignInAt)}` : "жодного входу"
  ].filter(Boolean).join(" · ");
  const options = ["admin", "seller"].map((value) =>
    `<option value="${value}"${value === person.role ? " selected" : ""}>${ROLE_LABEL[value]}</option>`
  ).join("");
  return `<article class="team-row${person.blocked ? " team-row-outside" : ""}">
    <div class="team-who">
      <strong>${escapeHtml(name || person.email)}${self ? " · це ти" : ""}</strong>
      ${name ? `<span>${escapeHtml(person.email)}</span>` : ""}
      ${facts ? `<span>${escapeHtml(facts)}</span>` : ""}
    </div>
    ${policyHtml(person.email)}
    <select class="team-access" data-email="${escapeAttr(person.email)}"${self ? " disabled title=\"Свою роль змінює інший адміністратор\"" : ""}>${options}</select>
    ${self
      ? ""
      : `<button class="icon-button danger-button" type="button" data-remove-user="${escapeAttr(person.id || "")}" data-remove-email="${escapeAttr(person.email)}" title="Прибрати акаунт назовсім" aria-label="Прибрати акаунт ${escapeAttr(person.email)}"><i data-lucide="trash-2"></i></button>`}
  </article>`;
}

function policyHtml(email) {
  const key = String(email || "").toLowerCase();
  const rule = contactPolicies[key] || { mode: "gate" };
  return `<label class="team-policy" title="Нові контакти з конвеєра (Workspace → «Нові»), поки в людини є відповіді чи прострочені пінги">
    <span>Нові, коли є розмови</span>
    <span class="team-policy-row">
      <select data-policy-email="${escapeAttr(key)}">${Object.entries(POLICY_LABEL).map(([mode, label]) => `<option value="${mode}"${mode === rule.mode ? " selected" : ""}>${label}</option>`).join("")}</select>
      ${rule.mode === "limit" ? `<input type="number" min="1" max="100" step="1" value="${escapeAttr(rule.limit || 5)}" data-policy-limit="${escapeAttr(key)}" aria-label="Скільки нових на день">` : ""}
    </span>
  </label>`;
}

/** Зберегти й сказати, що тепер діє; рядок пишеться після перечитування списку, бо воно пише туди підсумок. */
async function savePolicy(email, mode, limit) {
  let note;
  try {
    const result = await api("/api/today/new-contact-policy", { method: "POST", body: JSON.stringify({ email, mode, limit }) });
    contactPolicies = result.policies || {};
    const rule = contactPolicies[email];
    note = `${email}: ${rule ? (rule.mode === "limit" ? `до ${rule.limit} нових на день, навіть коли є розмови` : "нові контакти без обмеження") : "нові контакти — лише коли розмови розібрано"}.`;
  } catch (error) {
    note = error.message || "Не вдалося зберегти.";
  }
  await loadTeamDirectory();
  setText("teamUserNote", note);
}

/**
 * Адміністратор бачить усю базу CRM. Усі, одним списком: ті, кого CRM не пускає,
 * стоять у кінці й підписані чому, але вони тут — список користувачів, який
 * когось не показує, змушує шукати зниклих деінде.
 */
function renderTeamDirectory(directory, selfEmail) {
  setHtml("teamUserList", directory.people.map((person) => teamRowHtml(person, selfEmail)).join(""));
  const total = directory.people.length;
  const blocked = total - directory.canSignIn;
  setText("teamUserNote", [
    `${total} ${uaPlural(total, "користувач", "користувачі", "користувачів")}`,
    blocked ? `${directory.canSignIn} ${uaPlural(directory.canSignIn, "може", "можуть", "можуть")} увійти, решту тримає CRM` : "усі можуть увійти",
    directory.adminApi ? "" : "список із бази CRM: акаунтів Supabase без профілю в CRM тут не видно (потрібен сервісний ключ)"
  ].filter(Boolean).join(" · "));
  refreshIcons();
}

async function loadTeamDirectory() {
  const user = authState?.user;
  if (!user || user.role !== "admin") return;
  const selfEmail = String(user.email || "").toLowerCase();
  // Останній список цієї вкладки — одразу, поки CRM відповідає (`app/cache.js`).
  const remembered = recallScreen("team")?.value;
  if (remembered?.people && remembered.selfEmail === selfEmail) renderTeamDirectory(remembered, selfEmail);
  try {
    const [directory, policy] = await Promise.all([
      api("/api/account/directory"),
      api("/api/today/new-contact-policy").catch(() => ({ policies: {} }))
    ]);
    contactPolicies = policy.policies || {};
    renderTeamDirectory(directory, selfEmail);
    rememberScreen("team", { ...directory, selfEmail });
  } catch (error) {
    // Список приходить із Supabase; без нього тут було б порожньо, і про це
    // сказано, а не промовчано.
    setHtml("teamUserList", "");
    setText("teamUserNote", `Список команди зараз недоступний: ${error.message}`);
  }
  refreshIcons();
}

export async function loadSettingsScreen() {
  renderAccount();
  await loadTeamDirectory();
}

document.getElementById("teamUserList")?.addEventListener("click", (event) => {
  // Єдина незворотна кнопка в цьому списку, тож вона питає — і питає адресою,
  // а не «ви впевнені?»: підтверджувати треба те, що саме зникне.
  const remove = event.target.closest("[data-remove-user]");
  if (!remove) return;
  const email = remove.dataset.removeEmail || "цей акаунт";
  if (!window.confirm(`Прибрати акаунт ${email} назовсім? Це не відкотити.`)) return;
  void removeTeamUser(remove);
});

async function removeTeamUser(button) {
  button.disabled = true;
  try {
    const result = await api("/api/account/users/remove", {
      method: "POST",
      body: JSON.stringify({ userId: button.dataset.removeUser, email: button.dataset.removeEmail })
    });
    await loadTeamDirectory();
    // Рядок у CRM цей застосунок не чіпає: то чужа система обліку. Якщо він
    // лишився — про це сказано прямо, бо піввидалення, про яке мовчать, потім
    // виглядає як «воно не спрацювало». Нотатка пишеться після перечитування
    // списку, бо перечитування пише в той самий рядок свій підсумок.
    setText("teamUserNote", result.crmProfileRemains
      ? `Акаунт ${result.email || ""} прибрано. Рядок у CRM лишився — прибери його там, якщо він більше не потрібен.`
      : `Акаунт ${result.email || ""} прибрано.`);
  } catch (error) {
    setText("teamUserNote", error.message || "Не вдалося прибрати акаунт.");
    button.disabled = false;
  }
  refreshIcons();
}

document.getElementById("teamUserList")?.addEventListener("change", async (event) => {
  const policy = event.target.closest("[data-policy-email]");
  const limit = event.target.closest("[data-policy-limit]");
  const email = policy?.dataset?.policyEmail || limit?.dataset?.policyLimit;
  if (email) {
    const mode = policy?.dataset?.policyEmail ? policy.value : "limit";
    const value = limit?.dataset?.policyLimit ? Number(limit.value) : Number(contactPolicies[email]?.limit) || 5;
    return void savePolicy(email, mode, value);
  }
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
  // Форма береться до першого await: після нього currentTarget уже null, і
  // форма, що щойно змінила пароль, падала на reset() замість того, щоб сказати
  // «Пароль змінено».
  const form = event.currentTarget;
  const password = document.getElementById("accountPasswordInput").value;
  if (password !== document.getElementById("accountPasswordConfirmInput").value) {
    setUiNotice("Паролі не збігаються.");
    renderTopbar();
    return;
  }
  try {
    await api("/api/account/password", { method: "POST", body: JSON.stringify({ password }) });
    form.reset();
    setUiNotice("Пароль змінено.");
  } catch (error) {
    setUiNotice(error.message || "Не вдалося змінити пароль.");
  }
  renderTopbar();
});

document.getElementById("teamUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  // Те саме, що з паролем: форма береться до await.
  const form = event.currentTarget;
  try {
    const result = await api("/api/account/users", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("teamUserNameInput").value,
        email: document.getElementById("teamUserEmailInput").value,
        password: document.getElementById("teamUserPasswordInput").value,
        role: document.getElementById("teamUserRoleInput").value
      })
    });
    form.reset();
    setAuthState(await api("/api/auth/status"));
    setUiNotice(result.existingAccount
      ? "Наявний робочий акаунт додано. Продавець заходить своїм поточним паролем або відновлює його."
      : "Акаунт продавця створено.");
    render();
    // Новий користувач має з'явитися в списку одразу, а не після повернення на екран.
    await loadTeamDirectory();
  } catch (error) {
    setUiNotice(error.message || "Не вдалося створити акаунт.");
    renderTopbar();
  }
});
