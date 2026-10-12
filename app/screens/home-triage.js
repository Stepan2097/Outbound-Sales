// Головна (власник 12.10): папка CRM — і людина за людиною, кому ще ніхто не
// писав. Спершу ті, хто вже в друзях наших LinkedIn-акаунтів. Про кожного:
// усе з CRM, «Збагатити», у друзях якого акаунта, готовий текст для LinkedIn і
// для листа — і кнопка надіслати через той акаунт або з тієї скриньки. Або
// «Не валідний», або «Пропустити».
//
// Надсилає не ця сторінка: повідомлення в LinkedIn стає в чергу акаунта й іде в
// його наступній сесії (/api/warmup/first-messages/send), лист проходить шлюз
// ESP з усіма перевірками (/api/esp/send-one). Сервер: /api/triage/*.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, state } from "../core.js";

onScreen("home", { open: () => void openTriage() });

const FOLDER_KEY = "outbound.triage.folder";
const LANGUAGES = [["en", "English"], ["uk", "Українською"], ["ru", "Русский"]];
const PENDING_LABEL = { pending: "запит надіслано, ще не прийняв", waiting: "у черзі на запит", queued: "закріплено за акаунтом", declined: "не прийняв", withdrawn: "запит зник" };

const triage = {
  folders: null, foldersError: "", folderId: "",
  item: null, loading: false, error: "", notice: "", tone: "",
  cursor: 0, skip: [],
  texts: { linkedin: "", subject: "", body: "" },
  enrich: null, enriching: false, drafting: false, sending: "",
  productId: "", language: "en",
  inviteAccounts: null, mailboxes: null, liveSend: false, mailbox: "", inviteAccount: ""
};

const rootEl = () => document.getElementById("triageRoot");
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "");

function readSavedFolder() {
  try { return window.localStorage.getItem(FOLDER_KEY) || ""; } catch { return ""; }
}

async function openTriage() {
  if (!triage.folders) {
    try {
      const payload = await api("/api/contacts/folders");
      triage.folders = payload.folders || [];
      triage.foldersError = payload.warning || "";
    } catch (error) {
      triage.folders = [];
      triage.foldersError = error.message;
    }
    const saved = readSavedFolder();
    if (saved && triage.folders.some((folder) => folder.id === saved)) triage.folderId = saved;
  }
  // What sends: our mailboxes and whether real sending is on; accounts that can still send requests.
  void Promise.all([
    api("/api/esp/limits").then((payload) => { triage.mailboxes = (payload.senders || []).filter((sender) => sender.status === "active"); }).catch(() => { triage.mailboxes = []; }),
    api("/api/esp/halt").then((payload) => { triage.liveSend = Boolean(payload.liveSend) && !payload.halt?.on; }).catch(() => {}),
    api("/api/warmup/invites/accounts").then((payload) => { triage.inviteAccounts = payload.accounts || []; }).catch(() => { triage.inviteAccounts = []; })
  ]).then(() => {
    if (!triage.mailbox) triage.mailbox = triage.mailboxes?.[0]?.email || "";
    if (!triage.inviteAccount) triage.inviteAccount = triage.inviteAccounts?.find((account) => account.canSend)?.id || "";
    renderTriage();
  });
  if (triage.folderId && !triage.item) await loadNext();
  else renderTriage();
}

async function loadNext() {
  if (!triage.folderId) return renderTriage();
  triage.loading = true;
  triage.error = "";
  triage.enrich = null;
  renderTriage();
  try {
    const params = new URLSearchParams({ folderId: triage.folderId, cursor: String(triage.cursor), skip: triage.skip.slice(-300).join(",") });
    const item = await api(`/api/triage/next?${params}`);
    triage.item = item;
    triage.cursor = item.cursor || triage.cursor;
    fillTexts(item);
  } catch (error) {
    triage.item = null;
    triage.error = error.message || "Не вдалося прочитати папку.";
  }
  triage.loading = false;
  renderTriage();
}

/** The ready texts: a friend's saved first message, else the model's drafts for this contact, else empty. */
function fillTexts(item) {
  const friendDraft = item?.linkedin?.friends?.find((friend) => friend.draft)?.draft || "";
  const drafts = item?.drafts;
  triage.texts = {
    linkedin: friendDraft || drafts?.linkedin?.body || "",
    subject: drafts?.email?.subject || "",
    body: drafts?.email?.body || ""
  };
}

// ── малювання ─────────────────────────────────────────────────────────────

function foldersHtml() {
  const folders = triage.folders || [];
  return `<div class="triage-toolbar">
    <label class="triage-field"><span>Папка CRM</span>
      <select data-triage="folder">
        <option value="">${folders.length ? "Оберіть папку…" : "Папок немає"}</option>
        ${folders.map((folder) => `<option value="${escapeAttr(folder.id)}" ${folder.id === triage.folderId ? "selected" : ""}>${escapeHtml(folder.name || "без назви")}${Number.isFinite(folder.contactCount) ? ` · ${folder.contactCount}` : ""}</option>`).join("")}
      </select>
    </label>
    <label class="triage-field"><span>Продукт для текстів</span>
      <select data-triage="product">${(state?.products || []).map((product) => `<option value="${escapeAttr(product.id)}" ${product.id === (triage.productId || state?.selectedProductId) ? "selected" : ""}>${escapeHtml(product.name)}</option>`).join("") || '<option value="">Продукт за замовчуванням</option>'}</select>
    </label>
    <label class="triage-field is-narrow"><span>Мова</span>
      <select data-triage="language">${LANGUAGES.map(([code, label]) => `<option value="${code}" ${code === triage.language ? "selected" : ""}>${label}</option>`).join("")}</select>
    </label>
  </div>
  ${triage.foldersError ? `<p class="esp-notice is-bad">${escapeHtml(triage.foldersError)}</p>` : ""}`;
}

function progressHtml(item) {
  if (!item) return "";
  const where = item.phase === "friends"
    ? `<span class="pill tone-live"><i data-lucide="user-check"></i> друг нашого акаунта</span> друзів, яким ще не писали: <b>${item.friendsLeft}</b>`
    : `папка: людина №<b>${(item.cursor || 0) + 1}</b>${item.total ? ` з ${item.total}` : ""} · друзів, яким ще не писали, тут більше немає`;
  return `<p class="triage-progress">${where}</p>`;
}

function crmFieldsHtml(contact) {
  const rows = [
    ["Компанія", contact.company], ["Посада", contact.position], ["Країна", contact.country],
    ["Пошта", contact.email], ["Телефон", contact.phone], ["Telegram", contact.telegram],
    ["Статус ліда", contact.lead_status], ["Стадія", contact.lifecycle_stage], ["Категорія", contact.category],
    ["Додано в CRM", shortDate(contact.created_at)]
  ].filter(([, value]) => value);
  const link = (url, label) => (url ? `<a href="${escapeAttr(/^https?:/.test(url) ? url : `https://${url}`)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i>${label}</a>` : "");
  return `<dl class="triage-fields">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    <div class="triage-links">${link(contact.linkedin, "LinkedIn")}${link(contact.website, "Сайт")}${link(contact.facebook, "Facebook")}</div>
    ${contact.description ? `<div class="triage-note"><strong>Нотатка з CRM</strong><p>${escapeHtml(contact.description)}</p></div>` : ""}`;
}

function enrichHtml() {
  const enrich = triage.enrich;
  const button = `<button type="button" data-triage="enrich" ${triage.enriching ? "disabled" : ""}><i data-lucide="sparkles"></i><span>${triage.enriching ? "Шукаємо…" : "Збагатити"}</span></button>`;
  if (!enrich) return `<div class="triage-enrich">${button}<span class="triage-muted">Знайти пошту, телефон і профілі — публічний веб і скрапери, якщо підключені. У CRM нічого не пишеться.</span></div>`;
  if (enrich.error) return `<div class="triage-enrich">${button}<p class="esp-notice is-bad">${escapeHtml(enrich.error)}</p></div>`;
  const useful = enrich.candidates.filter((item) => ["email", "phone", "linkedin", "telegram", "whatsapp", "website"].includes(item.type));
  return `<div class="triage-enrich">${button}
    ${useful.length ? `<ul class="triage-found">${useful.map((item) => `<li><span class="pill tone-muted">${escapeHtml(item.type)}</span> <b>${escapeHtml(item.value)}</b>
      ${item.type === "email" ? `<button type="button" class="text-button" data-triage-use-email="${escapeAttr(item.value)}">Писати на цю адресу</button>` : ""}
      <span class="triage-muted">${escapeHtml(item.source || "")}${item.confidence != null ? ` · ${escapeHtml(String(item.confidence))}` : ""}</span></li>`).join("")}</ul>`
      : '<p class="triage-muted">Нових контактів не знайдено.</p>'}
    ${enrich.note ? `<p class="triage-muted">${escapeHtml(enrich.note)}</p>` : ""}
  </div>`;
}

function linkedinHtml(item) {
  const { friends = [], pending = [] } = item.linkedin || {};
  const writable = friends.filter((friend) => friend.canWrite);
  const status = friends.length
    ? friends.map((friend) => `<li><i data-lucide="user-check"></i> У друзях у <b>${escapeHtml(friend.accountName)}</b>${friend.acceptedAt ? ` · прийняв ${escapeHtml(shortDate(friend.acceptedAt))}` : ""}${friend.why ? ` <span class="triage-muted">— ${escapeHtml(friend.why)}</span>` : ""}${friend.reply ? ` <span class="pill tone-warn">перше повідомлення: ${friend.reply.state === "sent" ? "надіслано" : "чекає відправки"}</span>` : ""}</li>`).join("")
    : '<li><i data-lucide="user-x"></i> Не в друзях жодного нашого акаунта</li>';
  const pendingHtml = pending.map((row) => `<li><i data-lucide="clock"></i> ${escapeHtml(PENDING_LABEL[row.status] || row.status)} — <b>${escapeHtml(row.accountName)}</b>${row.at ? `, ${escapeHtml(shortDate(row.at))}` : ""}</li>`).join("");
  const accounts = (triage.inviteAccounts || []).filter((account) => account.canSend);
  const canInvite = !friends.length && !pending.length && item.contact.linkedin;
  return `<section class="triage-channel">
    <header><i data-lucide="message-square"></i><h3>LinkedIn</h3></header>
    <ul class="triage-status">${status}${pendingHtml}</ul>
    ${writable.length ? "" : '<p class="triage-muted">Чернетка першого повідомлення — надіслати її можна буде, коли людина стане другом одного з акаунтів.</p>'}
    <textarea data-triage-text="linkedin" rows="6" placeholder="Текст повідомлення в LinkedIn — «Згенерувати тексти» напише його.">${escapeHtml(triage.texts.linkedin)}</textarea>
    ${writable.length ? `<div class="triage-actions">
      ${writable.map((friend) => `<button type="button" class="primary-button" data-triage-send-linkedin="${escapeAttr(friend.outreachId)}" ${triage.sending ? "disabled" : ""}><i data-lucide="send"></i><span>Надіслати через ${escapeHtml(friend.accountName)}</span></button>`).join("")}
    </div>
    <p class="triage-muted">Повідомлення стане в чергу акаунта й піде в його наступній сесії, у вікні прогріву.</p>` : ""}
    ${!writable.length && friends.length ? '<p class="triage-muted">Через ці акаунти звідси не написати.</p>' : ""}
    ${canInvite ? inviteHtml(accounts) : ""}
    ${!friends.length && !pending.length && !item.contact.linkedin ? '<p class="triage-muted">У CRM немає посилання на LinkedIn — запит у друзі нікуди надіслати. «Збагатити» може знайти профіль.</p>' : ""}
  </section>`;
}

/** How much an account can still send today, in words: «ще 2 сьогодні», or that it goes tomorrow. */
function inviteRoom(account) {
  return account.connectsLeft > 0 ? `сьогодні ще ${account.connectsLeft}` : "ліміт на сьогодні вичерпано — піде завтра";
}

/**
 * Not a friend yet: a LinkedIn message can only go to a friend, so the step is
 * a request. A request on an account with nothing left today is still taken —
 * it waits in the account's queue and goes out tomorrow — and the line under
 * the button says which of the two it will be.
 */
function inviteHtml(accounts) {
  const chosen = accounts.find((account) => account.id === triage.inviteAccount) || accounts[0];
  if (!accounts.length) return '<p class="triage-muted">Написати в LinkedIn можна лише другові, а запит у друзі зараз не надішле жоден акаунт.</p>';
  return `<div class="triage-invite">
    <p class="triage-muted">Написати в LinkedIn можна лише другові — спершу запит у друзі. Коли людина прийме його, вона повернеться сюди першою.</p>
    <div class="triage-invite-row">
      <label class="triage-inline"><span>З акаунта</span>
        <select data-triage="invite-account">${accounts.map((account) => `<option value="${escapeAttr(account.id)}" ${account.id === chosen.id ? "selected" : ""}>${escapeHtml(account.label)} · ${escapeHtml(inviteRoom(account))}</option>`).join("")}</select>
      </label>
      <button type="button" data-triage="invite" ${triage.sending ? "disabled" : ""}><i data-lucide="user-plus"></i><span>${chosen.connectsLeft > 0 ? "Надіслати запит у друзі" : "Поставити запит на завтра"}</span></button>
    </div>
    <p class="triage-muted">${chosen.connectsLeft > 0 ? "Запит піде в найближчій сесії акаунта, у вікні прогріву." : `У ${escapeHtml(chosen.label)} денний ліміт запитів уже вичерпано — запит чекатиме в черзі й піде завтра.`}</p>
  </div>`;
}

function emailHtml(item) {
  const email = item.email || {};
  const address = email.address || "";
  const mailboxes = triage.mailboxes || [];
  const status = !address
    ? '<li><i data-lucide="mail-x"></i> Адреси в CRM немає — «Збагатити» може знайти</li>'
    : email.written
      ? `<li><i data-lucide="mail-check"></i> На <b>${escapeHtml(address)}</b> уже писали${email.writtenAt ? ` ${escapeHtml(shortDate(email.writtenAt))}` : ""}${email.writtenFrom ? ` з ${escapeHtml(email.writtenFrom)}` : ""}</li>`
      : `<li><i data-lucide="mail"></i> <b>${escapeHtml(address)}</b> · ще не писали</li>`;
  const locked = !triage.liveSend;
  return `<section class="triage-channel">
    <header><i data-lucide="mail"></i><h3>Пошта</h3></header>
    <ul class="triage-status">${status}</ul>
    <input data-triage-text="subject" placeholder="Тема" value="${escapeAttr(triage.texts.subject)}" />
    <textarea data-triage-text="body" rows="8" placeholder="Текст листа — «Згенерувати тексти» напише його. Лише простий текст; підпис і відписка додаються самі.">${escapeHtml(triage.texts.body)}</textarea>
    <div class="triage-actions">
      <select data-triage="mailbox" ${mailboxes.length ? "" : "disabled"}>${mailboxes.map((sender) => `<option value="${escapeAttr(sender.email)}" ${sender.email === triage.mailbox ? "selected" : ""}>${escapeHtml(sender.email)} · сьогодні ${sender.today}/${sender.limit}</option>`).join("") || '<option value="">Немає активної скриньки</option>'}</select>
      <button type="button" class="primary-button" data-triage="send-email" ${!address || !mailboxes.length || locked || email.written || triage.sending ? "disabled" : ""} title="${escapeAttr(locked ? "Справжню відправку ще не ввімкнено (ESP_LIVE_SEND, після приймання ESP 11)" : "")}"><i data-lucide="send"></i><span>Надіслати з ${escapeHtml(triage.mailbox || "скриньки")}</span></button>
    </div>
    ${locked ? '<p class="triage-muted"><i data-lucide="lock"></i> Справжню відправку листів ще не ввімкнено (ESP_LIVE_SEND, після приймання ESP 11) — кнопка запрацює разом із нею.</p>' : '<p class="triage-muted">Лист пройде ті самі перевірки, що й кампанія: виключення, верифікацію, ліміти скриньки й робочі години одержувача.</p>'}
  </section>`;
}

function cardHtml(item) {
  const contact = item.contact;
  return `<article class="triage-card">
    <div class="triage-person">
      <header class="triage-head">
        <div><h2>${escapeHtml(contact.name || "без імені")}</h2><p>${escapeHtml([contact.position, contact.company].filter(Boolean).join(" · "))}</p></div>
      </header>
      ${crmFieldsHtml(contact)}
      ${enrichHtml()}
      <div class="triage-decide">
        <button type="button" data-triage="draft" ${triage.drafting ? "disabled" : ""}><i data-lucide="wand-sparkles"></i><span>${triage.drafting ? "Пишемо…" : item.drafts ? "Переписати тексти" : "Згенерувати тексти"}</span></button>
        <div class="triage-decide-right">
          <button type="button" class="danger-button" data-triage="invalid"><i data-lucide="ban"></i><span>Не валідний</span></button>
          <button type="button" data-triage="skip"><span>Пропустити</span><i data-lucide="arrow-right"></i></button>
        </div>
      </div>
    </div>
    <div class="triage-channels">
      ${linkedinHtml(item)}
      ${emailHtml(item)}
    </div>
  </article>`;
}

export function renderTriage() {
  const root = rootEl();
  if (!root) return;
  const item = triage.item;
  let body;
  if (!triage.folderId) body = '<div class="triage-empty"><i data-lucide="folder-open"></i><strong>Оберіть папку CRM</strong><p>Далі — людина за людиною: спершу ті, хто вже в друзях наших LinkedIn-акаунтів, потім решта папки. Лише ті, кому ще ніхто не писав.</p></div>';
  else if (triage.loading && !item) body = '<div class="empty-state">Шукаємо наступну людину…</div>';
  else if (triage.error) body = `<p class="esp-notice is-bad">${escapeHtml(triage.error)}</p>`;
  else if (item?.done || !item?.contact) body = '<div class="triage-empty"><i data-lucide="party-popper"></i><strong>У цій папці всіх уже опрацьовано</strong><p>Кожному або вже писали, або його позначено невалідним. Пропущені сьогодні повернуться після перезавантаження.</p><button type="button" data-triage="restart">Почати папку спочатку</button></div>';
  else body = `${progressHtml(item)}${cardHtml(item)}`;
  root.innerHTML = `${foldersHtml()}${triage.notice ? `<p class="esp-notice ${triage.tone}" role="status">${escapeHtml(triage.notice)}</p>` : ""}${body}`;
  refreshIcons(root);
}

// ── дії ───────────────────────────────────────────────────────────────────

function readTexts() {
  const root = rootEl();
  for (const field of ["linkedin", "subject", "body"]) {
    const input = root?.querySelector(`[data-triage-text="${field}"]`);
    if (input) triage.texts[field] = input.value;
  }
}

function say(text, tone = "is-ok") {
  triage.notice = text;
  triage.tone = tone;
}

async function decideInvalid() {
  const contact = triage.item?.contact;
  if (!contact) return;
  try {
    await api("/api/triage/decide", { method: "POST", body: JSON.stringify({ contactId: contact.id, decision: "invalid" }) });
    say(`${contact.name || "Контакт"} — не валідний, більше не з'явиться.`);
  } catch (error) {
    return say(error.message, "is-bad"), renderTriage();
  }
  await loadNext();
}

async function skip() {
  const contact = triage.item?.contact;
  if (contact) triage.skip.push(String(contact.id));
  triage.notice = "";
  await loadNext();
}

async function draftTexts() {
  const contact = triage.item?.contact;
  if (!contact) return;
  readTexts();
  triage.drafting = true;
  renderTriage();
  try {
    const { drafts } = await api(`/api/contacts/${encodeURIComponent(contact.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ productId: triage.productId || state?.selectedProductId || "", language: triage.language })
    });
    triage.item.drafts = drafts;
    const friendDraft = triage.item.linkedin?.friends?.find((friend) => friend.draft)?.draft;
    triage.texts = { linkedin: drafts.linkedin?.body || friendDraft || "", subject: drafts.email?.subject || "", body: drafts.email?.body || "" };
    say(drafts.verifyBeforeSending?.length ? `Перевірте перед відправкою: ${drafts.verifyBeforeSending.join("; ")}` : "Тексти готові — перечитайте перед відправкою.", "");
  } catch (error) {
    say(error.message || "Модель не написала тексти.", "is-bad");
  }
  triage.drafting = false;
  renderTriage();
}

async function enrich() {
  const contact = triage.item?.contact;
  if (!contact) return;
  triage.enriching = true;
  renderTriage();
  try {
    triage.enrich = await api("/api/triage/enrich", { method: "POST", body: JSON.stringify({ contactId: contact.id }) });
  } catch (error) {
    triage.enrich = { error: error.message || "Не вдалося збагатити.", candidates: [] };
  }
  triage.enriching = false;
  renderTriage();
}

async function sendLinkedin(outreachId) {
  readTexts();
  const friend = triage.item.linkedin.friends.find((row) => row.outreachId === outreachId);
  if (!triage.texts.linkedin.trim()) return say("Порожнє повідомлення — напишіть або згенеруйте текст.", "is-bad"), renderTriage();
  triage.sending = "linkedin";
  renderTriage();
  try {
    const answer = await api("/api/warmup/first-messages/send", { method: "POST", body: JSON.stringify({ outreachId, text: triage.texts.linkedin }) });
    say(`Повідомлення стало в чергу ${friend?.accountName || "акаунта"}${answer.goesOutAt ? ` — піде ${new Date(answer.goesOutAt).toLocaleString("uk-UA", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}.`);
    triage.sending = "";
    await loadNext();
  } catch (error) {
    triage.sending = "";
    say(error.message || "Не вдалося поставити повідомлення в чергу.", "is-bad");
    renderTriage();
  }
}

async function sendEmail() {
  readTexts();
  const contact = triage.item.contact;
  triage.sending = "email";
  renderTriage();
  try {
    const lead = { email: triage.item.email.address, name: contact.name, company: contact.company, country: contact.country, position: contact.position, source: "CRM", sourceDate: contact.created_at };
    const answer = await api("/api/esp/send-one", { method: "POST", body: JSON.stringify({ lead, mailbox: triage.mailbox, subject: triage.texts.subject, body: triage.texts.body }) });
    triage.sending = "";
    if (!answer.ok) { say(answer.error || "Лист не пішов.", "is-bad"); return renderTriage(); }
    say(`Лист надіслано на ${answer.to} з ${answer.mailbox}.`);
    await loadNext();
  } catch (error) {
    triage.sending = "";
    say(error.message || "Лист не пішов.", "is-bad");
    renderTriage();
  }
}

async function invite() {
  const contact = triage.item?.contact;
  if (!contact || !triage.inviteAccount) return;
  triage.sending = "invite";
  renderTriage();
  try {
    await api("/api/warmup/invites", { method: "POST", body: JSON.stringify({ crmContactId: contact.id, accountId: triage.inviteAccount }) });
    const account = triage.inviteAccounts.find((row) => row.id === triage.inviteAccount);
    say(`Запит у друзі від ${account?.label || "акаунта"} стоїть у черзі — після прийняття людина повернеться сюди першою.`);
    triage.sending = "";
    triage.skip.push(String(contact.id));
    await loadNext();
  } catch (error) {
    triage.sending = "";
    say(error.message || "Запит не поставлено.", "is-bad");
    renderTriage();
  }
}

const root = document.getElementById("triageRoot");
root?.addEventListener("change", (event) => {
  const field = event.target.dataset?.triage;
  if (field === "folder") {
    triage.folderId = event.target.value;
    try { window.localStorage.setItem(FOLDER_KEY, triage.folderId); } catch {}
    Object.assign(triage, { cursor: 0, skip: [], item: null, notice: "" });
    void loadNext();
  } else if (field === "product") triage.productId = event.target.value;
  else if (field === "language") triage.language = event.target.value;
  else if (field === "mailbox") { readTexts(); triage.mailbox = event.target.value; renderTriage(); }
  else if (field === "invite-account") { readTexts(); triage.inviteAccount = event.target.value; renderTriage(); }
});
root?.addEventListener("input", (event) => {
  const field = event.target.dataset?.triageText;
  if (field) triage.texts[field] = event.target.value;
});
root?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.triageSendLinkedin) return void sendLinkedin(button.dataset.triageSendLinkedin);
  if (button.dataset.triageUseEmail) {
    readTexts();
    triage.item.email = { ...triage.item.email, address: button.dataset.triageUseEmail, written: false };
    return renderTriage();
  }
  switch (button.dataset.triage) {
    case "invalid": return void decideInvalid();
    case "skip": return void skip();
    case "draft": return void draftTexts();
    case "enrich": return void enrich();
    case "send-email": return void sendEmail();
    case "invite": return void invite();
    case "restart": Object.assign(triage, { cursor: 0, skip: [], notice: "" }); return void loadNext();
    default: return undefined;
  }
});
