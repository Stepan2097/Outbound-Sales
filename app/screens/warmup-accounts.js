// Прогрів — the accounts: the table, one account's card, the day's numbers,
// the queue and the people it is working on. The campaign that feeds them
// lives in warmup-campaign.js.

import {
  autoFeedFor, inviteAttentionText, queueAfterFailedClaim, queueAnswerIsCurrent
} from "../warmup-view.js";
import {
  api, escapeAttr, escapeHtml, onScreen, refreshIcons, uaPlural
} from "../core.js";
import {
  loadWarmupCampaigns, loadWarmupStrategy, renderWarmupCampaignDetail, renderWarmupCampaigns, renderWarmupStrategy, toggleWarmupAccount, warmupAutoFeedHtml, warmupCampaignAccountIds, warmupFolderName, warmupSelectedCampaign
} from "../screens/warmup-campaign.js";
import {
  loadWarmupInbox, renderWarmupInbox, setWarmupUnread, showWarmupInboxAccount, warmupInboxUnreadFor
} from "../screens/inbox.js";

onScreen("warmup", { open: () => loadWarmup() });

/**
 * Чи може ключ цього середовища оновити рядок у wl_events.
 *
 * Від відповіді залежить, яким шляхом іти в дедуплікації історії: оновлювати
 * тимчасовий рядок на місці чи назавжди тримати два і ховати один при показі.
 * Перевірити можна лише там, де є ключі — тобто на розгорнутому сервері, — тож
 * це кнопка в застосунку, а не скрипт, який нікому не запустити.
 */
document.getElementById("warmupProbeBtn").addEventListener("click", async () => {
  const note = document.getElementById("warmupProbeNote");
  const button = document.getElementById("warmupProbeBtn");
  note.hidden = false;
  note.className = "warmup-probe-note";
  note.textContent = "Перевіряємо...";
  button.disabled = true;
  try {
    const { probe } = await warmupApi("/diagnostics/event-write", { method: "POST", body: "{}" });
    // A step that was never attempted is not a refusal. Painting `null` red
    // with "ні — без пояснення" destroyed the one distinction this probe was
    // rebuilt to make: no keys here, versus the key is not allowed to.
    const line = (label, step) => {
      if (!step) return `<li class="is-skipped">${escapeHtml(label)}: не пробували</li>`;
      return `<li class="${step.ok ? "is-ok" : "is-bad"}">${escapeHtml(label)}: ${step.ok ? "так" : `ні — ${escapeHtml(step.error || "без пояснення")}`}</li>`;
    };
    const verdict = {
      full: "Ключ уміє все три дії. Дедуплікацію історії можна робити оновленням рядка на місці.",
      no_update: "Ключ пише, але не оновлює. Дедуплікацію доведеться робити придушенням під час показу — два рядки лишаться в базі назавжди.",
      no_delete: "Ключ пише й оновлює, але не прибирає. Оновлення на місці доступне; тестовий рядок треба прибрати руками.",
      cannot_write: "Ключ не пише в wl_events узагалі. Це ламає не лише дедуплікацію, а й усю історію — розбирайся з цього.",
      not_configured: "У цьому середовищі немає ключів до бази Anty, тож питати нема в кого. Перевіряй там, де вони є."
    }[probe.verdict] || "Невідомий результат.";
    note.className = `warmup-probe-note ${probe.canUpdate ? "is-ok" : "is-bad"}`;
    note.innerHTML = `
      <strong>${escapeHtml(verdict)}</strong>
      <ul>${line("Запис", probe.insert)}${line("Оновлення", probe.update)}${line("Прибирання", probe.remove)}</ul>
      ${probe.probeId ? `<small>Тестовий рядок лишився в базі: <code>${escapeHtml(probe.probeId)}</code></small>` : ""}
    `;
  } catch (error) {
    note.className = "warmup-probe-note is-bad";
    note.textContent = error.message || "Перевірка не пройшла.";
  } finally {
    button.disabled = false;
    refreshIcons();
  }
});

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
  // Per account: what is claimed to it now, or the server's sentence saying why
  // nothing is. An empty box is never the answer here.
  queues: {},
  queueBusy: {},
  leads: [],
  leadsTotal: null,
  leadsTargeting: null,
  leadsPrompt: "",
  leadsError: "",
  leadsReady: false,
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
    unreadOnly: false,
    showAll: false,
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
  return `<span class="warmup-subtle" ${all}>${total}</span>`;
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

function renderWarmupStats() {
  const strip = document.getElementById("warmupStatsStrip");
  if (!strip) return;
  const dashboard = warmupState.dashboard;
  if (!dashboard) {
    strip.innerHTML = "";
    return;
  }

  const { totals, todayProgress } = dashboard;
  const window = warmupState.config?.window;
  const cards = [
    { label: "Прогріваються", value: totals.warming },
    { label: "Робочий режим", value: totals.working ?? 0 },
    { label: "На паузі", value: totals.paused },
    // The standard strategy never finishes any more — day 15 is working mode —
    // so this card only appears when there is something to count.
    ...(totals.completed ? [{ label: "Завершені", value: totals.completed }] : []),
    { label: "Не почали", value: totals.idle },
    { label: "Сьогодні", value: `${todayProgress.done}/${todayProgress.planned}` },
    { label: "Вікно сесій", value: window ? `${window.label}${window.open ? "" : " · зачинене"}` : "—" }
  ];

  strip.innerHTML = cards
    .map((card) => `<div class="warmup-stat"><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(String(card.value))}</strong></div>`)
    .join("");
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

function warmupQueueRowHtml(row, accountId, campaignId) {
  const link = warmupLeadLink(row.linkedin);
  const where = [row.position, row.company].filter(Boolean).join(" · ");
  const name = row.name || "Контакт без імені";
  // A queue belongs to an account, not to a campaign: an account that works two
  // campaigns holds both their claims in one list. Saying which campaign a
  // person came from is the difference between a list and a claim about where
  // these people are from.
  const elsewhere = row.campaignId && campaignId && row.campaignId !== campaignId
    ? `<span class="warmup-queue-elsewhere" title="Закріплено іншою кампанією, яку цей акаунт теж веде">${escapeHtml(row.campaignName || "інша кампанія")}</span>`
    : "";
  return `<li>
    <div class="warmup-lead-who">
      <strong>${escapeHtml(name)}</strong>
      ${where ? `<span class="warmup-subtle">${escapeHtml(where)}</span>` : ""}
      ${elsewhere}
    </div>
    ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">профіль</a>` : '<span class="warmup-subtle">без посилання на профіль</span>'}
    <button class="text-button warmup-queue-send" type="button"
      data-warmup-take="${escapeAttr(row.crmContactId || "")}"
      data-warmup-take-account="${escapeAttr(accountId)}"
      data-warmup-take-name="${escapeAttr(name)}"
      ${row.crmContactId ? "" : "disabled"}
      title="Фіксує запит до цієї людини. Одна людина — один захід, назавжди.">Надіслав запит</button>
  </li>`;
}

function warmupQueueAccountHtml(accountId, campaignId) {
  const profile = warmupState.profiles.find((item) => item.account?.id === accountId) || null;
  const identity = profile?.identity || profile?.account?.identity || null;
  const queue = warmupQueueState(accountId);
  const busy = Boolean(warmupState.queueBusy[accountId]);

  const day = profile?.day ? `день ${profile.day}` : null;
  const connections = profile?.connections || {};
  const quotaLine = connections.quota > 0
    ? `${connections.today || 0}/${connections.quota} сьогодні`
    : (connections.startsDay ? `запити з ${connections.startsDay}-го дня` : "без запитів сьогодні");
  const meta = [day, quotaLine].filter(Boolean).join(" · ");

  // Only what the campaign on screen is doing: the cache is keyed by account,
  // and another campaign ticking the same account loaded it just as well.
  const feedLine = warmupAutoFeedHtml(autoFeedFor(queue, campaignId));
  const waitingList = warmupQueueWaitingHtml(queue?.waiting || []);

  let body = "";
  if (!queue) {
    body = '<div class="empty-state">Завантажуємо...</div>';
  } else if (queue.unavailable) {
    body = `<p class="warmup-queue-reason is-muted">${escapeHtml(queue.unavailable)}</p>`;
  } else if (queue.error) {
    body = `<p class="warmup-queue-reason is-bad">${escapeHtml(queue.error)}</p>`;
  } else if (queue.rows?.length) {
    body = `<ul class="warmup-leads warmup-queue-list">${queue.rows.map((row) => warmupQueueRowHtml(row, accountId, campaignId)).join("")}</ul>`;
  } else if (queue.reason && !feedLine) {
    // The server's sentence, verbatim — but only when the feed line has not
    // already said why nothing is held: two answers to one question is noise.
    body = `<p class="warmup-queue-reason">${escapeHtml(queue.reason)}</p>`;
  }

  const released = Number(queue?.released) || 0;
  const releasedNote = released
    ? `<p class="warmup-queue-released">${warmupCount(released)} ${uaPlural(released, "закріплення", "закріплення", "закріплень")} повернулось у пул</p>`
    : "";

  return `<article class="warmup-queue-account" data-warmup-queue-account="${escapeAttr(accountId)}">
    <header>
      <div class="warmup-queue-who">
        <strong>${escapeHtml(profile?.name || "Акаунт")}</strong>
        ${identity?.name ? `<span class="warmup-identity"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}</span></span>` : ""}
        ${meta ? `<span class="warmup-subtle">${escapeHtml(meta)}</span>` : ""}
      </div>
      <button class="text-button" type="button" data-warmup-claim="${escapeAttr(accountId)}" ${busy ? "disabled" : ""} title="Закріпити людей для ручного надсилання">
        <i data-lucide="hand"></i><span>${busy ? "Закріплюємо..." : "Закріпити"}</span>
      </button>
    </header>
    ${feedLine}
    ${waitingList}
    ${releasedNote}
    ${body}
  </article>`;
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

export function renderWarmupQueue() {
  const title = document.getElementById("warmupQueueTitle");
  const subtitle = document.getElementById("warmupQueueSubtitle");
  const body = document.getElementById("warmupQueueBody");
  if (!title || !subtitle || !body) return;

  const campaign = warmupSelectedCampaign();
  title.textContent = campaign ? `Черга · ${campaign.name || "Кампанія без назви"}` : "Черга";

  if (!campaign) {
    subtitle.textContent = "";
    body.innerHTML = '<div class="empty-state">Обери кампанію вгорі.</div>';
    return;
  }

  const accountIds = campaign.accountIds || [];
  if (!accountIds.length) {
    subtitle.textContent = "";
    body.innerHTML = `<div class="warmup-leads-prompt"><strong>Не позначено жодного акаунта.</strong>
      <span>Познач їх нижче, у Профілях.</span></div>`;
    refreshIcons();
    return;
  }

  // A queue is an account's, so what is counted here is everything these
  // accounts hold — this campaign's claims and any other campaign's.
  const claimed = accountIds.reduce((total, id) => total + (warmupQueueState(id)?.rows?.length || 0), 0);
  subtitle.textContent = claimed ? `${warmupCount(claimed)} закріплено вручну` : "";

  body.innerHTML = `<div class="warmup-queue-accounts">${accountIds.map((id) => warmupQueueAccountHtml(id, campaign.id)).join("")}</div>`;
  refreshIcons();
}

function warmupLeadLink(url) {
  const value = String(url || "");
  return /^https?:\/\//i.test(value) ? value : null;
}

function renderWarmupLeads() {
  const title = document.getElementById("warmupLeadsTitle");
  const subtitle = document.getElementById("warmupLeadsSubtitle");
  const body = document.getElementById("warmupLeadsBody");
  if (!title || !subtitle || !body) return;

  // The header names the folder: a queue that does not say where it comes from
  // is a list of strangers.
  const targeting = warmupState.leadsTargeting;
  const folderName = targeting?.folderName || warmupFolderName(targeting?.folderId);
  // A queue answering "nothing is targeted" must not carry a folder name in
  // its header — that would be two answers to the same question.
  title.textContent = folderName && !warmupState.leadsPrompt ? `Черга лідів · ${folderName}` : "Черга лідів";

  if (warmupState.leadsPrompt) {
    subtitle.textContent = "Ціль ще не задана";
    body.innerHTML = `<div class="warmup-leads-prompt">
      <strong>${escapeHtml(warmupState.leadsPrompt)}</strong>
      <span>Створи кампанію вгорі й запусти її — цей список і є те, що підпадає під її папку й фільтри, ще до закріплення за акаунтом.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (warmupState.leadsError) {
    subtitle.textContent = "Чергу не вдалося прочитати";
    body.innerHTML = `<div class="warmup-leads-prompt is-bad"><strong>${escapeHtml(warmupState.leadsError)}</strong>
      <span>«CRM не відповідає» і «більше нікого немає» — це різні відповіді; тут перша.</span></div>`;
    refreshIcons();
    return;
  }

  if (!warmupState.leadsReady) {
    subtitle.textContent = "Черги лідів на цьому сервері ще немає";
    body.innerHTML = '<div class="empty-state">Показувати нічого, поки ендпоїнт черги не відповість.</div>';
    return;
  }

  subtitle.textContent = Number.isFinite(warmupState.leadsTotal)
    ? `Наступні ${warmupState.leads.length} з ${warmupCount(warmupState.leadsTotal)}`
    : "";

  if (!warmupState.leads.length) {
    body.innerHTML = '<div class="empty-state">У папці більше нікого немає.</div>';
    return;
  }

  body.innerHTML = `<ul class="warmup-leads">${warmupState.leads
    .map((lead) => {
      const link = warmupLeadLink(lead.linkedin);
      const where = [lead.position, lead.company].filter(Boolean).join(" · ");
      return `<li>
        <div class="warmup-lead-who">
          <strong>${escapeHtml(lead.name || "Контакт без імені")}</strong>
          ${where ? `<span class="warmup-subtle">${escapeHtml(where)}</span>` : ""}
        </div>
        <span class="warmup-subtle">${escapeHtml(lead.country || "—")}</span>
        ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">профіль</a>` : '<span class="warmup-subtle">без посилання на профіль</span>'}
      </li>`;
    })
    .join("")}</ul>`;
  refreshIcons();
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
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state">Профілів за цим запитом немає.</div></td></tr>';
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
              ? `<div class="warmup-identity" title="На останньому вході агента залогінений як ця особа"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}${identity.slug ? ` · ${escapeHtml(identity.slug)}` : ""}</span></div>`
              : ""}
            <div class="warmup-subtle">${escapeHtml(profile.owner || "—")}${profile.proxy ? " · через проксі" : " · без проксі"}</div>
          </td>
          <td><span class="pill ${WARMUP_STATUS_TONE[status] || "tone-muted"}">${escapeHtml(WARMUP_STATUS_LABEL[status] || status)}</span></td>
          <td>${escapeHtml(profile.day || "—")}</td>
          <td>${warmupConnectionsCell(profile)}</td>
          <td>${warmupNextSessionCell(profile)}</td>
          <td class="warmup-row-actions">
            ${account
              ? '<button class="text-button" type="button" data-warmup-open>Відкрити</button>'
              : '<button class="primary-button" type="button" data-warmup-adopt>Прогріти</button>'}
          </td>
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
              <button class="text-button" type="button" data-warmup-record="${escapeHtml(kind)}" ${done >= quota ? "disabled" : ""}>Записати одну</button>
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

export async function loadWarmupQueues() {
  const campaign = warmupSelectedCampaign();
  const accountIds = campaign?.accountIds || [];
  if (!accountIds.length) {
    renderWarmupQueue();
    return;
  }
  await Promise.all(accountIds.map((id) => loadWarmupQueue(id)));
  renderWarmupQueue();
}

async function claimWarmupQueue(accountId) {
  if (warmupState.queueBusy[accountId]) return;
  warmupState.queueBusy[accountId] = true;
  renderWarmupQueue();

  try {
    const payload = await warmupApi("/campaigns/claim", {
      method: "POST",
      body: JSON.stringify({ accountId })
    });
    const claimed = payload.claimed || [];
    const existing = warmupState.queues[accountId]?.rows || [];
    warmupState.queues[accountId] = {
      ...(warmupState.queues[accountId] || {}),
      // Oldest first, as the queue itself is ordered.
      rows: existing.concat(claimed),
      reason: payload.reason || "",
      // Every claim first releases what expired. If that moved anything, the
      // queue just shrank under somebody's feet and they should hear why.
      released: Number(payload.released) || 0,
      error: "",
      unavailable: ""
    };
  } catch (error) {
    // Everything the card already showed stays: the auto-feed line and who is
    // waiting for the agent are still true when a claim fails.
    warmupState.queues[accountId] = queueAfterFailedClaim(warmupState.queues[accountId], error);
  } finally {
    warmupState.queueBusy[accountId] = false;
  }

  renderWarmupQueue();
  // Claiming changes what is left and what is held, so the row above has to
  // follow it.
  await loadWarmupCampaigns({ resetForm: false });
  renderWarmupQueue();
}

/**
 * The one place a request is recorded. It marks a real person as approached,
 * once and for good, so it asks first and says who.
 */
async function takeWarmupQueueLead(accountId, crmContactId, name) {
  if (!accountId || !crmContactId) return;
  if (!window.confirm(`Записати запит на контакт до ${name || "цього контакту"}?\n\nЦе назавжди позначає, що до цієї людини вже зверталися — для кожного акаунта й кожної кампанії.`)) return;

  try {
    await warmupApi("/leads/take", {
      method: "POST",
      body: JSON.stringify({ accountId, crmContactId })
    });
    const queue = warmupState.queues[accountId];
    if (queue) {
      queue.rows = (queue.rows || []).filter((row) => row.crmContactId !== crmContactId);
    }
  } catch (error) {
    if (warmupState.queues[accountId]) warmupState.queues[accountId].error = error.message;
    else warmupState.queues[accountId] = { rows: [], reason: "", error: error.message, unavailable: "" };
  }

  renderWarmupQueue();
  await loadWarmup({ full: false });
}

export async function loadWarmupLeads() {
  try {
    // The pool belongs to the campaign on screen. Left to itself the server
    // answers for the first running one, which is a different folder from the
    // one somebody is looking at as soon as there are two campaigns.
    const campaignId = warmupState.selectedCampaignId;
    const params = new URLSearchParams({ limit: "10" });
    if (campaignId) params.set("campaignId", campaignId);
    const payload = await warmupApi(`/leads?${params}`);
    warmupState.leads = payload.leads || [];
    warmupState.leadsTotal = Number.isFinite(payload.queueTotal) ? payload.queueTotal : null;
    warmupState.leadsTargeting = payload.campaign || payload.targeting || null;
    warmupState.leadsPrompt = "";
    warmupState.leadsError = "";
    warmupState.leadsReady = true;
  } catch (error) {
    warmupState.leads = [];
    warmupState.leadsTotal = null;
    warmupState.leadsPrompt = "";
    warmupState.leadsError = "";
    // 409 is the server saying there is no campaign yet. That is a prompt, and
    // drawing it in red would be calling the user's unfinished setup a fault.
    if (error.payload?.needsCampaign || error.payload?.needsTargeting || error.status === 409) {
      warmupState.leadsReady = true;
      warmupState.leadsPrompt = error.message || "Створи кампанію, перш ніж тягнути лідів";
    } else if (error.status === 404) {
      warmupState.leadsReady = false;
    } else {
      warmupState.leadsReady = true;
      warmupState.leadsError = error.message;
    }
  }
  renderWarmupLeads();
}

async function loadWarmupProfiles() {
  const search = document.getElementById("warmupSearchInput")?.value.trim() || "";
  const platform = document.getElementById("warmupPlatformSelect")?.value || "linkedin";
  const params = new URLSearchParams({ platform });
  if (search) params.set("q", search);

  const payload = await warmupApi(`/profiles?${params}`);
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
    warmupApi(`/events?accountId=${encodeURIComponent(accountId)}&limit=30`)
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
      renderWarmupInbox();
      renderWarmupStrategy();
      renderWarmupCampaigns();
      renderWarmupQueue();
      return;
    }

    // Reconciling Anty's "profile is running" flag with the sessions table is
    // what makes the Sessions column true; it is cheap and idempotent, so the
    // screen does it on every load rather than relying on somebody remembering.
    await warmupApi("/sync", { method: "POST" }).catch(() => null);

    warmupState.dashboard = await warmupApi("/dashboard");
    renderWarmupStats();
    // The inbox before the plan: it is the top panel, it depends on nothing
    // else here, and it is the one thing on this screen somebody else wrote.
    await loadWarmupInbox();
    // The schedule every account runs on. It depends on nothing else here and
    // nothing here depends on it, so it is read once and left alone.
    await loadWarmupStrategy();
    // Campaigns first: the tick column in the profiles table is drawn from the
    // selected one, and the queue below is drawn from its accounts.
    await loadWarmupCampaigns({ resetForm: full });
    await loadWarmupProfiles();
    await loadWarmupQueues();
    await loadWarmupLeads();
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

document.getElementById("warmupPlatformSelect")?.addEventListener("change", () => loadWarmupProfiles());

document.getElementById("warmupSearchInput")?.addEventListener("input", () => {
  clearTimeout(warmupState.searchTimer);
  warmupState.searchTimer = setTimeout(() => loadWarmupProfiles(), 250);
});

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
  const record = event.target.closest("[data-warmup-record]");
  if (record) {
    warmupControl("record", { kind: record.dataset.warmupRecord });
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

document.getElementById("warmupQueueBody")?.addEventListener("click", (event) => {
  const claim = event.target.closest("[data-warmup-claim]");
  if (claim) {
    claimWarmupQueue(claim.dataset.warmupClaim);
    return;
  }
  const take = event.target.closest("[data-warmup-take]");
  if (take) {
    takeWarmupQueueLead(take.dataset.warmupTakeAccount, take.dataset.warmupTake, take.dataset.warmupTakeName);
  }
});

document.getElementById("warmupQueueRefreshBtn")?.addEventListener("click", () => loadWarmupQueues());

document.getElementById("warmupLeadsRefreshBtn")?.addEventListener("click", () => loadWarmupLeads());

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
