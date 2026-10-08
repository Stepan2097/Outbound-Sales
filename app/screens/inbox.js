// Вхідні — the replies from every warm-up account on one screen: unread first,
// then the newest, each row saying who wrote, which account it reached and the
// last thing said. A row opens the conversation, and the conversation opens
// the person's card in «Контакти». The unread count sits on the menu item.

import {
  authState, escapeAttr, escapeHtml, onScreen, onWorkspaceEnter, refreshIcons, uaPlural
} from "../core.js";
import {
  showContactCard
} from "../screens/contacts.js";
import {
  WARMUP_OUTREACH_LABEL, WARMUP_OUTREACH_TONE, renderWarmupProfiles, warmupApi, warmupCount, warmupState
} from "../screens/warmup-accounts.js";

onScreen("inbox", { open: () => loadWarmupInbox() });

// The count is wanted the moment somebody is inside, on whatever screen they
// landed — not only when this one is opened.
onWorkspaceEnter(() => refreshWarmupBadge());

/** A run is roughly daily, so a gap longer than this is a stopped agent. */
const WARMUP_SYNC_STALE_HOURS = 36;

/**
 * The one account the list is narrowed to, set when somebody follows the
 * "new replies" badge on that account's row in «Прогрів». Null is every account,
 * and is what the screen opens on.
 */
let inboxAccountFilter = null;

/** How long ago, said the way a person would say it. */
function warmupAgo(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 0) return new Date(then).toLocaleString();
  if (minutes < 1) return "щойно";
  if (minutes < 60) return `${minutes} хв тому`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.round(hours / 24);
  if (days === 1) return "вчора";
  if (days < 30) return `${days} дн тому`;
  return new Date(then).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/** The same moment in full, for the tooltip behind the short version. */
function warmupStamp(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  return Number.isFinite(then) ? new Date(then).toLocaleString() : "";
}

function warmupHoursSince(iso) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 3600000;
}

/**
 * A stranger's message, escaped. The return value is HTML, so there is no
 * version of this text that reaches the DOM unescaped: newlines survive
 * because `.warmup-message-body` is `white-space: pre-wrap`, not because
 * anything here builds tags out of what was typed.
 */
function warmupBodyHtml(body) {
  return escapeHtml(String(body ?? ""));
}

/** The first line of a message, for a list row that has one line to spend. */
function warmupPreviewHtml(body, limit = 150) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return '<em class="warmup-subtle">у цьому повідомленні немає тексту</em>';
  const chars = Array.from(text);
  const clipped = chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
  // Quoted, because the row is half app copy and half somebody's words, and
  // without the quotes a reply reads as a sentence this screen is saying.
  return `«${escapeHtml(clipped)}»`;
}

/**
 * A LinkedIn link built from a slug somebody else supplied. Anything that is
 * not plainly a slug or an http(s) URL gets no link at all — a person's own
 * profile is not worth inventing a destination for.
 */
function warmupProfileUrl(slug) {
  const value = String(slug || "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  return `https://www.linkedin.com/in/${value}`;
}

/**
 * The strings that are not names. The server folds all of these to "Unknown"
 * before they reach here and its matcher refuses that sentinel from both sides,
 * which is where the rule with teeth lives — a thread that cannot name somebody
 * must never be filed against a CRM contact. This list is the display half of
 * the same idea, kept because an older server, or one whose normaliser is
 * bypassed, would otherwise have "LinkedIn Member" printed as a surname on ten
 * rows that are ten different people. Whole string, trimmed, case-insensitive:
 * "Linda Memberly" is a person.
 */
const WARMUP_UNNAMED = new Set([
  "unknown",
  "linkedin member",
  "linkedin user",
  "deleted member",
  "deleted user",
  "member"
]);

function warmupParticipantUnnamed(participant) {
  // Runs of whitespace are collapsed before the comparison: the agent reads
  // these strings out of the DOM, where "LinkedIn Member" can arrive as
  // "LinkedIn\n      Member". Collapsing cannot swallow a real name — "Linda
  // Memberly" is still not in the set however it was spaced.
  const name = String(participant?.name || "").replace(/\s+/g, " ").trim();
  return !name || WARMUP_UNNAMED.has(name.toLowerCase());
}

/** Who wrote, or an honest admission that nobody here knows. */
function warmupParticipantName(participant) {
  if (warmupParticipantUnnamed(participant)) return "Без імені";
  return String(participant.name).trim();
}

/**
 * Why there is no name: LinkedIn withholds it on a restricted or out-of-network
 * profile, or the agent failed to read it. Worth saying, because only the
 * second one is a fault — and that this thread is deliberately not matched to
 * anybody in the CRM.
 */
function warmupParticipantNameAttr(participant) {
  return warmupParticipantUnnamed(participant)
    ? ' title="LinkedIn не показав імені: зазвичай це закритий профіль, іноді невдале зчитування. Цей тред навмисно не зіставлено ні з ким у CRM."'
    : "";
}

/**
 * Which account a thread arrived on, by the person the browser is signed in as
 * rather than by the label somebody typed into Anty. When only the label is
 * known the row says that, because "arrived on Profile 7" and "arrived on Anna
 * Kovalenko" are not the same claim.
 */
function warmupThreadAccount(thread) {
  const identity = thread?.accountIdentity;
  const name = typeof identity === "string" ? identity.trim() : String(identity?.name || "").trim();
  if (name) return { name, exact: true };
  const label = String(thread?.accountLabel || "").trim();
  if (label) return { name: label, exact: false };
  return { name: "акаунт, який цей портал не може назвати", exact: false };
}

function warmupAccountTitle(account) {
  return account.exact
    ? "Особа, під якою залогінений цей акаунт"
    : "Назва профілю в Anty — цей портал не знає, під ким залогінений цей акаунт";
}

/**
 * What is known about syncing, from wherever it landed. The server carries the
 * summary at the top level — the only place it can be read when there are no
 * threads at all — and the contract also puts `lastSyncedAt` on each thread.
 * Read both, so the two halves of this phase can land in either order.
 */
function warmupInboxSync() {
  const inbox = warmupState.inbox;
  const sync = inbox.sync && typeof inbox.sync === "object" ? inbox.sync : null;

  let lastSyncedAt = sync?.lastSyncedAt || null;
  let fromThreads = false;
  for (const thread of inbox.threads) {
    const seen = thread?.lastSyncedAt;
    if (!seen) continue;
    if (!lastSyncedAt || Date.parse(seen) > Date.parse(lastSyncedAt)) {
      lastSyncedAt = seen;
      fromThreads = true;
    }
  }

  const accountsTotal = Number.isFinite(sync?.accountsTotal) ? sync.accountsTotal : null;
  const accountsSynced = Number.isFinite(sync?.accountsSynced) ? sync.accountsSynced : null;

  // "Never synced" is a claim, and it can only be made when the server actually
  // reports on syncing. Without that, the honest answer is that this is not
  // known — which is itself worth saying rather than dressing up as calm.
  const known = Boolean(sync) || fromThreads;
  const hours = warmupHoursSince(lastSyncedAt);

  return {
    known,
    lastSyncedAt,
    accountsTotal,
    accountsSynced,
    stale: Number.isFinite(hours) && hours > WARMUP_SYNC_STALE_HOURS
  };
}

/**
 * The one thing about the reading that a seller has to know, or nothing. The
 * list is only as good as the last time somebody read the inboxes, so the three
 * ways it can be wrong — never read, read long ago, some accounts never read —
 * are one sentence each, and at most one of them is shown: the worst.
 */
function warmupInboxNoteHtml(sync) {
  if (sync.known && !sync.lastSyncedAt) {
    return `<div class="warmup-inbox-note is-bad">
      <strong>Вхідні ще жодного разу не читали.</strong>
      <span>Перевір, що агент працює і його токен заданий.</span>
    </div>`;
  }
  if (sync.stale) {
    return `<div class="warmup-inbox-note is-warn">
      <strong>Вхідні не читали ${escapeHtml(warmupAgo(sync.lastSyncedAt))} — схоже, агент зупинився.</strong>
    </div>`;
  }
  if (sync.accountsTotal !== null && sync.accountsSynced !== null && sync.accountsSynced < sync.accountsTotal) {
    const missing = sync.accountsTotal - sync.accountsSynced;
    return `<div class="warmup-inbox-note is-warn">
      <strong>${warmupCount(missing)} з ${warmupCount(sync.accountsTotal)} ${uaPlural(sync.accountsTotal, "акаунта", "акаунтів", "акаунтів")} ще не читали — їхніх відповідей тут немає.</strong>
    </div>`;
  }
  return "";
}

/** The empty inbox, which says which of its two empties this is. */
function warmupInboxEmptyHtml(sync) {
  const note = warmupInboxNoteHtml(sync);
  if (note) return note;
  if (!sync.known) {
    return `<div class="warmup-inbox-note is-warn">
      <strong>Відповідей немає, але невідомо, коли вхідні читали востаннє.</strong>
    </div>`;
  }
  return `<div class="warmup-inbox-note is-calm">
    <strong>Відповідей поки немає.</strong>
    <span>Читали ${escapeHtml(warmupAgo(sync.lastSyncedAt))}.</span>
  </div>`;
}

/**
 * The list as it is drawn: unread first, then the newest, and — when somebody
 * followed a badge from one account's row — only that account's. A reply that
 * is waiting must be the first thing on the screen whichever account it reached,
 * which is why this is one list and not one list per account.
 */
function warmupInboxRows() {
  const sentAt = (thread) => Date.parse(thread?.lastMessage?.sentAt || "") || 0;
  return warmupState.inbox.threads
    .filter((thread) => !inboxAccountFilter || thread.accountId === inboxAccountFilter)
    .sort((left, right) => Number(Boolean(right.unread)) - Number(Boolean(left.unread)) || sentAt(right) - sentAt(left));
}

function warmupThreadRowHtml(thread) {
  const participant = thread.participant || {};
  const name = warmupParticipantName(participant);
  const account = warmupThreadAccount(thread);
  const last = thread.lastMessage || {};
  const inbound = last.direction !== "out";
  return `
    <button class="warmup-thread ${thread.unread ? "is-unread" : ""}" type="button"
      data-warmup-thread="${escapeAttr(thread.threadKey || "")}"
      data-warmup-thread-account="${escapeAttr(thread.accountId || "")}"
      aria-label="${escapeAttr(`Розмова з ${name}, акаунт ${account.name}${thread.unread ? ", непрочитане" : ""}`)}">
      <span class="warmup-thread-mark" aria-hidden="true"></span>
      <span class="warmup-thread-who">
        <strong${warmupParticipantNameAttr(participant)}>${escapeHtml(name)}</strong>
        ${participant.headline ? `<span class="warmup-subtle">${escapeHtml(participant.headline)}</span>` : ""}
        <span class="warmup-identity" title="${escapeAttr(warmupAccountTitle(account))}">
          <i data-lucide="${account.exact ? "badge-check" : "circle-help"}"></i>
          <span>${escapeHtml(account.name)}</span>
        </span>
      </span>
      <span class="warmup-thread-preview">
        <span class="warmup-thread-from">${inbound ? "Написали нам" : "Писали ми"}:</span>
        ${warmupPreviewHtml(last.body)}
      </span>
      <span class="warmup-thread-meta">
        <time datetime="${escapeAttr(last.sentAt || "")}" title="${escapeAttr(warmupStamp(last.sentAt))}">${escapeHtml(warmupAgo(last.sentAt) || "—")}</time>
      </span>
    </button>`;
}

/** The name an account goes by on this screen, from the server's summary or a thread of its own. */
function warmupInboxAccountName(accountId) {
  const inbox = warmupState.inbox;
  const summary = inbox.accounts.find((account) => account.accountId === accountId);
  if (summary?.identity) return summary.identity;
  if (summary?.label) return summary.label;
  const thread = inbox.threads.find((row) => row.accountId === accountId);
  return thread ? warmupThreadAccount(thread).name : "цей акаунт";
}

/** How many of this account's threads are unread — the number on its row in «Прогрів». */
export function warmupInboxUnreadFor(accountId) {
  const summary = warmupState.inbox.accounts.find((account) => account.accountId === accountId);
  if (summary) return Number(summary.unread) || 0;
  return warmupState.inbox.threads.filter((thread) => thread.accountId === accountId && thread.unread).length;
}

/** Said while the list is narrowed to one account, with the way back to all of them. */
function warmupInboxFilterHtml() {
  if (!inboxAccountFilter) return "";
  return `<div class="warmup-inbox-filter">
    <span>Тільки відповіді, що надійшли на <strong>${escapeHtml(warmupInboxAccountName(inboxAccountFilter))}</strong></span>
    <button class="warmup-inbox-link" type="button" data-warmup-inbox-allaccounts>Показати всі акаунти</button>
  </div>`;
}

function warmupMessageHtml(message, participantName, accountName) {
  const inbound = message.direction !== "out";
  const who = inbound ? (participantName || "Вони") : accountName;
  return `<li class="warmup-message ${inbound ? "is-in" : "is-out"}">
    <div class="warmup-message-head">
      <strong>${escapeHtml(who)}</strong>
      <time datetime="${escapeAttr(message.sentAt || "")}" title="${escapeAttr(warmupStamp(message.sentAt))}">${escapeHtml(warmupAgo(message.sentAt) || "—")}</time>
    </div>
    <div class="warmup-message-body">${warmupBodyHtml(message.body)}</div>
  </li>`;
}

/**
 * One conversation, oldest first. Above it the things that make a reply
 * actionable: who wrote, the card of that person in «Контакти», where to find
 * them on LinkedIn, which account holds the thread, and where that person stands
 * in the outreach they were part of.
 */
function warmupThreadViewHtml() {
  const inbox = warmupState.inbox;
  const back = '<button class="text-button warmup-thread-back" type="button" data-warmup-inbox-back><i data-lucide="arrow-left"></i><span>Усі відповіді</span></button>';

  if (inbox.openError) {
    return `${back}<div class="warmup-inbox-note is-bad">
      <strong>${escapeHtml(inbox.openError)}</strong>
      <span>Розмову не вдалося прочитати. У списку — останнє, що цьому порталу про неї сказали.</span>
    </div>`;
  }
  if (!inbox.open) {
    return `${back}<div class="empty-state">Відкриваємо розмову...</div>`;
  }

  const thread = inbox.open.thread || {};
  const participant = thread.participant || {};
  const name = warmupParticipantName(participant);
  const account = warmupThreadAccount(thread);
  const link = warmupProfileUrl(participant.slug);
  const status = String(thread.outreachStatus || "").trim();
  const contactId = thread.crmContactId ? String(thread.crmContactId) : "";
  const messages = Array.isArray(inbox.open.messages) ? inbox.open.messages : [];

  const head = `
    <div class="warmup-thread-head">
      ${back}
      <div class="warmup-thread-head-who">
        <strong${warmupParticipantNameAttr(participant)}>${escapeHtml(name)}</strong>
        ${participant.headline ? `<span class="warmup-subtle">${escapeHtml(participant.headline)}</span>` : ""}
        ${contactId
          ? `<button class="text-button" type="button" data-warmup-contact="${escapeAttr(contactId)}"><i data-lucide="contact"></i><span>Картка контакту</span></button>`
          : '<span class="warmup-subtle">у CRM цієї людини не знайдено</span>'}
        ${link
          ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer noopener"><i data-lucide="external-link"></i><span>їхній LinkedIn</span></a>`
          : ""}
      </div>
      <div class="warmup-thread-head-meta">
        <span class="warmup-identity" title="${escapeAttr(warmupAccountTitle(account))}">
          <i data-lucide="${account.exact ? "badge-check" : "circle-help"}"></i>
          <span>надійшло на ${escapeHtml(account.name)}</span>
        </span>
        ${status
          ? `<span class="pill ${WARMUP_OUTREACH_TONE[status] || "tone-muted"}">${escapeHtml(WARMUP_OUTREACH_LABEL[status] || status)}</span>`
          : ""}
      </div>
    </div>`;

  if (!messages.length) {
    return `${head}<div class="warmup-inbox-note is-warn">
      <strong>У цьому треді не збережено жодного повідомлення.</strong>
      <span>Розмову побачили, але нічого в ній не прочитали — на боці агента так виглядає протухлий селектор.</span>
    </div>`;
  }

  return `${head}
    <ol class="warmup-messages">${messages.map((message) => warmupMessageHtml(message, name, account.name)).join("")}</ol>
    <p class="warmup-thread-foot">Тут можна тільки читати: відповідь іде з самого акаунта.</p>`;
}

export function renderWarmupInbox() {
  const title = document.getElementById("warmupInboxTitle");
  const subtitle = document.getElementById("warmupInboxSubtitle");
  const pill = document.getElementById("warmupInboxPill");
  const body = document.getElementById("warmupInboxBody");
  if (!body || !title || !subtitle) return;

  const inbox = warmupState.inbox;
  renderWarmupNavBadge();

  // A thread is open: the panel becomes that conversation, and the pill that
  // belongs to the list steps out of the way.
  if (inbox.openThreadKey !== null) {
    const open = inbox.open?.thread?.participant;
    title.textContent = open ? `Вхідні · ${warmupParticipantName(open)}` : "Вхідні · одна розмова";
    subtitle.textContent = "Розмова такою, як її прочитав агент, від найстарішого";
    if (pill) pill.hidden = true;
    body.innerHTML = warmupThreadViewHtml();
    refreshIcons();
    return;
  }

  title.textContent = "Вхідні";
  if (pill) pill.hidden = false;

  if (pill) {
    if (!inbox.available) {
      pill.className = "pill tone-muted";
      pill.textContent = "немає на цьому сервері";
    } else if (inbox.error) {
      pill.className = "pill tone-bad";
      pill.textContent = "недоступно";
    } else if (!inbox.ready) {
      pill.className = "pill tone-muted";
      pill.textContent = "завантаження";
    } else if (inbox.unread > 0) {
      pill.className = "pill tone-live";
      pill.textContent = `${warmupCount(inbox.unread)} ${uaPlural(inbox.unread, "непрочитана", "непрочитані", "непрочитаних")}`;
    } else {
      pill.className = "pill tone-muted";
      pill.textContent = inbox.threads.length ? "усе прочитано" : "поки нічого";
    }
  }

  if (!inbox.available) {
    subtitle.textContent = "Вхідних на цьому сервері ще немає";
    body.innerHTML = `<div class="warmup-inbox-note is-warn">
      <strong>На цьому сервері немає ендпоїнта вхідних.</strong>
      <span>З акаунтами все гаразд — просто цей портал старший за вхідні. Нічия відповідь не губиться, але й ніхто її не читає.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (inbox.error) {
    subtitle.textContent = "Вхідні не вдалося прочитати";
    body.innerHTML = `<div class="warmup-inbox-note is-bad">
      <strong>${escapeHtml(inbox.error)}</strong>
      <span>«Вхідні не відповідають» і «ніхто не написав» — це різні відповіді; тут перша.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (!inbox.ready) {
    subtitle.textContent = "Читаємо, що прийшло";
    body.innerHTML = '<div class="empty-state">Завантажуємо вхідні...</div>';
    return;
  }

  const sync = warmupInboxSync();
  // Three answers, not two: read at a time, never read, and not reported. The
  // subtitle must not turn the third into the second.
  subtitle.textContent = sync.lastSyncedAt
    ? `читали ${warmupAgo(sync.lastSyncedAt)}`
    : (sync.known ? "ще не читали" : "");

  const rows = warmupInboxRows();
  if (!rows.length) {
    body.innerHTML = `${warmupInboxFilterHtml()}${inboxAccountFilter
      ? '<div class="warmup-inbox-note is-calm"><strong>Від цього акаунта відповідей немає.</strong></div>'
      : warmupInboxEmptyHtml(sync)}`;
    refreshIcons();
    return;
  }

  body.innerHTML = `${warmupInboxNoteHtml(sync)}${warmupInboxFilterHtml()}
    <div class="warmup-threads">${rows.map((thread) => warmupThreadRowHtml(thread)).join("")}</div>`;
  refreshIcons();
}

const WARMUP_BADGE_POLL_MS = 120000;

let warmupBadgeTimer = null;

function renderWarmupNavBadge() {
  const badge = document.getElementById("warmupNavBadge");
  if (!badge) return;
  const count = warmupState.unreadReplies;
  if (!Number.isFinite(count) || count <= 0) {
    badge.hidden = true;
    badge.textContent = "";
    return;
  }
  badge.hidden = false;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.title = `${count} ${uaPlural(count, "непрочитана відповідь", "непрочитані відповіді", "непрочитаних відповідей")}`;
  badge.setAttribute("aria-label", badge.title);
}

export function setWarmupUnread(count) {
  warmupState.unreadReplies = Number.isFinite(count) ? Math.max(0, count) : null;
  renderWarmupNavBadge();
}

function stopWarmupBadgePoll() {
  if (warmupBadgeTimer) clearInterval(warmupBadgeTimer);
  warmupBadgeTimer = null;
}

async function refreshWarmupBadge() {
  if (!authState?.authenticated) return;
  if (document.visibilityState === "hidden") return;
  try {
    const config = await warmupApi("/config");
    // A server with no warm-up will never have an unread reply, and should not
    // be asked again for the rest of the session.
    if (config && config.configured === false) {
      setWarmupUnread(0);
      stopWarmupBadgePoll();
      return;
    }
    if (Number.isFinite(config?.unreadReplies)) setWarmupUnread(config.unreadReplies);
  } catch (error) {
    // A portal without the count is not a portal with a wrong count: leave the
    // badge as it was, and stop pestering a server that has no such route.
    if (error?.status === 404) stopWarmupBadgePoll();
  }
}

export function startWarmupBadge() {
  stopWarmupBadgePoll();
  warmupBadgeTimer = setInterval(() => refreshWarmupBadge(), WARMUP_BADGE_POLL_MS);
  refreshWarmupBadge();
}

export async function loadWarmupInbox() {
  const inbox = warmupState.inbox;

  try {
    const payload = await warmupApi("/inbox");
    inbox.threads = Array.isArray(payload.threads) ? payload.threads : [];
    inbox.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    inbox.unread = Number.isFinite(payload.unread) ? payload.unread : 0;
    inbox.sync = payload.sync && typeof payload.sync === "object" ? payload.sync : null;
    inbox.available = true;
    inbox.ready = true;
    inbox.error = "";
    setWarmupUnread(inbox.unread);
  } catch (error) {
    inbox.threads = [];
    inbox.accounts = [];
    inbox.sync = null;
    if (error?.status === 404) {
      // The endpoint is not built here. That is a different sentence from "the
      // inbox is empty", and drawing the empty one would be a lie.
      inbox.available = false;
      inbox.ready = false;
      inbox.error = "";
    } else {
      inbox.available = true;
      inbox.ready = true;
      inbox.error = error.message || "Вхідні не вдалося прочитати.";
    }
  }
  renderWarmupInbox();
  // The accounts table carries the same unread numbers, and it was drawn before
  // this answer arrived — so it is redrawn with it rather than sitting there
  // saying nothing is waiting.
  if (warmupState.profiles.length) renderWarmupProfiles();
}

function warmupThreadIsOpen(accountId, threadKey) {
  const inbox = warmupState.inbox;
  return inbox.openAccountId === accountId && inbox.openThreadKey === threadKey;
}

/** Opening a thread marks it read — that is what opening it means. */
async function markWarmupThreadRead(accountId, threadKey) {
  const thread = warmupState.inbox.threads.find(
    (row) => row.threadKey === threadKey && row.accountId === accountId
  );
  if (thread && !thread.unread) return;

  let payload = null;
  try {
    payload = await warmupApi("/inbox/read", {
      method: "POST",
      body: JSON.stringify({ threadKey, accountId })
    });
  } catch (error) {
    // Failing to mark it read leaves it unread, which is the safe direction: a
    // reply shown twice costs a glance, a reply hidden costs the reply.
    return;
  }

  if (thread) thread.unread = false;
  warmupState.inbox.unread = Math.max(0, (warmupState.inbox.unread || 0) - 1);
  // The account this thread arrived on is one reply less busy, on the accounts
  // table's row as well as here.
  const summary = warmupState.inbox.accounts.find((account) => account.accountId === accountId);
  if (summary) summary.unread = Math.max(0, (Number(summary.unread) || 0) - 1);
  if (warmupState.profiles.length) renderWarmupProfiles();
  // The mark comes back with the new global count, so the badge is the server's
  // number rather than this screen's arithmetic about it.
  if (Number.isFinite(payload?.unread)) {
    setWarmupUnread(payload.unread);
  } else if (Number.isFinite(warmupState.unreadReplies)) {
    setWarmupUnread(warmupState.unreadReplies - 1);
  }
}

async function openWarmupThread(accountId, threadKey) {
  const inbox = warmupState.inbox;
  inbox.openAccountId = accountId;
  inbox.openThreadKey = threadKey;
  inbox.open = null;
  inbox.openError = "";
  inbox.openBusy = true;
  renderWarmupInbox();

  try {
    const payload = await warmupApi(
      `/inbox/thread?threadKey=${encodeURIComponent(threadKey)}&accountId=${encodeURIComponent(accountId)}`
    );
    // The reader may have gone back, or opened something else, while this was
    // in flight. Whatever is open now wins.
    if (!warmupThreadIsOpen(accountId, threadKey)) return;
    inbox.open = { thread: payload.thread || {}, messages: payload.messages || [] };
    inbox.openError = "";
  } catch (error) {
    if (!warmupThreadIsOpen(accountId, threadKey)) return;
    // A 404 here means the thread, not the route — a row can be listed and then
    // be gone by the time somebody clicks it. Unless the list never answered
    // either, in which case it is the route after all.
    inbox.openError = error?.status === 404
      ? (inbox.available
        ? "Цієї розмови вже немає на сервері."
        : "Цей сервер ще не вміє відкривати окремий тред.")
      : (error.message || "Розмову не вдалося прочитати.");
  } finally {
    if (warmupThreadIsOpen(accountId, threadKey)) {
      inbox.openBusy = false;
      renderWarmupInbox();
    }
  }

  if (warmupThreadIsOpen(accountId, threadKey) && !inbox.openError) {
    await markWarmupThreadRead(accountId, threadKey);
    if (warmupThreadIsOpen(accountId, threadKey)) renderWarmupInbox();
  }
}

function closeWarmupThread() {
  const inbox = warmupState.inbox;
  inbox.openAccountId = null;
  inbox.openThreadKey = null;
  inbox.open = null;
  inbox.openError = "";
  inbox.openBusy = false;
  renderWarmupInbox();
}

/**
 * Show one account's replies, from the badge on its row in «Прогрів».
 *
 * The badge says "2 нові відповіді" for that account; following it lands on this
 * screen narrowed to that account, with a line saying so and the way back to all
 * of them. Opening the screen loads the list, and the narrowing is applied to it.
 */
export function showWarmupInboxAccount(accountId) {
  if (!accountId) return;
  if (warmupState.inbox.openThreadKey !== null) closeWarmupThread();
  inboxAccountFilter = accountId;
  document.querySelector('.nav-item[data-view="inbox"]')?.click();
  renderWarmupInbox();
}

document.getElementById("warmupInboxRefreshBtn")?.addEventListener("click", () => {
  const inbox = warmupState.inbox;
  if (inbox.openThreadKey !== null) {
    openWarmupThread(inbox.openAccountId, inbox.openThreadKey);
    return;
  }
  loadWarmupInbox();
});

document.getElementById("warmupInboxBody")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-warmup-inbox-back]")) {
    closeWarmupThread();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-allaccounts]")) {
    inboxAccountFilter = null;
    renderWarmupInbox();
    return;
  }
  const contact = event.target.closest("[data-warmup-contact]");
  if (contact) {
    showContactCard(contact.dataset.warmupContact);
    return;
  }
  // A link inside a row is the link, not the row.
  if (event.target.closest("a")) return;
  const row = event.target.closest("[data-warmup-thread]");
  if (!row) return;
  openWarmupThread(row.dataset.warmupThreadAccount, row.dataset.warmupThread);
});
