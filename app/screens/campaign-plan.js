// Сценарій LinkedIn-кампанії у формі WorkSpace (таск f78ffd9a, 16.10.2026).
//
// Як в артефакті «Кампанії лідгену»: кого шукати (сигнал), гіпотеза, ціль, флоу
// розмови — кроки з шаблонами повідомлень і змінними {Name}, {Company}, розгалуження
// «якщо … → …» і де персоналізувати. Чотири кампанії з артефакту — готові шаблони:
// вибір шаблону заповнює поля, далі їх можна правити під себе. AI-чернетки пишуть
// за цим сценарієм (warmup/scenarios.mjs → scenarioForPrompt).

import { api, escapeAttr, escapeHtml, refreshIcons } from "../core.js";

let scenarios = { templates: [], spine: null, canEditSpine: false };
let loading = null;

/** Шаблони й хребет — раз за сесію сторінки; `force` — після збереження хребта. */
export function loadScenarios({ force = false } = {}) {
  if (loading && !force) return loading;
  loading = api("/api/scenarios")
    .then((payload) => { scenarios = { templates: payload.templates || [], spine: payload.spine || null, canEditSpine: Boolean(payload.canEditSpine) }; return scenarios; })
    .catch(() => scenarios);
  return loading;
}

export function scenarioBook() {
  return scenarios;
}

export function emptyPlan(plan) {
  return !plan || (!plan.signal && !plan.hypothesis && !plan.goal && !(plan.steps || []).length && !plan.branches && !plan.personalize);
}

function stepRowHtml(step = {}, index = 0) {
  return `
    <div class="plan-step" data-plan-step>
      <div class="plan-step-head">
        <span class="plan-step-number">${index + 1}</span>
        <input type="text" data-plan-step-label value="${escapeAttr(step.label || "")}" placeholder="Назва кроку: опенер, кваліфікація, місток, пруф, дзвінок…" maxlength="80" aria-label="Назва кроку ${index + 1}" />
        <button class="text-button plan-step-remove" type="button" data-plan-step-remove title="Прибрати крок" aria-label="Прибрати крок ${index + 1}"><i data-lucide="x"></i></button>
      </div>
      <textarea rows="3" data-plan-step-text maxlength="2000" placeholder="Шаблон повідомлення або що робимо на цьому кроці. Змінні: {Name}, {Company}, {конкретика}…" aria-label="Текст кроку ${index + 1}">${escapeHtml(step.text || "")}</textarea>
    </div>`;
}

/** Редактор сценарію всередині форми кампанії. */
export function renderPlanEditor(host, plan = {}) {
  if (!host) return;
  const templates = scenarios.templates;
  host.innerHTML = `
    <div class="plan-editor-head">
      <div>
        <h3>Сценарій</h3>
        <p>Як в артефакті «Кампанії лідгену»: за ним AI пише перше повідомлення, відповіді й нагадування.</p>
      </div>
      <label class="warmup-field plan-template">
        <span>Почати з шаблону</span>
        <select data-plan-template aria-label="Шаблон сценарію">
          <option value="">Свій сценарій</option>
          ${templates.map((template) => `<option value="${escapeAttr(template.id)}" ${plan.template === template.id ? "selected" : ""}>${escapeHtml(template.name)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="plan-grid">
      <label class="warmup-field"><span>Кого шукати — сигнал</span>
        <textarea rows="2" data-plan-field="signal" maxlength="1500" placeholder="Посади, компанії, сигнали в профілі чи постах">${escapeHtml(plan.signal || "")}</textarea></label>
      <label class="warmup-field"><span>Гіпотеза</span>
        <textarea rows="2" data-plan-field="hypothesis" maxlength="1500" placeholder="Чому саме ці люди підуть на розмову">${escapeHtml(plan.hypothesis || "")}</textarea></label>
    </div>
    <label class="warmup-field"><span>Ціль</span>
      <input type="text" data-plan-field="goal" maxlength="600" value="${escapeAttr(plan.goal || "")}" placeholder="Напр.: кваліфікований дзвінок зі Степаном · FB Mentorship" /></label>
    <div class="plan-steps">
      <div class="plan-steps-head"><strong>Флоу розмови</strong><span>крок за кроком: опенер → кваліфікація → місток → пруф → дзвінок</span></div>
      <div data-plan-steps>${(plan.steps || []).map(stepRowHtml).join("")}</div>
      <button class="text-button" type="button" data-plan-step-add><i data-lucide="plus"></i><span>Додати крок</span></button>
    </div>
    <div class="plan-grid">
      <label class="warmup-field"><span>Розгалуження — рядок на випадок: «Якщо … → …»</span>
        <textarea rows="4" data-plan-field="branches" maxlength="4000" placeholder="«Не на часі» → стаття + пінг за 3–4 тижні">${escapeHtml(plan.branches || "")}</textarea></label>
      <label class="warmup-field"><span>Де персоналізувати</span>
        <textarea rows="4" data-plan-field="personalize" maxlength="2000" placeholder="Що в повідомленні має бути саме про цю людину">${escapeHtml(plan.personalize || "")}</textarea></label>
    </div>`;
  refreshIcons(host);
}

/** Що зараз у редакторі. */
export function readPlan(host) {
  if (!host) return null;
  const field = (name) => (host.querySelector(`[data-plan-field="${name}"]`)?.value || "").trim();
  const steps = [...host.querySelectorAll("[data-plan-step]")].map((row) => ({
    label: (row.querySelector("[data-plan-step-label]")?.value || "").trim(),
    text: (row.querySelector("[data-plan-step-text]")?.value || "").trim()
  })).filter((step) => step.label || step.text);
  return {
    template: host.querySelector("[data-plan-template]")?.value || "",
    signal: field("signal"),
    hypothesis: field("hypothesis"),
    goal: field("goal"),
    steps,
    branches: field("branches"),
    personalize: field("personalize")
  };
}

/** Чи однакові два сценарії — для «є що зберегти». */
export function samePlan(left, right) {
  const shape = (plan) => JSON.stringify({
    template: plan?.template || "", signal: plan?.signal || "", hypothesis: plan?.hypothesis || "", goal: plan?.goal || "",
    steps: (plan?.steps || []).map((step) => ({ label: step.label || "", text: step.text || "" })),
    branches: plan?.branches || "", personalize: plan?.personalize || ""
  });
  return shape(left) === shape(right);
}

/**
 * Події редактора: шаблон, додати / прибрати крок. `onChange` — щоб форма
 * перерахувала «є що зберегти»; `onTemplate(template)` — підставити продукт шаблону.
 */
export function bindPlanEditor(host, { onChange, onTemplate } = {}) {
  if (!host || host.dataset.planBound) return;
  host.dataset.planBound = "1";
  host.addEventListener("input", () => onChange?.());
  host.addEventListener("change", (event) => {
    const select = event.target.closest("[data-plan-template]");
    if (!select) { onChange?.(); return; }
    const template = scenarios.templates.find((item) => item.id === select.value);
    if (!template) { onChange?.(); return; }
    const current = readPlan(host);
    if (!emptyPlan(current) && !window.confirm(`Заповнити сценарій шаблоном «${template.name}»? Те, що вже написано в полях, заміниться.`)) {
      select.value = current.template || "";
      return;
    }
    renderPlanEditor(host, { ...template.plan, template: template.id });
    onTemplate?.(template);
    onChange?.();
  });
  host.addEventListener("click", (event) => {
    if (event.target.closest("[data-plan-step-add]")) {
      const list = host.querySelector("[data-plan-steps]");
      const count = list.querySelectorAll("[data-plan-step]").length;
      if (count >= 12) return;
      list.insertAdjacentHTML("beforeend", stepRowHtml({}, count));
      refreshIcons(list);
      list.querySelectorAll("[data-plan-step-label]")[count]?.focus();
      onChange?.();
      return;
    }
    const remove = event.target.closest("[data-plan-step-remove]");
    if (remove) {
      remove.closest("[data-plan-step]")?.remove();
      host.querySelectorAll("[data-plan-step]").forEach((row, index) => {
        const number = row.querySelector(".plan-step-number");
        if (number) number.textContent = String(index + 1);
      });
      onChange?.();
    }
  });
}

/** Сценарій для читання — під вибраною кампанією у WorkSpace. */
export function planSummaryHtml(plan, { open = false } = {}) {
  if (emptyPlan(plan)) {
    return `<p class="plan-summary-empty">Сценарію ще немає — «Редагувати» → «Почати з шаблону» або свій. Без нього AI пише лише за хребтом і підходом.</p>`;
  }
  const row = (label, value) => (value ? `<div class="plan-summary-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>` : "");
  return `
    <details class="plan-summary" ${open ? "open" : ""}>
      <summary><i data-lucide="route"></i><span>Сценарій кампанії${plan.goal ? ` · ${escapeHtml(plan.goal)}` : ""}</span></summary>
      <dl>
        ${row("Кого шукати", plan.signal)}
        ${row("Гіпотеза", plan.hypothesis)}
      </dl>
      ${(plan.steps || []).length ? `<ol class="plan-summary-steps">${plan.steps.map((step) => `<li><strong>${escapeHtml(step.label || "Крок")}</strong><p>${escapeHtml(step.text || "")}</p></li>`).join("")}</ol>` : ""}
      <dl>
        ${row("Розгалуження", plan.branches)}
        ${row("Де персоналізувати", plan.personalize)}
      </dl>
    </details>`;
}
