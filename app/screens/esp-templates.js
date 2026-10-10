// Листи (ESP 2): шаблони холодних листів — тема й текст лише простим текстом,
// змінні, підпис, і перегляд того листа, що піде конкретній людині. Звідси
// нічого не надсилається: відправка з'явиться з ланцюжком (ESP 5) і лише після
// приймання ESP 11.
//
// Вигляд — приблизно редактор листа Snov.io (тема, «Змінна», «Plain text»,
// «Preview», «Save»), але без HTML-панелі, трекінгу й піксель-налаштувань: у
// нас їх немає за чеклістом, тож і кнопок для них немає.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, setHtml } from "../core.js";

onScreen("email", { open: () => void loadEspTemplates() });

const REMOVED_LABEL = {
  html: "HTML-теги",
  styles: "стилі",
  nbsp: "нерозривні пробіли",
  invisible: "невидимі символи",
  entities: "HTML-сутності"
};

const espTemplatesState = {
  ready: false,
  error: "",
  templates: [],
  variables: [],
  signature: null,
  // null — новий шаблон; рядок — той, що відкрито.
  openId: null,
  draft: { name: "", subject: "", body: "" },
  notice: "",
  noticeTone: "",
  busy: false,
  sample: { name: "Olena Hrytsenko", company: "Northwind", country: "Poland" },
  preview: null,
  signatureNotice: ""
};

// Поле, куди «Змінна» вставляє: тема чи текст — те, де стояв курсор.
let espLastField = "espTemplateBody";

export async function loadEspTemplates() {
  try {
    const payload = await api("/api/esp/templates");
    espTemplatesState.templates = payload.templates || [];
    espTemplatesState.variables = payload.variables || [];
    espTemplatesState.signature = payload.signature || null;
    espTemplatesState.error = "";
    if (espTemplatesState.openId && !espTemplatesState.templates.some((template) => template.id === espTemplatesState.openId)) {
      espTemplatesState.openId = null;
    }
    if (!espTemplatesState.ready && espTemplatesState.templates.length && !espTemplatesState.openId) {
      openEspTemplate(espTemplatesState.templates[0].id, { render: false });
    }
  } catch (error) {
    espTemplatesState.error = error.status === 403
      ? "Шаблони листів налаштовує адміністратор робочого простору."
      : error.message || "Шаблони не вдалося прочитати.";
  }
  espTemplatesState.ready = true;
  renderEspTemplates();
}

function openEspTemplate(id, { render = true } = {}) {
  const template = espTemplatesState.templates.find((row) => row.id === id) || null;
  espTemplatesState.openId = template?.id || null;
  espTemplatesState.draft = template
    ? { name: template.name, subject: template.subject, body: template.body }
    : { name: "", subject: "", body: "" };
  espTemplatesState.notice = "";
  espTemplatesState.preview = null;
  if (render) renderEspTemplates();
}

function espTemplateListHtml() {
  const { templates, openId } = espTemplatesState;
  if (!templates.length) return '<div class="empty-state">Шаблонів ще немає — почни з нового.</div>';
  return `<ul class="esp-template-list">${templates.map((template) => `
    <li>
      <button type="button" class="esp-template-row ${template.id === openId ? "is-open" : ""}" data-esp-template="${escapeAttr(template.id)}">
        <strong>${escapeHtml(template.name)}</strong>
        <span>${escapeHtml(template.subject)}</span>
      </button>
    </li>`).join("")}</ul>`;
}

function espEditorHtml() {
  const { draft, variables, busy, notice, noticeTone, openId } = espTemplatesState;
  return `
    <form class="esp-editor" id="espTemplateForm">
      <input id="espTemplateName" type="text" placeholder="Назва шаблону (бачиш лише ти)" value="${escapeAttr(draft.name)}" />
      <label class="esp-subject">
        <span>Тема</span>
        <input id="espTemplateSubject" type="text" placeholder="Коротко й по-людськи" value="${escapeAttr(draft.subject)}" required />
      </label>
      <div class="esp-toolbar">
        <select id="espVariableSelect" aria-label="Вставити змінну">
          <option value="">{ } Змінна</option>
          ${variables.map((variable) => `<option value="${escapeAttr(variable.name)}">${escapeHtml(variable.label)} — {{${escapeHtml(variable.name)}}}</option>`).join("")}
        </select>
        <span class="pill tone-muted" title="Лист іде однією частиною text/plain: без HTML, без пікселя відкриттів і без переписаних посилань">Лише простий текст</span>
        <small>Порожня змінна без заміни — лист цій людині не піде. Заміна: <code>{{first_name|друже}}</code></small>
      </div>
      <textarea id="espTemplateBody" rows="12" placeholder="Встав або напиши текст листа. Форматування з Google Docs знімається при збереженні." required>${escapeHtml(draft.body)}</textarea>
      ${notice ? `<p class="esp-notice ${noticeTone}">${escapeHtml(notice)}</p>` : ""}
      <div class="esp-editor-actions">
        <button class="primary-button" type="submit" ${busy ? "disabled" : ""}><i data-lucide="save"></i><span>${busy ? "Зберігаємо..." : "Зберегти"}</span></button>
        ${openId ? `<button class="danger-button" type="button" id="espTemplateDelete" ${busy ? "disabled" : ""}>Видалити</button>` : ""}
      </div>
    </form>
  `;
}

function espPreviewHtml() {
  const { sample, preview } = espTemplatesState;
  const result = !preview
    ? ""
    : preview.ok
      ? `<div class="esp-preview-letter">
          <div class="esp-preview-subject"><span>Тема</span><strong>${escapeHtml(preview.subject)}</strong></div>
          <pre>${escapeHtml(preview.text)}</pre>
          ${preview.listUnsubscribe ? `<dl class="esp-preview-headers">
            <div><dt>List-Unsubscribe</dt><dd>${escapeHtml(preview.listUnsubscribe)}</dd></div>
            <div><dt>List-Unsubscribe-Post</dt><dd>${escapeHtml(preview.listUnsubscribePost)}</dd></div>
          </dl>` : ""}
          <small>${escapeHtml(preview.contentType)} · ${preview.bytes} байт · відписка в один клік на домені відправника · нічого не надіслано</small>
        </div>`
      : `<p class="esp-notice is-bad">${escapeHtml(preview.error || "Цій людині лист не піде.")}</p>`;
  return `
    <form class="esp-preview-form" id="espPreviewForm">
      <input id="espSampleName" type="text" placeholder="Ім'я та прізвище" value="${escapeAttr(sample.name)}" />
      <input id="espSampleCompany" type="text" placeholder="Компанія" value="${escapeAttr(sample.company)}" />
      <input id="espSampleCountry" type="text" placeholder="Країна" value="${escapeAttr(sample.country)}" />
      <button type="submit"><i data-lucide="eye"></i><span>Переглянути лист</span></button>
    </form>
    ${result}
  `;
}

function espSignatureHtml() {
  const signature = espTemplatesState.signature || {};
  return `
    <form class="integration-form esp-signature-form" id="espSignatureForm">
      <input id="espSignatureName" type="text" placeholder="Ім'я" value="${escapeAttr(signature.name || "")}" />
      <input id="espSignatureTitle" type="text" placeholder="Посада" value="${escapeAttr(signature.title || "")}" />
      <input id="espSignatureCompany" type="text" placeholder="Компанія" value="${escapeAttr(signature.company || "ADvantage")}" />
      <input id="espSignatureSite" type="text" placeholder="Сайт" value="${escapeAttr(signature.site || "")}" />
      <textarea id="espSignatureAddress" rows="2" placeholder="Поштова адреса юрособи — додається лише для лідів зі США">${escapeHtml(signature.usPostalAddress || "")}</textarea>
      <button type="submit"><i data-lucide="pen-line"></i><span>Зберегти підпис</span></button>
    </form>
    ${espTemplatesState.signatureNotice ? `<p class="esp-notice is-ok">${escapeHtml(espTemplatesState.signatureNotice)}</p>` : ""}
  `;
}

export function renderEspTemplates() {
  if (!document.getElementById("espTemplatesBody")) return;
  if (espTemplatesState.error) {
    setHtml("espTemplatesBody", `<div class="empty-state">${escapeHtml(espTemplatesState.error)}</div>`);
    setHtml("espEditorBody", "");
    setHtml("espSignatureBody", "");
    return;
  }
  if (!espTemplatesState.ready) {
    setHtml("espTemplatesBody", '<div class="empty-state">Читаємо шаблони...</div>');
    return;
  }
  setHtml("espTemplatesBody", espTemplateListHtml());
  setHtml("espEditorTitle", espTemplatesState.openId ? "Шаблон" : "Новий шаблон");
  setHtml("espEditorBody", `${espEditorHtml()}<h3 class="esp-preview-title">Як піде конкретній людині</h3>${espPreviewHtml()}`);
  setHtml("espSignatureBody", espSignatureHtml());
  refreshIcons();
}

function readDraft() {
  return {
    name: document.getElementById("espTemplateName")?.value ?? "",
    subject: document.getElementById("espTemplateSubject")?.value ?? "",
    body: document.getElementById("espTemplateBody")?.value ?? ""
  };
}

async function saveEspTemplate() {
  espTemplatesState.draft = readDraft();
  espTemplatesState.busy = true;
  renderEspTemplates();
  try {
    const answer = await api("/api/esp/templates", {
      method: espTemplatesState.openId ? "PATCH" : "POST",
      body: JSON.stringify({ id: espTemplatesState.openId, ...espTemplatesState.draft })
    });
    espTemplatesState.templates = answer.templates || espTemplatesState.templates;
    espTemplatesState.openId = answer.template.id;
    espTemplatesState.draft = { name: answer.template.name, subject: answer.template.subject, body: answer.template.body };
    const removed = (answer.removed || []).map((key) => REMOVED_LABEL[key] || key);
    espTemplatesState.notice = removed.length ? `Збережено. Прибрано: ${removed.join(", ")} — у листі лише простий текст.` : "Збережено.";
    espTemplatesState.noticeTone = "is-ok";
  } catch (error) {
    espTemplatesState.notice = error.message || "Не вдалося зберегти.";
    espTemplatesState.noticeTone = "is-bad";
  } finally {
    espTemplatesState.busy = false;
    renderEspTemplates();
  }
}

async function previewEspTemplate() {
  espTemplatesState.draft = readDraft();
  espTemplatesState.sample = {
    name: document.getElementById("espSampleName")?.value ?? "",
    company: document.getElementById("espSampleCompany")?.value ?? "",
    country: document.getElementById("espSampleCountry")?.value ?? ""
  };
  try {
    // Те, що зараз у редакторі, навіть не збережене: перегляд чистить і
    // перевіряє так само, як збереження.
    espTemplatesState.preview = await api("/api/esp/preview", {
      method: "POST",
      body: JSON.stringify({ subject: espTemplatesState.draft.subject, body: espTemplatesState.draft.body, lead: espTemplatesState.sample, mailbox: "sender@your-domain.com" })
    });
  } catch (error) {
    espTemplatesState.preview = { ok: false, error: error.message };
  }
  renderEspTemplates();
}

document.getElementById("view-email")?.addEventListener("click", async (event) => {
  const row = event.target.closest("[data-esp-template]");
  if (row) return openEspTemplate(row.dataset.espTemplate);
  if (event.target.closest("#espTemplateNew")) return openEspTemplate(null);
  if (event.target.closest("#espTemplateDelete")) {
    if (!window.confirm("Видалити цей шаблон?")) return;
    const answer = await api(`/api/esp/templates?id=${encodeURIComponent(espTemplatesState.openId)}`, { method: "DELETE" }).catch((error) => ({ error: error.message }));
    if (answer.templates) espTemplatesState.templates = answer.templates;
    openEspTemplate(null);
  }
});

document.getElementById("view-email")?.addEventListener("focusin", (event) => {
  if (event.target.id === "espTemplateSubject" || event.target.id === "espTemplateBody") espLastField = event.target.id;
});

document.getElementById("view-email")?.addEventListener("change", (event) => {
  if (event.target.id !== "espVariableSelect" || !event.target.value) return;
  const field = document.getElementById(espLastField);
  const token = `{{${event.target.value}}}`;
  event.target.value = "";
  if (!field) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = `${field.value.slice(0, start)}${token}${field.value.slice(end)}`;
  field.focus();
  field.setSelectionRange(start + token.length, start + token.length);
});

document.getElementById("view-email")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "espTemplateForm") return saveEspTemplate();
  if (event.target.id === "espPreviewForm") return previewEspTemplate();
  if (event.target.id === "espSignatureForm") {
    const value = (id) => document.getElementById(id)?.value ?? "";
    try {
      const answer = await api("/api/esp/signature", {
        method: "PUT",
        body: JSON.stringify({
          name: value("espSignatureName"), title: value("espSignatureTitle"), company: value("espSignatureCompany"),
          site: value("espSignatureSite"), usPostalAddress: value("espSignatureAddress")
        })
      });
      espTemplatesState.signature = answer.signature;
      espTemplatesState.signatureNotice = "Підпис збережено — лише текст.";
    } catch (error) {
      espTemplatesState.signatureNotice = error.message;
    }
    renderEspTemplates();
  }
});
