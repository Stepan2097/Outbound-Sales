// Пошта (ESP 17): запит людини про її дані — у «Налаштуваннях».
//
// Людина пише «що у вас про мене є?» або «видаліть мене». Тут за адресою видно,
// звідки вона взялася (кампанія, джерело, дата), кожен лист так, як він пішов,
// і що прийшло у відповідь; це можна віддати їй файлом. Видалення — назавжди:
// з журналу й кампаній зникає все, що її називає, у виключеннях лишається хеш
// адреси, тож вставлена знову вона не піде. Читати — право журналу, видаляти —
// лише адміністратор.

import { api, escapeAttr, escapeHtml, refreshIcons } from "../core.js";

const privacy = { email: "", person: null, error: "", notice: "", busy: false };

const when = (value) => (value ? new Date(value).toLocaleString() : "");
const TYPE_WORDS = {
  "message.replied": "відповідь", "message.autoreplied": "автовідповідь", "message.bounced": "bounce",
  "contact.unsubscribed": "відписка", "contact.skipped": "пропущено перевіркою", "contact.note": "нотатка", "exclusion.added": "виключено"
};

function personHtml(person) {
  if (person.erased && !person.found) {
    return `<p class="esp-notice">Видалено ${escapeHtml(when(person.erased.at))} (${escapeHtml(person.erased.by)}): у журналі й кампаніях про цю адресу нічого немає, у виключеннях — лише її хеш.</p>`;
  }
  if (!person.found) {
    return `<p class="esp-subtle">Про ${escapeHtml(person.email)} у холодній пошті нічого немає${person.excluded ? " — адреса лише у виключеннях" : ""}.</p>`;
  }
  const sources = person.sources.map((row) => `<div class="esp-row"><div class="esp-row-main">
      <strong>${escapeHtml(row.campaign)}</strong> <span class="pill tone-muted">${escapeHtml(row.status)}</span>
      <span class="esp-subtle">джерело: ${escapeHtml(row.source || "не вказано")}${row.sourceDate ? `, ${escapeHtml(row.sourceDate)}` : ""} · додано ${escapeHtml(when(row.enrolledAt))} · з ${escapeHtml(row.sender || "")}</span>
    </div></div>`).join("");
  const sent = person.sent.map((row) => `<details class="esp-row"><summary><strong>${escapeHtml(row.subject || "(без теми)")}</strong>
      <span class="esp-subtle">${escapeHtml(when(row.at))} · ${escapeHtml(row.from || "")} · ${escapeHtml(row.campaign || "")}${row.step !== null ? `, крок ${row.step + 1}` : ""} · ${row.state === "sent" ? "надіслано" : row.state === "failed" ? "не пішло" : "не підтверджено"}</span></summary>
      <pre class="esp-letter">${escapeHtml(row.text || "")}</pre></details>`).join("");
  const received = person.received.map((row) => `<details class="esp-row"><summary><strong>${escapeHtml(TYPE_WORDS[row.type] || row.type)}</strong>
      <span class="esp-subtle">${escapeHtml(when(row.at))}${row.code ? ` · ${escapeHtml(row.code)}` : ""}${row.subject ? ` · ${escapeHtml(row.subject)}` : ""}</span></summary>
      ${row.text ? `<pre class="esp-letter">${escapeHtml(row.text)}</pre>` : ""}</details>`).join("");
  const events = person.events.map((row) => `<li>${escapeHtml(when(row.at))} — ${escapeHtml(TYPE_WORDS[row.type] || row.type)}${row.data?.reason ? `: ${escapeHtml(row.data.reason)}` : ""}</li>`).join("");
  return `
    <h3 class="esp-title">Звідки адреса</h3>
    ${sources ? `<div class="esp-list">${sources}</div>` : '<p class="esp-subtle">У жодній кампанії зараз немає — лише записи в журналі.</p>'}
    <h3 class="esp-title">Що надсилали (${person.sent.length})</h3>
    ${sent ? `<div class="esp-list">${sent}</div>` : '<p class="esp-subtle">Жодного листа.</p>'}
    ${received ? `<h3 class="esp-title">Що прийшло у відповідь (${person.received.length})</h3><div class="esp-list">${received}</div>` : ""}
    ${events ? `<h3 class="esp-title">Інше</h3><ul class="esp-subtle">${events}</ul>` : ""}
    ${person.excluded ? `<p class="esp-subtle">У виключеннях: ${escapeHtml(person.excluded.category)}${person.excluded.domain ? " (увесь домен)" : ""}.</p>` : ""}`;
}

export function renderEspPrivacy() {
  const root = document.getElementById("espPrivacyBody");
  if (!root) return;
  const person = privacy.person;
  root.innerHTML = `
    ${privacy.notice ? `<p class="esp-notice ${privacy.error ? "is-bad" : ""}">${escapeHtml(privacy.notice)}</p>` : ""}
    <form class="esp-form" id="espPrivacyFindForm">
      <input name="email" type="email" value="${escapeAttr(privacy.email)}" placeholder="olena@northwind.com" required />
      <button type="submit"${privacy.busy ? " disabled" : ""}><i data-lucide="search"></i><span>${privacy.busy ? "Шукаю..." : "Показати дані"}</span></button>
      ${person?.found ? '<button type="button" class="text-button" id="espPrivacyDownload"><i data-lucide="download"></i><span>Файл для людини (JSON)</span></button>' : ""}
    </form>
    ${person ? personHtml(person) : '<p class="esp-subtle">Введіть адресу людини, що запитала про свої дані.</p>'}
    ${person && (person.found || !person.erased) ? `
      <h3 class="esp-title">Видалити назавжди</h3>
      <p class="esp-subtle">Зникне все, що називає ${escapeHtml(person.email)}: рядки в кампаніях, тексти листів і відповідей у журналі. Лічильники сендерів лишаються, у виключеннях — хеш адреси, тож вставлена знову вона не піде. Відмінити не можна.</p>
      <form class="esp-form" id="espPrivacyEraseForm">
        <input name="confirm" placeholder="Введіть адресу ще раз" autocomplete="off" required />
        <input name="note" placeholder="Підстава (лист людини, дата)" />
        <button type="submit" class="danger-button"${privacy.busy ? " disabled" : ""}><i data-lucide="trash-2"></i><span>Видалити</span></button>
      </form>` : ""}`;
  refreshIcons();
}

async function find(email) {
  privacy.email = email;
  privacy.person = (await api(`/api/esp/people/export?email=${encodeURIComponent(email)}`)).person;
}

const root = document.getElementById("espPrivacyBody");
root?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries(new FormData(form).entries());
  privacy.busy = true;
  renderEspPrivacy();
  try {
    if (form.id === "espPrivacyFindForm") {
      await find(String(values.email || "").trim());
      privacy.notice = "";
    } else if (form.id === "espPrivacyEraseForm") {
      const { erased } = await api("/api/esp/people/erase", { method: "POST", body: JSON.stringify({ email: privacy.email, confirm: values.confirm, note: values.note }) });
      await find(privacy.email);
      privacy.notice = `Видалено: рядків журналу — ${erased.journalLines}, рядків у кампаніях — ${erased.campaignRows}. У виключеннях лишився хеш адреси.`;
    }
    privacy.error = "";
  } catch (error) {
    privacy.error = error?.message || "Не вдалося.";
    privacy.notice = privacy.error;
  } finally {
    privacy.busy = false;
    renderEspPrivacy();
  }
});

root?.addEventListener("click", (event) => {
  if (!event.target.closest("#espPrivacyDownload") || !privacy.person) return;
  const blob = new Blob([JSON.stringify(privacy.person, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `data-${privacy.person.email}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

renderEspPrivacy();
