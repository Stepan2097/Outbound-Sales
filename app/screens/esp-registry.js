// Пошта (ESP 9): реєстр доменів і відправників у «Налаштуваннях».
//
// Звідки йдуть холодні листи — які домени (коли зареєстровані, у якому стані:
// старіє / рампа / активний / запас / виведений, що кажуть DNS і блоклисти), які
// скриньки на них (хто з команди за кожною, етап рампи — це її ліміт на день) і чому
// кожна зміна сталася. Кожна зміна тут — рядок у журналі ESP, який лише дописується:
// нічого не редагується і не видаляється, «вивести» означає назавжди, а пауза
// просить причину. Міняє адміністратор; решта команди бачить.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

onScreen("account", { open: () => void loadEspRegistry() });

export const espRegistryState = { data: null, error: "", busy: false, notice: "", verify: null };

const ESP_STATE_LABEL = {
  aging: ["Старіє", "tone-muted"],
  ramp: ["Рампа", "tone-warn"],
  active: ["Активний", "tone-live"],
  reserve: ["Запас", "tone-muted"],
  paused: ["Пауза", "tone-warn"],
  held: ["Чекає домен", "tone-muted"],
  retired: ["Виведено", "tone-muted"]
};

const ESP_DOMAIN_FLOW = ["aging", "ramp", "active", "reserve"];

function espAgo(iso) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 60) return minutes < 1 ? "щойно" : `${minutes} хв тому`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} год тому` : `${Math.round(hours / 24)} дн тому`;
}

export async function loadEspRegistry() {
  try {
    espRegistryState.data = await api("/api/esp/registry");
    espRegistryState.error = "";
  } catch (error) {
    espRegistryState.error = error?.message || "Реєстр пошти не прочитався.";
  }
  renderEspRegistry();
}

function espPill(status) {
  const [label, tone] = ESP_STATE_LABEL[status] || [status, "tone-muted"];
  return `<span class="pill ${tone}">${escapeHtml(label)}</span>`;
}

function espDnsHtml(checks) {
  if (!checks) return '<span class="esp-subtle">DNS і блоклисти ще не перевіряли</span>';
  const mark = (ok, label, title = "") => `<span class="esp-dns ${ok ? "is-ok" : "is-bad"}" title="${escapeAttr(title)}">${ok ? "✓" : "✗"} ${escapeHtml(label)}</span>`;
  const list = (name, result) => {
    if (!result) return "";
    if (result.status === "clean") return mark(true, `${name}: чисто`);
    if (result.status === "listed") return mark(false, `${name}: У СПИСКУ`, (result.answers || []).join(", "));
    if (result.status === "not_checked") return `<span class="esp-subtle" title="${escapeAttr(result.why || "")}">${escapeHtml(name)}: не перевірено</span>`;
    return `<span class="esp-subtle">${escapeHtml(name)}: немає відповіді</span>`;
  };
  return `${mark(Boolean(checks.mx), "MX", (checks.mx || []).join(", "))}
    ${mark(Boolean(checks.spf), "SPF", checks.spf || "немає запису v=spf1")}
    ${mark(Boolean(checks.dmarc), checks.dmarcPolicy ? `DMARC p=${checks.dmarcPolicy}` : "DMARC", checks.dmarc || "немає _dmarc")}
    ${checks.dkimSelector ? mark(Boolean(checks.dkim), `DKIM ${checks.dkimSelector}`) : ""}
    ${list("Spamhaus DBL", checks.blocklists?.spamhausDbl)}
    ${list("SURBL", checks.blocklists?.surbl)}
    <span class="esp-subtle">${escapeHtml(espAgo(checks.at))}</span>`;
}

function espDomainActionsHtml(domain, canEdit) {
  if (!canEdit || domain.status === "retired") return "";
  const data = `data-esp-kind="domain" data-esp-key="${escapeAttr(domain.domain)}"`;
  const moves = [...ESP_DOMAIN_FLOW, "paused"].filter((state) => state !== domain.status)
    .map((state) => `<option value="${state}">${escapeHtml(ESP_STATE_LABEL[state][0])}</option>`).join("");
  return `<div class="esp-actions">
    <button class="text-button" type="button" data-esp-check ${data}><i data-lucide="search-check"></i><span>Перевірити DNS і блоклисти</span></button>
    <label class="esp-move"><span>Стан:</span><select data-esp-move ${data}><option value="">змінити…</option>${moves}</select></label>
    <button class="text-button" type="button" data-esp-status="retired" ${data}><i data-lucide="archive"></i><span>Вивести</span></button>
  </div>`;
}

function espSenderActionsHtml(sender, canEdit, stages) {
  if (!canEdit || sender.status === "retired") return "";
  const data = `data-esp-kind="sender" data-esp-key="${escapeAttr(sender.email)}"`;
  const at = stages.indexOf(sender.rampStage);
  return `<div class="esp-actions">
    ${at > 0 ? `<button class="text-button" type="button" data-esp-ramp="${stages[at - 1]}" ${data}><i data-lucide="chevron-down"></i><span>Етап нижче</span></button>` : ""}
    ${at >= 0 && at < stages.length - 1 ? `<button class="text-button" type="button" data-esp-ramp="${stages[at + 1]}" ${data}><i data-lucide="chevron-up"></i><span>Етап вище (${stages[at + 1]}/день)</span></button>` : ""}
    <button class="text-button" type="button" data-esp-person ${data}><i data-lucide="user"></i><span>Хто за скринькою</span></button>
    ${sender.status === "active"
      ? `<button class="text-button" type="button" data-esp-status="paused" ${data}><i data-lucide="pause"></i><span>Пауза</span></button>`
      : `<button class="text-button" type="button" data-esp-status="active" ${data}><i data-lucide="play"></i><span>Відновити</span></button>`}
    <button class="text-button" type="button" data-esp-status="retired" ${data}><i data-lucide="archive"></i><span>Вивести</span></button>
  </div>`;
}

export function renderEspRegistry() {
  const root = document.getElementById("espRegistryBody");
  if (!root) return;
  const state = espRegistryState;
  if (state.error && !state.data) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(state.error)}</div>`;
    return;
  }
  if (!state.data) {
    root.innerHTML = '<div class="empty-state">Читаємо реєстр пошти...</div>';
    return;
  }
  const { domains = [], senders = [], canEdit = false, rampStages = [5, 10, 15, 20, 25, 30, 35] } = state.data;

  const domainRows = domains.length
    ? domains.map((domain) => `<div class="esp-row">
        <div class="esp-row-main"><strong>${escapeHtml(domain.domain)}</strong> ${espPill(domain.status)}
          ${domain.registeredAt ? `<span class="esp-subtle">зареєстровано ${escapeHtml(domain.registeredAt)}</span>` : ""}
          ${domain.note ? `<span class="esp-subtle">${escapeHtml(domain.note)}</span>` : ""}</div>
        <div class="esp-row-dns">${espDnsHtml(domain.checks)}</div>
        ${espDomainActionsHtml(domain, canEdit)}
      </div>`).join("")
    : '<p class="esp-subtle">Доменів ще немає.</p>';

  const senderRows = senders.length
    ? senders.map((sender) => {
      const shown = sender.effectiveStatus || sender.status;
      return `<div class="esp-row">
        <div class="esp-row-main"><strong>${escapeHtml(sender.email)}</strong> ${espPill(shown)}
          ${sender.displayName ? `<span class="esp-subtle">${escapeHtml(sender.displayName)}</span>` : ""}
          ${shown === "held" ? `<span class="esp-subtle">— домен ${escapeHtml(sender.domain)} у стані «${escapeHtml((ESP_STATE_LABEL[sender.heldBy] || [sender.heldBy])[0].toLowerCase())}»</span>` : ""}</div>
        <div class="esp-row-dns">
          <span>Етап рампи <b>${sender.rampStep || 1}/${rampStages.length}</b> · ліміт <b>${sender.limit ?? sender.rampStage}</b> на день</span>
          <span class="esp-subtle">за скринькою: ${sender.person ? escapeHtml(sender.person) : "не вказано"}</span>
          <span class="esp-subtle">доступ: ${sender.mailboxRef ? `<code>${escapeHtml(sender.mailboxRef)}</code>` : "ще не прив'язано"}</span>
        </div>
        ${espSenderActionsHtml(sender, canEdit, rampStages)}
      </div>`;
    }).join("")
    : '<p class="esp-subtle">Відправників ще немає.</p>';

  const forms = canEdit ? `
    <form class="esp-form" id="espDomainForm">
      <input name="domain" placeholder="Домен, напр. mail.advantage-agency.co" required />
      <input name="registeredAt" type="date" title="Дата реєстрації домену" />
      <select name="status" title="З якого стану починає">
        ${ESP_DOMAIN_FLOW.map((state) => `<option value="${state}">${escapeHtml(ESP_STATE_LABEL[state][0])}</option>`).join("")}
      </select>
      <input name="note" placeholder="Нотатка (необов'язково)" />
      <button type="submit"><i data-lucide="plus"></i><span>Додати домен</span></button>
    </form>
    <form class="esp-form" id="espSenderForm">
      <input name="email" type="email" placeholder="Скринька, напр. mary@mail.advantage-agency.co" required />
      <input name="displayName" placeholder="Ім'я відправника" />
      <input name="person" placeholder="Хто з команди за нею" />
      <input name="mailboxRef" placeholder="Змінна з доступом, напр. GMAIL_MARY_TOKEN" pattern="[A-Z][A-Z0-9_]{2,80}" title="Лише назва змінної середовища — сам ключ сюди не пишеться" />
      <select name="rampStage" title="Етап рампи — ліміт листів на день">
        ${rampStages.map((stage) => `<option value="${stage}">Рампа: ${stage}/день</option>`).join("")}
      </select>
      <button type="submit"><i data-lucide="plus"></i><span>Додати відправника</span></button>
    </form>` : '<p class="esp-subtle">Міняти реєстр може адміністратор.</p>';

  const verify = state.verify
    ? `<p class="esp-verify ${state.verify.ok ? "is-ok" : "is-bad"}">${state.verify.ok
      ? `Журнал цілий: ${state.verify.count} подій, ланцюг хешів не порушено.`
      : `Журнал пошкоджено: ${state.verify.problems.map((row) => `рядок ${row.line} — ${row.problem}`).join("; ")}.`}</p>`
    : "";

  root.innerHTML = `
    ${state.notice ? `<p class="esp-notice ${state.error ? "is-bad" : ""}">${escapeHtml(state.notice)}</p>` : ""}
    <h3 class="esp-title">Домени</h3>
    <div class="esp-list">${domainRows}</div>
    <h3 class="esp-title">Відправники</h3>
    <div class="esp-list">${senderRows}</div>
    ${forms}
    ${canEdit ? `<div class="esp-foot"><button class="text-button" type="button" data-esp-verify><i data-lucide="shield-check"></i><span>Перевірити цілість журналу</span></button>${verify}</div>` : ""}`;
  refreshIcons();
}

async function espWrite(path, body, done) {
  espRegistryState.busy = true;
  try {
    const payload = await api(path, { method: "POST", body: JSON.stringify(body) });
    if (payload.domains) espRegistryState.data = { ...espRegistryState.data, domains: payload.domains, senders: payload.senders };
    espRegistryState.error = "";
    espRegistryState.notice = done(payload);
  } catch (error) {
    espRegistryState.error = error?.message || "Не вдалося.";
    espRegistryState.notice = espRegistryState.error;
  } finally {
    espRegistryState.busy = false;
    renderEspRegistry();
  }
}

document.getElementById("espRegistryBody")?.addEventListener("click", async (event) => {
  if (espRegistryState.busy) return;
  const verify = event.target.closest("[data-esp-verify]");
  if (verify) {
    try { espRegistryState.verify = await api("/api/esp/journal/verify"); } catch (error) { espRegistryState.notice = error.message; }
    renderEspRegistry();
    return;
  }
  const check = event.target.closest("[data-esp-check]");
  if (check) {
    await espWrite("/api/esp/domains/check", { domain: check.dataset.espKey, dkimSelector: window.prompt("DKIM-селектор (напр. google), або порожньо:", "google") || "" },
      (payload) => `${check.dataset.espKey}: DNS і блоклисти перевірено${payload.checks?.blocklists?.listed ? " — ДОМЕН У БЛОКЛИСТІ" : ""}.`);
    return;
  }
  const ramp = event.target.closest("[data-esp-ramp]");
  if (ramp) {
    await espWrite("/api/esp/senders/update", { email: ramp.dataset.espKey, rampStage: Number(ramp.dataset.espRamp) },
      () => `${ramp.dataset.espKey}: етап рампи — ${ramp.dataset.espRamp} на день.`);
    return;
  }
  const person = event.target.closest("[data-esp-person]");
  if (person) {
    const who = window.prompt(`Хто з команди за скринькою ${person.dataset.espKey}?`);
    if (who === null) return;
    await espWrite("/api/esp/senders/update", { email: person.dataset.espKey, person: who }, () => `${person.dataset.espKey}: за скринькою — ${who || "ніхто"}.`);
    return;
  }
  const status = event.target.closest("[data-esp-status]");
  if (!status) return;
  const next = status.dataset.espStatus;
  const kind = status.dataset.espKind;
  const key = status.dataset.espKey;
  let reason = "";
  if (next !== "active") {
    reason = window.prompt(next === "retired"
      ? `Вивести ${key} назавжди — повернути не можна. Чому?`
      : `Поставити ${key} на паузу. Чому?`) || "";
    if (!reason.trim()) return;
  }
  await espWrite(kind === "domain" ? "/api/esp/domains/status" : "/api/esp/senders/status",
    kind === "domain" ? { domain: key, status: next, reason } : { email: key, status: next, reason },
    () => `${key}: ${ESP_STATE_LABEL[next][0].toLowerCase()}.`);
});

// Стан домену — вибором: старіє → рампа → активний → запас, або пауза (з причиною).
document.getElementById("espRegistryBody")?.addEventListener("change", async (event) => {
  const move = event.target.closest?.("[data-esp-move]");
  if (!move || !move.value || espRegistryState.busy) return;
  const next = move.value;
  const key = move.dataset.espKey;
  let reason = "";
  if (next === "paused") {
    reason = window.prompt(`Поставити ${key} на паузу. Чому?`) || "";
    if (!reason.trim()) { move.value = ""; return; }
  }
  await espWrite("/api/esp/domains/status", { domain: key, status: next, reason }, () => `${key}: ${ESP_STATE_LABEL[next][0].toLowerCase()}.`);
});

document.getElementById("espRegistryBody")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries(new FormData(form).entries());
  if (form.id === "espDomainForm") await espWrite("/api/esp/domains", values, () => `Домен ${values.domain} додано.`);
  if (form.id === "espSenderForm") await espWrite("/api/esp/senders", { ...values, rampStage: Number(values.rampStage) }, () => `Відправника ${values.email} додано.`);
});
