/**
 * All of this account's LinkedIn connections, read from LinkedIn's own
 * «Контакти» page (14.10.2026, owner: «побачити весь список друзів»).
 *
 * What the page looked like on a read-only look at Chloe's (423 contacts) and
 * Profile 48's on 14.10.2026, Ukrainian UI:
 * - the list scrolls inside `main#workspace`, not the window, and loads ten
 *   more cards each time it is scrolled to the bottom — no «Show more» button;
 * - each card is a `div[componentkey="ConnectionCard_<n>-<slug>"]` whose text is
 *   «Name | Headline | Встановлено контакт October 14, 2026 | Повідомлення»;
 * - the total is in the page text: «423 контакти».
 *
 * Read only: nothing is clicked. A card that cannot be read is skipped, never
 * guessed at.
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const CONNECTED = /^(встановлено контакт|connected on|контакт установлен|підключено)\s*/i;
const NOISE = /^(повідомлення|message|сообщение|написати|more|більше)$/i;

/** «October 14, 2026» or «14 жовт. 2026 р.» → 2026-10-14 when the date is readable; null otherwise. */
export function connectedDate(line) {
  const rest = String(line || '').replace(CONNECTED, '').trim();
  const english = Date.parse(`${rest} 12:00 UTC`);
  if (Number.isFinite(english)) return new Date(english).toISOString().slice(0, 10);
  const months = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
  const match = rest.toLowerCase().match(/(\d{1,2})\s+([а-яіїєґ]+)\.?\s+(\d{4})/);
  const month = match ? months.findIndex((prefix) => match[2].startsWith(prefix)) : -1;
  if (month < 0) return null;
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

/** One card's raw read → a person, or null. */
export function parseCard({ href, lines }) {
  const slug = String(href || '').match(/\/in\/([^/?#]+)/)?.[1];
  if (!slug) return null;
  const clean = (lines || []).map((line) => String(line).trim()).filter((line) => line && !NOISE.test(line));
  const dateLine = clean.find((line) => CONNECTED.test(line));
  const rest = clean.filter((line) => line !== dateLine);
  const name = rest[0] || '';
  if (!name) return null;
  return { slug, name, headline: rest[1] || '', connectedAt: dateLine ? connectedDate(dateLine) : null };
}

async function readCards(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('[componentkey^="ConnectionCard_"]')];
    return cards.map((card) => {
      const link = [...card.querySelectorAll('a[href*="/in/"]')].find((a) => a.innerText.trim()) || card.querySelector('a[href*="/in/"]');
      return { href: link?.getAttribute('href') || '', lines: card.innerText.split('\n') };
    });
  });
}

async function readTotal(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const match = main.innerText.match(/([\d\s ,.]+)\s*(контакт|connection|контакт)/i);
    const number = match ? Number(match[1].replace(/[^\d]/g, '')) : NaN;
    return Number.isFinite(number) && number > 0 ? number : null;
  });
}

async function scrollDown(page) {
  await page.evaluate(() => {
    const box = document.querySelector('main#workspace') || document.querySelector('main');
    if (box) box.scrollTop = box.scrollHeight;
    window.scrollTo(0, document.scrollingElement.scrollHeight);
  });
}

/**
 * Scroll the list to its end (or to `max`), reading as it grows. Stops when
 * nothing new arrived for `stallRounds` scrolls in a row — LinkedIn
 * sometimes takes two of them to load the next ten.
 */
export async function readConnections(page, { guard = async () => {}, log = () => {}, sleep = wait, max = 3000, stallRounds = 4, pauseMs = 2500 } = {}) {
  await page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5000);
  await guard();
  const total = await readTotal(page).catch(() => null);
  const people = new Map();
  let stalled = 0;
  let rounds = 0;
  while (people.size < max && stalled < stallRounds) {
    const before = people.size;
    for (const raw of await readCards(page)) {
      const person = parseCard(raw);
      if (person && !people.has(person.slug)) people.set(person.slug, person);
    }
    if (total && people.size >= total) break;
    stalled = people.size > before ? 0 : stalled + 1;
    rounds += 1;
    if (rounds % 10 === 0) { log(`  контакти: ${people.size}${total ? ` з ${total}` : ''}`); await guard(); }
    await scrollDown(page);
    await sleep(pauseMs);
  }
  const list = [...people.values()].slice(0, max);
  // Complete when the page's own count was reached, or — without a count —
  // when the list stopped growing before the cap.
  const complete = total ? list.length >= total : list.length < max;
  return { people: list, total, complete };
}

/** Read and hand to the portal in parts; the portal keeps the last full read. */
export async function syncNetwork(page, { portal, guard, log = () => {}, sleep, max, batchSize = 200 } = {}) {
  const read = await readConnections(page, { guard, log, sleep, max });
  for (let start = 0; start < read.people.length || start === 0; start += batchSize) {
    const answer = await portal.networkBatch(read.people.slice(start, start + batchSize), start === 0);
    if (!answer.success) throw new Error(answer.error || 'network.batch refused');
    if (!read.people.length) break;
  }
  const done = await portal.networkDone({ total: read.total, complete: read.complete });
  if (!done.success) throw new Error(done.error || 'network.done refused');
  log(`  контакти: прочитано ${read.people.length}${read.total ? ` з ${read.total}` : ''}${read.complete ? '' : ' (не до кінця)'}`);
  return { read: read.people.length, total: read.total, complete: read.complete };
}
