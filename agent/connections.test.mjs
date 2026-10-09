import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/env.mjs';
import {
  sendInvitation, sendQueuedInvitations, checkInvitations, stopOnWarning, VisitStopped, reportWithRetry
} from './lib/connections.mjs';
import { buildThread } from './lib/inbox-dom.mjs';

let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH }); });
after(async () => { await browser?.close(); });
const sleep = async () => {};
const queued = { outreachId: 'invite-1', name: 'Person One', linkedin: 'https://www.linkedin.com/in/person-one/', note: '' };

/** All LinkedIn URLs are intercepted. These are local synthetic pages. */
async function profile(t, { more = false, pending = false, accepted = false, noButton = false, emailWall = false, nameless = false, connectLink = false, connectLong = false, suggestionInCard = false, acceptedUa = false, dialogDelay = 0, softGone = false, noteLimit = 200, warning = '', redirected = false, heading = 'h1', confirms = true, sentList = [] } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await context.route('**/*', (route) => {
    // LinkedIn's own list of sent invitations, as a synthetic page: links to
    // /in/<slug> are the whole of what the agent reads from it.
    if (route.request().url().includes('/invitation-manager/sent/')) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><main>`
        + sentList.map((slug) => `<a href="/in/${slug}/">somebody</a>`).join('')
        + `</main></body></html>` });
    }
    const action = pending ? '<button>Pending</button>' : accepted ? '<span>1st</span><button>Message</button>'
      : acceptedUa ? '<span>· 1-й</span><button>Повідомлення</button><button>Більше</button>' : noButton ? ''
      : more ? '<button id="more">More</button>'
      // 09.10.2026, the Ukrainian interface: a link to this person's own
      // invite page, with only the long label.
      : connectLong ? '<button id="connect" aria-label="Надіслати запрошення учасникові Person One, щоб встановити контакт">Встановити контакт</button>'
      : connectLink ? '<a id="connect" href="/preload/custom-invite/?vanityName=person-one" aria-label="Надіслати запрошення учасникові Person One, щоб встановити контакт">Встановити контакт</a>'
      : '<button id="connect">Connect</button>';
    // A suggestion inside the card itself, with the same long label and
    // somebody else's name.
    const suggestion = suggestionInCard
      ? '<button id="wrong-in-card" aria-label="Надіслати запрошення учасникові Shantal Chengelrayen, щоб встановити контакт">Встановити контакт</button>'
      : '';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
      ${warning}<main><section><${heading}>${nameless ? 'Hidden Behind A Redesign' : 'Person One'}</${heading}><div id="actions">${action}</div>${suggestion}</section>
      <aside><h2>Other Person</h2><button id="wrong">Connect</button></aside></main>
      <script>
      window.sent = []; window.wrongClicks = 0;
      try { if (!sessionStorage.getItem('sent')) sessionStorage.setItem('sent', '[]'); } catch {}
      document.querySelector('#wrong').onclick = () => window.wrongClicks++;
      const wrongInCard = document.querySelector('#wrong-in-card'); if (wrongInCard) wrongInCard.onclick = () => window.wrongClicks++;
      const dialog = () => {
        document.querySelector('[role="menu"]')?.remove();
        const el = document.createElement('div'); el.setAttribute('role','dialog');
        el.innerHTML = ${emailWall} ? '<input type="email"><button id="verify">Continue</button>'
          : '<button id="add">Add a note</button><button id="bare">Send without a note</button>';
        document.body.append(el);
        const send = (note) => {
          window.sent.push(note);
          // Mirrored: confirming through the sent list navigates away and
          // takes the window with it.
          try { sessionStorage.setItem('sent', JSON.stringify(window.sent)); } catch {}
          el.remove();
          ${confirms ? "document.querySelector('#actions').innerHTML = '<button>Pending</button>';" : ''}
        };
        if (!el.querySelector('#bare')) return;
        el.querySelector('#bare').onclick = () => send('');
        el.querySelector('#add').onclick = () => {
          el.innerHTML = '<textarea maxlength="${noteLimit}"></textarea><button id="send">Send</button>';
          el.querySelector('#send').onclick = () => send(el.querySelector('textarea').value);
        };
      };
      const connect = document.querySelector('#connect'); if (connect) connect.onclick = (event) => { event.preventDefault(); ${dialogDelay ? `setTimeout(dialog, ${dialogDelay})` : 'dialog()'}; };
      const more = document.querySelector('#more'); if (more) more.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role','menu');
        menu.innerHTML = '<button role="menuitem">Connect</button>'; document.body.append(menu);
        menu.firstChild.onclick = dialog;
      };
      ${redirected ? "history.replaceState(null,'','/in/someone-else/');" : ''}
      ${softGone ? "history.replaceState(null,'','/404/');" : ''}
      </script></body></html>` });
  });
  return page;
}

/**
 * 08.10.2026: a live profile had no `h1` anywhere and carried the name in an
 * `h2`. The card was never found, so every queued invitation came back
 * `no_button` — ten people in one visit, with nothing on screen saying why.
 * The header is found by the name now, so the shape of the page can change
 * again without taking the warm-up with it.
 */
test('a profile whose name is in an h2, with no h1 on the page, still gets its request', async (t) => {
  const page = await profile(t, { heading: 'h2' });
  assert.equal(await page.evaluate(() => document.querySelectorAll('h1').length), 0);
  assert.equal(await sendInvitation(page, { ...queued, note: '' }, { sleep }), 'sent');
  assert.deepEqual(await page.evaluate(() => window.sent), ['']);
  // The suggestion beside it is another person's card and stays untouched.
  assert.equal(await page.evaluate(() => window.wrongClicks), 0);
});

test('a request behind «Більше» is sent on a page with no h1 either', async (t) => {
  const page = await profile(t, { heading: 'h2', more: true });
  assert.equal(await sendInvitation(page, { ...queued, note: '' }, { sleep }), 'sent');
  assert.deepEqual(await page.evaluate(() => window.sent), ['']);
  assert.equal(await page.evaluate(() => window.wrongClicks), 0);
});

/** Що саме надсилалось, із дзеркала, яке переживає перехід на інші сторінки. */
async function sentNotes(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('sent') || '[]'));
}

/**
 * 08.10.2026: the profile header stopped saying «Pending» — withdrawing moved
 * inside «More» — so a real invitation went out and the agent then threw
 * «LinkedIn did not confirm Pending» and ended the visit. The evidence now
 * comes from the page that exists for this question.
 */
test('коли шапка профілю більше нічого не каже, надісланий запит підтверджує список надісланих', async (t) => {
  const page = await profile(t, { heading: 'h2', confirms: false, sentList: ['person-one'] });
  assert.equal(await sendInvitation(page, { ...queued, note: '' }, { sleep }), 'sent');
  assert.deepEqual(await sentNotes(page), ['']);
});

test('клік, якого не видно ні в шапці, ні в списку, зупиняє візит, а не зараховується', async (t) => {
  const page = await profile(t, { heading: 'h2', confirms: false, sentList: [] });
  await assert.rejects(
    () => sendInvitation(page, { ...queued, note: '' }, { sleep }),
    (error) => error instanceof VisitStopped && /sent list/.test(error.message)
  );
  // Клік таки був — рядок лишається в черзі на звірку, а не списується.
  assert.deepEqual(await sentNotes(page), ['']);
});

test('людину, яка вже в надісланих, другим запитом не чіпають', async (t) => {
  const page = await profile(t, { sentList: ['person-one'] });
  const outcomes = [];
  await sendQueuedInvitations(page, { prepareInvite: async () => ({ success: true, allowed: true, invite: queued, connectsLeft: 5 }),
    inviteSent: async (_id, outcome) => { outcomes.push(outcome); return { success: true }; } },
    [queued], { sleep, guard: async () => {} });
  assert.deepEqual(outcomes, ['already_pending']);
  // Жодного кліку: діалог навіть не відкривався.
  assert.deepEqual(await sentNotes(page), []);
});

test('a bare request and a request with an approved note reach only the queued profile', async (t) => {
  for (const note of ['', 'Радий знайомству']) {
    const page = await profile(t);
    assert.equal(await sendInvitation(page, { ...queued, note }, { sleep }), 'sent');
    assert.deepEqual(await page.evaluate(() => window.sent), [note]);
    assert.equal(await page.evaluate(() => window.wrongClicks), 0);
  }
});

test('Connect inside More is sent; suggestions are never used as a fallback', async (t) => {
  const menu = await profile(t, { more: true });
  assert.equal(await sendInvitation(menu, queued, { sleep }), 'sent');
  const missing = await profile(t, { noButton: true });
  assert.equal(await sendInvitation(missing, queued, { sleep }), 'cannot_connect');
  assert.equal(await missing.evaluate(() => window.wrongClicks), 0);
});

/**
 * Two different failures used to share one word, and the portal could only
 * treat both the cautious way: an unreachable profile came back every day and
 * held a slot of the account's allowance, because writing it off would have
 * written off everybody a redesign hid as well. They are told apart by the
 * card: found and silent is about them, never found is about us.
 */
/**
 * 09.10.2026: in the Ukrainian interface Connect was a link to the person's
 * own invite page, labelled only «Надіслати запрошення учасникові …, щоб
 * встановити контакт». Every request of the morning — fourteen people — came
 * back «no Connect». Beside it sat suggestions with the same label and other
 * names: finding Connect must never mean clicking one of those.
 */
test('Connect посиланням з довгою українською назвою надсилається, а пропозиція з чужим іменем у картці — ні', async (t) => {
  const page = await profile(t, { heading: 'h2', connectLink: true, suggestionInCard: true });
  assert.equal(await sendInvitation(page, { ...queued, note: '' }, { sleep }), 'sent');
  assert.deepEqual(await page.evaluate(() => window.sent), ['']);
  assert.equal(await page.evaluate(() => window.wrongClicks), 0, 'запит пішов іншій людині');
});

/**
 * 09.10.2026: the Connect link loads /preload/custom-invite/ and the dialog
 * comes up there seconds later. The agent looked once, after 0.8s, found no
 * dialog and stopped the visit — the request was never sent.
 */
test('діалог запрошення, що з\'являється за кілька секунд після Connect, дочікується, і запит іде', async (t) => {
  const page = await profile(t, { heading: 'h2', connectLink: true, dialogDelay: 2500 });
  const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  assert.equal(await sendInvitation(page, { ...queued, note: '' }, { sleep: realSleep }), 'sent');
  assert.deepEqual(await sentNotes(page), ['']);
});

test('кнопка з довгою назвою, що називає саме цю людину, — наш Connect, навіть поруч із чужою', async (t) => {
  const page = await profile(t, { heading: 'h2', connectLong: true, suggestionInCard: true });
  assert.equal(await sendInvitation(page, { ...queued, note: '' }, { sleep }), 'sent');
  assert.deepEqual(await page.evaluate(() => window.sent), ['']);
  assert.equal(await page.evaluate(() => window.wrongClicks), 0);
});

test('кнопка з довгою назвою, що називає іншу людину, — не наш Connect', async (t) => {
  const page = await profile(t, { heading: 'h2', noButton: true, suggestionInCard: true });
  assert.equal(await sendInvitation(page, { ...queued, note: '' }, { sleep }), 'cannot_connect');
  assert.equal(await page.evaluate(() => window.wrongClicks), 0);
});

test('профіль без жодного Connect — це про людину, а зникла картка — про нас', async (t) => {
  const silent = await profile(t, { noButton: true });
  assert.equal(await sendInvitation(silent, queued, { sleep }), 'cannot_connect');

  const walled = await profile(t, { emailWall: true });
  assert.equal(await sendInvitation(walled, queued, { sleep }), 'cannot_connect',
    'пошта, якої ми не знаємо, завтра буде такою самою');
  assert.deepEqual(await walled.evaluate(() => window.sent), [], 'нічого не надіслано');

  // Сторінку перемалювали так, як 08.10: ні h1, ні імені людини в заголовку —
  // картки не знайти взагалі, і дивитись на кнопки нема де.
  const redesigned = await profile(t, { nameless: true, heading: 'h2' });
  assert.equal(await sendInvitation(redesigned, queued, { sleep }), 'no_button',
    'це наші селектори, і за це людину не списують');
  assert.equal(await redesigned.evaluate(() => window.wrongClicks), 0);
});

test('an existing connection or pending request is reconciled without another click', async (t) => {
  for (const [options, outcome] of [[{ pending: true }, 'already_pending'], [{ accepted: true }, 'already_connected']]) {
    const page = await profile(t, options);
    assert.equal(await sendInvitation(page, queued, { sleep }), outcome);
    assert.deepEqual(await page.evaluate(() => window.sent), []);
  }
});

test('«· 1-й» в українському інтерфейсі — це вже контакт, а не людина без Connect', async (t) => {
  const page = await profile(t, { heading: 'h2', acceptedUa: true });
  assert.equal(await sendInvitation(page, queued, { sleep }), 'already_connected');
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('an approved note too long for LinkedIn is not truncated or replaced by a bare send', async (t) => {
  const page = await profile(t, { noteLimit: 5 });
  assert.equal(await sendInvitation(page, { ...queued, note: 'Радий знайомству' }, { sleep }), 'no_note');
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('видалений профіль, що відповідає 200 і переходить на /404/, — це profile_gone, а не зупинка візиту', async (t) => {
  const page = await profile(t, { softGone: true });
  assert.equal(await sendInvitation(page, queued, { sleep }), 'profile_gone');
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('a redirected profile is not treated as the queued recipient', async (t) => {
  const page = await profile(t, { redirected: true });
  await assert.rejects(sendInvitation(page, queued, { sleep }), VisitStopped);
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('an invitation limit warning pauses the server before any request is sent', async (t) => {
  const page = await profile(t, { warning: '<div role="alert">You have reached your weekly invitation limit</div>' });
  let paused = 0;
  await assert.rejects(sendInvitation(page, queued, { sleep, guard: () => stopOnWarning(page, {
    warning: async () => { paused++; return { success: true }; }
  }) }), VisitStopped);
  assert.equal(paused, 1);
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

/**
 * 09.10.2026, Chloe Stewart, verbatim. Her account had 307 old invitations
 * pending and hit LinkedIn's weekly limit; the Ukrainian toast was not
 * recognised, so every session clicked Connect into the same refusal.
 */
test('український тижневий ліміт LinkedIn теж зупиняє і ставить акаунт на паузу', async (t) => {
  const page = await profile(t, { warning: '<div role="alert">Ваше запрошення не було надіслано Bruno, оскільки ви досягли тижневого ліміту на запрошення контактів. Повторіть спробу наступного тижня</div>' });
  let paused = 0;
  await assert.rejects(sendInvitation(page, queued, { sleep, guard: () => stopOnWarning(page, {
    warning: async () => { paused++; return { success: true }; }
  }) }), VisitStopped);
  assert.equal(paused, 1, 'акаунт не поставлено на паузу');
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('a server stop after the first send prevents the next person from opening', async () => {
  let sends = 0;
  const reports = [];
  const portal = {
    prepareInvite: async (id) => ({ success: true, allowed: true, invite: { ...queued, outreachId: id } }),
    inviteSent: async (id, outcome, lease) => { reports.push({ id, outcome, lease }); return { success: true, stopSending: true }; }
  };
  await sendQueuedInvitations({}, portal, [queued, { ...queued, outreachId: 'invite-2' }], {
    sleep, guard: async () => {}, leaseId: 'lease-1', send: async () => { sends++; return 'sent'; }
  });
  assert.equal(sends, 1);
  assert.deepEqual(reports, [{ id: 'invite-1', outcome: 'sent', lease: 'lease-1' }]);
});

test('a pause before sending and two lost reports each stop the entire visit', async () => {
  let sends = 0;
  await assert.rejects(sendQueuedInvitations({}, {
    prepareInvite: async () => ({ success: true, allowed: false, duringPause: true })
  }, [queued], { sleep, guard: async () => {}, send: async () => { sends++; } }), VisitStopped);
  assert.equal(sends, 0);
  let attempts = 0;
  await assert.rejects(reportWithRetry(async () => { attempts++; throw new Error('lost socket'); }, { sleep }), VisitStopped);
  assert.equal(attempts, 2);
});

test('the daily check records accepted but never invents a withdrawn invitation', async (t) => {
  const page = await profile(t, { accepted: true });
  let posted;
  await checkInvitations(page, { invitesChecked: async (results) => { posted = results; return { success: true }; } }, [queued], { sleep });
  assert.deepEqual(posted, [{ outreachId: 'invite-1', state: 'accepted' }]);
});

test('message ids survive aging labels, preserve LinkedIn URNs, and distinguish repeated words', () => {
  const harvest = (label) => ({ items: [
    { index: 0, slug: 'other', paragraphs: ['ok'], stampText: label },
    { index: 1, paragraphs: ['ok'], stampText: label },
    { index: 2, paragraphs: ['Long reply'], externalId: 'urn:li:msg_message:(a,b)', stampIso: '2026-09-22T10:11:00Z' }
  ] });
  const first = buildThread({ threadKey: 't', harvest: harvest('2h'), self: { slug: 'me' } });
  const later = buildThread({ threadKey: 't', harvest: harvest('Sep 22'), self: { slug: 'me' } });
  assert.deepEqual(first.payload.messages.map((m) => m.externalId), later.payload.messages.map((m) => m.externalId));
  assert.notEqual(first.payload.messages[0].externalId, first.payload.messages[1].externalId);
  assert.equal(first.payload.messages[0].sentAt, '2h');
  assert.equal(first.payload.messages[2].externalId, 'urn:li:msg_message:(a,b)');
  assert.equal(first.payload.messages[2].sentAt, '2026-09-22T10:11:00.000Z');
});
