/**
 * The whole sweep, against a messenger that is not LinkedIn.
 *
 *   node --test agent/inbox-sweep.test.mjs
 *
 * `inbox-dom.test.mjs` proves the reading. This proves the *doing*: waiting for
 * the page, clicking a conversation open, waiting for it to paint, deciding
 * which ones to open at all, what is posted and in what order, and — the part
 * that matters most on a bad morning — what happens when things go wrong.
 *
 * It works by serving the fixtures from this machine on a local port, with the
 * paths LinkedIn uses (`/messaging/`, `/messaging/thread/<id>/`), and pointing
 * the sweep at that origin instead. Real Chromium, real clicks, real
 * navigation, real polling. No session, no account, no linkedin.com.
 *
 * What it cannot prove is that LinkedIn's messenger behaves like this static
 * copy of it — in particular that the conversation list is still links and that
 * a click still lands on a thread. That is the standing risk and it is written
 * down in `README.md` under the heading it deserves.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncInbox } from './lib/inbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
const NOW = Date.parse('2026-09-16T10:00:00.000Z');
const SELF = { slug: null, name: 'Mary Lindsay' };   // the normal case: no slug on file

const MARTA = '2-ZjE4ZmQ1NzQtYjE1NC00ZjQ4LThm';
const DMYTRO = '2-NTRhYjIxMDAtOGUwNy00';
const PRIYA = '2-T2xkZXJUaHJlYWQwMDI=';

let browser = null;
let page = null;
let server = null;
let origin = null;
let hits = [];

before(async () => {
  if (!fs.existsSync(CHROME)) return;
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ headless: true, executablePath: CHROME }).catch(() => null);
  if (!browser) return;
  page = await browser.newPage();

  // The messenger, as far as the sweep is concerned.
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.push(url.pathname);
    const key = decodeURIComponent((url.pathname.match(/\/messaging\/thread\/([^/]+)/) ?? [])[1] ?? '');
    let body = null;
    if (url.pathname === '/messaging/' || url.pathname === '/messaging') body = fixture(inboxFixture);
    else if (key === DMYTRO) body = fixture('thread-ours.html');
    // A conversation that opens onto nothing: the page is there, the messages
    // never arrive. It happens, and it must cost one conversation rather than
    // the sweep.
    else if (key === PRIYA) body = '<title>Messaging</title><div>Loading…</div>';
    else if (key) body = fixture('thread-reply.html');
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? '<title>404</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((r) => (server ? server.close(r) : r()));
});

// Which conversation list the fake messenger is serving for the test at hand.
let inboxFixture = 'messaging-list.html';

/** A portal that says yes and remembers what it was asked. */
function stubPortal(overrides = {}) {
  const calls = { threads: [], done: [], logs: [] };
  return {
    calls,
    async inboxThread(payload) {
      calls.threads.push(payload);
      return overrides.thread
        ? overrides.thread(payload)
        : { success: true, stored: payload.messages.length, skipped: 0, invalid: 0, undated: 0 };
    },
    async inboxDone(threadsSeen) { calls.done.push(threadsSeen); return { success: true }; },
    async log(type, message, meta, level) { calls.logs.push({ type, message, meta, level }); return { success: true }; },
  };
}

const sweep = (portal, opts = {}) => syncInbox(page, {
  portal, self: SELF, origin, nowMs: NOW, pace: 0.05, ...opts,
});

describe('a sweep of the messenger', () => {
  test('opens the conversations, posts each one, and marks the sync', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    inboxFixture = 'messaging-list.html';
    hits = [];
    const portal = stubPortal();
    const result = await sweep(portal, { limit: 3 });

    assert.equal(result.listed, 5, 'усі п’ять розмов у списку');
    assert.equal(portal.calls.threads.length, 3, 'відкрито рівно стільки, скільки дозволено');
    assert.equal(result.threadsSeen, 3);
    assert.deepEqual(portal.calls.done, [3], 'inbox.done рівно один раз, з числом прочитаних');

    // The first is Marta's, read out of thread-reply.html, oldest first.
    const marta = portal.calls.threads[0];
    assert.equal(marta.threadKey, MARTA);
    assert.equal(marta.participant.name, 'Marta Kowalczyk');
    assert.equal(marta.messages.length, 5);
    const times = marta.messages.map((m) => Date.parse(m.sentAt));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'повідомлення від найстарішого');

    // The second is ours-only, found without a single msg-* class, and not one
    // of its three messages is filed as a reply.
    const dmytro = portal.calls.threads.find((p) => p.threadKey === DMYTRO);
    assert.ok(dmytro, 'друга розмова відкрилась');
    assert.ok(dmytro.messages.every((m) => m.direction === 'out'), 'наші власні повідомлення не стали відповідями');
  });

  test('a conversation that will not paint costs one conversation, not the run', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    inboxFixture = 'messaging-list.html';
    const portal = stubPortal();
    const result = await sweep(portal, { limit: 5 });

    assert.equal(result.listed, 5);
    assert.equal(portal.calls.threads.length, 4, 'чотири з п’яти');
    assert.ok(!portal.calls.threads.some((p) => p.threadKey === PRIYA));
    assert.ok(result.notes.some((n) => n.includes(PRIYA) && /не відкрилась/.test(n)), 'і в нотатках написано, яка саме');
    assert.deepEqual(portal.calls.done, [4]);
  });

  test('stops at the last sync instead of reading the history again', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    inboxFixture = 'messaging-list.html';
    const portal = stubPortal();
    // Yesterday morning: the 2h and Yesterday rows are newer, the 3d one is not.
    await sweep(portal, { since: NOW - 30 * 3600_000 });
    assert.deepEqual(portal.calls.threads.map((p) => p.threadKey), [MARTA, DMYTRO]);
  });

  test('an empty inbox is reported as empty, and not as a failure', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    inboxFixture = 'messaging-empty.html';
    const portal = stubPortal();
    const result = await sweep(portal);

    assert.equal(result.listed, 0);
    assert.equal(result.threadsSeen, 0);
    assert.equal(result.suspicious, false, 'порожня скринька — це не поломка');
    assert.deepEqual(portal.calls.done, [0], 'але позначка синхронізації все одно ставиться');
    assert.equal(portal.calls.logs.at(-1).level, 'info');
  });

  /**
   * The day the anchors went was predicted by this fixture and arrived on
   * 08.10.2026. A full inbox with no links is no longer a failure to report —
   * it is a list to read by the shape of its rows. What must still hold is
   * that the run says how it read them, and that the mark goes to the portal
   * either way.
   */
  test('a full inbox with no links is read by the shape of its rows, and says so', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    inboxFixture = 'messaging-rotted.html';
    const portal = stubPortal();
    const result = await sweep(portal);

    assert.ok(result.listed > 0, 'рядки знайдені');
    assert.equal(result.suspicious, false, 'це вже не поломка — сторінку прочитали');
    assert.ok(result.notes.some((note) => /список без посилань/.test(note)), result.notes.join(' | '));
    assert.equal(portal.calls.done.length, 1, 'мітка «дивились сьогодні» однаково пішла');
  });

  test('a portal with no inbox is asked once, not twenty times', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    inboxFixture = 'messaging-list.html';
    const portal = stubPortal({ thread: () => ({ success: false, error: 'Unknown action' }) });
    const result = await sweep(portal, { limit: 5 });

    assert.equal(portal.calls.threads.length, 1, 'зупинився після першої відмови');
    assert.equal(result.threadsSeen, 0);
    assert.match(result.reason, /inbox\.thread/);
  });

  test('without knowing who we are, the messenger is never opened at all', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    hits = [];
    const portal = stubPortal();
    const result = await sweep(portal, { self: { slug: null, name: null } });

    assert.equal(hits.length, 0, 'жодного запиту до месенджера');
    assert.match(result.reason, /не знаю, хто ми/);
    assert.deepEqual(portal.calls.done, [0], 'портал усе одно дізнається, що сесія дивилась');
  });
});
