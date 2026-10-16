// «Веде: <лідген>» у картці акаунта на «Прогріві» (етап 1/6, рішення Марко 16.10):
// за ким закріплений робочий акаунт LinkedIn. Пінги діалогів цього акаунта йдуть
// цьому лідгенові (triage/today.mjs); без позначки — власникові контакту в CRM.
// Читають усі, змінює адміністратор. Окремий модуль, щоб картка акаунта лише
// лишала для нього місце (`accountLeadgenSlot`) і кликала `fillAccountLeadgen`.

import { api, escapeAttr, escapeHtml } from "./core.js";

let loaded = null;

async function load(force = false) {
  if (!loaded || force) loaded = api("/api/today/leadgens").catch(() => null);
  return loaded;
}

export function accountLeadgenSlot(accountId) {
  return `<section class="wa-section"><h3>Хто веде акаунт</h3><div class="account-leadgen" data-account-leadgen="${escapeAttr(accountId)}"><span class="wa-muted">…</span></div></section>`;
}

export async function fillAccountLeadgen() {
  const slots = [...document.querySelectorAll("[data-account-leadgen]")];
  if (!slots.length) return;
  const data = await load();
  for (const slot of slots) {
    const accountId = slot.dataset.accountLeadgen;
    if (!data) {
      slot.innerHTML = '<span class="wa-muted">Не вдалося прочитати, хто веде акаунт.</span>';
      continue;
    }
    const current = data.leadgens?.[accountId] || "";
    const who = data.people.find((person) => person.id === current)?.email || "";
    const hint = '<p class="wa-muted">Пінги з діалогів цього акаунта йдуть тому, хто його веде. Без позначки — власникові контакту в CRM.</p>';
    if (!data.canEdit) {
      slot.innerHTML = `<p>${who ? `Веде: <b>${escapeHtml(who)}</b>` : "Не позначено"}</p>${hint}`;
      continue;
    }
    slot.innerHTML = `<label class="account-leadgen-row"><span>Веде</span>
      <select data-account-leadgen-select="${escapeAttr(accountId)}">
        <option value="">— не позначено —</option>
        ${data.people.map((person) => `<option value="${escapeAttr(person.id)}"${person.id === current ? " selected" : ""}>${escapeHtml(person.email)}</option>`).join("")}
      </select></label>${hint}`;
  }
}

document.addEventListener("change", async (event) => {
  const select = event.target.closest?.("[data-account-leadgen-select]");
  if (!select) return;
  select.disabled = true;
  try {
    await api("/api/today/leadgens", { method: "POST", body: JSON.stringify({ accountId: select.dataset.accountLeadgenSelect, userId: select.value }) });
    await load(true);
  } catch (error) {
    window.alert(error.message || "Не вдалося зберегти.");
    await load(true);
  }
  await fillAccountLeadgen();
});
