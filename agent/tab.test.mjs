/**
 * One tab per stage of a visit, and its memory in the log.
 *
 *   node --test agent/tab.test.mjs
 *
 * 08.10–11.10.2026: one LinkedIn tab, kept from the first page of a visit to
 * the last, grew to 3.6 GB and the kernel killed Chromium in the Anty
 * container (4 GB). These prove the tab is replaced — never by closing the
 * last one first — and that the size it reached is read and said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeMemory, freshTab, oneTab, tabMemory } from './lib/tab.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function chrome(t) {
  if (!fs.existsSync(CHROME)) { t.skip('Chrome не знайдено'); return null; }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  t.after(() => browser.close());
  return browser.newContext();
}

test('a fresh tab replaces every other one, and the context never stands without a tab', async (t) => {
  const context = await chrome(t);
  if (!context) return;
  const old = await context.newPage();
  await old.setContent('<p>the feed, eight profiles and the likes</p>');
  const leftover = await context.newPage();
  let empty = false;
  old.on('close', () => { if (context.pages().length === 0) empty = true; });

  const page = await freshTab(context);
  assert.deepEqual(context.pages(), [page]);
  assert.equal(old.isClosed() && leftover.isClosed(), true);
  assert.equal(empty, false, 'the new tab was open before the old one closed');
});

test('a profile that restores several tabs keeps only the first', async (t) => {
  const context = await chrome(t);
  if (!context) return;
  const first = await context.newPage();
  await context.newPage();
  await context.newPage();
  assert.equal(await oneTab(context), first);
  assert.equal(context.pages().length, 1);
});

test('the tab says how big it is, and the log line reads it', async (t) => {
  const context = await chrome(t);
  if (!context) return;
  const page = await context.newPage();
  await page.setContent(`<ul>${'<li>row</li>'.repeat(2000)}</ul>`);
  await page.evaluate(() => { window.kept = Array.from({ length: 200_000 }, (_, i) => ({ i, text: `item ${i}` })); });
  const memory = await tabMemory(page);
  assert.ok(memory.heapMb > 1, JSON.stringify(memory));
  assert.ok(memory.nodes > 2000, JSON.stringify(memory));
  assert.match(describeMemory(memory), /МБ JS .* вузлів DOM/);
  assert.equal(describeMemory(null), 'пам\'ять вкладки невідома');
});

test('a visit takes a fresh tab before the likes, the invitations and the inbox, and logs the last one', () => {
  const source = fs.readFileSync(new URL('run-account.mjs', import.meta.url), 'utf8');
  assert.match(source, /page = await oneTab\(context\)/);
  const at = (needle) => {
    const index = source.indexOf(needle);
    assert.ok(index > 0, `немає: ${needle}`);
    return index;
  };
  assert.ok(at("recycle('лайки')") < at('// ── likes'));
  assert.ok(at("recycle('запрошення')") < at('await sendQueuedInvitations('));
  assert.ok(at("recycle('вхідні')") < at('report.inbox = await syncInbox('));
  assert.ok(at("shot(page, '6-final')") < at("stage: 'кінець'"));
});
