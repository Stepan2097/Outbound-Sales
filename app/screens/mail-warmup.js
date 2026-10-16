// Прогрів пошт — наші пошти Workspace пишуть одна одній (esp/mail-warmup.mjs):
// живі листи за розкладом, частина — з відповіддю в тому ж треді, лист зі спаму
// виймається у вхідні й позначається важливим, обсяг росте з днями. Тут —
// таблиця пошт зі «Старт» і «Пауза», що зараз заважає (банер), і журнал.
// Листи прогріву не потрапляють у кампанії, звіти й «Вхідні».

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural } from "../core.js";
import { accountActionsHtml, accountNotesHtml, accountsNoticeHtml, addButtonHtml, addDialogHtml, afterAccountsRender, bindAccounts, loadAccounts, onAccountsChange, readAccountsReturn, tagEditorHtml } from "./mail-accounts.js";

const STATUS = {
  running: ["іде", "tone-live"], paused: ["на паузі", "tone-warn"], never: ["не запущено", "tone-muted"], blocked: ["не можна", "tone-bad"], removed: ["не гріється", "tone-muted"]
};

export const mailWarmupState = { data: null, error: "", notice: "", busy: "", tag: null };

// Mailbox tags: the page shows every mailbox by default — grouped by domain
// (owner 14.10); the filter narrows it, «Запустити всі» starts what it shows.
function tagFilter() {
  return mailWarmupState.tag !== null ? mailWarmupState.tag : "";
}

function shownRows(data) {
  const tag = tagFilter(data);
  return data.rows.filter((row) => !tag || (tag === "-" ? !(row.tags || []).length : (row.tags || []).includes(tag)));
}

// «Розсилка» і «Прогрів» показує стовпчик «Призначення» — біля адреси лише свої теги команди.
const ownTags = (row) => (row.tags || []).filter((tag) => tag !== "Розсилка" && tag !== "Прогрів");
const tagPills = (tags = []) => tags.map((tag) => `<span class="warmup-mail-tag${tag === "Прогрів" ? " is-warm" : tag === "Розсилка" ? " is-send" : ""}">${escapeHtml(tag)}</span>`).join("");

onScreen("mail-warmup", { open: () => void loadMailWarmup() });

export async function loadMailWarmup() {
  if (!document.getElementById("mailWarmupRoot")) return;
  // The mailboxes' connections (what was the «Пошти» page) come with the table.
  readAccountsReturn();
  try {
    [mailWarmupState.data] = await Promise.all([api("/api/esp/warmup"), loadAccounts()]);
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

/** What share of this mailbox's warm-up letters landed in somebody's Spam. */
const spamShare = (row) => (row.sent ? Math.round((row.landedInSpam / row.sent) * 100) : 0);

function summaryHtml(rows) {
  const running = rows.filter((row) => row.status === "running");
  const sum = (key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
  const cards = [
    ["mail-plus", "Гріються", `${running.length} з ${rows.length}`, "пошт"],
    ["send", "Сьогодні листів", `${number(sum("firstsToday"))} / ${number(running.reduce((total, row) => total + row.plannedToday, 0))}`, `і ${number(sum("repliesToday"))} ${uaPlural(sum("repliesToday"), "відповідь", "відповіді", "відповідей")}`],
    ["reply", "Відповідей отримано", number(sum("repliesReceived")), "за весь прогрів"],
    ["shield-check", "Вийнято зі спаму", number(sum("rescued")), `${number(sum("landedInSpam"))} ${uaPlural(sum("landedInSpam"), "лист потрапив", "листи потрапили", "листів потрапило")} у спам${sum("sent") ? ` — ${Math.round((sum("landedInSpam") / sum("sent")) * 100)}% від надісланих` : ""}`]
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
  const { canChange } = data;
  // Domains A→Z, inside each the addresses A→Z, a heading row per domain (owner 13–14.10).
  // Mailboxes for campaigns first, then the unmarked, then warm-up-only (owner 14.10);
  // inside each, domains A→Z and addresses A→Z.
  const rank = (row) => (row.role === "cold" ? 0 : row.role === "warmup" ? 2 : 1);
  const rows = shownRows(data).slice().sort((left, right) => rank(left) - rank(right) || String(left.domain).localeCompare(String(right.domain)) || left.email.localeCompare(right.email));
  const perRank = new Map();
  for (const row of rows) perRank.set(rank(row), (perRank.get(rank(row)) || 0) + 1);
  const SECTION = ["Для розсилки", "Призначення не вказано", "Лише прогрів"];
  if (data.rows.length && !rows.length) return `<div class="empty-state">З тегом «${escapeHtml(tagFilter(data))}» пошт немає — виберіть інший тег у фільтрі.</div>${removedHtml(data)}`;
  if (!rows.length) return `<div class="empty-state">Пошт ще немає — «Додати пошту» вгорі сторінки.</div>${removedHtml(data)}`;
  const action = (row) => {
    if (!canChange) return "";
    if (row.status === "running") return `<button type="button" class="text-button" data-warmup-pause="${escapeAttr(row.email)}"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="pause"></i><span>Пауза</span></button>`;
    if (row.status === "removed") return `<button type="button" class="text-button" data-warmup-restore="${escapeAttr(row.email)}"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="undo-2"></i><span>Повернути в прогрів</span></button>`;
    if (row.status === "blocked") return `<span class="esp-subtle" title="${escapeAttr(row.blocked)}">${escapeHtml(row.blocked)}</span>`;
    return `<button type="button" class="primary-button" data-warmup-start="${escapeAttr(row.email)}"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="play"></i><span>Старт</span></button>`;
  };
  return `
    <div class="table-wrap"><table class="warmup-mail-table">
      <thead><tr><th>Пошта</th><th>Призначення</th><th>Статус</th><th>Листів сьогодні</th><th>Відповідей</th><th>Потрапили в спам</th><th>Холодних листів</th><th></th></tr></thead>
      <tbody>${rows.map((row, index, list) => {
        const [word, tone] = STATUS[row.status];
        const share = row.plannedToday ? Math.min(100, Math.round((row.firstsToday / row.plannedToday) * 100)) : 0;
        // A new domain starts a group: its name on a row of its own, with a gap above.
        const sectionStart = index === 0 || rank(list[index - 1]) !== rank(row);
        const groupStart = sectionStart || list[index - 1].domain !== row.domain;
        const section = sectionStart ? `<tr class="warmup-mail-section-row${index ? " is-gap" : ""}"><td colspan="8">${SECTION[rank(row)]}<span>${perRank.get(rank(row))}</span></td></tr>` : "";
        // A new domain: just a gap above it, no label (owner 14.10).
        const heading = sectionStart ? section : groupStart ? '<tr class="warmup-mail-domain-gap" aria-hidden="true"><td colspan="8"></td></tr>' : "";
        return `${heading}<tr>
          <td><strong>${escapeHtml(row.email)}</strong>${ownTags(row).length ? `<span class="warmup-mail-tags">${tagPills(ownTags(row))}</span>` : ""}${accountNotesHtml(row.email)}</td>
          <td>${roleHtml(row, canChange)}</td>
          <td class="warmup-mail-status"><span class="pill ${tone}">${word}</span>${row.day ? `<b class="warmup-mail-day">день ${escapeHtml(String(row.day))}</b>` : ""}${row.status === "paused" && row.pausedAt ? `<small>з ${escapeHtml(when(row.pausedAt))}</small>` : row.status === "running" && row.startedAt ? `<small>старт ${escapeHtml(when(row.startedAt))}</small>` : ""}</td>
          <td class="is-number">${row.status === "running" ? `<div class="warmup-mail-progress"><span style="width:${share}%"></span></div>` : ""}${row.firstsToday} / ${row.plannedToday}</td>
          <td class="is-number warmup-mail-pair"><span title="Скільки відповідей прийшло на листи цієї пошти"><b>${row.repliesReceived}</b> отримала</span><small title="На скільки чужих листів прогріву відповіла вона сама">відповіла сама: ${row.repliesSent}</small></td>
          <td class="is-number warmup-mail-pair" title="Листи цієї пошти, що в інших наших пошт потрапили у «Спам». Прогрів виймає їх усі й позначає важливими."><span class="${spamShare(row) >= 10 ? "is-bad" : ""}"><b>${row.landedInSpam}</b> з ${row.sent}</span><small>${row.sent ? `${spamShare(row)}%` : "—"}</small></td>
          <td class="is-number">${row.coldToday} / ${row.limit}<small>сьогодні з ліміту</small></td>
          <td class="warmup-mail-action">${action(row)}${accountActionsHtml(row.email)}${canChange && row.status !== "removed" ? `<button type="button" class="icon-button warmup-mail-remove" data-warmup-remove="${escapeAttr(row.email)}" title="Прибрати з прогріву" aria-label="Прибрати ${escapeAttr(row.email)} з прогріву"${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="trash-2"></i></button>` : ""}${row.lastError && row.status === "running" ? `<small class="is-bad" title="${escapeAttr(row.lastError.error)}">остання відмова ${escapeHtml(when(row.lastError.at))}</small>` : ""}</td>
        </tr>${tagEditorHtml(row.email) ? `<tr class="warmup-mail-tag-row"><td colspan="8">${tagEditorHtml(row.email)}</td></tr>` : ""}`;
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
  const wasOpen = document.getElementById("mailAccountsDialog")?.open;
  const { data, error, notice } = mailWarmupState;
  if (error && !data) { root.innerHTML = `<div class="empty-state">${escapeHtml(error)}</div>`; return; }
  if (!data) { root.innerHTML = '<div class="empty-state">Читаємо прогрів...</div>'; return; }
  const startable = shownRows(data).filter((row) => row.status === "never" || row.status === "paused").length;
  const current = tagFilter(data);
  const filter = `<label class="warmup-mail-filter">Тег <select id="mailWarmupTag">${[["", "Усі пошти"], ...(data.tagCatalog || ["Розсилка", "Прогрів"]).map((tag) => [tag, tag]), ["-", "Без тегу"]].map(([value, label]) => `<option value="${escapeAttr(value)}"${current === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>`;
  const plan = data.plan;
  root.innerHTML = `
    <div class="warmup-mail-head">
      <p>Наші пошти пишуть одна одній живі листи за розкладом: перший робочий день — ${plan.start}, далі +${plan.step} щодня до ${plan.max}. Приблизно третина отримує відповідь у тому ж треді. Лист, що впав у спам, виймається у «Вхідні» й позначається важливим. Ліміт дня пошти — лише для холодних листів; прогрів іде за своїм планом. У кампанії, звіти й «Вхідні» прогрів не потрапляє.</p>
      <div class="warmup-mail-head-actions">${addButtonHtml()}
      ${data.canChange && startable ? `<button type="button" class="primary-button" data-warmup-start-all${mailWarmupState.busy ? " disabled" : ""}><i data-lucide="play"></i><span>Запустити всі (${startable})</span></button>` : ""}</div>
    </div>
    ${accountsNoticeHtml()}
    ${bannerHtml(data)}
    ${planHtml(data)}
    ${notice ? `<p class="esp-notice ${error ? "is-bad" : ""}">${escapeHtml(notice)}</p>` : ""}
    ${summaryHtml(data.rows)}
    <section class="panel"><div class="panel-heading"><div><h2>Пошти</h2><p>Статус, день прогріву, листи сьогодні проти плану, відповіді й листи, вийняті зі спаму.</p></div>
      <div class="warmup-mail-tools">${filter}<button type="button" class="text-button" data-warmup-refresh><i data-lucide="refresh-cw"></i><span>Оновити</span></button></div></div>
      ${tableHtml(data)}
    </section>
    <section class="panel"><div class="panel-heading"><div><h2>Що робив прогрів</h2><p>Останні 30 подій.</p></div></div>${logHtml(data.log)}</section>
    ${addDialogHtml()}`;
  refreshIcons(root);
  afterAccountsRender(wasOpen);
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

document.getElementById("mailWarmupRoot")?.addEventListener("change", (event) => {
  if (event.target.id !== "mailWarmupTag") return;
  mailWarmupState.tag = event.target.value;
  renderMailWarmup();
});

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
    return void change("start", { mailboxes: shownRows(mailWarmupState.data).filter((row) => row.status === "never" || row.status === "paused").map((row) => row.email) }, (result) => `Запущено: ${result.changed.length}${result.refused.length ? `; не можна: ${result.refused.map((row) => row.mailbox).join(", ")}` : ""}.`);
  }
  if (event.target.closest("[data-warmup-refresh]")) void loadMailWarmup();
});

// «Призначення»: розсилка або прогрів — і пошти для розсилки піднімаються нагору.
document.getElementById("mailWarmupRoot")?.addEventListener("change", (event) => {
  const select = event.target.closest?.("[data-warmup-role]");
  if (!select) return;
  const mailbox = select.dataset.warmupRole;
  const role = select.value || null;
  // Призначення — це й вбудовані теги: щоб рядок не зник з-під руки, коли
  // фільтр за тегом його більше не бере, фільтр стає «Усі пошти».
  const row = mailWarmupState.data?.rows.find((item) => item.email === mailbox);
  const tag = mailWarmupState.data ? tagFilter(mailWarmupState.data) : "";
  const builtIns = role === "cold" ? ["Розсилка", ...((row?.tags || []).includes("Прогрів") ? ["Прогрів"] : [])] : role === "warmup" ? ["Прогрів"] : [];
  const after = [...builtIns, ...(row ? ownTags(row) : [])];
  if (tag && !(tag === "-" ? !after.length : after.includes(tag))) mailWarmupState.tag = "";
  void change("role", { mailbox, role }, () => `${mailbox}: ${role === "cold" ? "для розсилки" : role === "warmup" ? "лише для прогріву — холодні листи з неї не підуть" : "призначення знято"}.`);
});

// Connections: «Додати пошту», check, sign in again, tags, disconnect (what was the «Пошти» page).
onAccountsChange(() => renderMailWarmup());
bindAccounts(document.getElementById("mailWarmupRoot"), () => loadMailWarmup());
