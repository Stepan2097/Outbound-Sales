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
/** The member link of the person in an open conversation — the inbox sweep's own reader. */
async function participantOf(page, threadKey, self, pace) {
  const settled = await settleThread(page, { threadKey }, { pace });
  if (!settled.ok) return { failed: 'thread_not_painted' };
  const member = buildThread({ threadKey, harvest: settled.harvest, self })?.payload?.participant?.slug ?? null;
  return member ? { member } : { failed: 'no_participant_link' };
}

export async function resolveProfiles(page, items, {
  portal, guard = async () => {}, self, log = () => {}, refresh = async (current) => current, sleep = wait, pace = 1,
  participant = participantOf
}) {
  const done = { resolved: 0, failed: 0 };
  for (const item of items ?? []) {
    page = await refresh(page);
    await guard();
    let answer = { contactId: item.contactId, threadKey: item.threadKey };
    try {
      await page.goto(`${ORIGIN}/messaging/thread/${encodeURIComponent(item.threadKey)}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const { member, failed } = await participant(page, item.threadKey, self, pace);
      if (!member) {
        answer = { ...answer, failed };
      } else {
        await sleep(rand(1200, 2500) * pace);
        await page.goto(`${ORIGIN}/in/${encodeURIComponent(member)}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await sleep(rand(2500, 4000) * pace);
        await guard();
        const seen = await page.evaluate(() => ({
          url: location.href,
          name: document.querySelector('main h1, h1')?.innerText?.trim() || null,
          headline: document.querySelector('main .text-body-medium')?.innerText?.trim() || null
        })).catch(() => ({ url: page.url(), name: null, headline: null }));
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
