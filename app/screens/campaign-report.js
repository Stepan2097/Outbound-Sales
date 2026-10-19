// WorkSpace → порівняння LinkedIn-кампаній (етап 6/6 плану кампаній і пінгів, 16.10.2026;
// з «Пошта → Звіти» перенесено у WorkSpace того ж дня, аудит P1).
//
// Кампанії поруч: людей, написали, прийняли, відповіли, кваліфіковані відповіді на
// 100 написаних, дзвінки. Головне число — кваліфіковані на 100 написаних (лідген-
// стратегія 10.2026, §5). Рядок розгортається в список відповідей: у кожної мітка
// (AI ставить, лідген змінює одним кліком — і звіт одразу перераховується).
// Звіти ESP (mail-reports.js) цей блок не чіпає.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

// WorkSpace (16.10): порівняння кампаній поруч із кампаніями, не в «Пошта → Звіти».
onScreen("workspace", { open: () => void loadCampaignReport() });

const STATES = { running: "Іде", paused: "Пауза", done: "Завершена", draft: "Чернетка" };
const report = { data: null, error: "", open: "", replies: {}, saving: "" };

async function loadCampaignReport() {
  try {
    report.data = await api("/api/campaign-report");
    report.error = "";
  } catch (error) {
    report.error = error?.message || "Звіт кампаній не прочитався.";
  }
  renderCampaignReport();
  if (report.open) void loadReplies(report.open);
  if (report.data?.job?.running) setTimeout(() => void loadCampaignReport(), 4000);
}

async function loadReplies(campaignId) {
  try {
    const payload = await api(`/api/campaign-report/replies?campaignId=${encodeURIComponent(campaignId)}`);
    report.replies[campaignId] = payload.replies || [];
  } catch (error) {
    report.replies[campaignId] = { error: error?.message || "Відповіді не прочиталися." };
  }
  renderCampaignReport();
}

const per100 = (value) => (value == null ? "—" : String(value).replace(".", ","));

function rowHtml(campaign) {
  const isOpen = report.open === campaign.id;
  return `
    <tr class="campaign-report-row${isOpen ? " is-open" : ""}" data-campaign-report-open="${escapeAttr(campaign.id)}">
      <td><button type="button" class="text-button" aria-expanded="${isOpen}"><i data-lucide="${isOpen ? "chevron-down" : "chevron-right"}"></i><span>${escapeHtml(campaign.name || "Без назви")}</span></button>
        <small>${escapeHtml(STATES[campaign.state] || campaign.state || "")}</small></td>
      <td>${campaign.people}</td>
      <td>${campaign.written}</td>
      <td>${campaign.accepted}</td>
      <td>${campaign.replied}${campaign.unlabeled ? ` <small title="Відповіді без мітки">· ${campaign.unlabeled} без мітки</small>` : ""}</td>
      <td>${campaign.qualified}</td>
      <td class="campaign-report-key">${per100(campaign.qualifiedPer100)}</td>
      <td>${campaign.calls}</td>
    </tr>
    ${isOpen ? `<tr class="campaign-report-replies"><td colspan="8">${repliesHtml(campaign.id)}</td></tr>` : ""}`;
}

function repliesHtml(campaignId) {
  const list = report.replies[campaignId];
  if (!list) return `<div class="empty-state">Читаємо відповіді...</div>`;
  if (list.error) return `<div class="empty-state">${escapeHtml(list.error)}</div>`;
  if (!list.length) return `<div class="empty-state">У цій кампанії ще ніхто не відповів.</div>`;
  const labels = report.data?.labels || [];
  return `<ul class="campaign-report-list">${list.map((item) => `
    <li>
      <div class="campaign-report-who"><b>${escapeHtml(item.name || "Без імені")}</b><span>${escapeHtml([item.position, item.company].filter(Boolean).join(" · "))}</span></div>
      <p>${escapeHtml(item.reply || "(без тексту)")}</p>
      <div class="campaign-report-labels" role="group" aria-label="Мітка відповіді">
        ${labels.map(([key, title]) => `<button type="button" class="campaign-report-label${item.label === key ? " is-on" : ""}" data-reply-label="${escapeAttr(key)}" data-contact="${escapeAttr(item.contactId)}" data-campaign="${escapeAttr(campaignId)}" ${report.saving === item.contactId ? "disabled" : ""}>${escapeHtml(title)}</button>`).join("")}
        <small>${item.label ? (item.labelBy === "ai" ? "мітка AI" : "мітка людини") : "без мітки"}</small>
      </div>
    </li>`).join("")}</ul>`;
}

function renderCampaignReport() {
  const root = document.getElementById("campaignReportRoot");
  if (!root) return;
  const data = report.data;
  const job = data?.job;
  const jobLine = job?.running ? `AI ставить мітки: ${job.done} з ${job.total}…` : job && job.total ? `AI розмітив ${job.done - job.failed} з ${job.total}${job.failed ? `, не вдалось ${job.failed}` : ""}.` : "";
  const head = `
    <div class="campaign-report-head">
      <div><h2 title="Головне число — кваліфіковані відповіді на 100 написаних; дзвінки — як підтвердження.">Порівняння кампаній</h2></div>
      <button type="button" class="text-button" data-campaign-report-ai ${job?.running ? "disabled" : ""}><i data-lucide="sparkles"></i><span>Розмітити нові відповіді</span></button>
    </div>
    ${jobLine ? `<p class="campaign-report-job">${escapeHtml(jobLine)}</p>` : ""}`;
  if (report.error && !data) { root.innerHTML = `<section class="campaign-report panel blk-metrics">${head}<div class="empty-state">${escapeHtml(report.error)}</div></section>`; refreshIcons(root); return; }
  if (!data) { root.innerHTML = `<section class="campaign-report panel blk-metrics">${head}<div class="empty-state">Рахуємо кампанії...</div></section>`; return; }
  const rows = data.campaigns || [];
  root.innerHTML = `<section class="campaign-report panel blk-metrics">${head}${rows.length ? `
    <div class="campaign-report-scroll"><table class="campaign-report-table">
      <thead><tr><th>Кампанія</th><th>Людей</th><th>Написали</th><th>Прийняли</th><th>Відповіли</th><th>Кваліфіковані</th><th>На 100 написаних</th><th>Дзвінки</th></tr></thead>
      <tbody>${rows.map(rowHtml).join("")}</tbody>
    </table></div>` : `<div class="empty-state">Кампаній лідгенів ще немає — «Нова кампанія» вище.</div>`}</section>`;
  refreshIcons(root);
}

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest("#campaignReportRoot")) return;
  const label = target.closest("[data-reply-label]");
  if (label) {
    const { contact, campaign } = label.dataset;
    report.saving = contact;
    renderCampaignReport();
    try {
      await api("/api/campaign-report/label", { method: "POST", body: JSON.stringify({ contactId: contact, label: label.dataset.replyLabel }) });
    } catch (error) {
      window.alert(error?.message || "Мітка не збереглась.");
    }
    report.saving = "";
    await loadCampaignReport();
    return;
  }
  if (target.closest("[data-campaign-report-ai]")) {
    try {
      await api("/api/campaign-report/ai", { method: "POST", body: "{}" });
    } catch (error) {
      window.alert(error?.message || "AI зараз недоступний.");
    }
    await loadCampaignReport();
    return;
  }
  const row = target.closest("[data-campaign-report-open]");
  if (row) {
    const id = row.dataset.campaignReportOpen;
    report.open = report.open === id ? "" : id;
    renderCampaignReport();
    if (report.open) void loadReplies(report.open);
  }
});
