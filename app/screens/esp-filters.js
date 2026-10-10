// Пошта (ESP 6): виключення, фільтр країн і перевірка списку — у «Налаштуваннях».
//
// Перед кожним листом — не лише при завантаженні — його отримувач проходить
// перевірки: глобальні виключення назавжди (відписки, «ні», hard bounce, скарги,
// клієнти, партнери), верифікація не старша 30 днів, без catch-all, службових
// адрес і пошти Apple, лише пошта на Google, країна не з виключених, і є джерело
// з датою. Тут видно виключення й країни, а вставлений список можна перевірити
// до того, як людей додадуть у кампанію: хто піде, хто ніколи, хто чекає даних.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

onScreen("account", { open: () => void loadEspFilters() });

// ESP 17: a person erased on their own request stays excluded by a hash — not a category to pick by hand.
const CATEGORY_EXTRA = { erased: "видалено на прохання людини" };

export const espFiltersState = { data: null, error: "", notice: "", busy: false, check: null, checkText: "" };

export async function loadEspFilters() {
  try {
    espFiltersState.data = await api("/api/esp/filters");
    espFiltersState.error = "";
  } catch (error) {
    espFiltersState.error = error?.message || "Фільтри пошти не прочиталися.";
  }
  renderEspFilters();
}

function espCheckRowsHtml(results) {
  return results.map((row) => {
    const tone = row.ok ? "tone-live" : row.refused ? "tone-bad" : "tone-warn";
    const word = row.ok ? "піде" : row.refused ? "ніколи" : "чекає";
    return `<tr>
      <td>${escapeHtml(row.email)}</td>
      <td>${escapeHtml([row.name, row.company].filter(Boolean).join(" · "))}</td>
      <td><span class="pill ${tone}">${word}</span></td>
      <td>${escapeHtml(row.ok ? "усі перевірки пройдено" : row.label)}${row.detail && !row.ok ? `<span class="esp-subtle"> — ${escapeHtml(row.detail)}</span>` : ""}</td>
    </tr>`;
  }).join("");
}

export function renderEspFilters() {
  const root = document.getElementById("espFiltersBody");
  if (!root) return;
  const state = espFiltersState;
  if (state.error && !state.data) { root.innerHTML = `<div class="empty-state">${escapeHtml(state.error)}</div>`; return; }
  if (!state.data) { root.innerHTML = '<div class="empty-state">Читаємо фільтри пошти...</div>'; return; }
  const { exclusions = [], countries = [], categories = {}, verificationMaxDays = 30, canExclude, canSetCountries } = state.data;

  const list = exclusions.length
    ? `<div class="esp-list">${exclusions.slice(0, 50).map((row) => `<div class="esp-row"><div class="esp-row-main">
        <strong>${escapeHtml(row.key)}</strong> <span class="pill tone-muted">${escapeHtml(categories[row.category] || CATEGORY_EXTRA[row.category] || row.category)}</span>
        ${row.note ? `<span class="esp-subtle">${escapeHtml(row.note)}</span>` : ""}
        <span class="esp-subtle">${escapeHtml(row.actor || "")} · ${escapeHtml(new Date(row.at).toLocaleDateString())}</span>
      </div></div>`).join("")}</div>${exclusions.length > 50 ? `<p class="esp-subtle">І ще ${exclusions.length - 50}.</p>` : ""}`
    : '<p class="esp-subtle">Виключень ще немає. Відписки й hard bounce потрапляють сюди самі.</p>';

  const check = state.check ? `
    <p class="esp-subtle">Піде: <b>${state.check.counts.ok}</b> · ніколи: <b>${state.check.counts.refused}</b> · чекає даних: <b>${state.check.counts.waiting}</b>${state.check.rejected.length ? ` · рядків без адреси: <b>${state.check.rejected.length}</b>` : ""}</p>
    <div class="table-wrap"><table class="esp-matrix esp-check-table"><thead><tr><th>Адреса</th><th>Хто</th><th>Чи піде</th><th>Чому</th></tr></thead>
      <tbody>${espCheckRowsHtml(state.check.results)}</tbody></table></div>` : "";

  root.innerHTML = `
    ${state.notice ? `<p class="esp-notice ${state.error ? "is-bad" : ""}">${escapeHtml(state.notice)}</p>` : ""}
    <p class="esp-subtle">Перед кожним листом: виключення, верифікація не старша ${verificationMaxDays} днів, без catch-all, службових адрес (abuse@, postmaster@, admin@…) і @icloud.com, лише пошта на Google, країна не з виключених, є джерело й дата.</p>

    <h3 class="esp-title">Перевірити список</h3>
    <form class="esp-leads-check" id="espLeadsCheckForm">
      <textarea name="text" rows="5" placeholder="email,name,company,country,source,source_date,verification,verified_at&#10;olena@northwind.co.uk,Olena,Northwind,UK,Apollo,2026-10-01,valid,2026-10-05">${escapeHtml(state.checkText)}</textarea>
      <button type="submit"${state.busy ? " disabled" : ""}><i data-lucide="list-checks"></i><span>${state.busy ? "Перевіряю..." : "Перевірити"}</span></button>
    </form>
    ${check}

    <h3 class="esp-title">Виключені країни</h3>
    ${canSetCountries
      ? `<form class="esp-form" id="espCountriesForm"><input name="countries" value="${escapeAttr(countries.join(", "))}" placeholder="DE, PL, AT" /><button type="submit"><i data-lucide="save"></i><span>Зберегти</span></button></form>
         <p class="esp-subtle">Зараз: ${escapeHtml(countries.join(", ") || "жодної")}. PL, AT, DK, CZ, ES, IT, NL, CA — за рішенням після юриста. Людина без країни не йде.</p>`
      : `<p>${escapeHtml(countries.join(", ") || "жодної")}</p><p class="esp-subtle">Список міняє адміністратор.</p>`}

    <h3 class="esp-title">Глобальні виключення — назавжди</h3>
    ${canExclude ? `<form class="esp-form" id="espExcludeForm">
      <input name="key" placeholder="ivan@acme.com або @acme.com (увесь домен)" required />
      <select name="category">${Object.entries(categories).map(([key, label]) => `<option value="${escapeAttr(key)}">${escapeHtml(label)}</option>`).join("")}</select>
      <input name="note" placeholder="Нотатка (необов'язково)" />
      <button type="submit"><i data-lucide="ban"></i><span>Виключити</span></button>
    </form>` : ""}
    ${list}`;
  refreshIcons();
}

document.getElementById("espFiltersBody")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries(new FormData(form).entries());
  const state = espFiltersState;
  try {
    if (form.id === "espLeadsCheckForm") {
      state.checkText = values.text || "";
      state.busy = true;
      renderEspFilters();
      state.check = await api("/api/esp/leads/check", { method: "POST", body: JSON.stringify({ text: state.checkText }) });
      state.notice = "";
    } else if (form.id === "espExcludeForm") {
      const payload = await api("/api/esp/exclusions", { method: "POST", body: JSON.stringify(values) });
      state.notice = payload.unchanged ? `${values.key} уже у виключеннях.` : `${values.key} виключено назавжди.`;
      await loadEspFilters();
    } else if (form.id === "espCountriesForm") {
      const payload = await api("/api/esp/filters/countries", { method: "POST", body: JSON.stringify({ countries: values.countries }) });
      state.notice = payload.unchanged ? "Список той самий." : `Виключені країни: ${payload.countries.join(", ") || "жодної"}.`;
      await loadEspFilters();
    }
    state.error = "";
  } catch (error) {
    state.error = error?.message || "Не вдалося.";
    state.notice = state.error;
  } finally {
    state.busy = false;
    renderEspFilters();
  }
});
