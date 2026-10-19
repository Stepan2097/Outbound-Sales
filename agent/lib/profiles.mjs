/**
 * Who somebody who wrote in really is (власник 19.10: «іноді показує тільки
 * імя людини без прізвища… ти додаєш не робочі посилання на лінкедин акаунт
 * людини і через це ти робиш дублі»).
 *
 * The messenger names a person by their first name and links to them by
 * LinkedIn's member id (`/in/ACoAA…`), not by the profile address the CRM
 * holds — so a contact made from a conversation had a first name, a link that
 * matched nobody, and was a second copy of somebody already there. The portal
 * hands over those contacts with their conversation; here each conversation is
 * opened, the person's own link is taken from it (the reader the inbox sweep
 * uses), and their profile is opened by it. LinkedIn answers at the profile's
 * real address and under their full name, and that is what goes back.
 */
import { buildThread } from './inbox-dom.mjs';
import { settleThread } from './inbox.mjs';

const ORIGIN = 'https://www.linkedin.com';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (low, high) => low + Math.floor(Math.random() * (high - low + 1));

/** The vanity slug in a profile address; null for a member id or anything else. */
export function vanitySlug(url) {
  const raw = (String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i) || [])[1];
  if (!raw) return null;
  let slug = raw;
  try { slug = decodeURIComponent(raw); } catch { /* as written */ }
  return /^ac[ow]aa/i.test(slug) ? null : slug;
}

/**
 * `items` — `{ contactId, accountId, threadKey }` from the plan. Each answer
 * goes to the portal at once: a visit that ends halfway has still fixed the
 * people it got to. `refresh` hands back the tab to use (a fresh one when this
 * one has grown, lib/tab.mjs).
 */
/**
 * The conversation's own scrolling box (the messages, right of the list),
 * scrolled to its top a few times: LinkedIn paints the last few bubbles, and
 * the one carrying the person's name and link is often further up (19.10:
 * Lewis Spice's thread showed only his last, unsigned message).
 */
async function scrollThreadUp(page, sleep, pace) {
  for (let step = 0; step < 4; step += 1) {
    const moved = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('*')].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)
        && el.scrollHeight > el.clientHeight + 40 && el.querySelectorAll('li').length >= 1);
      // The rightmost such box is the conversation; the leftmost is the list of conversations.
      const box = boxes.sort((left, right) => right.getBoundingClientRect().x - left.getBoundingClientRect().x)[0];
      if (!box || box.scrollTop === 0) return false;
      box.scrollTop = 0;
      return true;
    }).catch(() => false);
    if (!moved) break;
    await sleep(Math.max(300, 1500 * pace));
  }
}

/**
 * The name at the top of the conversation, clicked: it leads to the person's
 * profile. For a conversation only we wrote in, nothing below it carries their
 * link (19.10: P.J. Gunsagar). The title is the topmost short, bold line above
 * the composer, in the conversation's column.
 */
async function profileFromTitle(page, sleep, pace) {
  const title = await page.evaluate(() => {
    const composer = document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!composer) return null;
    const column = composer.getBoundingClientRect();
    const candidates = [...document.querySelectorAll('h1, h2, h3, a, span, div, p')].filter((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || '').trim();
      return text && text.length <= 80 && !text.includes('\n') && el.children.length <= 2
        && rect.left >= column.left - 20 && rect.right <= column.right + 40 && rect.bottom < column.top - 250 && rect.top > 120
        && Number(getComputedStyle(el).fontWeight) >= 600;
    }).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
    const el = candidates[0];
    if (!el) return null;
    const clickable = el.closest('a, button, [role="link"], [tabindex]') || el;
    clickable.setAttribute('data-outbound-title', '1');
    return { text: el.innerText.trim(), tag: clickable.tagName.toLowerCase(), href: clickable.getAttribute('href') || null };
  }).catch(() => null);
  if (!title) return { failed: 'no_title' };
  const before = page.url();
  await page.click('[data-outbound-title]', { timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 10; i += 1) {
    await sleep(Math.max(200, 800 * pace));
    const url = page.url();
    const slug = (url.match(/linkedin\.com\/in\/([^/?#]+)/i) || [])[1];
    if (slug && url !== before) return { member: decodeURIComponent(slug), via: 'title' };
    // A card instead of a page: the profile link is in it.
    const inCard = await page.evaluate(() => {
      const link = [...document.querySelectorAll('[role="dialog"] a[href*="/in/"], [class*="profile-card"] a[href*="/in/"], [class*="hovercard"] a[href*="/in/"]')][0];
      return link ? (link.getAttribute('href').match(/\/in\/([^/?#]+)/) || [])[1] : null;
    }).catch(() => null);
    if (inCard) return { member: decodeURIComponent(inCard), via: 'card' };
  }
  return { failed: `title_click_nowhere (${title.tag}${title.href ? ` ${title.href.slice(0, 60)}` : ''}: ${title.text.slice(0, 40)})` };
}

/** The member link of the person in an open conversation — the inbox sweep's own reader, then the two fallbacks. */
async function participantOf(page, threadKey, self, pace, sleep = wait) {
  const settled = await settleThread(page, { threadKey }, { pace });
  if (!settled.ok) return { failed: 'thread_not_painted' };
  const read = (harvest) => buildThread({ threadKey, harvest, self })?.payload?.participant?.slug ?? null;
  let member = read(settled.harvest);
  if (member) return { member };
  await scrollThreadUp(page, sleep, pace);
  const again = await settleThread(page, { threadKey }, { pace, timeoutMs: 6000 });
  member = again.ok ? read(again.harvest) : null;
  if (member) return { member, via: 'scroll' };
  return profileFromTitle(page, sleep, pace);
}

export async function resolveProfiles(page, items, {
  portal, guard = async () => {}, self, log = () => {}, refresh = async (current) => current, sleep = wait, pace = 1,
  participant = participantOf, shot = async () => {}
}) {
  const done = { resolved: 0, failed: 0 };
  let shots = 0;
  for (const item of items ?? []) {
    page = await refresh(page);
    await guard();
    let answer = { contactId: item.contactId, threadKey: item.threadKey };
    try {
      // A member id in its own case opens the profile directly; only a lowercased one needs the thread.
      let member = item.memberId ?? null;
      let failed = null;
      if (!member) {
        await page.goto(`${ORIGIN}/messaging/thread/${encodeURIComponent(item.threadKey)}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        ({ member = null, failed = null } = await participant(page, item.threadKey, self, pace, sleep));
        if (!member && shots < 2) { shots += 1; await shot(page, `profile-miss-${shots}`).catch(() => {}); }
      }
      if (!member) {
        answer = { ...answer, failed };
      } else {
        await sleep(rand(1200, 2500) * pace);
        await page.goto(`${ORIGIN}/in/${encodeURIComponent(member)}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await sleep(rand(2500, 4000) * pace);
        await page.waitForSelector?.('main h1', { timeout: 8000 }).catch(() => {});
        await guard();
        // The heading is sometimes not painted yet, or not an h1 in this build;
        // the tab title is «Name | LinkedIn» from the first byte (19.10: the
        // first run read no names at all from the heading).
        const seen = await page.evaluate(() => {
          const heading = document.querySelector('main h1, h1')?.innerText?.trim();
          const title = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*[|(].*$/, '').trim();
          return {
            url: location.href,
            name: heading || (title && !/^linkedin$/i.test(title) ? title : null),
            headline: document.querySelector('main .text-body-medium')?.innerText?.trim() || null
          };
        }).catch(() => ({ url: page.url(), name: null, headline: null }));
        const vanity = vanitySlug(seen.url);
        answer = vanity
          ? { ...answer, memberId: member, vanity, name: seen.name, headline: seen.headline }
          : { ...answer, memberId: member, failed: 'no_profile_address' };
      }
    } catch (error) {
      answer = { ...answer, failed: `error: ${String(error.message).slice(0, 120)}` };
      if (/Target crashed|Page crashed|has been closed/i.test(error.message)) {
        // The tab died: the portal hears of it, and the next person opens in a fresh one.
        await portal.profileResolved(answer).catch(() => {});
        done.failed += 1;
        page = await refresh(null);
        continue;
      }
    }
    const reply = await portal.profileResolved(answer).catch((error) => ({ success: false, error: error.message }));
    if (answer.vanity && reply.success) {
      done.resolved += 1;
      log(`  🔗 ${answer.name || answer.vanity}: ${reply.merged ? 'та сама людина вже є — об\'єднано' : 'посилання й ім\'я виправлено'}`);
    } else {
      done.failed += 1;
      log(`  ⚠️ профіль не уточнено (${answer.failed || reply.error})`);
    }
    await sleep(rand(1500, 3000) * pace);
  }
  return done;
}
