// «Кампанії» — холодна пошта як окрема сторінка (ESP-UI 1–3, власник 12.10):
// список кампаній зі створенням (скріни Snov 04, 03), конструктор у чотири
// кроки Послідовність → Одержувачі → Параметри відправки → Перевірка (05) і
// редактор листа (08). Структура — як у Snov, вигляд — Outbound, а де Snov
// розходиться з чеклістом ESP, правий чекліст: немає відкриттів, кліків, HTML,
// пікселів і переписаних посилань — лише простий текст.
//
// Усе на готовому бекенді ESP: /api/esp/campaigns, /templates, /preview,
// /limits, /alerts, /halt. Звідси лист нікому не йде: відправку веде
// ланцюжок на сервері, і лише після приймання ESP 11.

import { api, authState, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

onScreen("campaigns", { open: () => void openCampaignsPage() });

const STATE_LABEL = { draft: "Чернетка", running: "Працює", paused: "Пауза", done: "Завершена" };
const STATE_TONE = { draft: "tone-muted", running: "tone-live", paused: "tone-warn", done: "tone-muted" };
const FOLDERS = [["all", "Усі кампанії", "folder"], ["draft", "Чернетки", "file-pen"], ["running", "Працюють", "play"], ["paused", "На паузі", "pause"], ["done", "Завершені", "flag"], ["archived", "Архів", "archive"]];
const STEPS = [["sequence", "Послідовність"], ["recipients", "Одержувачі"], ["sending", "Параметри відправки"], ["review", "Перевірка"]];
const PERSON_STATE = { active: "у ланцюжку", done: "отримав усі", stopped: "зупинено", uncertain: "невідомо, чи пішов", paused: "пауза" };
const STOP_REASON = {
  replied: "відповів", bounced: "bounce", unsubscribed: "відписався", campaign_done: "кампанію завершено", company_replied: "відповів колега з компанії",
  unknown_timezone: "невідомий часовий пояс", empty_variable: "порожня змінна", us_address_missing: "немає адреси для США",
  no_answer_from_provider: "Gmail не відповів — перевір «Надіслані»"
};
const SKIP_REASON = {
  not_due: "ще не день", sender_daily_limit: "ліміт пошти", domain_daily_limit: "ліміт домену", outside_window: "поза вікном одержувача",
  weekend: "вихідний", holiday: "свято в країні одержувача", too_soon: "інтервал між листами", sender_unavailable: "пошта не надсилає",
  sender_paused: "пошта на паузі", already_sent: "уже надіслано", provider_refused: "Gmail відмовив", company_daily_limit: "2 нових з компанії на день"
};
const SPIN_MODES = [["all", "Усім", "кожен отримує свої варіанти речень і тем"], ["half", "A/B — половині", "половина бачить базовий текст: видно, чи варіанти кращі"], ["off", "Нікому", "завжди перший варіант"]];
const SKIP_CHOOSER_KEY = "outbound.campaigns.skipChooser";
const MAX_LETTERS = 6;

const page = {
  ready: false, error: "", notice: "", noticeTone: "",
  campaigns: [], templates: [], variables: [], signature: null, limits: null, halt: null, sequenceOn: false, alerts: [], alertIndex: 0,
  folder: "all", search: "", selected: new Set(), menuFor: null,
  // Конструктор: відкрита кампанія і крок.
  openId: null, step: "sequence", people: [], peopleLoaded: false, peopleResult: null, peopleText: "", plan: null, previews: {}, sampleEmail: "",
  chooser: null, editor: null, busy: false,
  // Фільтр пошт за тегом у «Параметрах відправки»; null — ще не обрано (тоді «Розсилка», якщо така є).
  senderTag: null
};

const byId = (id) => page.campaigns.find((campaign) => campaign.id === id) || null;
const current = () => byId(page.openId);
const libraryTemplates = () => page.templates.filter((template) => !template.campaignId);
const templateOf = (id) => page.templates.find((template) => template.id === id) || null;
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const when = (iso) => (iso ? new Date(iso).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }) : "");
const started = () => page.people.some((person) => person.step > 0);
const rootEl = () => document.getElementById("mailCampaignsRoot");

// ── дані ────────────────────────────────────────────────────────────────────

async function openCampaignsPage() {
  readRoute();
  await loadCampaignsPage();
}

export async function loadCampaignsPage() {
  if (!rootEl()) return;
  try {
    const [campaigns, halt, templates, limits, alerts] = await Promise.all([
      api("/api/esp/campaigns"),
      api("/api/esp/halt"),
      api("/api/esp/templates").catch(() => ({ templates: [], variables: [] })),
      api("/api/esp/limits").catch(() => null),
      api("/api/esp/alerts").catch(() => ({ alerts: [] }))
    ]);
    page.campaigns = campaigns.campaigns || [];
    page.halt = halt.halt;
    page.sequenceOn = Boolean(halt.sequenceOn);
    page.liveSend = Boolean(halt.liveSend);
    page.templates = templates.templates || [];
    page.variables = templates.variables || [];
    page.signature = templates.signature || null;
    page.limits = limits;
    page.alerts = alerts.alerts || [];
    page.error = "";
    if (page.openId && !current()) page.openId = null;
    if (page.openId) await loadPeople();
  } catch (error) {
    page.error = error.status === 403 ? "Кампанії веде адміністратор або той, кому він дав право «Запускати кампанії»." : error.message;
  }
  page.ready = true;
  renderCampaignsPage();
}

async function loadPeople() {
  page.people = (await api(`/api/esp/campaigns/people?id=${encodeURIComponent(page.openId)}`).catch(() => ({ people: [] }))).people || [];
  page.peopleLoaded = true;
  if (!page.sampleEmail || !page.people.some((person) => person.email === page.sampleEmail)) page.sampleEmail = page.people[0]?.email || "";
}

/** Адреса сторінки: #campaigns — список, #campaigns/<id>/<крок> — конструктор. Посилання можна дати людині. */
function readRoute() {
  const [view, id, step] = window.location.hash.replace(/^#/, "").split("/");
  if (view !== "campaigns") return;
  page.openId = id || null;
  page.step = STEPS.some(([key]) => key === step) ? step : "sequence";
}

function writeRoute() {
  const hash = page.openId ? `#campaigns/${page.openId}/${page.step}` : "#campaigns";
  if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
}

async function act(work, { success = "", reload = true } = {}) {
  page.busy = true;
  renderCampaignsPage();
  try {
    await work();
    page.notice = success;
    page.noticeTone = "is-ok";
  } catch (error) {
    page.notice = error.message || "Не вдалося.";
    page.noticeTone = "is-bad";
  } finally {
    page.busy = false;
  }
  if (reload) await loadCampaignsPage();
  else renderCampaignsPage();
}

const saveCampaign = (patch) => api("/api/esp/campaigns", { method: "PATCH", body: JSON.stringify({ id: page.openId, ...patch }) });

// ── список (скрін 04) ────────────────────────────────────────────────────────

function bannersHtml() {
  const out = [];
  if (page.halt?.on) {
    out.push(`<div class="mc-banner is-bad" role="alert"><i data-lucide="octagon-x"></i>
      <div><strong>«Стоп усе» увімкнено — жоден лист не йде.</strong> ${escapeHtml(page.halt.reason || "")} · ${escapeHtml(page.halt.by || "")} · ${escapeHtml(when(page.halt.at))}</div>
      <button class="primary-button" type="button" data-mc="halt-off">Відновити відправку</button></div>`);
  }
  if (!page.sequenceOn) {
    out.push(`<div class="mc-banner"><i data-lucide="info"></i><div>Відправку на цьому сервері вимкнено (ESP_SEQUENCE): кампанії будуються й перевіряються, листи не йдуть — до приймання ESP 11.</div></div>`);
  }
  if (page.alerts.length) {
    const index = Math.min(page.alertIndex, page.alerts.length - 1);
    const alert = page.alerts[index];
    const fix = alert.kind === "pause_sender" ? "зняти паузу пошти — у «Налаштуваннях пошти», коли причину усунуто"
      : alert.kind === "pause_domain" ? "зняти паузу домену — у «Налаштуваннях пошти»" : alert.kind === "alert" ? "нічого не зупинено — перевірте" : "запустити знову — у списку, коли джерело перевірено";
    out.push(`<div class="mc-banner is-warn" role="alert"><i data-lucide="triangle-alert"></i>
      <div><strong>${escapeHtml(alert.title)}</strong> ${escapeHtml(alert.reason || "")} <span class="mc-subtle">${escapeHtml(when(alert.at))} · ${escapeHtml(fix)}</span></div>
      ${page.alerts.length > 1 ? `<div class="mc-pager"><button type="button" class="icon-button" data-mc="alert-prev" aria-label="Попередня"><i data-lucide="chevron-left"></i></button><span>${index + 1} з ${page.alerts.length}</span><button type="button" class="icon-button" data-mc="alert-next" aria-label="Наступна"><i data-lucide="chevron-right"></i></button></div>` : ""}
    </div>`);
  }
  return out.join("");
}

function visibleCampaigns() {
  const needle = page.search.trim().toLowerCase();
  return page.campaigns
    // Archived campaigns live in their own folder and nowhere else.
    .filter((campaign) => (page.folder === "archived" ? campaign.archived : !campaign.archived))
    .filter((campaign) => page.folder === "all" || page.folder === "templates" || page.folder === "archived" || campaign.state === page.folder)
    .filter((campaign) => !needle || campaign.name.toLowerCase().includes(needle))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function foldersHtml() {
  const count = (key) => (key === "archived"
    ? page.campaigns.filter((campaign) => campaign.archived).length
    : page.campaigns.filter((campaign) => !campaign.archived && (key === "all" || campaign.state === key)).length);
  return `<nav class="mc-folders" aria-label="Папки кампаній">
    <div class="mc-folders-title">Папки</div>
    ${FOLDERS.map(([key, label, icon]) => `<button type="button" class="mc-folder ${page.folder === key ? "is-active" : ""}" data-mc-folder="${key}">
      <i data-lucide="${icon}"></i><span>${label}</span><b>${count(key)}</b></button>`).join("")}
    <div class="mc-folders-sep"></div>
    <button type="button" class="mc-folder ${page.folder === "templates" ? "is-active" : ""}" data-mc-folder="templates"><i data-lucide="file-text"></i><span>Шаблони листів</span><b>${libraryTemplates().length}</b></button>
  </nav>`;
}

function campaignRowHtml(campaign) {
  const done = (campaign.byStatus?.done || 0) + (campaign.byStatus?.stopped || 0);
  const progress = percent(done, campaign.people);
  const menuOpen = page.menuFor === campaign.id;
  const stat = (value, base) => `<b>${value}</b>${base ? `<small>${percent(value, base)}%</small>` : ""}`;
  return `<tr>
    <td class="mc-check"><input type="checkbox" data-mc-select="${escapeAttr(campaign.id)}" ${page.selected.has(campaign.id) ? "checked" : ""} aria-label="Вибрати ${escapeAttr(campaign.name)}" /></td>
    <td class="mc-campaign-cell">
      <button type="button" class="mc-link" data-mc-open="${escapeAttr(campaign.id)}">${escapeHtml(campaign.name)}</button>
      <div class="mc-meta">
        <span><i data-lucide="users"></i>Одержувачів: ${campaign.people}</span>${campaign.people ? `<span class="mc-progress" title="Пройшли ланцюжок: ${done} з ${campaign.people}"><span style="width:${progress}%"></span></span>` : ""}
        <span><i data-lucide="mail"></i>${campaign.steps.length} ${campaign.steps.length === 1 ? "лист" : campaign.steps.length < 5 ? "листи" : "листів"}${campaign.spinMode === "half" ? " · A/B" : ""}</span>
        <span><i data-lucide="at-sign"></i>${campaign.senders.length ? escapeHtml(campaign.senders.join(", ")) : "пошти не обрано"}</span>
        <span><i data-lucide="calendar"></i>${escapeHtml(when(campaign.createdAt))}</span>
      </div>
    </td>
    <td><span class="pill ${STATE_TONE[campaign.state]}">${STATE_LABEL[campaign.state]}</span></td>
    <td class="mc-owner" title="${escapeAttr(campaign.owner || "")}">${campaign.owner ? `<i data-lucide="user"></i>${escapeHtml(campaign.owner.split("@")[0])}` : '<span class="mc-subtle">—</span>'}</td>
    <td class="mc-num">${stat(campaign.sent)}</td>
    <td class="mc-num">${stat(campaign.replied, campaign.sent)}</td>
    <td class="mc-num">${stat(campaign.bounced, campaign.sent)}</td>
    <td class="mc-num">${stat(campaign.unsubscribed, campaign.sent)}</td>
    <td class="mc-row-menu">
      <button type="button" class="icon-button" data-mc-menu="${escapeAttr(campaign.id)}" aria-label="Дії" aria-expanded="${menuOpen}"><i data-lucide="more-vertical"></i></button>
      ${menuOpen ? `<div class="mc-menu" role="menu">
        <button type="button" role="menuitem" data-mc-open="${escapeAttr(campaign.id)}"><i data-lucide="pencil"></i>Відкрити</button>
        ${campaign.state === "running" ? `<button type="button" role="menuitem" data-mc-state="paused" data-id="${escapeAttr(campaign.id)}"><i data-lucide="pause"></i>Пауза</button>` : ""}
        ${campaign.state === "paused" ? `<button type="button" role="menuitem" data-mc-state="running" data-id="${escapeAttr(campaign.id)}"><i data-lucide="play"></i>Продовжити</button>` : ""}
        <button type="button" role="menuitem" data-mc-copy="${escapeAttr(campaign.id)}"><i data-lucide="copy"></i>Дублювати</button>
        ${campaign.state !== "done" && campaign.state !== "draft" ? `<button type="button" role="menuitem" data-mc-state="done" data-id="${escapeAttr(campaign.id)}"><i data-lucide="flag"></i>Завершити</button>` : ""}
        ${campaign.archived
          ? `<button type="button" role="menuitem" data-mc-archive="0" data-id="${escapeAttr(campaign.id)}"><i data-lucide="archive-restore"></i>Повернути з архіву</button>`
          : campaign.state === "running"
            ? '<button type="button" role="menuitem" disabled title="Працююча кампанія — спершу пауза або завершення"><i data-lucide="archive"></i>Архівувати — спершу пауза</button>'
            : `<button type="button" role="menuitem" data-mc-archive="1" data-id="${escapeAttr(campaign.id)}"><i data-lucide="archive"></i>Архівувати</button>`}
        ${deletable(campaign) ? `<button type="button" role="menuitem" class="mc-danger-text" data-mc-delete="${escapeAttr(campaign.id)}"><i data-lucide="trash-2"></i>Видалити</button>` : ""}
      </div>` : ""}
    </td>
  </tr>`;
}

/** Nothing has gone out of it: it can go entirely. Otherwise only the archive (the server says the same). */
function deletable(campaign) {
  return campaign.state !== "running" && !campaign.sent && !campaign.byStatus?.done && !campaign.byStatus?.stopped;
}

function bulkBarHtml() {
  const chosen = page.campaigns.filter((campaign) => page.selected.has(campaign.id));
  if (!chosen.length) return "";
  const removable = chosen.filter(deletable).length;
  const archivable = chosen.filter((campaign) => !campaign.archived && campaign.state !== "running").length;
  return `<div class="mc-bulk" role="toolbar" aria-label="Дії з вибраними">
    <span>Вибрано: <b>${chosen.length}</b></span>
    ${archivable ? `<button type="button" data-mc="bulk-archive"><i data-lucide="archive"></i><span>Архівувати (${archivable})</span></button>` : ""}
    ${removable ? `<button type="button" class="danger-button" data-mc="bulk-delete"><i data-lucide="trash-2"></i><span>Видалити (${removable})</span></button>` : ""}
    <button type="button" class="text-button" data-mc="bulk-clear">Зняти вибір</button>
  </div>`;
}

function campaignsTableHtml() {
  const rows = visibleCampaigns();
  if (!page.campaigns.length) {
    return `<div class="mc-empty"><i data-lucide="send"></i><strong>Кампаній ще немає</strong><p>Ланцюжок холодних листів: лист, затримка в робочих днях, наступний лист. Відповідь, bounce чи відписка зупиняє його для людини.</p>
      <button class="primary-button" type="button" data-mc="create"><i data-lucide="plus"></i><span>Створити кампанію</span></button></div>`;
  }
  if (!rows.length) return '<div class="empty-state">У цій папці або за цим пошуком кампаній немає.</div>';
  const all = rows.every((campaign) => page.selected.has(campaign.id));
  return `${bulkBarHtml()}<div class="table-wrap mc-table-wrap"><table class="mc-table">
    <thead><tr>
      <th class="mc-check"><input type="checkbox" data-mc="select-all" ${all ? "checked" : ""} aria-label="Вибрати всі" /></th>
      <th>Кампанія</th><th>Стан</th><th>Власник</th><th>Надіслано</th><th>Відповіді</th><th>Bounce</th><th>Відписки</th><th></th>
    </tr></thead>
    <tbody>${rows.map(campaignRowHtml).join("")}</tbody>
  </table></div>
  <p class="mc-subtle mc-table-note">Відкриттів і кліків тут немає свідомо: листи йдуть простим текстом, без пікселя й переписаних посилань.</p>`;
}

function templatesLibraryHtml() {
  const list = libraryTemplates();
  return `<div class="mc-library">
    <div class="mc-library-head"><div><strong>Шаблони листів</strong><p class="mc-subtle">Бібліотека для нових кампаній. Лист, написаний у кампанії, живе в ній; сюди — через «Зберегти як шаблон».</p></div>
      <button type="button" class="text-button" data-mc="template-new"><i data-lucide="plus"></i><span>Новий шаблон</span></button></div>
    ${list.length ? `<div class="mc-library-grid">${list.map((template) => `<article class="mc-template-card">
        <strong>${escapeHtml(template.name || template.subject)}</strong>
        <span class="mc-subtle">Тема: ${escapeHtml(template.subject)}</span>
        <p>${escapeHtml(template.body.slice(0, 180))}${template.body.length > 180 ? "…" : ""}</p>
        <div class="mc-card-actions">
          <button type="button" class="text-button" data-mc-template-edit="${escapeAttr(template.id)}"><i data-lucide="pencil"></i><span>Редагувати</span></button>
          <button type="button" class="text-button" data-mc-from-template="${escapeAttr(template.id)}"><i data-lucide="send"></i><span>Кампанія з нього</span></button>
          <button type="button" class="text-button mc-danger-text" data-mc-template-delete="${escapeAttr(template.id)}"><i data-lucide="trash-2"></i><span>Видалити</span></button>
        </div>
      </article>`).join("")}</div>` : '<div class="empty-state">Шаблонів ще немає.</div>'}
  </div>`;
}

function listHtml() {
  return `
    <div class="mc-toolbar">
      <button class="primary-button" type="button" data-mc="create"><i data-lucide="circle-plus"></i><span>Створити кампанію</span></button>
      <button type="button" data-mc="export"><i data-lucide="download"></i><span>${page.selected.size ? `Експорт статистики (${page.selected.size})` : "Експорт статистики"}</span></button>
      <button type="button" data-mc="add-mailbox"><i data-lucide="mail-plus"></i><span>Додати пошту</span></button>
      <div class="mc-toolbar-spacer"></div>
      <label class="mc-search"><i data-lucide="search"></i><input type="search" data-mc-input="search" placeholder="Пошук кампанії" value="${escapeAttr(page.search)}" /></label>
      ${page.halt?.on ? "" : `<button type="button" class="danger-button" data-mc="halt-on"><i data-lucide="octagon-x"></i><span>Стоп усе</span></button>`}
    </div>
    ${bannersHtml()}
    ${noticeHtml()}
    <div class="mc-list-layout">
      ${foldersHtml()}
      <div class="mc-list-main">${page.folder === "templates" ? templatesLibraryHtml() : campaignsTableHtml()}</div>
    </div>`;
}

function noticeHtml() {
  return page.notice ? `<p class="esp-notice ${page.noticeTone}" role="status">${escapeHtml(page.notice)}</p>` : "";
}

// ── створення (скрін 03) ────────────────────────────────────────────────────

function chooserHtml() {
  const chooser = page.chooser;
  if (!chooser) return "";
  const body = chooser.mode === "template" ? `
      <button type="button" class="text-button mc-back" data-mc="chooser-back"><i data-lucide="arrow-left"></i><span>Назад</span></button>
      <h3>З чого почати</h3>
      <div class="mc-pick-list">
        ${libraryTemplates().map((template) => `<button type="button" class="mc-pick" data-mc-from-template="${escapeAttr(template.id)}">
          <i data-lucide="file-text"></i><span><strong>${escapeHtml(template.name || template.subject)}</strong><small>Шаблон листа · ${escapeHtml(template.subject)}</small></span></button>`).join("")}
        ${page.campaigns.filter((campaign) => campaign.steps.length).map((campaign) => `<button type="button" class="mc-pick" data-mc-copy="${escapeAttr(campaign.id)}">
          <i data-lucide="copy"></i><span><strong>${escapeHtml(campaign.name)}</strong><small>Копія ланцюжка · ${campaign.steps.length} ${campaign.steps.length === 1 ? "лист" : "листи"}, без людей</small></span></button>`).join("")}
        ${!libraryTemplates().length && !page.campaigns.some((campaign) => campaign.steps.length) ? '<p class="mc-subtle">Ще немає ні шаблонів, ні кампаній з листами — почніть з нуля.</p>' : ""}
      </div>` : `
      <div class="mc-choice-grid">
        <button type="button" class="mc-choice" data-mc="chooser-template">
          <span class="mc-choice-art"><i data-lucide="layers"></i></span>
          <strong>З шаблону</strong>
          <span>Шаблон листа з бібліотеки або копія ланцюжка іншої кампанії.</span>
        </button>
        <button type="button" class="mc-choice" data-mc="chooser-scratch">
          <span class="mc-choice-art"><i data-lucide="file-plus"></i></span>
          <strong>З нуля</strong>
          <span>Покроково: листи й затримки, одержувачі, пошти, перевірка.</span>
        </button>
      </div>
      <label class="mc-check-line"><input type="checkbox" data-mc-input="skip-chooser" ${readSkipChooser() ? "checked" : ""} /> Більше не показувати — одразу з нуля</label>`;
  return `<div class="mc-modal-backdrop" data-mc="chooser-close"></div>
    <section class="mc-modal mc-chooser" role="dialog" aria-modal="true" aria-label="Створити кампанію">
      <header><h2>Створити кампанію</h2><button type="button" class="icon-button" data-mc="chooser-close" aria-label="Закрити"><i data-lucide="x"></i></button></header>
      ${body}
    </section>`;
}

function readSkipChooser() {
  try { return window.localStorage.getItem(SKIP_CHOOSER_KEY) === "1"; } catch { return false; }
}

function draftName() {
  return `Чернетка (${new Date().toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" })})`;
}

/** Нова чернетка й одразу конструктор — як «Create from scratch» у Snov. */
async function createCampaign({ steps = [], name = draftName(), letters = [], senders = [], spinMode = "all" } = {}) {
  // A second click while the first is still creating made two identical drafts (12.10).
  if (page.creating) return;
  page.creating = true;
  await act(async () => {
    const { campaign } = await api("/api/esp/campaigns", { method: "POST", body: JSON.stringify({ name, senders, spinMode }) });
    // Листи нової кампанії — її власні копії: правка тут не міняє ні шаблон, ні іншу кампанію.
    const own = [];
    for (const [index, letter] of letters.entries()) {
      const { template } = await api("/api/esp/templates", { method: "POST", body: JSON.stringify({ name: `${name} — лист ${index + 1}`, subject: letter.subject, body: letter.body, campaignId: campaign.id }) });
      own.push({ templateId: template.id, delayDays: steps[index]?.delayDays ?? (index ? 3 : 0) });
    }
    if (own.length) await api("/api/esp/campaigns", { method: "PATCH", body: JSON.stringify({ id: campaign.id, steps: own }) });
    page.chooser = null;
    page.openId = campaign.id;
    page.step = "sequence";
    page.peopleResult = null;
    page.plan = null;
    page.previews = {};
    writeRoute();
  }).finally(() => { page.creating = false; });
}

// ── конструктор (скрін 05) ──────────────────────────────────────────────────

function stepperHtml(campaign) {
  const at = STEPS.findIndex(([key]) => key === page.step);
  return `<header class="mc-builder-head">
    <button type="button" class="icon-button" data-mc="back" aria-label="До списку кампаній" title="До списку кампаній"><i data-lucide="arrow-left"></i></button>
    <input class="mc-name" data-mc-input="name" value="${escapeAttr(campaign.name)}" aria-label="Назва кампанії" maxlength="120" />
    <span class="pill ${STATE_TONE[campaign.state]}">${STATE_LABEL[campaign.state]}</span>
    <ol class="mc-stepper">${STEPS.map(([key, label], index) => `<li class="${index < at ? "is-done" : index === at ? "is-current" : ""}">
      <button type="button" data-mc-step="${key}"><span class="mc-step-dot">${index < at ? '<i data-lucide="check"></i>' : index + 1}</span><span>${label}</span></button></li>`).join("")}</ol>
    <div class="mc-head-actions">
      <button type="button" data-mc="preview-all"><i data-lucide="eye"></i><span>Переглянути листи</span></button>
      ${at < STEPS.length - 1 ? `<button type="button" class="primary-button" data-mc-step="${STEPS[at + 1][0]}"><span>Далі</span><i data-lucide="arrow-right"></i></button>` : ""}
    </div>
  </header>`;
}

function sequenceHtml(campaign) {
  const locked = started() || campaign.state === "done";
  const nodes = campaign.steps.map((step, index) => {
    const template = templateOf(step.templateId);
    const spin = template && /\{[^{}]*\|[^{}]*\}/.test(`${template.subject} ${template.body.replace(/\{\{[^}]*\}\}/g, "")}`);
    return `${index ? `<div class="mc-connector"></div>
      <div class="mc-node mc-node-delay"><span class="mc-node-badge is-amber"><i data-lucide="hourglass"></i>Затримка</span>
        <label>Чекати <input type="number" min="0" max="30" value="${step.delayDays}" data-mc-delay="${index}" ${locked ? "disabled" : ""} /> робочих днів</label>
        <small class="mc-subtle">Вихідні й державні свята країни одержувача не рахуються.</small></div>` : ""}
      <div class="mc-connector"></div>
      <div class="mc-node mc-node-email">
        <span class="mc-node-badge is-blue"><i data-lucide="mail"></i>Лист ${index + 1}</span>
        ${template ? `<button type="button" class="mc-node-body" data-mc-edit="${index}">
            <strong>${escapeHtml(template.subject)}</strong>
            <span>${escapeHtml(template.body.slice(0, 160))}${template.body.length > 160 ? "…" : ""}</span>
          </button>` : `<button type="button" class="mc-node-body is-empty" data-mc-edit="${index}">Лист не знайдено — відкрийте й напишіть заново</button>`}
        <div class="mc-node-tools">
          ${spin ? '<span class="pill tone-live" title="У темі або тексті є блоки {варіант|варіант}">спінтакс</span>' : ""}
          ${locked ? "" : `<button type="button" class="text-button" data-mc-ab="${index}" title="Варіанти речень і тем: A/B через спінтакс"><i data-lucide="split"></i><span>A/B</span></button>
          <button type="button" class="icon-button mc-danger-text" data-mc-remove="${index}" aria-label="Видалити лист ${index + 1}"><i data-lucide="trash-2"></i></button>`}
        </div>
      </div>
      <div class="mc-connector"></div>
      <div class="mc-node mc-node-condition"><span class="mc-node-badge is-red"><i data-lucide="asterisk"></i>Умова</span>
        <span>Відповів, bounce або відписався — ланцюжок для людини зупиняється. Автовідповідь «у відпустці» переносить наступний лист. Колега з тієї ж компанії відповів — пауза.</span></div>`;
  }).join("");
  return `<section class="mc-canvas">
    <div class="mc-canvas-head"><h2>Автоматизуйте розсилку</h2><p>Ланцюжок, який пройде кожна людина: лист, затримка в робочих днях, наступний лист — з тієї самої пошти, у тому ж треді.</p></div>
    ${locked ? '<p class="esp-notice">Ланцюжок уже почався — листи й затримки не змінюються, інакше люди отримали б різне.</p>' : ""}
    <div class="mc-flow">
      <div class="mc-node mc-node-start"><span class="mc-node-badge is-green">Старт</span>
        <span>Кому: <b>${page.people.length}</b> ${page.people.length === 1 ? "людина" : "людей"}</span>
        <button type="button" class="text-button" data-mc-step="recipients">${page.people.length ? "Змінити одержувачів" : "Додати одержувачів"}</button></div>
      ${nodes}
      ${!locked && campaign.steps.length < MAX_LETTERS ? `<div class="mc-connector"></div>
        <div class="mc-add-menu">
          <button type="button" data-mc="add-letter"><i data-lucide="mail"></i><span>Додати лист</span><i data-lucide="plus"></i></button>
          <button type="button" data-mc="add-letter" data-delay="1"><i data-lucide="hourglass"></i><span>Затримка й лист</span><i data-lucide="plus"></i></button>
          <div class="mc-add-note"><i data-lucide="target"></i><span>Ціль — відповідь: на ній ланцюжок зупиняється сам. LinkedIn-дії — у «Прогріві».</span></div>
        </div>` : campaign.steps.length >= MAX_LETTERS ? '<p class="mc-subtle">Шість листів — максимум ланцюжка.</p>' : ""}
    </div>
    <aside class="mc-palette" aria-label="Блоки">
      <button type="button" data-mc="add-letter" ${locked || campaign.steps.length >= MAX_LETTERS ? "disabled" : ""}><span class="mc-palette-icon is-blue"><i data-lucide="mail"></i></span>Лист</button>
      <button type="button" data-mc="add-letter" data-delay="1" ${locked || campaign.steps.length >= MAX_LETTERS ? "disabled" : ""}><span class="mc-palette-icon is-amber"><i data-lucide="hourglass"></i></span>Затримка</button>
      <button type="button" disabled title="Умова одна для всіх: відповідь, bounce, відписка — стоп"><span class="mc-palette-icon is-red"><i data-lucide="asterisk"></i></span>Умова</button>
      <button type="button" disabled title="Ціль — відповідь"><span class="mc-palette-icon is-violet"><i data-lucide="target"></i></span>Ціль</button>
    </aside>
  </section>`;
}

function recipientsHtml(campaign) {
  const counts = page.people.reduce((map, person) => ({ ...map, [person.status]: (map[person.status] || 0) + 1 }), {});
  const result = page.peopleResult;
  const shown = page.people.slice(0, 300);
  return `<section class="mc-step-page">
    <div class="mc-step-intro"><h2>Одержувачі</h2><p>Кожна людина проходить перевірки ще до додавання — виключення, відписки, bounce, правило 90 днів, джерело, країна, службові адреси — і ще раз перед кожним листом.</p></div>
    <div class="mc-counts">
      <span><b>${page.people.length}</b> у кампанії</span>
      ${Object.entries(counts).map(([status, count]) => `<span><b>${count}</b> ${escapeHtml(PERSON_STATE[status] || status)}</span>`).join("")}
    </div>
    ${campaign.state === "done" ? "" : `<form class="mc-import" data-mc-form="people">
      <textarea data-mc-input="people" rows="5" placeholder="Рядок на людину: email, ім'я, компанія, країна, часовий пояс, джерело, дата джерела, верифікація, дата перевірки&#10;або вставте таблицю з рядком заголовків (email, name, company, country, source, source_date, verification, verified_at)">${escapeHtml(page.peopleText)}</textarea>
      <div class="mc-import-actions">
        <label class="mc-file"><i data-lucide="upload"></i><span>CSV з комп'ютера</span><input type="file" accept=".csv,.txt,text/csv,text/plain" data-mc-input="people-file" /></label>
        <button type="submit" class="primary-button" ${page.busy ? "disabled" : ""}><i data-lucide="user-plus"></i><span>Додати в кампанію</span></button>
      </div>
    </form>`}
    ${result ? `<div class="mc-import-result">
      <strong>Додано ${result.added}.</strong>
      ${result.skipped.length ? `<p>Не додано ${result.skipped.length}: ${result.skipped.slice(0, 12).map((row) => `${escapeHtml(row.email)} — ${escapeHtml(row.reason === "in_other_campaign" ? `уже в «${row.campaign}»` : result.labels?.[row.email] || row.reason)}`).join("; ")}${result.skipped.length > 12 ? "…" : ""}</p>` : ""}
      ${result.waiting.length ? `<p>Додано, але чекають даних ${result.waiting.length}: ${result.waiting.slice(0, 12).map((row) => `${escapeHtml(row.email)} — ${escapeHtml(row.label)}`).join("; ")}${result.waiting.length > 12 ? "…" : ""}</p>` : ""}
      ${result.rejected.length ? `<p>Рядків без адреси: ${result.rejected.length}.</p>` : ""}
    </div>` : ""}
    ${page.people.length ? `<div class="table-wrap"><table class="mc-table mc-people">
      <thead><tr><th>Людина</th><th>Пошта</th><th>Лист</th><th>Стан</th><th>Наступний</th></tr></thead>
      <tbody>${shown.map((person) => `<tr>
        <td><strong>${escapeHtml(person.email)}</strong><small>${escapeHtml([person.name, person.company, person.country].filter(Boolean).join(" · "))}</small></td>
        <td>${escapeHtml(person.sender || "— після вибору пошт")}</td>
        <td>${person.step} / ${campaign.steps.length}</td>
        <td>${escapeHtml(PERSON_STATE[person.status] || person.status)}${person.reason ? `<small>${escapeHtml(STOP_REASON[person.reason] || person.reason)}</small>` : ""}${person.recheck ? "<small>на повторну перевірку</small>" : ""}</td>
        <td>${escapeHtml(person.nextDueDate || (person.status === "active" ? "з першим вікном" : "—"))}</td>
      </tr>`).join("")}</tbody></table></div>${page.people.length > shown.length ? `<p class="mc-subtle">І ще ${page.people.length - shown.length}.</p>` : ""}`
      : '<div class="empty-state">Одержувачів ще немає.</div>'}
  </section>`;
}

/** Тег, за яким зараз відфільтровані пошти: обраний, інакше «Розсилка», коли хоч одна пошта її має. */
function senderTagOf(senders) {
  if (page.senderTag !== null) return page.senderTag;
  return senders.some((sender) => (sender.tags || []).includes("Розсилка")) ? "Розсилка" : "";
}

/** Позначену пошту видно завжди — інакше фільтр мовчки ховав би, з чого вже йде кампанія. */
function senderHidden(sender, campaign, tag) {
  if (!tag || campaign.senders.includes(sender.email)) return false;
  const tags = sender.tags || [];
  return tag === "-" ? tags.length > 0 : !tags.includes(tag);
}

function senderTagPills(sender) {
  const tags = sender.tags || [];
  if (!tags.length) return "";
  return `<span class="mc-sender-tags">${tags.map((tag) => `<span class="mc-sender-tag${tag === "Розсилка" ? " is-send" : tag === "Прогрів" ? " is-warm" : ""}">${escapeHtml(tag)}</span>`).join("")}</span>`;
}

function senderTagFilterHtml(senders) {
  const catalog = page.limits?.tagCatalog || [];
  if (!catalog.length) return "";
  const tag = senderTagOf(senders);
  const option = (value, label) => `<option value="${escapeAttr(value)}" ${tag === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
  return `<label class="mc-sender-filter"><span>Тег</span><select data-mc-sender-tag>${option("", "Усі пошти")}${catalog.map((name) => option(name, name)).join("")}${option("-", "Без тегу")}</select></label>`;
}

function sendingHtml(campaign) {
  const limits = page.limits;
  const usable = (limits?.senders || []).filter((sender) => sender.status === "active" || campaign.senders.includes(sender.email));
  const signature = page.signature || {};
  const window_ = limits?.window || { startHour: 8, endHour: 17 };
  return `<section class="mc-step-page">
    <div class="mc-step-intro"><h2>Параметри відправки</h2><p>З яких пошт іде кампанія і як. Людина отримує весь ланцюжок з однієї пошти; нові люди розподіляються на найменш завантажену.</p></div>
    <form class="mc-sending" data-mc-form="sending">
      <fieldset class="mc-fieldset"><legend>Пошти</legend>
        ${senderTagFilterHtml(usable)}
        ${usable.length ? usable.map((sender) => `<label class="mc-sender" data-mc-sender-tags="${escapeAttr((sender.tags || []).join("|"))}" ${senderHidden(sender, campaign, senderTagOf(usable)) ? "hidden" : ""}>
            <input type="checkbox" name="sender" value="${escapeAttr(sender.email)}" ${campaign.senders.includes(sender.email) ? "checked" : ""} ${campaign.state === "done" ? "disabled" : ""} />
            <span><strong>${escapeHtml(sender.email)}</strong><small>${sender.status === "active" ? "надсилає" : "на паузі"} · сьогодні ${sender.today} з ${sender.limit} · етап рампи ${sender.rampStage ?? "—"}</small>${senderTagPills(sender)}</span>
            <span class="mc-meter"><span style="width:${percent(sender.today, sender.limit)}%"></span></span>
          </label>`).join("") : '<p class="esp-notice is-bad">У реєстрі немає жодної активної пошти. Додайте пошту: «Пошта» → «Пошти» → «Додати пошту».</p>'}
        <button type="button" class="text-button" data-mc="add-mailbox"><i data-lucide="mail-plus"></i><span>Додати пошту</span></button>
      </fieldset>
      <fieldset class="mc-fieldset"><legend>Варіанти тексту (A/B)</legend>
        ${SPIN_MODES.map(([value, label, hint]) => `<label class="mc-radio"><input type="radio" name="spinMode" value="${value}" ${(campaign.spinMode || "all") === value ? "checked" : ""} ${started() ? "disabled" : ""} /><span><strong>${label}</strong><small>${hint}</small></span></label>`).join("")}
        ${started() ? '<small class="mc-subtle">Ланцюжок почався — режим не змінюється, інакше A/B порівнював би різне.</small>' : ""}
      </fieldset>
      <div class="mc-form-actions"><button type="submit" class="primary-button" ${page.busy || campaign.state === "done" ? "disabled" : ""}><i data-lucide="save"></i><span>Зберегти</span></button></div>
    </form>
    <div class="mc-rules">
      <h3>Як іде відправка — однаково для всіх кампаній</h3>
      <ul>
        <li><i data-lucide="clock"></i>Пн–Пт, ${String(window_.startHour).padStart(2, "0")}:00–${window_.endHour}:00 за часом одержувача; державні свята його країни пропускаються.</li>
        <li><i data-lucide="timer"></i>Між листами однієї пошти — ${limits?.gapMinutes?.min ?? 12}–${limits?.gapMinutes?.max ?? 40} хв, перший лист дня — не на відкритті вікна. Пропущене не доганяється.</li>
        <li><i data-lucide="gauge"></i>Пошта — до свого етапу рампи (5 → 35 на день), домен — до ${limits?.domainLimit ?? 105} на день.</li>
        <li><i data-lucide="building-2"></i>З однієї компанії — до 2 нових людей на день; повторно людині — не раніше ніж через 90 днів.</li>
        <li><i data-lucide="file-text"></i>Лише простий текст, посилання для відписки в один клік; без пікселів і переписаних посилань.</li>
      </ul>
    </div>
    <form class="mc-signature" data-mc-form="signature">
      <h3>Підпис під кожним листом</h3>
      <div class="mc-signature-grid">
        <input name="name" placeholder="Ім'я" value="${escapeAttr(signature.name || "")}" />
        <input name="title" placeholder="Посада" value="${escapeAttr(signature.title || "")}" />
        <input name="company" placeholder="Компанія" value="${escapeAttr(signature.company || "ADvantage")}" />
        <input name="site" placeholder="Сайт" value="${escapeAttr(signature.site || "")}" />
      </div>
      <textarea name="usPostalAddress" rows="2" placeholder="Поштова адреса юрособи — додається лише для лідів зі США">${escapeHtml(signature.usPostalAddress || "")}</textarea>
      <div class="mc-form-actions"><button type="submit" ${page.busy ? "disabled" : ""}><i data-lucide="pen-line"></i><span>Зберегти підпис</span></button><small class="mc-subtle">Підпис спільний для всіх кампаній.</small></div>
    </form>
  </section>`;
}

function reviewChecks(campaign) {
  const waitingSenders = page.people.filter((person) => !person.sender).length;
  return [
    [campaign.steps.length > 0, campaign.steps.length ? `${campaign.steps.length} ${campaign.steps.length === 1 ? "лист" : "листи"} у ланцюжку` : "Немає жодного листа", "sequence"],
    [campaign.steps.length > 0 && campaign.steps.every((step) => templateOf(step.templateId)), "Кожен лист написаний і знайдений", "sequence"],
    [page.people.length > 0, page.people.length ? `${page.people.length} одержувачів` : "Немає одержувачів", "recipients"],
    [campaign.senders.length > 0, campaign.senders.length ? `Пошти: ${campaign.senders.join(", ")}` : "Не обрано пошт", "sending"],
    [!waitingSenders || campaign.senders.length > 0, waitingSenders ? `${waitingSenders} людей отримають пошту при запуску` : "Кожна людина має пошту", "sending"],
    [!page.halt?.on, page.halt?.on ? "Увімкнено «Стоп усе»" : "«Стоп усе» вимкнено", null],
    [page.sequenceOn, page.sequenceOn ? "Відправка на сервері увімкнена" : "Відправку на сервері вимкнено — кампанія стоятиме, доки її не ввімкнуть (ESP 11)", null]
  ];
}

function reviewHtml(campaign) {
  const checks = reviewChecks(campaign);
  const ready = checks.slice(0, 4).every(([ok]) => ok);
  const sample = page.people.find((person) => person.email === page.sampleEmail);
  return `<section class="mc-step-page">
    <div class="mc-step-intro"><h2>Перевірка перед запуском</h2><p>Нічого не надсилається звідси: запуск лише дозволяє ланцюжку на сервері брати людей цієї кампанії у вікна відправки.</p></div>
    <ul class="mc-checklist">${checks.map(([ok, label, step]) => `<li class="${ok ? "is-ok" : "is-bad"}"><i data-lucide="${ok ? "circle-check" : "circle-alert"}"></i><span>${escapeHtml(label)}</span>${!ok && step ? `<button type="button" class="text-button" data-mc-step="${step}">Виправити</button>` : ""}</li>`).join("")}</ul>
    <div class="mc-review-actions">
      ${campaign.state === "draft" || campaign.state === "paused" ? `<button type="button" class="primary-button" data-mc-state="running" data-id="${escapeAttr(campaign.id)}" ${ready && !page.busy ? "" : "disabled"}><i data-lucide="play"></i><span>${campaign.state === "draft" ? "Запустити кампанію" : "Продовжити кампанію"}</span></button>` : ""}
      ${campaign.state === "running" ? `<button type="button" data-mc-state="paused" data-id="${escapeAttr(campaign.id)}"><i data-lucide="pause"></i><span>Пауза</span></button>` : ""}
      ${campaign.state === "running" || campaign.state === "paused" ? `<button type="button" class="danger-button" data-mc-state="done" data-id="${escapeAttr(campaign.id)}"><i data-lucide="archive"></i><span>Завершити</span></button>` : ""}
      <button type="button" data-mc="plan"><i data-lucide="list-checks"></i><span>Що піде зараз</span></button>
    </div>
    ${planHtml()}
    <div class="mc-preview-block">
      <div class="mc-preview-head"><h3>Як листи прийдуть людині</h3>
        ${page.people.length ? `<select data-mc-input="sample" aria-label="Одержувач для перегляду">${page.people.slice(0, 200).map((person) => `<option value="${escapeAttr(person.email)}" ${person.email === page.sampleEmail ? "selected" : ""}>${escapeHtml(person.name ? `${person.name} · ${person.email}` : person.email)}</option>`).join("")}</select>` : '<span class="mc-subtle">Додайте одержувачів — перегляд піде на першого; поки — на приклад.</span>'}
        <button type="button" data-mc="preview-all"><i data-lucide="eye"></i><span>Показати</span></button>
      </div>
      ${campaign.steps.map((step, index) => previewHtml(index, page.previews[index], sample)).join("")}
    </div>
  </section>`;
}

function planHtml() {
  const plan = page.plan;
  if (!plan) return "";
  if (plan.error) return `<p class="esp-notice is-bad">${escapeHtml(plan.error)}</p>`;
  const mine = (plan.planned || []).filter((row) => !row.campaignId || row.campaignId === page.openId);
  return `<div class="mc-plan">
    <strong>Якби ланцюжок ішов цієї хвилини: ${mine.length} ${mine.length === 1 ? "лист" : "листів"}</strong>
    ${mine.slice(0, 20).map((row) => `<p>${escapeHtml(row.sender)} → ${escapeHtml(row.email)} · лист ${row.step} · «${escapeHtml(row.subject)}»</p>`).join("")}
    ${Object.keys(plan.skipped || {}).length ? `<small>Чекають: ${Object.entries(plan.skipped).map(([reason, count]) => `${escapeHtml(SKIP_REASON[reason] || reason)} — ${count}`).join(" · ")}</small>` : ""}
  </div>`;
}

/** A draft with each empty variable marked: the letter, and where it has a hole. */
function markedHtml(text) {
  return escapeHtml(text).replace(/⟦([a-z_]+)⟧/g, '<mark class="mc-hole" title="У цієї людини порожньо, заміни в шаблоні немає">{{$1}}</mark>');
}

function holeWarning(preview) {
  const names = (preview.variables || []).map((name) => `{{${name}}}`).join(", ");
  return `<p class="esp-notice is-warn"><i data-lucide="triangle-alert"></i> Цій людині лист не піде: порожнє ${escapeHtml(names)}. Додайте заміну — <code>{{${escapeHtml(preview.variables?.[0] || "first_name")}|…}}</code> — або дані людині.</p>`;
}

function previewHtml(index, preview, sample) {
  if (!preview) return `<article class="mc-letter is-pending"><span class="mc-node-badge is-blue"><i data-lucide="mail"></i>Лист ${index + 1}</span><span class="mc-subtle">Натисніть «Показати».</span></article>`;
  if (!preview.ok && preview.draft) {
    return `<article class="mc-letter"><span class="mc-node-badge is-blue"><i data-lucide="mail"></i>Лист ${index + 1}</span>${holeWarning(preview)}
      <dl class="mc-letter-head"><div><dt>Кому</dt><dd>${escapeHtml(sample?.email || sampleLead().email)}</dd></div><div><dt>Тема</dt><dd>${markedHtml(index ? `Re: ${preview.draft.subject}` : preview.draft.subject)}</dd></div></dl>
      <pre>${markedHtml(preview.draft.body)}</pre></article>`;
  }
  if (!preview.ok) return `<article class="mc-letter"><span class="mc-node-badge is-blue"><i data-lucide="mail"></i>Лист ${index + 1}</span><p class="esp-notice is-bad">${escapeHtml(preview.error || "Цій людині лист не піде.")}</p></article>`;
  return `<article class="mc-letter">
    <span class="mc-node-badge is-blue"><i data-lucide="mail"></i>Лист ${index + 1}</span>
    <dl class="mc-letter-head"><div><dt>Кому</dt><dd>${escapeHtml(sample?.email || sampleLead().email)}</dd></div><div><dt>Тема</dt><dd>${escapeHtml(index ? `Re: ${preview.subject}` : preview.subject)}</dd></div></dl>
    <pre>${escapeHtml(preview.text)}</pre>
    <small class="mc-subtle">${escapeHtml(preview.contentType || "text/plain")} · ${preview.bytes} байт · List-Unsubscribe: ${preview.listUnsubscribe ? "є" : "немає"} · нічого не надіслано</small>
  </article>`;
}

function builderHtml(campaign) {
  const body = page.step === "recipients" ? recipientsHtml(campaign)
    : page.step === "sending" ? sendingHtml(campaign)
      : page.step === "review" ? reviewHtml(campaign) : sequenceHtml(campaign);
  return `${stepperHtml(campaign)}${noticeHtml()}<div class="mc-builder-body">${body}</div>`;
}

// ── редактор листа (скрін 08) ───────────────────────────────────────────────

function openEditor({ index = null, templateId = null, library = false, ab = false } = {}) {
  const campaign = current();
  const id = templateId ?? (index !== null ? campaign?.steps[index]?.templateId : null);
  const template = id ? templateOf(id) : null;
  // Лист 2+ — відповідь у треді першого: тема в нього «Re: …» першого листа, не своя.
  const position = index ?? campaign?.steps.length ?? 0;
  const followUp = !library && position > 0;
  page.editor = {
    index, library, followUp, templateId: template?.id || null,
    name: template?.name || "",
    subject: template?.subject || "",
    body: template?.body || (ab ? "" : ""),
    menu: null, preview: null, notice: ab ? "A/B: впишіть у тему чи речення варіанти в дужках — {Варіант 1|Варіант 2}. Кожна людина отримає один; у «Параметрах відправки» — кому їх показувати." : "", tone: "", busy: false, lastField: "body"
  };
  renderCampaignsPage();
  window.setTimeout(() => rootEl()?.querySelector(ab || !template ? "[data-mc-editor=subject]" : "[data-mc-editor=body]")?.focus(), 0);
}

function editorHtml() {
  const editor = page.editor;
  if (!editor) return "";
  const campaign = current();
  const title = editor.library ? (editor.templateId ? "Шаблон листа" : "Новий шаблон") : `Лист ${editor.index === null ? (campaign?.steps.length || 0) + 1 : editor.index + 1}`;
  const variables = page.variables;
  const menu = editor.menu === "variable" ? `<div class="mc-dropdown" role="menu">
      <button type="button" role="menuitem" data-mc-insert="{Варіант 1|Варіант 2}">Спінтакс — варіанти<code>{А|Б}</code></button>
      <div class="mc-dropdown-sep"></div>
      ${variables.map((variable) => `<button type="button" role="menuitem" data-mc-insert="{{${escapeAttr(variable.name)}}}">${escapeHtml(variable.label)}<code>{{${escapeHtml(variable.name)}}}</code></button>`).join("")}
      <div class="mc-dropdown-sep"></div>
      <span class="mc-dropdown-note">Заміна для порожньої змінної: <code>{{first_name|there}}</code>. Порожня без заміни — лист цій людині не піде.</span>
    </div>`
    : editor.menu === "template" ? `<div class="mc-dropdown" role="menu">
      ${libraryTemplates().length ? libraryTemplates().map((template) => `<button type="button" role="menuitem" data-mc-use-template="${escapeAttr(template.id)}"><i data-lucide="file-text"></i>${escapeHtml(template.name || template.subject)}</button>`).join("") : '<span class="mc-dropdown-note">У бібліотеці ще немає шаблонів.</span>'}
    </div>`
      : editor.menu === "unsubscribe" ? `<div class="mc-dropdown mc-dropdown-wide" role="note">
      <span class="mc-dropdown-note">Посилання для відписки додається саме: заголовки List-Unsubscribe і List-Unsubscribe-Post (кнопка «Відписатися» в Gmail, одним кліком) і рядок під підписом з посиланням на домен пошти. Вставляти його в текст не треба.</span>
    </div>` : "";
  const preview = editor.preview;
  return `<div class="mc-modal-backdrop" data-mc="editor-close"></div>
    <section class="mc-modal mc-editor" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
      <header><h2>${escapeHtml(title)}</h2><button type="button" class="icon-button" data-mc="editor-close" aria-label="Закрити"><i data-lucide="x"></i></button></header>
      ${editor.library ? `<input class="mc-editor-name" data-mc-editor="name" placeholder="Назва шаблону — бачите лише ви" value="${escapeAttr(editor.name)}" />` : ""}
      <div class="mc-editor-frame">
        ${editor.followUp
          ? `<div class="mc-subject"><b>Тема:</b><span>Re: ${escapeHtml(firstSubject() || "тема першого листа")}</span><small class="mc-subtle">відповідь у тому ж треді — тема не змінюється</small></div>`
          : `<label class="mc-subject"><b>Тема:</b><input data-mc-editor="subject" placeholder="Коротко й по-людськи" value="${escapeAttr(editor.subject)}" /></label>`}
        <div class="mc-editor-toolbar">
          <div class="mc-tool"><button type="button" data-mc-menu-tool="template"><i data-lucide="file-text"></i><span>Шаблон</span><i data-lucide="chevron-down"></i></button>${editor.menu === "template" ? menu : ""}</div>
          <div class="mc-tool"><button type="button" data-mc-menu-tool="variable" class="${editor.menu === "variable" ? "is-open" : ""}"><i data-lucide="braces"></i><span>Змінна</span><i data-lucide="chevron-${editor.menu === "variable" ? "up" : "down"}"></i></button>${editor.menu === "variable" ? menu : ""}</div>
          <div class="mc-tool"><button type="button" data-mc-menu-tool="unsubscribe"><i data-lucide="mail-x"></i><span>Посилання для відписки</span></button>${editor.menu === "unsubscribe" ? menu : ""}</div>
          <span class="mc-plain" title="Лист іде однією частиною text/plain: без HTML, без пікселя відкриттів, без переписаних посилань"><i data-lucide="type"></i>Лише простий текст</span>
        </div>
        <textarea data-mc-editor="body" placeholder="Напишіть або вставте текст листа. Форматування з Google Docs знімається при збереженні.">${escapeHtml(editor.body)}</textarea>
      </div>
      ${editor.notice ? `<p class="esp-notice ${editor.tone}">${escapeHtml(editor.notice)}</p>` : ""}
      ${page.liveSend ? "" : '<p class="mc-subtle mc-test-note"><i data-lucide="lock"></i> «Надіслати тест собі» неактивна: справжню відправку ще не ввімкнено (ESP_LIVE_SEND, після приймання ESP 11). Поки — «Переглянути й перевірити»: лист такий, як піде.</p>'}
      ${preview ? `<div class="mc-editor-preview">${preview.ok
        ? `<dl class="mc-letter-head"><div><dt>Кому</dt><dd>${escapeHtml(preview.to)}</dd></div><div><dt>Тема</dt><dd>${escapeHtml(preview.subject)}</dd></div></dl><pre>${escapeHtml(preview.text)}</pre><small class="mc-subtle">${escapeHtml(preview.contentType)} · ${preview.bytes} байт · з підписом і відпискою, як піде · нічого не надіслано</small>`
        : preview.draft
          ? `${holeWarning(preview)}<dl class="mc-letter-head"><div><dt>Кому</dt><dd>${escapeHtml(preview.to)}</dd></div><div><dt>Тема</dt><dd>${markedHtml(editor.followUp ? `Re: ${preview.draft.subject}` : preview.draft.subject)}</dd></div></dl><pre>${markedHtml(preview.draft.body)}</pre>`
          : `<p class="esp-notice is-bad">${escapeHtml(preview.error || "Такий лист не піде.")}</p>`}</div>` : ""}
      <footer>
        <button type="button" class="primary-button" data-mc="editor-save" ${editor.busy ? "disabled" : ""}><i data-lucide="save"></i><span>${editor.busy ? "Зберігаємо..." : "Зберегти"}</span></button>
        <div class="mc-toolbar-spacer"></div>
        <button type="button" data-mc="editor-preview" ${editor.busy ? "disabled" : ""}><i data-lucide="eye"></i><span>Переглянути й перевірити</span></button>
        <button type="button" data-mc="editor-test" ${editor.busy || !page.liveSend ? "disabled" : ""} title="${escapeAttr(page.liveSend ? `Лист піде вам на ${myEmail()} з ${sampleMailbox()}, через ті самі перевірки, що й справжні` : "Справжню відправку ще не ввімкнено (ESP_LIVE_SEND, після приймання ESP 11) — тест на вашу пошту з'явиться разом із нею")}"><i data-lucide="send"></i><span>Надіслати тест собі</span></button>
        ${editor.library ? "" : `<button type="button" data-mc="editor-save-template" ${editor.busy ? "disabled" : ""}><i data-lucide="bookmark-plus"></i><span>Зберегти як шаблон</span></button>`}
      </footer>
    </section>`;
}

/** Тема першого листа кампанії — її в треді продовжують наступні. */
function firstSubject() {
  const first = current()?.steps[0];
  return first ? templateOf(first.templateId)?.subject || "" : "";
}

function readEditor() {
  const root = rootEl();
  const editor = page.editor;
  if (!root || !editor) return;
  for (const field of ["name", "subject", "body"]) {
    const input = root.querySelector(`[data-mc-editor=${field}]`);
    if (input) editor[field] = input.value;
  }
  // Збережена тема наступного листа — тема першого: лист у треді все одно
  // піде з «Re: …» першого, а шаблон без теми не зберігається.
  if (editor.followUp) editor.subject = firstSubject() || editor.subject || "Follow-up";
}

function insertIntoEditor(text) {
  const editor = page.editor;
  const field = rootEl()?.querySelector(`[data-mc-editor=${editor.lastField === "subject" ? "subject" : "body"}]`);
  if (!field) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.value = `${field.value.slice(0, start)}${text}${field.value.slice(end)}`;
  readEditor();
  editor.menu = null;
  renderCampaignsPage();
  const again = rootEl()?.querySelector(`[data-mc-editor=${editor.lastField === "subject" ? "subject" : "body"}]`);
  again?.focus();
  again?.setSelectionRange(start + text.length, start + text.length);
}

const REMOVED_LABEL = { html: "HTML-теги", styles: "стилі", nbsp: "нерозривні пробіли", invisible: "невидимі символи", entities: "HTML-сутності" };

async function saveEditor({ asTemplate = false } = {}) {
  readEditor();
  const editor = page.editor;
  const campaign = current();
  editor.busy = true;
  renderCampaignsPage();
  try {
    let saved;
    if (asTemplate) {
      const name = window.prompt("Назва шаблону:", editor.subject.slice(0, 60));
      if (!name?.trim()) { editor.busy = false; renderCampaignsPage(); return; }
      saved = await api("/api/esp/templates", { method: "POST", body: JSON.stringify({ name, subject: editor.subject, body: editor.body }) });
      editor.notice = `Збережено в бібліотеку як «${saved.template.name}».`;
    } else if (editor.library) {
      saved = await api("/api/esp/templates", { method: editor.templateId ? "PATCH" : "POST", body: JSON.stringify({ id: editor.templateId, name: editor.name || editor.subject, subject: editor.subject, body: editor.body }) });
      editor.templateId = saved.template.id;
      editor.notice = "Шаблон збережено.";
    } else {
      const own = editor.templateId && templateOf(editor.templateId)?.campaignId === campaign.id;
      saved = await api("/api/esp/templates", {
        method: own ? "PATCH" : "POST",
        body: JSON.stringify({ id: own ? editor.templateId : undefined, name: `${campaign.name} — лист ${(editor.index ?? campaign.steps.length) + 1}`, subject: editor.subject, body: editor.body, campaignId: campaign.id })
      });
      if (!own) {
        // Новий лист — або копія шаблону з бібліотеки: у крок іде власний лист кампанії.
        const steps = campaign.steps.map((step) => ({ ...step }));
        if (editor.index === null) steps.push({ templateId: saved.template.id, delayDays: editor.delay ?? (steps.length ? 3 : 0) });
        else steps[editor.index].templateId = saved.template.id;
        await saveCampaign({ steps });
        if (editor.index === null) editor.index = steps.length - 1;
      }
      editor.templateId = saved.template.id;
      editor.notice = "Збережено.";
    }
    const removed = (saved.removed || []).map((key) => REMOVED_LABEL[key] || key);
    if (removed.length) editor.notice += ` Прибрано: ${removed.join(", ")} — у листі лише простий текст.`;
    editor.tone = "is-ok";
    page.previews = {};
    editor.busy = false;
    await loadCampaignsPage();
  } catch (error) {
    editor.notice = error.message || "Не вдалося зберегти.";
    editor.tone = "is-bad";
    editor.busy = false;
    renderCampaignsPage();
  }
}

function sampleLead() {
  const person = page.people.find((row) => row.email === page.sampleEmail) || page.people[0];
  return person ? { email: person.email, name: person.name, company: person.company, country: person.country } : { email: "olena@northwind.co.uk", name: "Olena Hrytsenko", company: "Northwind", country: "United Kingdom" };
}

function sampleMailbox() {
  return current()?.senders[0] || page.limits?.senders?.find((sender) => sender.status === "active")?.email || "sender@your-domain.com";
}

async function previewEditor() {
  readEditor();
  const editor = page.editor;
  const lead = sampleLead();
  try {
    const answer = await api("/api/esp/preview", { method: "POST", body: JSON.stringify({ subject: editor.subject, body: editor.body, lead, mailbox: sampleMailbox() }) });
    editor.preview = { ...answer, to: lead.email, subject: editor.followUp && answer.ok ? `Re: ${answer.subject}` : answer.subject };
  } catch (error) {
    editor.preview = { ok: false, error: error.message };
  }
  renderCampaignsPage();
}

function myEmail() {
  return authState?.user?.email || "вашу пошту";
}

async function sendTest() {
  readEditor();
  const editor = page.editor;
  editor.busy = true;
  renderCampaignsPage();
  try {
    const answer = await api("/api/esp/test-send", { method: "POST", body: JSON.stringify({ subject: editor.subject, body: editor.body, lead: sampleLead(), mailbox: sampleMailbox() }) });
    editor.notice = answer.ok ? `Тест надіслано на ${answer.to} з ${answer.mailbox}.` : answer.error || "Тест не пішов.";
    editor.tone = answer.ok ? "is-ok" : "is-bad";
  } catch (error) {
    editor.notice = error.message || "Тест не пішов.";
    editor.tone = "is-bad";
  }
  editor.busy = false;
  renderCampaignsPage();
}

async function previewAll() {
  const campaign = current();
  const lead = sampleLead();
  page.previews = {};
  for (const [index, step] of campaign.steps.entries()) {
    page.previews[index] = await api("/api/esp/preview", { method: "POST", body: JSON.stringify({ templateId: step.templateId, lead, mailbox: sampleMailbox() }) })
      .catch((error) => ({ ok: false, error: error.message }));
  }
  page.step = "review";
  writeRoute();
  renderCampaignsPage();
}

// ── малювання ────────────────────────────────────────────────────────────────

export function renderCampaignsPage() {
  const root = rootEl();
  if (!root) return;
  if (!page.ready) { root.innerHTML = '<div class="empty-state">Читаємо кампанії...</div>'; return; }
  if (page.error) { root.innerHTML = `<div class="empty-state">${escapeHtml(page.error)}</div>`; return; }
  const campaign = current();
  root.innerHTML = `${campaign ? builderHtml(campaign) : listHtml()}${chooserHtml()}${editorHtml()}`;
  // «Перевірка» одразу показує листи першому одержувачу — не по кнопці.
  if (campaign && page.step === "review" && campaign.steps.length && !Object.keys(page.previews).length && !page.previewing) {
    page.previewing = true;
    void previewAll().finally(() => { page.previewing = false; });
  }
  root.classList.toggle("is-builder", Boolean(campaign));
  refreshIcons(root);
}

function exportCsv() {
  const rows = page.campaigns.filter((campaign) => !page.selected.size || page.selected.has(campaign.id));
  const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [["Кампанія", "Стан", "Створено", "Одержувачів", "Листів у ланцюжку", "Надіслано", "Відповіді", "Bounce", "Відписки", "Пошти"].map(cell).join(",")]
    .concat(rows.map((campaign) => [campaign.name, STATE_LABEL[campaign.state], campaign.createdAt, campaign.people, campaign.steps.length, campaign.sent, campaign.replied, campaign.bounced, campaign.unsubscribed, campaign.senders.join(" ")].map(cell).join(",")));
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }));
  link.download = `campaigns-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function goToSettings() {
  document.querySelector('.nav-item[data-view="account"]')?.click();
}

// ── дії ──────────────────────────────────────────────────────────────────────

async function changeState(id, state) {
  const campaign = byId(id);
  if (state === "done" && !window.confirm(`Завершити «${campaign?.name}»? Ті, хто ще в ланцюжку, більше нічого з неї не отримають.`)) return;
  page.menuFor = null;
  await act(() => api("/api/esp/campaigns/state", { method: "POST", body: JSON.stringify({ id, state }) }),
    { success: { running: "Кампанію запущено: ланцюжок братиме її людей у вікна відправки.", paused: "Кампанію поставлено на паузу.", done: "Кампанію завершено." }[state] });
}

async function deleteCampaigns(ids) {
  const names = ids.map((id) => `«${byId(id)?.name}»`).join(", ");
  if (!window.confirm(`Видалити ${ids.length === 1 ? "кампанію" : `${ids.length} кампанії`} ${names}? Разом з людьми й листами цієї кампанії. Відмінити не можна.`)) return;
  page.menuFor = null;
  await act(async () => {
    for (const id of ids) await api(`/api/esp/campaigns?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    ids.forEach((id) => page.selected.delete(id));
  }, { success: ids.length === 1 ? "Кампанію видалено." : `Видалено кампаній: ${ids.length}.` });
}

async function archiveCampaigns(ids, archived) {
  page.menuFor = null;
  await act(async () => {
    for (const id of ids) await api("/api/esp/campaigns/archive", { method: "POST", body: JSON.stringify({ id, archived }) });
    ids.forEach((id) => page.selected.delete(id));
  }, { success: archived ? `В архіві: ${ids.length}. Папка «Архів» зліва.` : "Повернуто з архіву." });
}

async function copyCampaign(id) {
  const source = byId(id);
  const letters = source.steps.map((step) => templateOf(step.templateId)).filter(Boolean);
  await createCampaign({ name: `${source.name} (копія)`, letters, steps: source.steps, senders: source.senders, spinMode: source.spinMode });
}

async function removeLetter(index) {
  const campaign = current();
  if (!window.confirm(`Прибрати лист ${index + 1} з ланцюжка?`)) return;
  const steps = campaign.steps.filter((_, at) => at !== index).map((step, at) => ({ ...step, delayDays: at ? step.delayDays : 0 }));
  await act(() => saveCampaign({ steps }), { success: "Лист прибрано." });
}

async function setDelay(index, value) {
  const campaign = current();
  const steps = campaign.steps.map((step, at) => (at === index ? { ...step, delayDays: Math.max(0, Math.min(30, Number(value) || 0)) } : step));
  await act(() => saveCampaign({ steps }), { success: `Затримку перед листом ${index + 1} збережено.` });
}

function onClick(event) {
  const target = event.target;
  const button = target.closest("button, [data-mc]");
  if (!button) {
    if (page.menuFor) { page.menuFor = null; renderCampaignsPage(); }
    return;
  }
  const action = button.dataset.mc;
  const editor = page.editor;

  if (button.dataset.mcFolder) { page.folder = button.dataset.mcFolder; page.menuFor = null; return renderCampaignsPage(); }
  if (button.dataset.mcMenu) { page.menuFor = page.menuFor === button.dataset.mcMenu ? null : button.dataset.mcMenu; return renderCampaignsPage(); }
  if (button.dataset.mcOpen) {
    page.openId = button.dataset.mcOpen;
    page.step = byId(page.openId)?.state === "draft" ? "sequence" : "review";
    page.menuFor = null; page.peopleResult = null; page.plan = null; page.previews = {}; page.notice = "";
    writeRoute();
    return loadCampaignsPage();
  }
  if (button.dataset.mcState) return changeState(button.dataset.id, button.dataset.mcState);
  if (button.dataset.mcCopy) return copyCampaign(button.dataset.mcCopy);
  if (button.dataset.mcDelete) return deleteCampaigns([button.dataset.mcDelete]);
  if (button.dataset.mcArchive) return archiveCampaigns([button.dataset.id], button.dataset.mcArchive === "1");
  if (button.dataset.mcStep) { readEditor(); page.step = button.dataset.mcStep; page.notice = ""; writeRoute(); return renderCampaignsPage(); }
  if (button.dataset.mcEdit !== undefined) return openEditor({ index: Number(button.dataset.mcEdit) });
  if (button.dataset.mcAb !== undefined) return openEditor({ index: Number(button.dataset.mcAb), ab: true });
  if (button.dataset.mcRemove !== undefined) return removeLetter(Number(button.dataset.mcRemove));
  if (button.dataset.mcFromTemplate) {
    const template = templateOf(button.dataset.mcFromTemplate);
    return createCampaign({ name: template.name || draftName(), letters: [template] });
  }
  if (button.dataset.mcTemplateEdit) return openEditor({ templateId: button.dataset.mcTemplateEdit, library: true });
  if (button.dataset.mcTemplateDelete) {
    const template = templateOf(button.dataset.mcTemplateDelete);
    if (!window.confirm(`Видалити шаблон «${template?.name || template?.subject}»? Кампанії, що вже з нього створені, мають власні копії й не зміняться.`)) return;
    return act(() => api(`/api/esp/templates?id=${encodeURIComponent(template.id)}`, { method: "DELETE" }), { success: "Шаблон видалено." });
  }
  if (button.dataset.mcMenuTool && editor) { readEditor(); editor.menu = editor.menu === button.dataset.mcMenuTool ? null : button.dataset.mcMenuTool; return renderCampaignsPage(); }
  if (button.dataset.mcInsert && editor) return insertIntoEditor(button.dataset.mcInsert);
  if (button.dataset.mcUseTemplate && editor) {
    const template = templateOf(button.dataset.mcUseTemplate);
    readEditor();
    if ((editor.subject || editor.body) && !window.confirm("Замінити тему й текст листа шаблоном?")) return;
    Object.assign(editor, { subject: template.subject, body: template.body, menu: null, notice: `Вставлено шаблон «${template.name || template.subject}» — у кампанії буде її власна копія.`, tone: "" });
    return renderCampaignsPage();
  }

  switch (action) {
    case "create":
      if (readSkipChooser()) return createCampaign();
      page.chooser = { mode: "choose" };
      return renderCampaignsPage();
    case "chooser-close": page.chooser = null; return renderCampaignsPage();
    case "chooser-template": page.chooser = { mode: "template" }; return renderCampaignsPage();
    case "chooser-back": page.chooser = { mode: "choose" }; return renderCampaignsPage();
    case "chooser-scratch": return createCampaign();
    case "export": return exportCsv();
    case "bulk-delete": return deleteCampaigns(page.campaigns.filter((campaign) => page.selected.has(campaign.id) && deletable(campaign)).map((campaign) => campaign.id));
    case "bulk-archive": return archiveCampaigns(page.campaigns.filter((campaign) => page.selected.has(campaign.id) && !campaign.archived && campaign.state !== "running").map((campaign) => campaign.id), true);
    case "bulk-clear": page.selected.clear(); return renderCampaignsPage();
    case "add-mailbox": return goToSettings();
    case "halt-on": {
      const reason = window.prompt("«Стоп усе»: чому зупиняємо всю відправку?");
      if (!reason?.trim()) return;
      return act(() => api("/api/esp/halt", { method: "POST", body: JSON.stringify({ on: true, reason }) }), { success: "Відправку зупинено для всієї системи." });
    }
    case "halt-off":
      if (!window.confirm("Відновити відправку для всієї системи?")) return;
      return act(() => api("/api/esp/halt", { method: "POST", body: JSON.stringify({ on: false }) }), { success: "Відправку відновлено." });
    case "alert-prev": page.alertIndex = (page.alertIndex - 1 + page.alerts.length) % page.alerts.length; return renderCampaignsPage();
    case "alert-next": page.alertIndex = (page.alertIndex + 1) % page.alerts.length; return renderCampaignsPage();
    case "select-all": {
      const rows = visibleCampaigns();
      const all = rows.every((campaign) => page.selected.has(campaign.id));
      rows.forEach((campaign) => (all ? page.selected.delete(campaign.id) : page.selected.add(campaign.id)));
      return renderCampaignsPage();
    }
    case "back":
      page.openId = null; page.editor = null; page.notice = "";
      writeRoute();
      return loadCampaignsPage();
    case "add-letter":
      openEditor({});
      page.editor.delay = button.dataset.delay ? 3 : (current()?.steps.length ? 3 : 0);
      return undefined;
    case "template-new": return openEditor({ library: true });
    case "editor-close":
      if (target.closest(".mc-editor") && !target.closest("[data-mc=editor-close]")) return undefined;
      page.editor = null;
      return renderCampaignsPage();
    case "editor-save": return saveEditor();
    case "editor-save-template": return saveEditor({ asTemplate: true });
    case "editor-preview": return previewEditor();
    case "editor-test": return sendTest();
    case "preview-all": return previewAll();
    case "plan":
      return act(async () => { page.plan = await api("/api/esp/campaigns/plan").catch((error) => ({ error: error.message })); }, { reload: false });
    default: return undefined;
  }
}

function onInput(event) {
  const input = event.target;
  if (input.dataset.mcInput === "search") {
    page.search = input.value;
    const caret = input.selectionStart;
    renderCampaignsPage();
    const again = rootEl()?.querySelector("[data-mc-input=search]");
    again?.focus();
    again?.setSelectionRange(caret, caret);
  }
  if (input.dataset.mcInput === "people") page.peopleText = input.value;
}

async function onChange(event) {
  const input = event.target;
  if (input.dataset.mcSelect) {
    if (input.checked) page.selected.add(input.dataset.mcSelect); else page.selected.delete(input.dataset.mcSelect);
    return renderCampaignsPage();
  }
  if (input.dataset.mcInput === "skip-chooser") {
    try { window.localStorage.setItem(SKIP_CHOOSER_KEY, input.checked ? "1" : "0"); } catch {}
    return undefined;
  }
  if (input.dataset.mcInput === "name") {
    const name = input.value.trim();
    if (!name || name === current()?.name) return undefined;
    return act(() => saveCampaign({ name }), { success: "Назву збережено." });
  }
  if (input.dataset.mcSenderTag !== undefined) {
    // Без перемальовування: позначки, ще не збережені, лишаються як є.
    page.senderTag = input.value;
    const campaign = current();
    const form = input.closest("[data-mc-form=sending]");
    for (const label of form?.querySelectorAll(".mc-sender") || []) {
      const box = label.querySelector("input[name=sender]");
      const sender = { email: box.value, tags: label.dataset.mcSenderTags ? label.dataset.mcSenderTags.split("|") : [] };
      label.hidden = senderHidden(sender, { senders: [...(campaign?.senders || []), ...(box.checked ? [box.value] : [])] }, page.senderTag);
    }
    return undefined;
  }
  if (input.dataset.mcDelay !== undefined) return setDelay(Number(input.dataset.mcDelay), input.value);
  if (input.dataset.mcInput === "sample") { page.sampleEmail = input.value; return previewAll(); }
  if (input.dataset.mcInput === "people-file" && input.files?.[0]) {
    page.peopleText = await input.files[0].text();
    return renderCampaignsPage();
  }
  return undefined;
}

async function onSubmit(event) {
  const form = event.target.closest("[data-mc-form]");
  if (!form) return;
  event.preventDefault();
  const campaign = current();
  if (form.dataset.mcForm === "people") {
    const text = form.querySelector("[data-mc-input=people]").value;
    if (!text.trim()) return;
    return act(async () => {
      page.peopleResult = await api("/api/esp/campaigns/leads", { method: "POST", body: JSON.stringify({ id: campaign.id, text }) });
      page.peopleText = "";
    }, { success: "" });
  }
  if (form.dataset.mcForm === "sending") {
    const data = new FormData(form);
    const senders = data.getAll("sender");
    const spinMode = data.get("spinMode");
    return act(() => saveCampaign({ senders, ...(spinMode && !started() ? { spinMode } : {}) }), { success: "Параметри відправки збережено." });
  }
  if (form.dataset.mcForm === "signature") {
    const data = Object.fromEntries(new FormData(form).entries());
    return act(() => api("/api/esp/signature", { method: "PUT", body: JSON.stringify(data) }), { success: "Підпис збережено — він під кожним листом усіх кампаній." });
  }
  return undefined;
}

const root = document.getElementById("mailCampaignsRoot");
root?.addEventListener("click", (event) => void onClick(event));
root?.addEventListener("input", onInput);
root?.addEventListener("change", (event) => void onChange(event));
root?.addEventListener("submit", (event) => void onSubmit(event));
root?.addEventListener("focusin", (event) => {
  const field = event.target.dataset?.mcEditor;
  if (page.editor && (field === "subject" || field === "body")) page.editor.lastField = field;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !rootEl()?.offsetParent) return;
  if (page.editor) { page.editor = null; renderCampaignsPage(); } else if (page.chooser) { page.chooser = null; renderCampaignsPage(); }
});
