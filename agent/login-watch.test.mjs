import assert from 'node:assert/strict';
import test from 'node:test';
import { answerAsks, BUTTON_TEXT, checkParked, normalizeState, RECHECK_MS } from './lib/login-watch.mjs';
import { Telegram } from './lib/telegram.mjs';

// The watch is about two promises to a person: you will be told when a login
// dies, and you will not be nagged about it. Both are checked here against
// fakes — no browser, no network, no Telegram.
//
// And one promise to everybody else who shares the bot: this never reads the
// bot's updates. On 08.10.2026 it did, for a callback button, and swallowed
// the owner's replies to another chat on the same bot. The last test here is
// the fence around that.

const parked = { id: 'acc-47', label: 'Profile 47 - linkedin', health: 'needs_login', status: 'warming', profileRemoteId: 'remote-47', loginCheckPath: '/api/warmup/login-check?t=signed' };
const healthy = { id: 'acc-48', label: 'Profile 48- linkedin', health: 'ok', status: 'warming', profileRemoteId: 'remote-48' };
const PORTAL = 'https://outbound.example';

function fakePortal(accounts, { checks = [] } = {}) {
  return {
    accountId: null,
    written: [],
    verdicts: [],
    async accounts() { return accounts.map((account) => ({ ...account })); },
    async loginChecks() { return checks.map((check) => ({ ...check })); },
    async loginRecheck(nonce, signedIn, reason) {
      this.verdicts.push({ accountId: this.accountId, nonce, signedIn, reason });
      return { success: true };
    },
    async health(health, note) {
      this.written.push({ accountId: this.accountId, health, note });
      return { success: true };
    }
  };
}

function fakeTelegram({ configured = true } = {}) {
  return {
    configured,
    sent: [],
    async send(text, button = null) {
      if (button && !button.url) throw new Error('кнопка без url — це callback, якого тут не має бути');
      this.sent.push({ text, button });
    }
  };
}

const signedOut = async () => ({ signedIn: false, reason: 'сторінка входу' });
const signedIn = async () => ({ signedIn: true, reason: 'feed' });
const AT = Date.parse('2026-10-08T09:00:00Z');

test('розлогінений акаунт отримує одне повідомлення на день, із кнопкою-посиланням', async () => {
  const portal = fakePortal([parked, healthy]);
  const telegram = fakeTelegram();
  const state = normalizeState(null);

  const first = await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08', nowMs: AT, portalUrl: PORTAL });
  assert.deepEqual(first, { parked: 1, checked: 1, restored: 0, announced: 1 });
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /Profile 47/);
  assert.match(telegram.sent[0].text, /вийшов із LinkedIn/);
  assert.match(telegram.sent[0].text, /кожні 30 хвилин/);
  // Кнопка лише відкриває сторінку: callback_data тут не буває.
  assert.deepEqual(telegram.sent[0].button, { text: BUTTON_TEXT, url: `${PORTAL}/api/warmup/login-check?t=signed` });
  // Акаунт, у якого все добре, не чіпаємо взагалі.
  assert.equal(portal.written.length, 0);
});

test('перевірка повторюється щопівгодини, а повідомлення — ні', async () => {
  const portal = fakePortal([parked]);
  const telegram = fakeTelegram();
  const state = normalizeState(null);

  await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08', nowMs: AT, portalUrl: PORTAL });

  // Через десять хвилин ще рано навіть дивитись.
  const tooSoon = await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08', nowMs: AT + 10 * 60_000, portalUrl: PORTAL });
  assert.deepEqual(tooSoon, { parked: 1, checked: 0, restored: 0, announced: 0 });

  // Через півгодини дивимось знову — але в групу вже не пишемо того ж дня.
  const again = await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08', nowMs: AT + RECHECK_MS, portalUrl: PORTAL });
  assert.deepEqual(again, { parked: 1, checked: 1, restored: 0, announced: 0 });
  assert.equal(telegram.sent.length, 1, 'одне повідомлення за день');

  // Наступного дня — знову одне: одне повідомлення у вівторок ніхто не чинить.
  await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-09', nowMs: AT + 25 * 3600_000, portalUrl: PORTAL });
  assert.equal(telegram.sent.length, 2);
});

test('акаунт, який залогінили руками, повертається сам — і про це кажуть поза чергою', async () => {
  const portal = fakePortal([parked]);
  const telegram = fakeTelegram();
  const state = normalizeState(null);

  // Спершу розлогінений: сьогодні вже сказали.
  await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08', nowMs: AT, portalUrl: PORTAL });
  assert.equal(telegram.sent.length, 1);

  // Людина залогінилась; через півгодини перевірка це бачить.
  const back = await checkParked({ portal, telegram, probe: signedIn, state, today: '2026-10-08', nowMs: AT + RECHECK_MS, portalUrl: PORTAL });
  assert.deepEqual(back, { parked: 1, checked: 1, restored: 1, announced: 0 });
  assert.deepEqual(portal.written, [{ accountId: 'acc-47', health: 'ok', note: 'Вхід підтверджено щоденною перевіркою.' }]);
  assert.equal(telegram.sent.length, 2, 'про відновлення кажуть, попри денний ліміт');
  assert.match(telegram.sent[1].text, /вхід відновлено/i);
  assert.equal(telegram.sent[1].button, null);
  // І сліду про нього в стані не лишилось — більше не нагадуємо.
  assert.deepEqual(state.lastCheck, {});
  assert.deepEqual(state.lastTold, {});
});

test('без налаштованого бота вартовий усе одно знімає з паузи те, що відновилось', async () => {
  const portal = fakePortal([parked]);
  const telegram = fakeTelegram({ configured: false });
  const state = normalizeState(null);

  const result = await checkParked({ portal, telegram, probe: signedIn, state, today: '2026-10-08', nowMs: AT, portalUrl: PORTAL });
  assert.deepEqual(result, { parked: 1, checked: 1, restored: 1, announced: 0 });
  assert.deepEqual(portal.written, [{ accountId: 'acc-47', health: 'ok', note: 'Вхід підтверджено щоденною перевіркою.' }]);
  assert.equal(telegram.sent.length, 0);
});

test('перевірка, що впала, не купує акаунту півгодини тиші', async () => {
  const portal = fakePortal([parked]);
  const telegram = fakeTelegram();
  const state = normalizeState(null);
  const broken = async () => { throw new Error('рантайм не відповів'); };

  const failed = await checkParked({ portal, telegram, probe: broken, state, today: '2026-10-08', nowMs: AT, portalUrl: PORTAL });
  assert.deepEqual(failed, { parked: 1, checked: 0, restored: 0, announced: 0 });
  assert.deepEqual(state.lastCheck, {});

  const ok = await checkParked({ portal, telegram, probe: signedOut, state, today: '2026-10-08', nowMs: AT + 1000, portalUrl: PORTAL });
  assert.equal(ok.checked, 1);
  assert.equal(telegram.sent.length, 1);
});

test('стан від старої версії не ламає вартового: день у lastCheck і offset просто відкидаються', () => {
  assert.deepEqual(normalizeState(null), { lastCheck: {}, lastTold: {} });
  assert.deepEqual(normalizeState({ offset: 12, lastCheck: { 'acc-47': '2026-10-08' } }), { lastCheck: {}, lastTold: {} });
  assert.deepEqual(normalizeState({ lastCheck: { a: AT }, lastTold: { a: '2026-10-08' } }), { lastCheck: { a: AT }, lastTold: { a: '2026-10-08' } });
});


// ── посилання з групи ──────────────────────────────────────────────────────
//
// Кнопка веде на наш же ендпоінт, він записує запит, а відповідає на нього
// вартовий — бо браузер є лише в нього. Людина при цьому тримає телефон із
// сторінкою, яка обновлюється, тож кожен запит мусить отримати вердикт.

test('запит із групи перевіряється одразу, і вердикт повертається порталу', async () => {
  const portal = fakePortal([parked], { checks: [{ nonce: 'n1', accountId: 'acc-47', requestedAt: '2026-10-08T09:00:00Z' }] });
  const telegram = fakeTelegram();

  const result = await answerAsks({ portal, telegram, probe: signedIn });
  assert.deepEqual(result, { asks: 1, restored: 1 });
  assert.deepEqual(portal.written, [{ accountId: 'acc-47', health: 'ok', note: 'Вхід підтверджено за посиланням із групи.' }]);
  assert.deepEqual(portal.verdicts, [{ accountId: 'acc-47', nonce: 'n1', signedIn: true, reason: 'feed' }]);
  assert.match(telegram.sent[0].text, /вхід відновлено/i);
});

test('натиснули, а входу немає: вердикт усе одно повертається, з паузи нічого не знімається', async () => {
  const portal = fakePortal([parked], { checks: [{ nonce: 'n2', accountId: 'acc-47' }] });
  const telegram = fakeTelegram();

  const result = await answerAsks({ portal, telegram, probe: signedOut });
  assert.deepEqual(result, { asks: 1, restored: 0 });
  assert.equal(portal.written.length, 0, 'мертву сесію в ротацію не повертаємо');
  assert.deepEqual(portal.verdicts, [{ accountId: 'acc-47', nonce: 'n2', signedIn: false, reason: 'сторінка входу' }]);
  assert.match(telegram.sent[0].text, /входу ще не видно/i);
});

test('профіль, який не відкрився, теж отримує вердикт — із причиною, а не тишею', async () => {
  const portal = fakePortal([parked], { checks: [{ nonce: 'n3', accountId: 'acc-47' }] });
  const telegram = fakeTelegram();
  const broken = async () => { throw new Error('рантайм не відповів'); };

  await answerAsks({ portal, telegram, probe: broken });
  assert.equal(portal.verdicts.length, 1);
  assert.equal(portal.verdicts[0].signedIn, false);
  assert.match(portal.verdicts[0].reason, /рантайм не відповів/);
});

test('запит на акаунт, якого вже немає, закривається, а не висить вічно', async () => {
  const portal = fakePortal([healthy], { checks: [{ nonce: 'n4', accountId: 'acc-зник' }] });
  const telegram = fakeTelegram();

  await answerAsks({ portal, telegram, probe: signedIn });
  assert.deepEqual(portal.verdicts, [{ accountId: 'acc-зник', nonce: 'n4', signedIn: false, reason: 'акаунта вже немає в прогріві' }]);
  assert.equal(telegram.sent.length, 0);
});

test('портал, який не відповів про запити, не ламає коло перевірок', async () => {
  const portal = fakePortal([parked]);
  portal.loginChecks = async () => { throw new Error('портал не відповів'); };
  const telegram = fakeTelegram();
  const lines = [];
  const result = await answerAsks({ portal, telegram, probe: signedIn, log: (line) => lines.push(line) });
  assert.deepEqual(result, { asks: 0, restored: 0 });
  assert.match(lines.join(' '), /не зміг прочитати запити/);
});

test('клієнт Telegram уміє лише надсилати: читати оновлення бота нічим', () => {
  const telegram = new Telegram({ token: 'x', chatId: '-1' });
  // Поллінг прибраний назовсім, а не просто не викликається.
  assert.equal(typeof telegram.callbacks, 'undefined', 'getUpdates більше нема чим покликати');
  assert.equal(typeof telegram.answer, 'undefined', 'answerCallbackQuery теж');
  assert.equal(typeof telegram.send, 'function');
  // І кнопка з callback_data не пройде навіть як параметр.
  assert.throws(() => telegram.send('текст', { text: 'кнопка', data: 'warmup:login:acc-47' }), /callback/i);
});
