// Листи → «Кампанії» (ESP 5): ланцюжки холодних листів, люди в них і «Стоп
// усе». Приблизно як список і конструктор кампаній у Snov.io — кроки, затримки
// в робочих днях, скриньки, одержувачі, перегляд того, що піде, — але без
// відкриттів і кліків: їх у нас немає.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, setHtml } from "../core.js";

onScreen("email", { open: () => void loadEspCampaigns() });

const CAMPAIGN_STATE = { draft: "чернетка", running: "працює", paused: "пауза", done: "завершена" };
const CAMPAIGN_TONE = { draft: "tone-muted", running: "tone-live", paused: "tone-warn", done: "tone-done" };
const PERSON_STATE = { active: "у ланцюжку", done: "отримав усі", stopped: "зупинено", uncertain: "невідомо, чи пішов" };
const STOP_REASON = {
  replied: "відповів", bounced: "bounce", unsubscribed: "відписався", campaign_done: "кампанію завершено",
  unknown_timezone: "невідомий часовий пояс", empty_variable: "порожня змінна", us_address_missing: "немає адреси для США",
  no_answer_from_provider: "Gmail не відповів — перевір «Надіслані» скриньки"
};
const SKIP_REASON = {
  not_due: "ще не день", sender_daily_limit: "ліміт сендера", domain_daily_limit: "ліміт домену", outside_window: "поза вікном одержувача",
  weekend: "вихідний", too_soon: "інтервал між листами", sender_unavailable: "сендер не надсилає", sender_paused: "сендер на паузі",
  already_sent: "уже надіслано", provider_refused: "Gmail відмовив"
};

const espCampaignsState = {
  campaigns: [], templates: [], senders: [], halt: null, sequenceOn: false, error: "",
  openId: null, people: [], formOpen: false, notice: "", plan: null
};

export async function loadEspCampaigns() {
  if (!document.getElementById("espCampaignsBody")) return;
  try {
    const [campaigns, halt, templates, limits] = await Promise.all([
      api("/api/esp/campaigns"), api("/api/esp/halt"), api("/api/esp/templates"), api("/api/esp/limits")
    ]);
    espCampaignsState.campaigns = campaigns.campaigns || [];
    espCampaignsState.halt = halt.halt;
    espCampaignsState.sequenceOn = halt.sequenceOn;
    espCampaignsState.templates = templates.templates || [];
    espCampaignsState.senders = (limits.senders || []).filter((sender) => sender.status === "active");
    espCampaignsState.error = "";
    if (espCampaignsState.openId) await loadEspPeople(espCampaignsState.openId, { render: false });
  } catch (error) {
    espCampaignsState.error = error.status === 403 ? "Кампанії веде адміністратор робочого простору." : error.message;
  }
  renderEspCampaigns();
}

async function loadEspPeople(id, { render = true } = {}) {
  espCampaignsState.openId = id;
  espCampaignsState.people = (await api(`/api/esp/campaigns/people?id=${encodeURIComponent(id)}`)).people || [];
  if (render) renderEspCampaigns();
}

function haltHtml() {
  const { halt, sequenceOn } = espCampaignsState;
  const line = sequenceOn
    ? "Ланцюжок увімкнено: кожну хвилину сервер надсилає те, що вже пора."
    : "Ланцюжок на цьому сервері вимкнено (ESP_SEQUENCE) — кампанії можна будувати й переглядати, листи не йдуть.";
  if (halt?.on) {
    return `<div class="esp-halt is-on" role="alert">
      <i data-lucide="octagon-x"></i>
      <div><strong>«Стоп усе» увімкнено — жоден лист не йде.</strong><p>${escapeHtml(halt.reason)} · ${escapeHtml(halt.by || "")} · ${escapeHtml(halt.at ? new Date(halt.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }) : "")}</p></div>
      <button class="primary-button" type="button" id="espHaltOff">Відновити відправку</button>
    </div>`;
  }
  return `<div class="esp-halt"><p>${escapeHtml(line)}</p><button class="danger-button" type="button" id="espHaltOn"><i data-lucide="octagon-x"></i><span>Стоп усе</span></button></div>`;
}

function listHtml() {
  const { campaigns, openId } = espCampaignsState;
  if (!campaigns.length) return '<div class="empty-state">Кампаній ще немає.</div>';
  return `<div class="table-wrap"><table class="esp-campaign-table">
    <thead><tr><th>Кампанія</th><th>Стан</th><th>Людей</th><th>Надіслано</th><th>Відповіді</th><th>Bounce</th><th>Відписки</th><th></th></tr></thead>
    <tbody>${campaigns.map((campaign) => `
      <tr class="${campaign.id === openId ? "is-selected" : ""}">
        <td><button class="text-button" type="button" data-esp-campaign-open="${escapeAttr(campaign.id)}"><strong>${escapeHtml(campaign.name)}</strong></button>
          <small class="esp-steps-line">${campaign.steps.map((step, index) => `${index ? `+${step.delayDays} р. д. → ` : ""}лист ${index + 1}`).join(" · ")}${campaign.spinMode === "half" ? " · спінтакс A/B" : campaign.spinMode === "off" ? " · без спінтаксу" : ""}</small></td>
        <td><span class="pill ${CAMPAIGN_TONE[campaign.state]}">${CAMPAIGN_STATE[campaign.state]}</span></td>
        <td>${campaign.people}</td><td>${campaign.sent}</td><td>${campaign.replied}</td><td>${campaign.bounced}</td><td>${campaign.unsubscribed}</td>
        <td class="esp-campaign-actions">${campaign.state === "done" ? "" : `
          ${campaign.state === "running"
            ? `<button class="text-button" type="button" data-esp-campaign-state="paused" data-id="${escapeAttr(campaign.id)}">Пауза</button>`
            : `<button class="text-button" type="button" data-esp-campaign-state="running" data-id="${escapeAttr(campaign.id)}">Запустити</button>`}
          <button class="text-button" type="button" data-esp-campaign-state="done" data-id="${escapeAttr(campaign.id)}">Завершити</button>`}</td>
      </tr>`).join("")}</tbody>
  </table></div>`;
}

function formHtml() {
  const { templates, senders, formOpen } = espCampaignsState;
  if (!formOpen) return "";
  if (!templates.length) return '<p class="esp-notice is-bad">Спершу збережіть хоча б один шаблон листа нижче.</p>';
  const options = templates.map((template) => `<option value="${escapeAttr(template.id)}">${escapeHtml(template.name)}</option>`).join("");
  const stepRow = (index, delay) => `
    <div class="esp-step-row" data-esp-step>
      <span>Лист ${index + 1}</span>
      <select data-esp-step-template>${options}</select>
      ${index === 0 ? '<small>день 0</small>' : `<label>через <input type="number" min="0" max="30" value="${delay}" data-esp-step-delay /> робочих дн.</label>`}
    </div>`;
  return `
    <form class="esp-campaign-form" id="espCampaignForm">
      <input id="espCampaignName" type="text" placeholder="Назва кампанії" required />
      <div id="espCampaignSteps">${[0, 3, 4].map((delay, index) => stepRow(index, delay)).join("")}</div>
      <label class="esp-spin-mode">Спінтакс по реченнях
        <select id="espCampaignSpin">
          <option value="all">усім — кожен отримує свої варіанти</option>
          <option value="half">половині — A/B: половина бачить базовий текст</option>
          <option value="off">нікому — завжди перший варіант</option>
        </select>
      </label>
      <fieldset class="esp-senders">
        <legend>Скриньки-відправники — кожна людина отримає весь ланцюжок з однієї</legend>
        ${senders.length ? senders.map((sender) => `<label><input type="checkbox" value="${escapeAttr(sender.email)}" data-esp-sender checked /> ${escapeHtml(sender.email)} <small>до ${sender.limit}/день</small></label>`).join("")
          : '<p class="esp-notice is-bad">У реєстрі немає активних відправників — додайте їх у Налаштуваннях.</p>'}
      </fieldset>
      <div class="esp-editor-actions"><button class="primary-button" type="submit"><i data-lucide="save"></i><span>Створити чернетку</span></button></div>
    </form>`;
}

function detailHtml() {
  const { openId, people, campaigns, plan } = espCampaignsState;
  const campaign = campaigns.find((row) => row.id === openId);
  if (!campaign) return "";
  const rows = people.length
    ? `<div class="table-wrap"><table class="esp-people-table"><thead><tr><th>Людина</th><th>Скринька</th><th>Крок</th><th>Стан</th><th>Наступний</th></tr></thead><tbody>${people.map((person) => `
        <tr><td>${escapeHtml(person.email)}<small>${escapeHtml([person.name, person.company, person.country].filter(Boolean).join(" · "))}</small></td>
        <td>${escapeHtml(person.sender)}</td><td>${person.step} / ${campaign.steps.length}</td>
        <td>${escapeHtml(PERSON_STATE[person.status] || person.status)}${person.reason ? `<small>${escapeHtml(STOP_REASON[person.reason] || person.reason)}</small>` : ""}</td>
        <td>${escapeHtml(person.nextDueDate || (person.status === "active" ? "сьогодні" : "—"))}</td></tr>`).join("")}</tbody></table></div>`
    : '<div class="empty-state">У кампанії ще нікого немає.</div>';
  const planHtml = !plan ? "" : `<div class="esp-plan">
      <strong>Якби ланцюжок ішов зараз: ${plan.planned.length} ${plan.planned.length === 1 ? "лист" : "листів"}</strong>
      ${plan.planned.map((row) => `<p>${escapeHtml(row.sender)} → ${escapeHtml(row.email)} · лист ${row.step} · «${escapeHtml(row.subject)}»</p>`).join("")}
      ${Object.keys(plan.skipped || {}).length ? `<small>Чекають: ${Object.entries(plan.skipped).map(([reason, count]) => `${escapeHtml(SKIP_REASON[reason] || reason)} — ${count}`).join(" · ")}</small>` : ""}
      ${plan.halted ? "<small>«Стоп усе» увімкнено.</small>" : ""}
    </div>`;
  return `
    <h3 class="esp-preview-title">${escapeHtml(campaign.name)}: люди</h3>
    ${campaign.state === "done" ? "" : `<form class="esp-people-form" id="espPeopleForm">
      <textarea id="espPeopleInput" rows="4" placeholder="Рядок на людину: email, ім'я, компанія, країна[, часовий пояс]"></textarea>
      <button type="submit"><i data-lucide="user-plus"></i><span>Додати в кампанію</span></button>
    </form>`}
    ${espCampaignsState.notice ? `<p class="esp-notice">${escapeHtml(espCampaignsState.notice)}</p>` : ""}
    ${rows}
    <div class="esp-editor-actions"><button class="text-button" type="button" id="espPlanBtn"><i data-lucide="list-checks"></i><span>Що піде зараз</span></button></div>
    ${planHtml}`;
}

export function renderEspCampaigns() {
  if (espCampaignsState.error) {
    setHtml("espCampaignsBody", `<div class="empty-state">${escapeHtml(espCampaignsState.error)}</div>`);
    return;
  }
  setHtml("espCampaignsBody", `${haltHtml()}${listHtml()}${formHtml()}${detailHtml()}`);
  refreshIcons();
}

async function act(request) {
  try {
    await request();
    espCampaignsState.notice = espCampaignsState.notice || "";
  } catch (error) {
    espCampaignsState.notice = error.message;
  }
  await loadEspCampaigns();
}

document.getElementById("view-email")?.addEventListener("click", async (event) => {
  const target = event.target;
  if (target.closest("#espCampaignNew")) {
    espCampaignsState.formOpen = !espCampaignsState.formOpen;
    return renderEspCampaigns();
  }
  if (target.closest("#espHaltOn")) {
    const reason = window.prompt("«Стоп усе»: чому зупиняємо всю відправку?");
    if (!reason?.trim()) return;
    return act(() => api("/api/esp/halt", { method: "POST", body: JSON.stringify({ on: true, reason }) }));
  }
  if (target.closest("#espHaltOff")) {
    if (!window.confirm("Відновити відправку для всієї системи?")) return;
    return act(() => api("/api/esp/halt", { method: "POST", body: JSON.stringify({ on: false }) }));
  }
  const open = target.closest("[data-esp-campaign-open]");
  if (open) {
    espCampaignsState.plan = null;
    espCampaignsState.notice = "";
    return loadEspPeople(open.dataset.espCampaignOpen);
  }
  const state = target.closest("[data-esp-campaign-state]");
  if (state) {
    const next = state.dataset.espCampaignState;
    if (next === "done" && !window.confirm("Завершити кампанію? Ті, хто ще в ланцюжку, більше нічого з неї не отримають.")) return;
    espCampaignsState.notice = "";
    return act(() => api("/api/esp/campaigns/state", { method: "POST", body: JSON.stringify({ id: state.dataset.id, state: next }) }));
  }
  if (target.closest("#espPlanBtn")) {
    espCampaignsState.plan = await api("/api/esp/campaigns/plan").catch((error) => ({ planned: [], skipped: {}, error: error.message }));
    return renderEspCampaigns();
  }
});

document.getElementById("view-email")?.addEventListener("submit", async (event) => {
  if (event.target.id === "espCampaignForm") {
    event.preventDefault();
    const steps = [...document.querySelectorAll("[data-esp-step]")].map((row) => ({
      templateId: row.querySelector("[data-esp-step-template]").value,
      delayDays: Number(row.querySelector("[data-esp-step-delay]")?.value ?? 0)
    }));
    const senders = [...document.querySelectorAll("[data-esp-sender]:checked")].map((input) => input.value);
    const name = document.getElementById("espCampaignName").value;
    const spinMode = document.getElementById("espCampaignSpin")?.value || "all";
    return act(async () => {
      const answer = await api("/api/esp/campaigns", { method: "POST", body: JSON.stringify({ name, steps, senders, spinMode }) });
      espCampaignsState.formOpen = false;
      espCampaignsState.openId = answer.campaign.id;
      espCampaignsState.notice = "Чернетку створено — додайте людей і запустіть.";
    });
  }
  if (event.target.id === "espPeopleForm") {
    event.preventDefault();
    const text = document.getElementById("espPeopleInput").value;
    return act(async () => {
      const answer = await api("/api/esp/campaigns/leads", { method: "POST", body: JSON.stringify({ id: espCampaignsState.openId, text }) });
      const skipped = answer.skipped.length ? ` Не додано ${answer.skipped.length}: ${answer.skipped.slice(0, 5).map((row) => `${row.email} (${row.reason === "in_other_campaign" ? `уже в «${row.campaign}»` : row.reason})`).join(", ")}.` : "";
      const rejected = answer.rejected.length ? ` Рядків без адреси: ${answer.rejected.length}.` : "";
      espCampaignsState.notice = `Додано ${answer.added}.${skipped}${rejected}`;
    });
  }
});
