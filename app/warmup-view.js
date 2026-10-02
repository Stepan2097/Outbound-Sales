/**
 * The warm-up screens' decisions that do not need a page to make.
 *
 * Kept out of `main.js` so they can be tested: `main.js` reads `window` and
 * `document` the moment it loads, and nothing but a browser can import it.
 * Everything here takes plain values and answers plain values — no DOM, no
 * fetch, no state of its own. `main.js` imports it; so does
 * `tests/warmup-view.test.mjs`.
 */

/**
 * The auto-feed facts for one account's card, when they are about the
 * campaign on screen — and `null` when they are not.
 *
 * The queue cache is keyed by account alone, and `autoFeed` in it describes
 * the campaign the queue was loaded for. Two campaigns can tick the same
 * account, so without this check a card under «Черга · B» said what campaign
 * A was doing: "not running", or A's first day. Nothing is better than that
 * until the right answer arrives.
 */
export function autoFeedFor(queue, campaignId) {
  const feed = queue?.autoFeed;
  return feed && campaignId && feed.campaignId === campaignId ? feed : null;
}

/**
 * Whether a queue answer still belongs on screen: it was asked for the
 * campaign that is still selected. A slow answer for the campaign somebody
 * just clicked away from would otherwise land on top of the new one's.
 */
export function queueAnswerIsCurrent(askedFor, selectedNow) {
  return (askedFor || "") === (selectedNow || "");
}

/**
 * An account's queue entry after «Закріпити зараз» failed: the error, and
 * everything the card already showed.
 *
 * The success branch keeps the rest of the entry; the failure branch used to
 * build a new one from the claims alone, so the auto-feed line and the list
 * of people waiting for the agent vanished — and a 409 on a paused account,
 * exactly when that line explains why, read as "the folder is off and nobody
 * is waiting".
 */
export function queueAfterFailedClaim(existing, error) {
  return {
    ...(existing || {}),
    rows: existing?.rows || [],
    reason: "",
    error: error?.status === 404 ? "Цей сервер ще не вміє закріплювати." : error?.message || "Не вдалося закріпити",
    unavailable: ""
  };
}

/**
 * What a seller is asked before an invitation is cancelled.
 *
 * Cancelling somebody the folder added also takes them out of the folder's
 * feed for good (the server writes `campaign.skipped`), so the question says
 * so. "Back to the pool" alone reads as "the folder may take them again",
 * which it will not: from then on only a person can queue them.
 */
export function inviteCancelQuestion(invite) {
  if (!invite?.fromCampaign) return "Скасувати запит і повернути людину в пул?";
  return "Скасувати запит? Автопідбір більше не братиме цю людину (вручну поставити можна).";
}

/**
 * Why a waiting invitation needs a person, or "" when it does not.
 *
 * A block page on the request pauses the account and parks the request at
 * once — the agent is not handed it again until somebody moves it to another
 * account or cancels it. A seller has to act on it, so it says what to do.
 */
export function inviteAttentionText(invite) {
  if (invite?.status !== "waiting" || !invite.parked) return "";
  return "Потребує уваги: LinkedIn показав блокування — перекинь на інший акаунт або скасуй.";
}

/**
 * The one state that needs a word beyond its pill: a draft does nothing until
 * somebody starts it. Every other state is said by the pill alone.
 */
export function campaignStateNote(campaign) {
  return campaign?.state === "draft" ? "Чернетка — запусти, щоб почати." : "";
}

/**
 * The campaign row's "from which day", as `{ text, title }`, or `null` for a
 * finished campaign. "Of the warm-up" is not decoration: «з 7-го дня» alone
 * read as the campaign's own first day, and a campaign launched on day-2
 * accounts looked broken for five days.
 */
export function campaignFeedStart(campaign, defaultFromDay) {
  const fromDay = Number(campaign?.fromDay) || defaultFromDay;
  if (campaign?.state === "done") return null;
  const title = "З якого дня свого прогріву акаунт сам бере людей із папки";
  if (campaign?.state === "running") return { text: `автопідбір з ${fromDay}-го дня прогріву`, title };
  return { text: `автопідбір з ${fromDay}-го дня прогріву, після запуску`, title };
}

/**
 * Whether the campaign on screen fills this account by itself, as a short
 * `{ text, tone, icon }`, or `null` without facts. "Not yet" says from which
 * day; "ahead" names the campaigns above it that fill the account first, since
 * "working" would otherwise be said about a folder that never moves.
 */
export function autoFeedLine(feed, defaultFromDay) {
  if (!feed) return null;
  const fromDay = Number(feed.fromDay) || defaultFromDay;
  if (!feed.running) return { tone: "is-muted", icon: "clock", text: "Кампанія не запущена" };
  if (!feed.ticked) return { tone: "is-muted", icon: "clock", text: "Акаунт не в кампанії" };
  if (feed.blocked) return { tone: "is-muted", icon: "clock", text: `Автопідбір стоїть: ${feed.blocked}` };
  if (!feed.on) return { tone: "is-muted", icon: "clock", text: `Автопідбір з ${fromDay}-го дня (зараз ${feed.day}-й)` };
  const ahead = Array.isArray(feed.ahead) ? feed.ahead : [];
  if (ahead.length) {
    const names = ahead.map((campaign) => `«${campaign.name || "без назви"}»`).join(", ");
    return { tone: "is-muted", icon: "list-ordered", text: `Спершу бере ${ahead.length === 1 ? "кампанія" : "кампанії"} ${names}` };
  }
  return { tone: "is-live", icon: "repeat", text: `Автопідбір: ще ${Number(feed.connectsLeft) || 0} сьогодні` };
}
