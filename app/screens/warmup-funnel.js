// «Прогрів LinkedIn» → «Як іде розсилка»: конвеєр від черги до відповіді —
// у черзі, запрошено, прийняли, ми написали, відповіли. Переїхав сюди з
// «Головної» (12.10, власник: «це перенести в розділ прогрів лінкедін»).
// Ті самі числа, що й раніше, з того самого /api/warmup/home.

import { escapeHtml, onScreen, refreshIcons } from "../core.js";
import { homeFunnelHtml } from "./home.js";
import { warmupApi, warmupCount } from "./warmup-accounts.js";

onScreen("warmup", { open: () => void loadWarmupFunnel() });

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
