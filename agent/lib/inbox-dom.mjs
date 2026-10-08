/**
 * Reading LinkedIn's messenger, deliberately split in two.
 *
 * The half that runs inside the page (`harvest*`) only **collects**: hrefs,
 * alt texts, `time` elements and lines of text, exactly as LinkedIn wrote them.
 * The half that runs in node (`conversationRow`, `buildThread`, `parseStamp`)
 * only **decides**: who sent what, when, and what a message's stable id is.
 *
 * The split is the whole reason any of this can be trusted without a session.
 * A live run is not ours to spend — these are real accounts, an unscheduled
 * visit is a signal to LinkedIn, and the session window is four hours a day —
 * so the deciding half is a pure function over plain data and is tested with
 * nothing but node, and the collecting half is run against saved fixtures in a
 * local page that has never heard of linkedin.com. See `inbox-dom.test.mjs`.
 *
 * The collecting functions are handed to `page.evaluate`, which serialises them
 * to source and re-creates them inside the page. Nothing outside the function
 * body survives that trip: no imports, no module constants, no shared helpers.
 * So each one repeats its own two-line helpers. That is not an accident and it
 * is not worth "fixing" — the first refactor that hoists them out is also the
 * first run that reads zero threads.
 *
 * What it reads and what it refuses to read: LinkedIn's class names are hashes
 * (`_5dfaadcf _11c561b9 …`) and rotate, the same lesson `settle()` and the like
 * button already record. So the anchors are the spine — a conversation *is* a
 * link to `/messaging/thread/<id>`, an author *is* a link to `/in/<slug>` — and
 * class names are only ever a hint that is tried first and survived without.
 */
import { createHash } from 'node:crypto';

// ── inside the page ────────────────────────────────────────────────────────

/**
 * The conversation list — by its links where they exist, by its shape where
 * they do not.
 *
 * Runs in the page. Returns raw strings only; `conversationRow()` below turns
 * them into something with a name and a date.
 *
 * A link was the whole spine of this file: a conversation *was* an anchor to
 * `/messaging/thread/<id>`, and the id out of that href was the one thing
 * LinkedIn could not rename without breaking its own router. On 08.10.2026 it
 * renamed it anyway — by removing it. A live messenger now has **no**
 * `/messaging/thread/` anchors at all: rows are `li` elements with a `tabindex`
 * and a click handler, the id is nowhere in the DOM, and the sweep read zero
 * conversations off a page carrying twenty-three timestamps.
 *
 * So there is a second way to see a row, used only when the first finds
 * nothing: an `li` that holds a `time` and an `img[alt]` and no `li` of its
 * own. That is the shape of a conversation card and not much else on the page,
 * and both parts are there for the screen reader rather than the layout. Such a
 * row carries no key — it is marked with `data-outbound-row` so the sweep can
 * click the same element it read, and the thread id is taken from the address
 * bar once the click lands.
 *
 * The anchor path is kept first and unchanged: if the links come back, nothing
 * about this changes with them.
 */
export const ROW_MARK = 'data-outbound-row';

export function harvestConversations() {
  const flat = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const notes = [];

  // Counted whether or not anything is found, because this is what makes a
  // zero readable. A messaging page carrying nine timestamps and no links to
  // conversations is not an empty inbox — it is a list that stopped being
  // links, and somebody has to be told. An inbox that is genuinely empty has
  // no timestamps on it either.
  const times = document.querySelectorAll('time').length;
  const chars = (document.body?.innerText ?? '').length;

  /** The strings one card gives up, however the card was found. */
  const describe = (card, order) => ({
    // The avatar's alt text is the participant's name in every build so far,
    // and it is written for screen readers rather than for layout, which is
    // why it survives redesigns that move every visible element.
    alts: [...card.querySelectorAll('img[alt]')]
      .map((img) => (img.getAttribute('alt') || '').trim())
      .filter(Boolean),
    slugs: [...card.querySelectorAll('a[href*="/in/"]')]
      .map((el) => ((el.getAttribute('href') || el.href || '').match(/\/in\/([^/?#]+)/) || [])[1])
      .filter(Boolean),
    // innerText keeps the card's line breaks, which is what separates the
    // name from the snippet. A card rendered as one line falls back to the
    // middot LinkedIn uses to join them.
    lines: ((card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean).length > 1
      ? (card.innerText || '').split('\n')
      : flat(card).split('·')
    ).map((s) => s.trim()).filter(Boolean).slice(0, 8),
    stampIso: card.querySelector('time')?.getAttribute('datetime') ?? null,
    stampText: flat(card.querySelector('time')) || null,
    order,
  });

  const anchors = [...document.querySelectorAll('a[href*="/messaging/thread/"]')];
  if (!anchors.length) {
    document.querySelectorAll(`[${'data-outbound-row'}]`).forEach((node) => node.removeAttribute('data-outbound-row'));
    const cards = [...document.querySelectorAll('li')].filter((li) =>
      li.querySelector('time') && li.querySelector('img[alt]') && !li.querySelector('li')
      && (li.offsetWidth || li.offsetHeight || li.getClientRects().length));
    if (!cards.length) {
      notes.push(`жодного посилання на /messaging/thread/ (${location.pathname}, ${chars} символів тексту, ${times} міток часу)`);
      return { rows: [], notes, chars, times, url: location.href };
    }
    notes.push(`список без посилань: беру ${cards.length} рядків за часом і аватаркою (${location.pathname})`);
    const rows = cards.map((card, index) => {
      card.setAttribute('data-outbound-row', String(index));
      // No key until the click lands: the id lives only in the address bar.
      return { threadKey: null, rowMark: index, href: null, ...describe(card, index) };
    });
    return { rows, notes, chars, times, url: location.href };
  }

  /**
   * The card this link belongs to: climb while the subtree still holds exactly
   * one thread link, and stop at the list item. One more level and the "card"
   * is the whole list, which is how a reader starts attributing the second
   * person's name to the first person's conversation.
   */
  const cardOf = (a) => {
    let node = a;
    let best = a;
    for (let i = 0; i < 6 && node; i += 1) {
      if (node.querySelectorAll('a[href*="/messaging/thread/"]').length > 1) break;
      best = node;
      if (node.tagName === 'LI') break;
      node = node.parentElement;
    }
    return best;
  };

  const rows = [];
  const seen = new Set();
  for (const a of anchors) {
    // getAttribute, not .href: in a page loaded from a data: URL (which is how
    // the fixtures are tested) .href does not resolve to an absolute URL, and
    // the regex below has to match both shapes anyway.
    const href = a.getAttribute('href') || a.href || '';
    const raw = (href.match(/\/messaging\/thread\/([^/?#]+)/) || [])[1];
    if (!raw) continue;
    let threadKey = raw;
    try { threadKey = decodeURIComponent(raw); } catch { /* a key we cannot decode is still a key */ }
    // `/messaging/thread/new/` is the composer, not a conversation.
    if (/^(new|compose)$/i.test(threadKey)) continue;
    if (seen.has(threadKey)) continue;
    seen.add(threadKey);

    const card = cardOf(a);
    rows.push({ threadKey, href, rowMark: null, ...describe(card, rows.length) });
  }

  if (!rows.length) notes.push(`знайшов ${anchors.length} посилань, але жодного ключа розмови в них`);
  return { rows, notes, chars, times, url: location.href };
}

/**
 * One conversation's messages, as they sit in the page.
 *
 * Runs in the page. Two things here are worth knowing before changing it.
 *
 * First, LinkedIn groups consecutive messages from one sender under a single
 * header: the second and third bubbles carry no name, no avatar and no profile
 * link at all. A reader that demands an author per item silently drops most of
 * a conversation. So the author is reported as `null` where it is missing and
 * carried forward in `buildThread()`, where it can be tested.
 *
 * Second, the messenger renders the conversation *list* on the same page. Both
 * are lists of items with timestamps, and the list is usually the longer one,
 * so any "find the biggest list" heuristic finds the wrong one. The guard is
 * structural: a message list contains no links to other conversations.
 */
export function harvestThread() {
  const flat = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const notes = [];

  // Tried in order. The class hints are LinkedIn's own semantic names, which
  // have outlived several redesigns of the feed; the substring match means a
  // rename to `msg-s-message-list__event--v2` still lands. When they go, the
  // structural pass below still works, and `how` says which one answered — a
  // run that quietly changes strategy is a run that has started to rot.
  let how = 'class hint';
  let items = [...document.querySelectorAll(
    'li[class*="message-list__event"], li[class*="event-listitem"], li[class*="msg-s-message-list"]',
  )];

  if (!items.length) {
    how = 'structure';
    let best = [];
    for (const list of document.querySelectorAll('ul, ol')) {
      // The conversation list. Not this one.
      if (list.querySelector('a[href*="/messaging/thread/"]')) continue;
      const kids = [...list.children].filter((li) => li.querySelector('p, time') || flat(li).length > 20);
      if (kids.length > best.length) best = kids;
    }
    items = best;
  }

  if (!items.length) {
    notes.push(`жодного повідомлення на ${location.pathname} (${(document.body?.innerText ?? '').length} символів тексту)`);
    return { items: [], header: [], how, notes, url: location.href, chars: (document.body?.innerText ?? '').length };
  }

  const out = items.map((li, index) => {
    const link = li.querySelector('a[href*="/in/"]');
    const timeEl = li.querySelector('time');
    const paragraphs = [...li.querySelectorAll('p')].map((p) => (p.innerText || p.textContent || '').trim()).filter(Boolean);
    return {
      index,
      externalId: [li, ...li.querySelectorAll('[data-event-urn], [data-message-urn], [data-entity-urn], [data-urn], [data-id]')]
        .flatMap((node) => ['data-event-urn', 'data-message-urn', 'data-entity-urn', 'data-urn', 'data-id'].map((key) => node.getAttribute(key)))
        .find((value) => value && /^urn:li:.*(?:message|msg)/i.test(value)) ?? null,
      slug: link ? ((link.getAttribute('href') || link.href || '').match(/\/in\/([^/?#]+)/) || [])[1] ?? null : null,
      // The author's name lives in three places depending on the build: the
      // profile link's text, the avatar's alt, or a bare heading. All three are
      // reported and `buildThread()` picks; none of them is load-bearing alone.
      linkText: link ? flat(link) : null,
      alts: [...li.querySelectorAll('img[alt]')].map((img) => (img.getAttribute('alt') || '').trim()).filter(Boolean),
      stampIso: timeEl?.getAttribute('datetime') ?? null,
      stampText: flat(timeEl) || null,
      paragraphs,
      // The fallback body, for a build where the bubble is not a <p>. Kept
      // separately so the node side can prefer the paragraphs and still have
      // something when there are none.
      text: (li.innerText || flat(li) || '').trim(),
      hasMedia: Boolean(li.querySelector('img[src], video, a[href*="/dms/"], [class*="attachment"]')),
    };
  });

  return {
    items: out,
    // The top of the thread: the participant's name and headline are here in
    // every build, and it is the only place they are when the conversation is
    // one long run of messages from us.
    header: [...document.querySelectorAll('a[href*="/in/"]')].slice(0, 6).map((el) => ({
      slug: ((el.getAttribute('href') || el.href || '').match(/\/in\/([^/?#]+)/) || [])[1] ?? null,
      text: flat(el),
    })),
    headerLines: (document.querySelector('header, [class*="msg-entity-lockup"], [class*="thread"]')?.innerText ?? '')
      .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6),
    how,
    notes,
    url: location.href,
    chars: (document.body?.innerText ?? '').length,
  };
}

// ── in node, where it can be tested ────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
  mo: 30 * DAY, mos: 30 * DAY, month: 30 * DAY, months: 30 * DAY,
  y: 365 * DAY, yr: 365 * DAY, yrs: 365 * DAY, year: 365 * DAY, years: 365 * DAY,
};

/**
 * What a LinkedIn timestamp means, in milliseconds.
 *
 * The messenger writes the same moment five different ways depending on where
 * it is on screen: `datetime="2026-09-16T08:12:00Z"` on a `time` element in the
 * thread, a bare `2h` in the conversation list, `Yesterday` and `10:32 AM` on
 * the day separators, `Sep 12` once it is older than a week, and a raw epoch in
 * some builds. Only the first is unambiguous.
 *
 * `precision` is the honest part: `exact` came from a machine-readable
 * attribute, `about` was computed from a relative label, `day` knows the date
 * and not the hour, `unknown` is a guess the caller should not store as fact.
 */
export function parseStamp(raw, nowMs = Date.now()) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { at: null, precision: 'unknown' };

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) return { at, precision: 'exact' };
  }
  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text);
    return { at: n < 1e12 ? n * 1000 : n, precision: 'exact' };
  }
  if (/^(now|just now|зараз)$/i.test(text)) return { at: nowMs, precision: 'about' };
  if (/^(today|сьогодні)$/i.test(text)) return { at: nowMs, precision: 'day' };
  if (/^(yesterday|вчора)$/i.test(text)) return { at: nowMs - DAY, precision: 'day' };

  const rel = text.match(/^(\d+)\s*([a-z]+)\s*(ago)?$/i);
  if (rel && UNITS[rel[2].toLowerCase()]) {
    return { at: nowMs - Number(rel[1]) * UNITS[rel[2].toLowerCase()], precision: 'about' };
  }

  // `Sep 12` / `12 Sep` / `Sep 12, 2025`. Without a year LinkedIn means the
  // most recent one, so a date that lands in the future belongs to last year —
  // which is the whole bug that makes a December sync re-read January.
  const named = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/);
  if (named) {
    const year = named[3] ? Number(named[3]) : new Date(nowMs).getUTCFullYear();
    const at = Date.parse(`${named[1]} ${named[2]}, ${year} 12:00:00 GMT`);
    if (Number.isFinite(at)) {
      return { at: at > nowMs + DAY && !named[3] ? at - 365 * DAY : at, precision: 'day' };
    }
  }
  const dayFirst = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:,?\s*(\d{4}))?$/);
  if (dayFirst) {
    const year = dayFirst[3] ? Number(dayFirst[3]) : new Date(nowMs).getUTCFullYear();
    const at = Date.parse(`${dayFirst[2]} ${dayFirst[1]}, ${year} 12:00:00 GMT`);
    if (Number.isFinite(at)) {
      return { at: at > nowMs + DAY && !dayFirst[3] ? at - 365 * DAY : at, precision: 'day' };
    }
  }

  // `10:32 AM` — a time with no date. On its own that is only useful next to a
  // day separator, which `buildThread()` supplies; here it means "today".
  const clock = text.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (clock) {
    const base = new Date(nowMs);
    let hour = Number(clock[1]) % 12;
    if (/pm/i.test(clock[3] ?? '')) hour += 12;
    if (!clock[3]) hour = Number(clock[1]);
    base.setHours(hour, Number(clock[2]), 0, 0);
    return { at: base.getTime(), precision: 'about' };
  }

  return { at: null, precision: 'unknown' };
}

/**
 * A conversation list row, read into something with a name and an age.
 *
 * Two places claim to hold the name and they disagree on group threads: the
 * avatar's alt text is one person, the visible row says "Anna Bauer, Tomás
 * Ruiz". The alt is the safer source in general — it is written for screen
 * readers rather than for layout — but when the visible line *contains* it,
 * the visible line is the same answer more completely, so it wins. That keeps
 * a group conversation from being filed under whoever's avatar loaded first,
 * which downstream is an outreach row moved to `connected` for one member of a
 * group chat that was never about them.
 */
export function conversationRow(raw, nowMs = Date.now()) {
  const alt = (raw.alts ?? []).find((a) => a && a.length > 1 && !/^linkedin$|logo|banner|background|icon/i.test(a)) ?? null;
  // A line that ends with the row's own timestamp is a name and a time
  // rendered as one line — which is how the list looks when LinkedIn puts the
  // `time` inside the same row element as the name. The stamp is read from the
  // `time` element itself, so here it is only in the way: without this the
  // conversation is filed under «Marta Kowalczyk 2h».
  const withoutStamp = (line) => {
    const stamp = String(raw.stampText ?? '').trim();
    if (!stamp) return line;
    const trimmed = line.endsWith(stamp) ? line.slice(0, -stamp.length) : line;
    return trimmed.replace(/[\s·,-]+$/, '').trim();
  };
  const visible = (raw.lines ?? [])
    .map(withoutStamp)
    .find((line) => line.length > 1 && line !== raw.stampText) ?? null;
  const name = (alt && visible && visible.toLowerCase().includes(alt.toLowerCase())) ? visible : (alt ?? visible);
  const lines = (raw.lines ?? []).filter((line) => line !== name && line !== raw.stampText);
  const stamp = parseStamp(raw.stampIso ?? raw.stampText, nowMs);
  return {
    threadKey: raw.threadKey,
    href: raw.href ?? null,
    rowMark: raw.rowMark ?? null,
    name,
    slug: (raw.slugs ?? [])[0] ?? null,
    preview: lines.length ? lines[lines.length - 1].slice(0, 200) : null,
    stampText: raw.stampText ?? null,
    at: stamp.at,
    precision: stamp.precision,
    order: raw.order ?? 0,
  };
}

/**
 * Which conversations this run should open.
 *
 * Two rules from the contract and one from experience. The contract's: at most
 * `limit` a run, and stop at the first row older than the last sync, because
 * the list is newest-first and reading the whole history every morning is both
 * slow and a pattern in itself.
 *
 * Experience's: a row whose age we could not work out counts as new. The two
 * mistakes are not symmetrical — re-reading a conversation costs one page view
 * and is then thrown away by the portal's duplicate suppression, while skipping
 * one loses a reply silently, which is the failure nobody notices for a week.
 */
export function pickConversations(rows, { since = null, limit = 20 } = {}) {
  const picked = [];
  const skipped = [];
  for (const row of rows) {
    if (picked.length >= limit) { skipped.push({ threadKey: row.threadKey, why: 'ліміт' }); continue; }
    if (since && row.at != null && row.at < since) {
      // Newest-first, so everything below this is older too.
      skipped.push({ threadKey: row.threadKey, why: 'старіше за останню синхронізацію' });
      break;
    }
    picked.push(row);
  }
  return { picked, skipped };
}

/**
 * The body, as LinkedIn gave it.
 *
 * Deliberately *not* trimmed to the portal's 4 000 characters: the portal
 * truncates, and it marks the cut in its own words, so a body cut here would
 * only take the marker away from the one place that knows the limit. Emoji,
 * newlines and text that arrived looking like markup all pass through
 * untouched — the portal's screens escape on the way out, and a reader who
 * sanitises is a reader that quietly edits a stranger's words.
 *
 * The cap that is left is a guard against the absurd — a pasted contract, a
 * log file — where the only question is whether it travels over the wire, not
 * what gets stored. It sits far above the portal's limit so that in every case
 * the portal is the thing doing the truncating.
 */
export function trimBody(body, max = 20_000) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * A message's id, and why it is built the way it is.
 *
 * LinkedIn does not put a message id anywhere in the DOM, so the contract
 * allows a hash of time and body. The trap is the word "time": if the hash
 * includes a timestamp the agent *computed* — "2h ago" resolved against the
 * clock — then the same message hashes differently on every run, the portal's
 * duplicate suppression never matches, and one reply is stored twenty times
 * over a fortnight. So the hash takes the raw stamp *as LinkedIn wrote it*, and
 * takes nothing at all when there is no stamp, rather than taking a guess.
 */
export function externalIdFor({ threadKey, direction, body, stampToken, occurrence = 0 }) {
  // ISO datetimes are stable. Relative or human-formatted labels are not.
  const absolute = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(stampToken ?? '')) ? stampToken : '';
  const parts = [threadKey, direction, String(absolute), String(body ?? ''), String(occurrence)];
  return createHash('sha1').update(parts.join('\0')).digest('hex');
}

/**
 * One conversation, turned into the payload the portal takes.
 *
 * `self` is who we are — `{ slug, name }` as `run-account.mjs` read them off
 * the feed. It is required, and the sync refuses to run without at least one of
 * the two, because direction is the one field here that is worse wrong than
 * missing: an outbound message filed as inbound tells the portal a stranger
 * replied, which moves an outreach row to `connected` and writes an activity
 * into the CRM that the sales team will read as a lead answering.
 */
export function buildThread({ threadKey, harvest, self, listRow = null, nowMs = Date.now(), maxMessages = Infinity }) {
  const notes = [...(harvest.notes ?? [])];
  if (!self?.slug && !self?.name) {
    return { skip: 'не знаю, хто ми — напрямок повідомлень визначити нічим', notes };
  }

  const selfSlug = self.slug ? String(self.slug).toLowerCase() : null;
  const selfName = self.name ? String(self.name).toLowerCase().replace(/\s+/g, ' ').trim() : null;

  const isSelf = (item) => {
    if (selfSlug && item.slug && String(item.slug).toLowerCase() === selfSlug) return true;
    const names = [item.linkText, ...(item.alts ?? [])].filter(Boolean).map((n) => n.toLowerCase().replace(/\s+/g, ' ').trim());
    if (selfName && names.some((n) => n === selfName)) return true;
    // Some builds label our own group header "You" rather than with our name.
    return names.some((n) => /^(you|ви|ти)$/.test(n));
  };

  const messages = [];
  const occurrences = new Map();
  const participants = new Map();
  let author = null;          // carried forward across a grouped run of bubbles
  let heading = null;         // the day separator the following messages belong to
  let lastAt = null;

  for (const item of harvest.items ?? []) {
    const bodyRaw = item.paragraphs?.length ? item.paragraphs.join('\n') : (item.text ?? '');
    const body = trimBody(bodyRaw);
    const stampToken = item.stampIso ?? item.stampText ?? null;

    // A day separator: a date and nothing else. It is not a message, but it is
    // the only thing that tells `10:32 AM` which day it is. "Nothing else" is
    // the test, rather than "short text" — a message whose whole body is "ok"
    // is short too, and filing it as a separator loses it.
    const asHeading = !item.slug
      && !item.paragraphs?.length
      && Boolean(item.stampText)
      && body.replace(item.stampText, '').replace(/\s+/g, ' ').trim().length === 0;
    if (asHeading) {
      const parsed = parseStamp(item.stampText, nowMs);
      if (parsed.at != null) heading = parsed.at;
      continue;
    }

    if (item.slug || item.linkText || item.alts?.length) {
      author = {
        slug: item.slug ?? null,
        name: (item.linkText || item.alts?.[0] || '').trim() || null,
        self: isSelf(item),
      };
    }
    if (!author) {
      // A message before any author has been seen. LinkedIn only does this when
      // the reader scrolled into the middle of a thread; attributing it by
      // guess is exactly the mistake this file refuses to make.
      notes.push(`повідомлення #${item.index} без автора — пропускаю`);
      continue;
    }

    if (!author.self && (author.slug || author.name)) {
      const key = author.slug ?? author.name;
      const held = participants.get(key) ?? { slug: author.slug ?? null, name: author.name ?? null, count: 0 };
      held.count += 1;
      held.slug = held.slug ?? author.slug ?? null;
      held.name = held.name ?? author.name ?? null;
      participants.set(key, held);
    }

    if (!body) {
      // An attachment, a sticker, a voice note. Storing nothing would make the
      // thread look emptier than it is on a day when the only inbound thing
      // that happened was a file.
      notes.push(`повідомлення #${item.index} без тексту${item.hasMedia ? ' (вкладення)' : ''}`);
    }

    const stamp = parseStamp(item.stampIso ?? item.stampText, nowMs);
    let at = stamp.at;
    if (at != null && stamp.precision === 'about' && heading != null && !item.stampIso) {
      // `10:32 AM` under a `Sep 12` heading: keep the hour, move it to the day.
      const clock = new Date(at);
      const day = new Date(heading);
      day.setHours(clock.getHours(), clock.getMinutes(), 0, 0);
      at = day.getTime();
    }
    // Nothing on the bubble itself: the day separator above it, or the message
    // before it, are both readings of the page rather than guesses about it.
    if (at == null) at = heading ?? lastAt ?? listRow?.at ?? null;
    // Messages read top to bottom are oldest to newest. A stamp that goes
    // backwards is a parse that went wrong, not a conversation that did.
    if (at != null && lastAt != null && at < lastAt) at = lastAt;
    if (at != null) lastAt = at;

    const direction = author.self ? 'out' : 'in';
    const occurrenceKey = `${direction}\0${body}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const message = {
      // Built from the stamp LinkedIn *wrote*, never from the one we worked
      // out — see `externalIdFor`. `at` moves every run; `stampToken` does not.
      externalId: item.externalId || externalIdFor({ threadKey, direction, body: body || '[no text]', stampToken: item.stampIso, occurrence }),
      direction,
      body: body || (item.hasMedia ? '[attachment]' : '[no text]'),
    };
    // And when there is no time to be had anywhere: send the label as written
    // rather than a manufactured timestamp. The portal stores its own
    // received-at and keeps the raw string beside it, which is recoverable
    // later; an invented ISO date looks like a reading and is not one.
    if (item.stampIso && /^\d{4}-\d{2}-\d{2}T/.test(item.stampIso) && Number.isFinite(Date.parse(item.stampIso))) {
      message.sentAt = new Date(item.stampIso).toISOString();
    } else if (stampToken) message.sentAt = String(stampToken);
    else notes.push(`повідомлення #${item.index} без жодної мітки часу`);
    messages.push(message);
  }

  // The participant is whoever is not us and said the most. A group chat has
  // several; the portal's shape holds one, so the loudest is the honest choice
  // and the rest are in the bodies.
  const ranked = [...participants.values()].sort((a, b) => b.count - a.count);
  // A thread we did all the talking in has no ranked participant at all, so the
  // top of the page is the only place their name is. It has to skip *us* by
  // both slug and name: when the account's own slug is unknown — which is the
  // normal state — a slug-only filter hands back our own profile link.
  const fromHeader = (harvest.header ?? []).find((h) => {
    if (!h.slug) return false;
    if (selfSlug && h.slug.toLowerCase() === selfSlug) return false;
    if (selfName && String(h.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim() === selfName) return false;
    return true;
  });
  const participant = {
    name: ranked[0]?.name ?? listRow?.name ?? fromHeader?.text ?? 'Unknown',
    slug: ranked[0]?.slug ?? fromHeader?.slug ?? listRow?.slug ?? null,
    headline: headlineFrom(harvest, ranked[0]?.name ?? listRow?.name ?? null),
  };

  const capped = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
  if (capped.length < messages.length) {
    notes.push(`довга розмова: лишив останні ${maxMessages} з ${messages.length}`);
  }

  return {
    payload: { threadKey, participant, messages: capped },
    inbound: capped.filter((m) => m.direction === 'in').length,
    how: harvest.how ?? null,
    notes,
  };
}

/**
 * The headline, if the page happens to say it.
 *
 * Always optional — the contract takes null — so this never tries hard. The
 * line after the participant's name at the top of the thread is the headline in
 * every build so far, and a wrong guess here is worth less than a crash.
 */
function headlineFrom(harvest, name) {
  const lines = (harvest.headerLines ?? []).map((l) => l.trim()).filter(Boolean);
  if (!name) return null;
  const i = lines.findIndex((l) => l.toLowerCase() === String(name).toLowerCase());
  if (i < 0 || i + 1 >= lines.length) return null;
  const next = lines[i + 1];
  if (!next || next.length > 220 || /^\d/.test(next)) return null;
  return next;
}
