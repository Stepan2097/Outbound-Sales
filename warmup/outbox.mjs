import { anty } from "./db.mjs";

/**
 * Replies written in the portal, waiting for the account to send them.
 *
 * The portal owns no browser, so a reply cannot be sent from here: it is asked
 * for, and the account sends it from its own session — the same session that
 * reads the inbox, once a day, inside the window. That is a choice and not a
 * limitation to be fixed later: opening a warming account's browser the moment
 * somebody presses a button is an unscheduled session, which is the one signal
 * the rest of this folder exists to avoid, and a message typed out of nowhere
 * is the signal that gets an account restricted. A reply goes out the way a
 * person's would — in the morning, from the account, typed — and the page says
 * when.
 *
 * Like messages, replies live in `wl_events` (see `inbox.mjs` for why), and like
 * every row there they are never rewritten: a reply is `outbox.queued`, and what
 * happens to it is a second row that points back at it (`meta.replyId`). The
 * newest of those decides where it stands.
 *
 * What is refused here, and why:
 *
 * - Nothing that is not an answer. A thread in which nobody has written to the
 *   account is a cold message, which has its own allowance, its own copy rules
 *   and its own place in «Прогрів»; this is for replying to somebody who wrote.
 * - More than a few at a time, and more than a day's worth. A page that can put
 *   forty messages into one account's morning is a page that gets it banned.
 * - A reply that waited so long that the conversation has moved on. It is shown
 *   as not sent, and nothing sends it.
 */

export const QUEUED = "outbox.queued";
export const SENT = "outbox.sent";
export const FAILED = "outbox.failed";
export const CANCELLED = "outbox.cancelled";
export const OUTBOX_TYPES = [QUEUED, SENT, FAILED, CANCELLED];

/**
 * The reply's own text is private, like a message's, and the audit log has no
 * business listing it. The rows saying what happened to it carry no text and
 * stay visible: a send that failed is something somebody may need to act on.
 */
export const OUTBOX_AUDIT_HIDDEN = [QUEUED];

/** LinkedIn allows far more; a reply this long is not a reply. */
export const REPLY_LIMIT = 2000;

/** How many may wait on one account at once. */
export const WAITING_PER_ACCOUNT = 5;

/** What an account is asked to send in one session. */
export const REPLIES_PER_SESSION = 3;

/** How long a reply keeps waiting before it is let go: after this the conversation has moved on. */
export const EXPIRES_AFTER_MS = 72 * 60 * 60 * 1000;

/** How long a reply that is done stays on the conversation before it goes. */
const DONE_STAYS_MS = 48 * 60 * 60 * 1000;

/** The most replies an account is asked to send in a day, sent and waiting together. */
export function repliesPerDay(env = process.env) {
  const configured = Number(env.INBOX_REPLIES_PER_DAY);
  return Number.isInteger(configured) && configured >= 1 && configured <= 50 ? configured : 10;
}

/** The text as it is compared: what LinkedIn shows is not what was typed, to the whitespace. */
export function sameText(left, right) {
  const flat = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return flat(left) === flat(right);
}

/** What was typed, cleaned the way it will be sent: no stray whitespace at the ends, no carriage returns. */
export function cleanReply(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Where a reply stands, from the rows about it.
 *
 * `waiting` until something happened to it; `sent`, `failed` and `cancelled`
 * are what happened; `expired` is a waiting one nobody got to in time. The
 * newest row decides, so a reply cancelled and then — by a stale agent — marked
 * sent still reads as the last thing that was said about it.
 */
export function deriveReplies(events, { nowMs = Date.now() } = {}) {
  const queued = events.filter((row) => row.type === QUEUED);
  const verdicts = new Map();
  for (const row of events) {
    if (row.type === QUEUED || !row.meta?.replyId) continue;
    const held = verdicts.get(String(row.meta.replyId));
    if (!held || String(row.created_at) > String(held.created_at)) verdicts.set(String(row.meta.replyId), row);
  }

  return queued.map((row) => {
    const verdict = verdicts.get(String(row.id)) ?? null;
    const queuedAt = row.created_at;
    let state = "waiting";
    if (verdict?.type === SENT) state = "sent";
    else if (verdict?.type === FAILED) state = "failed";
    else if (verdict?.type === CANCELLED) state = "cancelled";
    else if (nowMs - Date.parse(queuedAt) > EXPIRES_AFTER_MS) state = "expired";
    return {
      id: String(row.id),
      accountId: row.account_id,
      // `reply` goes into a conversation that exists; `first` is the first
      // message to somebody who accepted, written on their profile, where there
      // is no conversation yet — its `threadKey` is `first:<outreachId>`, so the
      // per-conversation rules (one waiting copy of the same words) hold for it too.
      kind: row.meta?.kind === "first" ? "first" : "reply",
      outreachId: row.meta?.outreachId ? String(row.meta.outreachId) : null,
      linkedin: row.meta?.linkedin ?? null,
      threadKey: String(row.meta?.threadKey ?? ""),
      body: String(row.meta?.body ?? ""),
      participantName: row.meta?.participantName ?? null,
      queuedAt,
      state,
      at: verdict?.created_at ?? null,
      reason: state === "failed" ? String(verdict?.meta?.reason ?? "") : null
    };
  }).sort((left, right) => String(left.queuedAt).localeCompare(String(right.queuedAt)));
}

/** Everything written about this account's replies, newest first, bounded like every listing here. */
async function eventsFor(accountId) {
  return anty.from("wl_events").select("id,account_id,type,meta,created_at")
    .eq("account_id", accountId).in("type", OUTBOX_TYPES)
    .order("created_at", { ascending: false }).limit(1000).rows();
}

/** This account's replies, oldest first, each with where it stands. */
export async function repliesOf(accountId, options = {}) {
  return deriveReplies(await eventsFor(accountId), options);
}

/** Whether the account already sent a reply today — the one number the daily limit is counted by. */
function sentToday(replies, todayIso) {
  return replies.filter((reply) => reply.state === "sent" && String(reply.at || "").startsWith(todayIso)).length;
}

/**
 * Put a reply in the queue.
 *
 * Idempotent on what the person sees: the same words for the same conversation
 * while one is already waiting is that one, not a second — a double click, or a
 * page that re-sent after a timeout, must not put the same message into the
 * account twice.
 */
export async function queueReply({
  accountId, threadKey, text, participantName = null, todayIso, nowMs = Date.now(), kind = "reply", outreachId = null, linkedin = null
}) {
  const body = cleanReply(text);
  if (!body) return { ok: false, status: 400, error: "Напишіть, що відповісти." };
  if (body.length > REPLY_LIMIT) {
    return { ok: false, status: 400, error: `Відповідь задовга: ${body.length} з ${REPLY_LIMIT} символів.` };
  }

  const replies = await repliesOf(accountId, { nowMs });
  const waiting = replies.filter((reply) => reply.state === "waiting");

  const same = waiting.find((reply) => reply.threadKey === threadKey && sameText(reply.body, body));
  if (same) return { ok: true, reply: same, duplicate: true };

  if (waiting.length >= WAITING_PER_ACCOUNT) {
    return {
      ok: false, status: 429,
      error: `З цього акаунта вже чекає ${waiting.length} відповідей — вони йдуть по кілька за сесію. Дочекайтесь, поки підуть, або скасуйте зайві.`
    };
  }
  const limit = repliesPerDay();
  if (sentToday(replies, todayIso) + waiting.length >= limit) {
    return {
      ok: false, status: 429,
      error: `Ліміт на добу — ${limit} відповідей з одного акаунта, і його вже вибрано (надіслані й ті, що чекають). Далі — завтра.`
    };
  }

  const [made] = await anty.from("wl_events").insert({
    account_id: accountId,
    level: "info",
    type: QUEUED,
    message: "Reply queued",
    meta: {
      threadKey, body, participantName, length: body.length,
      ...(kind === "first" ? { kind: "first", outreachId: String(outreachId), linkedin } : {})
    }
  }).select("id,created_at").rows();
  if (!made?.id) throw new Error("The database did not say which reply it stored");
  return {
    ok: true, duplicate: false,
    reply: {
      id: String(made.id), accountId, threadKey, body, participantName,
      kind: kind === "first" ? "first" : "reply", outreachId: kind === "first" ? String(outreachId) : null,
      linkedin: kind === "first" ? linkedin : null,
      queuedAt: made.created_at ?? new Date(nowMs).toISOString(), state: "waiting", at: null, reason: null
    }
  };
}

/** One reply of this account, or null — an id from another account is not one. */
export async function replyOf(accountId, replyId, options = {}) {
  return (await repliesOf(accountId, options)).find((reply) => reply.id === String(replyId)) ?? null;
}

async function note(accountId, type, replyId, message, meta = {}) {
  await anty.from("wl_events").insert({
    account_id: accountId,
    level: type === FAILED ? "warn" : "info",
    type,
    message,
    meta: { replyId: String(replyId), ...meta }
  }).rows();
}

/**
 * Take a reply back, or put away one that did not go. Only what is not already
 * sent: a reply that has gone out cannot be taken back from here, and saying
 * that is the point of refusing.
 */
export async function cancelReply(accountId, replyId, options = {}) {
  const reply = await replyOf(accountId, replyId, options);
  if (!reply) return { ok: false, status: 404, error: "Такої відповіді немає." };
  if (reply.state === "sent") return { ok: false, status: 409, error: "Ця відповідь уже надіслана — її не скасувати." };
  if (reply.state === "cancelled") return { ok: true, reply };
  await note(accountId, CANCELLED, replyId, "Reply cancelled");
  return { ok: true, reply: { ...reply, state: "cancelled" } };
}

/**
 * What the account is asked to send in this session: the oldest waiting, not
 * more than the session's share, and never past the day's limit. Empty while
 * paused or when told so — the caller decides that, this only counts.
 */
export async function repliesToSend(accountId, { todayIso, nowMs = Date.now() } = {}) {
  const replies = await repliesOf(accountId, { nowMs });
  const waiting = replies.filter((reply) => reply.state === "waiting");
  const room = Math.max(0, repliesPerDay() - sentToday(replies, todayIso));
  return {
    toSend: waiting.slice(0, Math.min(REPLIES_PER_SESSION, room)),
    waiting: waiting.length,
    sentToday: sentToday(replies, todayIso),
    perDay: repliesPerDay()
  };
}

/**
 * The agent asks, right before typing, whether this one still goes out. Asked
 * rather than assumed because the plan was cut minutes or hours earlier and a
 * person may have taken the reply back since — and a message typed after it was
 * cancelled is not something that can be undone.
 */
export async function prepareReply(accountId, replyId, { todayIso, nowMs = Date.now() } = {}) {
  const replies = await repliesOf(accountId, { nowMs });
  const reply = replies.find((row) => row.id === String(replyId)) ?? null;
  if (!reply || reply.state !== "waiting") return { allowed: false, reply, reason: reply ? reply.state : "unknown" };
  if (sentToday(replies, todayIso) >= repliesPerDay()) return { allowed: false, reply, reason: "limit" };
  return { allowed: true, reply, reason: null };
}

/**
 * Said by the agent after LinkedIn showed the message in the conversation —
 * never before. Only a waiting reply moves: a repeat is harmless and answers
 * what it answered, and a reply cancelled while it was being typed is still
 * recorded as sent, because it was.
 */
export async function markReplySent(accountId, replyId, options = {}) {
  const reply = await replyOf(accountId, replyId, options);
  if (!reply) return { ok: false, status: 404, error: "Такої відповіді немає." };
  if (reply.state === "sent") return { ok: true, reply, repeated: true };
  await note(accountId, SENT, replyId, "Reply sent");
  return { ok: true, reply: { ...reply, state: "sent" } };
}

/** Said by the agent when it could not send, or could not tell. The reason is shown to the person. */
export async function markReplyFailed(accountId, replyId, reason, options = {}) {
  const reply = await replyOf(accountId, replyId, options);
  if (!reply) return { ok: false, status: 404, error: "Такої відповіді немає." };
  if (reply.state === "sent") return { ok: true, reply, repeated: true };
  const why = String(reason || "без причини").replace(/\s+/g, " ").trim().slice(0, 300);
  await note(accountId, FAILED, replyId, `Reply not sent — ${why}`, { reason: why });
  return { ok: true, reply: { ...reply, state: "failed", reason: why } };
}

/**
 * What the conversation shows of its replies.
 *
 * Waiting and failed ones, so the person sees what is owed and what went wrong;
 * and sent ones until the message itself turns up among the stored ones — the
 * agent re-reads the conversation after sending, but when that read did not
 * happen the reply would otherwise vanish for up to a day, which reads as lost.
 * Cancelled ones are gone, and what is done and old is let go.
 */
export function visibleReplies(replies, messages = [], { nowMs = Date.now() } = {}) {
  return replies.filter((reply) => {
    if (reply.state === "cancelled") return false;
    if (reply.state === "waiting") return true;
    // Since when it has been in its present state: for one nobody got to, since
    // the moment it ran out, not since it was written.
    const since = reply.state === "expired"
      ? Date.parse(reply.queuedAt) + EXPIRES_AFTER_MS
      : Date.parse(reply.at || reply.queuedAt);
    if (nowMs - since > DONE_STAYS_MS) return false;
    if (reply.state !== "sent") return true;
    return !messages.some((message) => message.direction === "out"
      && sameText(message.body, reply.body)
      && Date.parse(message.sentAt || "") >= Date.parse(reply.queuedAt) - 5 * 60_000);
  });
}

/** The conversation key a first message is queued under: there is no LinkedIn thread yet. */
export function firstThreadKey(outreachId) {
  return `first:${outreachId}`;
}
