import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASK_PREFIX, BUTTON_TEXT, checkParked, handlePresses, normalizeState
} from './lib/login-watch.mjs';

// The watch is about two promises to a person: you will be told when a login
// dies, and the button will not lie to you. Both are checked here against
// fakes — no browser, no network, no Telegram.

const parked = { id: 'acc-47', label: 'Profile 47 - linkedin', health: 'needs_login', status: 'warming', profileRemoteId: 'remote-47' };
const healthy = { id: 'acc-48', label: 'Profile 48- linkedin', health: 'ok', status: 'warming', profileRemoteId: 'remote-48' };

function fakePortal(accounts) {
  return {
    accountId: null,
    written: [],
    async accounts() { return accounts.map((account) => ({ ...account })); },
    async health(health, note) {
      this.written.push({ accountId: this.accountId, health, note });
      return { success: true };
    }
  };
}

function fakeTelegram({ configured = true, presses = [] } = {}) {
  return {
    configured,
    sent: [],
    answered: [],
    askedFrom: null,
    async callbacks(offset) {
      this.askedFrom = offset;
      return { offset: offset + presses.length, presses };
    },
    async send(text, button = null) { this.sent.push({ text, button }); },
    async answer(id, text) { this.answered.push({ id, text }); }
  };
}

const signedOut = async () => ({ signedIn: false, reason: 'login form' });
const signedIn = async () => ({ signedIn: true, reason: 'feed' });

test('розлогінений акаунт отримує одне нагадування на день — із кнопкою саме на себе', async () => {
  const portal = fakePortal([parked, healthy]);
  const telegram = fakeTelegram();
  const state = normalizeState(null);

  const first = await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08' });
  assert.deepEqual(first, { parked: 1, checked: 1, restored: 0, announced: 1 });
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /Profile 47/);
  assert.match(telegram.sent[0].text, /вийшов із LinkedIn/);
  assert.deepEqual(telegram.sent[0].button, { text: BUTTON_TEXT, data: `${ASK_PREFIX}acc-47` });
  // Акаунт, у якого все добре, не чіпаємо взагалі.
  assert.equal(portal.written.length, 0);

  // Другий прохід того ж дня — тиша: нагадування щогодини це замучена група.
  const again = await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08' });
  assert.deepEqual(again, { parked: 1, checked: 0, restored: 0, announced: 0 });
  assert.equal(telegram.sent.length, 1);

  // Наступного дня — знову, бо одне повідомлення у вівторок ніхто не чинить.
  await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-09' });
  assert.equal(telegram.sent.length, 2);
});

test('акаунт, який залогінили руками, знімається з паузи сам і більше не нагадує', async () => {
  const portal = fakePortal([parked]);
  const telegram = fakeTelegram();
  const state = normalizeState(null);

  const result = await checkParked({ portal, telegram, probe: signedIn, state, today: '2026-10-08' });
  assert.deepEqual(result, { parked: 1, checked: 1, restored: 1, announced: 0 });
  assert.deepEqual(portal.written, [{ accountId: 'acc-47', health: 'ok', note: 'Вхід підтверджено щоденною перевіркою.' }]);
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /вхід відновлено/i);
  assert.equal(telegram.sent[0].button, null);
});

test('кнопка не вірить натисканню — вона перевіряє', async () => {
  const press = { id: 'cb-1', data: `${ASK_PREFIX}acc-47`, from: 'Павло' };

  // Натиснули, а входу немає: нічого не знімається з паузи, і людині так і сказано.
  const stillOut = fakePortal([parked]);
  const telegramOut = fakeTelegram({ presses: [press] });
  const stateOut = normalizeState(null);
  const refused = await handlePresses({ portal: stillOut, telegram: telegramOut, probe: signedOut, state: stateOut });
  assert.deepEqual(refused, { presses: 1, restored: 0 });
  assert.equal(stillOut.written.length, 0);
  assert.match(telegramOut.answered[0].text, /ще не видно/i);
  assert.equal(stateOut.offset, 1);

  // Натиснули, і вхід є: знімаємо з паузи рівно один раз.
  const back = fakePortal([parked]);
  const telegramIn = fakeTelegram({ presses: [press] });
  const stateIn = normalizeState(null);
  const accepted = await handlePresses({ portal: back, telegram: telegramIn, probe: signedIn, state: stateIn });
  assert.deepEqual(accepted, { presses: 1, restored: 1 });
  assert.deepEqual(back.written, [{ accountId: 'acc-47', health: 'ok', note: 'Вхід підтверджено після кнопки в групі (Павло).' }]);
  assert.match(telegramIn.answered[0].text, /прогрів продовжено/i);
});

test('натискання на акаунт, якого вже немає в прогріві, лише відповідає людині', async () => {
  const portal = fakePortal([healthy]);
  const telegram = fakeTelegram({ presses: [{ id: 'cb-2', data: `${ASK_PREFIX}acc-gone`, from: 'Марко' }] });
  const state = normalizeState(null);
  await handlePresses({ portal, telegram, probe: signedIn, state });
  assert.equal(portal.written.length, 0);
  assert.match(telegram.answered[0].text, /немає в списку/i);
});

test('без налаштованого бота вартовий усе одно знімає з паузи те, що відновилось', async () => {
  const portal = fakePortal([parked]);
  const telegram = fakeTelegram({ configured: false });
  const state = normalizeState(null);

  // Кнопок без бота не буває — і запитувати оновлення нема в кого.
  assert.deepEqual(await handlePresses({ portal, telegram, probe: signedIn, state }), { presses: 0, restored: 0 });
  assert.equal(telegram.askedFrom, null);

  const result = await checkParked({ portal, telegram, probe: signedIn, state, today: '2026-10-08' });
  assert.deepEqual(result, { parked: 1, checked: 1, restored: 1, announced: 0 });
  assert.deepEqual(portal.written, [{ accountId: 'acc-47', health: 'ok', note: 'Вхід підтверджено щоденною перевіркою.' }]);
  assert.equal(telegram.sent.length, 0);
});

test('перевірка, що впала, не купує акаунту день тиші', async () => {
  const portal = fakePortal([parked]);
  const telegram = fakeTelegram();
  const state = normalizeState(null);
  const broken = async () => { throw new Error('рантайм не відповів'); };

  const failed = await checkParked({ portal, telegram, probe: broken, state, today: '2026-10-08' });
  assert.deepEqual(failed, { parked: 1, checked: 0, restored: 0, announced: 0 });
  assert.equal(state.lastCheck['acc-47'], undefined);

  // Той самий день, робочий рантайм — нагадування таки йде.
  await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08' });
  assert.equal(telegram.sent.length, 1);
});

test('збережений стан, якому не можна вірити, не ламає вартового', () => {
  assert.deepEqual(normalizeState(null), { offset: 0, lastCheck: {} });
  assert.deepEqual(normalizeState({ offset: -5, lastCheck: { a: 'колись' } }), { offset: 0, lastCheck: {} });
  assert.deepEqual(normalizeState({ offset: 12, lastCheck: { a: '2026-10-08' } }), { offset: 12, lastCheck: { a: '2026-10-08' } });
});
