/**
 * The messenger reader, tested without a messenger.
 *
 *   node --test agent/inbox-dom.test.mjs
 *
 * There is no way to save a real LinkedIn messaging page here: doing that means
 * opening a warming account's browser outside its window, and an unscheduled
 * session is exactly the signal the whole warm-up is built to avoid. So the
 * reader is tested the only honest way left.
 *
 * Two layers, and the split matters:
 *
 *   1. The **collecting** half runs in a real DOM — a headless Chromium, the
 *      same engine the agent drives, pointed at a `data:` URL built from the
 *      fixtures in `fixtures/`. Real `querySelector`, real `innerText`, real
 *      `closest`. No network, no linkedin.com, no session, no account.
 *   2. The **deciding** half is a pure function over plain objects and is
 *      tested with nothing at all. This is where direction, timestamps and the
 *      message id live, which is to say where the consequences live.
 *
 * Layer 1 needs Chrome installed. When it is not, those tests skip and layer 2
 * still runs — a machine without Chrome can still tell you that "2h" parses and
 * that an outbound message is not about to be filed as a reply.
 *
 * What this cannot prove: that the fixtures look like LinkedIn. See
 * `fixtures/README.md` — the anchors and `time` elements are safe, the class
 * names are a guess, and the arrangement is an assumption.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  harvestConversations, harvestThread,
  parseStamp, conversationRow, pickConversations, buildThread, externalIdFor, trimBody, personNameFrom,
} from './lib/inbox-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

// A fixed "now" so a relative timestamp means the same thing in a year.
// 2026-09-16T10:00:00Z — the morning the fixtures were written for.
const NOW = Date.parse('2026-09-16T10:00:00.000Z');
const SELF_BY_NAME = { slug: null, name: 'Mary Lindsay' };
const SELF_BY_SLUG = { slug: 'mary-lindsay-0a12b3', name: null };

let browser = null;
let page = null;

before(async () => {
  if (!fs.existsSync(CHROME)) return;
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ headless: true, executablePath: CHROME }).catch(() => null);
  page = browser ? await browser.newPage() : null;
});
after(async () => { await browser?.close().catch(() => {}); });

/**
 * Put a fixture in front of a real DOM.
 *
 * `page.setContent` is the obvious way and it hangs here — it waits for `load`,
 * which never fires on an about:blank document in this Chrome. A `data:` URL
 * loads the same markup and settles, with the side effect that relative hrefs
 * stay relative, which is worth having: it is the case the reader has to cope
 * with anyway, since `getAttribute('href')` is what it reads.
 */
async function open(name) {
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(fixture(name))}`,
    { waitUntil: 'domcontentloaded', timeout: 15000 });
}
const needsChrome = () => (page ? false : { skip: 'Chrome не знайдено — шар DOM пропущено' });

// ── layer 1: collecting, in a real DOM ─────────────────────────────────────

describe('the conversation list', () => {
  test('reads every thread and ignores the composer', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-list.html');
    const raw = await page.evaluate(harvestConversations);
    const rows = raw.rows.map((r) => conversationRow(r, NOW));

    assert.equal(rows.length, 5, 'п’ять розмов, без /messaging/thread/new/');
    assert.ok(!rows.some((r) => r.threadKey === 'new'));
    assert.deepEqual(rows.map((r) => r.threadKey), [
      '2-ZjE4ZmQ1NzQtYjE1NC00ZjQ4LThm',
      '2-NTRhYjIxMDAtOGUwNy00',
      '2-R3JvdXBDaGF0MDAx',
      '2-T2xkZXJUaHJlYWQwMDI=',   // percent-encoded in the href, decoded here
      '2-SW5NYWlsUmVjcnVpdGVy',
    ]);
    assert.equal(rows[0].name, 'Marta Kowalczyk');
    assert.match(rows[0].preview, /happy to chat next week/);
  });

  test('a name is not taken from the LinkedIn logo', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-list.html');
    const raw = await page.evaluate(harvestConversations);
    const inmail = raw.rows.map((r) => conversationRow(r, NOW)).find((r) => r.threadKey === '2-SW5NYWlsUmVjcnVpdGVy');
    assert.equal(inmail.name, 'Sarah Whitfield');
  });

  test('ages come out of the labels LinkedIn actually writes', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-list.html');
    const rows = (await page.evaluate(harvestConversations)).rows.map((r) => conversationRow(r, NOW));
    const ages = Object.fromEntries(rows.map((r) => [r.name, Math.round((NOW - r.at) / 3600_000)]));
    assert.equal(ages['Marta Kowalczyk'], 2);                      // "2h"
    assert.equal(ages['Dmytro Herasymenko'], 24);                  // "Yesterday"
    assert.equal(ages['Anna Bauer, Tomás Ruiz'], 72);              // "3d"
    assert.equal(ages['Sarah Whitfield'], 336);                    // "2w"
    assert.ok(rows.every((r) => r.at != null), 'жоден рядок не лишився без дати');
  });

  /**
   * 08.10.2026: the live messenger had no `/messaging/thread/` anchors at all —
   * rows became `li` elements with a click handler, and the sweep read zero
   * conversations off a page carrying twenty-three timestamps. The second way
   * of seeing a row exists for exactly that page.
   */
  test('список без жодного посилання читається за формою рядка', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-list-nolinks.html');
    const raw = await page.evaluate(harvestConversations);
    const rows = raw.rows.map((r) => conversationRow(r, NOW));

    assert.equal(rows.length, 3, 'три рядки: час плюс аватарка');
    assert.deepEqual(rows.map((r) => r.name), ['Marta Kowalczyk', 'Dmytro Herasymenko', 'Hiring Assistant']);
    // Ключа до кліку немає — і це сказано прямо, а не вдається порожнім рядком.
    assert.ok(rows.every((r) => r.threadKey === null));
    assert.deepEqual(rows.map((r) => r.rowMark), [0, 1, 2]);
    assert.match(rows[0].preview, /happy to chat next week/);
    assert.equal(Math.round((NOW - rows[1].at) / 3600_000), 24, '«Yesterday» лишається «Yesterday»');
    // І сторінка не вважається зламаною: у нотатці сказано, що взяли за формою.
    assert.ok(raw.notes.some((note) => /список без посилань/.test(note)), raw.notes.join(' | '));
  });

  test('кожен рядок позначений так, щоб клікнути саме той, який прочитали', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-list-nolinks.html');
    await page.evaluate(harvestConversations);
    const marked = await page.evaluate(() =>
      [...document.querySelectorAll('[data-outbound-row]')].map((node) => ({
        mark: node.getAttribute('data-outbound-row'),
        name: node.querySelector('img[alt]')?.getAttribute('alt') ?? null
      })));
    assert.deepEqual(marked, [
      { mark: '0', name: 'Marta Kowalczyk' },
      { mark: '1', name: 'Dmytro Herasymenko' },
      { mark: '2', name: 'LinkedIn' }
    ]);
    // Друге читання не плодить других позначок на тих самих рядках.
    await page.evaluate(harvestConversations);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-outbound-row]').length), 3);
  });

  test('сторінка з посиланнями читається по-старому: форма рядка не підмінює їх', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-list.html');
    const raw = await page.evaluate(harvestConversations);
    assert.ok(raw.rows.every((r) => r.threadKey), 'ключі з href, як і раніше');
    assert.ok(raw.rows.every((r) => r.rowMark === null));
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-outbound-row]').length), 0);
  });

  test('an empty inbox is empty, and says so differently from a broken one', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-empty.html');
    const raw = await page.evaluate(harvestConversations);
    assert.equal(raw.rows.length, 0);
    assert.ok(raw.chars > 0, 'сторінка намалювалась — просто порожня');
    assert.equal(raw.notes.length, 1, 'нуль розмов завжди з поясненням');
  });

  /**
   * This fixture was written as a prediction: the day the anchors go. It
   * arrived on 08.10.2026, and the answer is no longer "report zero loudly" —
   * it is to read the page by the shape of its rows. The loud zero is kept for
   * the page where even the shape is gone, below.
   */
  test('коли посилання зникли, список читається за формою, а не падає в нуль', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-rotted.html');
    const raw = await page.evaluate(harvestConversations);
    assert.ok(raw.rows.length > 0, 'рядки знайдені за часом і аватаркою');
    assert.ok(raw.rows.every((row) => row.threadKey === null && row.rowMark !== null));
    assert.ok(raw.notes.some((note) => /список без посилань/.test(note)), raw.notes.join(' | '));
    assert.ok(raw.chars > 100);
  });

  test('сторінка, де немає ні посилань, ні форми рядка, лишається голосним нулем', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('messaging-rotted.html');
    // Аватарки — друга половина форми рядка. Без них сторінку вже не прочитати,
    // і тоді нуль мусить бути сказаний так, щоб його знайшли в логу.
    await page.evaluate(() => document.querySelectorAll('img').forEach((img) => img.remove()));
    const raw = await page.evaluate(harvestConversations);
    assert.equal(raw.rows.length, 0);
    assert.match(raw.notes[0], /messaging\/thread/);
    assert.ok(raw.chars > 100, 'сторінка не порожня, отже нуль — це поломка');
  });
});

describe('one conversation', () => {
  test('grouped bubbles keep the sender they were grouped under', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const harvest = await page.evaluate(harvestThread);
    assert.equal(harvest.how, 'class hint');
    const built = buildThread({ threadKey: '2-ZjE4ZmQ1NzQtYjE1NC00ZjQ4LThm', harvest, self: SELF_BY_SLUG, nowMs: NOW });

    assert.equal(built.payload.messages.length, 5);
    assert.deepEqual(built.payload.messages.map((m) => m.direction), ['in', 'in', 'out', 'in', 'in']);
    // The second bubble carries no name, no avatar and no profile link at all.
    assert.match(built.payload.messages[1].body, /slide 4/);
    assert.equal(built.payload.messages[1].direction, 'in');
  });

  test('the sidebar full of other conversations is not read as messages', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const harvest = await page.evaluate(harvestThread);
    const built = buildThread({ threadKey: 'x', harvest, self: SELF_BY_SLUG, nowMs: NOW });
    const bodies = built.payload.messages.map((m) => m.body).join('\n');
    assert.ok(!/compare notes on the Q4 pipeline/.test(bodies), 'рядок зі списку розмов потрапив у повідомлення');
  });

  test('markup that arrived as text stays text', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const built = buildThread({ threadKey: 'x', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW });
    assert.match(built.payload.messages[1].body, /<b>your deck<\/b>/);
  });

  test('emoji and newlines survive', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const built = buildThread({ threadKey: 'x', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW });
    const last = built.payload.messages[3];
    assert.match(last.body, /😊/);
    assert.match(last.body, /\nPing me Monday\?/);
  });

  test('a message with no text is stored as an attachment, not dropped', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const built = buildThread({ threadKey: 'x', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW });
    assert.equal(built.payload.messages.at(-1).body, '[attachment]');
    assert.ok(built.notes.some((n) => /без тексту/.test(n)));
  });

  test('a day separator dates the messages under it and is not one itself', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const built = buildThread({ threadKey: 'x', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW });
    assert.ok(!built.payload.messages.some((m) => /^SEP 12$|^TODAY$/.test(m.body)), 'роздільник дня потрапив у повідомлення');
    // "10:32 AM" under "SEP 12" is the 12th, not today.
    assert.equal(built.payload.messages[0].sentAt, '10:32 AM');
    // A real datetime attribute beats everything else on the page.
    assert.equal(built.payload.messages[3].sentAt, '2026-09-16T08:12:00.000Z');
  });

  test('the participant and their headline come off the top of the page', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const built = buildThread({ threadKey: 'x', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW });
    assert.equal(built.payload.participant.name, 'Marta Kowalczyk');
    assert.equal(built.payload.participant.slug, 'marta-kowalczyk-8a1b2c');
  });

  test('without the msg-* classes it finds the messages structurally', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-ours.html');
    const harvest = await page.evaluate(harvestThread);
    assert.equal(harvest.how, 'structure', 'мало впасти на структурний прохід');
    const built = buildThread({
      threadKey: '2-NTRhYjIxMDAtOGUwNy00', harvest, self: SELF_BY_NAME, nowMs: NOW,
      listRow: { name: 'Dmytro Herasymenko', slug: null, at: NOW - 86_400_000 },
    });
    assert.equal(built.payload.messages.length, 3);
    // Every one of them is ours, identified by our own name alone.
    assert.deepEqual(built.payload.messages.map((m) => m.direction), ['out', 'out', 'out']);
    assert.equal(built.inbound, 0);
    // The bubble whose whole body is "ok" is a message, not a day separator.
    assert.equal(built.payload.messages[1].body, 'ok');
    // Nobody else spoke, so the participant is whoever the page is about.
    assert.equal(built.payload.participant.name, 'Dmytro Herasymenko');
    assert.equal(built.payload.participant.slug, 'dmytro-herasymenko-77c1');
  });

  test('our own messages are not filed as replies when only the name identifies us', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const harvest = await page.evaluate(harvestThread);
    const bySlug = buildThread({ threadKey: 'x', harvest, self: SELF_BY_SLUG, nowMs: NOW });
    const byName = buildThread({ threadKey: 'x', harvest, self: SELF_BY_NAME, nowMs: NOW });
    assert.deepEqual(
      bySlug.payload.messages.map((m) => m.direction),
      byName.payload.messages.map((m) => m.direction),
      'ім’я і слаг мають давати однаковий напрямок',
    );
  });

  test('the same page read twice gives the same message ids', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-reply.html');
    const first = buildThread({ threadKey: 'k', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW });
    await open('thread-reply.html');
    // An hour later, which is what "2h ago" moving to "3h ago" does to a naive
    // id: this is the run where a reply is stored for the second time.
    const second = buildThread({ threadKey: 'k', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW + 3600_000 });
    assert.deepEqual(first.payload.messages.map((m) => m.externalId), second.payload.messages.map((m) => m.externalId));
  });
});

// ── layer 2: deciding, in plain node ───────────────────────────────────────

describe('timestamps', () => {
  test('the five ways LinkedIn writes a moment', () => {
    assert.equal(parseStamp('2026-09-16T08:12:00.000Z', NOW).at, Date.parse('2026-09-16T08:12:00.000Z'));
    assert.equal(parseStamp('2026-09-16T08:12:00.000Z', NOW).precision, 'exact');
    assert.equal(parseStamp('2h', NOW).at, NOW - 2 * 3600_000);
    assert.equal(parseStamp('45m', NOW).at, NOW - 45 * 60_000);
    assert.equal(parseStamp('3d', NOW).at, NOW - 3 * 86_400_000);
    assert.equal(parseStamp('Yesterday', NOW).at, NOW - 86_400_000);
    assert.equal(parseStamp('1758000000000', NOW).precision, 'exact');
    assert.equal(parseStamp('', NOW).at, null);
    assert.equal(parseStamp('Отримано', NOW).precision, 'unknown');
  });

  test('a date with no year means the most recent one, not next year', () => {
    // Read in September, "SEP 12" is four days ago.
    assert.ok(Math.abs(parseStamp('SEP 12', NOW).at - Date.parse('2026-09-12T12:00:00Z')) < 86_400_000);
    // Read in January, "Dec 20" is last December — not eleven months from now,
    // which is the bug that makes a January sync re-read the whole year.
    const january = Date.parse('2027-01-05T10:00:00.000Z');
    assert.ok(parseStamp('Dec 20', january).at < january, 'Dec 20 має бути в минулому');
    assert.ok(january - parseStamp('Dec 20', january).at < 30 * 86_400_000);
  });
});

describe('which conversations a run opens', () => {
  const rows = [
    { threadKey: 'a', at: NOW - 3600_000 },
    { threadKey: 'b', at: NOW - 2 * 3600_000 },
    { threadKey: 'c', at: NOW - 40 * 3600_000 },
    { threadKey: 'd', at: NOW - 80 * 3600_000 },
  ];

  test('stops at the first one older than the last sync', () => {
    const { picked } = pickConversations(rows, { since: NOW - 24 * 3600_000 });
    assert.deepEqual(picked.map((r) => r.threadKey), ['a', 'b']);
  });

  test('never opens more than the cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ threadKey: `t${i}`, at: NOW - i * 1000 }));
    assert.equal(pickConversations(many, { since: null, limit: 20 }).picked.length, 20);
  });

  test('a row with no readable date is opened, not skipped', () => {
    // The two mistakes are not symmetrical: re-reading costs a page view and is
    // thrown away by the portal, skipping loses a reply and nobody finds out.
    const { picked } = pickConversations(
      [{ threadKey: 'a', at: null }, { threadKey: 'b', at: NOW - 100 * 3600_000 }],
      { since: NOW - 24 * 3600_000 },
    );
    assert.deepEqual(picked.map((r) => r.threadKey), ['a']);
  });

  test('with no last sync it takes the whole first page, up to the cap', () => {
    assert.equal(pickConversations(rows, { since: null, limit: 20 }).picked.length, 4);
  });
});

describe('what the portal is told', () => {
  test('a message id is built only from things that do not move', () => {
    const a = externalIdFor({ threadKey: 'k', direction: 'in', body: 'hello', stampToken: '2h' });
    const b = externalIdFor({ threadKey: 'k', direction: 'in', body: 'hello', stampToken: '2h' });
    const c = externalIdFor({ threadKey: 'k', direction: 'in', body: 'hello', stampToken: '3h' });
    assert.equal(a, b);
    assert.equal(a, c, 'relative age changes must not invent a new message');
    assert.match(a, /^[0-9a-f]{40}$/);
  });

  test('a long body arrives whole, because the portal is the one that truncates', () => {
    // The portal cuts at 4 000 and writes its own marker. Cutting here too
    // would take the marker away from the only place that knows the limit.
    assert.equal(trimBody('x'.repeat(9000)).length, 9000);
    // The guard that remains is against the absurd, well above the limit that
    // matters, so the stored result is identical either way.
    assert.equal(trimBody('x'.repeat(50_000)).length, 20_000);
  });

  test('without knowing who we are, it refuses rather than guesses', () => {
    const built = buildThread({
      threadKey: 'k',
      harvest: { items: [{ index: 0, slug: 'someone', linkText: 'Someone', alts: [], paragraphs: ['hi'], text: 'hi' }], header: [] },
      self: { slug: null, name: null },
      nowMs: NOW,
    });
    assert.ok(built.skip, 'має відмовитись, а не вгадати напрямок');
    assert.equal(built.payload, undefined);
  });

  test('a conversation with nothing readable in it produces no messages, not a crash', () => {
    const built = buildThread({ threadKey: 'k', harvest: { items: [], header: [], notes: ['порожньо'] }, self: SELF_BY_NAME, nowMs: NOW });
    assert.deepEqual(built.payload.messages, []);
    assert.equal(built.payload.participant.name, 'Unknown');
    assert.equal(built.payload.participant.slug, null);
  });
});

// ── cards: a picture is not a message, and its description is not a name ───

describe('service cards', () => {
  test('a thread of only pictures reads as no conversation at all', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-cards.html');
    const harvest = await page.evaluate(harvestThread);
    assert.equal(harvest.items.length, 2, 'обидві картки прочитано як елементи списку');
    assert.ok(harvest.items.every((item) => !item.hasMedia), 'аватарка — не вкладення');
    const built = buildThread({ threadKey: 'cards', harvest, self: SELF_BY_NAME, nowMs: NOW });
    assert.ok(built.skip, 'розмова з самих карток має бути пропущена, а не відправлена порталу');
    assert.match(built.skip, /службов/);
    assert.equal(built.payload, undefined);
    assert.equal(built.cards, 2);
  });

  test('a picture in the middle of a conversation is not a message in it', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-cards-mixed.html');
    const built = buildThread({ threadKey: 'mixed', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW });
    const messages = built.payload.messages;
    assert.deepEqual(messages.map((m) => m.direction), ['out', 'in', 'in'], 'наше, їхня відповідь і файл — а не четверте «[no text]»');
    assert.deepEqual(messages.map((m) => m.body), [
      'Hi Sinan — we work with UA teams on installs analytics. Worth a short chat?',
      'Sure, send me what you have.',
      '[attachment]'
    ]);
    assert.ok(!messages.some((m) => m.body === '[no text]'));
    assert.equal(built.cards, 1);
    assert.ok(built.notes.some((n) => /службова картка/.test(n)));
  });

  test('the person is Sinan, not three words of an instruction in front of Sinan', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await open('thread-cards-mixed.html');
    const built = buildThread({ threadKey: 'mixed', harvest: await page.evaluate(harvestThread), self: SELF_BY_SLUG, nowMs: NOW });
    assert.equal(built.payload.participant.name, 'Sinan');
    assert.equal(built.payload.participant.slug, 'sinan-arslan-1');
  });

  test('the list row of such a person is filed under the name, not under the sentence', () => {
    // Only the avatar's description is the name here; the visible line has the full one.
    const row = conversationRow({
      threadKey: 'k', alts: ['Переглянути профіль Sinan'], slugs: ['sinan-arslan-1'],
      lines: ['Sinan Arslan', 'Sure, send me what you have.'], stampText: '2h', stampIso: null, order: 0
    }, NOW);
    assert.equal(row.name, 'Sinan Arslan', 'видимий рядок містить ім’я з аватарки, тож він і виграє');
    const bare = conversationRow({ threadKey: 'k', alts: ['Переглянути профіль Sinan'], slugs: [], lines: [], stampText: '2h', order: 0 }, NOW);
    assert.equal(bare.name, 'Sinan');
  });

  test('the words in front of a name are taken off, and a real name is left alone', () => {
    assert.equal(personNameFrom('Переглянути профіль Sinan'), 'Sinan');
    assert.equal(personNameFrom('  переглянути   профіль   Edgar Lopez '), 'Edgar Lopez');
    assert.equal(personNameFrom('View profile of Anna Lee'), 'Anna Lee');
    assert.equal(personNameFrom('View profile Luke'), 'Luke');
    assert.equal(personNameFrom('View Sinan’s profile'), 'Sinan');
    assert.equal(personNameFrom("View Sinan's profile"), 'Sinan');
    assert.equal(personNameFrom('Viewer Smith'), 'Viewer Smith');
    assert.equal(personNameFrom('Oleh Petrenko'), 'Oleh Petrenko');
    assert.equal(personNameFrom('Переглянути профіль'), '', 'без імені лишається порожньо, а не службові слова');
    assert.equal(personNameFrom(null), '');
  });

  test('a card does not decide who the next grouped bubble belongs to', () => {
    // Their picture, then a bubble of ours with no header of its own. If the
    // picture set the author, our message would be filed as theirs.
    const built = buildThread({
      threadKey: 'k',
      harvest: {
        items: [
          { index: 0, slug: 'mary-lindsay-0a12b3', linkText: 'Mary Lindsay', alts: [], paragraphs: ['Hi Sinan'], text: 'Hi Sinan', stampIso: '2026-09-15T09:00:00.000Z', hasMedia: false },
          { index: 1, slug: 'sinan-arslan-1', linkText: '', alts: ['Переглянути профіль Sinan'], paragraphs: [], text: '', hasMedia: false },
          { index: 2, slug: null, linkText: '', alts: [], paragraphs: ['Following up'], text: 'Following up', stampIso: '2026-09-15T10:00:00.000Z', hasMedia: false }
        ],
        header: []
      },
      self: SELF_BY_SLUG,
      nowMs: NOW,
    });
    assert.deepEqual(built.payload.messages.map((m) => m.direction), ['out', 'out'], 'наше повідомлення після картки лишилось нашим');
    assert.equal(built.inbound, 0);
  });

  test('a real attachment still arrives, and a conversation with one attachment is a conversation', () => {
    const built = buildThread({
      threadKey: 'k',
      harvest: {
        items: [{ index: 0, slug: 'sinan-arslan-1', linkText: 'Sinan Arslan', alts: [], paragraphs: [], text: '', hasMedia: true, stampIso: '2026-09-15T12:07:00.000Z' }],
        header: []
      },
      self: SELF_BY_SLUG,
      nowMs: NOW,
    });
    assert.ok(!built.skip);
    assert.deepEqual(built.payload.messages.map((m) => m.body), ['[attachment]']);
    assert.equal(built.cards, 0);
  });
});
