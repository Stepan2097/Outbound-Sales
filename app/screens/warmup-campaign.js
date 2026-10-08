// Прогрів — the campaign: which CRM folder feeds which accounts, from which
// day, with which note, and the warm-up schedule by day. The accounts it feeds
// live in warmup-accounts.js.

import {
  autoFeedLine, campaignFeedStart, campaignStateNote
} from "../warmup-view.js";
import {
  escapeAttr, escapeHtml, refreshIcons, state, uaPlural
} from "../core.js";
import {
  WARMUP_CAMPAIGN_STATE_LABEL, WARMUP_CAMPAIGN_TONE, WARMUP_DEFAULT_FROM_DAY, WARMUP_EDITABLE_KINDS, WARMUP_EMPTY_FILTERS, WARMUP_KIND_LABEL, refreshWarmupAccountQueue, renderWarmupProfiles, warmupApi, warmupCount, warmupDuration, warmupState
} from "./warmup-accounts.js";

/** День із поля форми, як рядок: перевіряє його сервер і каже реченням, що не так. */
function warmupFromDayValue() {
  return (document.getElementById("warmupCampaignFromDay")?.value || "").trim();
}

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

export function warmupSelectedCampaign() {
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
export function warmupCampaignAccountIds(campaign) {
  return new Set(campaign?.accountIds || []);
}

export function warmupFolderName(folderId) {
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
export function renderWarmupCampaignDetail() {
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

export function renderWarmupCampaigns({ resetForm = false } = {}) {
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

/** Чи годує ця кампанія акаунт сама — одним реченням; слова в `autoFeedLine`. */
export function warmupAutoFeedHtml(feed) {
  const line = autoFeedLine(feed, WARMUP_DEFAULT_FROM_DAY);
  if (!line) return "";
  return `<p class="warmup-queue-feed ${line.tone}"><i data-lucide="${line.icon}"></i><span>${escapeHtml(line.text)}</span></p>`;
}

/**
 * Folders and the campaigns, in one round. Both are allowed to be missing —
 * the server may not carry them yet — and the panel says so rather than
 * pretending there are no campaigns.
 */
export async function loadWarmupCampaigns({ resetForm = true } = {}) {
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
  // «Редагувати» on another campaign selects it, and the open account's queue
  // has to follow — whether the folder feeds it was read for the one before.
  if (moved) refreshWarmupAccountQueue();
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
  await refreshWarmupAccountQueue();
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
  await refreshWarmupAccountQueue();
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
  await refreshWarmupAccountQueue();
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
  await refreshWarmupAccountQueue();
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
  refreshWarmupAccountQueue();
}

/** Ticking an account is itself a save: the forecast has to follow the tick. */
export function toggleWarmupAccount(accountId, on) {
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
  await refreshWarmupAccountQueue();
}

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

export function renderWarmupStrategy() {
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

export async function loadWarmupStrategy() {
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
