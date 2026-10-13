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

export const UNIBOX_FOLDERS = { inbox: "Вхідні", sent: "Надіслані", starred: "Із зірочкою", bounced: "Bounce" };
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
    snippet: firstLine(last?.text) || (last?.kind === "bounced" ? `Лист не доставлено${last.code ? ` (${last.code})` : ""}` : last?.kind === "unsubscribed" ? "Відписка" : ""),
    count: thread.messages.length,
    label: thread.label,
    lastAt: thread.lastAt,
    lastDirection: last?.direction || "out",
    inbound: thread.inbound,
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
  return row.inbound > 0;
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
    unread: rows.filter(({ row }) => row.unread).length,
    sent: rows.length,
    starred: rows.filter(({ row }) => row.starred).length,
    bounced: rows.filter(({ row }) => row.bounced).length
  };
  const needle = String(q || "").trim().toLowerCase();
  const matches = rows.filter(({ thread, row }) => inFolder(row, folder)
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
export function uniboxProblems({ mode = "stub", polling = false, senders = [] } = {}) {
  const problems = [];
  if (mode === "stub") problems.push({ code: "stub", text: "Пошту ще не підключено — працює заглушка: листи з Gmail не читаються, і відповісти звідси не можна. Підключення — «Пошта» → «Скриньки» → «Додати скриньку» → «Увійти через Google»." });
  else if (!polling) problems.push({ code: "not_polling", text: "Скриньки зараз не читаються (ланцюжок вимкнено, ESP_SEQUENCE) — нові відповіді не з'являться, доки його не ввімкнуть." });
  const paused = senders.filter((row) => row.status === "paused").map((row) => row.email);
  if (paused.length) problems.push({ code: "paused", text: `На паузі: ${paused.join(", ")} — їхні листи не йдуть. Причина й зняття паузи — у реєстрі відправників.`, senders: paused });
  return problems;
}
