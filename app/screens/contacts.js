// Контакти — the CRM and one helper: pick a folder, find a person in it, open
// their card. The card is what the CRM says about them, what the warm-up has done
// with them on LinkedIn (where their request stands, and the conversation), and
// a small form that has the model write them three drafts: LinkedIn, email and
// Telegram.

import {
  HISTORY_EVENT_LABEL, INVITE_NOTE_DROPPED, api, escapeAttr, escapeHtml, linkIfUrl, onScreen, refreshIcons, relativeTime, setHtml, setText, state, uaPlural
} from "../core.js";
import { cachedRead, onCacheReset, onReadsInvalidated, recallScreen, rememberScreen } from "../cache.js";
import {
  WARMUP_OUTREACH_LABEL, WARMUP_OUTREACH_TONE, warmupApi
} from "../screens/warmup-accounts.js";

// CRM опитується, коли на неї дивляться, але не частіше за раз на хвилину: кнопки
// «Оновити» тут нема, тож нова папка чи нова людина з'являється, коли повертаєшся
// на екран, а не коли пам'ятаєш, що її треба шукати.
onScreen("contacts", { open: () => void openContactsScreen() });

const CONTACTS_STALE_MS = 60_000;

async function openContactsScreen() {
  // After a reload the last folder and page are drawn at once from this tab's
  // memory (`app/cache.js`); being as old as they are, they are also stale, so
  // the CRM is read again right behind them.
  if (recallContacts()) renderContacts();
  const stale = Date.now() - contactsLoadedAt > CONTACTS_STALE_MS;
  const selectedAtOpen = selectedContactId;
  try {
    await loadContactFolders({ force: stale });
    if (selectedAtOpen && selectedContactId === selectedAtOpen && !contactDraftsBusy) await openContact(selectedAtOpen, { keepDraftForm: true });
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
/** Хронологія пошти (ESP) цієї людини: спроби з точним текстом, відповіді, відписки. Ключ — адреса. */
let contactMail = null;
let contactMailFor = "";
let contactMailNotice = "";

// Повідомлення, які модель написала цій людині: лист, Telegram і два тексти для
// LinkedIn. Сервер зберігає їх на людину, тож вони чекають на картці, поки їх
// не напишуть наново.
let contactDrafts = null;

let contactDraftsBusy = false;

let contactDraftsError = "";

// Що вибрано у формі чернеток для відкритої людини. Картка перемальовується, коли
// приходить листування чи статус запиту, тож значення полів тримаються тут, а не
// в елементах: інакше напівнаписане «що врахувати» зникало б посеред речення.
// Порожнє поле означає «ще не вибирали» — тоді діє значення за замовчуванням.
let contactDraftForm = { productId: "", language: "", instruction: "" };

// Коли CRM читали востаннє; нуль — ще ні.
let contactsLoadedAt = 0;

let contactsRecalled = false;

/** Папки й сторінка списку, як їх востаннє показали, — щоб після перезавантаження екран не стояв порожній. */
function rememberContacts() {
  if (contactsError || !contactFoldersLoaded) return;
  rememberScreen("contacts", {
    folders: contactFolders, folderId: contactFolderId, rows: crmContactRows,
    total: contactTotal, offset: contactOffset, search: contactSearch, foldersAt: contactsLoadedAt
  });
}

function recallContacts() {
  if (contactsRecalled) return false;
  contactsRecalled = true;
  if (contactFoldersLoaded) return false;
  const saved = recallScreen("contacts")?.value;
  if (!Array.isArray(saved?.folders) || !saved.folders.length) return false;
  contactFolders = saved.folders;
  contactFoldersLoaded = true;
  contactFolderId = saved.folderId || null;
  crmContactRows = Array.isArray(saved.rows) ? saved.rows : [];
  contactTotal = Number(saved.total) || 0;
  contactOffset = Number(saved.offset) || 0;
  contactSearch = String(saved.search || "");
  contactsLoadedAt = Number(saved.foldersAt) || 0;
  // Пошук, з яким цю сторінку читали, стоїть і в полі — інакше список і поле
  // говорили б різне.
  const input = document.getElementById("contactSearchInput");
  if (input) input.value = contactSearch;
  return true;
}

let contactsLoading = false;

let contactsError = "";

// A request belongs to a selection and an authenticated session, not merely
// to a contact ID: A → B → A must not accept the first A's late answer.
const contactReads = {
  session: 0, folders: null, pageController: null, pageKey: "", pagePromise: null,
  pageGeneration: 0, cardController: null, cardGeneration: 0, historyGeneration: 0,
  mailGeneration: 0
};

onCacheReset(resetContacts);
onReadsInvalidated((prefix) => {
  if (!prefix || prefix.startsWith("contacts:")) contactsLoadedAt = 0;
});

function resetContacts() {
  contactReads.session += 1;
  contactReads.pageGeneration += 1;
  contactReads.cardGeneration += 1;
  contactReads.historyGeneration += 1;
  contactReads.mailGeneration += 1;
  contactReads.pageController?.abort();
  contactReads.cardController?.abort();
  contactReads.folders = null;
  contactReads.pagePromise = null;
  contactReads.pageKey = "";
  window.clearTimeout(contactSearchTimer);
  contactFolders = [];
  contactFoldersLoaded = false;
  contactFolderId = null;
  crmContactRows = [];
  contactTotal = 0;
  contactOffset = 0;
  contactSearch = "";
  selectedContactId = null;
  contactRecord = null;
  contactHistory = null;
  contactHistoryFor = "";
  contactHistoryNotice = "";
  contactOutreach = null;
  contactMail = null;
  contactMailFor = "";
  contactMailNotice = "";
  contactDrafts = null;
  contactDraftsBusy = false;
  contactDraftsError = "";
  contactDraftForm = { productId: "", language: "", instruction: "" };
  contactsLoadedAt = 0;
  contactsRecalled = false;
  contactsLoading = false;
  contactsError = "";
  const input = document.getElementById("contactSearchInput");
  if (input) input.value = "";
}

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

  renderKeepingFocus(() => setHtml("contactCardBody", `
    <dl class="contact-fields">${rows || `<div><dt>Порожньо</dt><dd>CRM не знає про цю людину нічого, крім імені</dd></div>`}</dl>
    ${contact.description ? `<div class="contact-note"><strong>Нотатка з CRM</strong><p>${escapeHtml(contact.description)}</p></div>` : ""}
    ${custom}
    ${contactMessagesHtml()}
    ${contactHistoryFor && contactHistoryFor === String(contact.id) ? contactConversationHtml() : ""}
    ${contact.email ? contactMailHtml(contact.email) : ""}
  `));
}

const MAIL_EVENT_LABEL = {
  "message.sending": "Відправка",
  "message.sent": "Надіслано",
  "message.failed": "Не пішло",
  "message.replied": "Відповідь",
  "message.bounced": "Повернувся (bounce)",
  "contact.unsubscribed": "Відписка",
  "contact.skipped": "Не надіслано — перевірка",
  "contact.note": "Нотатка"
};

/**
 * Пошта цієї людини, від найстарішого: кожна спроба з точним текстом, що пішов
 * (тема, текст, від кого), і все, що було потім. Журнал ESP — окремо від CRM;
 * якщо він не відповів, картка лишається, а тут одне речення.
 */
function contactMailHtml(email) {
  const key = String(email).trim().toLowerCase();
  if (contactMailFor !== key) {
    void loadContactMail(key);
    return '<section class="contact-history"><strong>Пошта</strong><p>Читаємо журнал пошти...</p></section>';
  }
  const body = contactMailNotice
    ? `<p>Журнал пошти не прочитався: ${escapeHtml(contactMailNotice)}</p>`
    : !contactMail
      ? "<p>Читаємо журнал пошти...</p>"
      : !contactMail.length
        ? "<p>Холодних листів цій людині ще не було.</p>"
        : `<ol class="mail-feed">${contactMail.map((event) => {
          const data = event.data || {};
          const when = new Date(event.at).toLocaleString();
          const label = MAIL_EVENT_LABEL[event.type] || event.type;
          const bad = ["message.failed", "message.bounced", "contact.unsubscribed"].includes(event.type);
          const detail = event.type === "message.sending"
            ? `<span>${escapeHtml(data.from || "")} → ${escapeHtml(data.to || "")}${data.campaignId ? ` · кампанія ${escapeHtml(data.campaignId)}${data.step ? `, крок ${escapeHtml(data.step)}` : ""}` : ""}</span>
               ${data.subject ? `<strong>Тема: ${escapeHtml(data.subject)}</strong>` : ""}
               <pre>${escapeHtml(data.text || "")}</pre>`
            : event.type === "message.sent"
              ? `<span>id ${escapeHtml(data.messageId || "")} · відбиток ${escapeHtml(String(data.hash || "").slice(0, 12))}</span>`
              : (data.error || data.reason || data.snippet || data.text || data.via)
                ? `<span>${escapeHtml(data.error || data.reason || data.snippet || data.text || data.via)}</span>`
                : "";
          return `<li class="mail-event${bad ? " is-bad" : ""}">
            <div class="mail-event-head"><strong>${escapeHtml(label)}</strong><span title="${escapeAttr(event.actor || "")}">${escapeHtml(when)}</span></div>
            ${detail}
          </li>`;
        }).join("")}</ol>`;
  return `<section class="contact-history"><strong>Пошта</strong>${body}</section>`;
}

async function loadContactMail(key) {
  const generation = ++contactReads.mailGeneration;
  contactMailFor = key;
  contactMail = null;
  contactMailNotice = "";
  try {
    const payload = await api(`/api/esp/contacts/timeline?email=${encodeURIComponent(key)}`);
    if (contactMailFor !== key || generation !== contactReads.mailGeneration) return;
    contactMail = Array.isArray(payload.events) ? payload.events : [];
  } catch (error) {
    if (contactMailFor !== key || generation !== contactReads.mailGeneration) return;
    contactMailNotice = error?.message || "Журнал пошти не відповів.";
  }
  renderContactCard();
  refreshIcons();
}

/**
 * Картка перемальовується цілком, а людина може саме писати в «що врахувати»: без
 * цього курсор зникав би щоразу, коли дочитується листування. Фокус і місце
 * курсору повертаються на поле з тим самим id.
 */
function renderKeepingFocus(render) {
  const body = document.getElementById("contactCardBody");
  const active = document.activeElement;
  const id = active && body?.contains?.(active) ? active.id : "";
  const caret = id && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  render();
  if (!id) return;
  const next = document.getElementById(id);
  if (!next || typeof next.focus !== "function") return;
  next.focus();
  if (caret && typeof next.setSelectionRange === "function") next.setSelectionRange(caret[0], caret[1]);
}

/**
 * Мова за замовчуванням: українською, коли людина з України, і англійською в
 * решті випадків. Це лише початкове значення в списку мов — його можна змінити, а
 * коли людині вже писали, форма бере те, що було вибрано тоді.
 */
function contactDraftLanguage(contact) {
  return /^(ua|ukr|україн|украин)/i.test(String(contact?.country || "").trim()) ? "uk" : "en";
}

const CONTACT_DRAFT_LANGUAGES = [["en", "English"], ["uk", "Українською"], ["ru", "Русский"]];

const CONTACT_DRAFT_LANGUAGE_LABEL = { uk: "українською", en: "English", ru: "російською" };

// Продукт, який людина вибрала востаннє в цьому браузері. Продукт, обраний у
// просторі, ставила шапка, якої вже нема, тож він застиг на одному значенні, а лід
// кампанії може бути для іншого продукту: без пам'яті кожна нова картка починалась
// би з нього. Сховище може бути закрите (приватне вікно) — тоді просто без пам'яті.
const CONTACT_PRODUCT_KEY = "outbound.contact.product";

function rememberedContactProduct() {
  try { return window.localStorage.getItem(CONTACT_PRODUCT_KEY) || ""; } catch { return ""; }
}

function rememberContactProduct(productId) {
  try { window.localStorage.setItem(CONTACT_PRODUCT_KEY, productId); } catch { /* без пам'яті */ }
}

/**
 * Продукт, мова й «що врахувати», з якими піде запит: вибране у формі, а де не
 * вибрано — продукт, який людина вибирала востаннє тут, потім обраний у просторі,
 * і мова за країною людини.
 */
function contactDraftChoice(contact) {
  const products = state?.products || [];
  const has = (id) => products.some((product) => product.id === id);
  const productId = has(contactDraftForm.productId)
    ? contactDraftForm.productId
    : has(rememberedContactProduct())
      ? rememberedContactProduct()
      : has(state?.selectedProductId) ? state.selectedProductId : (products[0]?.id || "");
  const language = CONTACT_DRAFT_LANGUAGES.some(([code]) => code === contactDraftForm.language)
    ? contactDraftForm.language
    : contactDraftLanguage(contact);
  return { productId, language, instruction: contactDraftForm.instruction };
}

function wordCountLabel(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean).length;
  return `${words} ${uaPlural(words, "слово", "слова", "слів")}`;
}

function contactDraftHtml({ title, hint, text, copyText, count, label }) {
  return `
    <article class="contact-draft">
      <header>
        <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(hint)}</span></div>
        <button type="button" data-copy-text="${escapeAttr(copyText ?? text)}" data-copy-label="${escapeAttr(label)}"><i data-lucide="copy"></i><span>Копіювати</span></button>
      </header>
      <pre>${escapeHtml(text)}</pre>
      <small>${escapeHtml(count)}</small>
    </article>`;
}

/**
 * Повідомлення людині: форма з продуктом, мовою й «що врахувати», кнопка «Згенерувати
 * три чернетки» і те, що з неї вийшло. Зміст тримається на картці й описі продукту —
 * про це сервер, а тут лише показ. Текст ніколи не йде сам: він копіюється, а
 * надсилає його людина.
 */
function contactMessagesHtml() {
  const drafts = contactDrafts;
  const choice = contactDraftChoice(contactRecord);
  const products = state?.products || [];
  const productOptions = products.length
    ? products.map((product) => `<option value="${escapeAttr(product.id)}"${product.id === choice.productId ? " selected" : ""}>${escapeHtml(product.name)}</option>`).join("")
    : `<option value="">Продукт за замовчуванням</option>`;
  const languageOptions = CONTACT_DRAFT_LANGUAGES
    .map(([code, label]) => `<option value="${code}"${code === choice.language ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  const pill = drafts ? (drafts.provider === "local" ? "чернетка з брифу" : "AI") : "немає";
  const form = `
    <form class="contact-draft-form" id="contactDraftForm" data-contact-draft-form>
      <div class="split-fields">
        <label>
          <span>Продукт</span>
          <select id="contactProductSelect" data-draft-field="productId"${products.length ? "" : " disabled"}>${productOptions}</select>
        </label>
        <label>
          <span>Мова</span>
          <select id="contactLanguageSelect" data-draft-field="language">${languageOptions}</select>
        </label>
      </div>
      <label>
        <span>Що врахувати (необов'язково)</span>
        <input id="contactInstructionInput" type="text" data-draft-field="instruction" value="${escapeAttr(choice.instruction)}" placeholder="Наприклад: коротше, без згадки ціни, зайти через їхній новий застосунок" />
      </label>
      <div class="button-row">
        <button class="primary-button" type="submit" id="contactGenerateBtn"${contactDraftsBusy ? " disabled" : ""}><i data-lucide="sparkles"></i><span>${contactDraftsBusy ? "Пишемо..." : "Згенерувати три чернетки"}</span></button>
      </div>
    </form>`;
  const problem = contactDraftsError ? `<p class="contact-messages-problem">${escapeHtml(contactDraftsError)}</p>` : "";
  const head = `<div class="contact-messages-head"><strong>Повідомлення</strong><span class="pill tone-muted" id="contactDraftsPill">${pill}</span></div>`;

  if (!drafts) {
    return `<section class="contact-messages">
      ${head}
      ${form}
      ${problem}
      <p class="contact-messages-hint">Модель прочитає цю картку й опис продукту та напише чернетки: лист, повідомлення в Telegram і два тексти для LinkedIn — запрошення й перше повідомлення. Нічого не надсилається саме.</p>
    </section>`;
  }

  const emailText = [drafts.email?.subject ? `Тема: ${drafts.email.subject}` : "", drafts.email?.body || ""].filter(Boolean).join("\n\n");
  // Назва береться зі списку продуктів за id, щоб і чернетки, написані раніше,
  // казали, для чого вони; а продукт, якого вже нема в списку, лишає свою назву.
  const productName = products.find((product) => product.id === drafts.productId)?.name || drafts.productName || "";
  const made = [
    productName,
    CONTACT_DRAFT_LANGUAGE_LABEL[drafts.language] || drafts.language || "",
    drafts.provider === "local" ? "складено без моделі, за описом продукту" : (drafts.modelUsed || ""),
    drafts.generatedAt ? relativeTime(drafts.generatedAt) : ""
  ].filter(Boolean).join(" · ");
  const grounding = (drafts.grounding || []).length
    ? `<div><strong>На чому тримається</strong><ul>${drafts.grounding.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
    : "";
  const verify = (drafts.verifyBeforeSending || []).length
    ? `<div class="contact-draft-warning"><strong>Перевір перед відправкою</strong><ul>${drafts.verifyBeforeSending.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
    : "";

  return `<section class="contact-messages">
    ${head}
    ${form}
    ${problem}
    <div class="contact-draft-list">
      ${contactDraftHtml({ title: "Пошта", hint: drafts.email?.subject || "без теми", text: drafts.email?.body || "", copyText: emailText, count: wordCountLabel(drafts.email?.body), label: "Лист" })}
      ${contactDraftHtml({ title: "Telegram", hint: contactRecord?.telegram || "юзернейм невідомий", text: drafts.telegram?.body || "", count: wordCountLabel(drafts.telegram?.body), label: "Telegram" })}
      ${contactDraftHtml({ title: "LinkedIn · запрошення", hint: "до 300 символів, без пропозиції", text: drafts.linkedin?.invite || "", count: `${String(drafts.linkedin?.invite || "").length} символів`, label: "Запрошення в LinkedIn" })}
      ${contactDraftHtml({ title: "LinkedIn · перше повідомлення", hint: "після прийняття запрошення", text: drafts.linkedin?.body || "", count: wordCountLabel(drafts.linkedin?.body), label: "Повідомлення в LinkedIn" })}
    </div>
    <div class="contact-draft-meta"><span>${escapeHtml(made)}</span>${grounding}${verify}</div>
  </section>`;
}

async function generateContactMessages() {
  const contactId = selectedContactId;
  const generation = contactReads.cardGeneration;
  if (!contactId || !contactRecord || contactDraftsBusy) return;
  contactDraftsBusy = true;
  contactDraftsError = "";
  renderContactCard();
  try {
    const payload = await api(`/api/contacts/${encodeURIComponent(contactId)}/messages`, {
      method: "POST",
      body: JSON.stringify(contactDraftChoice(contactRecord))
    });
    // Людину могли перемкнути, поки модель писала: чужі тексти на чужій картці
    // гірші за відсутні.
    if (selectedContactId !== contactId || generation !== contactReads.cardGeneration) return;
    contactDrafts = payload.drafts || null;
  } catch (error) {
    if (selectedContactId === contactId && generation === contactReads.cardGeneration) contactDraftsError = error.message || "Не вдалося написати повідомлення.";
  } finally {
    if (generation === contactReads.cardGeneration) contactDraftsBusy = false;
    if (selectedContactId === contactId && generation === contactReads.cardGeneration) {
      renderContactCard();
      refreshIcons();
    }
  }
}

/**
 * Папки CRM, прочитані раз на хвилину, а не при кожному поверненні на екран:
 * це та сама відповідь, і заново питати її щоразу означало б лише блимання списку.
 */
async function fetchContactFolders({ force = false } = {}) {
  if (contactFoldersLoaded && !force) return contactFolders;
  const session = contactReads.session;
  const payload = await cachedRead("contacts:folders", ({ signal }) => api("/api/contacts/folders", { signal }), { ttlMs: CONTACTS_STALE_MS });
  if (session !== contactReads.session) return [];
  contactFolders = payload.folders || [];
  contactFoldersLoaded = true;
  contactsLoadedAt = Date.now();
  if (contactFolderId && !contactFolders.some((folder) => folder.id === contactFolderId)) {
    contactFolderId = null;
    contactOffset = 0;
  }
  contactsError = contactFolders.length ? "" : payload.warning || "";
  return contactFolders;
}

export async function loadContactFolders({ force = false } = {}) {
  if (contactReads.folders) return contactReads.folders;
  if (contactFoldersLoaded && !force) {
    if (!contactFolderId && contactFolders.length) await selectContactFolder(contactFolders[0].id);
    else renderContacts();
    return;
  }
  const session = contactReads.session;
  const loading = (async () => {
    contactsLoading = true;
    contactsError = "";
    renderContacts();
    try {
      await fetchContactFolders({ force });
      if (session !== contactReads.session) return;
      if (!contactFolderId && contactFolders.length) await selectContactFolder(contactFolders[0].id);
      else if (contactFolderId) await loadContactPage();
    } catch (error) {
      if (session === contactReads.session && error.name !== "AbortError") contactsError = error.message || "CRM не відповіла.";
    } finally {
      if (session === contactReads.session) {
        contactsLoading = false;
        renderContacts();
        refreshIcons();
      }
    }
  })();
  contactReads.folders = loading;
  try { await loading; } finally { if (contactReads.folders === loading) contactReads.folders = null; }
}

function loadContactPage() {
  if (!contactFolderId) return Promise.resolve();
  const params = new URLSearchParams({
    folderId: contactFolderId,
    limit: String(CONTACT_PAGE_SIZE),
    offset: String(contactOffset)
  });
  if (contactSearch) params.set("search", contactSearch);
  const path = `/api/contacts?${params}`;
  if (contactReads.pageKey === path && contactReads.pagePromise) return contactReads.pagePromise;
  contactReads.pageController?.abort();
  const controller = new AbortController();
  contactReads.pageController = controller;
  const generation = ++contactReads.pageGeneration;
  contactReads.pageKey = path;
  contactsLoading = true;
  renderContacts();
  const loading = (async () => {
    try {
      const page = await cachedRead(`contacts:page:${path}`, ({ signal }) => api(path, { signal }), { ttlMs: CONTACTS_STALE_MS, signal: controller.signal });
      if (generation !== contactReads.pageGeneration) return;
      crmContactRows = page.contacts || [];
      contactTotal = page.total || 0;
      contactsError = "";
      rememberContacts();
    } catch (error) {
      if (generation !== contactReads.pageGeneration || error.name === "AbortError") return;
      crmContactRows = [];
      contactTotal = 0;
      contactsError = error.message || "CRM не відповіла.";
    } finally {
      if (generation === contactReads.pageGeneration) {
        contactsLoading = false;
        contactReads.pagePromise = null;
        renderContacts();
        refreshIcons();
      }
    }
  })();
  contactReads.pagePromise = loading;
  return loading;
}

async function selectContactFolder(folderId) {
  // Folder changes cancel the previous query immediately, including its debounce.
  window.clearTimeout(contactSearchTimer);
  contactFolderId = folderId;
  contactOffset = 0;
  const input = document.getElementById("contactSearchInput");
  if (input) contactSearch = input.value.trim();
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

async function openContact(contactId, { keepDraftForm = false } = {}) {
  contactReads.cardController?.abort();
  const controller = new AbortController();
  contactReads.cardController = controller;
  const generation = ++contactReads.cardGeneration;
  selectedContactId = contactId;
  if (!keepDraftForm) {
    contactRecord = null;
    contactDrafts = null;
    contactDraftsBusy = false;
    contactDraftsError = "";
    contactDraftForm = { productId: "", language: "", instruction: "" };
  }
  void loadContactHistory(contactId);
  if (keepDraftForm && contactRecord?.email) void loadContactMail(String(contactRecord.email).trim().toLowerCase());
  renderContacts();
  try {
    const payload = await cachedRead(`contacts:card:${contactId}`, ({ signal }) => api(`/api/contacts/${encodeURIComponent(contactId)}`, { signal }), { ttlMs: 30_000, signal: controller.signal });
    // Людину могли перемкнути, поки відповідь ішла: чужа картка з чужими текстами
    // гірша за порожню.
    if (selectedContactId !== contactId || generation !== contactReads.cardGeneration) return;
    contactRecord = payload.contact;
    contactDrafts = payload.drafts || null;
    // Продукт, мова й побажання беруться з того, що вже писали цій людині, щоб
    // повтор не починався з чужих налаштувань.
    if (contactDrafts && !keepDraftForm) {
      contactDraftForm = {
        productId: contactDrafts.productId || "",
        language: contactDrafts.language || "",
        instruction: contactDrafts.instruction || ""
      };
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    if (selectedContactId !== contactId || generation !== contactReads.cardGeneration) return;
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
  const generation = ++contactReads.historyGeneration;
  contactHistoryFor = contactId;
  contactHistory = null;
  contactOutreach = null;
  contactHistoryNotice = "";
  try {
    const payload = await warmupApi(`/history?crmContactId=${encodeURIComponent(contactId)}`);
    // Людину могли перемкнути, поки відповідь ішла.
    if (contactHistoryFor !== contactId || generation !== contactReads.historyGeneration) return;
    contactHistory = payload.entries || [];
    contactOutreach = payload.outreach || null;
  } catch (error) {
    if (contactHistoryFor !== contactId || generation !== contactReads.historyGeneration) return;
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
  contactReads.pageGeneration += 1;
  contactReads.pageController?.abort();
  contactReads.pagePromise = null;
  contactSearchTimer = window.setTimeout(async () => {
    contactSearch = value;
    contactOffset = 0;
    await loadContactPage();
  }, 350);
});

// Форма чернеток і «Копіювати» живуть на самій картці, яка перемальовується, тож
// слухачі стоять на її контейнері, а не на елементах.
document.getElementById("contactCardBody").addEventListener("submit", async (event) => {
  if (!event.target.closest("[data-contact-draft-form]")) return;
  event.preventDefault();
  await generateContactMessages();
});

function rememberContactDraftField(event) {
  const field = event.target.closest?.("[data-draft-field]");
  if (!field) return;
  contactDraftForm = { ...contactDraftForm, [field.dataset.draftField]: field.value };
  if (field.dataset.draftField === "productId" && field.value) rememberContactProduct(field.value);
}

document.getElementById("contactCardBody").addEventListener("input", rememberContactDraftField);

document.getElementById("contactCardBody").addEventListener("change", rememberContactDraftField);

document.getElementById("contactCardBody").addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy-text]");
  if (!copy) return;
  const label = copy.querySelector("span");
  try {
    await navigator.clipboard.writeText(copy.dataset.copyText);
    if (label) {
      label.textContent = "Скопійовано";
      window.setTimeout(() => { label.textContent = "Копіювати"; }, 1500);
    }
  } catch {
    if (label) label.textContent = "Не вдалося скопіювати";
  }
});
