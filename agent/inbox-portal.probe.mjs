#!/usr/bin/env node
/**
 * Does the portal actually take what this agent actually sends?
 *
 *   WARMUP_AGENT_TOKEN=… node agent/inbox-portal.probe.mjs --portal http://127.0.0.1:4212
 *
 * The messenger reader cannot be tested against LinkedIn — see the note at the
 * top of `lib/inbox-dom.mjs` — but this half can be tested against the real
 * thing, and so it is. This drives the whole chain the morning run drives: a
 * fixture through a real DOM, through the same reader, into the same `Portal`
 * client, at a running portal. Everything except LinkedIn itself.
 *
 * It posts under thread keys beginning `agent-probe-`, so what it leaves behind
 * is obvious to anybody reading the events table later. It deletes nothing.
 *
 * Point it at a *local* portal. It writes messages and sync marks to whatever
 * it is pointed at, and the ones it writes are fiction.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Portal } from './lib/portal.mjs';
import { harvestThread, buildThread } from './lib/inbox-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const PORTAL = arg('portal', 'http://127.0.0.1:4212');
const ACCOUNT = arg('account', 'Profile 47');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOW = Date.parse('2026-09-16T10:00:00.000Z');
// Every run writes its own conversations. Duplicate suppression is the thing
// being tested, so a probe that reused last run's keys would "pass" by being
// suppressed wholesale and prove nothing — and the first genuine regression
// would look exactly like a second run.
const RUN = new Date().toISOString().replace(/[^0-9]/g, '').slice(4, 14);
const key = (name) => `agent-probe-${name}-${RUN}`;
const SELF = { slug: 'mary-lindsay-0a12b3', name: 'Mary Lindsay' };

if (!process.env.WARMUP_AGENT_TOKEN) {
  console.error('WARMUP_AGENT_TOKEN is not set — the agent routes are closed without it, which is the point of them.');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const portal = new Portal(PORTAL);

// ── the portal is the one we think it is ───────────────────────────────────
check('inbox supported at this portal', await portal.supportsInbox(), portal.prefix ?? '?');

const found = await portal.resolve(ACCOUNT);
check('account resolved through the agent token', Boolean(found.accountId), `${found.name} (${found.accountId})`);

const plan = await portal.plan();
check('plan carries the inbox watermark', plan.inbox !== undefined,
  `lastSyncedAt=${plan.inbox?.lastSyncedAt ?? 'null'} maxThreads=${plan.inbox?.maxThreads ?? '?'}`);

// ── a real fixture, through the real reader, into the real portal ──────────
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage();
const open = (name) => page.goto(
  `data:text/html;charset=utf-8,${encodeURIComponent(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'))}`,
  { waitUntil: 'domcontentloaded', timeout: 15_000 },
);

await open('thread-reply.html');
const built = buildThread({ threadKey: key('reply'), harvest: await page.evaluate(harvestThread), self: SELF, nowMs: NOW });
const first = await portal.inboxThread(built.payload);
check('a conversation read off a fixture is accepted', first.success === true, JSON.stringify(first));
check('every message in it was stored', first.stored === built.payload.messages.length,
  `stored ${first.stored} of ${built.payload.messages.length}`);
check('an attachment with no text still arrived', built.payload.messages.some((m) => m.body === '[attachment]'));
check('emoji and markup went in raw', built.payload.messages.some((m) => /😊/.test(m.body)) && built.payload.messages.some((m) => /<b>/.test(m.body)));

// The one that matters: the same conversation, read again an hour later, the
// way tomorrow's run reads it.
await open('thread-reply.html');
const again = buildThread({ threadKey: key('reply'), harvest: await page.evaluate(harvestThread), self: SELF, nowMs: NOW + 3600_000 });
const second = await portal.inboxThread(again.payload);
check('re-reading the same conversation stores nothing new', second.stored === 0,
  `stored ${second.stored}, skipped ${second.skipped}`);
check('and it recognises every message it already had', second.skipped === built.payload.messages.length);

// ── the awkward ones ───────────────────────────────────────────────────────
const awkward = [
  ['a participant with no slug (a group thread)', {
    threadKey: key('group'),
    participant: { name: 'Anna Bauer, Tomás Ruiz', slug: null, headline: null },
    messages: [{ externalId: `${key('group')}-1`, direction: 'in', body: 'we should compare notes on the Q4 pipeline', sentAt: '2026-09-13T12:00:00.000Z' }],
  }, (r) => r.success && r.stored === 1],

  ['a message with no id of its own', {
    threadKey: key('noid'),
    participant: { name: 'Priya Nair', slug: 'priya-nair-42', headline: null },
    messages: [{ direction: 'in', body: 'congratulations on the new role!', sentAt: '2026-09-12T12:00:00.000Z' }],
  }, (r) => r.success && r.stored === 1],

  ['a message LinkedIn only dated "2h"', {
    threadKey: key('undated'),
    participant: { name: 'Marta Kowalczyk', slug: 'marta-kowalczyk-8a1b2c', headline: 'Head of Partnerships' },
    messages: [{ externalId: `${key('undated')}-1`, direction: 'in', body: 'sent two hours ago and nowhere does it say when', sentAt: '2h' }],
  }, (r) => r.success && r.stored === 1 && r.undated === 1],

  ['a body with emoji, newlines and text that looks like markup', {
    threadKey: key('body'),
    participant: { name: 'Dmytro Herasymenko', slug: null, headline: null },
    messages: [{
      externalId: `${key('body')}-1`, direction: 'in',
      body: 'привіт 👋\nдивись <b>слайд 4</b> — там <script>alert(1)</script> цифри\n— Дмитро',
      sentAt: '2026-09-15T09:00:00.000Z',
    }],
  }, (r) => r.success && r.stored === 1],

  ['a 9 000 character body', {
    threadKey: key('long'),
    participant: { name: 'Sarah Whitfield', slug: 'sarah-whitfield-99', headline: null },
    messages: [{ externalId: `${key('long')}-1`, direction: 'in', body: `${'довга відповідь. '.repeat(600)}`, sentAt: '2026-09-02T12:00:00.000Z' }],
  }, (r) => r.success && r.stored === 1],

  // LinkedIn prints "LinkedIn Member" where a name should be, for restricted
  // and out-of-network profiles. It is sent verbatim rather than cleaned up
  // here: the portal folds it to its own sentinel and refuses to match on it,
  // and ten threads all called "LinkedIn Member" are ten different people.
  // Inventing a placeholder of our own is the one thing that would break that.
  ['a participant LinkedIn will not name', {
    threadKey: key('restricted'),
    participant: { name: 'LinkedIn Member', slug: null, headline: null },
    messages: [{ externalId: `${key('restricted')}-1`, direction: 'in', body: 'hello from behind a wall', sentAt: '2026-09-15T12:00:00.000Z' }],
  }, (r) => r.success && r.stored === 1 && r.matchedOutreachId === null],

  // The same placeholder, ragged. Two of the four places a name comes out of
  // the page keep their whitespace exactly as LinkedIn wrote it — an `alt`
  // attribute is only trimmed, and a line of `innerText` keeps the runs of
  // spaces inside it — so the tidy form is not the likely one to arrive here.
  // If the portal folded only the tidy one, this would be the ragged way back
  // into ten conversations matching one outreach row.
  ['the same placeholder with a line break in it', {
    threadKey: key('restricted-ragged'),
    participant: { name: 'LinkedIn\n      Member', slug: null, headline: null },
    messages: [{ externalId: `${key('restricted-ragged')}-1`, direction: 'in', body: 'from an alt attribute that wrapped', sentAt: '2026-09-15T12:00:00.000Z' }],
  }, (r) => r.success && r.stored === 1 && r.matchedOutreachId === null],

  ['the same placeholder with a double space and the wrong case', {
    threadKey: key('restricted-spaced'),
    participant: { name: 'linkedin  member', slug: null, headline: null },
    messages: [{ externalId: `${key('restricted-spaced')}-1`, direction: 'in', body: 'from a line of innerText', sentAt: '2026-09-15T12:30:00.000Z' }],
  }, (r) => r.success && r.stored === 1 && r.matchedOutreachId === null],

  ['a conversation that opened but could not be read', {
    threadKey: key('empty'),
    participant: { name: 'Unknown', slug: null, headline: null },
    messages: [],
  }, (r) => r.success && r.stored === 0],

  ['one bad message beside two good ones', {
    threadKey: key('mixed'),
    participant: { name: 'Tomás Ruiz', slug: 'tomas-ruiz-7', headline: null },
    messages: [
      { externalId: `${key('mixed')}-1`, direction: 'in', body: 'first', sentAt: '2026-09-14T09:00:00.000Z' },
      { externalId: `${key('mixed')}-2`, direction: 'sideways', body: 'this one is broken', sentAt: '2026-09-14T09:01:00.000Z' },
      { externalId: `${key('mixed')}-3`, direction: 'out', body: 'third', sentAt: '2026-09-14T09:02:00.000Z' },
    ],
  }, (r) => r.success && r.stored === 2 && r.invalid === 1],
];

for (const [name, payload, ok] of awkward) {
  const res = await portal.inboxThread(payload);
  check(name, ok(res), JSON.stringify({ stored: res.stored, skipped: res.skipped, invalid: res.invalid, undated: res.undated, error: res.error }));
}

// ── the mark that says somebody looked ─────────────────────────────────────
const done = await portal.inboxDone(8);
check('inbox.done is accepted', done.success === true, JSON.stringify(done));
const after = await portal.plan();
check('and the watermark moved', Boolean(after.inbox?.lastSyncedAt), after.inbox?.lastSyncedAt ?? 'null');
check('a sweep that read nothing still marks the sync', (await portal.inboxDone(0)).success === true);

// ── and the door is shut without the token ─────────────────────────────────
const stranger = new Portal(PORTAL, { token: 'not-the-token' });
stranger.accountId = found.accountId;
stranger.prefix = portal.prefix;
const refused = await stranger.inboxThread({ threadKey: key('unauthorised'), participant: { name: 'Nobody', slug: null, headline: null }, messages: [] });
check('a wrong token is refused', refused.success !== true, `HTTP ${refused.status}`);

await browser.close();
console.log(failures ? `\n${failures} перевірок не пройшло` : '\nусі перевірки пройшли');
process.exit(failures ? 1 : 0);
