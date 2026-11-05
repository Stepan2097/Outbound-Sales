import { conversations } from "./conversations.mjs";

/**
 * ESP-UI 4 — the cold-email Unibox (Snov's «Unibox», screen 02): one list of
 * every conversation the sending mailboxes have had, in folders, with search,
 * filters by reply, campaign and mailbox, and pages of 50.
 *
 * Folders, as Snov's: «Вхідні» — something came back (a reply, an auto-reply,
 * a bounce, an unsubscribe); «Надіслані» — every conversation we started,
 * answered or not; «Із зірочкою»; «Bounce». A row is bold while a reply in it
 * is newer than the last time anybody on the team opened it — the inbox is
 * the team's, as Snov's Unibox is the account's.
 *
 * Stars and «read» are journal lines (`conversation.starred`, `conversation.read`)
 * like every other change here: who did it and when stays on record, and
 * nothing outside the journal needs to be kept in step with it.
 */

// Owner 03.11 «проаналізуй листи і нормально просортуй»: «Вхідні» — лише живі
// відповіді людей; автовідповіді (у відпустці, служба підтримки з тікетом),
// відписки й bounce — кожне в своїй папці.
export const UNIBOX_FOLDERS = { inbox: "Вхідні", auto: "Автовідповіді", unsubscribed: "Відписки", bounced: "Bounce", starred: "Із зірочкою", sent: "Надіслані" };

// A help desk acknowledging a ticket is a machine, not the person: a support or
// no-reply address, or the desk's stock sentences.
const DESK_ADDRESS = /^(support|help|helpdesk|service|customer|care|tickets?|noreply|no-reply|donotreply|payments?(-support)?|billing|info|contact|hello|team)[\w.+-]*@/i;
const DESK_TEXT = /how can we help you today|we (have )?received your (request|message|e-?mail|ticket)|your (ticket|request) (number|#|id)|ticket #?\d|thank you for (contacting|reaching out to) (us|our)|this is an automated|automatic(ally)? (reply|response)|do not reply to this/i;

/** An inbound letter that only looks like a reply. */
export function isAutoAck(message, contact = "") {
  if (message?.kind !== "replied") return false;
  return DESK_TEXT.test(String(message.text || "")) || (DESK_ADDRESS.test(String(contact)) && String(message.text || "").length < 600);
}
export const UNIBOX_PAGE = 50;

/** Stars and the last time each conversation was opened, from the journal. */
export function uniboxMarks(entries) {
  const starred = new Set();
  const readAt = new Map();
  for (const entry of entries) {
    const key = entry.data?.key;
    if (!key) continue;
    if (entry.type === "conversation.starred") { if (entry.data.on) starred.add(key); else starred.delete(key); }
    else if (entry.type === "conversation.read") readAt.set(key, entry.at);
  }
  return { starred, readAt };
}

const firstLine = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 180);

/** One conversation as a list row: no texts beyond a snippet. */
function rowOf(thread, { marks, leads, campaigns }) {
  const last = thread.messages.at(-1);
  const lastIn = [...thread.messages].reverse().find((message) => message.direction === "in");
  const readAt = marks.readAt.get(thread.key);
  const lead = leads.get(thread.contact) || {};
  return {
    key: thread.key,
    contact: thread.contact,
    name: lead.name || "",
    company: lead.company || "",
    sender: thread.sender,
    campaignId: thread.campaignId,
    campaignName: campaigns.get(thread.campaignId) || null,
    subject: thread.subject || "",
    snippet: firstLine(last?.text) || (last?.kind === "bounced" ? `Лист не доставлено${last.code ? ` (${last.code})` : ""}` : last?.kind === "unsubscribed" ? "Відписка" : last?.kind === "autoreplied" ? "Автовідповідь" : ""),
    count: thread.messages.length,
    // A label is for what a person said; a desk's «how can we help» is not «neutral».
    label: thread.messages.some((message) => message.kind === "replied" && !isAutoAck(message, thread.contact)) ? thread.label : null,
    lastAt: thread.lastAt,
    lastDirection: last?.direction || "out",
    inbound: thread.inbound,
    // Whether a person answered, and whether anything came back by itself.
    human: thread.messages.some((message) => message.kind === "replied" && !isAutoAck(message, thread.contact)),
    auto: thread.messages.some((message) => message.kind === "autoreplied" || isAutoAck(message, thread.contact)),
    bounced: thread.messages.some((message) => message.kind === "bounced"),
    unsubscribed: thread.messages.some((message) => message.kind === "unsubscribed"),
    starred: marks.starred.has(thread.key),
    unread: Boolean(lastIn && (!readAt || String(lastIn.at) > String(readAt)))
  };
}

function inFolder(row, folder) {
  if (folder === "sent") return true;
  if (folder === "starred") return row.starred;
  if (folder === "bounced") return row.bounced;
  if (folder === "unsubscribed") return row.unsubscribed;
  if (folder === "auto") return row.auto && !row.human && !row.unsubscribed && !row.bounced;
  // «Вхідні»: a person answered (and did not just unsubscribe).
  return row.human && !row.unsubscribed;
}

/**
 * The page of the list for `folder`, filtered: `label` (a reply label, or
 * `unread`), `campaign`, `sender`, `q` (address, name, company, subject or any
 * text of the conversation). Counts are per folder before the filters, as the
 * side column shows them.
 */
export function uniboxList(entries, { folder = "inbox", label = "", campaign = "", sender = "", q = "", offset = 0, limit = UNIBOX_PAGE, leads = new Map(), campaigns = new Map() } = {}) {
  const marks = uniboxMarks(entries);
  const threads = conversations(entries, { all: true });
  const rows = threads.map((thread) => ({ thread, row: rowOf(thread, { marks, leads, campaigns }) }));
  const counts = {
    inbox: rows.filter(({ row }) => inFolder(row, "inbox")).length,
    unread: rows.filter(({ row }) => inFolder(row, "inbox") && row.unread).length,
    auto: rows.filter(({ row }) => inFolder(row, "auto")).length,
    unsubscribed: rows.filter(({ row }) => inFolder(row, "unsubscribed")).length,
    sent: rows.length,
    starred: rows.filter(({ row }) => row.starred).length,
    bounced: rows.filter(({ row }) => row.bounced).length
  };
  const needle = String(q || "").trim().toLowerCase();
  const matches = rows.sort((left, right) => String(right.row.lastAt).localeCompare(String(left.row.lastAt))).filter(({ thread, row }) => inFolder(row, folder)
    && (!label || (label === "unread" ? row.unread : row.label === label))
    && (!campaign || row.campaignId === campaign)
    && (!sender || row.sender === sender)
    && (!needle || [row.contact, row.name, row.company, row.subject].some((value) => String(value).toLowerCase().includes(needle))
      || thread.messages.some((message) => String(message.text || "").toLowerCase().includes(needle))));
  const size = Math.max(1, Math.min(100, Number(limit) || UNIBOX_PAGE));
  // A page that no longer exists (the list shrank) shows the last one.
  const lastPage = Math.max(0, Math.ceil(matches.length / size) - 1);
  const start = Math.min(Math.floor(Math.max(0, Number(offset) || 0) / size), lastPage) * size;
  return {
    folder: UNIBOX_FOLDERS[folder] ? folder : "inbox",
    total: matches.length,
    offset: start,
    limit: size,
    counts,
    rows: matches.slice(start, start + size).map(({ row }) => row),
    senders: [...new Set(threads.map((thread) => thread.sender))].sort(),
    campaigns: [...new Set(threads.map((thread) => thread.campaignId).filter(Boolean))].map((id) => ({ id, name: campaigns.get(id) || id })).sort((left, right) => left.name.localeCompare(right.name))
  };
}

/** One conversation in full, with its row (stars, unread) on top. */
export function uniboxThread(entries, key, { leads = new Map(), campaigns = new Map() } = {}) {
  const thread = conversations(entries, { all: true }).find((row) => row.key === key);
  if (!thread) return null;
  return { ...rowOf(thread, { marks: uniboxMarks(entries), leads, campaigns }), messages: thread.messages, threadId: thread.threadId };
}

/**
 * What stands between the inbox and the mail, for the yellow banner on top —
 * as Snov's «Specify the IMAP settings for …». Each item names what to do.
 */
export function uniboxProblems({ mode = "stub", polling = false } = {}) {
  const problems = [];
  if (mode === "stub") problems.push({ code: "stub", text: "Пошту ще не підключено — працює заглушка: листи з Gmail не читаються, і відповісти звідси не можна. Підключення — «Пошта» → «Прогрів пошт» → «Додати пошту» → «Увійти через Google»." });
  else if (!polling) problems.push({ code: "not_polling", text: "Пошти зараз не читаються (ланцюжок вимкнено, ESP_SEQUENCE) — нові відповіді не з'являться, доки його не ввімкнуть." });
  // A paused mailbox is not raised here (owner 05.11: «сповіщення На паузі … не
  // треба показувати на цій і на інших сторінках окрім прогріву») — «Прогрів
  // пошт» shows each pause with its reason and what to do.
  return problems;
}
