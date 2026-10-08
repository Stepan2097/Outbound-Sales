/** Browser actions for people chosen by Outbound-Sales. No recipient discovery here. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONNECT = /^(connect|invite .+ to connect|підключитися|встановити контакт|приєднатися|установить контакт|подключиться)$/i;
const MORE = /^(more|more actions|більше|ще|ещё|еще)$/i;
const SEND = /^(send|send invitation|надіслати|відправити|отправить)$/i;
const BARE = /^(send without a note|send now|надіслати без нотатки|надіслати без примітки|отправить без заметки)$/i;

export function profileSlug(link) {
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || !/^(www\.)?linkedin\.com$/i.test(url.hostname)) return null;
    const slug = url.pathname.match(/^\/in\/([^/]+)\/?$/)?.[1];
    return slug ? decodeURIComponent(slug).toLowerCase() : null;
  } catch { return null; }
}

/** An explicit restriction stops the whole visit, including the inbox. */
export async function linkedinWarning(page) {
  if (/\/(checkpoint|challenge|captcha)(\/|\?)/i.test(page.url())) return 'LinkedIn checkpoint or CAPTCHA';
  const text = await page.locator('body').innerText();
  const restriction = /(?:you(?:'ve| have) reached (?:your |the )?(?:weekly )?invitation limit|weekly invitation limit|too many invitations|temporarily restricted|account (?:has been |is )restricted|verify your identity|security verification|unusual activity|підтверд(?:іть|ити) (?:свою )?особу|ліміт запрошень|обмежено ваш акаунт|превышен.{0,30}лимит приглашений|подтвердите (?:свою )?личность|аккаунт.{0,30}ограничен|необычн.{0,15}активност)/i;
  return text.match(restriction)?.[0] ?? null;
}

export class VisitStopped extends Error {}

export async function stopOnWarning(page, portal) {
  const warning = await linkedinWarning(page);
  if (!warning) return;
  const result = await reportWithRetry(() => portal.warning(warning));
  if (!result.success) throw new VisitStopped(`Could not report LinkedIn warning: ${result.error}`);
  throw new VisitStopped(`LinkedIn warning — account paused: ${warning}`);
}

export async function reportWithRetry(send, { sleep = wait, attempts = 2 } = {}) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await send();
      if (response.success || (response.status >= 400 && response.status < 500)) return response;
      failure = response.error || `HTTP ${response.status}`;
    } catch (error) { failure = error.message; }
    if (attempt + 1 < attempts) await sleep(3000);
  }
  throw new VisitStopped(`Report failed; stopping this visit: ${failure}`);
}

/**
 * Mark only the main profile header, so a Connect in a suggestion is never clicked.
 *
 * The anchor is the person's own name, not the page's shape. It used to be
 * `main h1`, and on 08.10.2026 that stopped existing: a live profile now has no
 * `h1` anywhere on it and carries the name in an `h2` with generated class
 * names. Every queued invitation failed as `no_button` — the agent could not
 * find the card, so it never looked for a button at all.
 *
 * So the heading is found by what it says. We already know whose profile this
 * is — the queue carries the name and the URL, and the URL was checked before
 * this runs — and a suggestion's card carries somebody else's name, which is
 * what keeps "never click a Connect in a suggestion" true without relying on
 * where LinkedIn happens to put its asides this quarter.
 *
 * Three anchors, in order: the heading that says this person's name; the
 * heading whose card links to this person's own profile; and, last, an `h1`,
 * for the shape the page had before and may have again. A card that holds two
 * headings is two people's, not this person's header, and is refused.
 */
async function profileCard(page, name = '', slug = null) {
  const tokens = nameTokens(name);
  const safeSlug = typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug) ? slug : null;
  const marked = await page.evaluate(({ tokens, slug }) => {
    document.querySelectorAll('[data-outbound-profile]').forEach((node) => node.removeAttribute('data-outbound-profile'));
    const main = document.querySelector('main');
    if (!main) return false;
    const headings = [...main.querySelectorAll('h1, h2')];
    const flat = (text) => String(text || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
    const cardOf = (heading) => {
      let card = heading.closest('section');
      if (!card) {
        card = heading.parentElement;
        while (card && card.tagName !== 'MAIN' && !card.querySelector('button')) card = card.parentElement;
      }
      if (!card || card.tagName === 'MAIN') return null;
      // One heading to a card: a container that holds another person's name is
      // not this person's header.
      if (card.querySelectorAll('h1, h2').length !== 1) return null;
      return card;
    };
    const byName = tokens.length
      ? headings.filter((heading) => {
          const text = flat(heading.textContent);
          return tokens.every((token) => text.includes(token));
        })
      : [];
    const bySlug = slug
      ? headings.filter((heading) => cardOf(heading)?.querySelector(`a[href*="/in/${slug}"]`))
      : [];
    for (const heading of [...byName, ...bySlug, ...headings.filter((heading) => heading.tagName === 'H1')]) {
      const card = cardOf(heading);
      if (card) {
        card.setAttribute('data-outbound-profile', 'true');
        return true;
      }
    }
    return false;
  }, { tokens, slug: safeSlug });
  if (!marked) return null;
  return page.locator('[data-outbound-profile="true"]');
}

/**
 * A name as the page would spell it: without accents, case or punctuation, so
 * "Álex Galindo" in the CRM still matches "Alex Galindo" on screen. One-letter
 * pieces are dropped — an initial matches almost any heading.
 */
function nameTokens(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

async function visibleButton(scope, name) {
  const buttons = scope.getByRole('button', { name });
  for (let i = 0; i < await buttons.count(); i += 1) {
    const button = buttons.nth(i);
    if (await button.isVisible()) return button;
  }
  return null;
}

async function relation(card) {
  if (await visibleButton(card, /^(pending|запрошення надіслано|очікує|ожидает)$/i)) return 'pending';
  const text = await card.innerText();
  const degree = card.getByText(/^(?:1st|1-й|1-ий)$/i);
  if (await degree.count() && await degree.first().isVisible()) return 'accepted';
  return null;
}

async function openProfile(page, invite, { sleep = wait, guard = async () => {} } = {}) {
  const expected = profileSlug(invite.linkedin);
  if (!expected) throw new VisitStopped('The queue contains an invalid LinkedIn profile URL');
  const response = await page.goto(invite.linkedin, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1800);
  await guard();
  if (response?.status() === 404) return { gone: true };
  if (profileSlug(page.url()) !== expected) throw new VisitStopped('LinkedIn redirected away from the queued person');
  const card = await profileCard(page, invite.name, expected);
  return { card, gone: false };
}

export async function sendInvitation(page, invite, { sleep = wait, guard = async () => {} } = {}) {
  const { card, gone } = await openProfile(page, invite, { sleep, guard });
  await guard();
  if (gone) return 'profile_gone';
  if (!card) return 'no_button';
  const before = await relation(card);
  if (before) return before === 'pending' ? 'already_pending' : 'already_connected';

  let connect = await visibleButton(card, CONNECT);
  if (!connect) {
    const more = await visibleButton(card, MORE);
    if (more) {
      await more.click();
      await sleep(300);
      connect = await visibleButton(page.getByRole('menu'), CONNECT);
      if (!connect) {
        const item = page.getByRole('menuitem', { name: CONNECT }).first();
        if (await item.isVisible()) connect = item;
      }
    }
  }
  if (!connect) return 'no_button';
  await guard();
  await connect.click();
  await sleep(800);
  await guard();
  const dialog = page.getByRole('dialog').last();
  const hasDialog = await dialog.isVisible();
  const note = typeof invite.note === 'string' ? invite.note : '';
  if (hasDialog) {
    if (await dialog.locator('input[type="email"]').count()) return 'no_button';
    let send;
    if (note) {
      const add = await visibleButton(dialog, /^(add a note|додати нотатку|додати примітку|добавить заметку)$/i);
      if (add) { await add.click(); await sleep(300); }
      const field = dialog.locator('textarea, [contenteditable="true"][role="textbox"]').first();
      if (!await field.isVisible()) return 'no_note';
      const max = await field.getAttribute('maxlength');
      if (max && note.length > Number(max)) return 'no_note';
      await field.fill(note);
      send = await visibleButton(dialog, SEND);
    } else {
      // A bare invitation is intentional. No note is invented or requested.
      send = await visibleButton(dialog, BARE) ?? await visibleButton(dialog, SEND);
    }
    if (!send || !await send.isEnabled()) return note ? 'no_note' : 'no_button';
    await guard();
    await send.click();
  }
  // Some profiles send directly on Connect. The Pending state is the evidence.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(500);
    await guard();
    const freshCard = await profileCard(page, invite.name, profileSlug(invite.linkedin));
    if (freshCard && await relation(freshCard) === 'pending') return 'sent';
  }
  // An uncertain click is not a failed send: leave it waiting for reconciliation.
  throw new VisitStopped('Invitation was clicked but LinkedIn did not confirm Pending');
}

export async function sendQueuedInvitations(page, portal, invites, {
  sleep = wait, guard = () => stopOnWarning(page, portal), leaseId = null,
  send = sendInvitation, onSent = () => {}
} = {}) {
  for (const queued of invites ?? []) {
    await guard();
    const prepared = await reportWithRetry(() => portal.prepareInvite(queued.outreachId), { sleep });
    if (prepared.stopAll || prepared.duringPause) throw new VisitStopped('Server stopped this account');
    if (!prepared.allowed) {
      if (prepared.connectsLeft <= 0) break;
      continue;
    }
    const invite = prepared.invite;
    if (invite.outreachId !== queued.outreachId || profileSlug(invite.linkedin) !== profileSlug(queued.linkedin)) {
      throw new VisitStopped('The queued recipient changed during preparation');
    }
    const outcome = await send(page, invite, { sleep, guard });
    const answer = await reportWithRetry(() => portal.inviteSent(invite.outreachId, outcome, leaseId), { sleep });
    if (!answer.success) throw new VisitStopped(`Invitation report refused: ${answer.error}`);
    if (outcome === 'sent') onSent(invite);
    if (answer.duringPause || outcome === 'blocked') throw new VisitStopped('Account paused during invitation');
    if (answer.stopSending || answer.overQuota) break;
    await sleep(2000);
  }
}

/** An absent invitation is never called withdrawn without proof. */
export async function checkInvitations(page, portal, invites, {
  sleep = wait, guard = () => stopOnWarning(page, portal)
} = {}) {
  const results = [];
  for (const invite of invites ?? []) {
    const { card } = await openProfile(page, invite, { sleep, guard });
    await guard();
    const state = card ? await relation(card) : null;
    results.push({ outreachId: invite.outreachId, state: state === 'accepted' ? 'accepted' : 'pending' });
  }
  const result = await reportWithRetry(() => portal.invitesChecked(results), { sleep });
  if (!result.success) throw new VisitStopped(`Daily invitation check refused: ${result.error}`);
  return result;
}
