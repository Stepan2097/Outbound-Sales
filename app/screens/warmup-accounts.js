// Прогрів — the accounts: the table, one line on how the day is going, and one
// account's card with who waits on it. The campaign that feeds them lives in
// warmup-campaign.js.

import {
  autoFeedFor, inviteAttentionText, queueAnswerIsCurrent
} from "../warmup-view.js";
import {
  api, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural
} from "../core.js";
import {
  loadWarmupInbox, setWarmupUnread, showWarmupInboxAccount, warmupInboxUnreadFor
} from "./inbox.js";
import {
  loadWarmupCampaigns, loadWarmupStrategy, renderWarmupCampaignDetail, renderWarmupCampaigns, renderWarmupStrategy, toggleWarmupAccount, warmupAutoFeedHtml, warmupCampaignAccountIds, warmupSelectedCampaign
} from "./warmup-campaign.js";

onScreen("warmup", { open: () => loadWarmup() });

export const warmupState = {
  config: null,
  dashboard: null,
  profiles: [],
  selectedAccountId: null,
  selectedProfileId: null,
  detail: null,
  busy: false,
  error: "",
  // The warm-up schedule itself: one strategy for every account, held as the
  // server sends it and edited as `strategyDraft`, day by day. The draft is
  // null until somebody opens the editor, so an open panel with no edits and a
  // panel nobody opened are the same thing to everything else here.
  strategy: null,
  strategyDraft: null,
  strategyOpen: false,
  strategyBusy: false,
  strategyError: "",
  strategyNotice: "",
  // Campaigns: a folder, the filters that narrow it, the accounts that work it
  // and a product, each with the server's forecast for that combination. The
  // forecast is never recomputed here — a second copy of that arithmetic is a
  // second answer.
  folders: [],
  foldersReady: false,
  campaigns: [],
  campaignsReady: false,
  campaignsError: "",
  campaignNotice: "",
  selectedCampaignId: null,
  // The form is open on exactly one thing at a time: a new campaign (id null)
  // or an existing one. Nothing is a draft in two places.
  formOpen: false,
  formCampaignId: null,
  savingCampaign: false,
  pendingAccountIds: null,
  // Per account: who waits on it and whether the folder tops it up today, or
  // the server's sentence saying why nothing does. Read with the open card.
  queues: {},
  // The inbox. `ready` is "the endpoint answered", `available` is "this server
  // has the endpoint at all" — a portal built before the inbox landed should
  // say so rather than claim nobody has written.
  inbox: {
    threads: [],
    // One entry per account that holds a thread: how much it holds, how much of
    // it is unread. The list groups by this and the accounts table reads the
    // same numbers, so the two can never tell a seller different things.
    accounts: [],
    unread: 0,
    sync: null,
    ready: false,
    available: true,
    error: "",
    // The open thread, held as account + thread because a thread key is only
    // unique within the account it arrived on.
    openAccountId: null,
    openThreadKey: null,
    open: null,
    openError: "",
    openBusy: false
  },
  // Null is "not asked yet", which is not the same as zero: a badge that has
  // never been told a number must not claim there is nothing to read.
  unreadReplies: null
};

export function warmupApi(path, options) {
  return api(`/api/warmup${path}`, options);
}

const WARMUP_STATUS_TONE = {
  warming: "tone-live",
  working: "tone-live",
  paused: "tone-warn",
  blocked: "tone-bad",
  needs_attention: "tone-warn",
  finished: "tone-done",
  excluded: "tone-muted",
  off: "tone-muted"
};

const WARMUP_STATUS_LABEL = {
  warming: "Прогрівається",
  // Past the last phase an account does not stop; it settles into working mode.
  working: "Робочий режим",
  paused: "На паузі",
  blocked: "Заблоковано",
  needs_attention: "Потребує уваги",
  finished: "Завершено",
  excluded: "Виключено",
  off: "Вимкнено"
};

function warmupRelativeTime(iso) {
  if (!iso) return "—";
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (!Number.isFinite(minutes)) return "—";
  const time = new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (minutes <= 0) return time;
  if (minutes < 60) return `${time} · через ${minutes} хв`;
  return `${time} · через ${Math.round(minutes / 60)} год`;
}

/** What the "next session" cell says, which follows the quota and not the clock. */
function warmupNextSessionCell(profile) {
  const next = profile.nextSession;
  if (profile.isRunningNow) return '<span class="warmup-due">відкрита зараз</span>';
  if (!next) return "—";
  if (next.overdue) return '<span class="warmup-due">час настав</span>';
  if (next.today) return warmupRelativeTime(next.at);
  return `завтра ${new Date(next.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function warmupConnectionsCell(profile) {
  const { today = 0, total = 0, quota = 0, startsDay = null } = profile.connections || {};
  const week = profile.connections?.weekly;
  const all = `title="${total} за весь час${week ? ` · ${week.done}/${week.limit} за 7 днів` : ""}"`;
  if (quota > 0) return `<span ${all}>${today}/${quota}</span>`;
  if (startsDay) return `<span class="warmup-subtle" ${all}>з ${startsDay}-го дня</span>`;
  // No requests today: the column is about today, so it says nothing — the
  // all-time count read as today's in a column headed «сьогодні».
  return `<span class="warmup-subtle" ${all}>—</span>`;
}

function renderWarmupConfigNote() {
  const note = document.getElementById("warmupConfigNote");
  if (!note) return;
  const config = warmupState.config;
  const problems = [];

  if (warmupState.error) problems.push(escapeHtml(warmupState.error));
  if (config && !config.configured) {
    problems.push(`База Anty не налаштована — задай на сервері ${escapeHtml(config.missing.join(", "))}.`);
  }
  if (config?.configured && !config.teamConfigured) {
    problems.push("ANTY_TEAM_ID не заданий, тому в списку профілі всіх команд.");
  }
  if (config?.configured && !config.crmConfigured) {
    problems.push(`Черга лідів вимкнена — задай ${escapeHtml(config.crmMissing.join(", "))}, щоб надсилати запити на контакт конкретним людям.`);
  }
  if (config?.configured && !config.secretsConfigured) {
    problems.push("LINKEDIN_SECRET_KEY не заданий, тому паролі акаунтів нікуди зберігати.");
  }

  note.hidden = problems.length === 0;
  note.innerHTML = problems.map((problem) => `<p>${problem}</p>`).join("");
}

/**
 * One line under «Акаунти»: how far today has got, and whether a session can
 * start right now. It used to be seven cards, five of them counts of a status
 * the table already shows row by row.
 */
function renderWarmupStats() {
  const line = document.getElementById("warmupSummary");
  if (!line) return;
  const dashboard = warmupState.dashboard;
  if (!dashboard) {
    line.textContent = "";
    return;
  }
  const { totals, todayProgress } = dashboard;
  const window = warmupState.config?.window;
  const parts = [`Сьогодні зроблено ${todayProgress.done} з ${todayProgress.planned}`];
  if (window) parts.push(`вікно сесій ${window.label}${window.open ? "" : " — зачинене"}`);
  if (totals.paused) parts.push(`на паузі ${warmupCount(totals.paused)}`);
  line.textContent = parts.join(" · ");
}

export const WARMUP_EMPTY_FILTERS = { country: "", position: "", leadStatus: "", ownerId: "" };

/**
 * З якого дня прогріву кампанія сама годує акаунти зі своєї папки. Сім —
 * бо дні 4–6 для своїх і перевірених, яких ставлять вручну з картки ліда.
 * Сервер має те саме число (`DEFAULT_FROM_DAY`); тут воно лише для форми.
 */
export const WARMUP_DEFAULT_FROM_DAY = 7;

export const WARMUP_CAMPAIGN_TONE = {
  draft: "tone-muted",
  running: "tone-live",
  paused: "tone-warn",
  done: "tone-done"
};

/** Стан кампанії — це дані; те, що видно в пігулці, — це текст. */
export const WARMUP_CAMPAIGN_STATE_LABEL = {
  draft: "чернетка",
  running: "працює",
  paused: "на паузі",
  done: "завершена"
};

/** 12 038 rather than 12038: these are counts somebody has to weigh. */
export function warmupCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return Math.round(number).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** A thousand days is not a figure anybody can feel; "2.7 years" is. */
export function warmupDuration(days) {
  const number = Number(days);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number < 45) return `${Math.round(number)} ${uaPlural(Math.round(number), "день", "дні", "днів")}`;
  if (number < 365) return `${Math.round(number / 30)} ${uaPlural(Math.round(number / 30), "місяць", "місяці", "місяців")}`;
  return `${(number / 365).toFixed(1)} року`;
}

function warmupQueueState(accountId) {
  return warmupState.queues[accountId] || null;
}

/**
 * Who this account will send requests to next, and whether the campaign's
 * folder tops it up today — the part of the old «Черга» panel that answered a
 * question. The manual half of that panel (claim people, mark a request as sent
 * by hand) is gone: every one of the 41 requests so far came from the folder.
 */
function warmupAccountQueueHtml(accountId) {
  const queue = warmupQueueState(accountId);
  if (!queue) return "";
  if (queue.error) return `<p class="warmup-queue-reason is-bad">${escapeHtml(queue.error)}</p>`;
  if (queue.unavailable) return "";
  const feedLine = warmupAutoFeedHtml(autoFeedFor(queue, warmupState.selectedCampaignId || ""));
  const waiting = warmupQueueWaitingHtml(queue.waiting || []);
  const reason = !waiting && !feedLine && queue.reason ? `<p class="warmup-queue-reason">${escapeHtml(queue.reason)}</p>` : "";
  if (!feedLine && !waiting && !reason) return "";
  return `<section class="warmup-card-queue"><h3>Черга запитів</h3>${feedLine}${waiting}${reason}</section>`;
}

/**
 * Хто чекає, поки агент надішле запит, — і хто з них із папки, а кого
 * поставили вручну. Кнопок тут немає: це черга агента, не людини.
 */
function warmupQueueWaitingHtml(rows) {
  if (!rows.length) return "";
  const fromFolder = rows.filter((row) => row.fromFolder).length;
  const items = rows.map((row) => {
    const link = warmupLeadLink(row.linkedin);
    const where = [row.position, row.company].filter(Boolean).join(" · ");
    const source = row.fromFolder
      ? `<span class="pill tone-muted" title="${escapeAttr(row.campaignName ? `Із папки кампанії «${row.campaignName}»` : "Із папки кампанії")}">з папки</span>`
      : '<span class="pill tone-live" title="Поставлено вручну з картки ліда — піде першим">вручну</span>';
    // A block page on this request: the agent is not handed it until
    // somebody moves or cancels it on the card.
    const attention = row.parked
      ? `<span class="pill tone-warn" title="${escapeAttr(inviteAttentionText({ status: "waiting", parked: true }))}">потребує уваги</span>`
      : "";
    return `<li>
      <div class="warmup-lead-who">
        <strong>${escapeHtml(row.name || "Контакт без імені")}</strong>
        ${where ? `<span class="warmup-subtle">${escapeHtml(where)}</span>` : ""}
      </div>
      ${source}
      ${attention}
      ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">профіль</a>` : ""}
    </li>`;
  }).join("");
  const parked = rows.filter((row) => row.parked).length;
  return `<details class="warmup-queue-waiting"${parked ? " open" : ""}>
    <summary>Чекають агента: ${warmupCount(rows.length)}${fromFolder ? ` · з папки ${warmupCount(fromFolder)}` : ""}${parked ? ` · потребують уваги ${warmupCount(parked)}` : ""}</summary>
    <ul class="warmup-leads warmup-queue-list">${items}</ul>
  </details>`;
}

function warmupLeadLink(url) {
  const value = String(url || "");
  return /^https?:\/\//i.test(value) ? value : null;
}

/**
 * The waiting replies on this account, said next to its name.
 *
 * The nav badge counts every account at once, which answers "is anyone waiting"
 * but never "on which login" — and that is the question in front of somebody
 * looking at five profiles. Clicking it opens that account's group in the inbox
 * below rather than filtering, because the number and the threads it counts
 * should be one gesture apart.
 */
function warmupAccountUnreadHtml(accountId) {
  const unread = warmupInboxUnreadFor(accountId);
  if (!unread) return "";
  const label = `${warmupCount(unread)} ${uaPlural(unread, "нова відповідь", "нові відповіді", "нових відповідей")}`;
  return `<button class="warmup-account-unread" type="button" data-warmup-inbox-jump="${escapeAttr(accountId)}"
    title="${escapeAttr(`${label} на цьому акаунті — показати їх у вхідних`)}"><i data-lucide="mail"></i><span>${escapeHtml(label)}</span></button>`;
}

export function renderWarmupProfiles() {
  const body = document.getElementById("warmupProfileTableBody");
  if (!body) return;

  if (!warmupState.profiles.length) {
    body.innerHTML = '<tr><td colspan="6"><div class="empty-state">Акаунтів LinkedIn в Anty немає.</div></td></tr>';
    renderWarmupCampaignDetail();
    return;
  }

  // The tick column belongs to the selected campaign: an account works a
  // campaign, not "the targeting", and there is no second place that answers
  // which folder an account is on.
  const campaign = warmupSelectedCampaign();
  const ticked = warmupCampaignAccountIds(campaign);
  const tickable = Boolean(campaign) && warmupState.campaignsReady;
  const tickTitle = campaign
    ? `Вести «${campaign.name || "цю кампанію"}» з цього акаунта`
    : "Спочатку обери кампанію вгорі, потім познач акаунти, які її ведуть";

  body.innerHTML = warmupState.profiles
    .map((profile) => {
      const status = profile.status;
      const account = profile.account;
      // The person the browser is actually signed in as, which is not the same
      // string as the profile label somebody typed in Anty.
      const identity = profile.identity || account?.identity || null;
      return `
        <tr data-warmup-profile="${escapeHtml(profile.id)}" class="${profile.id === warmupState.selectedProfileId ? "is-selected" : ""}">
          <td class="warmup-tick">
            ${account
              ? `<input type="checkbox" data-warmup-account-tick="${escapeAttr(account.id)}" ${ticked.has(account.id) ? "checked" : ""} ${tickable ? "" : "disabled"} aria-label="Вести вибрану кампанію з акаунта ${escapeAttr(profile.name)}" title="${escapeAttr(tickTitle)}" />`
              : '<span class="warmup-subtle" title="Ще не на прогріві, тож із нього не можна надсилати">—</span>'}
          </td>
          <td>
            <strong>${escapeHtml(profile.name)}</strong>
            ${account ? warmupAccountUnreadHtml(account.id) : ""}
            ${identity?.name
              ? `<div class="warmup-identity" title="На останньому вході агента залогінений як ця особа"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}</span></div>`
              : ""}
            ${profile.proxy ? "" : '<div class="warmup-subtle warmup-no-proxy" title="LinkedIn бачить справжню адресу цього профілю">без проксі</div>'}
          </td>
          <td><span class="pill ${WARMUP_STATUS_TONE[status] || "tone-muted"}">${escapeHtml(WARMUP_STATUS_LABEL[status] || status)}</span></td>
          <td>${escapeHtml(profile.day || "—")}</td>
          <td>${warmupConnectionsCell(profile)}</td>
          <td>${account
            ? warmupNextSessionCell(profile)
            : '<button class="primary-button" type="button" data-warmup-adopt>Прогріти</button>'}</td>
        </tr>`;
    })
    .join("");

  renderWarmupCampaignDetail();
  refreshIcons();
}

function renderWarmupDetail() {
  const title = document.getElementById("warmupDetailTitle");
  const subtitle = document.getElementById("warmupDetailSubtitle");
  const body = document.getElementById("warmupDetailBody");
  if (!title || !body) return;

  const detail = warmupState.detail;
  if (!detail) {
    title.textContent = "Профіль";
    subtitle.textContent = "";
    body.innerHTML = '<div class="empty-state">Вибери профіль зі списку.</div>';
    refreshIcons();
    return;
  }

  const account = detail.account;
  const warmup = account.warmup;
  title.textContent = account.label;
  subtitle.textContent = warmup
    ? warmup.working
      ? `${warmup.strategyName} · робочий режим · день ${warmup.day}`
      : `${warmup.strategyName} · день ${warmup.day} з ${warmup.totalDays}${warmup.phase ? ` · ${warmup.phase}` : ""}`
    : "Ще не прогрівається";

  const actionRows = warmup && !warmup.finished
    ? (warmupState.config?.actionKinds || [])
        .map(({ kind, label }) => {
          const quota = warmup.quotas[kind] ?? 0;
          const done = warmup.done[kind] ?? 0;
          // A kind with no quota today is forbidden, not merely finished, so it
          // gets no button rather than a disabled-looking one.
          if (quota === 0) {
            return `<div class="warmup-action is-off"><span>${escapeHtml(label)}</span><em>сьогодні не можна</em></div>`;
          }
          return `
            <div class="warmup-action">
              <span>${escapeHtml(label)}</span>
              <strong>${done}/${quota}</strong>
            </div>`;
        })
        .join("")
    : "";

  const controls = [];
  if (account.status === "excluded") {
    controls.push('<button class="text-button" type="button" data-warmup-control="include">Повернути в список</button>');
  } else if (!warmup || warmup.state === "completed" || !warmup.runId) {
    controls.push('<button class="primary-button" type="button" data-warmup-control="start">Почати прогрів</button>');
    controls.push('<button class="text-button" type="button" data-warmup-control="exclude">Виключити</button>');
  } else if (warmup.state === "paused") {
    // The pause ends by itself; this is for ending it early.
    controls.push('<button class="primary-button" type="button" data-warmup-control="resume" title="Продовжити зараз, не чекаючи кінця паузи">Продовжити</button>');
    controls.push('<button class="danger-button" type="button" data-warmup-control="stop">Зупинити</button>');
  } else {
    controls.push('<button class="text-button" type="button" data-warmup-control="warning">Прилетіло попередження</button>');
    controls.push('<button class="danger-button" type="button" data-warmup-control="stop">Зупинити</button>');
  }

  const healthOptions = (warmupState.config?.healthValues || [])
    .map(({ value, label }) => `<option value="${escapeHtml(value)}" ${account.health === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");

  const rules = warmup?.rules?.length
    ? `<ul class="warmup-rules">${warmup.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}</ul>`
    : "";

  const sessions = detail.sessions.length
    ? detail.sessions
        .slice(0, 8)
        .map((session) => {
          const did = Object.entries(session.actions || {}).map(([kind, count]) => `${kind}: ${count}`).join(", ");
          return `<li><strong>${new Date(session.startedAt).toLocaleString()}</strong> · ${
            session.endedAt ? `${session.durationMin} хв` : "відкрита"
          } · ${escapeHtml(session.source)}${did ? ` · ${escapeHtml(did)}` : ""}</li>`;
        })
        .join("")
    : "<li>Сесій ще не записано.</li>";

  const events = detail.events.length
    ? detail.events
        .slice(0, 12)
        .map((event) => `<li class="level-${escapeHtml(event.level)}"><span>${new Date(event.created_at).toLocaleString()}</span> ${escapeHtml(event.message)}</li>`)
        .join("")
    : "<li>У лозі ще порожньо.</li>";

  body.innerHTML = `
    <div class="warmup-detail-controls">${controls.join("")}</div>
    ${warmup?.state === "paused" && warmup.pausedUntil ? `<p class="warmup-paused">На паузі після попередження: до ${escapeHtml(warmup.pausedUntil)} включно акаунт нічого не робить. Далі прогрів продовжиться сам, а дні паузи в нього не рахуються.</p>` : ""}
    ${actionRows ? `<div class="warmup-actions">${actionRows}</div>` : ""}
    ${rules}
    ${warmupAccountQueueHtml(account.id)}
    <div class="warmup-health">
      <label for="warmupHealthSelect">Стан</label>
      <select id="warmupHealthSelect">${healthOptions}</select>
      <input id="warmupHealthNote" type="text" placeholder="Що ти побачив?" value="${escapeHtml(account.healthNote || "")}" />
      <button class="text-button" type="button" data-warmup-health>Зберегти</button>
    </div>
    <h3>Сесії</h3>
    <ul class="warmup-sessions">${sessions}</ul>
    <h3>Лог</h3>
    <ul class="warmup-events">${events}</ul>
  `;
  refreshIcons();
}

/**
 * Read the open account's queue again and redraw its card — after a campaign
 * changes, whether the folder feeds this account today may have changed too.
 */
export async function refreshWarmupAccountQueue() {
  const accountId = warmupState.selectedAccountId;
  if (!accountId || !warmupState.detail) return;
  await loadWarmupQueue(accountId);
  renderWarmupDetail();
}

async function loadWarmupQueue(accountId) {
  // The campaign on screen, so the server answers whether *this* one feeds
  // the account by itself today, and from which day it will.
  const campaignId = warmupState.selectedCampaignId || "";
  try {
    const payload = await warmupApi(`/queue?accountId=${encodeURIComponent(accountId)}${campaignId ? `&campaignId=${encodeURIComponent(campaignId)}` : ""}`);
    // Somebody picked another campaign while this was on its way: its answer
    // is about the old one, and the new one's request is already out.
    if (!queueAnswerIsCurrent(campaignId, warmupState.selectedCampaignId)) return;
    warmupState.queues[accountId] = {
      rows: payload.queue || payload.claimed || [],
      reason: payload.reason || "",
      waiting: payload.waiting || [],
      autoFeed: payload.autoFeed || null,
      error: "",
      unavailable: ""
    };
  } catch (error) {
    if (!queueAnswerIsCurrent(campaignId, warmupState.selectedCampaignId)) return;
    warmupState.queues[accountId] = {
      rows: [],
      reason: "",
      // A 409 is the server refusing this account outright — excluded, not
      // warming, paused. That is an answer too, and it carries only `error`.
      error: error.status === 404 ? "" : error.message,
      unavailable: error.status === 404
        ? "Цей сервер ще не тримає черги закріплень, тож звідси нічого не закріпити."
        : ""
    };
  }
}

async function loadWarmupProfiles() {
  // This workspace warms LinkedIn accounts and nothing else; Anty's other
  // profiles are not ours to show.
  const payload = await warmupApi("/profiles?platform=linkedin");
  warmupState.profiles = payload.profiles;
  renderWarmupProfiles();
}

async function loadWarmupAccountDetail(accountId) {
  if (!accountId) {
    warmupState.detail = null;
    renderWarmupDetail();
    return;
  }
  const [accountPayload, sessionsPayload, eventsPayload] = await Promise.all([
    warmupApi(`/accounts?id=${encodeURIComponent(accountId)}`),
    warmupApi(`/sessions?accountId=${encodeURIComponent(accountId)}`),
    warmupApi(`/events?accountId=${encodeURIComponent(accountId)}&limit=30`),
    loadWarmupQueue(accountId)
  ]);
  warmupState.detail = {
    account: accountPayload.account,
    sessions: sessionsPayload.sessions,
    events: eventsPayload.events
  };
  renderWarmupDetail();
}

/** The three actions this system actually performs. Others are kept, not shown. */
export const WARMUP_EDITABLE_KINDS = ["profile_view", "like", "connect"];

export const WARMUP_KIND_LABEL = {
  profile_view: "Перегляди профілів",
  like: "Лайки",
  connect: "Запити в друзі"
};

export async function loadWarmup({ full = true } = {}) {
  if (warmupState.busy) return;
  warmupState.busy = true;
  warmupState.error = "";
  try {
    if (full || !warmupState.config) {
      warmupState.config = await warmupApi("/config");
    }
    renderWarmupConfigNote();
    if (Number.isFinite(warmupState.config?.unreadReplies)) setWarmupUnread(warmupState.config.unreadReplies);
    if (!warmupState.config.configured) {
      warmupState.profiles = [];
      warmupState.foldersReady = false;
      warmupState.campaignsReady = false;
      warmupState.campaignsError = "Прогрів на цьому сервері не налаштований, тож немає папок, на яких будувати кампанію.";
      // The schedule lives in the Anty database too, so it is unreachable for
      // the same reason — and has to say so. Left alone it sat on its loading
      // text for good, which reads as a panel that is still trying.
      warmupState.strategy = null;
      warmupState.strategyDraft = null;
      warmupState.strategyError = "Розклад лежить у базі Anty, а цей сервер до неї не підключений — тож і днів тут показати нізвідки.";
      // Nothing can have arrived on accounts this server cannot even reach, and
      // the config note above already says why. An inbox promising otherwise
      // would be a second, softer answer to the same question.
      warmupState.inbox.available = false;
      renderWarmupProfiles();
      renderWarmupStats();
      renderWarmupStrategy();
      renderWarmupCampaigns();
      return;
    }

    // Reconciling Anty's "profile is running" flag with the sessions table is
    // what makes the Sessions column true; it is cheap and idempotent, so the
    // screen does it on every load rather than relying on somebody remembering.
    await warmupApi("/sync", { method: "POST" }).catch(() => null);

    warmupState.dashboard = await warmupApi("/dashboard");
    renderWarmupStats();
    // The replies, though they have a screen of their own: the accounts table
    // marks each account with its unread count («1 нова відповідь»), and that
    // count comes from this read, not from the menu badge's.
    await loadWarmupInbox();
    // The schedule every account runs on. It depends on nothing else here and
    // nothing here depends on it, so it is read once and left alone.
    await loadWarmupStrategy();
    // Campaigns first: the tick column in the accounts table is drawn from the
    // selected one.
    await loadWarmupCampaigns({ resetForm: full });
    await loadWarmupProfiles();
    if (warmupState.selectedAccountId) await loadWarmupAccountDetail(warmupState.selectedAccountId);
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  } finally {
    warmupState.busy = false;
    refreshIcons();
  }
}

async function warmupControl(action, extra = {}) {
  if (!warmupState.selectedAccountId) return;
  try {
    await warmupApi("/control", {
      method: "POST",
      body: JSON.stringify({ accountId: warmupState.selectedAccountId, action, ...extra })
    });
    await loadWarmup({ full: false });
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  }
}

async function selectWarmupProfile(profileId) {
  const profile = warmupState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  warmupState.selectedProfileId = profileId;
  warmupState.selectedAccountId = profile.account?.id || null;
  renderWarmupProfiles();
  await loadWarmupAccountDetail(warmupState.selectedAccountId);
}

/** Put a profile on warm-up: create its account, then start the run. */
async function adoptWarmupProfile(profileId) {
  const profile = warmupState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  try {
    const created = await warmupApi("/accounts", {
      method: "POST",
      body: JSON.stringify({ label: profile.name, profileRemoteId: profile.id })
    });
    warmupState.selectedProfileId = profile.id;
    warmupState.selectedAccountId = created.account.id;
    await warmupControl("start");
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  }
}

document.getElementById("warmupRefreshBtn")?.addEventListener("click", () => loadWarmup());

document.getElementById("warmupProfileTableBody")?.addEventListener("change", (event) => {
  const tick = event.target.closest("[data-warmup-account-tick]");
  if (!tick) return;
  toggleWarmupAccount(tick.dataset.warmupAccountTick, tick.checked);
});

document.getElementById("warmupProfileTableBody")?.addEventListener("click", (event) => {
  // Ticking an account is not the same gesture as opening it.
  if (event.target.closest("[data-warmup-account-tick]")) return;
  const jump = event.target.closest("[data-warmup-inbox-jump]");
  if (jump) {
    event.stopPropagation();
    showWarmupInboxAccount(jump.dataset.warmupInboxJump);
    return;
  }
  const row = event.target.closest("[data-warmup-profile]");
  if (!row) return;
  const profileId = row.dataset.warmupProfile;
  if (event.target.closest("[data-warmup-adopt]")) {
    adoptWarmupProfile(profileId);
    return;
  }
  selectWarmupProfile(profileId);
});

document.getElementById("warmupDetailBody")?.addEventListener("click", (event) => {
  const control = event.target.closest("[data-warmup-control]");
  if (control) {
    warmupControl(control.dataset.warmupControl);
    return;
  }
  if (event.target.closest("[data-warmup-health]")) {
    const health = document.getElementById("warmupHealthSelect")?.value;
    const note = document.getElementById("warmupHealthNote")?.value || "";
    warmupApi("/accounts/health", {
      method: "POST",
      body: JSON.stringify({ accountId: warmupState.selectedAccountId, health, note })
    })
      .then(() => loadWarmup({ full: false }))
      .catch((error) => {
        warmupState.error = error.message;
        renderWarmupConfigNote();
      });
  }
});

/** Статус — це дані; пігулка на екрані — це текст. */
/**
 * Статуси аутрічу українською — єдине місце, де вони стають словами.
 *
 * Мапа була написана під статуси, яких сервер ніколи не писав («replied»,
 * «skipped», «failed»), і не мала трьох, які він пише. Невідомий статус падав
 * сюди англійським рядком посеред українського екрана. Тут рівно той набір, що
 * існує в OUTREACH_STATUSES плюс дві машинні черги.
 */
export const WARMUP_OUTREACH_LABEL = {
  waiting: "у черзі на запит",
  queued: "закріплено",
  pending: "запит надіслано",
  accepted: "прийняв(ла)",
  connected: "відповів(ла)",
  declined: "не прийняв(ла)",
  withdrawn: "запит зник"
};

export const WARMUP_OUTREACH_TONE = {
  waiting: "tone-warn",
  queued: "tone-muted",
  pending: "tone-muted",
  accepted: "tone-live",
  connected: "tone-live",
  declined: "tone-bad",
  withdrawn: "tone-bad"
};
