// Пошта (ESP 10): доступи, журнал дій адміністраторів і стан секретів — у
// «Налаштуваннях».
//
// Хто що може в холодній розсилці: запускати кампанії, міняти ліміти, бачити
// відповіді й решту. Ролі ті самі, що в «Команді» (адміністратор і продавець); на
// них адміністратор може видати продавцю окреме право або забрати. Кожна зміна, як
// і все, що адміністратор міняє в робочому просторі, — рядок у журналі дій, який
// лише дописується. Секрети живуть у змінних середовища: тут лише, чи задано.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

onScreen("account", { open: () => void loadEspAccess() });

export const espAccessState = { access: null, log: null, secrets: null, error: "", notice: "", busy: false };

const ESP_ADMIN_ACTION_LABEL = {
  "domain.added": "додав домен",
  "domain.status": "змінив стан домену",
  "domain.checked": "перевірив DNS домену",
  "sender.added": "додав скриньку",
  "sender.status": "змінив стан скриньки",
  "sender.updated": "змінив скриньку",
  "access.granted": "видав право",
  "access.revoked": "забрав право",
  "admin.role_changed": "змінив роль",
  "admin.user_created": "додав людину",
  "admin.user_removed": "прибрав людину",
  "admin.model_chosen_for": "вибрав модель за людину",
  "admin.model_provider_set": "задав ключ моделі",
  "admin.mailbox_resumed": "зняв паузу зі скриньки",
  "admin.template_created": "створив шаблон",
  "admin.template_updated": "змінив шаблон",
  "admin.template_removed": "видалив шаблон",
  "admin.signature_changed": "змінив підпис",
  "admin.halt_on": "натиснув «стоп усе»",
  "admin.halt_off": "зняв «стоп усе»",
  "admin.campaign_created": "створив кампанію",
  "admin.campaign_updated": "змінив кампанію",
  "admin.campaign_state": "змінив стан кампанії",
  "admin.campaign_leads_added": "додав людей у кампанію",
  "admin.monitor_run": "запустив перевірку DNS і блоклистів",
  "admin.retention_run": "анонімізував неактивних лідів"
};

export async function loadEspAccess() {
  try {
    const access = await api("/api/esp/access");
    espAccessState.access = access;
    const manage = access.mine.includes("access.manage");
    const [log, secrets] = await Promise.all([
      access.mine.includes("journal.read") ? api("/api/esp/admin-log?limit=40") : null,
      manage ? api("/api/esp/secrets") : null
    ]);
    espAccessState.log = log?.events ?? null;
    espAccessState.secrets = secrets;
    espAccessState.error = "";
  } catch (error) {
    espAccessState.error = error?.message || "Доступи пошти не прочиталися.";
  }
  renderEspAccess();
}

function espWhat(event) {
  const data = event.data || {};
  const pieces = [data.domain, data.email, data.mailbox, data.permission ? (espAccessState.access?.permissions?.[data.permission] || data.permission) : "",
    data.status, data.role, data.rampStage ? `рампа ${data.rampStage}/день` : "", data.model, data.reason ? `причина: ${data.reason}` : ""]
    .filter(Boolean);
  return pieces.join(" · ");
}

export function renderEspAccess() {
  const root = document.getElementById("espAccessBody");
  if (!root) return;
  const state = espAccessState;
  if (state.error && !state.access) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(state.error)}</div>`;
    return;
  }
  if (!state.access) {
    root.innerHTML = '<div class="empty-state">Читаємо доступи...</div>';
    return;
  }
  const { permissions, roles, mine, people } = state.access;
  const manage = mine.includes("access.manage");
  const names = Object.keys(permissions);

  const matrix = `<table class="esp-matrix">
    <thead><tr><th>Право</th><th>Адміністратор</th><th>Продавець</th></tr></thead>
    <tbody>${names.map((name) => `<tr>
      <td>${escapeHtml(permissions[name])}</td>
      <td>${roles.admin.includes(name) ? "✓" : "—"}</td>
      <td>${roles.seller.includes(name) ? "✓" : "—"}</td>
    </tr>`).join("")}</tbody>
  </table>`;

  const own = `<p class="esp-subtle">Ваші права: ${mine.map((name) => escapeHtml(permissions[name] || name)).join("; ") || "немає"}.</p>`;
  if (!manage) {
    root.innerHTML = `${own}${matrix}<p class="esp-subtle">Видає й забирає права адміністратор.</p>`;
    refreshIcons();
    return;
  }

  const options = names.filter((name) => name !== "access.manage")
    .map((name) => `<option value="${escapeAttr(name)}">${escapeHtml(permissions[name])}</option>`).join("");
  const peopleRows = people.length
    ? people.map((person) => `<div class="esp-row">
        <div class="esp-row-main"><strong>${escapeHtml(person.email)}</strong>
          <span class="esp-subtle">як продавець може: ${person.rights.map((name) => escapeHtml(permissions[name] || name)).join("; ") || "нічого"}</span></div>
        <div class="esp-actions">${person.granted.map((name) => `<button class="text-button" type="button" data-esp-revoke="${escapeAttr(name)}" data-esp-email="${escapeAttr(person.email)}"><i data-lucide="minus"></i><span>Забрати: ${escapeHtml(permissions[name] || name)}</span></button>`).join("")}
          ${person.revoked.map((name) => `<button class="text-button" type="button" data-esp-grant="${escapeAttr(name)}" data-esp-email="${escapeAttr(person.email)}"><i data-lucide="plus"></i><span>Повернути: ${escapeHtml(permissions[name] || name)}</span></button>`).join("")}</div>
      </div>`).join("")
    : '<p class="esp-subtle">Окремих прав ще нікому не видавали — діють ролі.</p>';

  const secrets = state.secrets ? `
    <h3 class="esp-title">Секрети</h3>
    <p class="esp-subtle">Лише в змінних середовища (Coolify). Тут видно, чи задано, — самих значень сторінка не отримує.</p>
    <div class="esp-list">${[
      ...state.secrets.secrets.map((row) => `<div class="esp-row"><div class="esp-row-main"><code>${escapeHtml(row.name)}</code>
        <span class="pill ${row.set ? "tone-live" : row.required ? "tone-warn" : "tone-muted"}">${row.set ? `задано${row.via !== row.name ? ` (${escapeHtml(row.via)})` : ""}` : "не задано"}</span>
        <span class="esp-subtle">${escapeHtml(row.purpose)}</span></div></div>`),
      ...state.secrets.switches.map((row) => `<div class="esp-row"><div class="esp-row-main"><code>${escapeHtml(row.name)}</code>
        <span class="pill ${row.on ? "tone-bad" : "tone-muted"}">${row.on ? "увімкнено" : "вимкнено"}</span>
        <span class="esp-subtle">${escapeHtml(row.purpose)}</span></div></div>`),
      ...state.secrets.mailboxes.map((row) => `<div class="esp-row"><div class="esp-row-main">${escapeHtml(row.email)} → <code>${escapeHtml(row.ref)}</code>
        <span class="pill ${row.set ? "tone-live" : "tone-warn"}">${row.set ? "задано" : "не задано"}</span></div></div>`)
    ].join("")}</div>` : "";

  const log = state.log ? `
    <h3 class="esp-title">Журнал дій адміністраторів</h3>
    ${state.log.length ? `<ol class="esp-log">${state.log.map((event) => `<li>
        <span class="esp-subtle">${escapeHtml(new Date(event.at).toLocaleString())}</span>
        <strong>${escapeHtml(event.actor || "система")}</strong>
        <span>${escapeHtml(ESP_ADMIN_ACTION_LABEL[event.type] || event.type)}</span>
        <span class="esp-subtle">${escapeHtml(espWhat(event))}</span>
      </li>`).join("")}</ol>` : '<p class="esp-subtle">Дій ще не було.</p>'}` : "";

  root.innerHTML = `
    ${state.notice ? `<p class="esp-notice ${state.error ? "is-bad" : ""}">${escapeHtml(state.notice)}</p>` : ""}
    ${matrix}
    <h3 class="esp-title">Окремі права людей</h3>
    <div class="esp-list">${peopleRows}</div>
    <form class="esp-form" id="espGrantForm">
      <input name="email" type="email" placeholder="Пошта людини з команди" required />
      <select name="permission">${options}</select>
      <button type="submit" name="grant" value="1"><i data-lucide="plus"></i><span>Видати</span></button>
      <button type="submit" name="grant" value="0"><i data-lucide="minus"></i><span>Забрати</span></button>
    </form>
    ${secrets}
    ${log}`;
  refreshIcons();
}

async function espChange(email, permission, grant) {
  if (espAccessState.busy) return;
  espAccessState.busy = true;
  try {
    const payload = await api(`/api/esp/access/${grant ? "grant" : "revoke"}`, { method: "POST", body: JSON.stringify({ email, permission }) });
    espAccessState.error = "";
    espAccessState.notice = payload.unchanged ? "Так уже й було — нічого не змінено." : `${email}: ${grant ? "видано" : "забрано"} — ${espAccessState.access.permissions[permission]}.`;
  } catch (error) {
    espAccessState.error = error?.message || "Не вдалося.";
    espAccessState.notice = espAccessState.error;
  } finally {
    espAccessState.busy = false;
  }
  await loadEspAccess();
}

document.getElementById("espAccessBody")?.addEventListener("click", (event) => {
  const revoke = event.target.closest("[data-esp-revoke]");
  if (revoke) { void espChange(revoke.dataset.espEmail, revoke.dataset.espRevoke, false); return; }
  const grant = event.target.closest("[data-esp-grant]");
  if (grant) void espChange(grant.dataset.espEmail, grant.dataset.espGrant, true);
});

document.getElementById("espAccessBody")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id !== "espGrantForm") return;
  const values = Object.fromEntries(new FormData(form).entries());
  void espChange(values.email, values.permission, event.submitter?.value !== "0");
});
