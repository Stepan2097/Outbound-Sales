// «Прогрів LinkedIn» → «Як іде розсилка»: конвеєр від черги до відповіді —
// у черзі, запрошено, прийняли, ми написали, відповіли. Переїхав сюди з
// «Головної» (12.10, власник: «це перенести в розділ прогрів лінкедін»).
// Ті самі числа, що й раніше, з того самого /api/warmup/home.

import { escapeHtml, onScreen, refreshIcons } from "../core.js";
import { warmupApi, warmupCount } from "./warmup-accounts.js";

// Конвеєр LinkedIn-кампаній — у WorkSpace (16.10), поруч із кампаніями.
onScreen("workspace", { open: () => void loadWarmupFunnel() });

// The funnel itself — moved here from home.js when «LinkedIn · огляд» was removed (15.10).
function homePercent(part, whole) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "";
}

const HOME_STEPS = [
  { key: "queued", label: "У черзі", hint: "з папок кампаній, ще не запрошені" },
  { key: "invited", label: "Запрошено", hint: "запит на контакт надіслано" },
  { key: "accepted", label: "Прийняли", hint: "у контактах акаунта" },
  { key: "written", label: "Ми написали", hint: "перше повідомлення пішло" },
  { key: "replied", label: "Відповіли", hint: "написали у відповідь" }
];

export function homeFunnelHtml(data) {
  const funnel = data.funnel || {};
  const today = data.today || {};
  const extra = {
    invited: today.invited ? `+${warmupCount(today.invited)} сьогодні` : "",
    accepted: homePercent(funnel.accepted, funnel.invited) ? `${homePercent(funnel.accepted, funnel.invited)} запрошених` : "",
    written: data.toWriteTotal ? `${warmupCount(data.toWriteTotal)} чекають на повідомлення` : "",
    replied: today.replied ? `+${warmupCount(today.replied)} сьогодні` : (homePercent(funnel.replied, funnel.accepted) ? `${homePercent(funnel.replied, funnel.accepted)} прийнятих` : "")
  };
  return `<ol class="home-funnel">${HOME_STEPS.map((step) => `
    <li class="home-step is-${step.key}">
      <span class="home-step-label">${escapeHtml(step.label)}</span>
      <strong class="home-step-value">${warmupCount(Number(funnel[step.key]) || 0)}</strong>
      <span class="home-step-hint">${escapeHtml(extra[step.key] || step.hint)}</span>
    </li>`).join("")}</ol>`;
}


let funnel = { data: null, error: "" };

export async function loadWarmupFunnel() {
  const root = document.getElementById("warmupFunnelPanel");
  if (!root) return;
  if (!funnel.data) renderWarmupFunnel();
  try {
    funnel = { data: await warmupApi("/home"), error: "" };
  } catch (error) {
    funnel = { ...funnel, error: error?.message || "Не вдалося прочитати." };
  }
  renderWarmupFunnel();
}

export function renderWarmupFunnel() {
  const root = document.getElementById("warmupFunnelPanel");
  if (!root) return;
  const data = funnel.data;
  const subtitle = data?.today
    ? `Сьогодні: ${warmupCount(data.today.invited || 0)} запрошень, ${warmupCount(data.today.replied || 0)} відповідей`
    : funnel.error || "Рахуємо...";
  root.innerHTML = `
    <div class="panel-heading">
      <div>
        <h2>Як іде розсилка</h2>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      <button class="text-button" type="button" data-warmup-funnel-refresh><i data-lucide="refresh-cw"></i><span>Оновити</span></button>
    </div>
    ${data ? homeFunnelHtml(data) : ""}`;
  refreshIcons(root);
}

document.getElementById("warmupFunnelPanel")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-warmup-funnel-refresh]")) void loadWarmupFunnel();
});
