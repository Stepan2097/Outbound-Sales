// Вхідні → «Нові» (Марко 20.10, таск f50d24e9): люди з папки CRM, яким ще ніхто не писав —
// конвеєр (home-triage.js): папка → людина за людиною → лист чи повідомлення.
//
// Правило — «з правилом» (Марко 20.10): спершу свої відповіді й прострочені пінги
// (/api/today/gate); адмін може дати лідгену «До N на день» чи «Без обмеження»
// (Налаштування → Команда). Раніше цей блок жив у WorkSpace і на Головній.

import { api, escapeHtml, refreshIcons } from "../core.js";
import { openTriage } from "./home-triage.js";

let gate = null;
let shown = false;

/** Відкрити «Нові»: конвеєр — або рядок, що спершу розмови, і шлях до них. */
export async function openNewContacts({ recheck = false } = {}) {
  shown = true;
  const slot = document.getElementById("triageGate");
  const conveyor = document.getElementById("triageRoot");
  const wasAllowed = !conveyor?.hidden;
  try {
    gate = await api("/api/today/gate");
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

/** Вкладку закрили — перевіряти ворота після відправки більше нема для кого. */
export function leaveNewContacts() {
  shown = false;
}

const waiting = (data) => [data.replies ? `відповідей ${data.replies}` : "", data.overdue ? `прострочених ${data.overdue}` : ""].filter(Boolean).join(", ");

function gateHtml(data) {
  const spent = data.mode === "limit" ? ` Норму нових на сьогодні (${data.limit}) уже взято.` : "";
  return `<section class="panel blk-ref triage-gate">
    <p><b>Спершу розмови</b>: у вас ${escapeHtml(waiting(data))}.${spent} Нові контакти з папки з'являться, коли їх розберете.</p>
    <button type="button" class="primary-button" data-new-to-work><i data-lucide="inbox"></i><span>В роботу</span></button>
  </section>`;
}

/** Розмови чекають, але адмін дозволив цьому лідгену нових попри них (Налаштування → Команда). */
function allowanceHtml(data) {
  const left = data.mode === "limit" ? `Нових сьогодні: <b>${data.used} з ${data.limit}</b>.` : "Нові контакти без обмеження.";
  return `<p class="triage-allowance">${left} Розмови теж чекають (${escapeHtml(waiting(data))}) — <button type="button" class="text-button" data-new-to-work>В роботу</button></p>`;
}

// Взяли людину з конвеєра — ворота перечитуються: на нормі конвеєр поступається розмовам.
// Пауза — бо журнал роботи пишеться вже після відповіді сервера.
document.addEventListener("triage:outreach", () => {
  if (!shown) return;
  setTimeout(() => void openNewContacts({ recheck: true }), 1500);
});

// «В роботу» — вкладка розмов поруч.
document.getElementById("triageGate")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-new-to-work]")) document.querySelector('[data-inbox-tab="work"]')?.click();
});
