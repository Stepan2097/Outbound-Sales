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
async function profile(t, { more = false, pending = false, accepted = false, noButton = false, noteLimit = 200, warning = '', redirected = false } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await context.route('**/*', (route) => {
    const action = pending ? '<button>Pending</button>' : accepted ? '<span>1st</span><button>Message</button>' : noButton ? '' : more ? '<button id="more">More</button>' : '<button id="connect">Connect</button>';
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      ${warning}<main><section><h1>Person One</h1><div id="actions">${action}</div></section>
      <aside><h2>Other Person</h2><button id="wrong">Connect</button></aside></main>
      <script>
      window.sent = []; window.wrongClicks = 0;
      document.querySelector('#wrong').onclick = () => window.wrongClicks++;
      const dialog = () => {
        document.querySelector('[role="menu"]')?.remove();
        const el = document.createElement('div'); el.setAttribute('role','dialog');
        el.innerHTML = '<button id="add">Add a note</button><button id="bare">Send without a note</button>';
        document.body.append(el);
        const send = (note) => { window.sent.push(note); el.remove(); document.querySelector('#actions').innerHTML = '<button>Pending</button>'; };
        el.querySelector('#bare').onclick = () => send('');
        el.querySelector('#add').onclick = () => {
          el.innerHTML = '<textarea maxlength="${noteLimit}"></textarea><button id="send">Send</button>';
          el.querySelector('#send').onclick = () => send(el.querySelector('textarea').value);
        };
      };
      const connect = document.querySelector('#connect'); if (connect) connect.onclick = dialog;
      const more = document.querySelector('#more'); if (more) more.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role','menu');
        menu.innerHTML = '<button role="menuitem">Connect</button>'; document.body.append(menu);
        menu.firstChild.onclick = dialog;
      };
      ${redirected ? "history.replaceState(null,'','/in/someone-else/');" : ''}
      </script></body></html>` });
  });
  return page;
}

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
  assert.equal(await sendInvitation(missing, queued, { sleep }), 'no_button');
  assert.equal(await missing.evaluate(() => window.wrongClicks), 0);
});

test('an existing connection or pending request is reconciled without another click', async (t) => {
  for (const [options, outcome] of [[{ pending: true }, 'already_pending'], [{ accepted: true }, 'already_connected']]) {
    const page = await profile(t, options);
    assert.equal(await sendInvitation(page, queued, { sleep }), outcome);
    assert.deepEqual(await page.evaluate(() => window.sent), []);
  }
});

test('an approved note too long for LinkedIn is not truncated or replaced by a bare send', async (t) => {
  const page = await profile(t, { noteLimit: 5 });
  assert.equal(await sendInvitation(page, { ...queued, note: 'Радий знайомству' }, { sleep }), 'no_note');
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
