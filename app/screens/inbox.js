// Вхідні — the replies from every warm-up account, laid out like a messenger:
// the accounts across the top (one tap narrows to one of them), that account's
// conversations on the left — unread first, then the newest — and on the right
// the whole conversation with the person who is open, without leaving the
// screen. On a phone the same thing is a list and, after a tap, the conversation
// with a way back. The conversation opens the person's card in «Контакти». The
// unread count sits on the menu item.

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

/**
 * Що вписано в пошук над списком — рівно як вписано, з пробілами. Фільтр живе в
 * стані, а не в полі: список перемальовується щоразу, коли приходить відповідь чи
 * прочитано розмову. Обрізати пробіли тут не можна: поле звіряється з цим
 * значенням, і «UA » ставало б «UA», а пробіл, який людина щойно набрала, зникав.
 */
let inboxSearch = "";

/** Слова пошуку: порожньо, коли в полі самі пробіли. */
function inboxSearchTerms() {
  return inboxSearch.toLowerCase().split(/\s+/).filter(Boolean);
}

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
 * Не текст, а мітка агента: повідомлення без тексту (картка профілю, службова
 * плашка, вкладення) він зберігає як «[no text]» чи «[attachment]». У списку й у
 * розмові це читається як мітка в дужках, а не як те, що написала людина.
 */
const WARMUP_PLACEHOLDERS = { "[no text]": "без тексту", "[attachment]": "вкладення без тексту" };

function warmupPlaceholder(body) {
  return WARMUP_PLACEHOLDERS[String(body ?? "").trim().toLowerCase()] || null;
}

/**
 * A stranger's message, escaped. The return value is HTML, so there is no
 * version of this text that reaches the DOM unescaped: newlines survive
 * because `.warmup-message-body` is `white-space: pre-wrap`, not because
 * anything here builds tags out of what was typed.
 */
function warmupBodyHtml(body) {
  const placeholder = warmupPlaceholder(body);
  if (placeholder) return `<em class="warmup-subtle">(${placeholder})</em>`;
  return escapeHtml(String(body ?? ""));
}

/** The first line of a message, for a list row that has two lines to spend. */
function warmupPreviewHtml(body, limit = 150) {
  const placeholder = warmupPlaceholder(body);
  if (placeholder) return `<em class="warmup-subtle">(${placeholder})</em>`;
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return '<em class="warmup-subtle">(без тексту)</em>';
  const chars = Array.from(text);
  return escapeHtml(chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text);
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

/**
 * The name as the agent read it, minus the words LinkedIn puts in front of it
 * for screen readers: a profile card is labelled "Переглянути профіль Sinan",
 * and without this the list shows ten rows that all begin with the same three
 * words and differ only at the end.
 */
const WARMUP_NAME_NOISE = /^(?:переглянути\s+профіль|view\s+profile\s+of|view\s+profile)(?:\s+|$)/i;

function warmupCleanName(participant) {
  // Runs of whitespace are collapsed before anything is compared: the agent
  // reads these strings out of the DOM, where "LinkedIn Member" can arrive as
  // "LinkedIn\n      Member". Collapsing cannot swallow a real name — "Linda
  // Memberly" is still not in the set however it was spaced.
  return String(participant?.name || "").replace(/\s+/g, " ").trim().replace(WARMUP_NAME_NOISE, "").trim();
}

function warmupParticipantUnnamed(participant) {
  const name = warmupCleanName(participant);
  return !name || WARMUP_UNNAMED.has(name.toLowerCase());
}

/** Who wrote, or an honest admission that nobody here knows. */
function warmupParticipantName(participant) {
  if (warmupParticipantUnnamed(participant)) return "Без імені";
  return warmupCleanName(participant);
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
  const terms = inboxSearchTerms();
  return warmupState.inbox.threads
    .filter((thread) => !inboxAccountFilter || thread.accountId === inboxAccountFilter)
    .filter((thread) => warmupInboxMatches(thread, terms))
    .sort((left, right) => Number(Boolean(right.unread)) - Number(Boolean(left.unread)) || sentAt(right) - sentAt(left));
}

/**
 * Чи підходить розмова під пошук: кожне слово запиту має знайтись серед імені,
 * посади чи компанії людини, акаунта, на який надійшло, і тексту останньої
 * відповіді. Шукається те, що видно в рядку, — нічого прихованого.
 */
function warmupInboxMatches(thread, terms) {
  if (!terms.length) return true;
  const participant = thread.participant || {};
  const haystack = [
    warmupParticipantName(participant),
    participant.headline,
    warmupThreadAccount(thread).name,
    warmupPlaceholder(thread.lastMessage?.body) ? "" : thread.lastMessage?.body
  ].join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function warmupThreadRowHtml(thread) {
  const participant = thread.participant || {};
  const name = warmupParticipantName(participant);
  const account = warmupThreadAccount(thread);
  const last = thread.lastMessage || {};
  const mine = last.direction === "out";
  const open = warmupThreadIsOpen(thread.accountId, thread.threadKey);
  // The account is said on the row only while the list holds every account's
  // threads; once one account is picked, naming it on each row is noise.
  const showAccount = !inboxAccountFilter;
  return `
    <button class="warmup-thread ${thread.unread ? "is-unread" : ""} ${open ? "is-open" : ""}" type="button"
      data-warmup-thread="${escapeAttr(thread.threadKey || "")}"
      data-warmup-thread-account="${escapeAttr(thread.accountId || "")}"${open ? ' aria-current="true"' : ""}
      aria-label="${escapeAttr(`Розмова з ${name}, акаунт ${account.name}${thread.unread ? ", непрочитане" : ""}`)}">
      <span class="warmup-thread-mark" aria-hidden="true"></span>
      <span class="warmup-thread-main">
        <span class="warmup-thread-top">
          <strong${warmupParticipantNameAttr(participant)}>${escapeHtml(name)}</strong>
          <time datetime="${escapeAttr(last.sentAt || "")}" title="${escapeAttr(warmupStamp(last.sentAt))}">${escapeHtml(warmupAgo(last.sentAt) || "—")}</time>
        </span>
        ${participant.headline ? `<span class="warmup-thread-headline">${escapeHtml(participant.headline)}</span>` : ""}
        <span class="warmup-thread-preview">${mine ? '<span class="warmup-thread-from">Ви:</span> ' : ""}${warmupPreviewHtml(last.body)}</span>
        ${showAccount ? `<span class="warmup-identity" title="${escapeAttr(warmupAccountTitle(account))}">
          <i data-lucide="${account.exact ? "badge-check" : "circle-help"}"></i>
          <span>${escapeHtml(account.name)}</span>
        </span>` : ""}
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

/**
 * Said while the list is narrowed — by an account, by a search, or both: how
 * many of the threads are shown, and the way back to all of them. The count is
 * what tells a seller that the list is short because of the filter, not because
 * nobody wrote.
 */
function warmupInboxFilterHtml(shown) {
  if (!inboxAccountFilter && !inboxSearchTerms().length) return "";
  return `<div class="warmup-inbox-filter">
    <span>Розмов: <strong>${warmupCount(shown)}</strong> з ${warmupCount(warmupState.inbox.threads.length)}</span>
    <button class="warmup-inbox-link" type="button" data-warmup-inbox-reset>Скинути фільтр</button>
  </div>`;
}

/**
 * The accounts that have a thread here, for the list above the replies: how many
 * threads each holds and how many of them are waiting. The account the list is
 * narrowed to is always among them, even when it holds none, so the field can
 * say what it is set to.
 */
function warmupInboxAccountOptions() {
  const found = new Map();
  for (const thread of warmupState.inbox.threads) {
    if (!thread.accountId) continue;
    const entry = found.get(thread.accountId) || { accountId: thread.accountId, count: 0, unread: 0 };
    entry.count += 1;
    if (thread.unread) entry.unread += 1;
    found.set(thread.accountId, entry);
  }
  if (inboxAccountFilter && !found.has(inboxAccountFilter)) {
    found.set(inboxAccountFilter, { accountId: inboxAccountFilter, count: 0, unread: 0 });
  }
  return [...found.values()]
    .map((entry) => ({ ...entry, name: warmupInboxAccountName(entry.accountId) }))
    .sort((left, right) => right.unread - left.unread || left.name.localeCompare(right.name, "uk"));
}

/**
 * The accounts across the top, one button each: «Усі акаунти» and every account
 * that has a thread, with the number of replies waiting on it. One tap narrows
 * the list to that account, which is the whole of "open just one account". With
 * a single account there is nothing to pick, and the row is not drawn.
 */
function warmupInboxChipsHtml() {
  const options = warmupInboxAccountOptions();
  if (options.length < 2 && !inboxAccountFilter) return "";
  const chip = (accountId, label, unread) => {
    const active = (inboxAccountFilter || "") === accountId;
    return `<button class="inbox-chip ${active ? "is-active" : ""}" type="button" data-warmup-account="${escapeAttr(accountId)}" aria-pressed="${active}">
      <span class="inbox-chip-name">${escapeHtml(label)}</span>${unread ? `<span class="inbox-chip-count" aria-label="непрочитаних: ${unread}">${warmupCount(unread)}</span>` : ""}
    </button>`;
  };
  const unreadAll = warmupState.inbox.threads.filter((thread) => thread.unread).length;
  return chip("", "Усі акаунти", unreadAll) + options.map((entry) => chip(entry.accountId, entry.name, entry.unread)).join("");
}

/** Where the conversation goes while none is open: what to do, and the shortest way to start. */
function warmupThreadPlaceholderHtml() {
  const next = warmupNextUnread();
  return `<div class="inbox-thread-empty">
    <i data-lucide="message-square"></i>
    <strong>Оберіть розмову зі списку</strong>
    <span>Тут буде вся переписка з цією людиною, від найстарішого.</span>
    ${next ? `<button class="primary-button" type="button" data-warmup-inbox-next><span>Почати з непрочитаної: ${escapeHtml(warmupParticipantName(next.participant || {}))}</span><i data-lucide="arrow-right"></i></button>` : ""}
  </div>`;
}

/** The first unread thread in the list as it is drawn, other than the one that is open. */
function warmupNextUnread() {
  const inbox = warmupState.inbox;
  return warmupInboxRows().find((thread) => thread.unread
    && !(thread.accountId === inbox.openAccountId && thread.threadKey === inbox.openThreadKey)) || null;
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
  const back = '<button class="text-button warmup-thread-back" type="button" data-warmup-inbox-back><i data-lucide="arrow-left"></i><span>Назад до списку</span></button>';

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

  // The end of a conversation is where somebody who is working through the
  // replies stops reading, so that is where the way to the next one is.
  const next = warmupNextUnread();
  return `${head}
    <ol class="warmup-messages">${messages.map((message) => warmupMessageHtml(message, name, account.name)).join("")}</ol>
    <p class="warmup-thread-foot">Тут можна тільки читати: відповідь іде з самого акаунта.</p>
    ${next ? `<button class="primary-button warmup-thread-next" type="button" data-warmup-inbox-next><span>Наступна непрочитана: ${escapeHtml(warmupParticipantName(next.participant || {}))}</span><i data-lucide="arrow-right"></i></button>` : ""}`;
}

/** What the conversation pane showed last, so a redraw that changes nothing leaves its scroll alone. */
let inboxPaneKey = "";

export function renderWarmupInbox() {
  const title = document.getElementById("warmupInboxTitle");
  const subtitle = document.getElementById("warmupInboxSubtitle");
  const pill = document.getElementById("warmupInboxPill");
  const body = document.getElementById("warmupInboxBody");
  const notice = document.getElementById("warmupInboxNotice");
  const chips = document.getElementById("warmupInboxAccounts");
  const layout = document.getElementById("warmupInboxLayout");
  const pane = document.getElementById("warmupInboxThread");
  const search = document.getElementById("warmupInboxSearch");
  if (!body || !title || !subtitle) return;

  const inbox = warmupState.inbox;
  renderWarmupNavBadge();
  title.textContent = "Вхідні";

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

  // Nothing to pick from: one message across the whole panel, no accounts, no panes.
  const alone = (html, line) => {
    subtitle.textContent = line;
    if (notice) { notice.innerHTML = html; notice.hidden = !html; }
    if (chips) chips.hidden = true;
    if (layout) layout.hidden = true;
    refreshIcons();
  };

  if (!inbox.available) {
    alone(`<div class="warmup-inbox-note is-warn">
      <strong>На цьому сервері немає ендпоїнта вхідних.</strong>
      <span>З акаунтами все гаразд — просто цей портал старший за вхідні. Нічия відповідь не губиться, але й ніхто її не читає.</span>
    </div>`, "Вхідних на цьому сервері ще немає");
    return;
  }

  if (inbox.error) {
    alone(`<div class="warmup-inbox-note is-bad">
      <strong>${escapeHtml(inbox.error)}</strong>
      <span>«Вхідні не відповідають» і «ніхто не написав» — це різні відповіді; тут перша.</span>
    </div>`, "Вхідні не вдалося прочитати");
    return;
  }

  if (!inbox.ready) {
    alone('<div class="empty-state">Завантажуємо вхідні...</div>', "Читаємо, що прийшло");
    return;
  }

  const sync = warmupInboxSync();
  // Three answers, not two: read at a time, never read, and not reported. The
  // subtitle must not turn the third into the second.
  const readLine = sync.lastSyncedAt
    ? `читали ${warmupAgo(sync.lastSyncedAt)}`
    : (sync.known ? "ще не читали" : "");

  if (!inbox.threads.length) {
    alone(warmupInboxEmptyHtml(sync), readLine);
    return;
  }

  subtitle.textContent = readLine;
  const note = warmupInboxNoteHtml(sync);
  if (notice) { notice.innerHTML = note; notice.hidden = !note; }

  const chipsHtml = warmupInboxChipsHtml();
  if (chips) {
    if (chips.innerHTML !== chipsHtml) chips.innerHTML = chipsHtml;
    chips.hidden = !chipsHtml;
  }

  // The search field stands outside what is redrawn, so what is being typed
  // survives; it is only kept in step with the state, and not rewritten while
  // it already says the same (a rewrite would move the caret).
  if (search && search.value !== inboxSearch) search.value = inboxSearch;

  const open = inbox.openThreadKey !== null;
  if (layout) {
    layout.hidden = false;
    layout.classList?.toggle("has-thread", open);
  }
  // On a phone the open conversation has the screen to itself: the note and the
  // accounts above it are hidden by this class and come back with the list.
  document.getElementById("view-inbox")?.classList?.toggle?.("inbox-has-thread", open);

  // The list.
  const rows = warmupInboxRows();
  const filterLine = warmupInboxFilterHtml(rows.length);
  const listHtml = rows.length
    ? `${filterLine}<div class="warmup-threads">${rows.map((thread) => warmupThreadRowHtml(thread)).join("")}</div>`
    : `${filterLine}${inboxSearchTerms().length
      ? '<div class="warmup-inbox-note is-calm"><strong>За цим запитом нічого не знайшлось.</strong><span>Шукається в імені, посаді, акаунті й тексті останньої відповіді.</span></div>'
      : '<div class="warmup-inbox-note is-calm"><strong>Від цього акаунта відповідей немає.</strong></div>'}`;
  if (body.innerHTML !== listHtml) {
    const scrolled = body.scrollTop;
    body.innerHTML = listHtml;
    if (typeof scrolled === "number") body.scrollTop = scrolled;
  }

  // The conversation, drawn only when it changed, and from the top when it is a
  // different one — a list that reloads must not throw the reader back to the
  // first message.
  if (pane) {
    const paneHtml = open ? warmupThreadViewHtml() : warmupThreadPlaceholderHtml();
    const paneKey = open ? `${inbox.openAccountId}|${inbox.openThreadKey}` : "";
    if (pane.innerHTML !== paneHtml) {
      const scrolled = pane.scrollTop;
      pane.innerHTML = paneHtml;
      pane.scrollTop = paneKey === inboxPaneKey && typeof scrolled === "number" ? scrolled : 0;
    }
    inboxPaneKey = paneKey;
  }
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
    if (Number.isFinite(config?.unreadReplies)) {
      const before = warmupState.unreadReplies;
      setWarmupUnread(config.unreadReplies);
      // Хтось відповів, поки екран відкритий: список не чекає, поки його
      // оновлять руками. Розмова, яку читають, не перемальовується з-під очей.
      if (Number.isFinite(before) && before !== config.unreadReplies && warmupInboxListOnScreen()) void loadWarmupInbox();
    }
  } catch (error) {
    // A portal without the count is not a portal with a wrong count: leave the
    // badge as it was, and stop pestering a server that has no such route.
    if (error?.status === 404) stopWarmupBadgePoll();
  }
}

/** Чи видно зараз вхідні: розмова праворуч від списку не заважає, список оновлюється поруч. */
function warmupInboxListOnScreen() {
  const inbox = warmupState.inbox;
  return Boolean(document.getElementById("view-inbox")?.classList.contains("active"))
    && inbox.ready && inbox.available;
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

async function openWarmupThread(accountId, threadKey, { refresh = false } = {}) {
  const inbox = warmupState.inbox;
  inbox.openAccountId = accountId;
  inbox.openThreadKey = threadKey;
  // Reloading the conversation that is already on the screen keeps showing it
  // until the new answer comes, instead of flashing «Відкриваємо розмову...».
  if (!refresh) inbox.open = null;
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

// «Оновити» перечитує список, а коли відкрита розмова — і її: інакше кнопка
// оновила б лише те, що збоку.
document.getElementById("warmupInboxRefreshBtn")?.addEventListener("click", async () => {
  const inbox = warmupState.inbox;
  await loadWarmupInbox();
  if (inbox.openThreadKey !== null) openWarmupThread(inbox.openAccountId, inbox.openThreadKey, { refresh: true });
});

// Акаунти зверху: один дотик — і список лише цього акаунта.
document.getElementById("warmupInboxAccounts")?.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-warmup-account]");
  if (!chip) return;
  inboxAccountFilter = chip.dataset.warmupAccount || null;
  renderWarmupInbox();
});

// Список і розмова — обидві живуть у цьому контейнері, тож клік обробляється тут.
document.getElementById("warmupInboxLayout")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-warmup-inbox-back]")) {
    closeWarmupThread();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-reset]")) {
    inboxAccountFilter = null;
    inboxSearch = "";
    renderWarmupInbox();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-next]")) {
    const next = warmupNextUnread();
    if (!next) return;
    openWarmupThread(next.accountId, next.threadKey);
    // Кнопка стоїть унизу розмови, а наступна починається зверху.
    globalThis.scrollTo?.(0, 0);
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

document.getElementById("warmupInboxSearch")?.addEventListener("input", (event) => {
  inboxSearch = event.target.value;
  renderWarmupInbox();
});

// Вкладка, що довго була прихована, не опитувала лічильник: при поверненні він
// береться одразу, а не за дві хвилини. Приховану вкладку refreshWarmupBadge
// сама не питає.
document.addEventListener("visibilitychange", () => refreshWarmupBadge());
