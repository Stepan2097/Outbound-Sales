// «Сьогодні» — черга пінгів лідгена (етап 1/6 плану кампаній і пінгів, 16.10.2026).
// Живе у LinkedIn → Вхідні → «В роботі» (Марко 20.10: одна вкладка розмов замість двох):
// фільтри черги — тут, фільтр «Усі розмови» — месенджер (inbox.js). Між ними — переходи:
// пінг → «Уся розмова», розмова з пінгом → «До роботи» (connectInboxWork).
//
// Кожен живий діалог має пінг — задачу CRM з датою наступного дотику. Тут вони в
// тому порядку, в якому їх робити: відповіді → прострочені → на сьогодні →
// перші повідомлення. Нові контакти з папки — у Вхідні → «Нові» (20.10), з правилом
// «спершу розмови».
//
// Робоче місце — один лід за раз: хто це, уся переписка, чернетка, «Погодити й
// надіслати» → наступний. Пінг можна перенести (+1 день, +3, тиждень, дата) чи
// зробити дзвінком. Надсилає не ця сторінка: повідомлення стає в чергу акаунта
// тими самими маршрутами, що й «Усі розмови», а сервер звіряє пінги —
// закриває цей і ставить наступний (через 3 робочі дні).

import { api, escapeAttr, escapeHtml, keepScroll, onScreen, refreshIcons } from "../core.js";
import { connectInboxWork, renderWarmupInbox, warmupThreadTotal, showWarmupInboxThread, warmupGoesOutText, warmupMessageHtml, warmupProfileUrl } from "./inbox.js";
import { showContactCard } from "./contacts.js";
import { createCampaignFor } from "./lead-campaigns.js";
import { leaveNewContacts, openNewContacts } from "./new-contacts.js";

onScreen("inbox", { open: () => applyInboxMode() });

/* ── Workspace (до 22.10 — «Вхідні»; Марко 20.10, таск f50d24e9; перейменовано — таск 485bbc8d;
   внутрішня назва екрана лишилась "inbox"): вкладки «В роботі» і «Нові» ──────────────────
   «В роботі» — одна вкладка розмов: фільтри «Відповіді / Прострочені / На сьогодні /
   Перші» — черга пінгів (цей файл), фільтр «Усі розмови» — месенджер усіх акаунтів
   (inbox.js), зокрема розмови без пінга. «Нові» — конвеєр нових контактів (new-contacts.js).
   Стан: "work" — черга, "all" — усі розмови (обидва — вкладка «В роботі»), "new" — «Нові». */

const MODE_KEY = "outbound.inbox.mode";
const MODES = ["work", "all", "new"];
let inboxMode = readMode();

function readMode() {
  try { const saved = window.localStorage.getItem(MODE_KEY); return MODES.includes(saved) ? saved : "work"; } catch { return "work"; }
}

function setInboxMode(mode) {
  inboxMode = MODES.includes(mode) ? mode : "work";
  try { window.localStorage.setItem(MODE_KEY, inboxMode); } catch {}
}

const onInboxView = () => Boolean(document.getElementById("view-inbox")?.classList.contains("active"));
// Пінги свіжі хвилину: перемикання «Уся розмова» ↔ «До роботи» на тому самому екрані їх не перечитує
// (Марко 22.10, таск de18b7b2: «працює баговано» — кожен перехід тягнув усе заново, картка блимала).
const FRESH_MS = 60000;

/** Показати вибране: черга чи всі розмови (вкладка «В роботі») або «Нові». */
function applyInboxMode({ refresh = true } = {}) {
  const tab = inboxMode === "new" ? "new" : "work";
  for (const button of document.querySelectorAll("[data-inbox-tab]")) {
    const on = button.dataset.inboxTab === tab;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-selected", String(on));
  }
  for (const pane of document.querySelectorAll("[data-inbox-pane]")) pane.hidden = !pane.dataset.inboxPane.split(" ").includes(inboxMode);
  // «До роботи» і «Усі розмови» — одна панель, різна аудиторія (Марко 20.10): стиль за режимом.
  document.getElementById("view-inbox")?.setAttribute("data-mode", inboxMode);
  if (inboxMode === "new") return void openNewContacts();
  leaveNewContacts();
  // Пінги потрібні й «Усім розмовам»: розмова з пінгом має кнопку «До роботи».
  if (refresh || !today.data || Date.now() - (today.loadedAt || 0) > FRESH_MS) return void openToday({ keepSelection: true });
  render();
  if (inboxMode === "all") return void renderWarmupInbox();
  if (today.selected && today.detail?.item?.pingId !== today.selected) void loadDetail(today.selected);
}

/** Перемкнути «До роботи» ↔ «Усі розмови»: на Workspace — на місці, з іншого екрана — через меню. */
function switchInboxMode(mode) {
  setInboxMode(mode);
  if (onInboxView()) return applyInboxMode({ refresh: false });
  document.querySelector('.nav-item[data-view="inbox"]')?.click();
}

/** «Усі розмови» з inbox.js: на Workspace — на місці; перехід з іншого екрана робить сам inbox.js. */
function showAllConversations() {
  setInboxMode("all");
  if (onInboxView()) applyInboxMode({ refresh: false });
}

function renderModeCounts() {
  const work = document.getElementById("inboxWorkCount");
  if (work) work.textContent = today.data?.configured ? String(allItems().length || "") : "";
  // Ледь помітний коментар біля «Нові» замість рядка під чергою (Марко 20.10).
  const hint = document.getElementById("inboxNewHint");
  if (hint) hint.textContent = today.data?.configured && today.data.newContactsAllowed === false ? "після розмов" : "";
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest?.("[data-inbox-tab]");
  if (tab) {
    const next = tab.dataset.inboxTab === "new" ? "new" : "work";
    if ((next === "new") === (inboxMode === "new")) return;
    setInboxMode(next);
    return void applyInboxMode();
  }
  const toWork = event.target.closest?.("[data-inbox-to-work]");
  if (toWork) return void openPing(toWork.dataset.inboxToWork);
});

/** Пінг цієї розмови — у черзі або «далі за планом». */
function pingFor(accountId, threadKey) {
  if (!accountId || !threadKey || !today.data) return null;
  return [...allItems(), ...(today.data.later || [])].find((item) => item.accountId === accountId && item.threadKey === threadKey) || null;
}

/** Відкрити пінг у «До роботи» — з розмови в «Усіх розмовах» чи з Головної. */
export function openPing(pingId) {
  if (!pingId) return;
  today.blockFilter = "";
  // Той самий лід, що вже відкритий, — картка лишається як є: без «Оберіть пінг» і «Відкриваю…».
  if (today.detail?.item?.pingId !== pingId) {
    today.detail = null;
    today.detailLoading = true;
    today.text = "";
    today.textFor = "";
    today.draftNote = "";
  }
  today.selected = pingId;
  switchInboxMode("work");
}

/** З Головної-пульту: «Усі розмови» (коли вхідні давно не читались — глянути, що там). */
export function openAllConversations() {
  setInboxMode("all");
  document.querySelector('.nav-item[data-view="inbox"]')?.click();
}

/** З Головної-пульту: «До роботи» з одним блоком (відповіді, прострочені…) або всі — у тих самих «Мої / Усі». */
/** З Головної: Вхідні → «Нові» (кнопка «Нові контакти» під пультом, таск ca978070). */
export function openNewTab() {
  setInboxMode("new");
  document.querySelector('.nav-item[data-view="inbox"]')?.click();
}

export function openTodayBlock(block = "", { scope = "" } = {}) {
  setInboxMode("work");
  today.blockFilter = BLOCKS.some(([key]) => key === block) ? block : "";
  today.selected = "";
  if (scope === "all" || scope === "mine") today.scope = scope;
  document.querySelector('.nav-item[data-view="inbox"]')?.click();
}

connectInboxWork({ showAll: showAllConversations, pingFor, loaded: () => render(), opened: (open) => void openThreadSide(open) });

const SCOPE_KEY = "outbound.today.scope";
const BLOCKS = [
  ["replies", "Відповіді", "Лід написав — відповісти"],
  ["overdue", "Прострочені", "Дата пінгу минула"],
  ["today", "На сьогодні", "Пінги на сьогодні"],
  ["first", "Перші повідомлення", "Прийняли запит — написати першими"]
];

// Фільтри «В роботі» — один список (Марко 22.10, таск 4c945837, варіант A): «Щодня» — по черзі,
// «Перевіряти» — час від часу. Пояснення три: рядок у пункті, підказка при наведенні, «?».
const FILTER_TEXT = {
  "": ["Усе нижче разом", "Усе, що чекає на вас, разом: відповіді, прострочені, на сьогодні й перші повідомлення. Не окремий список, а сума."],
  replies: ["Лід написав — відповісти. Першими", "Лід написав останнім і чекає відповіді — з будь-якого дня, не лише сьогодні. Робити першими."],
  overdue: ["Дата пінга минула — нагадати, написати, подзвонити", "Дата пінга минула, а ми не написали: нагадати мовчуну, перше повідомлення чи дзвінок. Друге за пріоритетом."],
  today: ["Нагадування з датою на сьогодні", "Нагадування тим, хто мовчить, з датою на сьогодні."],
  first: ["Прийняв запит — написати першим", "Людина прийняла запит у друзі — написати першими."],
  silent: ["Ми написали останніми — людина мовчить", "Ми написали останніми, людина мовчить. Нагадування саме прийде в «На сьогодні» в свій день — тут лише перевірити, хто чекає."],
  threads: ["Усі переписки, і без пінга", "Усі переписки акаунтів, і ті, де пінга немає: люди не з CRM, старі, закриті статусом. Перевіряти час від часу."]
};

/** «Без відповіді»: усі «Нагадати» — і ті, що вже настали, і «далі за планом»; ближчі — вище. */
function silentItems() {
  return [...allItems(), ...(today.data?.later || [])].filter((item) => item.reason === "silent")
    .sort((left, right) => String(left.dueDay || "").localeCompare(String(right.dueDay || "")));
}
const DRAFT_LABEL = { reply: "Чернетка відповіді", "follow-up": "Нагадування", first: "Перше повідомлення" };

const today = {
  data: null, error: "", loading: false,
  scope: readScope(),
  // Чіп блоку в шапці (аудит 16.10): показати лише «Прострочені», «На сьогодні»… — порожньо = усі.
  blockFilter: "", statusSaving: false, filterOpen: false, helpOpen: false,
  // Акаунт і пошук — так само, як в «Усіх розмовах» (19.10, В1). Порожньо — усі акаунти.
  account: "", search: "",
  selected: "", detail: null, detailError: "", detailLoading: false,
  draftLoading: false, draftNote: "", sending: false, notice: "", tone: "", text: "", textFor: "",
  // Етап 2/6: відкриті діалоги з 01.08 (адмін).
  imports: null, importOpen: false, importError: "", importPick: new Set(), importEdits: new Map(), importAssignee: "", importBusy: false, importTimer: null,
  // Коли нагадувати тим, хто мовчить (власник 20.10: «зробити ці поля редагованими»).
  stepsOpen: false, steps: null, stepsDraft: [], stepsLaterDays: 30, stepsSaving: false, stepsError: "", stepsNote: ""
};

const ORDINAL = ["Перший", "Другий", "Третій", "Четвертий", "П'ятий", "Шостий"];

/** Кроки нагадувань: поле на кожен, «+» до шести, і що буде з «Невдалим часом». */
function stepsHtml() {
  if (!today.steps) return `<div class="today-steps"><p class="today-empty">${escapeHtml(today.stepsError || "Читаю…")}</p></div>`;
  const draft = today.stepsDraft;
  return `<form class="today-steps" data-today-steps>
    <p class="today-steps-lead">Лід мовчить після нашого повідомлення — коли нагадати (робочих днів після попереднього):</p>
    <div class="today-steps-row">
      ${draft.map((days, index) => `<label class="today-step"><span>${ORDINAL[index]} пінг через</span>
        <input type="number" min="1" max="30" step="1" inputmode="numeric" data-today-step="${index}" value="${escapeAttr(days)}" aria-label="${ORDINAL[index]} пінг через, робочих днів" />
        <span>дн.</span>${draft.length > 1 ? `<button type="button" class="icon-button" data-today="step-remove" data-index="${index}" aria-label="Прибрати це нагадування" title="Прибрати"><i data-lucide="x"></i></button>` : ""}</label>`).join("")}
      ${draft.length < 6 ? `<button type="button" data-today="step-add"><i data-lucide="plus"></i>Нагадування</button>` : ""}
    </div>
    <p class="today-steps-note">Після ${draft.length + 1} повідомлень без відповіді людину більше не пінгуємо. Статус «Невдалий час» — один пінг «Повернутись» через ${escapeHtml(today.stepsLaterDays)} днів. Кампанії мають свої кроки — у налаштуваннях кампанії.</p>
    <div class="today-steps-actions">
      <button type="submit" class="primary-button" ${today.stepsSaving ? "disabled" : ""}>${today.stepsSaving ? "Зберігаю…" : "Зберегти"}</button>
      ${today.stepsError ? `<span class="today-notice is-error" role="alert">${escapeHtml(today.stepsError)}</span>` : today.stepsNote ? `<span class="today-notice" role="status">${escapeHtml(today.stepsNote)}</span>` : ""}
    </div>
  </form>`;
}

async function loadSteps() {
  try {
    const payload = await api("/api/today/ping-steps");
    today.steps = payload.steps;
    today.stepsDraft = [...payload.steps];
    today.stepsLaterDays = payload.laterDays || 30;
    today.stepsError = "";
  } catch (error) {
    today.stepsError = error.message || "Не вдалося прочитати.";
  }
  render();
}

async function saveSteps() {
  const steps = today.stepsDraft.map(Number);
  if (!steps.every((days) => Number.isInteger(days) && days >= 1 && days <= 30)) {
    today.stepsError = "Кожне — ціле число від 1 до 30.";
    return render();
  }
  today.stepsSaving = true;
  today.stepsError = "";
  render();
  try {
    const payload = await api("/api/today/ping-steps", { method: "POST", body: JSON.stringify({ steps }) });
    today.steps = payload.steps;
    today.stepsDraft = [...payload.steps];
    today.stepsNote = "Збережено. Пінги перерахуються за хвилину.";
  } catch (error) {
    today.stepsError = error.message || "Не вдалося зберегти.";
  } finally {
    today.stepsSaving = false;
    render();
  }
}

function readScope() {
  try { return window.localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "mine"; } catch { return "mine"; }
}

const root = () => document.getElementById("todayRoot");

function dayLabel(day, todayDay) {
  if (!day) return "";
  if (day === todayDay) return "сьогодні";
  const [y, m, d] = day.split("-");
  return day < todayDay ? `з ${d}.${m}` : `${d}.${m}.${y.slice(2)}`;
}

function allItems() {
  const blocks = today.data?.blocks || {};
  return BLOCKS.flatMap(([key]) => blocks[key] || []);
}

async function openToday({ keepSelection = false } = {}) {
  today.loading = true;
  render();
  try {
    today.data = await api(`/api/today?scope=${today.scope}`);
    today.loadedAt = Date.now();
    today.error = "";
  } catch (error) {
    if (error?.name === "AbortError") return;
    today.error = error.message || "Не вдалося завантажити пінги.";
  } finally {
    today.loading = false;
  }
  const items = allItems();
  // Вибраним лишається пінг, відкритий з розмови чи з Головної, — навіть «далі за планом».
  const known = [...items, ...(today.data?.later || [])];
  const first = (today.blockFilter === "silent" ? silentItems()[0] : today.blockFilter && today.data?.blocks?.[today.blockFilter]?.[0]) || items[0];
  if (!keepSelection || !known.some((item) => item.pingId === today.selected)) today.selected = first?.pingId || "";
  render();
  // «Усі розмови» читають пінги лише заради кнопки «До роботи»: картку не відкриваємо —
  // відкриття відповіді позначає її прочитаною.
  if (inboxMode !== "work") return void renderWarmupInbox();
  if (today.selected) void loadDetail(today.selected);
  else today.detail = null;
}

async function loadDetail(pingId) {
  today.detailLoading = true;
  today.detailError = "";
  render();
  try {
    const detail = await api(`/api/today/item?pingId=${encodeURIComponent(pingId)}`);
    if (today.selected !== pingId) return;
    today.detail = detail;
    if (today.textFor !== pingId) {
      today.text = detail.draft?.text || "";
      today.textFor = pingId;
    }
    // Відповідь, яку відкрили тут, прочитана — як у «Вхідних».
    const item = detail.item;
    if (item.channel === "thread" && item.block === "replies") {
      void api("/api/warmup/inbox/read", { method: "POST", body: JSON.stringify({ accountId: item.accountId, threadKey: item.threadKey }) }).catch(() => {});
    }
    if (!today.text && (item.channel === "thread" || item.channel === "first")) void writeDraft(false);
  } catch (error) {
    if (error?.name === "AbortError") return;
    today.detailError = error.message || "Не вдалося відкрити пінг.";
  } finally {
    today.detailLoading = false;
    render();
    // Гортається лише розмова, поле відповіді й кнопки стоять унизу (Марко 20.10): одразу —
    // до останнього повідомлення.
    const thread = document.querySelector("#todayRoot .today-thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
  }
}

async function writeDraft(force) {
  const item = today.detail?.item;
  if (!item) return;
  today.draftLoading = true;
  render();
  try {
    let text = "";
    if (item.channel === "first") {
      const payload = await api("/api/warmup/first-messages/draft", { method: "POST", body: JSON.stringify({ outreachId: item.outreachId, force }) });
      text = payload.draft?.text || "";
    } else {
      const payload = await api("/api/today/draft", { method: "POST", body: JSON.stringify({ pingId: item.pingId, force }) });
      text = payload.draft?.text || "";
    }
    if (today.selected === item.pingId && (force || !today.text)) {
      today.text = text;
      // Біля поля, а не в загальному рядку: там може стояти «погоджено, піде…» про попереднього ліда.
      today.draftNote = text ? "" : "Модель зараз не написала чернетку — напишіть самі.";
    }
  } catch (error) {
    if (error?.name !== "AbortError") today.draftNote = error.message || "Чернетка не вийшла — напишіть самі.";
  } finally {
    today.draftLoading = false;
    render();
  }
}

function say(text, tone = "is-ok") {
  today.notice = text;
  today.tone = tone;
}

async function send() {
  const item = today.detail?.item;
  const text = today.text.trim();
  if (!item || !text || today.sending) return;
  today.sending = true;
  say("");
  render();
  try {
    let reply;
    if (item.channel === "first") {
      reply = await api("/api/warmup/first-messages/send", { method: "POST", body: JSON.stringify({ outreachId: item.outreachId, text }) });
    } else {
      const followUp = today.detail.messages.at(-1)?.direction !== "in";
      reply = await api("/api/warmup/inbox/reply", { method: "POST", body: JSON.stringify({ accountId: item.accountId, threadKey: item.threadKey, text, followUp }) });
    }
    // Пінг закривається, наступний ставиться — звірка на сервері.
    await api("/api/today/refresh", { method: "POST", body: "{}" }).catch(() => {});
    const goes = warmupGoesOutText(reply);
    const name = item.name;
    today.text = "";
    today.textFor = "";
    today.draftNote = "";
    await openToday();
    say(`${name}: погоджено, піде ${goes}. Наступний пінг — через 3 робочі дні.`);
    render();
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося поставити в чергу.", "is-error");
    render();
  } finally {
    today.sending = false;
    render();
  }
}

/** «Скасувати» повідомлення, що ще чекає відправки (той самий маршрут, що в «Усіх розмовах»). */
async function cancelReply(replyId) {
  const item = today.detail?.item;
  if (!item || !replyId) return;
  try {
    await api("/api/warmup/inbox/reply/cancel", { method: "POST", body: JSON.stringify({ accountId: item.accountId, replyId }) });
    say("Скасовано — повідомлення не піде.");
    await loadDetail(item.pingId);
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося скасувати.", "is-error");
    render();
  }
}

async function movePing(when, call = false) {
  const item = today.detail?.item;
  if (!item) return;
  try {
    const result = await api("/api/today/ping", { method: "POST", body: JSON.stringify({ pingId: item.pingId, when, call }) });
    const name = item.name;
    await openToday({ keepSelection: true });
    say(`${name}: ${call ? "дзвінок" : "пінг"} на ${dayLabel(result.dueDay, today.data?.today)}.`);
    render();
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося перенести.", "is-error");
    render();
  }
}

/* ── відкриті діалоги з 01.08 (етап 2/6) ───────────────────────────────── */

const STEP = { reply: "Відповісти", silent: "Нагадати", call: "Дзвінок" };
const PRIORITY_LABEL = { high: "високий", normal: "звичайний", low: "низький" };

async function loadImports() {
  try {
    today.imports = await api("/api/today/open-dialogs");
    today.importError = "";
    if (!today.importAssignee) today.importAssignee = today.imports.defaultAssignee || "";
    // Нові кандидати вибрані одразу; зняте людиною лишається знятим.
    for (const item of today.imports.items) if (!today.importEdits.has(item.contactId) && !today.importPick.has(`x:${item.contactId}`)) today.importPick.add(item.contactId);
  } catch (error) {
    if (error?.name !== "AbortError") today.importError = error.message || "Не вдалося прочитати відкриті діалоги.";
  }
  clearTimeout(today.importTimer);
  if (today.importOpen && today.imports?.job?.running) today.importTimer = setTimeout(() => void loadImports(), 3000);
  render();
}

function importValue(item, field) {
  return today.importEdits.get(item.contactId)?.[field] ?? item[field];
}

function importHtml() {
  const data = today.imports;
  if (today.importError) return `<p class="today-empty is-error">${escapeHtml(today.importError)}</p>`;
  if (!data) return `<p class="today-empty">Збираю відкриті діалоги з CRM…</p>`;
  const picked = data.items.filter((item) => today.importPick.has(item.contactId));
  const job = data.job;
  const ai = job?.running ? `AI думає: ${job.done} з ${job.total}…` : job ? `AI переглянув ${job.done}${job.failed ? `, без відповіді ${job.failed} — за правилом` : ""}` : "";
  return `
    <div class="today-import-bar">
      <p>${data.items.length ? `${data.items.length} відкритих діалогів без пінга. Дати розкладено до ${data.perDay} на робочий день, важливіші — раніше.` : "Відкритих діалогів без пінга немає."}</p>
      <div class="today-import-actions">
        <button type="button" data-today="import-ai" ${job?.running || !data.items.length ? "disabled" : ""}><i data-lucide="sparkles"></i><span>${job ? "Спитати AI ще раз" : "Спитати AI про кожного"}</span></button>
        ${ai ? `<span class="today-hint">${escapeHtml(ai)}</span>` : ""}
      </div>
    </div>
    ${data.items.length ? `<div class="today-import-accept">
      <label><span>Кому пінги</span><select data-today-import="assignee">
        <option value="">— оберіть —</option>
        ${(data.people || []).map((person) => `<option value="${escapeAttr(person.id)}"${person.id === today.importAssignee ? " selected" : ""}>${escapeHtml(person.email)}</option>`).join("")}
      </select></label>
      <button type="button" data-today="import-all">${picked.length === data.items.length ? "Зняти всі" : "Вибрати всі"}</button>
      <button type="button" class="primary-button" data-today="import-accept" ${!picked.length || !today.importAssignee || today.importBusy ? "disabled" : ""}><i data-lucide="check"></i><span>${today.importBusy ? "Ставлю пінги…" : `Прийняти вибрані (${picked.length})`}</span></button>
    </div>
    <div class="table-wrap today-import-table"><table>
      <thead><tr><th></th><th>Хто</th><th>Останній дотик</th><th>Крок</th><th>Дата</th><th>Чому</th></tr></thead>
      <tbody>${data.items.map((item) => {
        const last = item.timeline.at(-1);
        return `<tr>
          <td><input type="checkbox" data-today-import="pick" data-id="${escapeAttr(item.contactId)}" ${today.importPick.has(item.contactId) ? "checked" : ""} aria-label="Вибрати"></td>
          <td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml([item.position, item.company].filter(Boolean).join(" · "))}</span><span class="pill tone-muted">${escapeHtml(item.status)}</span></td>
          <td><span>${escapeHtml(item.lastBy === "them" ? "Лід" : "Ми")} · ${escapeHtml(item.lastAt ? new Date(item.lastAt).toLocaleDateString("uk-UA") : "")}</span><span class="today-import-snippet">${escapeHtml(String(last?.text || "").replace(/^LinkedIn · [^\n]*\n/, "").slice(0, 160))}</span></td>
          <td><select data-today-import="reason" data-id="${escapeAttr(item.contactId)}">${Object.entries(STEP).map(([value, label]) => `<option value="${value}"${importValue(item, "reason") === value ? " selected" : ""}>${label}</option>`).join("")}</select></td>
          <td><input type="date" data-today-import="due" data-id="${escapeAttr(item.contactId)}" value="${escapeAttr(importValue(item, "due"))}"></td>
          <td><span>${escapeHtml(item.why || "")}</span><span class="today-hint">${item.by === "ai" ? "AI" : "правило"} · пріоритет ${escapeHtml(PRIORITY_LABEL[item.priority] || item.priority)}</span></td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>` : ""}`;
}

async function acceptImports() {
  const data = today.imports;
  const items = data.items.filter((item) => today.importPick.has(item.contactId)).map((item) => ({
    contactId: item.contactId, reason: importValue(item, "reason"), due: importValue(item, "due"), why: item.why, priority: item.priority
  }));
  today.importBusy = true;
  render();
  try {
    const result = await api("/api/today/open-dialogs/accept", { method: "POST", body: JSON.stringify({ items, assignee: today.importAssignee }) });
    say(`Пінги поставлено: ${result.created}${result.skipped ? `, пропущено (уже мали пінг): ${result.skipped}` : ""}.`);
    today.importEdits.clear();
    await loadImports();
    await openToday({ keepSelection: true });
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося поставити пінги.", "is-error");
  } finally {
    today.importBusy = false;
    render();
  }
}

/* ── малювання ──────────────────────────────────────────────────────────── */

// Розвантаження (аудит 16.10, D1): лідген під кожним пінгом — лише коли в списку їх кілька, і коротко.
const shortName = (email) => String(email || "").split("@")[0];
function mixedAssignees() {
  return new Set(allItems().map((item) => item.assignee).filter(Boolean)).size > 1;
}

/** Рядок черги — той самий, що в «Усіх розмовах» (warmup-thread): ім'я, дата, посада, прев'ю. */
function queueItem(item) {
  const mine = item.preview?.body && item.preview.direction !== "in";
  const preview = item.preview?.body || item.reasonTitle;
  const active = item.pingId === today.selected;
  return `<button type="button" class="warmup-thread today-item${item.block === "replies" ? " is-unread" : ""}${active ? " is-open active" : ""}" data-today="select" data-id="${escapeAttr(item.pingId)}"${active ? ' aria-current="true"' : ""}>
    <span class="warmup-thread-mark" aria-hidden="true"></span>
    <span class="warmup-thread-main">
      <span class="warmup-thread-top"><strong>${escapeHtml(item.name)}</strong><span class="today-due">${escapeHtml(dayLabel(item.dueDay, today.data.today))}</span></span>
      ${item.position || item.company ? `<span class="warmup-thread-headline">${escapeHtml([item.position, item.company].filter(Boolean).join(" · "))}</span>` : ""}
      <span class="warmup-thread-preview">${mine ? '<span class="warmup-thread-from">Ви:</span> ' : ""}${escapeHtml(String(preview).slice(0, 150))}</span>
      ${!today.account && item.accountName ? `<span class="warmup-thread-account">${escapeHtml(item.accountName)}${today.scope === "all" && item.assignee && mixedAssignees() ? ` · ${escapeHtml(shortName(item.assignee))}` : ""}</span>` : ""}
    </span>
  </button>`;
}

/** Акаунт і пошук (19.10, В1): що з черги лишається видно. */
function visible(items) {
  const terms = today.search.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => (!today.account || item.accountId === today.account)
    && terms.every((term) => [item.name, item.position, item.company, item.preview?.body, item.accountName].join(" ").toLowerCase().includes(term)));
}

/** Кнопки акаунтів — як в «Усіх розмовах»: «Усі акаунти» і кожен акаунт з кількістю пінгів. */
function accountChipsHtml() {
  const counts = new Map();
  for (const item of allItems()) if (item.accountId) counts.set(item.accountId, { name: item.accountName || "акаунт", count: (counts.get(item.accountId)?.count || 0) + 1 });
  if (counts.size < 2 && !today.account) return "";
  const chip = (id, name, count) => `<button class="inbox-chip${today.account === id ? " is-active" : ""}" type="button" data-today="account" data-account="${escapeAttr(id)}" aria-pressed="${today.account === id}"><span class="inbox-chip-name">${escapeHtml(name)}</span><span class="inbox-chip-count">${count}</span></button>`;
  return `<div class="inbox-accounts today-accounts">${chip("", "Усі акаунти", allItems().length)}${[...counts.entries()].sort((a, b) => b[1].count - a[1].count).map(([id, entry]) => chip(id, entry.name, entry.count)).join("")}</div>`;
}

function queueHtml() {
  const data = today.data;
  if (today.blockFilter === "silent") {
    const items = visible(silentItems());
    return items.length
      ? `<section class="today-block today-block-silent"><h3 title="${escapeAttr(FILTER_TEXT.silent[1])}">Без відповіді</h3>${items.map(queueItem).join("")}</section>`
      : `<p class="today-empty">Тих, хто мовчить після нашого повідомлення, зараз немає.</p>`;
  }
  const blocks = BLOCKS.map(([key, title, hint]) => {
    const items = visible(data.blocks[key] || []);
    if (!items.length || (today.blockFilter && today.blockFilter !== key)) return "";
    return `<section class="today-block today-block-${key}">
      <h3 title="${escapeAttr(hint)}">${escapeHtml(title)}${data.blocks && Object.values(data.blocks).filter((list) => list.length).length > 1 ? "" : ` <span class="today-count">${items.length}</span>`}</h3>
      ${items.map(queueItem).join("")}
    </section>`;
  }).join("");
  const later = data.later?.length && !today.blockFilter
    ? `<details class="today-later"><summary>Далі за планом <span class="today-count">${data.later.length}</span></summary>
        ${data.later.map((item) => `<div class="today-later-row"><span>${escapeHtml(item.name)}</span><span>${escapeHtml(item.reasonTitle)} · ${escapeHtml(dayLabel(item.dueDay, data.today))}</span></div>`).join("")}
      </details>`
    : "";
  if (blocks || later) return `${blocks}${later}`;
  if ((today.search.trim() || today.account) && allItems().length) return `<p class="today-empty">За цим пошуком чи акаунтом у черзі нікого. <button type="button" data-today="clear-filter">Показати всіх</button></p>`;
  // Адмін у «Мої» з порожнім списком — пінги команди лежать в «Усі» (аудит 16.10, P2).
  if (data.canSeeAll && today.scope === "mine") {
    return `<p class="today-empty">Ваших пінгів сьогодні немає. Пінги лідгенів — у «Усі». <button type="button" data-today="scope" data-scope="all">Показати пінги команди</button></p>`;
  }
  return `<p class="today-empty">Сьогодні все розібрано.</p>`;
}

/** Уся розмова тими самими бульбашками, що в «Усіх розмовах» (19.10, В1). */
function messagesHtml(messages, name, accountName) {
  if (!messages.length) return "";
  return `<ol class="warmup-messages today-thread">${messages.map((message) => warmupMessageHtml(message, name, accountName || "Ми")).join("")}</ol>`;
}

/* ── лід без кампанії (таск 207ffbc1, Марко 20.10, К1) ─────────────────────
   Лід, якого взяли прямо з LinkedIn повз базу, кампанії не має. Перед відповіддю його
   обов'язково відносять до кампанії (людина додається в папку CRM кампанії) — або
   позначають «Не лід». Кампанії на паузі теж у списку: людина в них уже віднесена. */

function needsCampaign(detail = today.detail) {
  return Boolean(detail && !detail.campaignAny && (detail.campaigns || []).length && detail.item?.contactId && !skipActive(detail.campaignSkippedUntil));
}

/* ── Кампанія: створити з картки або пропустити на 3 дні (Марко 22.10, таск a0c0820f) ── */

const skipActive = (until) => Boolean(until && Date.parse(until) > Date.now());
const skipDate = (until) => new Date(until).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });

/** Блок «Кампанія» без кампанії: обрати, створити, пропустити — і що з пропуском зараз. */
function campaignChoiceHtml({ campaigns, skippedUntil, attr, busy }) {
  const active = skipActive(skippedUntil);
  const note = active
    ? `<p class="today-side-text is-muted">Пропущено до ${escapeHtml(skipDate(skippedUntil))} — тоді нагадаю обрати.</p>`
    : skippedUntil ? `<p class="today-side-text today-side-remind">Нагадування: кампанію пропускали до ${escapeHtml(skipDate(skippedUntil))}. Оберіть, створіть або пропустіть ще раз.</p>` : "";
  const pick = campaigns.length ? `<select id="${attr === "side" ? "inboxSideCampaign" : "todayCampaignPick"}" aria-label="Кампанія" title="AI писатиме за продуктом і сценарієм кампанії, нагадування підуть за її кроками">
        <option value="">— обрати —</option>
        ${campaigns.map((entry) => `<option value="${escapeAttr(entry.id)}">${escapeHtml(entry.name || "без назви")}${entry.state === "paused" ? " (на паузі)" : ""}</option>`).join("")}
      </select>` : "";
  const act = (value) => (attr === "side" ? `data-side="${value}"` : `data-today="${value}"`);
  return `${note}${pick}
      <div class="today-side-row">
        ${campaigns.length ? `<button type="button" class="primary-button" ${act(attr === "side" ? "campaign" : "campaign-assign")} ${busy ? "disabled" : ""}>Віднести</button>` : ""}
        <button type="button" ${act("campaign-create")} title="Нова кампанія; після збереження — назад до цієї людини, її буде віднесено до кампанії"><i data-lucide="plus"></i><span>Створити</span></button>
      </div>
      <div class="today-side-row">
        ${active ? "" : `<button type="button" class="text-button" ${act("campaign-skip")} title="Відповісти без кампанії; через 3 дні картка знову попросить обрати">Пропустити на 3 дні</button>`}
        <button type="button" class="text-button" ${act("not-lead")} title="Знайомий, рекрутер, не наш ICP — статус «Не ICP», пінги закриються">Не лід</button>
      </div>`;
}

/** З картки «До роботи» у форму нової кампанії — і назад до цього ж пінга. */
function createCampaignFromWork() {
  const item = today.detail?.item;
  if (!item?.contactId) return;
  const pingId = item.pingId;
  createCampaignFor({
    name: item.name,
    contactId: item.contactId,
    back: (campaign) => {
      setInboxMode("work");
      today.selected = pingId;
      today.detail = null;
      if (campaign) say(campaign.assignError ? `Кампанію «${campaign.name}» створено, але: ${campaign.assignError}` : `${item.name}: тепер у новій кампанії «${campaign.name}».`, campaign.assignError ? "is-warn" : "");
      document.querySelector('.nav-item[data-view="inbox"]')?.click();
      void openToday({ keepSelection: true }).then(() => loadDetail(pingId)).then(() => { if (campaign && !campaign.assignError) void writeDraft(true); });
    }
  });
}

async function skipCampaignForWork() {
  const item = today.detail?.item;
  if (!item?.contactId) return;
  try {
    const { until } = await api("/api/lead-campaigns/skip", { method: "POST", body: JSON.stringify({ contactId: item.contactId }) });
    say(`${item.name}: кампанію пропущено до ${skipDate(until)} — можна відповідати.`);
    await loadDetail(item.pingId);
  } catch (error) {
    if (error?.name !== "AbortError") { say(error.message || "Не вдалося пропустити.", "is-error"); render(); }
  }
}

function canSend() {
  return !today.sending && Boolean(today.text.trim()) && !needsCampaign();
}

async function assignCampaign() {
  const item = today.detail?.item;
  const campaignId = document.getElementById("todayCampaignPick")?.value || "";
  if (!item?.contactId) return;
  if (!campaignId) { say("Оберіть кампанію зі списку.", "is-error"); return render(); }
  today.assigning = true;
  render();
  try {
    const { campaign } = await api("/api/lead-campaigns/assign", { method: "POST", body: JSON.stringify({ contactId: item.contactId, campaignId }) });
    // Кампанію людини сервер бачить після звірки; потім — чернетка під її продукт і сценарій.
    await api("/api/today/refresh", { method: "POST", body: "{}" }).catch(() => {});
    say(`${item.name}: тепер у кампанії «${campaign.name}». Чернетку переписую під неї.`);
    today.text = "";
    today.textFor = "";
    await loadDetail(item.pingId);
    void writeDraft(true);
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося віднести до кампанії.", "is-error");
  } finally {
    today.assigning = false;
    render();
  }
}

/** Що стоїть у черзі на відправку — як в «Усіх розмовах», зі «Скасувати». */
function pendingHtml(detail) {
  const waiting = (detail.pending || []).filter((entry) => entry.state === "waiting");
  if (!waiting.length) return "";
  const who = detail.item.accountName || "акаунт";
  return `<ol class="warmup-messages warmup-outbox">${waiting.map((entry) => `<li class="warmup-message is-out is-reply is-reply-waiting">
      <div class="warmup-message-head"><strong>${escapeHtml(who)}</strong><span class="warmup-reply-state">чекає відправки</span></div>
      <div class="warmup-message-body">${escapeHtml(entry.body || "")}</div>
      <p class="warmup-reply-note">Піде з акаунта ${escapeHtml(who)} у найближчу сесію. До того її можна скасувати.</p>
      <div class="warmup-reply-actions"><button class="text-button" type="button" data-today="cancel-reply" data-reply="${escapeAttr(entry.id)}"><i data-lucide="x"></i><span>Скасувати</span></button></div>
    </li>`).join("")}</ol>`;
}

function workHtml() {
  if (today.detailLoading && !today.detail) return `<p class="today-empty">Відкриваю…</p>`;
  if (today.detailError) return `<p class="today-empty is-error">${escapeHtml(today.detailError)}</p>`;
  const detail = today.detail;
  if (!detail) return `<p class="today-empty">Оберіть пінг ліворуч.</p>`;
  const item = detail.item;
  const kind = item.channel === "first" ? "first" : detail.messages.at(-1)?.direction === "in" ? "reply" : "follow-up";
  const canWrite = item.channel === "thread" || item.channel === "first";
  return `<div class="today-main">
    <div class="warmup-thread-head today-work-head">
      <div class="warmup-thread-head-who">
        <strong>${escapeHtml(item.name)}</strong>
        ${item.position || item.company ? `<span class="warmup-subtle">${escapeHtml([item.position, item.company].filter(Boolean).join(" · "))}</span>` : ""}
        ${item.channel === "thread" && item.threadKey ? `<button type="button" class="text-button today-to-thread" data-today="thread" title="Ця розмова в «Усіх розмовах»: ручна відповідь, уся історія"><i data-lucide="messages-square"></i><span>Уся розмова</span></button>` : ""}
      </div>
      <div class="warmup-thread-head-meta">
        <span class="warmup-identity" title="Акаунт LinkedIn, з якого йде розмова"><i data-lucide="badge-check"></i><span>${item.accountName ? `через ${escapeHtml(item.accountName)}` : "LinkedIn"}</span></span>
        ${item.campaign ? `<span class="warmup-subtle">${escapeHtml(item.campaign.name || "кампанія без назви")}</span>` : ""}
        ${item.assignee && today.scope === "all" && mixedAssignees() ? `<span class="warmup-subtle">${escapeHtml(shortName(item.assignee))}</span>` : ""}
        <span class="pill today-reason today-reason-${escapeAttr(item.block)}">${escapeHtml(item.reasonTitle)} · ${escapeHtml(dayLabel(item.dueDay, today.data?.today))}</span>
      </div>
    </div>
    ${item.reassigned ? `<p class="today-note today-note-moved">Перепризначено з ${escapeHtml(item.reassigned.from)} на ${escapeHtml(item.reassigned.to)} (${escapeHtml(new Date(item.reassigned.at).toLocaleDateString("uk-UA"))}): старий акаунт заблоковано${item.channel === "moved" ? `; запит у друзі піде з ${escapeHtml(item.reassigned.to)}, і коли прийме — тут буде «Перше повідомлення»` : ""}.</p>` : ""}
    ${item.channel === "first" ? `<p class="today-note">Прийняв запит${detail.acceptedAt ? ` ${escapeHtml(new Date(detail.acceptedAt).toLocaleDateString("uk-UA"))}` : ""} — розмови ще немає, це перше повідомлення.</p>` : ""}
    ${messagesHtml(detail.messages, item.name, item.accountName)}
    ${pendingHtml(detail)}
    ${today.notice ? `<p class="today-notice ${today.tone}" role="status">${escapeHtml(today.notice)}</p>` : ""}
    ${canWrite ? `
      <div class="today-draft">
        <div class="today-draft-head">
          <span>${DRAFT_LABEL[kind]} — AI написав, можна правити</span>
          <span class="today-draft-tools">
            <button type="button" data-today="rewrite" ${today.draftLoading ? "disabled" : ""} title="Попросити AI написати інакше"><i data-lucide="refresh-cw"></i><span>${today.draftLoading ? "Пишу…" : "Переписати AI"}</span></button>
            <button type="button" data-today="own-text" ${today.text ? "" : "disabled"} title="Стерти чернетку й написати свій текст"><i data-lucide="eraser"></i><span>Напишу сам</span></button>
          </span>
        </div>
        ${today.draftNote ? `<p class="today-draft-note">${escapeHtml(today.draftNote)}</p>` : ""}
        ${needsCampaign(detail) ? `<p class="today-draft-note">Спершу оберіть, створіть або пропустіть кампанію праворуч — без цього надіслати не можна.</p>` : ""}
        <textarea id="todayText" rows="6" placeholder="${today.draftLoading ? "Модель пише чернетку…" : "Текст повідомлення"}">${escapeHtml(today.text)}</textarea>
        <div class="today-actions">
          <button type="button" class="primary-button" data-today="send" title="Піде з цього акаунта в найближчу сесію. Наступний пінг — через 3 робочі дні." ${canSend() ? "" : "disabled"}><i data-lucide="send"></i><span>${today.sending ? "Ставлю в чергу…" : "Погодити й надіслати"}</span></button>
        </div>
      </div>` : item.channel === "moved" ? "" : `<p class="today-note">Переписки з цим контактом тут немає — відкрийте його в CRM або перенесіть пінг.</p>`}
    </div>
    ${sideHtml(item, detail)}`;
}

/* ── колонка дій (Марко 22.10, таск 4c945837: «так виглядає більш компактно») ──────────
   Статус у CRM, наступний пінг, кампанія, посилання — праворуч від розмови, завжди на виду:
   Богдан не бачив статусу й перенесення під полем відповіді і йшов ставити їх у CRM. */

function sideBox(title, body) {
  return body ? `<section class="today-side-box"><h4>${escapeHtml(title)}</h4>${body}</section>` : "";
}

function sideHtml(item, detail) {
  const linkedin = warmupProfileUrl(detail.participant?.slug);
  const campaignName = item.campaign?.name || detail.campaignAny?.name || "";
  const campaign = campaignName
    ? `<p class="today-side-text">${escapeHtml(campaignName)}</p>`
    : campaignChoiceHtml({ campaigns: detail.campaigns || [], skippedUntil: detail.campaignSkippedUntil, attr: "today", busy: today.assigning });
  const ping = item.pingId ? `
      <div class="today-side-row">
        <button type="button" data-today="move" data-when="+1" title="На завтра (робочий день)">+1</button>
        <button type="button" data-today="move" data-when="+3" title="Через 3 робочі дні">+3</button>
        <button type="button" data-today="move" data-when="+7" title="Через тиждень">+7</button>
        <input type="date" id="todayMoveDate" aria-label="Перенести на дату" title="Вибір дати одразу переносить пінг" min="${escapeAttr(today.data?.today || "")}" />
      </div>
      <button type="button" class="today-side-wide ${today.callMode ? "active" : ""}" data-today="call" aria-pressed="${Boolean(today.callMode)}" title="Дзвінок: натисніть і оберіть дату"><i data-lucide="phone"></i><span>${today.callMode ? "Дзвінок — оберіть дату" : "Дзвінок"}</span></button>
      ${item.contactId ? `<button type="button" class="today-side-wide today-later-button" data-today="bad-timing" title="Статус «Невдалий час»: пінги закриються, через місяць прийде пінг «Повернутись»">Невдалий час · через місяць</button>` : ""}` : "";
  const links = [
    linkedin ? `<a href="${escapeAttr(linkedin)}" target="_blank" rel="noreferrer noopener">LinkedIn <i data-lucide="arrow-up-right"></i></a>` : "",
    item.crmUrl ? `<a href="${escapeAttr(item.crmUrl)}" target="_blank" rel="noreferrer noopener" title="Контакт у CRM — нова вкладка">CRM <i data-lucide="arrow-up-right"></i></a>` : "",
    item.contactId ? `<button type="button" class="text-button" data-today="contact" title="Картка людини в «Контактах» порталу">Картка контакту</button>` : ""
  ].filter(Boolean).join("");
  return `<aside class="today-side" aria-label="Дії з лідом">
    ${sideBox("Статус у CRM", statusHtml(item))}
    ${sideBox("Наступний пінг", ping)}
    ${sideBox("Кампанія", item.contactId ? campaign : "")}
    ${sideBox("Посилання", links ? `<div class="today-side-links">${links}</div>` : "")}
  </aside>`;
}

/** Статус і причина виходу — ті самі, що в CRM, і записуються в CRM (етап 5/6). */
function statusHtml(item) {
  const data = today.data;
  if (!data?.statuses || !item.contactId) return "";
  const current = today.statusDraft?.pingId === item.pingId ? today.statusDraft : { status: item.status || "new", exitReason: item.exitReason || "" };
  const closing = (data.closing || []).includes(current.status);
  return `<div class="today-status">
    <label title="Зберігається в CRM одразу при виборі"><select data-today-status="status" aria-label="Статус у CRM">${data.statuses.map(([key, label]) => `<option value="${escapeAttr(key)}"${key === current.status ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
    ${closing ? `<label><span>Причина виходу</span><select data-today-status="exit"><option value="">— оберіть —</option>${data.exitReasons.map(([key, label]) => `<option value="${escapeAttr(key)}"${key === current.exitReason ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>` : ""}
    ${today.statusSaving ? `<span class="today-hint">Зберігаю в CRM…</span>` : closing && !current.exitReason ? `<span class="today-hint">Оберіть причину — статус збережеться одразу, пінги контакту закриються.</span>` : closing ? `<span class="today-hint">Вихід із воронки — пінги цього контакту закриються.</span>` : current.status === "booked_call" ? `<span class="today-hint">«Дзвінок» — у CRM з'явиться угода, якщо її ще немає.</span>` : ""}
  </div>`;
}

async function saveStatus() {
  const item = today.detail?.item;
  const draft = today.statusDraft;
  if (!item || !draft || today.statusSaving) return;
  today.statusSaving = true;
  render();
  try {
    const result = await api("/api/today/status", { method: "POST", body: JSON.stringify({ contactId: item.contactId, status: draft.status, exitReason: draft.exitReason }) });
    const label = today.data.statuses.find(([key]) => key === result.status)?.[1] || result.status;
    today.statusDraft = null;
    const name = item.name;
    await openToday({ keepSelection: true });
    say(`${name}: статус «${label}» у CRM${result.closedPings ? `, пінгів закрито: ${result.closedPings}` : ""}${result.dealId ? ", угоду створено" : ""}.`);
  } catch (error) {
    if (error?.name !== "AbortError") say(error.message || "Не вдалося змінити статус.", "is-error");
  } finally {
    today.statusSaving = false;
  }
  render();
}

function render() {
  renderModeCounts();
  const host = root();
  if (!host) return;
  if (today.loading && !today.data) {
    host.innerHTML = `<section class="panel blk-queue today"><p class="today-empty">Збираю пінги…</p></section>`;
    return;
  }
  if (today.error && !today.data) {
    host.innerHTML = `<section class="panel blk-queue today"><p class="today-empty is-error">${escapeHtml(today.error)} <button type="button" data-today="reload">Спробувати ще раз</button></p></section>`;
    return;
  }
  const data = today.data;
  if (!data || data.configured === false) {
    host.innerHTML = "";
    return;
  }
  const counts = BLOCKS.map(([key, title]) => [key, title, (data.blocks[key] || []).length]).filter(([, , count]) => count);
  if (today.blockFilter && today.blockFilter !== "silent" && !counts.some(([key]) => key === today.blockFilter)) today.blockFilter = "";
  const threads = inboxMode === "all";
  // Лічильники — це й фільтри: клік показує лише цей блок (аудит 16.10, P2). Останній —
  // «Усі розмови»: усі переписки акаунтів, і ті, де пінга немає (Марко 20.10).
  const unread = document.getElementById("warmupNavBadge");
  const unreadCount = unread && !unread.hidden ? unread.textContent : "";
  // «Усі розмови» — скільки їх усього (Марко 20.10: «чому всіх розмов менше ніж в до роботи?»
  // — бо раніше тут стояло число непрочитаних, а не розмов).
  const totalThreads = warmupThreadTotal();
  const chips = filterHtml(counts, threads, totalThreads, unreadCount);
  const restoreScroll = keepScroll(host, [".today-queue", ".today-thread"]);
  host.innerHTML = `
    <section class="panel blk-queue today">
      <header class="today-head">
        <div>
          ${chips}
        </div>
        <div class="today-head-actions">
          ${data.canSeeAll && !threads ? `<div class="today-scope" role="group" aria-label="Чиї пінги">
            <button type="button" data-today="scope" data-scope="mine" class="${today.scope === "mine" ? "active" : ""}">Мої</button>
            <button type="button" data-today="scope" data-scope="all" class="${today.scope === "all" ? "active" : ""}">Усі</button>
          </div>` : ""}
          ${data.canSeeAll ? `<button type="button" class="icon-button ${today.stepsOpen ? "active" : ""}" data-today="steps-toggle" title="Коли нагадувати тим, хто мовчить" aria-label="Коли нагадувати тим, хто мовчить" aria-expanded="${today.stepsOpen}"><i data-lucide="alarm-clock"></i></button>` : ""}
          ${data.canSeeAll ? (today.importOpen
            ? `<button type="button" data-today="import-toggle">До пінгів</button>`
            : `<button type="button" class="icon-button" data-today="import-toggle" title="Відкриті діалоги з 01.08 — підтягнути в пінги" aria-label="Відкриті діалоги з 01.08"><i data-lucide="history"></i></button>`) : ""}
          <button type="button" class="icon-button" data-today="reload" title="Оновити" aria-label="Оновити"><i data-lucide="refresh-cw"></i></button>
        </div>
      </header>
      ${today.helpOpen ? helpHtml() : ""}
      ${today.stepsOpen ? stepsHtml() : ""}
      ${threads ? "" : `${today.importOpen || !allItems().length ? "" : `<div class="today-toolbar">
        ${accountChipsHtml()}
        <label class="warmup-inbox-search today-search"><i data-lucide="search"></i><input id="todaySearch" type="search" autocomplete="off" aria-label="Пошук у черзі" placeholder="Ім'я, компанія або слово з повідомлення" value="${escapeAttr(today.search)}" /></label>
      </div>`}
      ${today.importOpen ? `${today.notice ? `<p class="today-notice ${today.tone}" role="status">${escapeHtml(today.notice)}</p>` : ""}<div class="today-import">${importHtml()}</div>` : allItems().length ? `<div class="today-layout">
        <aside class="today-queue">${queueHtml()}</aside>
        <article class="today-work">${workHtml()}</article>
      </div>` : `${today.notice ? `<p class="today-notice ${today.tone}" role="status">${escapeHtml(today.notice)}</p>` : ""}<div class="today-queue today-queue-solo">${queueHtml()}</div>`}
`}
    </section>`;
  restoreScroll();
  refreshIcons(host);
}

/** Один список фільтрів: кнопка з назвою й числом, під нею — «Щодня» і «Перевіряти». */
function filterHtml(counts, threads, totalThreads, unreadCount) {
  const total = counts.reduce((sum, [, , count]) => sum + count, 0);
  const silent = silentItems().length;
  const key = threads ? "threads" : today.blockFilter;
  const label = { "": "До роботи", silent: "Без відповіді", threads: "Усі розмови" }[key] ?? BLOCKS.find(([block]) => block === key)?.[1] ?? "До роботи";
  const count = { "": total, silent, threads: totalThreads }[key] ?? counts.find(([block]) => block === key)?.[2];
  const item = (value, title, number, act = "block") => `<button type="button" role="menuitemradio" aria-checked="${key === value}" class="today-filter-item${key === value ? " is-on" : ""}${["replies", "overdue"].includes(value) && number ? " is-hot" : ""}" data-today="${act}" data-block="${escapeAttr(value)}" title="${escapeAttr(FILTER_TEXT[value][1])}">
      <span>${escapeHtml(title)}</span><b>${number ?? ""}</b><small>${escapeHtml(FILTER_TEXT[value][0])}</small>
    </button>`;
  return `<div class="today-filter">
    <button type="button" class="today-filter-button" data-today="filter-toggle" aria-haspopup="menu" aria-expanded="${today.filterOpen}" title="${escapeAttr(FILTER_TEXT[key]?.[1] || "")}">
      <span>${escapeHtml(label)}</span>${count != null ? `<b>${count}</b>` : ""}<i data-lucide="chevron-down"></i>
    </button>
    <button type="button" class="today-help-button${today.helpOpen ? " active" : ""}" data-today="help-toggle" aria-expanded="${today.helpOpen}" title="Як працювати з фільтрами" aria-label="Як працювати з фільтрами">?</button>
    ${today.filterOpen ? `<div class="today-filter-menu" role="menu" aria-label="Що показати">
      <p class="today-filter-group">Щодня — по черзі</p>
      ${item("", "До роботи", total)}
      ${counts.map(([block, title, number]) => item(block, title, number)).join("")}
      <p class="today-filter-group">Перевіряти час від часу</p>
      ${item("silent", "Без відповіді", silent)}
      ${item("threads", "Усі розмови", totalThreads, "threads")}
      ${unreadCount ? `<p class="today-filter-foot">Непрочитаних у розмовах: ${escapeHtml(unreadCount)}</p>` : ""}
    </div>` : ""}
  </div>`;
}

/** «?» — коротко, де працювати щодня, а що лише перевіряти (Марко 22.10: «лідгенам потрібне пояснення»). */
function helpHtml() {
  const rows = [["До роботи", ""], ["Відповіді", "replies"], ["Прострочені", "overdue"], ["На сьогодні", "today"], ["Перші повідомлення", "first"], ["Без відповіді", "silent"], ["Усі розмови", "threads"]];
  return `<section class="today-help" aria-label="Як працювати з фільтрами">
    <p><b>Порядок дня:</b> Відповіді → Прострочені → На сьогодні → Перші повідомлення. «Без відповіді» й «Усі розмови» — перевіряти час від часу.</p>
    <dl>${rows.map(([title, key]) => `<dt>${escapeHtml(title)}</dt><dd>${escapeHtml(FILTER_TEXT[key][1])}</dd>`).join("")}</dl>
    <p>Праворуч від розмови — дії з лідом: статус у CRM, наступний пінг (+1 і +3 — робочі дні, +7 — тиждень, дата, дзвінок), «Невдалий час» — пінг «Повернутись» через місяць, і кампанія. У CRM для цього заходити не треба.</p>
  </section>`;
}

/* ── дії ─────────────────────────────────────────────────────────────────── */

document.addEventListener("input", (event) => {
  if (event.target?.dataset?.todayStep !== undefined && event.target.closest?.("#todayRoot")) {
    today.stepsDraft[Number(event.target.dataset.todayStep)] = event.target.value;
    today.stepsNote = "";
    return;
  }
  if (event.target?.id === "todaySearch") {
    today.search = event.target.value;
    // Лише список: поле пошуку не перемальовується, курсор лишається на місці.
    const queue = document.querySelector("#todayRoot .today-queue");
    if (queue) { queue.innerHTML = queueHtml(); refreshIcons(queue); }
    return;
  }
  if (event.target?.id === "todayText") {
    today.text = event.target.value;
    const sendButton = document.querySelector('#todayRoot [data-today="send"]');
    if (sendButton) sendButton.disabled = !canSend();
  }
});

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("#todayRoot [data-today]");
  if (!target) return;
  const act = target.dataset.today;
  if (act === "reload") {
    if (inboxMode === "all") document.getElementById("warmupInboxRefreshBtn")?.click();
    return void openToday({ keepSelection: true });
  }
  if (act === "account") {
    today.account = target.dataset.account || "";
    return render();
  }
  if (act === "clear-filter") {
    today.account = "";
    today.search = "";
    return render();
  }
  if (act === "contact") {
    const contactId = today.detail?.item?.contactId;
    return void (contactId && showContactCard(contactId));
  }
  if (act === "cancel-reply") return void cancelReply(target.dataset.reply);
  if (act === "filter-toggle") {
    today.filterOpen = !today.filterOpen;
    return render();
  }
  if (act === "help-toggle") {
    today.helpOpen = !today.helpOpen;
    today.filterOpen = false;
    return render();
  }
  if (act === "bad-timing") {
    const item = today.detail?.item;
    if (!item?.contactId) return;
    today.statusDraft = { pingId: item.pingId, status: "bad_timing", exitReason: today.data?.defaultExit?.bad_timing || "not_now" };
    return void saveStatus();
  }
  if (act === "block") {
    today.filterOpen = false;
    today.blockFilter = target.dataset.block || "";
    if (inboxMode !== "work") { setInboxMode("work"); return void applyInboxMode(); }
    return render();
  }
  if (act === "threads") {
    today.filterOpen = false;
    if (inboxMode === "all") return render();
    return switchInboxMode("all");
  }
  if (act === "scope") {
    today.scope = target.dataset.scope === "all" ? "all" : "mine";
    try { window.localStorage.setItem(SCOPE_KEY, today.scope); } catch {}
    return void openToday();
  }
  if (act === "select") {
    if (today.text.trim() && today.textFor && today.textFor !== target.dataset.id && today.text !== (today.detail?.draft?.text || "")
      && !window.confirm("Текст ще не надіслано. Перейти до іншого ліда?")) return;
    today.selected = target.dataset.id;
    today.callMode = false;
    today.detail = null;
    today.text = "";
    today.textFor = "";
    today.draftNote = "";
    say("");
    render();
    // На вузькому екрані робоче місце під чергою — показуємо його, а не лишаємо внизу.
    if (window.matchMedia("(max-width: 900px)").matches) document.querySelector("#todayRoot .today-work")?.scrollIntoView({ block: "start" });
    return void loadDetail(today.selected);
  }
  if (act === "steps-toggle") {
    today.stepsOpen = !today.stepsOpen;
    today.stepsNote = "";
    render();
    if (today.stepsOpen) void loadSteps();
    return;
  }
  if (act === "step-add") {
    if (today.stepsDraft.length < 6) today.stepsDraft.push(today.stepsDraft.at(-1) || 3);
    return render();
  }
  if (act === "step-remove") {
    today.stepsDraft.splice(Number(target.dataset.index), 1);
    return render();
  }
  if (act === "import-toggle") {
    today.importOpen = !today.importOpen;
    say("");
    render();
    if (today.importOpen) void loadImports();
    return;
  }
  if (act === "import-ai") {
    return void api("/api/today/open-dialogs/suggest", { method: "POST", body: "{}" })
      .then(() => loadImports())
      .catch((error) => { say(error.message || "AI зараз недоступний.", "is-warn"); render(); });
  }
  if (act === "import-all") {
    const all = today.imports?.items || [];
    const everyPicked = all.every((item) => today.importPick.has(item.contactId));
    for (const item of all) {
      if (everyPicked) { today.importPick.delete(item.contactId); today.importPick.add(`x:${item.contactId}`); }
      else { today.importPick.add(item.contactId); today.importPick.delete(`x:${item.contactId}`); }
    }
    return render();
  }
  if (act === "import-accept") return void acceptImports();
  if (act === "thread") {
    const item = today.detail?.item;
    if (!item?.threadKey) return;
    return void showWarmupInboxThread(item.accountId, item.threadKey);
  }
  if (act === "rewrite") return void writeDraft(true);
  if (act === "campaign-assign") return void assignCampaign();
  if (act === "campaign-create") return createCampaignFromWork();
  if (act === "campaign-skip") return void skipCampaignForWork();
  if (act === "not-lead") {
    const item = today.detail?.item;
    if (!item) return;
    today.statusDraft = { pingId: item.pingId, status: "not_icp", exitReason: today.data?.defaultExit?.not_icp || "not_icp" };
    return void saveStatus();
  }
  // Свій текст замість чернетки (Марко 20.10: «як взяти згенеровану відповідь, так і написати свою»).
  if (act === "own-text") {
    today.text = "";
    today.draftNote = "";
    render();
    return void document.getElementById("todayText")?.focus();
  }
  if (act === "send") return void send();
  if (act === "move") return void movePing(target.dataset.when);
  if (act === "call") {
    // «Дзвінок» вмикає режим: наступний вибір дати ставить дзвінок, а не просто переносить пінг.
    today.callMode = !today.callMode;
    render();
    const input = document.getElementById("todayMoveDate");
    input?.focus();
    try { if (today.callMode) input?.showPicker?.(); } catch {}
    return;
  }
});

// Список фільтрів закривається кліком повз нього й клавішею Escape.
document.addEventListener("click", (event) => {
  if (!today.filterOpen || event.target.closest?.(".today-filter")) return;
  today.filterOpen = false;
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !today.filterOpen) return;
  today.filterOpen = false;
  render();
});

// D5: вибір дати сам переносить пінг — без окремої кнопки «На дату».
document.addEventListener("change", (event) => {
  if (event.target?.id !== "todayMoveDate" || !event.target.value) return;
  // З клавіатури браузер шле change на кожній цифрі року (0002-10-19): переносимо лише
  // повну дату від сьогодні до року вперед; вибір у календарі — як і був, в один крок.
  const value = event.target.value;
  const first = today.data?.today || "";
  const year = Number(value.slice(0, 4));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || (first && value < first) || year > Number(first.slice(0, 4) || year) + 1) return;
  const call = Boolean(today.callMode);
  today.callMode = false;
  void movePing(event.target.value, call);
});

document.addEventListener("change", (event) => {
  const field = event.target.closest?.("#todayRoot [data-today-import]");
  if (!field) return;
  const kind = field.dataset.todayImport;
  const id = field.dataset.id;
  if (kind === "assignee") today.importAssignee = field.value;
  if (kind === "pick") {
    if (field.checked) { today.importPick.add(id); today.importPick.delete(`x:${id}`); }
    else { today.importPick.delete(id); today.importPick.add(`x:${id}`); }
  }
  if (kind === "reason" || kind === "due") today.importEdits.set(id, { ...(today.importEdits.get(id) || {}), [kind]: field.value });
  render();
});

document.addEventListener("change", (event) => {
  const field = event.target.closest?.("#todayRoot [data-today-status]");
  const item = today.detail?.item;
  if (!field || !item) return;
  const base = today.statusDraft?.pingId === item.pingId ? today.statusDraft : { pingId: item.pingId, status: item.status || "new", exitReason: item.exitReason || "" };
  const draft = { ...base, [field.dataset.todayStatus === "exit" ? "exitReason" : "status"]: field.value };
  // Закриваючий статус без причини бере причину за замовчуванням (Не ICP → не ICP, Без відповіді → не відповідає).
  if (field.dataset.todayStatus === "status") draft.exitReason = (today.data?.closing || []).includes(draft.status) ? (today.data?.defaultExit?.[draft.status] || "") : "";
  today.statusDraft = draft;
  // Зберігається одразу при виборі (аудит 16.10, P2): окремої кнопки «Зберегти статус» більше немає.
  // Закриваючий статус — коли є причина виходу.
  const closing = (today.data?.closing || []).includes(draft.status);
  const changed = draft.status !== (item.status || "new") || (draft.exitReason || "") !== (item.exitReason || "");
  if (changed && (!closing || draft.exitReason)) return void saveStatus();
  render();
});

document.addEventListener("submit", (event) => {
  if (!event.target?.matches?.("#todayRoot [data-today-steps]")) return;
  event.preventDefault();
  void saveSteps();
});

/* ── Колонка дій у «Усіх розмовах» (Марко 22.10, таск 4c945837) ──────────────────────────
   Та сама, що в картці «До роботи»: статус у CRM, наступний пінг, кампанія, посилання. Пінга
   в розмови може й не бути — тоді «+1 / +3 / +7 / дата» ставлять новий (/api/today/ping за контактом). */

const side = { key: "", contactId: "", thread: null, data: null, loading: false, error: "", saving: false, callMode: false, notice: "", pendingStatus: "", carry: "" };
const sideRoot = () => document.getElementById("warmupInboxSide");

async function openThreadSide(open) {
  const host = sideRoot();
  if (!host) return;
  const key = open ? `${open.accountId}|${open.threadKey}` : "";
  if (key === side.key && open) return;
  Object.assign(side, { key, thread: open?.thread || null, contactId: open?.thread?.crmContactId ? String(open.thread.crmContactId) : "", data: null, error: "", notice: side.carry || "", carry: "", callMode: false, pendingStatus: "" });
  host.hidden = !open;
  document.getElementById("warmupInboxLayout")?.classList.toggle("has-side", Boolean(open));
  if (!open) return;
  await loadThreadSide();
}

async function loadThreadSide() {
  if (!side.contactId) return renderThreadSide();
  side.loading = true;
  renderThreadSide();
  const asked = side.key;
  try {
    const data = await api(`/api/today/contact?contactId=${encodeURIComponent(side.contactId)}`);
    if (asked === side.key) { side.data = data; side.error = ""; }
  } catch (error) {
    if (asked === side.key && error?.name !== "AbortError") side.error = error.message || "Не вдалося прочитати контакт у CRM.";
  }
  side.loading = false;
  renderThreadSide();
}

function renderThreadSide() {
  const host = sideRoot();
  if (!host || !side.key) return;
  const linkedin = warmupProfileUrl(side.thread?.participant?.slug);
  const linkedinLink = linkedin ? `<a href="${escapeAttr(linkedin)}" target="_blank" rel="noreferrer noopener">LinkedIn <i data-lucide="arrow-up-right"></i></a>` : "";
  if (!side.contactId) {
    host.innerHTML = `${sideBox("У CRM", `<p class="today-side-text is-muted">Цієї людини ще немає в CRM — статус і пінг з'являться, щойно її додадуть (сама додається, коли напише).</p>`)}${sideBox("Посилання", linkedinLink ? `<div class="today-side-links">${linkedinLink}</div>` : "")}`;
    return refreshIcons(host);
  }
  if (side.loading && !side.data) { host.innerHTML = sideBox("Дії з лідом", `<p class="today-side-text is-muted">Читаю CRM…</p>`); return; }
  if (side.error && !side.data) { host.innerHTML = sideBox("Дії з лідом", `<p class="today-side-text is-muted">${escapeHtml(side.error)}</p>`); return; }
  const data = side.data;
  const statuses = today.data?.statuses || [];
  const shownStatus = side.pendingStatus || data.status;
  const status = statuses.length ? `<select data-side-status aria-label="Статус у CRM" title="Зберігається в CRM одразу при виборі" ${side.saving ? "disabled" : ""}>${statuses.map(([key, label]) => `<option value="${escapeAttr(key)}"${key === shownStatus ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>
      ${side.pendingStatus ? `<select data-side-exit aria-label="Причина виходу"><option value="">— причина виходу —</option>${(today.data?.exitReasons || []).map(([key, label]) => `<option value="${escapeAttr(key)}">${escapeHtml(label)}</option>`).join("")}</select>
      <span class="today-hint">Оберіть причину — статус збережеться, пінги контакту закриються.</span>` : ""}` : `<p class="today-side-text">${escapeHtml(data.status)}</p>`;
  const due = data.ping?.dueDay ? `<p class="today-side-text is-muted">Зараз: ${escapeHtml(data.ping.title || "пінг")} · ${escapeHtml(dayLabel(data.ping.dueDay, today.data?.today || data.ping.dueDay))}</p>` : `<p class="today-side-text is-muted">Пінга немає — кнопка поставить новий.</p>`;
  const ping = `${due}
      <div class="today-side-row">
        <button type="button" data-side-when="+1" title="На завтра (робочий день)">+1</button>
        <button type="button" data-side-when="+3" title="Через 3 робочі дні">+3</button>
        <button type="button" data-side-when="+7" title="Через тиждень">+7</button>
        <input type="date" id="inboxSideDate" aria-label="Пінг на дату" title="Вибір дати одразу ставить пінг" min="${escapeAttr(today.data?.today || "")}" />
      </div>
      <button type="button" class="today-side-wide ${side.callMode ? "active" : ""}" data-side="call" aria-pressed="${side.callMode}" title="Дзвінок: натисніть і оберіть дату"><i data-lucide="phone"></i><span>${side.callMode ? "Дзвінок — оберіть дату" : "Дзвінок"}</span></button>
      <button type="button" class="today-side-wide today-later-button" data-side="bad-timing" title="Статус «Невдалий час»: пінги закриються, через місяць прийде пінг «Повернутись»">Невдалий час · через місяць</button>`;
  const campaign = data.campaignAny
    ? `<p class="today-side-text">${escapeHtml(data.campaignAny.name || "кампанія без назви")}</p>`
    : campaignChoiceHtml({ campaigns: data.campaigns || [], skippedUntil: data.campaignSkippedUntil, attr: "side", busy: side.saving });
  const links = [linkedinLink, `<a href="${escapeAttr(data.crmUrl)}" target="_blank" rel="noreferrer noopener" title="Контакт у CRM — нова вкладка">CRM <i data-lucide="arrow-up-right"></i></a>`,
    `<button type="button" class="text-button" data-side="card" title="Картка людини в «Контактах» порталу">Картка контакту</button>`].filter(Boolean).join("");
  host.innerHTML = `${side.notice ? `<p class="today-notice" role="status">${escapeHtml(side.notice)}</p>` : ""}
    ${sideBox("Статус у CRM", status)}
    ${sideBox("Наступний пінг", ping)}
    ${sideBox("Кампанія", campaign)}
    ${sideBox("Посилання", `<div class="today-side-links">${links}</div>`)}`;
  refreshIcons(host);
}

async function sideAction(label, work) {
  if (side.saving) return;
  side.saving = true;
  side.notice = "";
  renderThreadSide();
  try {
    side.notice = await work();
    // Пінги й черга «До роботи» — з тих самих даних: перечитати.
    void openToday({ keepSelection: true });
  } catch (error) {
    if (error?.name !== "AbortError") side.notice = error.message || `Не вдалося: ${label}.`;
  } finally {
    side.saving = false;
  }
  await loadThreadSide();
}

/** Закриваючий статус без причини за замовчуванням («Не актуально») спершу питає причину. */
function pickSideStatus(status) {
  const closing = (today.data?.closing || []).includes(status);
  if (closing && !today.data?.defaultExit?.[status]) { side.pendingStatus = status; return renderThreadSide(); }
  side.pendingStatus = "";
  return void sideStatus(status);
}

const sideStatus = (status, chosenExit = "") => sideAction("змінити статус", async () => {
  side.pendingStatus = "";
  const exitReason = chosenExit || ((today.data?.closing || []).includes(status) ? (today.data?.defaultExit?.[status] || "") : "");
  const result = await api("/api/today/status", { method: "POST", body: JSON.stringify({ contactId: side.contactId, status, exitReason }) });
  const label = (today.data?.statuses || []).find(([key]) => key === result.status)?.[1] || result.status;
  return `Статус «${label}» у CRM${result.closedPings ? `, пінгів закрито: ${result.closedPings}` : ""}.`;
});

const sidePing = (when, call = false) => sideAction("поставити пінг", async () => {
  const result = await api("/api/today/ping", { method: "POST", body: JSON.stringify({ pingId: side.data?.ping?.mine ? side.data.ping.pingId : "", contactId: side.contactId, when, call }) });
  return `${call ? "Дзвінок" : "Пінг"} на ${dayLabel(result.dueDay, today.data?.today || result.dueDay)}.`;
});

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("#warmupInboxSide [data-side], #warmupInboxSide [data-side-when]");
  if (!target) return;
  if (target.dataset.sideWhen) return void sidePing(target.dataset.sideWhen);
  const act = target.dataset.side;
  if (act === "card") return void (side.contactId && showContactCard(side.contactId));
  if (act === "bad-timing") return void sideStatus("bad_timing");
  if (act === "not-lead") return void sideStatus("not_icp");
  if (act === "call") {
    side.callMode = !side.callMode;
    renderThreadSide();
    const input = document.getElementById("inboxSideDate");
    input?.focus();
    try { if (side.callMode) input?.showPicker?.(); } catch {}
    return;
  }
  if (act === "campaign-skip") {
    return void sideAction("пропустити кампанію", async () => {
      const { until } = await api("/api/lead-campaigns/skip", { method: "POST", body: JSON.stringify({ contactId: side.contactId }) });
      return `Кампанію пропущено до ${skipDate(until)}.`;
    });
  }
  if (act === "campaign-create") {
    const open = { accountId: side.thread?.accountId, threadKey: side.thread?.threadKey, contactId: side.contactId };
    const name = side.thread?.participant?.name || "контакта";
    return createCampaignFor({
      name,
      contactId: side.contactId,
      back: (campaign) => {
        setInboxMode("all");
        side.key = "";
        if (campaign) side.carry = campaign.assignError ? `Кампанію «${campaign.name}» створено, але: ${campaign.assignError}` : `Тепер у новій кампанії «${campaign.name}».`;
        document.querySelector('.nav-item[data-view="inbox"]')?.click();
        if (open.accountId && open.threadKey) void showWarmupInboxThread(open.accountId, open.threadKey);
      }
    });
  }
  if (act === "campaign") {
    const campaignId = document.getElementById("inboxSideCampaign")?.value || "";
    if (!campaignId) { side.notice = "Оберіть кампанію зі списку."; return renderThreadSide(); }
    return void sideAction("віднести до кампанії", async () => {
      const { campaign } = await api("/api/lead-campaigns/assign", { method: "POST", body: JSON.stringify({ contactId: side.contactId, campaignId }) });
      await api("/api/today/refresh", { method: "POST", body: "{}" }).catch(() => {});
      return `Тепер у кампанії «${campaign.name}».`;
    });
  }
});

document.addEventListener("change", (event) => {
  if (event.target?.matches?.("#warmupInboxSide [data-side-status]")) return void pickSideStatus(event.target.value);
  if (event.target?.matches?.("#warmupInboxSide [data-side-exit]") && event.target.value && side.pendingStatus) return void sideStatus(side.pendingStatus, event.target.value);
  if (event.target?.id !== "inboxSideDate" || !event.target.value) return;
  const value = event.target.value;
  const first = today.data?.today || "";
  const year = Number(value.slice(0, 4));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || (first && value < first) || year > Number(first.slice(0, 4) || year) + 1) return;
  const call = side.callMode;
  side.callMode = false;
  void sidePing(value, call);
});
