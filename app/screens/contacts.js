// Контакти — the CRM: folders, a page of people, one person's card with their
// LinkedIn history.

import {
  HISTORY_EVENT_LABEL, INVITE_NOTE_DROPPED, api, escapeAttr, escapeHtml, fillSelect, linkIfUrl, onScreen, refreshIcons, relativeTime, runUiAction, setFormValue, setHtml, setText, state, uaPlural
} from "../core.js";
import {
  warmupApi
} from "../screens/warmup-accounts.js";

// CRM опитується, коли на неї дивляться.
onScreen("contacts", { open: () => void loadContactFolders().catch(() => {}) });

// Контакти CRM. Папка на двадцять дві тисячі людей не їздить у /api/state, тож
// сторінка тримає свою сторінку списку, вибрану людину і написані їй чернетки.
let contactFolders = [];

let contactFoldersLoaded = false;

let contactFolderId = null;

let crmContactRows = [];

let contactTotal = 0;

let contactOffset = 0;

let contactSearch = "";

let selectedContactId = null;

let contactRecord = null;

let contactDrafts = null;

let contactProspectId = null;

// Та сама стрічка, що й «Історія» на Панелі: запит, наші повідомлення і
// відповіді. Читається з прогріву окремо від картки, бо картка — з CRM, і одна
// не має чекати на другу.
let contactHistory = null;

let contactHistoryFor = "";

let contactHistoryNotice = "";

let contactsLoading = false;

let contactsError = "";

function historyEntryHtml(entry) {
  const when = entry.at ? relativeTime(entry.at) : "";
  const exact = entry.at ? new Date(entry.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }) : "";

  if (entry.kind === "invite") {
    return `
      <li class="history-entry is-invite">
        <div class="history-when" title="${escapeAttr(exact)}">${escapeHtml(when)}</div>
        <div class="history-body">
          <strong>${escapeHtml(HISTORY_EVENT_LABEL[entry.event] || entry.event)}</strong>
          ${entry.meta?.source === "campaign" ? `<small class="is-muted">з папки${entry.meta.campaignName ? ` «${escapeHtml(entry.meta.campaignName)}»` : ""}</small>` : ""}
          ${entry.meta?.note ? `<pre>${escapeHtml(entry.meta.note)}</pre>` : ""}
          ${entry.meta?.by ? `<small class="is-muted">${entry.meta.by === "agent" ? "надіслав агент" : "надіслано вручну"}${entry.meta.overQuota ? " · понад денну норму" : ""}${entry.meta.duringPause ? " · під час паузи, у норму не зараховано" : ""}${entry.meta.noteDropped ? ` · без записки: ${escapeHtml(INVITE_NOTE_DROPPED[entry.meta.noteDropped] || entry.meta.noteDropped)}` : ""}</small>` : ""}
          ${entry.meta?.outcome ? `<small class="is-muted">${escapeHtml(entry.meta.outcome)}</small>` : ""}
        </div>
      </li>
    `;
  }

  const mine = entry.direction === "out";
  return `
    <li class="history-entry ${mine ? "is-out" : "is-in"}">
      <div class="history-when" title="${escapeAttr(exact)}">${escapeHtml(when)}</div>
      <div class="history-body">
        <strong>${mine ? "Ми написали" : "Прийшло у відповідь"}</strong>
        <pre>${escapeHtml(entry.body || "")}</pre>
        <small class="is-muted">${[
          entry.accountLabel ? `${mine ? "з" : "на"} ${escapeHtml(entry.accountLabel)}` : "",
          entry.truncated ? "обрізано" : "",
          entry.matchedBy === "name_or_slug" ? "збіг за імʼям" : ""
        ].filter(Boolean).join(" · ")}</small>
      </div>
    </li>
  `;
}

function contactLinkedInLink(value) {
  const text = String(value || "").trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text.replace(/^\/\//, "")}`);
    if (!["http:", "https:"].includes(url.protocol) || !(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))) return "—";
    return `<a href="${escapeAttr(url.href)}" target="_blank" rel="noopener noreferrer">Відкрити LinkedIn</a>`;
  } catch { return "—"; }
}

/**
 * Контакти: папки CRM, людина в них, і три чернетки під три канали.
 *
 * CRM — чужа база, тож сторінка нічого в ній не змінює: читає папку, читає
 * картку і показує те, що написав AI. У робочий простір контакт потрапляє лише
 * тоді, коли його свідомо беруть у ліди.
 *
 * Стан тримається тут, а не в /api/state: папка на двадцять дві тисячі людей не
 * має їздити в кожній відповіді сервера.
 */
const CONTACT_PAGE_SIZE = 25;

function renderContacts() {
  const folderList = document.getElementById("contactFolderList");
  if (!folderList) return;

  if (contactsError) {
    folderList.innerHTML = `<div class="empty-state">${escapeHtml(contactsError)}</div>`;
  } else {
    folderList.innerHTML = contactFolders.length
      ? contactFolders.map((folder) => `
          <article class="contact-folder-row ${folder.id === contactFolderId ? "active" : ""}" data-contact-folder="${escapeAttr(folder.id)}">
            <strong>${escapeHtml(folder.name || "Без назви")}</strong>
            <span>${folder.contactCount} ${uaPlural(folder.contactCount, "контакт", "контакти", "контактів")}</span>
          </article>
        `).join("")
      : `<div class="empty-state">${contactsLoading ? "Читаємо CRM..." : "Папок не знайдено"}</div>`;
  }

  const folder = contactFolders.find((item) => item.id === contactFolderId);
  setText("contactListTitle", folder ? folder.name : "Контакти");
  setText(
    "contactListSubtitle",
    folder
      ? `${contactTotal} ${uaPlural(contactTotal, "контакт", "контакти", "контактів")}${contactSearch ? ` за запитом «${contactSearch}»` : ""}`
      : "Вибери папку, щоб побачити людей"
  );

  setHtml("crmContactList", crmContactRows.length
    ? crmContactRows.map((contact) => `
        <article class="contact-row ${contact.id === selectedContactId ? "active" : ""}" data-contact="${escapeAttr(contact.id)}">
          <strong>${escapeHtml(contact.name || "Без імені")}</strong>
          <span>${escapeHtml([contact.position, contact.company].filter(Boolean).join(" · ") || "посада і компанія невідомі")}</span>
          <small>${escapeHtml([contact.country, contact.lead_status].filter(Boolean).join(" · "))}${contactChannelHint(contact)}</small>
        </article>
      `).join("")
    : `<div class="empty-state">${contactsLoading ? "Читаємо контакти..." : contactFolderId ? "У цій папці нічого не знайшлося" : "Папку не вибрано"}</div>`);

  const from = contactTotal ? contactOffset + 1 : 0;
  const to = Math.min(contactOffset + CONTACT_PAGE_SIZE, contactTotal);
  setHtml("contactPager", contactTotal > CONTACT_PAGE_SIZE
    ? `
      <button type="button" id="contactPrevBtn" ${contactOffset === 0 ? "disabled" : ""}><i data-lucide="chevron-left"></i><span>Назад</span></button>
      <span>${from}–${to} з ${contactTotal}</span>
      <button type="button" id="contactNextBtn" ${to >= contactTotal ? "disabled" : ""}><span>Далі</span><i data-lucide="chevron-right"></i></button>
    `
    : "");

  renderContactCard();
  renderContactDrafts();
}

/** Якими каналами до цієї людини взагалі можна дотягнутися. */
function contactChannelHint(contact = {}) {
  const channels = [
    contact.email ? "пошта" : "",
    contact.linkedin ? "LinkedIn" : "",
    contact.telegram ? "Telegram" : "",
    contact.phone ? "телефон" : ""
  ].filter(Boolean);
  return channels.length ? ` · ${escapeHtml(channels.join(", "))}` : "";
}

const contactFieldLabels = {
  company: "Компанія",
  position: "Посада",
  country: "Країна",
  category: "Категорія",
  lead_status: "Статус ліда",
  lifecycle_stage: "Стадія",
  email: "Пошта",
  phone: "Телефон",
  telegram: "Telegram",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
  twitter: "Twitter",
  website: "Сайт",
  created_at: "Доданий у CRM"
};

function renderContactCard() {
  const contact = contactRecord;
  if (!contact) {
    setText("contactCardTitle", "Контакт не вибрано");
    setText("contactCardSubtitle", "");
    setText("contactCardPill", "—");
    setHtml("contactCardBody", `<div class="empty-state">Контакт не вибрано.</div>`);
    return;
  }

  setText("contactCardTitle", contact.name || "Без імені");
  setText("contactCardSubtitle", [contact.position, contact.company].filter(Boolean).join(" · ") || "посада і компанія невідомі");
  setText("contactCardPill", contactProspectId ? "уже в лідах" : "тільки в CRM");

  const rows = Object.entries(contactFieldLabels)
    .map(([key, label]) => {
      const value = contact[key];
      if (!value) return "";
      const text = key === "created_at" ? new Date(value).toLocaleDateString([], { dateStyle: "medium" }) : String(value);
      return `<div><dt>${escapeHtml(label)}</dt><dd>${key === "linkedin" ? contactLinkedInLink(text) : linkIfUrl(text)}</dd></div>`;
    })
    .filter(Boolean)
    .join("");

  const custom = contact.custom_fields && typeof contact.custom_fields === "object" && Object.keys(contact.custom_fields).length
    ? `<details class="contact-custom"><summary>Додаткові поля CRM</summary><pre>${escapeHtml(JSON.stringify(contact.custom_fields, null, 2))}</pre></details>`
    : "";

  setHtml("contactCardBody", `
    <dl class="contact-fields">${rows || `<div><dt>Порожньо</dt><dd>CRM не знає про цю людину нічого, крім імені</dd></div>`}</dl>
    ${contact.description ? `<div class="contact-note"><strong>Нотатка з CRM</strong><p>${escapeHtml(contact.description)}</p></div>` : ""}
    ${custom}
    ${contactHistoryFor && contactHistoryFor === String(contact.id) ? contactConversationHtml() : ""}
  `);
}

function renderContactDrafts() {
  const productSelect = document.getElementById("contactProductSelect");
  if (productSelect) {
    fillSelect(productSelect, state?.products || [], (product) => product.id, (product) => product.name, productSelect.value || state?.selectedProductId);
  }
  const form = document.getElementById("contactDraftForm");
  if (form) form.hidden = !contactRecord;

  const drafts = contactDrafts;
  setText("contactDraftsPill", drafts ? (drafts.provider === "openrouter" ? "AI" : "чернетка з брифу") : "немає");

  if (!drafts) {
    setHtml("contactDraftList", contactRecord
      ? `<div class="empty-state">Ще не згенеровано. AI прочитає картку контакту, опис продукту й файли — і напише лист, повідомлення в Telegram і LinkedIn.</div>`
      : `<div class="empty-state">Вибери контакт, щоб згенерувати повідомлення.</div>`);
    return;
  }

  const emailText = [drafts.email?.subject ? `Тема: ${drafts.email.subject}` : "", drafts.email?.body || ""].filter(Boolean).join("\n\n");
  setHtml("contactDraftList", `
    <article class="contact-draft">
      <header>
        <div><strong>Пошта</strong><span>${escapeHtml(drafts.email?.subject || "без теми")}</span></div>
        <button data-copy-text="${escapeAttr(emailText)}" data-copy-channel="email" data-copy-label="Лист для контакту"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(drafts.email?.body || "")}</pre>
      <small>${wordCountLabel(drafts.email?.body)}</small>
    </article>
    <article class="contact-draft">
      <header>
        <div><strong>Telegram</strong><span>${escapeHtml(contactRecord?.telegram || "юзернейм невідомий")}</span></div>
        <button data-copy-text="${escapeAttr(drafts.telegram?.body || "")}" data-copy-channel="telegram" data-copy-label="Telegram для контакту"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(drafts.telegram?.body || "")}</pre>
      <small>${wordCountLabel(drafts.telegram?.body)}</small>
    </article>
    <article class="contact-draft">
      <header>
        <div><strong>LinkedIn · запрошення</strong><span>до 300 символів, без пропозиції</span></div>
        <button data-copy-text="${escapeAttr(drafts.linkedin?.invite || "")}" data-copy-channel="linkedin" data-copy-label="Запрошення в LinkedIn"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(drafts.linkedin?.invite || "")}</pre>
      <small>${String(drafts.linkedin?.invite || "").length} символів</small>
    </article>
    <article class="contact-draft">
      <header>
        <div><strong>LinkedIn · перше повідомлення</strong><span>після прийняття запрошення</span></div>
        <button data-copy-text="${escapeAttr(drafts.linkedin?.body || "")}" data-copy-channel="linkedin" data-copy-label="Повідомлення в LinkedIn"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(drafts.linkedin?.body || "")}</pre>
      <small>${wordCountLabel(drafts.linkedin?.body)}</small>
    </article>
    <div class="contact-draft-meta">
      <span>${escapeHtml(drafts.productName || "продукт")} · ${escapeHtml(drafts.modelUsed || "локально")} · ${relativeTime(drafts.generatedAt)}</span>
      ${(drafts.grounding || []).length ? `<div><strong>На чому тримається</strong><ul>${drafts.grounding.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
      ${(drafts.verifyBeforeSending || []).length ? `<div class="contact-draft-warning"><strong>Перевір перед відправкою</strong><ul>${drafts.verifyBeforeSending.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
    </div>
  `);
}

function wordCountLabel(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean).length;
  return `${words} ${uaPlural(words, "слово", "слова", "слів")}`;
}

/**
 * Папки CRM, прочитані один раз на дві сторінки.
 *
 * Їх питають і «Контакти», і «Панель», і це той самий список — тримати дві
 * копії означало б показувати різні папки на сусідніх вкладках.
 */
async function fetchContactFolders({ force = false } = {}) {
  if (contactFoldersLoaded && !force) return contactFolders;
  const payload = await api("/api/contacts/folders");
  contactFolders = payload.folders || [];
  contactFoldersLoaded = true;
  // Порожня CRM і CRM, прочитана не тим ключем, виглядають однаково — сервер
  // розрізняє їх за нас, і сторінка повторює це словами.
  contactsError = contactFolders.length ? "" : payload.warning || "";
  return contactFolders;
}

export async function loadContactFolders({ force = false } = {}) {
  // Панель читає той самий список папок одразу після входу, тож «завантажено»
  // буває правдою ще до того, як цей екран його намалював. Малюємо наявне,
  // а не лишаємо порожній список до натискання «Оновити».
  if (contactFoldersLoaded && !force) {
    if (!contactFolderId && contactFolders.length) await selectContactFolder(contactFolders[0].id);
    else renderContacts();
    return;
  }
  contactsLoading = true;
  contactsError = "";
  renderContacts();
  try {
    await fetchContactFolders({ force });
    if (!contactFolderId && contactFolders.length) {
      await selectContactFolder(contactFolders[0].id);
      return;
    }
  } catch (error) {
    contactsError = error.message || "CRM не відповіла.";
  } finally {
    contactsLoading = false;
    renderContacts();
    refreshIcons();
  }
}

async function loadContactPage() {
  if (!contactFolderId) return;
  contactsLoading = true;
  renderContacts();
  try {
    const params = new URLSearchParams({
      folderId: contactFolderId,
      limit: String(CONTACT_PAGE_SIZE),
      offset: String(contactOffset)
    });
    if (contactSearch) params.set("search", contactSearch);
    const page = await api(`/api/contacts?${params}`);
    crmContactRows = page.contacts || [];
    contactTotal = page.total || 0;
    contactsError = "";
  } catch (error) {
    crmContactRows = [];
    contactTotal = 0;
    contactsError = error.message || "CRM не відповіла.";
  } finally {
    contactsLoading = false;
    renderContacts();
    refreshIcons();
  }
}

async function selectContactFolder(folderId) {
  contactFolderId = folderId;
  contactOffset = 0;
  await loadContactPage();
}

/**
 * A person's card from another screen — the conversation in «Вхідні» names who
 * wrote, and the card is where that person's history and status already are.
 * Goes through the menu item so the shell does what it always does on a switch.
 */
export function showContactCard(contactId) {
  document.querySelector('.nav-item[data-view="contacts"]')?.click();
  return openContact(String(contactId));
}

async function openContact(contactId) {
  selectedContactId = contactId;
  contactRecord = null;
  contactDrafts = null;
  contactProspectId = null;
  void loadContactHistory(contactId);
  renderContacts();
  try {
    const payload = await api(`/api/contacts/${encodeURIComponent(contactId)}`);
    contactRecord = payload.contact;
    contactDrafts = payload.drafts;
    contactProspectId = payload.prospectId;
    // Мова й продукт беруться з того, що вже писали цій людині, щоб повтор не
    // починався з чужих налаштувань.
    if (payload.drafts?.language) setFormValue("contactLanguageSelect", payload.drafts.language);
    if (payload.drafts?.productId) setFormValue("contactProductSelect", payload.drafts.productId);
  } catch (error) {
    contactsError = error.message || "Не вдалося прочитати контакт.";
  }
  renderContacts();
  refreshIcons();
}

/**
 * Листування з людиною для картки контакту — той самий маршрут, що й вкладка
 * «Історія». Прогрів — окрема база: якщо він не відповів, картка з CRM
 * лишається на місці, а замість стрічки — одне речення чому.
 */
async function loadContactHistory(contactId) {
  contactHistoryFor = contactId;
  contactHistory = null;
  contactHistoryNotice = "";
  try {
    const payload = await warmupApi(`/history?crmContactId=${encodeURIComponent(contactId)}`);
    // Людину могли перемкнути, поки відповідь ішла.
    if (contactHistoryFor !== contactId) return;
    contactHistory = payload.entries || [];
  } catch (error) {
    if (contactHistoryFor !== contactId) return;
    contactHistoryNotice = error.message || "Прогрів не відповів.";
  }
  renderContactCard();
  refreshIcons();
}

function contactConversationHtml() {
  const body = contactHistoryNotice
    ? `<p>Листування не прочиталося: ${escapeHtml(contactHistoryNotice)}</p>`
    : !contactHistory
      ? `<p>Читаємо листування...</p>`
      : !contactHistory.length
        ? `<p>Ще нічого.</p>`
        : `<ol class="history-feed">${contactHistory.map(historyEntryHtml).join("")}</ol>`;
  return `
    <section class="contact-history">
      <strong>Листування в LinkedIn</strong>
      ${body}
    </section>
  `;
}

document.getElementById("contactFolderList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-contact-folder]");
  if (!row || row.dataset.contactFolder === contactFolderId) return;
  await selectContactFolder(row.dataset.contactFolder);
});

document.getElementById("contactFoldersRefreshBtn").addEventListener("click", async () => {
  await loadContactFolders({ force: true });
  await loadContactPage();
});

document.getElementById("crmContactList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-contact]");
  if (!row) return;
  await openContact(row.dataset.contact);
});

document.getElementById("contactPager").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  contactOffset = button.id === "contactPrevBtn"
    ? Math.max(0, contactOffset - CONTACT_PAGE_SIZE)
    : contactOffset + CONTACT_PAGE_SIZE;
  await loadContactPage();
});

// Пошук чекає, поки людина допише: кожна літера — це запит у CRM.
let contactSearchTimer = null;

document.getElementById("contactSearchInput").addEventListener("input", (event) => {
  const value = event.target.value.trim();
  window.clearTimeout(contactSearchTimer);
  contactSearchTimer = window.setTimeout(async () => {
    contactSearch = value;
    contactOffset = 0;
    await loadContactPage();
  }, 350);
});

document.getElementById("contactDraftForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedContactId) return;
  await runUiAction("contact-drafts", "AI читає контакт, продукт і файли та пише чернетки...", async () => {
    const payload = await api(`/api/contacts/${encodeURIComponent(selectedContactId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        productId: document.getElementById("contactProductSelect").value,
        language: document.getElementById("contactLanguageSelect").value,
        instruction: document.getElementById("contactInstructionInput").value
      })
    });
    contactDrafts = payload.drafts;
  });
  renderContacts();
  refreshIcons();
});
