// Головна (власник 12.10): папка CRM — і людина за людиною, кому ще ніхто не
// писав. Спершу ті, хто вже в друзях наших LinkedIn-акаунтів. Про кожного:
// усе з CRM, «Збагатити», у друзях якого акаунта, готовий текст для LinkedIn і
// для листа — і кнопка надіслати через той акаунт або з тієї пошти. Або
// «Не валідний», або «Пропустити».
//
// Надсилає не ця сторінка: повідомлення в LinkedIn стає в чергу акаунта й іде в
// його наступній сесії (/api/warmup/first-messages/send), лист проходить шлюз
// ESP з усіма перевірками (/api/esp/send-one). Сервер: /api/triage/*.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons, state } from "../core.js";

onScreen("home", { open: () => void openTriage() });

const FOLDER_KEY = "outbound.triage.folder";
const TACTIC_KEY = "outbound.triage.tactic";
const EVENT_KEY = "outbound.triage.event";
const PREP_POLL_MS = 2000;
// Тактики листа (triage/tactics.mjs): поки сервер не сказав, які можливі для людини, видно всі.
const TACTIC_LIST = [
  ["auto", "Сама вибере"], ["conference", "Конференція"], ["news", "Свіжа новина компанії"], ["role", "Їхня роль"],
  ["product", "Їхній продукт чи застосунок"], ["market", "Ринок / GEO"], ["proof", "Кейс із цифрою"],
  ["linkedin", "Ми вже на зв'язку"], ["question", "Одне питання"], ["insight", "Спостереження"], ["partnership", "Партнерство"]
];
const STEP_MARK = { done: "✓", skipped: "—", failed: "!", running: "…", pending: "·" };
const LANGUAGES = [["en", "English"], ["uk", "Українською"], ["ru", "Русский"]];
const PENDING_LABEL = { pending: "запит надіслано, ще не прийняв", waiting: "у черзі на запит", queued: "закріплено за акаунтом", declined: "не прийняв", withdrawn: "запит зник" };

const triage = {
  folders: null, foldersError: "", folderId: "",
  item: null, loading: false, error: "", notice: "", tone: "", companyLoading: "", companyError: "",
  cursor: 0, skip: [],
  texts: { linkedin: "", subject: "", body: "" },
  enrich: null, enriching: false, drafting: false, sending: "",
  // The addresses ticked for the letter, and which contacts already had texts written automatically.
  selected: new Set(), autoDrafted: new Set(),
  productId: "", language: "en",
  inviteAccounts: null, mailboxes: null, liveSend: false, mailbox: "", inviteAccount: "",
  // Підготовка наперед (15.10): що сервер уже зібрав про людину і чи написав лист.
  prep: null, prepTimer: null, tactic: readSaved(TACTIC_KEY) || "auto", event: readSaved(EVENT_KEY),
  // Поля, які людина вже правила руками: лист від моделі їх не перезапише.
  dirty: new Set(),
  // «Щойно написали сьогодні»: кому цей логін написав чи надіслав запит сьогодні.
  recent: null
};

function readSaved(key) {
  try { return window.localStorage.getItem(key) || ""; } catch { return ""; }
}
function save(key, value) {
  try { window.localStorage.setItem(key, value); } catch {}
}

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
    if (saved && (saved === "all" || triage.folders.some((folder) => folder.id === saved))) triage.folderId = saved;
  }
  // What sends: our mailboxes and whether real sending is on; accounts that can still send requests.
  void Promise.all([
    // Active mailboxes that may send cold mail — a warm-up-only one never does — by domain A→Z, then address A→Z.
    api("/api/esp/limits").then((payload) => {
      triage.mailboxes = (payload.senders || []).filter((sender) => sender.status === "active" && sender.role !== "warmup")
        .sort((left, right) => String(left.domain || left.email.split("@")[1]).localeCompare(String(right.domain || right.email.split("@")[1])) || left.email.localeCompare(right.email));
    }).catch(() => { triage.mailboxes = []; }),
    api("/api/esp/halt").then((payload) => { triage.liveSend = Boolean(payload.liveSend) && !payload.halt?.on; }).catch(() => {}),
    api("/api/warmup/invites/accounts").then((payload) => { triage.inviteAccounts = payload.accounts || []; }).catch(() => { triage.inviteAccounts = []; })
  ]).then(() => {
    if (!triage.mailbox) triage.mailbox = triage.mailboxes?.[0]?.email || "";
    if (!triage.inviteAccount) triage.inviteAccount = triage.inviteAccounts?.find((account) => account.canSend)?.id || "";
    renderTriage();
  });
  void loadRecent();
  if (triage.folderId && !triage.item) await loadNext();
  else renderTriage();
}

/** Today's people from this login (/api/work/day): whom we wrote to, and how each one stands now. */
async function loadRecent() {
  try {
    const data = await api("/api/work/day?user=me");
    triage.recent = (data.contacts || []).slice(0, 15);
  } catch {
    triage.recent = triage.recent || [];
  }
  renderTriage();
}

const RECENT_WORD = { invited: "запит у друзі", replied: "відповідь у розмові" };
const recentTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" }) : "");

/**
 * Under the card: the people just written to, so they do not vanish when the
 * next card opens — what was done, how they stand (answered, accepted, waiting)
 * and «Шлях», their whole way in «По днях».
 */
function recentHtml() {
  const rows = triage.recent || [];
  if (!rows.length) return "";
  return `<section class="triage-recent">
    <header><h3><i data-lucide="history"></i>Щойно написали сьогодні <b>${rows.length}</b></h3><span class="triage-muted">Повна історія й шлях кожного — у «По днях»</span></header>
    <ul>${rows.map((row) => {
      const last = row.actions.at(-1) || {};
      const what = last.action === "wrote" ? (last.channel === "email" ? "лист" : "повідомлення в LinkedIn") : RECENT_WORD[last.action] || last.action;
      const status = row.answer ? '<span class="pill tone-live">відповів</span>'
        : row.bounced ? '<span class="pill tone-bad">лист не дійшов</span>'
          : row.accepted ? '<span class="pill tone-good">прийняв запит</span>'
            : '<span class="pill tone-muted">чекаємо</span>';
      return `<li>
        <span class="triage-recent-who"><b>${escapeHtml(row.name)}</b><small>${escapeHtml(what)}${last.accountName || last.mailbox ? ` · ${escapeHtml(last.accountName || last.mailbox)}` : ""} · ${escapeHtml(recentTime(last.at))}</small></span>
        ${status}
        <button type="button" class="text-button" data-triage-path="${escapeAttr(row.key)}"><i data-lucide="route"></i><span>Шлях</span></button>
      </li>`;
    }).join("")}</ul>
  </section>`;
}

async function loadNext() {
  if (!triage.folderId) return renderTriage();
  triage.loading = true;
  triage.error = "";
  triage.enrich = null;
  triage.companyError = "";
  renderTriage();
  try {
    const params = new URLSearchParams({
      folderId: triage.folderId, cursor: String(triage.cursor), skip: triage.skip.slice(-300).join(","),
      product: triage.productId || state?.selectedProductId || "", language: triage.language, tactic: triage.tactic, event: triage.event
    });
    const item = await api(`/api/triage/next?${params}`);
    triage.item = item;
    triage.cursor = item.cursor || triage.cursor;
    triage.dirty = new Set();
    triage.prep = item.prep || null;
    fillTexts(item);
    tickConfirmed(true);
  } catch (error) {
    triage.item = null;
    triage.error = error.message || "Не вдалося прочитати папку.";
  }
  triage.loading = false;
  renderTriage();
  if (triage.item?.contact) watchPrep(triage.item.contact.id);
}

/**
 * The preparation the server runs for this person (and the next two): read
 * every two seconds until it is done, and whatever arrived — checked
 * addresses, the company, what enrichment found, the letter — put on the card.
 */
function watchPrep(id) {
  clearTimeout(triage.prepTimer);
  const tick = async () => {
    if (triage.item?.contact?.id !== id) return;
    try {
      const { prep } = await api(`/api/triage/prepare?contactId=${encodeURIComponent(id)}`);
      if (triage.item?.contact?.id !== id) return;
      if (!prep) {
        // Nothing started yet (a server restarted in between): ask for it.
        const started = await api("/api/triage/prepare", { method: "POST", body: JSON.stringify(prepOptions(id)) });
        applyPrep(started.prep);
      } else applyPrep(prep);
    } catch { /* the card stays as it is; the buttons still work */ }
    if (triage.item?.contact?.id === id && triage.prep?.state !== "done") triage.prepTimer = setTimeout(tick, PREP_POLL_MS);
  };
  void tick();
}

function prepOptions(contactId, extra = {}) {
  return { contactId, productId: triage.productId || state?.selectedProductId || "", language: triage.language, tactic: triage.tactic, event: triage.event, ...extra };
}

function applyPrep(prep) {
  if (!prep || !triage.item) return;
  triage.prep = prep;
  if (prep.contact) triage.item.contact = { ...triage.item.contact, ...prep.contact };
  if (prep.emails) { mergeAddresses(prep.emails); tickConfirmed(); }
  if (prep.company) triage.item.company = prep.company;
  if (prep.enrich && !triage.enrich) triage.enrich = prep.enrich;
  if (prep.drafts && prep.state === "done") {
    triage.item.drafts = prep.drafts;
    readTexts();
    const friendDraft = triage.item.linkedin?.friends?.find((friend) => friend.draft)?.draft;
    const fresh = { linkedin: friendDraft || prep.drafts.linkedin?.body || "", subject: prep.drafts.email?.subject || "", body: prep.drafts.email?.body || "" };
    for (const field of Object.keys(fresh)) if (!triage.dirty.has(field)) triage.texts[field] = fresh[field];
  }
  renderTriage();
  // The tactic was changed while the preparation was still writing with the old one.
  if (prep.state === "done" && prep.tactic && prep.tactic !== triage.tactic && !triage.drafting && !(triage.tactic === "conference" && !triage.event)) void draftTexts();
}

/** The person's addresses, as the card holds them now. */
const addresses = () => triage.item?.email?.addresses || [];

/** Tick every confirmed address nobody wrote to — all of them, or only the newly confirmed ones. */
function tickConfirmed(reset = false) {
  if (reset) triage.selected = new Set();
  for (const row of addresses()) {
    if (row.check?.status === "valid" && !row.written && !triage.selected.has(row.address) && !row.seen) triage.selected.add(row.address);
    row.seen = true;
  }
}

/** «Про компанію»: researched once per company on the server, a short brief by the connected model. */
async function loadCompany(id, { force = false } = {}) {
  triage.companyLoading = id;
  triage.companyError = "";
  renderTriage();
  try {
    const answer = await api("/api/triage/company", { method: "POST", body: JSON.stringify({ contactId: id, force }) });
    if (triage.item?.contact?.id === id) triage.item.company = answer.company;
  } catch (error) {
    if (triage.item?.contact?.id === id) triage.companyError = error.message || "Не вдалося зібрати відомості про компанію.";
  }
  if (triage.companyLoading === id) triage.companyLoading = "";
  renderTriage();
}

function prepHtml() {
  const prep = triage.prep;
  if (!prep) return '<section class="triage-prep"><h3><i data-lucide="list-checks"></i>Підготовка</h3><p class="triage-muted">Сервер збирає дані про людину й компанію…</p></section>';
  const running = prep.state !== "done";
  return `<section class="triage-prep ${running ? "is-running" : ""}">
    <h3><i data-lucide="list-checks"></i>Підготовка${running ? " · збираємо" : " · готово"}</h3>
    <ol>${prep.steps.map((step) => `<li class="is-${step.state}"><span class="triage-prep-mark">${STEP_MARK[step.state] || "·"}</span><b>${escapeHtml(step.label)}</b>${step.note ? `<small>${escapeHtml(step.note)}</small>` : ""}</li>`).join("")}</ol>
    ${running ? '<p class="triage-muted">Лист пишеться останнім — коли зібрано все. Наступні двоє людей готуються вже зараз.</p>' : ""}
  </section>`;
}

/** The tactic picker: «Сама вибере» and ten angles; the ones this person has no data for are greyed out with the reason. */
function tacticHtml() {
  const known = new Map((triage.prep?.tactics || []).map((row) => [row.id, row]));
  const used = triage.item?.drafts?.tacticUsed;
  const options = TACTIC_LIST.map(([id, label]) => {
    const row = known.get(id);
    const off = row && !row.available && id !== "conference";
    return `<option value="${id}" ${id === triage.tactic ? "selected" : ""} ${off ? "disabled" : ""}>${escapeHtml(label)}${off ? ` — ${escapeHtml(row.why)}` : ""}</option>`;
  }).join("");
  const hint = known.get(triage.tactic)?.hint || "";
  return `<div class="triage-tactic">
    <label class="triage-field"><span>Тактика листа</span><select data-triage="tactic" ${triage.drafting ? "disabled" : ""}>${options}</select></label>
    ${triage.tactic === "conference" ? `<label class="triage-field"><span>Конференція</span><input data-triage="event" placeholder="напр. SiGMA World, Рим, 2–5 листопада" value="${escapeAttr(triage.event)}" /></label>` : ""}
    <p class="triage-muted">${hint ? `${escapeHtml(hint)}. ` : ""}${used && triage.tactic === "auto" ? `Модель вибрала: <b>${escapeHtml(TACTIC_LIST.find(([id]) => id === used)?.[1] || used)}</b>.` : ""}</p>
  </div>`;
}

function companyHtml(item) {
  if (!item.contact.company) return "";
  const company = item.company;
  const loading = triage.companyLoading === item.contact.id;
  if (!company) {
    if (loading) return '<section class="triage-company is-loading"><h3><i data-lucide="building-2"></i>Про компанію</h3><p class="triage-muted">Збираємо: сайт, новини, продукти…</p></section>';
    return `<section class="triage-company"><h3><i data-lucide="building-2"></i>Про компанію</h3>${triage.companyError ? `<p class="esp-notice is-bad">${escapeHtml(triage.companyError)}</p>` : ""}<button type="button" data-triage="company"><i data-lucide="search"></i><span>Дізнатися про компанію</span></button></section>`;
  }
  const link = (url, label) => (url ? `<a href="${escapeAttr(/^https?:/.test(url) ? url : `https://${url}`)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i>${label}</a>` : "");
  const facts = [["Галузь", company.industry], ["Розмір", company.size], ["Де", company.headquarters]].filter(([, value]) => value);
  return `<section class="triage-company">
    <header>
      <h3><i data-lucide="building-2"></i>Про компанію${company.name ? ` · ${escapeHtml(company.name)}` : ""}</h3>
      <div class="triage-links">${link(company.website, "Сайт")}${link(company.linkedin, "LinkedIn")}</div>
    </header>
    ${company.summary ? `<p class="triage-company-summary">${escapeHtml(company.summary)}</p>` : '<p class="triage-muted">Опису компанії в публічних джерелах не знайшлося.</p>'}
    ${facts.length ? `<div class="triage-company-facts">${facts.map(([label, value]) => `<span><small>${label}</small>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
    ${company.audience ? `<p><small class="triage-muted">Клієнти:</small> ${escapeHtml(company.audience)}</p>` : ""}
    ${company.products.length ? `<div class="triage-company-chips"><small class="triage-muted">Продукти:</small>${company.products.map((name) => `<span class="pill tone-muted">${escapeHtml(name)}</span>`).join("")}</div>` : ""}
    ${company.apps.length ? `<div class="triage-company-chips"><small class="triage-muted">Застосунки:</small>${company.apps.map((name) => `<span class="pill tone-muted">${escapeHtml(name)}</span>`).join("")}</div>` : ""}
    ${company.signals.length ? `<div class="triage-company-news"><small class="triage-muted">Новини й згадки</small><ul>${company.signals.slice(0, 3).map((row) => `<li><a href="${escapeAttr(row.url)}" target="_blank" rel="noopener">${escapeHtml(row.title)}</a><small>${escapeHtml([row.publisher, row.date].filter(Boolean).join(" · "))}</small></li>`).join("")}</ul></div>` : ""}
    <footer class="triage-muted">${company.researchedAt ? `зібрано ${escapeHtml(shortDate(company.researchedAt))}` : ""}
      <button type="button" class="text-button" data-triage="company-refresh" ${loading ? "disabled" : ""}><i data-lucide="refresh-cw"></i><span>${loading ? "Оновлюємо…" : "Оновити"}</span></button></footer>
  </section>`;
}

/** New addresses and checks from the server, keeping what the card already knew about letters sent. */
function mergeAddresses(fresh = []) {
  const known = new Map(addresses().map((row) => [row.address, row]));
  triage.item.email = {
    ...triage.item.email,
    addresses: fresh.map((row) => ({ written: false, ...known.get(row.address), ...row, seen: known.get(row.address)?.seen }))
  };
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
    <label class="triage-field"><span>Папка бази</span>
      <select data-triage="folder">
        <option value="">Оберіть папку…</option>
        <option value="all" ${triage.folderId === "all" ? "selected" : ""}>Усі контакти бази</option>
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
    : `${triage.folderId === "all" ? "уся база" : "папка"}: людина №<b>${(item.cursor || 0) + 1}</b>${item.total ? ` з ${item.total.toLocaleString("uk-UA")}` : ""} · друзів, яким ще не писали, тут більше немає`;
  return `<p class="triage-progress">${where}</p>`;
}

function crmFieldsHtml(contact) {
  const rows = [
    ["Компанія", contact.company], ["Посада", contact.position], ["Країна", contact.country],
    ["Пошта", contact.email], ["Телефон", contact.phone], ["Telegram", contact.telegram],
    ["Статус ліда", contact.lead_status], ["Стадія", contact.lifecycle_stage], ["Категорія", contact.category],
    ["Додано в базу", shortDate(contact.created_at)]
  ].filter(([, value]) => value);
  const link = (url, label) => (url ? `<a href="${escapeAttr(/^https?:/.test(url) ? url : `https://${url}`)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i>${label}</a>` : "");
  return `<dl class="triage-fields">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    <div class="triage-links">${link(contact.linkedin, "LinkedIn")}${link(contact.website, `Сайт · ${escapeHtml(String(contact.website).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}`)}${link(contact.facebook, "Facebook")}</div>
    ${contact.description ? `<div class="triage-note"><strong>Нотатка з бази</strong><p>${escapeHtml(contact.description)}</p></div>` : ""}`;
}

const FIELD_WORD = { email: "пошта", emails: "ще одна пошта", linkedin: "LinkedIn", website: "сайт", phone: "телефон" };

const sameValue = (left, right) => {
  const plain = (value) => {
    const text = String(value ?? "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    return /^[+\d\s().-]+$/.test(text) ? text.replace(/[^\d]/g, "") : text;
  };
  return plain(left) !== "" && plain(left) === plain(right);
};

// Whether a found site, phone or profile is in the base now — the owner asked
// that it go there, and the card says so next to it instead of leaving a guess.
function foundMark(item) {
  const field = { website: "website", phone: "phone", linkedin: "linkedin" }[item.type];
  if (!field) return "";
  const stored = triage.item?.contact?.[field];
  if (sameValue(stored, item.value)) return '<span class="triage-stored" title="Записано в базу">✓ у базі</span>';
  if (stored) return `<span class="triage-muted" title="У базі вже інше значення — його не перезаписано">у базі інше: ${escapeHtml(stored)}</span>`;
  return '<span class="triage-muted" title="Джерело недостатньо впевнене, щоб записати самому">не записано — перевірте</span>';
}

function enrichHtml() {
  const enrich = triage.enrich;
  const button = `<button type="button" data-triage="enrich" ${triage.enriching ? "disabled" : ""}><i data-lucide="sparkles"></i><span>${triage.enriching ? "Шукаємо й перевіряємо…" : "Збагатити"}</span></button>`;
  if (!enrich) return `<div class="triage-enrich">${button}<span class="triage-muted">Знайти пошту, телефон і профілі. Знайдена пошта перевіряється на поштовому сервері; що пройшло, і знайдений сайт, телефон, профіль — одразу записуються в базу.</span></div>`;
  if (enrich.error) return `<div class="triage-enrich">${button}<p class="esp-notice is-bad">${escapeHtml(enrich.error)}</p></div>`;
  const others = enrich.candidates.filter((item) => ["phone", "linkedin", "telegram", "whatsapp", "website"].includes(item.type));
  return `<div class="triage-enrich">${button}
    ${enrich.added?.length
      ? `<p class="triage-added"><i data-lucide="database"></i> Додано в базу: ${enrich.added.map((row) => `${escapeHtml(FIELD_WORD[row.field] || row.field)} <b>${escapeHtml(row.value)}</b>`).join(", ")}</p>`
      : '<p class="triage-muted">Нового для бази не знайдено — те, що знайшлося, там уже є.</p>'}
    ${others.length ? `<ul class="triage-found">${others.map((item) => `<li><span class="pill tone-muted">${escapeHtml(FIELD_WORD[item.type] || item.type)}</span> <b>${escapeHtml(item.value)}</b>
      ${foundMark(item)}
      <span class="triage-muted">${escapeHtml(item.source || "")}${item.confidence != null ? ` · ${escapeHtml(String(item.confidence))}` : ""}</span></li>`).join("")}</ul>` : ""}
    ${enrich.hidden ? `<p class="triage-muted">${enrich.hidden === 1 ? "Ще одну знайдену адресу поштовий сервер не підтвердив — її" : `Ще ${enrich.hidden} знайдені адреси поштові сервери не підтвердили — їх`} не показано й не збережено.</p>` : ""}
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
    ${!friends.length && !pending.length && !item.contact.linkedin ? '<p class="triage-muted">У базі немає посилання на LinkedIn — запит у друзі нікуди надіслати. «Збагатити» може знайти профіль.</p>' : ""}
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

/** One address as a row: a tick when its mailbox is confirmed, «!» with the reason when it is not. */
function addressRowHtml(row) {
  const status = row.check?.status;
  const ok = status === "valid";
  const why = !row.check ? "перевіряємо на поштовому сервері…" : `${row.check.reason || status}${row.check.checkedAt ? ` · перевірено ${shortDate(row.check.checkedAt)}` : ""}`;
  const mark = !row.check
    ? '<span class="triage-check is-pending" title="перевіряємо на поштовому сервері…">…</span>'
    : ok ? `<span class="triage-check is-ok" title="${escapeAttr(why)}">✓</span>`
      : `<span class="triage-check is-bad" title="${escapeAttr(why)}">!</span>`;
  const sentLine = row.written ? ` <span class="triage-muted">· уже писали${row.writtenAt ? ` ${escapeHtml(shortDate(row.writtenAt))}` : ""}${row.writtenFrom ? ` з ${escapeHtml(row.writtenFrom)}` : ""}</span>` : "";
  return `<li class="${ok ? "" : "is-off"}">
    <label class="triage-address" title="${escapeAttr(why)}">
      <input type="checkbox" data-triage-address="${escapeAttr(row.address)}" ${triage.selected.has(row.address) ? "checked" : ""} ${ok && !row.written ? "" : "disabled"} />
      ${mark}<b>${escapeHtml(row.address)}</b>
      <span class="triage-muted">${row.source === "found" ? "знайдено збагаченням" : "з бази"}</span>${sentLine}
    </label>
  </li>`;
}

/**
 * The mailbox to send from — a picker of our own, not the browser's select
 * (owner 13.10): grouped by domain, a small gap between domains, each with
 * today's count against its limit; a full one says so and cannot be picked.
 */
function mailboxPickerHtml(mailboxes) {
  if (!mailboxes.length) return '<div class="triage-picker is-empty"><i data-lucide="mail-x"></i><span>Немає пошти для розсилки</span></div>';
  const chosen = mailboxes.find((sender) => sender.email === triage.mailbox) || mailboxes[0];
  const room = (sender) => `${sender.today}/${sender.limit}`;
  const groups = new Map();
  for (const sender of mailboxes) {
    const domain = sender.domain || sender.email.split("@")[1];
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(sender);
  }
  return `<div class="triage-picker ${triage.pickerOpen ? "is-open" : ""}">
    <button type="button" class="triage-picker-button" data-triage="picker" aria-haspopup="listbox" aria-expanded="${triage.pickerOpen ? "true" : "false"}">
      <span class="triage-picker-avatar">${escapeHtml(chosen.email.charAt(0).toUpperCase())}</span>
      <span class="triage-picker-text"><b>${escapeHtml(chosen.email)}</b><small>сьогодні ${room(chosen)}</small></span>
      <i data-lucide="chevron-down"></i>
    </button>
    ${triage.pickerOpen ? `<div class="triage-picker-menu" role="listbox">${[...groups.entries()].map(([domain, group]) => `
      <div class="triage-picker-group">
        <div class="triage-picker-domain">${escapeHtml(domain)}</div>
        ${group.map((sender) => {
          const full = sender.today >= sender.limit;
          return `<button type="button" role="option" class="triage-picker-option ${sender.email === chosen.email ? "is-chosen" : ""}" data-triage-pick="${escapeAttr(sender.email)}" aria-selected="${sender.email === chosen.email}" ${full ? "disabled" : ""}>
            <span>${escapeHtml(sender.email.split("@")[0])}<small>@${escapeHtml(domain)}</small></span>
            <span class="triage-picker-room ${full ? "is-full" : ""}">${full ? "ліміт на сьогодні" : room(sender)}</span>
            ${sender.email === chosen.email ? '<i data-lucide="check"></i>' : ""}
          </button>`;
        }).join("")}
      </div>`).join("")}</div>` : ""}
  </div>`;
}

function emailHtml(item) {
  const list = addresses();
  const mailboxes = triage.mailboxes || [];
  const chosen = list.filter((row) => triage.selected.has(row.address));
  const locked = !triage.liveSend;
  const label = chosen.length > 1 ? `Надіслати ${chosen.length} листи з ${triage.mailbox || "пошти"}` : `Надіслати з ${triage.mailbox || "пошти"}`;
  return `<section class="triage-channel">
    <header><i data-lucide="mail"></i><h3>Пошта</h3></header>
    ${list.length
      ? `<ul class="triage-addresses">${list.map(addressRowHtml).join("")}</ul>
         ${list.length > 1 ? '<p class="triage-muted">Позначте, на які адреси писати. Усі листи підуть з однієї пошти — вибраної нижче.</p>' : ""}`
      : '<ul class="triage-status"><li><i data-lucide="mail-x"></i> Адреси в базі немає — «Збагатити» може знайти й перевірити</li></ul>'}
    ${tacticHtml()}
    <input data-triage-text="subject" placeholder="Тема" value="${escapeAttr(triage.texts.subject)}" />
    <textarea data-triage-text="body" rows="8" placeholder="${triage.drafting || (triage.prep && triage.prep.state !== "done") ? "Лист пишеться, коли зібрано всі дані…" : "Текст листа. Лише простий текст; підпис і відписка додаються самі."}">${escapeHtml(triage.texts.body)}</textarea>
    <div class="triage-actions">
      ${mailboxPickerHtml(mailboxes)}
      <button type="button" class="primary-button" data-triage="send-email" ${!chosen.length || !mailboxes.length || locked || triage.sending ? "disabled" : ""} title="${escapeAttr(locked ? "Справжню відправку ще не ввімкнено (ESP_LIVE_SEND, після приймання ESP 11)" : "")}"><i data-lucide="send"></i><span>${escapeHtml(label)}</span></button>
    </div>
    ${locked ? '<p class="triage-muted"><i data-lucide="lock"></i> Справжню відправку листів ще не ввімкнено (ESP_LIVE_SEND, після приймання ESP 11) — кнопка запрацює разом із нею.</p>' : '<p class="triage-muted">Лист пройде ті самі перевірки, що й кампанія: виключення, верифікацію, ліміти пошти й робочі години одержувача.</p>'}
  </section>`;
}

function cardHtml(item) {
  const contact = item.contact;
  return `<article class="triage-card">
    <div class="triage-person">
      <header class="triage-head">
        <div><h2>${escapeHtml(contact.name || "без імені")}</h2><p>${escapeHtml([contact.position, contact.company].filter(Boolean).join(" · "))}</p></div>
      </header>
      ${prepHtml()}
      ${crmFieldsHtml(contact)}
      ${companyHtml(item)}
      ${enrichHtml()}
      <div class="triage-decide">
        <button type="button" data-triage="draft" ${triage.drafting ? "disabled" : ""}><i data-lucide="wand-sparkles"></i><span>${triage.drafting ? "Пишемо…" : item.drafts ? "Переписати лист" : "Написати лист"}</span></button>
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
  if (!triage.folderId) body = '<div class="triage-empty"><i data-lucide="folder-open"></i><strong>Оберіть папку бази</strong><p>Далі — людина за людиною: спершу ті, хто вже в друзях наших LinkedIn-акаунтів, потім решта папки. Лише ті, кому ще ніхто не писав.</p></div>';
  else if (triage.loading && !item) body = '<div class="empty-state">Шукаємо наступну людину…</div>';
  else if (triage.error) body = `<p class="esp-notice is-bad">${escapeHtml(triage.error)}</p>`;
  else if (item?.done || !item?.contact) body = '<div class="triage-empty"><i data-lucide="party-popper"></i><strong>У цій папці всіх уже опрацьовано</strong><p>Кожному або вже писали, або його позначено невалідним. Пропущені сьогодні повернуться після перезавантаження.</p><button type="button" data-triage="restart">Почати папку спочатку</button></div>';
  else body = `${progressHtml(item)}${cardHtml(item)}`;
  root.innerHTML = `${foldersHtml()}${triage.notice ? `<p class="esp-notice ${triage.tone}" role="status">${escapeHtml(triage.notice)}</p>` : ""}${body}${recentHtml()}`;
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
  if (contact) {
    triage.skip.push(String(contact.id));
    // Counted for «По днях»; the queue itself is this page's.
    api("/api/triage/skip", { method: "POST", body: JSON.stringify({ contactId: contact.id, name: contact.name }) }).catch(() => {});
  }
  triage.notice = "";
  await loadNext();
}

/**
 * «Переписати лист» and a new tactic: the server writes the letter again from
 * the data it already gathered — nothing is researched twice.
 */
async function draftTexts() {
  const contact = triage.item?.contact;
  if (!contact || triage.drafting) return;
  readTexts();
  triage.drafting = true;
  triage.dirty = new Set();
  renderTriage();
  try {
    const { prep } = await api("/api/triage/prepare", { method: "POST", body: JSON.stringify(prepOptions(contact.id, { redraft: true })) });
    if (triage.item?.contact?.id !== contact.id) return;
    triage.prep = prep;
    watchPrep(contact.id);
  } catch (error) {
    say(error.message || "Модель не написала лист.", "is-bad");
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
    const answer = await api("/api/triage/enrich", { method: "POST", body: JSON.stringify({ contactId: contact.id }) });
    if (triage.item?.contact?.id !== contact.id) return;
    triage.enrich = answer;
    if (answer.contact) triage.item.contact = { ...triage.item.contact, ...answer.contact };
    mergeAddresses(answer.emails);
    tickConfirmed();
  } catch (error) {
    triage.enrich = { error: error.message || "Не вдалося збагатити.", candidates: [] };
  }
  triage.enriching = false;
  renderTriage();
  // Something new went into the base: the letter is written again with it.
  if (triage.enrich?.added?.length && triage.item?.contact?.id === contact.id && !triage.dirty.has("body")) await draftTexts();
}

async function sendLinkedin(outreachId) {
  readTexts();
  const friend = triage.item.linkedin.friends.find((row) => row.outreachId === outreachId);
  if (!triage.texts.linkedin.trim()) return say("Порожнє повідомлення — напишіть або згенеруйте текст.", "is-bad"), renderTriage();
  triage.sending = "linkedin";
  renderTriage();
  try {
    const answer = await api("/api/warmup/first-messages/send", { method: "POST", body: JSON.stringify({ outreachId, text: triage.texts.linkedin }) });
    void loadRecent();
    const when = (iso) => new Date(iso).toLocaleString("uk-UA", { weekday: "short", hour: "2-digit", minute: "2-digit" });
    say(answer.goesOutNow
      ? `Повідомлення піде з ${friend?.accountName || "акаунта"} за кілька хвилин — окремою короткою сесією.`
      : answer.limitReached
        ? `Денний ліміт повідомлень ${friend?.accountName || "акаунта"}${answer.perDay ? ` (${answer.perDay})` : ""} вичерпано — повідомлення піде ${answer.goesOutAt ? when(answer.goesOutAt) : "у наступну сесію"}.`
        : `Повідомлення стало в чергу ${friend?.accountName || "акаунта"}${answer.goesOutAt ? ` — піде ${when(answer.goesOutAt)}` : ""}: акаунт зараз не можна відкрити (пауза чи потрібен вхід).`);
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
  // One letter per ticked address, all from the one mailbox chosen.
  const chosen = addresses().filter((row) => triage.selected.has(row.address));
  const went = [];
  const failed = [];
  for (const row of chosen) {
    try {
      const lead = { email: row.address, crmContactId: contact.id, name: contact.name, company: contact.company, country: contact.country, position: contact.position, source: "CRM", sourceDate: contact.created_at, verification: row.check?.status, verifiedAt: row.check?.checkedAt };
      const answer = await api("/api/esp/send-one", { method: "POST", body: JSON.stringify({ lead, mailbox: triage.mailbox, subject: triage.texts.subject, body: triage.texts.body }) });
      if (answer.ok) went.push(row.address); else failed.push(`${row.address}: ${answer.error || "не пішов"}`);
    } catch (error) {
      failed.push(`${row.address}: ${error.message || "не пішов"}`);
    }
  }
  triage.sending = "";
  if (failed.length) {
    say(`${went.length ? `Надіслано з ${triage.mailbox}: ${went.join(", ")}. ` : ""}Не пішло — ${failed.join("; ")}`, "is-bad");
    return renderTriage();
  }
  say(`Надіслано з ${triage.mailbox}: ${went.join(", ")}.`);
  void loadRecent();
  await loadNext();
}

async function invite() {
  const contact = triage.item?.contact;
  if (!contact || !triage.inviteAccount) return;
  triage.sending = "invite";
  renderTriage();
  try {
    await api("/api/warmup/invites", { method: "POST", body: JSON.stringify({ crmContactId: contact.id, accountId: triage.inviteAccount }) });
    const account = triage.inviteAccounts.find((row) => row.id === triage.inviteAccount);
    void loadRecent();
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
  } else if (field === "tactic") {
    triage.tactic = event.target.value;
    save(TACTIC_KEY, triage.tactic);
    if (triage.tactic !== "conference" || triage.event.trim()) void draftTexts(); else renderTriage();
  } else if (field === "event") {
    triage.event = event.target.value.trim();
    save(EVENT_KEY, triage.event);
    if (triage.tactic === "conference" && triage.event) void draftTexts();
  } else if (field === "product") triage.productId = event.target.value;
  else if (field === "language") triage.language = event.target.value;
  else if (field === "mailbox") { readTexts(); triage.mailbox = event.target.value; renderTriage(); }
  else if (field === "invite-account") { readTexts(); triage.inviteAccount = event.target.value; renderTriage(); }
});
root?.addEventListener("change", (event) => {
  const address = event.target.dataset?.triageAddress;
  if (!address) return;
  readTexts();
  if (event.target.checked) triage.selected.add(address); else triage.selected.delete(address);
  renderTriage();
});
root?.addEventListener("input", (event) => {
  const field = event.target.dataset?.triageText;
  if (field) { triage.texts[field] = event.target.value; triage.dirty.add(field); }
});
root?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.triageSendLinkedin) return void sendLinkedin(button.dataset.triageSendLinkedin);
  if (button.dataset.triagePath) {
    const key = button.dataset.triagePath;
    return void import("./work.js").then((module) => module.openWorkContact(key));
  }
  if (button.dataset.triagePick) {
    readTexts();
    Object.assign(triage, { mailbox: button.dataset.triagePick, pickerOpen: false });
    return renderTriage();
  }
  switch (button.dataset.triage) {
    case "picker": readTexts(); triage.pickerOpen = !triage.pickerOpen; return renderTriage();
    case "invalid": return void decideInvalid();
    case "skip": return void skip();
    case "draft": return void draftTexts();
    case "enrich": return void enrich();
    case "company": return void loadCompany(triage.item.contact.id);
    case "company-refresh": return void loadCompany(triage.item.contact.id, { force: true });
    case "send-email": return void sendEmail();
    case "invite": return void invite();
    case "restart": Object.assign(triage, { cursor: 0, skip: [], notice: "" }); return void loadNext();
    default: return undefined;
  }
});

// The mailbox picker closes on a click elsewhere and on Escape.
document.addEventListener("click", (event) => {
  if (!triage.pickerOpen || event.target.closest?.(".triage-picker")) return;
  readTexts();
  triage.pickerOpen = false;
  renderTriage();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !triage.pickerOpen) return;
  readTexts();
  triage.pickerOpen = false;
  renderTriage();
});
