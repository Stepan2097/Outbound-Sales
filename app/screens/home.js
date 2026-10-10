// Головна — навіщо цей софт, на одній сторінці: розсилка йде сама, повідомлення
// пише модель, а людина бачить, де все стоїть, і робить лише те, що може тільки
// вона: схвалює перше повідомлення, читає відповіді, рятує акаунт, що застряг.
//
// Зверху — конвеєр: у черзі → запрошено → прийняли → ми написали → відповіли.
// Під ним головне, що чекає людини: ті, хто прийняв запрошення, кожен із
// повідомленням, яке модель уже написала. Одне «Надіслати» — і акаунт надішле
// його у свою наступну сесію. Далі — нові відповіді й акаунти, які розсилають.

import { escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";
import { getCacheEpoch, onCacheReset, recallScreen, rememberScreen } from "../cache.js";
import { showContactCard } from "../screens/contacts.js";
import { showWarmupInboxThread } from "../screens/inbox.js";
import { warmupApi, warmupCount } from "../screens/warmup-accounts.js";

onScreen("home", { open: () => loadHome() });

export const homeState = {
  data: null,
  ready: false,
  error: "",
  // Що людина змінила в тексті першого повідомлення, по людині: перемалювання
  // сторінки не повертає модельного тексту поверх виправленого.
  edits: new Map(),
  // Хто зараз пишеться моделлю, і чиє повідомлення зараз іде в чергу.
  drafting: new Set(),
  busy: new Set(),
  // Помилка біля конкретної людини, а не загальна.
  errors: new Map()
};

onCacheReset(resetHomeScreen);

function resetHomeScreen() {
  homeState.data = null;
  homeState.ready = false;
  homeState.error = "";
  homeState.edits.clear();
  homeState.drafting.clear();
  homeState.busy.clear();
  homeState.errors.clear();
  const root = document.getElementById("homeRoot");
  if (root) root.innerHTML = "";
}

const HOME_CACHE = "home";

/** Скільки людей модель пише одночасно, коли сторінку відкрили. Решта — по черзі. */
const HOME_DRAFT_PARALLEL = 2;

// ── читання ────────────────────────────────────────────────────────────────

export async function loadHome() {
  const session = getCacheEpoch();
  const saved = recallScreen(HOME_CACHE);
  if (!homeState.ready && saved?.value) {
    homeState.data = saved.value;
    homeState.ready = true;
    renderHome();
  } else if (!homeState.ready) {
    renderHome();
  }
  try {
    const payload = await warmupApi("/home");
    if (session !== getCacheEpoch()) return;
    homeState.data = payload;
    homeState.ready = true;
    homeState.error = "";
    rememberScreen(HOME_CACHE, payload);
  } catch (error) {
    if (session !== getCacheEpoch()) return;
    homeState.error = error?.status === 404
      ? "На цьому сервері ще немає головної сторінки."
      : (error?.message || "Головну не вдалося прочитати.");
    if (!homeState.data) homeState.ready = true;
  }
  renderHome();
  draftMissing();
}

/**
 * Модель пише тим, у кого ще немає повідомлення, — сама, щойно сторінку відкрили.
 * Тут автоматизація письма: людина приходить уже до готових текстів.
 */
async function draftMissing() {
  const session = getCacheEpoch();
  const people = (homeState.data?.toWrite || []).filter((person) =>
    !person.draft && !person.reply && !homeState.drafting.has(person.outreachId));
  const queue = [...people];
  const worker = async () => {
    while (queue.length && session === getCacheEpoch()) {
      const person = queue.shift();
      await draftFor(person.outreachId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOME_DRAFT_PARALLEL, queue.length) }, worker));
}

async function draftFor(outreachId, { force = false } = {}) {
  const session = getCacheEpoch();
  homeState.drafting.add(outreachId);
  homeState.errors.delete(outreachId);
  renderHomeCard(outreachId);
  try {
    const payload = await warmupApi("/first-messages/draft", {
      method: "POST",
      body: JSON.stringify({ outreachId, force })
    });
    if (session !== getCacheEpoch()) return;
    const person = homePerson(outreachId);
    if (person) person.draft = payload.draft;
    // Переписали на прохання — то й виправлене людиною поступається новому.
    if (force) homeState.edits.delete(outreachId);
  } catch (error) {
    if (session !== getCacheEpoch()) return;
    homeState.errors.set(outreachId, error?.message || "Модель не написала повідомлення.");
  } finally {
    if (session === getCacheEpoch()) {
      homeState.drafting.delete(outreachId);
      renderHomeCard(outreachId);
    }
  }
}

function homePerson(outreachId) {
  return (homeState.data?.toWrite || []).find((person) => person.outreachId === outreachId) || null;
}

/** Текст, що стоїть у полі: виправлений людиною, інакше — написаний моделлю. */
function homeText(person) {
  if (homeState.edits.has(person.outreachId)) return homeState.edits.get(person.outreachId);
  if (person.reply && person.reply.state !== "cancelled") return person.reply.body || "";
  return person.draft?.text || "";
}

// ── дії ────────────────────────────────────────────────────────────────────

async function sendFirst(outreachId) {
  const session = getCacheEpoch();
  const person = homePerson(outreachId);
  if (!person || homeState.busy.has(outreachId)) return;
  const text = homeText(person).trim();
  if (!text) return;
  homeState.busy.add(outreachId);
  homeState.errors.delete(outreachId);
  renderHomeCard(outreachId);
  try {
    const payload = await warmupApi("/first-messages/send", {
      method: "POST",
      body: JSON.stringify({ outreachId, text })
    });
    if (session !== getCacheEpoch()) return;
    person.reply = payload.reply;
    person.goesOut = { at: payload.goesOutAt, today: payload.goesOutToday, soon: payload.goesOutSoon };
    homeState.edits.delete(outreachId);
  } catch (error) {
    if (session !== getCacheEpoch()) return;
    homeState.errors.set(outreachId, error?.message || "Не вдалося поставити в чергу.");
  } finally {
    if (session === getCacheEpoch()) {
      homeState.busy.delete(outreachId);
      renderHomeCard(outreachId);
    }
  }
}

async function cancelFirst(outreachId) {
  const session = getCacheEpoch();
  const person = homePerson(outreachId);
  if (!person?.reply || homeState.busy.has(outreachId)) return;
  homeState.busy.add(outreachId);
  renderHomeCard(outreachId);
  try {
    await warmupApi("/inbox/reply/cancel", {
      method: "POST",
      body: JSON.stringify({ accountId: person.accountId, replyId: person.reply.id })
    });
    if (session !== getCacheEpoch()) return;
    // Текст лишається в полі: скасовують, щоб виправити, а не щоб почати з нуля.
    homeState.edits.set(outreachId, person.reply.body || homeText(person));
    person.reply = null;
    person.goesOut = null;
  } catch (error) {
    if (session !== getCacheEpoch()) return;
    homeState.errors.set(outreachId, error?.message || "Не вдалося скасувати.");
  } finally {
    if (session === getCacheEpoch()) {
      homeState.busy.delete(outreachId);
      renderHomeCard(outreachId);
    }
  }
}

async function dismissFirst(outreachId) {
  const session = getCacheEpoch();
  if (homeState.busy.has(outreachId)) return;
  homeState.busy.add(outreachId);
  try {
    await warmupApi("/first-messages/dismiss", { method: "POST", body: JSON.stringify({ outreachId }) });
    if (session !== getCacheEpoch()) return;
    const data = homeState.data;
    data.toWrite = data.toWrite.filter((person) => person.outreachId !== outreachId);
    data.toWriteTotal = Math.max(0, (Number(data.toWriteTotal) || 1) - 1);
    homeState.edits.delete(outreachId);
    renderHome();
  } catch (error) {
    if (session !== getCacheEpoch()) return;
    homeState.errors.set(outreachId, error?.message || "Не вдалося пропустити.");
    renderHomeCard(outreachId);
  } finally {
    if (session === getCacheEpoch()) {
      homeState.busy.delete(outreachId);
    }
  }
}

// ── малювання ──────────────────────────────────────────────────────────────

function homeAgo(iso) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "щойно";
  if (minutes < 60) return `${minutes} хв тому`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.round(hours / 24);
  return days === 1 ? "вчора" : `${days} дн тому`;
}

/** Коли акаунт надішле: його наступна сесія. */
function homeGoesOut(goesOut) {
  if (!goesOut?.at) return "у наступну сесію акаунта";
  if (goesOut.soon) return "найближчим часом, у вікні сесій";
  const at = new Date(goesOut.at);
  if (!Number.isFinite(at.getTime())) return "у наступну сесію акаунта";
  const time = at.toLocaleTimeString("uk", { hour: "2-digit", minute: "2-digit" });
  return `${goesOut.today ? "сьогодні" : "завтра"} близько ${time}`;
}

function homePercent(part, whole) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "";
}

const HOME_STEPS = [
  { key: "queued", label: "У черзі", hint: "з папок кампаній, ще не запрошені" },
  { key: "invited", label: "Запрошено", hint: "запит на контакт надіслано" },
  { key: "accepted", label: "Прийняли", hint: "у контактах акаунта" },
  { key: "written", label: "Ми написали", hint: "перше повідомлення пішло" },
  { key: "replied", label: "Відповіли", hint: "написали у відповідь" }
];

function homeFunnelHtml(data) {
  const funnel = data.funnel || {};
  const today = data.today || {};
  const extra = {
    invited: today.invited ? `+${warmupCount(today.invited)} сьогодні` : "",
    accepted: homePercent(funnel.accepted, funnel.invited) ? `${homePercent(funnel.accepted, funnel.invited)} запрошених` : "",
    written: data.toWriteTotal ? `${warmupCount(data.toWriteTotal)} чекають на повідомлення` : "",
    replied: today.replied ? `+${warmupCount(today.replied)} сьогодні` : (homePercent(funnel.replied, funnel.accepted) ? `${homePercent(funnel.replied, funnel.accepted)} прийнятих` : "")
  };
  return `<ol class="home-funnel">${HOME_STEPS.map((step) => `
    <li class="home-step is-${step.key}">
      <span class="home-step-label">${escapeHtml(step.label)}</span>
      <strong class="home-step-value">${warmupCount(Number(funnel[step.key]) || 0)}</strong>
      <span class="home-step-hint">${escapeHtml(extra[step.key] || step.hint)}</span>
    </li>`).join("")}</ol>`;
}

function homeAttentionHtml(data) {
  const items = Array.isArray(data.attention) ? data.attention : [];
  if (!items.length) return "";
  return `<ul class="home-attention">${items.map((item) => `
    <li class="home-attention-item is-${escapeAttr(item.kind || "other")}">
      <i data-lucide="${item.kind === "writer" ? "sparkles" : item.kind === "campaign" ? "megaphone" : "alert-triangle"}"></i>
      <span>${escapeHtml(item.text)}</span>
      ${item.kind === "account" || item.kind === "campaign"
        ? '<button class="text-button" type="button" data-home-go="warmup"><span>До «Прогріву»</span><i data-lucide="arrow-right"></i></button>'
        : ""}
    </li>`).join("")}</ul>`;
}

const HOME_REPLY_STATE = {
  waiting: "чекає відправки",
  failed: "не пішло",
  expired: "не надіслано — минуло три доби",
  sent: "надіслано"
};

/** Одна людина, що прийняла запрошення: хто, через який акаунт, повідомлення і що з ним робити. */
function homeCardInnerHtml(person) {
  const id = person.outreachId;
  const busy = homeState.busy.has(id);
  const drafting = homeState.drafting.has(id);
  const error = homeState.errors.get(id) || "";
  const reply = person.reply && person.reply.state !== "cancelled" ? person.reply : null;
  const waiting = reply?.state === "waiting";
  const text = homeText(person);
  const role = [person.position, person.company].filter(Boolean).join(" · ");

  const who = `
    <div class="home-person-head">
      <div class="home-person-who">
        <strong>${person.linkedin
          ? `<a href="${escapeAttr(person.linkedin)}" target="_blank" rel="noreferrer noopener">${escapeHtml(person.name || "Без імені")}</a>`
          : escapeHtml(person.name || "Без імені")}</strong>
        ${role ? `<span class="home-subtle">${escapeHtml(role)}</span>` : ""}
      </div>
      <div class="home-person-meta">
        <span class="home-subtle">прийняв(ла) запрошення від <b>${escapeHtml(person.accountName || "акаунта")}</b></span>
        ${person.crmContactId ? `<button class="text-button" type="button" data-home-contact="${escapeAttr(person.crmContactId)}"><i data-lucide="contact"></i><span>У CRM</span></button>` : ""}
      </div>
    </div>`;

  let status = "";
  if (waiting) {
    status = `<p class="home-person-status is-waiting"><i data-lucide="clock"></i><span>${escapeHtml(HOME_REPLY_STATE.waiting)} — акаунт ${escapeHtml(person.accountName || "")} надішле ${escapeHtml(homeGoesOut(person.goesOut))}.</span></p>`;
  } else if (reply?.state === "failed" || reply?.state === "expired") {
    status = `<p class="home-person-status is-bad"><i data-lucide="alert-triangle"></i><span>${escapeHtml(HOME_REPLY_STATE[reply.state])}${reply.reason ? `: ${escapeHtml(reply.reason)}` : ""}</span></p>`;
  } else if (drafting) {
    status = '<p class="home-person-status is-drafting"><i data-lucide="sparkles"></i><span>Модель пише повідомлення…</span></p>';
  } else if (person.draft?.model === "local-draft") {
    status = '<p class="home-person-status is-warn"><i data-lucide="file-text"></i><span>Написано за шаблоном, без моделі — перечитайте уважно.</span></p>';
  }

  const field = `<textarea class="home-person-text" data-home-text="${escapeAttr(id)}" rows="4"
    aria-label="Перше повідомлення для ${escapeAttr(person.name || "людини")}"
    placeholder="${drafting ? "Модель пише…" : "Перше повідомлення"}"${waiting || busy ? " disabled" : ""}>${escapeHtml(text)}</textarea>`;

  const actions = waiting
    ? `<button class="text-button" type="button" data-home-cancel="${escapeAttr(id)}"${busy ? " disabled" : ""}><i data-lucide="x"></i><span>Скасувати й виправити</span></button>`
    : `<button class="primary-button" type="button" data-home-send="${escapeAttr(id)}"${busy || drafting || !text.trim() ? " disabled" : ""}><i data-lucide="send"></i><span>${busy ? "Ставлю в чергу…" : reply ? "Надіслати знову" : "Надіслати"}</span></button>
       <button class="text-button" type="button" data-home-redraft="${escapeAttr(id)}"${busy || drafting ? " disabled" : ""}><i data-lucide="refresh-cw"></i><span>Переписати</span></button>
       <button class="text-button" type="button" data-home-dismiss="${escapeAttr(id)}"${busy ? " disabled" : ""}><i data-lucide="user-x"></i><span>Пропустити</span></button>`;

  return `${who}${status}${field}
    ${error ? `<p class="home-person-error">${escapeHtml(error)}</p>` : ""}
    <div class="home-person-actions">${actions}</div>`;
}

function homeWriteHtml(data) {
  const people = Array.isArray(data.toWrite) ? data.toWrite : [];
  const total = Number(data.toWriteTotal) || people.length;
  const head = `
    <div class="panel-heading">
      <div>
        <h2>Прийняли запрошення — напишіть першими</h2>
        <p>${total
          ? `${warmupCount(total)} ${total === 1 ? "людина чекає" : "людей чекають"} на перше повідомлення. Модель уже пише кожному; перечитайте й натисніть «Надіслати» — акаунт надішле сам, у свою наступну сесію.`
          : "Повідомлення пише модель, надсилає акаунт — а ви лише схвалюєте."}</p>
      </div>
    </div>`;
  if (!people.length) {
    return `${head}<div class="home-empty">
      <i data-lucide="inbox"></i>
      <strong>Поки ніхто не чекає на перше повідомлення.</strong>
      <span>Щойно хтось прийме запрошення, тут з'явиться він — і вже з повідомленням від моделі.</span>
    </div>`;
  }
  const more = total > people.length ? `<p class="home-subtle home-more">І ще ${warmupCount(total - people.length)} — з'являться тут, коли ці підуть.</p>` : "";
  return `${head}<div class="home-people">${people.map((person) => `
    <article class="home-person" data-home-card="${escapeAttr(person.outreachId)}">${homeCardInnerHtml(person)}</article>`).join("")}</div>${more}`;
}

function homeRepliesHtml(data) {
  const replies = data.replies || {};
  const latest = Array.isArray(replies.latest) ? replies.latest : [];
  const head = `
    <div class="panel-heading">
      <div>
        <h2>Нові відповіді</h2>
        <p>${replies.unread ? `${warmupCount(replies.unread)} непрочитаних` : "Усе прочитано"}</p>
      </div>
      <button class="text-button" type="button" data-home-go="inbox"><span>Усі у «Вхідних»</span><i data-lucide="arrow-right"></i></button>
    </div>`;
  if (!latest.length) return `${head}<div class="home-empty is-small"><span>Нових відповідей немає.</span></div>`;
  return `${head}<div class="home-replies">${latest.map((thread) => {
    const body = String(thread.lastMessage?.body || "").replace(/\s+/g, " ").trim();
    const name = String(thread.participant?.name || "").replace(/^(переглянути\s+профіль|view\s+profile\s+of)\s+/i, "") || "Без імені";
    return `<button class="home-reply" type="button" data-home-thread="${escapeAttr(thread.threadKey)}" data-home-thread-account="${escapeAttr(thread.accountId)}">
      <span class="home-reply-head"><strong>${escapeHtml(name)}</strong><time>${escapeHtml(homeAgo(thread.lastMessage?.sentAt))}</time></span>
      <span class="home-reply-body">${escapeHtml(body.length > 140 ? `${body.slice(0, 139)}…` : body)}</span>
      <span class="home-subtle">на ${escapeHtml(thread.accountName || "акаунт")}</span>
    </button>`;
  }).join("")}</div>`;
}

const HOME_ACCOUNT_STATE = {
  warming: ["Прогрів", "tone-live"],
  working: ["Розсилає", "tone-live"],
  limit: ["Ліміт LinkedIn", "tone-warn"],
  paused: ["Пауза", "tone-warn"],
  finished: ["Прогрів завершено", "tone-muted"],
  idle: ["Не запущено", "tone-muted"]
};

function homeAccountsHtml(data) {
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const head = `
    <div class="panel-heading">
      <div>
        <h2>Хто розсилає</h2>
        <p>${accounts.length ? `Сесії щодня у вікні ${escapeHtml(data.window || "")}` : "Акаунтів ще немає"}</p>
      </div>
      <button class="text-button" type="button" data-home-go="warmup"><span>«Прогрів»</span><i data-lucide="arrow-right"></i></button>
    </div>`;
  if (!accounts.length) {
    return `${head}<div class="home-empty is-small"><span>Додайте акаунти LinkedIn у «Прогріві» — без них нема кому розсилати.</span></div>`;
  }
  return `${head}<div class="home-accounts">${accounts.map((account) => {
    const [label, tone] = account.health && account.health !== "ok"
      ? ["Потрібна увага", "tone-bad"]
      : HOME_ACCOUNT_STATE[account.state] || HOME_ACCOUNT_STATE.idle;
    const day = account.state === "warming" && account.day ? ` · день ${account.day}${account.totalDays ? ` з ${account.totalDays}` : ""}` : "";
    const until = (account.state === "limit" || account.state === "paused") && account.pausedUntil ? ` до ${account.pausedUntil}` : "";
    const next = account.nextSession ? new Date(account.nextSession) : null;
    const nextText = next && Number.isFinite(next.getTime())
      ? next.toLocaleString("uk", { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : "—";
    return `<div class="home-account">
      <div class="home-account-who">
        <strong>${escapeHtml(account.name || account.label || "акаунт")}</strong>
        <span class="pill ${tone}">${escapeHtml(label)}${escapeHtml(until)}</span>
      </div>
      <div class="home-account-facts">
        <span>Запити сьогодні: <b>${account.connects ? `${account.connects.done}/${account.connects.quota}` : "—"}</b>${escapeHtml(day)}</span>
        <span>Наступна сесія: <b>${escapeHtml(nextText)}</b></span>
        ${account.campaigns?.length ? `<span>Кампанія: ${escapeHtml(account.campaigns.join(", "))}</span>` : '<span class="home-subtle">без кампанії</span>'}
      </div>
    </div>`;
  }).join("")}</div>`;
}

export function renderHome() {
  const root = document.getElementById("homeRoot");
  if (!root) return;
  const data = homeState.data;
  if (!homeState.ready) {
    root.innerHTML = '<div class="empty-state">Завантажуємо головну...</div>';
    return;
  }
  if (!data) {
    root.innerHTML = `<div class="home-empty is-bad"><strong>${escapeHtml(homeState.error || "Головну не вдалося прочитати.")}</strong></div>`;
    return;
  }
  const subtitle = data.today
    ? `Сьогодні: ${warmupCount(data.today.invited || 0)} запрошень, ${warmupCount(data.today.replied || 0)} відповідей`
    : "";
  root.innerHTML = `
    ${homeState.error ? `<div class="home-stale">${escapeHtml(homeState.error)} Показано останнє, що було.</div>` : ""}
    <section class="panel home-panel">
      <div class="panel-heading">
        <div>
          <h2>Як іде розсилка</h2>
          <p>${escapeHtml(subtitle)}</p>
        </div>
        <button class="text-button" type="button" id="homeRefreshBtn"><i data-lucide="refresh-cw"></i><span>Оновити</span></button>
      </div>
      ${homeFunnelHtml(data)}
      ${homeAttentionHtml(data)}
    </section>
    <section class="panel home-panel home-write">${homeWriteHtml(data)}</section>
    <div class="home-columns">
      <section class="panel home-panel">${homeRepliesHtml(data)}</section>
      <section class="panel home-panel">${homeAccountsHtml(data)}</section>
    </div>`;
  refreshIcons();
}

/**
 * Перемалювати одну людину, не чіпаючи решти: модель дописує повідомлення
 * комусь іншому, поки тут правлять текст, — і поле, в якому пишуть, не мусить
 * зникати з-під рук. Якщо курсор саме в цій картці, поле лишається, а міняється
 * все довкола нього.
 */
export function renderHomeCard(outreachId) {
  const person = homePerson(outreachId);
  const card = document.querySelector?.(`[data-home-card="${CSS.escape(outreachId)}"]`);
  if (!person || !card) return;
  const active = document.activeElement;
  const typing = active?.dataset?.homeText === outreachId;
  if (typing) {
    // Поле не перемальовується; лише кнопки й стан біля нього.
    const fresh = document.createElement("div");
    fresh.innerHTML = homeCardInnerHtml(person);
    for (const selector of [".home-person-actions", ".home-person-status", ".home-person-error"]) {
      const next = fresh.querySelector(selector);
      const now = card.querySelector(selector);
      if (now && next) now.replaceWith(next);
      else if (now && !next) now.remove();
      else if (!now && next) active.insertAdjacentElement(selector === ".home-person-status" ? "beforebegin" : "afterend", next);
    }
  } else {
    card.innerHTML = homeCardInnerHtml(person);
  }
  refreshIcons();
}

// ── руки ───────────────────────────────────────────────────────────────────

document.getElementById("homeRoot")?.addEventListener("click", (event) => {
  const target = event.target;
  const pick = (attribute) => target.closest?.(`[${attribute}]`);
  let hit;
  if ((hit = pick("data-home-send"))) { sendFirst(hit.dataset.homeSend); return; }
  if ((hit = pick("data-home-cancel"))) { cancelFirst(hit.dataset.homeCancel); return; }
  if ((hit = pick("data-home-redraft"))) { draftFor(hit.dataset.homeRedraft, { force: true }); return; }
  if ((hit = pick("data-home-dismiss"))) { dismissFirst(hit.dataset.homeDismiss); return; }
  if ((hit = pick("data-home-contact"))) { showContactCard(hit.dataset.homeContact); return; }
  if ((hit = pick("data-home-thread"))) { showWarmupInboxThread(hit.dataset.homeThreadAccount, hit.dataset.homeThread); return; }
  if ((hit = pick("data-home-go"))) { document.querySelector(`.nav-item[data-view="${hit.dataset.homeGo}"]`)?.click(); return; }
  if (target.closest?.("#homeRefreshBtn")) loadHome();
});

// Виправлене людиною лишається її текстом, а кнопка «Надіслати» оживає й гасне з ним.
document.getElementById("homeRoot")?.addEventListener("input", (event) => {
  const id = event.target?.dataset?.homeText;
  if (!id) return;
  homeState.edits.set(id, event.target.value);
  const send = event.target.closest?.("[data-home-card]")?.querySelector?.("[data-home-send]");
  if (send) send.disabled = !event.target.value.trim() || homeState.busy.has(id) || homeState.drafting.has(id);
});
