/** Browser actions for people chosen by Outbound-Sales. No recipient discovery here. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// How long the invite dialog may take to come up after Connect: twelve looks
// a second apart — the link loads a page of its own before showing it.
const DIALOG_WAIT_TRIES = 12;
const DIALOG_WAIT_MS = 1000;
const CONNECT = /^(connect|invite .+ to connect|підключитися|встановити контакт|приєднатися|установить контакт|подключиться)$/i;
// LinkedIn's long accessible label names a person: «Invite Ajay Manger to
// connect», «Надіслати запрошення учасникові Ajay Manger, щоб встановити
// контакт». The suggestions beside the card carry the same label with
// somebody else's name, so it only counts when the name is this person's.
const CONNECT_LONG = /^(invite .+ to connect|надіслати запрошення .+ встановити контакт|пригласить .+ установить контакт)$/i;
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

/**
 * Who this account is already waiting on, read from LinkedIn's own list of
 * sent invitations.
 *
 * The profile page used to answer this: a «Pending» button in the header meant
 * the request was out. On 08.10.2026 it stopped — the header keeps only
 * «More», with withdrawing moved inside it — and the agent clicked Connect,
 * sent a real invitation, then threw «LinkedIn did not confirm Pending» and
 * ended the visit. The request had gone out; only our reading of it had not.
 *
 * So the evidence moved to the page that exists for exactly this question. It
 * is one load per visit plus one after each send, it is the same list a person
 * would open to check, and it does not care what LinkedIn calls its buttons
 * this quarter or in which language.
 *
 * Unreadable list → an empty set, never a thrown visit: not knowing who is
 * pending must cost at most a careful re-send that LinkedIn itself refuses,
 * not the morning's work.
 */
const SENT_INVITATIONS = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';

export async function pendingSlugs(page, { sleep = wait, guard = async () => {} } = {}) {
  const slugs = new Set();
  try {
    await page.goto(SENT_INVITATIONS, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(1500);
    await guard();
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="/in/"]')].map((node) => node.getAttribute('href') || ''));
    for (const href of hrefs) {
      const slug = profileSlug(/^https?:/i.test(href) ? href : `https://www.linkedin.com${href}`);
      if (slug) slugs.add(slug);
    }
  } catch (error) {
    if (error instanceof VisitStopped) throw error;
  }
  return slugs;
}

/**
 * An explicit restriction stops the whole visit, including the inbox.
 *
 * The Ukrainian weekly limit reads «Ваше запрошення не було надіслано …,
 * оскільки ви досягли тижневого ліміту на запрошення контактів» — not «ліміт
 * запрошень». On 09.10.2026 Chloe's account had 307 old invitations pending and
 * hit that limit; the toast went unrecognised, and every session clicked
 * Connect again into the same refusal.
 */
export async function linkedinWarning(page) {
  if (/\/(checkpoint|challenge|captcha)(\/|\?)/i.test(page.url())) return 'LinkedIn checkpoint or CAPTCHA';
  const text = await page.locator('body').innerText();
  const restriction = /(?:you(?:'ve| have) reached (?:your |the )?(?:weekly )?invitation limit|weekly invitation limit|too many invitations|temporarily restricted|account (?:has been |is )restricted|verify your identity|security verification|unusual activity|підтверд(?:іть|ити) (?:свою )?особу|ліміт запрошень|ліміт\S* на запрошення|тижнев\S* ліміт\S*|запрошення не було надіслано|обмежено ваш акаунт|превышен.{0,30}лимит приглашений|подтвердите (?:свою )?личность|аккаунт.{0,30}ограничен|необычн.{0,15}активност)/i;
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

/**
 * This person's Connect, in the card — and never anybody else's.
 *
 * On 09.10.2026 it was not a button at all but a link,
 * `<a href="/preload/custom-invite/?vanityName=<slug>">`, labelled
 * «Надіслати запрошення учасникові Ajay Manger, щоб встановити контакт». The
 * agent looked only for buttons with the short label, so every request of the
 * morning — fourteen people on three accounts — came back «no Connect» while
 * the page had one for each of them.
 *
 * Next to it sat suggestions with the very same long label and another
 * person's name, as buttons. So the order is by certainty: the link that names
 * this person's own profile; then the short label, which names nobody; then a
 * long label only if it carries this person's name.
 */
async function visibleConnect(card, slug, name) {
  if (slug) {
    const invites = card.locator('a[href*="/preload/custom-invite/"]');
    for (let i = 0; i < await invites.count(); i += 1) {
      const link = invites.nth(i);
      const href = await link.getAttribute('href') || '';
      const vanity = new URL(href, 'https://www.linkedin.com').searchParams.get('vanityName') || '';
      if (decodeURIComponent(vanity).toLowerCase() === slug.toLowerCase() && await link.isVisible()) return link;
    }
  }
  for (const role of ['button', 'link']) {
    const short = card.getByRole(role, { name: CONNECT });
    for (let i = 0; i < await short.count(); i += 1) {
      const control = short.nth(i);
      const label = (await control.getAttribute('aria-label')) || (await control.innerText()).trim();
      // `CONNECT` also accepts «Invite X to connect»; that one goes through
      // the name check below like every long label.
      if (CONNECT_LONG.test(label)) continue;
      if (await control.isVisible()) return control;
    }
  }
  const tokens = nameTokens(name);
  if (!tokens.length) return null;
  for (const role of ['button', 'link']) {
    const long = card.getByRole(role, { name: CONNECT_LONG });
    for (let i = 0; i < await long.count(); i += 1) {
      const control = long.nth(i);
      const label = ((await control.getAttribute('aria-label')) || (await control.innerText()))
        .normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
      if (tokens.every((token) => label.includes(token)) && await control.isVisible()) return control;
    }
  }
  return null;
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
  // «1st» in English; in Ukrainian it reads «· 1-й», dot and all — on
  // 09.10.2026 two people already connected to the account were taken for
  // people with no Connect because the dot did not match.
  const degree = card.getByText(/^(?:·\s*)?(?:1st|1-й|1-ий)$/i);
  if (await degree.count() && await degree.first().isVisible()) return 'accepted';
  return null;
}

async function openProfile(page, invite, { sleep = wait, guard = async () => {} } = {}) {
  const expected = profileSlug(invite.linkedin);
  if (!expected) throw new VisitStopped('The queue contains an invalid LinkedIn profile URL');
  const response = await page.goto(invite.linkedin, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1800);
  await guard();
  // A deleted profile is not always a 404: LinkedIn answers 200 and moves the
  // page to /404/. On 09.10.2026 that read as «redirected away from the
  // queued person» and stopped Profile 48's every visit on the same person.
  if (response?.status() === 404 || /^\/404\/?$/.test(new URL(page.url()).pathname)) return { gone: true };
  if (profileSlug(page.url()) !== expected) throw new VisitStopped('LinkedIn redirected away from the queued person');
  const card = await profileCard(page, invite.name, expected);
  return { card, gone: false };
}

/**
 * What `sendInvitation` would find on this person's profile, without clicking
 * anything: whether the card is there, what LinkedIn says about the two of
 * us, and which control it would press. For checking a live page by hand
 * (`agent/check-connect.mjs`) before trusting a change to the selectors.
 */
export async function inspectConnect(page, invite, { sleep = wait } = {}) {
  const slug = profileSlug(invite.linkedin);
  const { card, gone } = await openProfile(page, invite, { sleep });
  if (gone) return { slug, card: false, gone: true };
  if (!card) return { slug, card: false };
  const before = await relation(card);
  const connect = before ? null : await visibleConnect(card, slug, invite.name);
  return {
    slug,
    card: true,
    relation: before,
    connect: connect ? {
      tag: await connect.evaluate((el) => el.tagName),
      label: (await connect.getAttribute('aria-label')) || (await connect.innerText()).trim(),
      href: await connect.getAttribute('href')
    } : null
  };
}

export async function sendInvitation(page, invite, { sleep = wait, guard = async () => {}, pending = null } = {}) {
  const slug = profileSlug(invite.linkedin);
  // Asked before the profile is even opened: a request already out there is
  // the one thing worth not opening a browser tab for.
  if (pending?.has(slug)) return 'already_pending';
  const { card, gone } = await openProfile(page, invite, { sleep, guard });
  await guard();
  if (gone) return 'profile_gone';
  if (!card) return 'no_button';
  const before = await relation(card);
  if (before) return before === 'pending' ? 'already_pending' : 'already_connected';

  let connect = await visibleConnect(card, slug, invite.name);
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
  // The card is on screen and it is the right person's: no Connect in the
  // header and none under «More» means this profile offers us no way to
  // connect at all. That is about them, not about our selectors, and the
  // portal may let them go (`INVITE_PERSON_OUTCOMES`). A card we never found
  // stays `no_button` above — that one is ours.
  if (!connect) return 'cannot_connect';
  await guard();
  await connect.click();
  await sleep(800);
  await guard();
  // The Connect link goes to /preload/custom-invite/, and the «Надіслати без
  // примітки» dialog comes up there seconds later, not at once. On 09.10.2026
  // the agent looked once after 0.8s, saw no dialog, and stopped the visit
  // with the request never sent. A profile that sends on Connect itself shows
  // no dialog at all; the confirmation below covers that one.
  const dialog = page.getByRole('dialog').last();
  let hasDialog = await dialog.isVisible();
  for (let waited = 0; !hasDialog && waited < DIALOG_WAIT_TRIES; waited += 1) {
    await sleep(DIALOG_WAIT_MS);
    hasDialog = await dialog.isVisible();
  }
  await guard();
  const note = typeof invite.note === 'string' ? invite.note : '';
  if (hasDialog) {
    // LinkedIn asks for their email before it will carry the request: we do
    // not have it and will not guess it, and tomorrow it will ask again.
    if (await dialog.locator('input[type="email"]').count()) return 'cannot_connect';
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
  // Some profiles send directly on Connect. A header that still says so is the
  // quickest evidence; where the header no longer says anything, LinkedIn's
  // own list of sent invitations does.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(500);
    await guard();
    const freshCard = await profileCard(page, invite.name, slug);
    if (freshCard && await relation(freshCard) === 'pending') return 'sent';
  }
  const sentNow = await pendingSlugs(page, { sleep, guard });
  if (sentNow.has(slug)) {
    pending?.add(slug);
    return 'sent';
  }
  // An uncertain click is not a failed send: leave it waiting for reconciliation.
  throw new VisitStopped('Invitation was clicked but neither the profile nor the sent list shows it');
}

export async function sendQueuedInvitations(page, portal, invites, {
  sleep = wait, guard = () => stopOnWarning(page, portal), leaseId = null,
  send = sendInvitation, onSent = () => {}, pending = null
} = {}) {
  const queue = invites ?? [];
  // One read for the whole visit: everybody this account is already waiting
  // on. Without it a queue the portal has not reconciled yet is a queue of
  // second requests to the same people.
  const alreadyPending = pending ?? (queue.length ? await pendingSlugs(page, { sleep, guard }) : new Set());
  for (const queued of queue) {
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
    const outcome = await send(page, invite, { sleep, guard, pending: alreadyPending });
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
