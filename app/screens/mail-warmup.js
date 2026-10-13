// Прогрів пошт — наші пошти Workspace пишуть одна одній (esp/mail-warmup.mjs):
// живі листи за розкладом, частина — з відповіддю в тому ж треді, лист зі спаму
// виймається у вхідні й позначається важливим, обсяг росте з днями. Тут —
// таблиця пошт зі «Старт» і «Пауза», що зараз заважає (банер), і журнал.
// Листи прогріву не потрапляють у кампанії, звіти й «Вхідні».

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural } from "../core.js";

const STATUS = {
  running: ["іде", "tone-live"], paused: ["на паузі", "tone-warn"], never: ["не запущено", "tone-muted"], blocked: ["не можна", "tone-bad"]
};
const DOMAIN_WORD = { aging: "старіє", ramp: "рампа", active: "активний", reserve: "запас", paused: "на паузі", retired: "виведено" };

export const mailWarmupState = { data: null, error: "", notice: "", busy: "" };

onScreen("mail-warmup", { open: () => void loadMailWarmup() });

export async function loadMailWarmup() {
  if (!document.getElementById("mailWarmupRoot")) return;
  try {
    mailWarmupState.data = await api("/api/esp/warmup");
    mailWarmupState.error = "";
  } catch (error) {
    mailWarmupState.error = error?.status === 403 ? "Прогрів бачить команда з правом читати відповіді — його дає адміністратор." : error?.message || "Прогрів не прочитався.";
  }
  renderMailWarmup();
}

const when = (value) => (value ? new Date(value).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }) : "");
const number = (value) => Number(value || 0).toLocaleString("uk-UA");

function bannerHtml(data) {
  const lines = [];
  if (data.halted) lines.push("Натиснуто «Стоп усе» — прогрів стоїть разом з усією відправкою.");
  if (data.mode.text) lines.push(data.mode.text);
  if (data.rescueRefused) lines.push(`Google не дає змінювати мітки (${when(data.rescueRefused)}): листи прогріву йдуть і отримують відповіді, але зі спаму не виймаються. Власнику — додати scope gmail.modify у делегуванні домену (ESP_GMAIL_SETUP.md, крок 2).`);
  return lines.map((line) => `<div class="mail-banner" role="status"><i data-lucide="circle-alert"></i><p>${escapeHtml(line)}</p></div>`).join("");
}

function summaryHtml(rows) {
  const running = rows.filter((row) => row.status === "running");
  const sum = (key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
  const cards = [
    ["mail-plus", "Гріються", `${running.length} з ${rows.length}`, "пошт"],
    ["send", "Сьогодні листів", `${number(sum("firstsToday"))} / ${number(running.reduce((total, row) => total + row.plannedToday, 0))}`, `і ${number(sum("repliesToday"))} ${uaPlural(sum("repliesToday"), "відповідь", "відповіді", "відповідей")}`],
    ["reply", "Відповідей отримано", number(sum("repliesReceived")), "за весь прогрів"],
    ["shield-check", "Вийнято зі спаму", number(sum("rescued")), `${number(sum("landedInSpam"))} ${uaPlural(sum("landedInSpam"), "лист потрапив", "листи потрапили", "листів потрапило")} у спам`]
  ];
  return `<div class="warmup-mail-cards">${cards.map(([icon, label, value, note]) => `
    <article class="warmup-mail-card"><span class="warmup-mail-icon"><i data-lucide="${icon}"></i></span><div><span>${label}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div></article>`).join("")}</div>`;
}

const ROLE_WORD = { cold: "Розсилка", warmup: "Прогрів" };

/** «Розсилка» or «Прогрів»: a select for whoever may change it, a label for the rest. */
function roleHtml(row, canChange) {
  if (!canChange) return row.role ? `<span class="warmup-mail-role is-${row.role}">${ROLE_WORD[row.role]}</span>` : '<span class="esp-subtle">—</span>';
  return `<select class="warmup-mail-role-select is-${row.role || "none"}" data-warmup-role="${escapeAttr(row.email)}" aria-label="Призначення ${escapeAttr(row.email)}"${mailWarmupState.busy ? " disabled" : ""}>
    <option value=""${row.role ? "" : " selected"}>не вказано</option>
    <option value="cold"${row.role === "cold" ? " selected" : ""}>Розсилка</option>
    <option value="warmup"${row.role === "warmup" ? " selected" : ""}>Прогрів</option>
  </select>`;
}

function tableHtml(data) {
  const { rows, canChange } = data;
  if (!rows.length) return `<div class="empty-state">У прогріві немає пошт — додайте їх у «Пошта» → «Пошти» → «Додати пошту».</div>${removedHtml(data)}`;
  const action = (row) => {
    if (!canChange) return "";
    if (row.status === "running") return `<button type="button" class="text-button" data-warmup-pause="${escapeAttr(row.email)}"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="pause"></i><span>Пауза</span></button>`;
    if (row.status === "blocked") return `<span class="esp-subtle" title="${escapeAttr(row.blocked)}">${escapeHtml(row.blocked)}</span>`;
    return `<button type="button" class="primary-button" data-warmup-start="${escapeAttr(row.email)}"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="play"></i><span>Старт</span></button>`;
  };
  return `
    <div class="table-wrap"><table class="warmup-mail-table">
      <thead><tr><th>Пошта</th><th>Призначення</th><th>Статус</th><th>День</th><th>Листів сьогодні</th><th>Відповідей</th><th>Вийнято зі спаму</th><th>Ліміт дня</th><th></th></tr></thead>
      <tbody>${rows.map((row) => {
        const [word, tone] = STATUS[row.status];
        const share = row.plannedToday ? Math.min(100, Math.round((row.firstsToday / row.plannedToday) * 100)) : 0;
        return `<tr>
          <td><strong>${escapeHtml(row.email)}</strong><small>${escapeHtml(row.person || "")}${row.person ? " · " : ""}домен: ${escapeHtml(DOMAIN_WORD[row.domainStatus] || row.domainStatus || "—")}</small></td>
          <td>${roleHtml(row, canChange)}</td>
          <td><span class="pill ${tone}">${word}</span>${row.status === "paused" && row.pausedAt ? `<small>з ${escapeHtml(when(row.pausedAt))}</small>` : row.status === "running" && row.startedAt ? `<small>старт ${escapeHtml(when(row.startedAt))}</small>` : ""}</td>
          <td class="is-number">${row.day || "—"}</td>
          <td class="is-number">${row.status === "running" ? `<div class="warmup-mail-progress"><span style="width:${share}%"></span></div>` : ""}${row.firstsToday} / ${row.plannedToday}${row.repliesToday ? `<small>+ ${row.repliesToday} ${uaPlural(row.repliesToday, "відповідь", "відповіді", "відповідей")}</small>` : ""}${row.planOfDay > row.plannedToday && row.status === "running" ? `<small title="Холодні листи сьогодні: ${row.coldToday}">план ${row.planOfDay}, ліміт урізав</small>` : ""}</td>
          <td class="is-number">${row.repliesReceived}<small>сама відповіла: ${row.repliesSent}</small></td>
          <td class="is-number">${row.rescued}<small>її листів у спамі: ${row.landedInSpam}</small></td>
          <td class="is-number">${row.limit}<small>холодних сьогодні: ${row.coldToday}</small></td>
          <td class="warmup-mail-action">${action(row)}${canChange ? `<button type="button" class="icon-button warmup-mail-remove" data-warmup-remove="${escapeAttr(row.email)}" title="Прибрати з прогріву" aria-label="Прибрати ${escapeAttr(row.email)} з прогріву"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="trash-2"></i></button>` : ""}${row.lastError && row.status === "running" ? `<small class="is-bad" title="${escapeAttr(row.lastError.error)}">остання відмова ${escapeHtml(when(row.lastError.at))}</small>` : ""}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    ${removedHtml(data)}`;
}

/** Mailboxes taken off the warm-up: listed small under the table, each with «Повернути». */
function removedHtml(data) {
  const removed = data.removed || [];
  if (!removed.length) return "";
  return `<div class="warmup-mail-removed"><span>Прибрані з прогріву:</span>${removed.map((email) => `<span class="warmup-mail-removed-item">${escapeHtml(email)}${data.canChange ? `<button type="button" class="text-button" data-warmup-restore="${escapeAttr(email)}"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="undo-2"></i><span>Повернути</span></button>` : ""}</span>`).join("")}</div>`;
}

function planHtml(data) {
  const { plan, planBounds: bounds, canChange } = data;
  const field = (name, label, suffix) => `<label>${label}<input type="number" name="${name}" min="${bounds[name][0]}" max="${bounds[name][1]}" step="1" value="${plan[name]}" required${canChange ? "" : " disabled"} />${suffix}</label>`;
  return `<form class="warmup-mail-plan" id="mailWarmupPlan">
    <strong>План прогріву</strong>
    ${field("start", "Перший день", "листів")}
    ${field("step", "Щодня більше на", "")}
    ${field("max", "До", "на день")}
    ${canChange ? `<button type="submit" class="text-button"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="save"></i><span>Зберегти</span></button>` : ""}
    <small>${plan.savedAt ? `змінено ${escapeHtml(when(plan.savedAt))}${plan.by ? ` · ${escapeHtml(plan.by)}` : ""}` : "за замовчуванням"} · для свіжого домену — менший старт і приріст. Діє на всі пошти з наступного проходу; ліміт дня пошти (ESP 4) однаково головніший.</small>
  </form>`;
}

function logHtml(log) {
  if (!log.length) return '<p class="esp-subtle">Прогрів ще нічого не робив.</p>';
  return `<ol class="warmup-mail-log">${log.map((row) => `<li><time>${escapeHtml(when(row.at))}</time><span>${escapeHtml(row.text)}</span>${row.actor && !row.actor.startsWith("esp-") ? `<small>${escapeHtml(row.actor)}</small>` : ""}</li>`).join("")}</ol>`;
}

export function renderMailWarmup() {
  const root = document.getElementById("mailWarmupRoot");
  if (!root) return;
  const { data, error, notice } = mailWarmupState;
  if (error && !data) { root.innerHTML = `<div class="empty-state">${escapeHtml(error)}</div>`; return; }
  if (!data) { root.innerHTML = '<div class="empty-state">Читаємо прогрів...</div>'; return; }
  const startable = data.rows.filter((row) => row.status === "never" || row.status === "paused").length;
  const plan = data.plan;
  root.innerHTML = `
    <div class="warmup-mail-head">
      <p>Наші пошти пишуть одна одній живі листи за розкладом: перший робочий день — ${plan.start}, далі +${plan.step} щодня до ${plan.max}. Приблизно третина отримує відповідь у тому ж треді. Лист, що впав у спам, виймається у «Вхідні» й позначається важливим. Прогрів і холодні листи разом не виходять за ліміт дня пошти й домену. У кампанії, звіти й «Вхідні» прогрів не потрапляє.</p>
      ${data.canChange && startable ? `<button type="button" class="primary-button" data-warmup-start-all${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="play"></i><span>Запустити всі (${startable})</span></button>` : ""}
    </div>
    ${bannerHtml(data)}
    ${planHtml(data)}
    ${notice ? `<p class="esp-notice ${error ? "is-bad" : ""}">${escapeHtml(notice)}</p>` : ""}
    ${summaryHtml(data.rows)}
    <section class="panel"><div class="panel-heading"><div><h2>Пошти</h2><p>Статус, день прогріву, листи сьогодні проти плану, відповіді й листи, вийняті зі спаму.</p></div>
      <button type="button" class="text-button" data-warmup-refresh><i data-lucide="refresh-cw"></i><span>Оновити</span></button></div>
      ${tableHtml(data)}
    </section>
    <section class="panel"><div class="panel-heading"><div><h2>Що робив прогрів</h2><p>Останні 30 подій.</p></div></div>${logHtml(data.log)}</section>`;
  refreshIcons(root);
}

async function change(path, body, done) {
  mailWarmupState.busy = path;
  renderMailWarmup();
  try {
    const result = await api(`/api/esp/warmup/${path}`, { method: "POST", body: JSON.stringify(body) });
    mailWarmupState.notice = done(result);
    mailWarmupState.error = "";
  } catch (error) {
    mailWarmupState.notice = error?.status === 403 ? "Запускати й зупиняти прогрів може той, хто має право міняти ліміти." : error?.message || "Не вдалося.";
    mailWarmupState.error = mailWarmupState.notice;
  } finally {
    mailWarmupState.busy = "";
  }
  await loadMailWarmup();
}

document.getElementById("mailWarmupRoot")?.addEventListener("submit", (event) => {
  if (event.target.id !== "mailWarmupPlan") return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target).entries());
  void change("plan", values, (result) => `План: старт ${result.plan.start}, +${result.plan.step} щодня, до ${result.plan.max}.`);
});

document.getElementById("mailWarmupRoot")?.addEventListener("click", (event) => {
  const start = event.target.closest("[data-warmup-start]")?.dataset.warmupStart;
  if (start) return void change("start", { mailbox: start }, () => `${start}: прогрів запущено.`);
  const remove = event.target.closest("[data-warmup-remove]")?.dataset.warmupRemove;
  if (remove) {
    if (!window.confirm(`Прибрати ${remove} з прогріву? Вона перестане писати й отримувати листи прогріву. Повернути можна під таблицею.`)) return;
    return void change("remove", { mailbox: remove }, () => `${remove}: прибрано з прогріву.`);
  }
  const restore = event.target.closest("[data-warmup-restore]")?.dataset.warmupRestore;
  if (restore) return void change("restore", { mailbox: restore }, () => `${restore}: повернуто — натисніть «Старт», щоб прогрів пішов.`);
  const pause = event.target.closest("[data-warmup-pause]")?.dataset.warmupPause;
  if (pause) return void change("pause", { mailbox: pause }, () => `${pause}: прогрів на паузі.`);
  if (event.target.closest("[data-warmup-start-all]")) {
    return void change("start", { all: true }, (result) => `Запущено: ${result.changed.length}${result.refused.length ? `; не можна: ${result.refused.map((row) => row.mailbox).join(", ")}` : ""}.`);
  }
  if (event.target.closest("[data-warmup-refresh]")) void loadMailWarmup();
});

// «Призначення»: розсилка або прогрів — і пошти для розсилки піднімаються нагору.
document.getElementById("mailWarmupRoot")?.addEventListener("change", (event) => {
  const select = event.target.closest?.("[data-warmup-role]");
  if (!select) return;
  const mailbox = select.dataset.warmupRole;
  const role = select.value || null;
  void change("role", { mailbox, role }, () => `${mailbox}: ${role === "cold" ? "для розсилки" : role === "warmup" ? "лише для прогріву — холодні листи з неї не підуть" : "призначення знято"}.`);
});
