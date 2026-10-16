// Прогрів — the accounts: the table, one line on how the day is going, and one
// account's card with who waits on it. The campaign that feeds them lives in
// warmup-campaign.js.

import {
  autoFeedFor, inviteAttentionText, queueAnswerIsCurrent
} from "../warmup-view.js";
import {
  api, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural
} from "../core.js";
import { onCacheReset, recallScreen, rememberScreen } from "../cache.js";
import { accountLeadgenSlot, fillAccountLeadgen } from "../account-leadgen.js";
import {
  loadWarmupInbox, setWarmupUnread, showWarmupInboxAccount, showWarmupInboxThread, warmupAccountRepliesHtml, warmupInboxUnreadFor
} from "./inbox.js";
import {
  loadWarmupCampaigns, loadWarmupStrategy, renderWarmupCampaignDetail, renderWarmupCampaigns, renderWarmupStrategy, toggleWarmupAccount, warmupAccountCampaign, warmupAutoFeedHtml, warmupEditsInProgress
} from "./warmup-campaign.js";

onScreen("warmup", { open: () => loadWarmup() });

// Where the account's card lives when no row holds it (see parkWarmupDetail).
let detailHome = null;
// The last card read for each account: shown at once when it is opened again.
const warmupDetailCache = new Map();

export const warmupState = {
  // Вимкнені, з тегами й Ban — згорнуті під робочими (аудит 16.10); розгортаються кнопкою.
  showIdleProfiles: false,
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

const WARMUP_INITIAL = JSON.stringify(warmupState);

onCacheReset(resetWarmupScreen);

function resetWarmupScreen() {
  warmupRecalled = false;
  warmupInboxRecalled = false;
  Object.assign(warmupState, JSON.parse(WARMUP_INITIAL));
  // The shell can become visible before new reads settle. Erase old account
  // names and campaign text now, while the previous session is being closed.
  // The campaign panel's own markup (and the listeners bound to it) is built
  // once by warmup-campaign.js: only the parts that carry another person's data
  // are cleared. Clearing the whole panel left an empty frame for the rest of
  // the session (12.10, the owner: «тут немає блоку»).
  // The card may sit under a row of the table about to be emptied: home first.
  parkWarmupDetail();
  for (const id of ["warmupCampaignList", "warmupCampaignDetail", "warmupCampaignFormNote", "warmupProfileTableBody", "warmupDetailBody", "warmupDetailSubtitle", "warmupSummary", "warmupConfigNote"]) {
    const element = document.getElementById(id);
    if (element) element.textContent = "";
  }
  const detail = document.getElementById("warmupDetailPanel");
  if (detail) detail.hidden = true;
  const title = document.getElementById("warmupDetailTitle");
  if (title) title.textContent = "Акаунт";
}

export function warmupApi(path, options) {
  return api(`/api/warmup${path}`, options);
}

/** Дії прогріву й стани акаунта — українською, однаково в картці й у сесіях. */
const WARMUP_KIND_UA = { profile_view: "Перегляди профілів", like: "Лайки", connect: "Запити в друзі", post_comment: "Коментарі", follow: "Підписки", message: "Повідомлення" };
const WARMUP_HEALTH_LABEL = { ok: "Усе гаразд", needs_login: "Потрібен вхід", captcha: "Капча", blocked: "Заблоковано" };

const WARMUP_STATUS_TONE = {
  warming: "tone-live",
  working: "tone-live",
  limited: "tone-warn",
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
  // LinkedIn will not take new invitations this week; the account rests until it will.
  limited: "Ліміт LinkedIn",
  paused: "На паузі",
  blocked: "Заблоковано",
  needs_attention: "Потребує уваги",
  finished: "Завершено",
  excluded: "Виключено",
  off: "Вимкнено"
};

/** «до 11.10» from "2026-10-11" — the last date the pause holds. */
function warmupPauseUntil(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return match ? `до ${match[3]}.${match[2]}` : "";
}

/** The status pill, with the pause's last date beside a pause or a limit. */
export function warmupStatusPill(profile) {
  const status = profile.status;
  const until = (status === "paused" || status === "limited") ? warmupPauseUntil(profile.pause?.until) : "";
  const title = status === "limited"
    ? "LinkedIn не приймає нових запитів у друзі з цього акаунта: досягнуто тижневого ліміту запрошень. Акаунт відпочиває й продовжить сам."
    : status === "paused" ? "Зупинено після попередження LinkedIn. Акаунт продовжить сам." : "";
  const label = `${WARMUP_STATUS_LABEL[status] || status}${until ? ` · ${until}` : ""}`;
  return `<span class="pill ${WARMUP_STATUS_TONE[status] || "tone-muted"}"${title ? ` title="${escapeAttr(title)}"` : ""}>${escapeHtml(label)}</span>`;
}

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

/**
 * On a phone the status, the day and today's requests do not get columns of
 * their own — the table would not fit 390px — so they ride under the name.
 */
function warmupPhoneLine(profile) {
  const { today = 0, quota = 0 } = profile.connections || {};
  const parts = [];
  if (profile.day) parts.push(`день ${profile.day}`);
  if (quota > 0) parts.push(`${today}/${quota} сьогодні`);
  return parts.join(" · ");
}

function warmupConnectionsCell(profile) {
  const { today = 0, total = 0, quota = 0, startsDay = null, off = false } = profile.connections || {};
  const week = profile.connections?.weekly;
  const all = `title="${total} за весь час${week ? ` · ${week.done}/${week.limit} за 7 днів` : ""}"`;
  let count;
  if (off) count = `<span class="pill tone-muted" ${all}>вимкнено</span>`;
  else if (quota > 0) count = `<span ${all}>${today}/${quota}</span>`;
  else if (startsDay) count = `<span class="warmup-subtle" ${all}>з ${startsDay}-го дня</span>`;
  // No requests today: the column is about today, so it says nothing — the
  // all-time count read as today's in a column headed «сьогодні».
  else count = `<span class="warmup-subtle" ${all}>—</span>`;
  return `<span class="warmup-invites-cell">${count}${warmupInvitesSwitchHtml(profile)}</span>`;
}

/**
 * Запити в друзі з цього акаунта — увімкнено чи ні (власник 16.10: «Profile 42
 * тільки він хай додає в друзі всі інші ні і це має бути видно в інтерфейсі»).
 * Off holds back requests only: views, likes, the inbox and replies go on.
 */
function warmupInvitesSwitchHtml(profile) {
  const account = profile.account;
  if (!account) return "";
  const off = Boolean(profile.connections?.off);
  const title = off
    ? "Запити в друзі з цього акаунта вимкнено. Натисніть, щоб увімкнути."
    : "Цей акаунт надсилає запити в друзі. Натисніть, щоб вимкнути — решта роботи акаунта триває.";
  return `<button type="button" class="warmup-invites-switch ${off ? "is-off" : "is-on"}" role="switch" aria-checked="${!off}" data-warmup-invites="${escapeAttr(account.id)}" data-warmup-invites-on="${off ? "1" : "0"}" title="${escapeAttr(title)}" aria-label="${escapeAttr(`Запити в друзі з ${profile.name}: ${off ? "вимкнено" : "увімкнено"}`)}"><i data-lucide="${off ? "user-x" : "user-plus"}"></i></button>`;
}

async function setWarmupInvites(accountId, enabled) {
  const profile = warmupState.profiles.find((row) => row.account?.id === accountId);
  if (profile) {
    profile.connections = { ...(profile.connections || {}), off: !enabled, ...(enabled ? {} : { quota: 0 }) };
    renderWarmupProfiles();
  }
  try {
    await warmupApi("/accounts/invites", { method: "POST", body: JSON.stringify({ accountId, enabled }) });
  } catch (error) {
    if (profile) profile.connections = { ...(profile.connections || {}), off: enabled };
    renderWarmupProfiles();
    window.alert?.(error?.message || "Не вдалося змінити запити в друзі.");
    return;
  }
  await loadWarmupProfiles().catch(() => {});
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
 * «Веде» in the card as well as in the table: on a phone the card is where an
 * account is looked at, and whether it works the campaign is the first thing
 * to see or change there. The same tick, the same save.
 */
/** Колонка «Автозапити» в таблиці прогріву: що веде акаунт; змінюється в блоці вище. */
function warmupCampaignCellHtml(accountId) {
  const campaign = warmupAccountCampaign(accountId);
  if (!campaign) return '<span class="warmup-subtle" title="Акаунти автозапитів обирають у блоці «Автозапити в друзі» вище">—</span>';
  return `<span class="warmup-campaign-chip ${campaign.state === "running" ? "is-running" : ""}" title="${escapeAttr(`Веде «${campaign.name || "без назви"}»${campaign.state === "running" ? "" : " — не запущена"}. Змінюється в блоці «Автозапити в друзі».`)}">${escapeHtml(campaign.name || "без назви")}</span>`;
}

function warmupCardCampaignHtml(accountId) {
  const campaign = warmupAccountCampaign(accountId);
  if (!campaign) return `<p class="warmup-card-campaign">Автозапитів не веде.</p>`;
  return `<p class="warmup-card-campaign">Автозапити «${escapeHtml(campaign.name || "без назви")}»${campaign.state === "running" ? "" : " · не запущені"}</p>`;
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

// ── теги профілю Anty (власник 16.10: «додай в табличці статуси tags … і
// можливість їх редагувати») ──────────────────────────────────────────────
// The same tags the Anty app shows on the profile; saved straight into it.
const tagsEdit = { profileId: null, draft: [], busy: false, error: "" };

function warmupTagTone(tag) {
  if (/ban|бан|мертв|dead|блок/i.test(tag)) return "tone-warn";
  if (/жив|live|active|ok/i.test(tag)) return "tone-live";
  return "tone-muted";
}

/**
 * The table's order (власник 16.10): accounts that are warming first, then the
 * rest without tags, then those with tags, and those marked «Ban» last. Within
 * a group — as the server sent them (by name).
 */
function warmupProfileRank(profile) {
  const tags = profile.tags || [];
  if (tags.some((tag) => /^ban$|бан/i.test(tag))) return 3;
  if (profile.account && ["warming", "working", "paused", "limited", "needs_attention"].includes(profile.status)) return 0;
  return tags.length ? 2 : 1;
}

function warmupSortedProfiles(profiles) {
  return profiles.map((profile, index) => ({ profile, index }))
    .sort((left, right) => warmupProfileRank(left.profile) - warmupProfileRank(right.profile) || left.index - right.index)
    .map((item) => item.profile);
}

function warmupTagsCell(profile) {
  const tags = profile.tags || [];
  if (tagsEdit.profileId !== profile.id) {
    return `<div class="warmup-tags">${tags.map((tag) => `<span class="pill ${warmupTagTone(tag)}">${escapeHtml(tag)}</span>`).join("")}
      <button type="button" class="icon-button warmup-tags-edit" data-warmup-tags-edit="${escapeAttr(profile.id)}" aria-label="Змінити теги" title="Змінити теги — так само, як в Anty"><i data-lucide="${tags.length ? "pencil" : "tag"}"></i></button></div>`;
  }
  const known = (warmupState.knownTags || []).filter((tag) => !tagsEdit.draft.some((item) => item.toLowerCase() === tag.toLowerCase()));
  return `<div class="warmup-tags-editor" data-warmup-tags-editor>
    <div class="warmup-tags">${tagsEdit.draft.map((tag, index) => `<span class="pill ${warmupTagTone(tag)}">${escapeHtml(tag)}<button type="button" data-warmup-tag-drop="${index}" aria-label="Прибрати ${escapeAttr(tag)}">×</button></span>`).join("") || '<span class="warmup-subtle">тегів немає</span>'}</div>
    ${known.length ? `<div class="warmup-tags warmup-tags-known">${known.map((tag) => `<button type="button" class="pill tone-muted" data-warmup-tag-add="${escapeAttr(tag)}">+ ${escapeHtml(tag)}</button>`).join("")}</div>` : ""}
    <form class="warmup-tags-form" data-warmup-tags-form><input name="tag" maxlength="40" placeholder="Новий тег" autocomplete="off" />
      <button type="submit" class="primary-button"${tagsEdit.busy ? " disabled" : ""}>${tagsEdit.busy ? "Зберігаю..." : "Зберегти"}</button>
      <button type="button" class="text-button" data-warmup-tags-cancel>Скасувати</button></form>
    ${tagsEdit.error ? `<small class="warmup-tags-error">${escapeHtml(tagsEdit.error)}</small>` : ""}
  </div>`;
}

function addDraftTag(value) {
  const tag = String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (tag && !tagsEdit.draft.some((item) => item.toLowerCase() === tag.toLowerCase())) tagsEdit.draft.push(tag);
}

async function saveWarmupTags(profileId, typed) {
  addDraftTag(typed);
  tagsEdit.busy = true;
  tagsEdit.error = "";
  renderWarmupProfiles();
  try {
    await warmupApi("/profiles", { method: "PATCH", body: JSON.stringify({ id: profileId, tags: tagsEdit.draft }) });
    const profile = warmupState.profiles.find((row) => row.id === profileId);
    if (profile) profile.tags = [...tagsEdit.draft];
    for (const tag of tagsEdit.draft) if (!(warmupState.knownTags || []).some((item) => item.toLowerCase() === tag.toLowerCase())) (warmupState.knownTags ||= []).push(tag);
    Object.assign(tagsEdit, { profileId: null, draft: [], busy: false });
  } catch (error) {
    tagsEdit.busy = false;
    tagsEdit.error = error?.message || "Теги не збереглися.";
  }
  renderWarmupProfiles();
}

// The account's card opens under its own row (власник 16.10: «воно має
// розгортатися під аккаунтом при відкритті»), not at the foot of the page. The
// card is one element with its listeners; it is moved, never rebuilt — taken
// back to its place before the table is redrawn, then put under the row.
function parkWarmupDetail() {
  const panel = document.getElementById("warmupDetailPanel");
  if (!panel) return null;
  detailHome ||= { parent: panel.parentElement, next: panel.nextSibling };
  if (panel.parentElement !== detailHome.parent) detailHome.parent.insertBefore(panel, detailHome.next);
  return panel;
}

function placeWarmupDetail(body) {
  const panel = document.getElementById("warmupDetailPanel");
  const row = warmupState.selectedProfileId ? body.querySelector(`tr[data-warmup-profile="${CSS.escape(warmupState.selectedProfileId)}"]`) : null;
  if (!panel || !row || !warmupState.selectedAccountId) return;
  const holder = document.createElement("tr");
  holder.className = "warmup-detail-row";
  const cell = document.createElement("td");
  cell.colSpan = 7;
  cell.appendChild(panel);
  holder.appendChild(cell);
  row.after(holder);
}

export function renderWarmupProfiles() {
  const body = document.getElementById("warmupProfileTableBody");
  if (!body) return;
  parkWarmupDetail();

  if (!warmupState.profiles.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state">Акаунтів LinkedIn в Anty немає.</div></td></tr>';
    renderWarmupCampaignDetail();
    return;
  }

  // Робочі акаунти — зверху; решта (вимкнені, з тегами, Ban) — згорнута групою під ними,
  // якщо серед них не відкрито той, на який дивляться (аудит 16.10, P2).
  const sorted = warmupSortedProfiles(warmupState.profiles);
  const idle = sorted.filter((profile) => warmupProfileRank(profile) > 0);
  const showIdle = warmupState.showIdleProfiles || idle.some((profile) => profile.id === warmupState.selectedProfileId);
  const shown = showIdle ? sorted : sorted.filter((profile) => warmupProfileRank(profile) === 0);
  const idleToggle = idle.length && idle.length < sorted.length
    ? `<tr class="warmup-idle-toggle"><td colspan="7"><button class="text-button" type="button" data-warmup-idle-toggle aria-expanded="${showIdle}"><i data-lucide="${showIdle ? "chevron-up" : "chevron-down"}"></i><span>${showIdle ? "Сховати" : "Показати"} ще ${idle.length} — вимкнені, з тегами, Ban</span></button></td></tr>`
    : "";
  const firstIdle = idle[0]?.id;

  body.innerHTML = shown
    .map((profile) => (profile.id === firstIdle ? idleToggle : "") + (() => {
      const status = profile.status;
      const account = profile.account;
      // The person the browser is actually signed in as, which is not the same
      // string as the profile label somebody typed in Anty.
      const identity = profile.identity || account?.identity || null;
      return `
        <tr data-warmup-profile="${escapeHtml(profile.id)}" class="${profile.id === warmupState.selectedProfileId ? "is-selected" : ""}">
          <td class="warmup-tick">
            ${account
              ? warmupCampaignCellHtml(account.id)
              : '<span class="warmup-subtle" title="Ще не на прогріві, тож із нього не можна надсилати">—</span>'}
          </td>
          <td>
            <strong>${escapeHtml(profile.name)}</strong>
            ${account ? warmupAccountUnreadHtml(account.id) : ""}
            ${identity?.name
              ? `<div class="warmup-identity" title="На останньому вході агента залогінений як ця особа"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}</span></div>`
              : ""}
            ${profile.proxy ? "" : '<div class="warmup-subtle warmup-no-proxy" title="LinkedIn бачить справжню адресу цього профілю">без проксі</div>'}
            <div class="warmup-row-phone">${warmupStatusPill(profile)}${account && warmupPhoneLine(profile) ? ` <span class="warmup-subtle">${escapeHtml(warmupPhoneLine(profile))}</span>` : ""}</div>
          </td>
          <td>${warmupStatusPill(profile)}</td>
          <td class="warmup-tags-cell">${warmupTagsCell(profile)}</td>
          <td>${escapeHtml(profile.day || "—")}</td>
          <td>${warmupConnectionsCell(profile)}</td>
          <td>${account
            ? warmupNextSessionCell(profile)
            : warmupProfileRank(profile) === 3
              // Тег Ban: основна зелена кнопка тут підштовхувала прогрівати забанений акаунт (аудит 16.10, P1).
              ? '<button class="text-button" type="button" data-warmup-adopt title="Тег Ban — акаунт забанено в LinkedIn. Прогрівати, лише якщо його розбанили.">Прогріти</button>'
              : '<button class="primary-button" type="button" data-warmup-adopt>Прогріти</button>'}</td>
        </tr>`;
    })())
    .join("") + (!showIdle && idleToggle ? idleToggle : "");

  placeWarmupDetail(body);
  renderWarmupCampaignDetail();
  refreshIcons();
}

function renderWarmupDetail() {
  const title = document.getElementById("warmupDetailTitle");
  const subtitle = document.getElementById("warmupDetailSubtitle");
  const body = document.getElementById("warmupDetailBody");
  if (!title || !body) return;

  const detail = warmupState.detail;
  // No card until an account is picked: an empty block saying «pick one» was
  // only something to scroll past on the way to the campaign.
  const panel = document.getElementById("warmupDetailPanel");
  if (panel) panel.hidden = !detail;
  if (!detail) {
    body.innerHTML = "";
    return;
  }
  // Opened, not read yet: the card stands under the row at once and fills in.
  if (detail.loading) {
    title.textContent = detail.label || "Акаунт";
    subtitle.textContent = "";
    body.innerHTML = '<div class="empty-state">Завантажую…</div>';
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

  // Українською, а не ключами сервера: «Profile views 8/8» і «connect: 3»
  // читалися як лог, а не як картка людини (12.10, власник: «зробити толковіше»).
  const tiles = warmup && !warmup.finished
    ? (warmupState.config?.actionKinds || [])
        .map(({ kind, label }) => {
          const quota = warmup.quotas[kind] ?? 0;
          const done = warmup.done[kind] ?? 0;
          const name = WARMUP_KIND_UA[kind] || label;
          if (quota === 0) {
            return `<div class="wa-tile is-off"><span class="wa-tile-name">${escapeHtml(name)}</span><span class="wa-tile-off">сьогодні не можна</span></div>`;
          }
          const full = done >= quota;
          return `<div class="wa-tile ${full ? "is-done" : ""}">
              <span class="wa-tile-name">${escapeHtml(name)}</span>
              <strong class="wa-tile-value">${done}<small>/${quota}</small></strong>
              <span class="wa-bar"><span style="width:${quota ? Math.min(100, Math.round((done / quota) * 100)) : 0}%"></span></span>
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
    controls.push('<button type="button" data-warmup-control="warning"><i data-lucide="triangle-alert"></i><span>Прилетіло попередження</span></button>');
    controls.push('<button class="danger-button" type="button" data-warmup-control="stop"><i data-lucide="square"></i><span>Зупинити</span></button>');
  }

  // 12.10, the owner: a blocked account is put away by one button, and from
  // then on it raises nothing anywhere; the same button brings it back.
  if (account.status !== "excluded") {
    controls.push(account.health === "blocked"
      ? '<button class="text-button" type="button" data-warmup-block="ok">Розблокувати</button>'
      : '<button class="danger-button" type="button" data-warmup-block="blocked" title="LinkedIn заблокував акаунт: агент його більше не відкриває, і він ніде не висить жовтим"><i data-lucide="ban"></i><span>Позначити заблокованим</span></button>');
  }

  const healthOptions = (warmupState.config?.healthValues || [])
    .map(({ value, label }) => `<option value="${escapeHtml(value)}" ${account.health === value ? "selected" : ""}>${escapeHtml(WARMUP_HEALTH_LABEL[value] || label)}</option>`)
    .join("");

  const rules = warmup?.rules?.length
    ? `<ul class="warmup-rules wa-rules">${warmup.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}</ul>`
    : "";

  const did = (session) => Object.entries(session.actions || {})
    .map(([kind, count]) => `${WARMUP_KIND_UA[kind] || kind} ${count}`).join(" · ");
  const sessions = detail.sessions.length
    ? `<div class="table-wrap"><table class="wa-sessions">
        <thead><tr><th>Коли</th><th>Тривалість</th><th>Хто</th><th>Що зроблено</th></tr></thead>
        <tbody>${detail.sessions.slice(0, 8).map((session) => `<tr>
          <td>${escapeHtml(new Date(session.startedAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</td>
          <td>${session.endedAt ? `${session.durationMin} хв` : '<span class="pill tone-live">іде зараз</span>'}</td>
          <td>${escapeHtml(session.source === "agent" ? "агент" : session.source === "manual" ? "вручну" : session.source || "")}</td>
          <td>${did(session) ? escapeHtml(did(session)) : '<span class="wa-muted">нічого не зроблено</span>'}</td>
        </tr>`).join("")}</tbody></table></div>`
    : '<p class="wa-muted">Сесій ще не записано.</p>';

  const events = detail.events.length
    ? detail.events
        .slice(0, 12)
        .map((event) => `<li class="level-${escapeHtml(event.level)}"><span>${new Date(event.created_at).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span> ${escapeHtml(event.message)}</li>`)
        .join("")
    : "<li>У лозі ще порожньо.</li>";

  const queue = warmupAccountQueueHtml(account.id);
  const campaignTick = warmupCardCampaignHtml(account.id);

  body.innerHTML = `
    <div class="warmup-detail-controls wa-controls">${controls.join("")}</div>
    ${warmupAccountRepliesHtml(account.id)}
    ${warmup?.state === "paused" && warmup.pausedUntil
      ? warmup.pauseCause === "invite_limit"
        ? `<p class="warmup-paused">Ліміт LinkedIn: з цього акаунта LinkedIn тиждень не приймає нових запитів у друзі («${escapeHtml(warmup.pauseNote || "запрошення не надіслано")}»). Ліміт рахує всі запити за останні 7 днів, зокрема надіслані поза цією системою. До ${escapeHtml(warmup.pausedUntil)} включно акаунт нічого не робить, далі прогрів продовжиться сам, а ці дні в нього не рахуються.</p>`
        : `<p class="warmup-paused">На паузі після попередження: до ${escapeHtml(warmup.pausedUntil)} включно акаунт нічого не робить. Далі прогрів продовжиться сам, а дні паузи в нього не рахуються.</p>`
      : ""}
    ${tiles ? `<section class="wa-section">
      <h3>Сьогодні</h3>
      <div class="wa-tiles warmup-actions">${tiles}</div>
      ${rules}
    </section>` : ""}
    ${campaignTick || queue ? `<section class="wa-section">
      <h3>Кампанія й черга</h3>
      ${campaignTick}
      ${queue}
    </section>` : ""}
    ${warmupPeople.accountId === account.id ? warmupPeopleSectionHtml() : ""}
    <section class="wa-section">
      <h3>Стан акаунта</h3>
      <div class="warmup-health wa-health">
        <select id="warmupHealthSelect" aria-label="Стан акаунта">${healthOptions}</select>
        <input id="warmupHealthNote" type="text" placeholder="Що ти побачив?" value="${escapeHtml(account.healthNote || "")}" />
        <button type="button" data-warmup-health><i data-lucide="save"></i><span>Зберегти</span></button>
      </div>
    </section>
    ${accountLeadgenSlot(account.id)}
    <section class="wa-section">
      <h3>Сесії</h3>
      ${sessions}
    </section>
    <details class="wa-section wa-log">
      <summary><h3>Лог</h3><span class="wa-muted">${detail.events.length ? `останні: ${Math.min(12, detail.events.length)}` : "порожньо"}</span></summary>
      <ul class="warmup-events">${events}</ul>
    </details>
  `;
  refreshIcons();
  void fillAccountLeadgen();
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
  warmupState.knownTags = payload.knownTags || [];
  renderWarmupProfiles();
}

async function loadWarmupAccountDetail(accountId) {
  if (!accountId) {
    warmupState.detail = null;
    renderWarmupDetail();
    return;
  }
  // Власник 16.10: «додаткова інформація довго відкривається». The card opens
  // at once — with what was read last time for this account, or «Завантажую…» —
  // and the queue (the slow CRM read) no longer holds the rest back.
  const label = warmupState.profiles.find((row) => row.account?.id === accountId)?.name || "";
  warmupState.detail = warmupDetailCache.get(accountId) || { loading: true, label };
  renderWarmupDetail();
  void loadWarmupQueue(accountId).then(() => {
    if (warmupState.selectedAccountId === accountId && !warmupState.detail?.loading) renderWarmupDetail();
  });
  const [accountPayload, sessionsPayload, eventsPayload] = await Promise.all([
    warmupApi(`/accounts?id=${encodeURIComponent(accountId)}`),
    warmupApi(`/sessions?accountId=${encodeURIComponent(accountId)}`),
    warmupApi(`/events?accountId=${encodeURIComponent(accountId)}&limit=30`)
  ]);
  // Another account was opened (or this one closed) while these were on their way.
  if (warmupState.selectedAccountId !== accountId) return;
  warmupState.detail = {
    account: accountPayload.account,
    sessions: sessionsPayload.sessions,
    events: eventsPayload.events
  };
  warmupDetailCache.set(accountId, warmupState.detail);
  if (warmupPeople.accountId !== accountId) warmupPeople = { accountId, rows: null, error: "", search: "", filter: "friends" };
  renderWarmupDetail();
  void loadWarmupPeople(accountId);
}

// ── Друзі й запрошення (12.10, власник: «список друзів, пошук по них») ────
//
// Люди, яким цей акаунт надсилав запит, і що з того вийшло: друзі — ті, хто
// прийняв (і, можливо, вже відповів). Повного списку контактів LinkedIn агент
// не читає, тож тут — ті, кого привела ця система.
const WARMUP_FRIEND_STATUSES = new Set(["accepted", "connected"]);
const WARMUP_PEOPLE_FILTERS = [
  ["all", "Усі", () => true],
  ["friends", "Друзі", (row) => WARMUP_FRIEND_STATUSES.has(row.status)],
  ["pending", "Чекають", (row) => row.status === "pending"],
  ["declined", "Не прийняли", (row) => row.status === "declined" || row.status === "withdrawn"]
];
let warmupPeople = { accountId: null, rows: null, error: "", search: "", filter: "friends" };
// Усі друзі LinkedIn (14.10): те, що агент прочитав зі сторінки «Контакти».
let warmupNetwork = { accountId: null, data: null, error: "", busy: false, shown: 50 };
const WARMUP_NETWORK_FILTER = "linkedin";

async function loadWarmupNetwork(accountId) {
  if (warmupNetwork.accountId !== accountId) warmupNetwork = { accountId, data: null, error: "", busy: false, shown: 50 };
  try {
    const payload = await warmupApi(`/network?accountId=${encodeURIComponent(accountId)}`);
    if (warmupNetwork.accountId !== accountId) return;
    warmupNetwork.data = payload.network || null;
    warmupNetwork.error = "";
  } catch (error) {
    if (warmupNetwork.accountId !== accountId) return;
    warmupNetwork.error = error.status === 404 ? "" : error.message;
  }
}

const warmupSlugOf = (link) => String(link || "").match(/\/in\/([^/?#]+)/)?.[1]?.toLowerCase() || "";

export async function loadWarmupPeople(accountId) {
  if (warmupPeople.accountId !== accountId) warmupPeople = { accountId, rows: null, error: "", search: "", filter: "friends" };
  try {
    const [payload] = await Promise.all([
      warmupApi(`/outreach?accountId=${encodeURIComponent(accountId)}&limit=500`),
      loadWarmupNetwork(accountId)
    ]);
    if (warmupPeople.accountId !== accountId) return;
    warmupPeople.rows = payload.outreach || [];
    warmupPeople.error = "";
  } catch (error) {
    if (warmupPeople.accountId !== accountId) return;
    warmupPeople.error = error.status === 404 ? "" : error.message;
    warmupPeople.rows = warmupPeople.rows || [];
  }
  const section = document.getElementById("warmupPeopleSection");
  if (section) section.outerHTML = warmupPeopleSectionHtml();
  else if (warmupState.detail?.account?.id === accountId) renderWarmupDetail();
  refreshIcons();
}

function warmupPeopleMatches(row) {
  const words = warmupPeople.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [row.personName, row.personPosition, row.personCompany, row.personCountry].filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

const warmupShortDate = (iso) => (iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—");

function warmupNetworkListHtml() {
  const data = warmupNetwork.data;
  const people = data?.people || [];
  const words = warmupPeople.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = people.filter((person) => { const text = `${person.name} ${person.headline}`.toLowerCase(); return words.every((word) => text.includes(word)); });
  const ours = new Map((warmupPeople.rows || []).map((row) => [warmupSlugOf(row.personLinkedin), row]).filter(([slug]) => slug));
  const asked = data?.requestedAt && (!data.syncedAt || Date.parse(data.requestedAt) > Date.parse(data.syncedAt));
  const status = !data?.syncedAt
    ? "Список ще не читали — агент прочитає сторінку LinkedIn «Контакти» в найближчій сесії акаунта."
    : `Прочитано зі сторінки LinkedIn «Контакти» ${escapeHtml(warmupShortDate(data.syncedAt))}: ${people.length}${data.total ? ` з ${data.total}` : ""}${data.complete ? "" : " — не до кінця, решта підтягнеться наступного разу"}. Оновлюється раз на 3 дні.`;
  const refresh = asked
    ? '<span class="wa-muted">Оновлення замовлено — агент перечитає в найближчій сесії.</span>'
    : `<button type="button" class="text-button" data-warmup-network-refresh${warmupNetwork.busy ? " disabled" : ""}><i data-lucide="refresh-cw"></i><span>Оновити</span></button>`;
  const head = `<div class="wa-network-status"><span class="wa-muted">${status}</span>${refresh}</div>${warmupNetwork.error ? `<p class="warmup-queue-reason is-bad">${escapeHtml(warmupNetwork.error)}</p>` : ""}`;
  if (!shown.length) return `${head}${people.length ? '<p class="wa-muted">Нікого не знайдено — змініть пошук.</p>' : ""}`;
  return `${head}<div class="table-wrap"><table class="wa-people">
    <thead><tr><th>Людина</th><th>У друзях з</th><th>Звідки</th><th></th></tr></thead>
    <tbody>${shown.slice(0, warmupNetwork.shown).map((person) => {
      const row = ours.get(person.slug);
      return `<tr>
      <td>${row?.crmContactId
        ? `<button type="button" class="wa-person-link" data-warmup-person="${escapeAttr(row.crmContactId)}">${escapeHtml(person.name)}</button>`
        : `<strong>${escapeHtml(person.name)}</strong>`}<small>${escapeHtml(person.headline || "")}</small></td>
      <td>${person.connectedAt ? escapeHtml(warmupShortDate(person.connectedAt)) : "—"}</td>
      <td>${row ? '<span class="pill tone-good">через систему</span>' : '<span class="wa-muted">поза системою</span>'}</td>
      <td><a class="icon-button" href="https://www.linkedin.com/in/${escapeAttr(encodeURIComponent(person.slug))}/" target="_blank" rel="noopener" aria-label="Відкрити LinkedIn" title="Відкрити LinkedIn"><i data-lucide="external-link"></i></a></td>
    </tr>`;
    }).join("")}</tbody></table></div>${shown.length > warmupNetwork.shown ? `<p class="wa-network-more"><span class="wa-muted">Показано ${warmupNetwork.shown} з ${shown.length}</span><button type="button" class="text-button" data-warmup-network-more>Показати ще 50</button></p>` : ""}`;
}

function warmupPeopleListHtml() {
  if (warmupPeople.filter === WARMUP_NETWORK_FILTER) return warmupNetworkListHtml();
  const rows = warmupPeople.rows || [];
  const test = (WARMUP_PEOPLE_FILTERS.find(([key]) => key === warmupPeople.filter) || WARMUP_PEOPLE_FILTERS[0])[2];
  const shown = rows.filter(test).filter(warmupPeopleMatches);
  if (!shown.length) {
    return `<p class="wa-muted">${rows.length ? "Нікого не знайдено — змініть пошук чи фільтр." : "Цей акаунт ще нікому не надсилав запитів."}</p>`;
  }
  return `<div class="table-wrap"><table class="wa-people">
    <thead><tr><th>Людина</th><th>Стан</th><th>Запит</th><th>Прийняв(ла)</th><th></th></tr></thead>
    <tbody>${shown.slice(0, 300).map((row) => `<tr>
      <td>${row.crmContactId
        ? `<button type="button" class="wa-person-link" data-warmup-person="${escapeAttr(row.crmContactId)}">${escapeHtml(row.personName || "без імені")}</button>`
        : `<strong>${escapeHtml(row.personName || "без імені")}</strong>`}
        <small>${escapeHtml([row.personPosition, row.personCompany].filter(Boolean).join(" · "))}</small></td>
      <td><span class="pill ${WARMUP_OUTREACH_TONE[row.status] || "tone-muted"}">${escapeHtml(WARMUP_OUTREACH_LABEL[row.status] || row.status)}</span></td>
      <td>${escapeHtml(warmupShortDate(row.createdAt))}</td>
      <td>${WARMUP_FRIEND_STATUSES.has(row.status) ? escapeHtml(warmupShortDate(row.respondedAt)) : "—"}</td>
      <td>${row.personLinkedin ? `<a class="icon-button" href="${escapeAttr(row.personLinkedin)}" target="_blank" rel="noopener" aria-label="Відкрити LinkedIn" title="Відкрити LinkedIn"><i data-lucide="external-link"></i></a>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>${shown.length > 300 ? `<p class="wa-muted">Показано 300 з ${shown.length} — уточніть пошук.</p>` : ""}`;
}

function warmupPeopleSectionHtml() {
  const rows = warmupPeople.rows;
  return `<section class="wa-section" id="warmupPeopleSection">
    <h3>Друзі й запрошення</h3>
    ${rows === null ? '<p class="wa-muted">Читаємо...</p>' : warmupPeopleBodyHtml(rows)}
  </section>`;
}

function warmupPeopleBodyHtml(rows) {
  return `
    ${warmupPeople.error ? `<p class="warmup-queue-reason is-bad">${escapeHtml(warmupPeople.error)}</p>` : ""}
    <div class="wa-people-tools">
      <div class="wa-people-filters" role="tablist">${WARMUP_PEOPLE_FILTERS.map(([key, label, test]) => `<button type="button" role="tab" class="${warmupPeople.filter === key ? "is-active" : ""}" aria-selected="${warmupPeople.filter === key}" data-warmup-people-filter="${key}">${label} <b>${rows.filter(test).length}</b></button>`).join("")}<button type="button" role="tab" class="${warmupPeople.filter === WARMUP_NETWORK_FILTER ? "is-active" : ""}" aria-selected="${warmupPeople.filter === WARMUP_NETWORK_FILTER}" data-warmup-people-filter="${WARMUP_NETWORK_FILTER}">Усі друзі LinkedIn <b>${warmupNetwork.data?.syncedAt ? (warmupNetwork.data.total ?? warmupNetwork.data.people.length) : "—"}</b></button></div>
      <label class="wa-people-search"><i data-lucide="search"></i><input type="search" id="warmupPeopleSearch" placeholder="Пошук: ім'я, посада, компанія" value="${escapeAttr(warmupPeople.search)}" /></label>
    </div>
    <div id="warmupPeopleList">${warmupPeopleListHtml()}</div>
    ${warmupPeople.filter === WARMUP_NETWORK_FILTER ? "" : '<p class="wa-muted">Ті, кому цей акаунт надсилав запит через систему. Усіх друзів акаунта видно у вкладці «Усі друзі LinkedIn».</p>'}`;
}

/** The three actions this system actually performs. Others are kept, not shown. */
export const WARMUP_EDITABLE_KINDS = ["profile_view", "like", "connect"];

export const WARMUP_KIND_LABEL = {
  profile_view: "Перегляди профілів",
  like: "Лайки",
  connect: "Запити в друзі"
};

/**
 * What the warm-up and inbox screens keep for this tab (`app/cache.js`): the
 * answers, not what somebody is doing with them — no open form, no draft, no
 * open conversation, no selection.
 */
const WARMUP_REMEMBERED = ["config", "dashboard", "profiles", "strategy", "folders", "foldersReady", "campaigns", "campaignsReady", "campaignsError", "selectedCampaignId", "unreadReplies"];
const WARMUP_INBOX_REMEMBERED = ["threads", "accounts", "unread", "sync", "ready", "available", "error"];

function rememberWarmup() {
  if (warmupState.error) return;
  rememberScreen("warmup", Object.fromEntries(WARMUP_REMEMBERED.map((key) => [key, warmupState[key]])));
  rememberWarmupInbox();
}

/** The inbox has a screen of its own and is remembered on its own, so neither screen's save overwrites the other's. */
export function rememberWarmupInbox() {
  // A failed read is not worth drawing again after a reload: it would greet
  // the next open with an error the fresh read may no longer have.
  if (!warmupState.inbox.ready || warmupState.inbox.error) return;
  rememberScreen("inbox", Object.fromEntries(WARMUP_INBOX_REMEMBERED.map((key) => [key, warmupState.inbox[key]])));
}

let warmupRecalled = false;
let warmupInboxRecalled = false;

/**
 * The last answers, drawn at once — only on the first open after a page load,
 * and only into a screen that has nothing yet. True when something was drawn.
 */
export function recallWarmup() {
  recallWarmupInbox();
  if (warmupRecalled) return false;
  warmupRecalled = true;
  if (warmupState.config) return false;
  const saved = recallScreen("warmup")?.value;
  if (!saved?.config) return false;
  for (const key of WARMUP_REMEMBERED) if (key in saved) warmupState[key] = saved[key];
  return true;
}

export function recallWarmupInbox() {
  if (warmupInboxRecalled) return false;
  warmupInboxRecalled = true;
  if (warmupState.inbox.ready) return false;
  const saved = recallScreen("inbox")?.value;
  if (!saved?.ready) return false;
  for (const key of WARMUP_INBOX_REMEMBERED) if (key in saved) warmupState.inbox[key] = saved[key];
  if (Number.isFinite(warmupState.inbox.unread)) setWarmupUnread(warmupState.inbox.unread);
  return true;
}

/** «Оновити» says when a read is under way, so a screen drawn from memory is not taken for the final word. */
function renderWarmupRefreshing(busy) {
  const button = document.getElementById("warmupRefreshBtn");
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  const label = button.querySelector("span");
  if (label) label.textContent = busy ? "Оновлюю..." : "Оновити";
}

export async function loadWarmup({ full = true } = {}) {
  if (warmupState.busy) return;
  warmupState.busy = true;
  warmupState.error = "";
  if (recallWarmup()) {
    renderWarmupConfigNote();
    renderWarmupStats();
    renderWarmupStrategy();
    renderWarmupCampaigns({ resetForm: true });
    renderWarmupProfiles();
  }
  renderWarmupRefreshing(true);
  // Reconciling Anty's "profile is running" flag with the sessions table is
  // what makes the Sessions column true. It no longer holds the screen up: the
  // table is read with everything else and read once more when this is done.
  const synced = warmupApi("/sync", { method: "POST" }).catch(() => null);
  // Everything at once, the config included: none of these waits on another.
  // Each draws its own part when it lands; the campaigns and the table redraw
  // each other, so the tick column is right whichever comes last.
  const editing = warmupEditsInProgress();
  const reading = Promise.allSettled([
    warmupApi("/dashboard").then((dashboard) => { warmupState.dashboard = dashboard; renderWarmupStats(); }),
    // The replies, though they have a screen of their own: the accounts table
    // marks each account with its unread count («1 нова відповідь»), and that
    // count comes from this read, not from the menu badge's.
    loadWarmupInbox(),
    loadWarmupStrategy({ keepDraft: true }),
    loadWarmupCampaigns({ resetForm: full && !editing.form }),
    loadWarmupProfiles()
  ]);
  try {
    const config = full || !warmupState.config ? await warmupApi("/config") : warmupState.config;
    warmupState.config = config;
    renderWarmupConfigNote();
    if (Number.isFinite(config?.unreadReplies)) setWarmupUnread(config.unreadReplies);
    if (!config.configured) {
      // Let the reads that went out alongside land first, so none of them
      // draws over the sentences below.
      await reading;
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

    const parts = await reading;
    const failed = parts.find((part) => part.status === "rejected");
    if (failed) throw failed.reason;
    if (warmupState.selectedAccountId) await loadWarmupAccountDetail(warmupState.selectedAccountId);
    rememberWarmup();
    if (await synced) {
      await loadWarmupProfiles();
      rememberWarmup();
    }
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  } finally {
    warmupState.busy = false;
    renderWarmupRefreshing(false);
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

async function selectWarmupProfile(profileId, { keepOpen = false } = {}) {
  const profile = warmupState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  // A second click on the open account folds its card away.
  if (!keepOpen && warmupState.selectedProfileId === profileId && warmupState.detail) {
    warmupState.selectedProfileId = null;
    warmupState.selectedAccountId = null;
    warmupState.detail = null;
    renderWarmupDetail();
    renderWarmupProfiles();
    return;
  }
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
  // The account's card sits inside the table now; its own listeners answer for it.
  if (event.target.closest("#warmupDetailPanel")) return;
  const tick = event.target.closest("[data-warmup-account-tick]");
  if (!tick) return;
  toggleWarmupAccount(tick.dataset.warmupAccountTick, tick.checked);
});

document.getElementById("warmupProfileTableBody")?.addEventListener("click", (event) => {
  if (event.target.closest("#warmupDetailPanel")) return;
  if (event.target.closest("[data-warmup-idle-toggle]")) {
    warmupState.showIdleProfiles = !warmupState.showIdleProfiles;
    renderWarmupProfiles();
    return;
  }
  // Ticking an account is not the same gesture as opening it.
  if (event.target.closest("[data-warmup-account-tick]")) return;
  // Nor is editing its tags.
  const editTags = event.target.closest("[data-warmup-tags-edit]");
  if (editTags) {
    const profile = warmupState.profiles.find((row) => row.id === editTags.dataset.warmupTagsEdit);
    Object.assign(tagsEdit, { profileId: profile?.id || null, draft: [...(profile?.tags || [])], busy: false, error: "" });
    renderWarmupProfiles();
    document.querySelector("[data-warmup-tags-form] input")?.focus();
    return;
  }
  if (event.target.closest("[data-warmup-tags-editor]")) {
    const drop = event.target.closest("[data-warmup-tag-drop]");
    const add = event.target.closest("[data-warmup-tag-add]");
    if (drop) tagsEdit.draft.splice(Number(drop.dataset.warmupTagDrop), 1);
    else if (add) addDraftTag(add.dataset.warmupTagAdd);
    else if (event.target.closest("[data-warmup-tags-cancel]")) Object.assign(tagsEdit, { profileId: null, draft: [], error: "" });
    else return;
    const typed = document.querySelector("[data-warmup-tags-form] input")?.value || "";
    renderWarmupProfiles();
    const input = document.querySelector("[data-warmup-tags-form] input");
    if (input) { input.value = typed; input.focus(); }
    return;
  }
  const invites = event.target.closest("[data-warmup-invites]");
  if (invites) {
    event.stopPropagation();
    void setWarmupInvites(invites.dataset.warmupInvites, invites.dataset.warmupInvitesOn === "1");
    return;
  }
  const jump = event.target.closest("[data-warmup-inbox-jump]");
  if (jump) {
    event.stopPropagation();
    // To «Вхідні» (власник 16.10: «має вести на повідомлення»), at the top, with
    // this account's newest unread conversation open.
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

document.getElementById("warmupDetailBody")?.addEventListener("change", (event) => {
  const tick = event.target.closest("[data-warmup-account-tick]");
  if (!tick) return;
  toggleWarmupAccount(tick.dataset.warmupAccountTick, tick.checked);
  renderWarmupDetail();
});

document.getElementById("warmupDetailBody")?.addEventListener("click", (event) => {
  // A new reply in the card: its conversation, on «Вхідні», where it is answered.
  const thread = event.target.closest("[data-warmup-thread]");
  if (thread) {
    showWarmupInboxThread(thread.dataset.warmupThreadAccount, thread.dataset.warmupThread);
    return;
  }
  const control = event.target.closest("[data-warmup-control]");
  if (control) {
    warmupControl(control.dataset.warmupControl);
    return;
  }
  const peopleFilter = event.target.closest("[data-warmup-people-filter]");
  if (peopleFilter) {
    warmupPeople.filter = peopleFilter.dataset.warmupPeopleFilter;
    const section = document.getElementById("warmupPeopleSection");
    if (section) section.outerHTML = warmupPeopleSectionHtml();
    refreshIcons();
    return;
  }
  if (event.target.closest("[data-warmup-network-more]")) {
    warmupNetwork.shown += 50;
    const list = document.getElementById("warmupPeopleList");
    if (list) { list.innerHTML = warmupPeopleListHtml(); refreshIcons(list); }
    return;
  }
  const networkRefresh = event.target.closest("[data-warmup-network-refresh]");
  if (networkRefresh && warmupNetwork.accountId) {
    const accountId = warmupNetwork.accountId;
    warmupNetwork.busy = true;
    void warmupApi("/network/refresh", { method: "POST", body: JSON.stringify({ accountId }) })
      .then(() => loadWarmupNetwork(accountId))
      .catch((error) => { warmupNetwork.error = error.message; })
      .finally(() => {
        warmupNetwork.busy = false;
        const section = document.getElementById("warmupPeopleSection");
        if (section) section.outerHTML = warmupPeopleSectionHtml();
        refreshIcons();
      });
    return;
  }
  const person = event.target.closest("[data-warmup-person]");
  if (person) {
    const contactId = person.dataset.warmupPerson;
    void import("./contacts.js").then((module) => {
      document.querySelector('.nav-item[data-view="contacts"]')?.click();
      module.showContactCard(contactId);
    });
    return;
  }
  const block = event.target.closest("[data-warmup-block]");
  if (block) {
    const health = block.dataset.warmupBlock;
    if (health === "blocked" && !window.confirm("Позначити акаунт заблокованим? Агент перестане його відкривати, а нагадування про нього зникнуть з «Вхідних» і «Головної».")) return;
    warmupApi("/accounts/health", {
      method: "POST",
      body: JSON.stringify({ accountId: warmupState.selectedAccountId, health, note: health === "blocked" ? "Заблоковано в LinkedIn" : "" })
    })
      .then((payload) => { announceReassigned(payload?.reassigned); return loadWarmup({ full: false }); })
      .catch((error) => {
        warmupState.error = error.message;
        renderWarmupConfigNote();
      });
    return;
  }
  if (event.target.closest("[data-warmup-health]")) {
    const health = document.getElementById("warmupHealthSelect")?.value;
    const note = document.getElementById("warmupHealthNote")?.value || "";
    warmupApi("/accounts/health", {
      method: "POST",
      body: JSON.stringify({ accountId: warmupState.selectedAccountId, health, note })
    })
      .then((payload) => { announceReassigned(payload?.reassigned); return loadWarmup({ full: false }); })
      .catch((error) => {
        warmupState.error = error.message;
        renderWarmupConfigNote();
      });
  }
});

/** Етап 4/6: після «Заблоковано» — куди перейшли люди акаунта, або чому ні. */
function announceReassigned(result) {
  if (!result) return;
  const text = result.moved
    ? `Людей перепризначено: ${result.moved} — ${result.to.filter((item) => item.count).map((item) => `${item.name}: ${item.count}`).join(", ")}. Нові запити в друзі підуть у межах лімітів цих акаунтів; переписка й історія в CRM лишились.`
    : result.reason || "На заблокованому акаунті не було людей для перенесення.";
  window.alert(text);
}

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

document.getElementById("warmupDetailBody")?.addEventListener("input", (event) => {
  if (event.target.id !== "warmupPeopleSearch") return;
  warmupPeople.search = event.target.value;
  warmupNetwork.shown = 50;
  const list = document.getElementById("warmupPeopleList");
  if (list) { list.innerHTML = warmupPeopleListHtml(); refreshIcons(list); }
});

// Enter in the tag field, or «Зберегти»: what is typed is added, then all is saved into Anty.
document.getElementById("warmupProfileTableBody")?.addEventListener("submit", (event) => {
  if (event.target.closest("#warmupDetailPanel")) return;
  const form = event.target.closest("[data-warmup-tags-form]");
  if (!form || !tagsEdit.profileId) return;
  event.preventDefault();
  void saveWarmupTags(tagsEdit.profileId, form.querySelector("input")?.value || "");
});
