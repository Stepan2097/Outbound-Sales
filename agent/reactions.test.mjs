/**
 * The reaction button, in the languages an account's LinkedIn speaks.
 *
 *   node --test agent/reactions.test.mjs
 *
 * 11.10.2026: Profile 48's LinkedIn turned Ukrainian, the English-only
 * selector matched nothing, and two days of likes came back 0/2 without an
 * error. The labels below are the ones read off the live feed that day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REACTION_BUTTON, UNREACTED_BUTTON, isUnreacted } from './lib/reactions.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FEED = `
  <button aria-label="Стан кнопки реакції: реакція відсутня">Подобається</button>
  <button aria-label="Відкрити меню реакцій">⌄</button>
  <button aria-label="Стан кнопки реакції: Подобається">Подобається</button>
  <button aria-label="Reaction button state: no reaction">Like</button>
  <button aria-label="Reaction button state: Like">Like</button>`;

test('«no reaction» is read in English and in Ukrainian, and a placed like is not', () => {
  assert.equal(isUnreacted('Reaction button state: no reaction'), true);
  assert.equal(isUnreacted('Стан кнопки реакції: реакція відсутня'), true);
  assert.equal(isUnreacted('Стан кнопки реакції: Подобається'), false);
  assert.equal(isUnreacted('Reaction button state: Like'), false);
  assert.equal(isUnreacted(null), false);
});

test('the selectors find the unliked buttons on a feed in either language, and nothing else', async (t) => {
  if (!fs.existsSync(CHROME)) return t.skip('Chrome не знайдено');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(FEED);
  const labels = (selector) => page.$$eval(selector, (buttons) => buttons.map((b) => b.getAttribute('aria-label')));
  assert.deepEqual(await labels(UNREACTED_BUTTON), ['Стан кнопки реакції: реакція відсутня', 'Reaction button state: no reaction']);
  assert.equal((await labels(REACTION_BUTTON)).length, 4, 'the menu opener is not a reaction button');
});

test('no step spells the reaction button out in one language again', () => {
  for (const file of ['run-account.mjs', 'lib/login-probe.mjs']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /aria-label\^="Reaction button state"|no reaction"\]/, `${file} has its own copy of the selector`);
  }
});
