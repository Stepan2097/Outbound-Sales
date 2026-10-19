// WorkSpace LinkedIn (таск f78ffd9a, 16.10.2026): кампанії лідгенів — стратегія аутріч.
//
// На вкладці: кампанії лідгенів (lead-campaigns.js), порівняння кампаній
// (campaign-report.js) і хребет, спільний для всіх кампаній: драбина кваліфікації,
// куди веде кожен лід, правила. Прогріву (автозапити, розсилка, акаунти) тут немає —
// він на своїй вкладці й з кампаніями не пов'язаний (Марко, 16.10).
//
// Друга частина WorkSpace — «Нові контакти» (Марко 19.10: конвеєр з Головної «напевно
// є сенс перенести у WorkSpace»): папка CRM → людина за людиною (home-triage.js).
// Правило без змін — спершу свої відповіді й прострочені пінги (/api/today/gate).

import { api, escapeHtml, onScreen, refreshIcons } from "../core.js";
import { loadLeadCampaigns } from "./lead-campaigns.js";
import { loadScenarios, scenarioBook } from "./campaign-plan.js";
import { openTriage } from "./home-triage.js";
import { openTodayBlock } from "./today.js";
import "./campaign-report.js";

const TAB_KEY = "outbound.workspace.tab";
const WS_TABS = ["campaigns", "contacts"];
let wsTab = readTab();
let gate = null;
// «Нові контакти» — один блок на дві сторінки: у WorkSpace і на Головній під
// пультом (власник 19.10). Переноситься туди, де відкритий, зі своїми слухачами.
let paneHome = null;
let onHome = false;
let homeGate = false;

function contactsPane() {
  return document.querySelector('[data-ws-pane="contacts"]');
}

function placeContactsPane(host = null) {
  const pane = contactsPane();
  if (!pane) return null;
  paneHome ||= { parent: pane.parentElement, next: pane.nextSibling };
  if (host) host.appendChild(pane);
  else if (pane.parentElement !== paneHome.parent) paneHome.parent.insertBefore(pane, paneHome.next);
  onHome = Boolean(host);
  return pane;
}

/**
 * Головна: «Нові контакти» — конвеєр з листами, як у WorkSpace. `gate: false` —
 * без умови «спершу розмови» (власник 19.10: Головна як до 16.10).
 */
export async function openNewContactsOnHome({ gate: useGate = true } = {}) {
  const host = document.getElementById("homeContacts");
  const pane = placeContactsPane(host);
  if (!pane) return;
  pane.hidden = false;
  await openNewContacts({ gate: useGate });
}

function readTab() {
  try { return WS_TABS.includes(window.localStorage.getItem(TAB_KEY)) ? window.localStorage.getItem(TAB_KEY) : "campaigns"; } catch { return "campaigns"; }
}

onScreen("workspace", { open: () => openTab() });

function openTab() {
  placeContactsPane(null);
  for (const button of document.querySelectorAll("[data-ws-tab]")) {
    const on = button.dataset.wsTab === wsTab;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-selected", String(on));
  }
  for (const pane of document.querySelectorAll("[data-ws-pane]")) pane.hidden = pane.dataset.wsPane !== wsTab;
  if (wsTab === "contacts") return void openNewContacts();
  void loadLeadCampaigns();
  void openSpine();
}

/** «Нові контакти»: конвеєр — або рядок, що спершу розмови, і шлях до них. */
async function openNewContacts({ recheck = false, gate: useGate = !onHome || homeGate } = {}) {
  const slot = document.getElementById("triageGate");
  const conveyor = document.getElementById("triageRoot");
  const wasAllowed = !conveyor?.hidden;
  if (onHome) homeGate = useGate;
  try {
    gate = useGate ? await api("/api/today/gate") : null;
  } catch {
    gate = null; // Не прочитали — не блокуємо: правило лише про порядок роботи.
  }
  const allowed = !gate || gate.allowed !== false;
  if (conveyor) conveyor.hidden = !allowed;
  if (slot) {
    slot.innerHTML = allowed ? (gate?.busy ? allowanceHtml(gate) : "") : gateHtml(gate);
    refreshIcons(slot);
  }
  // Перевірка після відправки не перезапускає конвеєр, що й так відкритий.
  if (allowed && !(recheck && wasAllowed)) await openTriage();
}

const waiting = (data) => [data.replies ? `відповідей ${data.replies}` : "", data.overdue ? `прострочених ${data.overdue}` : ""].filter(Boolean).join(", ");

function gateHtml(data) {
  const spent = data.mode === "limit" ? ` Норму нових на сьогодні (${data.limit}) уже взято.` : "";
  return `<section class="panel blk-ref triage-gate">
    <p><b>Спершу розмови</b>: у вас ${escapeHtml(waiting(data))}.${spent} Нові контакти з папки з'являться, коли їх розберете.</p>
    <button type="button" class="primary-button" data-ws-to-work><i data-lucide="inbox"></i><span>До роботи</span></button>
  </section>`;
}

/** Розмови чекають, але адмін дозволив цьому лідгену нових попри них (Налаштування → Команда). */
function allowanceHtml(data) {
  const left = data.mode === "limit" ? `Нових сьогодні: <b>${data.used} з ${data.limit}</b>.` : "Нові контакти без обмеження.";
  return `<p class="triage-allowance">${left} Розмови теж чекають (${escapeHtml(waiting(data))}) — <button type="button" class="text-button" data-ws-to-work>До роботи</button></p>`;
}

// Взяли людину з конвеєра — ворота перечитуються: на нормі конвеєр поступається розмовам.
// Пауза — бо журнал роботи пишеться вже після відповіді сервера.
document.addEventListener("triage:outreach", () => {
  if (wsTab !== "contacts" && !onHome) return;
  setTimeout(() => void openNewContacts({ recheck: true }), 1500);
});

document.querySelector("#view-workspace .view-tabs")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-ws-tab]");
  if (!button || button.dataset.wsTab === wsTab) return;
  wsTab = button.dataset.wsTab;
  try { window.localStorage.setItem(TAB_KEY, wsTab); } catch {}
  openTab();
});

document.getElementById("triageGate")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-ws-to-work]")) openTodayBlock();
});

/** З Головної-пульту: відкрити WorkSpace одразу на «Нові контакти» (або на «Кампаніях»). */
export function showNewContacts(tab = "contacts") {
  wsTab = WS_TABS.includes(tab) ? tab : "contacts";
  try { window.localStorage.setItem(TAB_KEY, wsTab); } catch {}
  document.querySelector('.nav-item[data-view="workspace"]')?.click();
}

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
