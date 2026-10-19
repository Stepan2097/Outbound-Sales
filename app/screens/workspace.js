// WorkSpace LinkedIn (таск f78ffd9a, 16.10.2026): кампанії лідгенів — стратегія аутріч.
//
// На вкладці: кампанії лідгенів (lead-campaigns.js), порівняння кампаній
// (campaign-report.js) і хребет, спільний для всіх кампаній: драбина кваліфікації,
// куди веде кожен лід, правила. Прогріву (автозапити, розсилка, акаунти) тут немає —
// він на своїй вкладці й з кампаніями не пов'язаний (Марко, 16.10).

import { api, escapeHtml, onScreen, refreshIcons } from "../core.js";
import { loadLeadCampaigns } from "./lead-campaigns.js";
import { loadScenarios, scenarioBook } from "./campaign-plan.js";
import "./campaign-report.js";

onScreen("workspace", { open: () => { void loadLeadCampaigns(); void openSpine(); } });

const SPINE_PARTS = [
  ["ladder", "Драбина кваліфікації", "2–3 питання до пропозиції дзвінка, по рядку на крок"],
  ["routes", "Куди веде кожен лід", "Рядок на маршрут: «Куди — кому»"],
  ["rules", "Правила на всі кампанії", "Рядок на правило"]
];

const spine = { open: false, editing: false, saving: false, error: "", notice: "" };

async function openSpine() {
  await loadScenarios();
  renderSpine();
}

function linesHtml(text) {
  const lines = String(text || "").split("\n").map((value) => value.trim()).filter(Boolean);
  return lines.length ? `<ol>${lines.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ol>` : '<p class="workspace-muted">Порожньо.</p>';
}

function renderSpine() {
  const root = document.getElementById("workspaceSpinePanel");
  if (!root) return;
  const { spine: values, canEditSpine } = scenarioBook();
  const head = `
    <div class="panel-heading">
      <div>
        <h2 title="Спільне для всіх кампаній: як кваліфікуємо, куди веде кожен лід, правила. За ним пишуть AI-чернетки.">Хребет кампаній</h2>
      </div>
      <div class="workspace-spine-controls">
        ${canEditSpine && spine.open && !spine.editing ? '<button class="text-button" type="button" data-spine-edit><i data-lucide="pencil"></i><span>Редагувати</span></button>' : ""}
        <button class="text-button" type="button" data-spine-toggle aria-expanded="${spine.open}"><i data-lucide="${spine.open ? "chevron-up" : "chevron-down"}"></i><span>${spine.open ? "Згорнути" : "Відкрити"}</span></button>
      </div>
    </div>`;
  if (!spine.open) { root.innerHTML = head; refreshIcons(root); return; }
  if (!values) { root.innerHTML = `${head}<div class="empty-state">Читаємо хребет...</div>`; return; }
  const body = spine.editing
    ? `<form class="workspace-spine-form" data-spine-form>
        ${SPINE_PARTS.map(([key, title, hint]) => `<label class="warmup-field"><span>${escapeHtml(title)} — ${escapeHtml(hint)}</span>
          <textarea rows="5" data-spine-field="${key}" maxlength="4000">${escapeHtml(values[key] || "")}</textarea></label>`).join("")}
        <div class="workspace-spine-foot">
          <button class="primary-button" type="submit" ${spine.saving ? "disabled" : ""}><i data-lucide="save"></i><span>${spine.saving ? "Зберігаємо..." : "Зберегти хребет"}</span></button>
          <button class="text-button" type="button" data-spine-cancel><i data-lucide="x"></i><span>Скасувати</span></button>
          ${spine.error ? `<p class="warmup-campaign-problem">${escapeHtml(spine.error)}</p>` : ""}
        </div>
      </form>`
    : `<div class="workspace-spine-grid">${SPINE_PARTS.map(([key, title]) => `<section><h3>${escapeHtml(title)}</h3>${linesHtml(values[key])}</section>`).join("")}</div>
      ${spine.notice ? `<p class="workspace-muted">${escapeHtml(spine.notice)}</p>` : ""}`;
  root.innerHTML = head + body;
  refreshIcons(root);
}

const spineRoot = document.getElementById("workspaceSpinePanel");
spineRoot?.addEventListener("click", (event) => {
  if (event.target.closest("[data-spine-toggle]")) {
    spine.open = !spine.open;
    if (!spine.open) spine.editing = false;
    renderSpine();
    return;
  }
  if (event.target.closest("[data-spine-edit]")) {
    spine.editing = true;
    spine.error = "";
    spine.notice = "";
    renderSpine();
    return;
  }
  if (event.target.closest("[data-spine-cancel]")) {
    spine.editing = false;
    spine.error = "";
    renderSpine();
  }
});
spineRoot?.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-spine-form]");
  if (!form) return;
  event.preventDefault();
  const body = Object.fromEntries(SPINE_PARTS.map(([key]) => [key, form.querySelector(`[data-spine-field="${key}"]`)?.value || ""]));
  spine.saving = true;
  renderSpine();
  try {
    await api("/api/scenarios/spine", { method: "PUT", body: JSON.stringify(body) });
    await loadScenarios({ force: true });
    spine.editing = false;
    spine.error = "";
    spine.notice = "Збережено. Нові чернетки пишуться вже за ним.";
  } catch (error) {
    spine.error = error?.message || "Хребет не зберігся.";
  } finally {
    spine.saving = false;
    renderSpine();
  }
});

renderSpine();
