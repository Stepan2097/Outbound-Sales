// Контакти — the CRM and nothing else: pick a folder, find a person in it, open
// their card. The card is what the CRM says about them and what the warm-up has
// done with them on LinkedIn: where their request stands, and the conversation.

import {
  HISTORY_EVENT_LABEL, INVITE_NOTE_DROPPED, api, escapeAttr, escapeHtml, linkIfUrl, onScreen, refreshIcons, relativeTime, setHtml, setText, uaPlural
} from "../core.js";
import {
  WARMUP_OUTREACH_LABEL, WARMUP_OUTREACH_TONE, warmupApi
} from "../screens/warmup-accounts.js";

// CRM опитується, коли на неї дивляться, але не частіше за раз на хвилину: кнопки
// «Оновити» тут нема, тож нова папка чи нова людина з'являється, коли повертаєшся
// на екран, а не коли пам'ятаєш, що її треба шукати.
onScreen("contacts", { open: () => void openContactsScreen() });

const CONTACTS_STALE_MS = 60_000;

async function openContactsScreen() {
  const stale = Date.now() - contactsLoadedAt > CONTACTS_STALE_MS;
  try {
    await loadContactFolders({ force: stale });
    if (stale && contactFolderId) await loadContactPage();
  } catch {
    // Помилку CRM уже видно в самому списку (contactsError).
  }
}

// Контакти CRM. Папка на двадцять дві тисячі людей не їздить у /api/state, тож
// сторінка тримає свою сторінку списку й вибрану людину.
let contactFolders = [];

let contactFoldersLoaded = false;

let contactFolderId = null;

let crmContactRows = [];

let contactTotal = 0;

let contactOffset = 0;

let contactSearch = "";

let selectedContactId = null;

let contactRecord = null;

// Запит, наші повідомлення і відповіді. Читається з прогріву окремо від картки,
// бо картка — з CRM, і одна не має чекати на другу.
let contactHistory = null;

let contactHistoryFor = "";

let contactHistoryNotice = "";

// Де ця людина в запрошеннях LinkedIn: рядок підходу, який віддає історія. Null —
// запитів із цього простору їй не було.
let contactOutreach = null;

// Коли CRM читали востаннє; нуль — ще ні.
let contactsLoadedAt = 0;

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
 * Контакти: папка CRM, людина в ній, її картка.
 *
 * CRM — чужа база, тож сторінка нічого в ній не змінює: читає папку й картку.
 * Стан тримається тут, а не в /api/state: папка на двадцять дві тисячі людей не
 * має їздити в кожній відповіді сервера.
 */
const CONTACT_PAGE_SIZE = 25;

function renderContacts() {
  const folderSelect = document.getElementById("contactFolderSelect");
  if (!folderSelect) return;

  // Папка — випадаючий список із кількістю людей; поки CRM мовчить, у ньому
  // стоїть підказка, а не порожній прямокутник.
  folderSelect.innerHTML = contactFolders.length
    ? contactFolders.map((folder) =>
      `<option value="${escapeAttr(folder.id)}"${folder.id === contactFolderId ? " selected" : ""}>${escapeHtml(folder.name || "Без назви")} · ${folder.contactCount} ${uaPlural(folder.contactCount, "контакт", "контакти", "контактів")}</option>`).join("")
    : `<option value="">${contactsLoading ? "Читаємо CRM..." : "Папок не знайдено"}</option>`;
  folderSelect.disabled = !contactFolders.length;

  const folder = contactFolders.find((item) => item.id === contactFolderId);
  setText(
    "contactListSubtitle",
    folder
      ? `${contactTotal} ${uaPlural(contactTotal, "контакт", "контакти", "контактів")}${contactSearch ? ` за запитом «${contactSearch}»` : ""}`
      : "Вибери папку, щоб побачити людей"
  );

  setHtml("crmContactList", contactsError
    ? `<div class="empty-state">${escapeHtml(contactsError)}</div>`
    : crmContactRows.length
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

/**
 * Де людина в запрошеннях LinkedIn, одним словом на картці. Це відповідь
 * прогріву, не CRM, тому поки вона йде — «…», а коли прогрів мовчить — «—»:
 * «запиту не було» є твердженням, і його не можна вимовити, не знаючи.
 */
function contactRequestPill() {
  if (contactHistoryNotice) {
    return { text: "—", tone: "tone-muted", title: "Прогрів не відповів, тож про запит нічого не відомо" };
  }
  if (!contactHistory) {
    return { text: "…", tone: "tone-muted", title: "Читаємо листування" };
  }
  const status = contactOutreach?.status;
  if (!status) {
    return { text: "запиту не було", tone: "tone-muted", title: "З цього простору цій людині запитів у LinkedIn не ставили" };
  }
  return { text: WARMUP_OUTREACH_LABEL[status] || status, tone: WARMUP_OUTREACH_TONE[status] || "tone-muted", title: "Де ця людина в запрошеннях LinkedIn" };
}

function renderContactPill() {
  const pill = document.getElementById("contactCardPill");
  if (!pill) return;
  const { text, tone, title } = contactRequestPill();
  pill.className = `pill ${tone}`;
  pill.textContent = text;
  pill.title = title;
}

function renderContactCard() {
  const contact = contactRecord;
  if (!contact) {
    setText("contactCardTitle", "Контакт не вибрано");
    setText("contactCardSubtitle", "");
    const pill = document.getElementById("contactCardPill");
    if (pill) { pill.className = "pill tone-muted"; pill.textContent = "—"; }
    setHtml("contactCardBody", `<div class="empty-state">Контакт не вибрано.</div>`);
    return;
  }

  setText("contactCardTitle", contact.name || "Без імені");
  setText("contactCardSubtitle", [contact.position, contact.company].filter(Boolean).join(" · ") || "посада і компанія невідомі");
  renderContactPill();

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

/**
 * Папки CRM, прочитані раз на хвилину, а не при кожному поверненні на екран:
 * це та сама відповідь, і заново питати її щоразу означало б лише блимання списку.
 */
async function fetchContactFolders({ force = false } = {}) {
  if (contactFoldersLoaded && !force) return contactFolders;
  const payload = await api("/api/contacts/folders");
  contactFolders = payload.folders || [];
  contactFoldersLoaded = true;
  contactsLoadedAt = Date.now();
  // Порожня CRM і CRM, прочитана не тим ключем, виглядають однаково — сервер
  // розрізняє їх за нас, і сторінка повторює це словами.
  contactsError = contactFolders.length ? "" : payload.warning || "";
  return contactFolders;
}

export async function loadContactFolders({ force = false } = {}) {
  // Папки могли бути прочитані ще до того, як цей екран їх намалював. Малюємо
  // наявне, а не лишаємо порожній список.
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
  void loadContactHistory(contactId);
  renderContacts();
  try {
    const payload = await api(`/api/contacts/${encodeURIComponent(contactId)}`);
    contactRecord = payload.contact;
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
  contactOutreach = null;
  contactHistoryNotice = "";
  try {
    const payload = await warmupApi(`/history?crmContactId=${encodeURIComponent(contactId)}`);
    // Людину могли перемкнути, поки відповідь ішла.
    if (contactHistoryFor !== contactId) return;
    contactHistory = payload.entries || [];
    contactOutreach = payload.outreach || null;
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

document.getElementById("contactFolderSelect").addEventListener("change", async (event) => {
  const folderId = event.target.value;
  if (!folderId || folderId === contactFolderId) return;
  await selectContactFolder(folderId);
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
