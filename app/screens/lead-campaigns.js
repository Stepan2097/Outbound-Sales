// WorkSpace → кампанії лідгенів (таск f78ffd9a, 16.10.2026; «варіант А» Марка).
//
// Кампанія — стратегія аутріч: папки CRM, з яких її люди, продукт зі «Смислів»,
// сценарій (campaign-plan.js), нагадування й привід хвилі. Людина в кампанії, якщо
// вона в одній із її папок. З прогрівом не пов'язана: прогрів лише додає людей у
// друзі, веде активність і тягне діалоги в портал.

import { api, escapeAttr, escapeHtml, refreshIcons } from "../core.js";
import { loadPitchProducts, pitchProductName, pitchProducts } from "../pitch-products.js";
import { pitchProductOptions } from "../pitch-options.js";
import { bindPlanEditor, emptyPlan, loadScenarios, planSummaryHtml, readPlan, renderPlanEditor, samePlan } from "./campaign-plan.js";

const lead = {
  campaigns: [], folders: [], loaded: false, error: "",
  formOpen: false, editingId: null, saving: false, notice: "", folderQuery: "", openId: null
};

export async function loadLeadCampaigns() {
  try {
    const [campaigns, folders] = await Promise.all([
      api("/api/lead-campaigns"),
      lead.folders.length ? { folders: lead.folders } : api("/api/warmup/folders").catch(() => ({ folders: [] })),
      loadPitchProducts(),
      loadScenarios()
    ]);
    lead.campaigns = campaigns.campaigns || [];
    lead.folders = folders.folders || [];
    lead.loaded = true;
    lead.error = "";
  } catch (error) {
    lead.error = error?.message || "Кампанії не прочиталися.";
  }
  renderLeadCampaigns();
}

const host = () => document.getElementById("leadCampaignPanel");
const planHost = () => document.getElementById("leadCampaignPlan");
const editing = () => lead.campaigns.find((campaign) => campaign.id === lead.editingId) || null;

function folderName(id, campaign) {
  return lead.folders.find((folder) => folder.id === id)?.name || campaign?.folderNames?.[id] || "папка, якої CRM не показує";
}

function rowHtml(campaign) {
  const product = campaign.productId ? pitchProductName(campaign.productId) || campaign.productId : "без продукту";
  const open = lead.openId === campaign.id;
  return `
    <article class="lead-campaign ${campaign.state === "paused" ? "is-paused" : ""}" data-lead-campaign="${escapeAttr(campaign.id)}">
      <div class="lead-campaign-head">
        <div class="lead-campaign-who">
          <strong>${escapeHtml(campaign.name)}</strong>
          <span class="pill ${campaign.state === "active" ? "state-run" : "state-pause"}">${campaign.state === "active" ? "іде" : "пауза"}</span>
        </div>
        <div class="lead-campaign-actions">
          <button class="text-button" type="button" data-lead-open aria-expanded="${open}"><i data-lucide="${open ? "chevron-up" : "route"}"></i><span>Сценарій</span></button>
          <button class="text-button" type="button" data-lead-state="${campaign.state === "active" ? "paused" : "active"}"><i data-lucide="${campaign.state === "active" ? "pause" : "play"}"></i><span>${campaign.state === "active" ? "Пауза" : "Запустити"}</span></button>
          <button class="text-button" type="button" data-lead-edit><i data-lucide="pencil"></i><span>Редагувати</span></button>
        </div>
      </div>
      <dl class="kv">
        <div><dt>Папки CRM</dt><dd>${escapeHtml(campaign.folderIds.map((id) => folderName(id, campaign)).join(", "))}</dd></div>
        <div><dt>Продукт</dt><dd>${escapeHtml(product)}</dd></div>
        <div><dt>Нагадування</dt><dd>через ${escapeHtml(campaign.silentSteps.join(" → "))} роб. дн.</dd></div>
        <div><dt>Ціль</dt><dd>${escapeHtml(campaign.plan?.goal || "—")}</dd></div>
      </dl>
      ${open ? `<div class="lead-campaign-body">${campaign.approach ? `<p class="lead-campaign-meta">Привід хвилі: ${escapeHtml(campaign.approach)}</p>` : ""}${planSummaryHtml(campaign.plan, { open: true })}</div>` : ""}
    </article>`;
}

function foldersPickerHtml(selected) {
  const query = lead.folderQuery.trim().toLowerCase();
  const shown = lead.folders.filter((folder) => selected.has(folder.id) || !query || folder.name.toLowerCase().includes(query));
  return `
    <input type="search" id="leadCampaignFolderQuery" placeholder="Знайти папку" value="${escapeAttr(lead.folderQuery)}" aria-label="Знайти папку" />
    <div class="lead-folders">${shown.map((folder) => `
      <label class="lead-folder ${selected.has(folder.id) ? "is-on" : ""}">
        <input type="checkbox" data-lead-folder value="${escapeAttr(folder.id)}" ${selected.has(folder.id) ? "checked" : ""} />
        <span>${escapeHtml(folder.name)}</span><small>${escapeHtml(String(folder.contactCount ?? ""))}</small>
      </label>`).join("") || '<p class="campaign-form-hint">Таких папок немає.</p>'}</div>`;
}

function formHtml(campaign) {
  return `
    <form class="lead-campaign-form" id="leadCampaignForm">
      <div class="campaign-form-section">
        <h3>Основне</h3>
        <div class="lead-form-grid">
          <label class="warmup-field"><span>Назва</span><input id="leadCampaignName" type="text" maxlength="120" value="${escapeAttr(campaign?.name || "")}" placeholder="Напр.: Оператори, що вже ллють Meta" /></label>
          <label class="warmup-field"><span>Продукт — зі «Смислів»</span><select id="leadCampaignProduct">${pitchProductOptions(pitchProducts(), campaign?.productId || "", escapeAttr, escapeHtml)}</select></label>
        </div>
      </div>
      <div class="campaign-form-section">
        <h3>Папки CRM — люди кампанії</h3>
        <p class="campaign-form-hint">Людина в кампанії, якщо вона в одній із цих папок; у кількох кампаніях — у першій за списком.</p>
        <div id="leadCampaignFolders">${foldersPickerHtml(new Set(campaign?.folderIds || []))}</div>
      </div>
      <div class="campaign-form-section campaign-plan-editor" id="leadCampaignPlan"></div>
      <div class="campaign-form-section">
        <h3>Нагадування й привід</h3>
        <div class="lead-form-grid">
          <label class="warmup-field"><span>Лід мовчить — нагадати через (робочих днів)</span><input id="leadCampaignSteps" type="text" value="${escapeAttr((campaign?.silentSteps || [3, 3]).join(", "))}" placeholder="3, 4, 7" /></label>
          <label class="warmup-field"><span>Привід хвилі, якщо є (конференція, акція)</span><input id="leadCampaignApproach" type="text" maxlength="2000" value="${escapeAttr(campaign?.approach || "")}" placeholder="Напр.: SiGMA World у Римі, 2–5.11" /></label>
        </div>
        <p class="campaign-form-hint">Після останнього нагадування й ще стількох днів тиші — статус CRM «Без відповіді».</p>
      </div>
      <div class="warmup-campaign-form-footer">
        <button class="primary-button" id="leadCampaignSaveBtn" type="submit" ${lead.saving ? "disabled" : ""}><i data-lucide="save"></i><span>${lead.saving ? "Зберігаємо..." : campaign ? "Зберегти" : "Створити кампанію"}</span></button>
        <button class="text-button" type="button" data-lead-cancel><i data-lucide="x"></i><span>Скасувати</span></button>
        ${campaign ? '<button class="text-button warmup-campaign-delete" type="button" data-lead-delete><i data-lucide="trash-2"></i><span>Видалити</span></button>' : ""}
        ${lead.notice ? `<p class="warmup-campaign-problem">${escapeHtml(lead.notice)}</p>` : ""}
      </div>
    </form>`;
}

export function renderLeadCampaigns() {
  const root = host();
  if (!root) return;
  const head = `
    <div class="panel-heading">
      <div>
        <h2 title="Як говоримо з людьми з папки: продукт, сценарій, нагадування.">Кампанії лідгенів</h2>
      </div>
      ${lead.formOpen ? "" : '<button class="primary-button" type="button" data-lead-new><i data-lucide="plus"></i><span>Нова кампанія</span></button>'}
    </div>`;
  let body;
  if (lead.error && !lead.loaded) body = `<div class="empty-state">${escapeHtml(lead.error)}</div>`;
  else if (!lead.loaded) body = '<div class="empty-state">Читаємо кампанії...</div>';
  else if (lead.formOpen) body = formHtml(editing());
  else if (!lead.campaigns.length) body = '<div class="empty-state">Кампаній ще немає. «Нова кампанія» → папка CRM, продукт і шаблон сценарію з артефакту.</div>';
  else body = `<div class="lead-campaign-list">${lead.campaigns.map(rowHtml).join("")}</div>`;
  root.innerHTML = head + body;
  if (lead.formOpen) {
    renderPlanEditor(planHost(), editing()?.plan || {});
    bindPlanEditor(planHost(), {
      onTemplate: (template) => {
        const product = document.getElementById("leadCampaignProduct");
        if (product && !product.value && template.productId && [...product.options].some((option) => option.value === template.productId)) product.value = template.productId;
        const name = document.getElementById("leadCampaignName");
        if (name && !name.value.trim()) name.value = template.name;
      }
    });
  }
  refreshIcons(root);
}

function formValues() {
  const folderIds = [...document.querySelectorAll("#leadCampaignFolders [data-lead-folder]:checked")].map((input) => input.value);
  return {
    name: (document.getElementById("leadCampaignName")?.value || "").trim(),
    productId: document.getElementById("leadCampaignProduct")?.value || null,
    folderIds,
    folderNames: Object.fromEntries(folderIds.map((id) => [id, folderName(id, editing())])),
    plan: readPlan(planHost()) || {},
    silentSteps: (document.getElementById("leadCampaignSteps")?.value || "").split(/[,;\s]+/).filter(Boolean).map(Number),
    approach: (document.getElementById("leadCampaignApproach")?.value || "").trim()
  };
}

async function save() {
  const values = formValues();
  if (!values.name) { lead.notice = "Дайте кампанії назву."; return renderLeadCampaigns(); }
  if (!values.folderIds.length) { lead.notice = "Оберіть хоча б одну папку CRM."; return renderLeadCampaigns(); }
  const current = editing();
  lead.saving = true;
  lead.notice = "";
  try {
    await api("/api/lead-campaigns", { method: current ? "PATCH" : "POST", body: JSON.stringify(current ? { id: current.id, ...values } : values) });
    lead.formOpen = false;
    lead.editingId = null;
    lead.saving = false;
    await loadLeadCampaigns();
    return;
  } catch (error) {
    lead.notice = error?.message || "Кампанія не зберіглась.";
  }
  lead.saving = false;
  // Форма перемальовується — те, що вже введено, не губиться.
  const keep = values;
  renderLeadCampaigns();
  restoreForm(keep);
}

function restoreForm(values) {
  const set = (id, value) => { const field = document.getElementById(id); if (field) field.value = value; };
  set("leadCampaignName", values.name);
  set("leadCampaignProduct", values.productId || "");
  set("leadCampaignSteps", values.silentSteps.join(", "));
  set("leadCampaignApproach", values.approach);
  document.querySelectorAll("#leadCampaignFolders [data-lead-folder]").forEach((input) => { input.checked = values.folderIds.includes(input.value); });
  if (!emptyPlan(values.plan) || values.plan.template) renderPlanEditor(planHost(), values.plan);
}

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest("#leadCampaignPanel")) return;
  if (target.closest("[data-lead-new]")) {
    Object.assign(lead, { formOpen: true, editingId: null, notice: "", folderQuery: "" });
    renderLeadCampaigns();
    document.getElementById("leadCampaignName")?.focus();
    return;
  }
  if (target.closest("[data-lead-cancel]")) {
    const current = editing();
    const values = formValues();
    const dirty = current
      ? values.name !== current.name || (values.productId || null) !== (current.productId || null) || values.folderIds.join() !== current.folderIds.join() || !samePlan(values.plan, current.plan)
      : Boolean(values.name || values.folderIds.length || !emptyPlan(values.plan));
    if (dirty && !window.confirm("Скасувати незбережені зміни кампанії?")) return;
    Object.assign(lead, { formOpen: false, editingId: null, notice: "" });
    renderLeadCampaigns();
    return;
  }
  if (target.closest("[data-lead-delete]")) {
    const current = editing();
    if (!current || !window.confirm(`Видалити кампанію «${current.name}»? Люди лишаються в CRM, пінги — як є; нагадування підуть за загальним правилом.`)) return;
    try { await api(`/api/lead-campaigns?id=${encodeURIComponent(current.id)}`, { method: "DELETE" }); } catch (error) { lead.notice = error.message; }
    Object.assign(lead, { formOpen: false, editingId: null });
    await loadLeadCampaigns();
    return;
  }
  const row = target.closest("[data-lead-campaign]");
  if (!row) return;
  const id = row.dataset.leadCampaign;
  if (target.closest("[data-lead-edit]")) {
    Object.assign(lead, { formOpen: true, editingId: id, notice: "", folderQuery: "" });
    renderLeadCampaigns();
    return;
  }
  if (target.closest("[data-lead-open]")) {
    lead.openId = lead.openId === id ? null : id;
    renderLeadCampaigns();
    return;
  }
  const stateButton = target.closest("[data-lead-state]");
  if (stateButton) {
    try { await api("/api/lead-campaigns", { method: "PATCH", body: JSON.stringify({ id, state: stateButton.dataset.leadState }) }); } catch (error) { lead.notice = error.message; }
    await loadLeadCampaigns();
  }
});

document.addEventListener("submit", (event) => {
  if (event.target?.id !== "leadCampaignForm") return;
  event.preventDefault();
  void save();
});

document.addEventListener("input", (event) => {
  if (event.target?.id !== "leadCampaignFolderQuery") return;
  lead.folderQuery = event.target.value;
  const picked = new Set([...document.querySelectorAll("#leadCampaignFolders [data-lead-folder]:checked")].map((input) => input.value));
  const box = document.getElementById("leadCampaignFolders");
  if (!box) return;
  box.innerHTML = foldersPickerHtml(picked);
  const input = document.getElementById("leadCampaignFolderQuery");
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
});

document.addEventListener("change", (event) => {
  const box = event.target.closest?.("[data-lead-folder]");
  if (box) box.closest(".lead-folder")?.classList.toggle("is-on", box.checked);
});
