/**
 * Sending a reply, against a messenger that is not LinkedIn.
 *
 *   node --test agent/outbox.test.mjs
 *
 * The portal asks for a reply and the account sends it; this is the sending. It
 * is served the way `inbox-sweep.test.mjs` serves the reader's pages — from this
 * machine, at the paths LinkedIn uses, in a real Chromium with real keys and
 * real clicks — and the page is `fixtures/thread-composer.html`, whose send
 * button can be made to do the thing under test: show the message, swallow it,
 * never come alive, or sit beside a second composer.
 *
 * The part that matters is what is NOT sent. A message is the one thing here that
 * cannot be taken back, so most of this file is the cases where the right
 * answer is to type nothing, or to say plainly that it is not known to have gone.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendReplies, markComposer, flatText, chunkLine } from './lib/outbox.mjs';
import { VisitStopped } from './lib/connections.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'thread-composer.html'), 'utf8');
const PROFILE = fs.readFileSync(path.join(here, 'fixtures', 'profile-message.html'), 'utf8');
const SELF = { slug: null, name: 'Mary Lindsay' };
const MARTA = '2-ZjE4ZmQ1NzQtYjE1NC00ZjQ4LThm';
const TEXT = 'Дякую, Марто!\nПерший рядок — з «лапками» і <тегом> & амперсандом.\n\nНадішлю модель у понеділок 😊';

let browser = null;
let page = null;
let server = null;
let origin = null;
let hits = [];

// What the fake messenger does at the moment: the mode of the button, and what
// the conversation already ends with.
let mode = 'ok';
let lastOurs = '';

before(async () => {
  if (!fs.existsSync(CHROME)) return;
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ headless: true, executablePath: CHROME }).catch(() => null);
  if (!browser) return;
  page = await browser.newPage();

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.push(url.pathname);
    let body = null;
    if (url.pathname === '/in/gone-person/') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<title>404</title>'); return; }
    if (/^\/in\/[^/]+\/?$/.test(url.pathname)) {
      body = PROFILE
        .replace(/\/\*MODE\*\/.*?\/\*END\*\//, JSON.stringify(mode))
        .replace(/\/\*LAST_OURS\*\/.*?\/\*END\*\//, JSON.stringify(lastOurs));
    } else if (/\/messaging\/thread\//.test(url.pathname)) {
      body = FIXTURE
        .replace(/\/\*MODE\*\/.*?\/\*END\*\//, JSON.stringify(mode === 'plain' ? 'ok' : mode))
        .replace(/\/\*LAST_OURS\*\/.*?\/\*END\*\//, JSON.stringify(lastOurs));
      // A messenger whose class names were all changed: the structure is what is left.
      if (mode === 'plain') body = body.replaceAll('msg-form', 'x-form');
    }
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

/** A portal that says what it is told to, and remembers the order it was asked in. */
function stubPortal({ prepare = () => ({ success: true, allowed: true, stopAll: false }), sentAnswer = { success: true } } = {}) {
  const calls = [];
  return {
    calls,
    async outboxPrepare(id) {
      calls.push(['prepare', id]);
      const answer = prepare(id);
      return answer.allowed && !answer.reply
        ? { ...answer, reply: { id, threadKey: MARTA, text: this.texts?.[id] ?? TEXT } }
        : answer;
    },
    async outboxSent(id) { calls.push(['sent', id]); return sentAnswer; },
    async outboxFailed(id, reason) { calls.push(['failed', id, reason]); return { success: true }; },
    async inboxThread(payload) { calls.push(['thread', payload]); return { success: true, stored: 1 }; },
    async log() { return { success: true }; },
  };
}

const item = (id = 'r-1') => ({ id, threadKey: MARTA, text: TEXT, name: 'Marta Kowalczyk' });
const send = (portal, items = [item()], extra = {}) => sendReplies(page, {
  portal, items, self: SELF, origin, pace: 0.02, confirmMs: 2500, retryWait: async () => {}, ...extra,
});
const sends = () => page.evaluate(() => window.__sends ?? 0);
const field = () => page.evaluate(() => [...document.querySelectorAll('[contenteditable]')].map((el) => el.innerText).join('|'));
const names = (portal) => portal.calls.map(([name]) => name);

describe('sending a reply', () => {
  test('types it as written, sends it, sees it in the conversation, and only then says so', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = ''; hits = [];
    const portal = stubPortal();
    const result = await send(portal);

    assert.deepEqual({ sent: result.sent, failed: result.failed, skipped: result.skipped }, { sent: 1, failed: 0, skipped: 0 });
    assert.deepEqual(names(portal), ['prepare', 'sent', 'thread'], 'спитав → надіслав → повідомив → перечитав розмову');
    assert.equal(await sends(), 1, 'кнопку натиснуто рівно раз');
    assert.equal(await field(), '', 'поле порожнє');

    // The message on the page is exactly what was written, line breaks and all —
    // and what the portal is then told about the conversation has it as ours.
    const stored = portal.calls.find(([name]) => name === 'thread')[1];
    const mine = stored.messages.filter((message) => message.direction === 'out').at(-1);
    assert.equal(flatText(mine.body), flatText(TEXT));
    assert.equal(stored.threadKey, MARTA);
    assert.match(hits.join(' '), new RegExp(`/messaging/thread/${MARTA}/`), 'розмову відкрито за адресою');
  });

  test('звітує «надіслано» лише після того, як повідомлення з’явилось, а не після кліку', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = '';
    const portal = stubPortal();
    const original = portal.outboxSent.bind(portal);
    let onPageWhenReported = null;
    portal.outboxSent = async (id) => {
      onPageWhenReported = await page.evaluate(() => document.querySelectorAll('.msg-s-message-list__event').length);
      return original(id);
    };
    const before = 8; // дві дати, п'ять повідомлень і вкладення в фікстурі
    await send(portal);
    assert.ok(onPageWhenReported > before - 3, 'на сторінці вже було повідомлення');
    assert.equal(await page.evaluate(() => document.querySelector('.msg-s-message-list-content').lastElementChild.innerText.includes('Дякую, Марто!')), true);
  });

  test('якщо портал уже не дозволяє (скасовано) — нічого не відкривається і не набирається', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = ''; hits = [];
    const portal = stubPortal({ prepare: () => ({ success: true, allowed: false, reason: 'cancelled', stopAll: false, reply: null }) });
    const result = await send(portal);
    assert.equal(result.skipped, 1);
    assert.equal(result.sent, 0);
    assert.deepEqual(names(portal), ['prepare']);
    assert.deepEqual(hits.filter((hit) => /thread/.test(hit)), [], 'розмову навіть не відкривали');
  });

  test('«зупинись» від порталу (пауза, попередження) — зупиняє візит, нічого не набираючи', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = ''; hits = [];
    const portal = stubPortal({ prepare: () => ({ success: true, allowed: false, stopAll: true, reply: null }) });
    await assert.rejects(() => send(portal), VisitStopped);
    assert.deepEqual(hits.filter((hit) => /thread/.test(hit)), []);
  });

  test('вичерпаний денний ліміт обриває решту, а не лише цю', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = '';
    const portal = stubPortal({ prepare: () => ({ success: true, allowed: false, reason: 'limit', stopAll: false, reply: null }) });
    const result = await send(portal, [item('r-1'), item('r-2'), item('r-3')]);
    assert.equal(result.skipped, 1);
    assert.deepEqual(names(portal), ['prepare'], 'про другу й третю вже не питав');
  });

  test('кілька відповідей — по одній, у порядку плану, кожна із запитом перед набором', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = '';
    const portal = stubPortal();
    portal.texts = { 'r-1': 'Перша відповідь', 'r-2': 'Друга відповідь' };
    const result = await send(portal, [item('r-1'), item('r-2')]);
    assert.equal(result.sent, 2);
    assert.deepEqual(names(portal).filter((name) => name !== 'thread'), ['prepare', 'sent', 'prepare', 'sent']);
  });

  test('на сторінці без знайомих класів поле й кнопку знаходить за будовою', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'plain'; lastOurs = '';
    const portal = stubPortal();
    const result = await send(portal);
    assert.equal(result.sent, 1, 'повідомлення пішло');
    assert.equal(await sends(), 1);
  });
});

describe('what is not sent', () => {
  test('кнопку натиснуто, але повідомлення в розмові немає: це «невідомо», а не «надіслано»', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'silent'; lastOurs = '';
    const portal = stubPortal();
    const result = await send(portal);
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(names(portal), ['prepare', 'failed'], '«надіслано» не сказано');
    const reason = portal.calls.find(([name]) => name === 'failed')[2];
    assert.match(reason, /невідомо, чи пішло/);
    assert.match(reason, /не надсилайте вдруге/);
    assert.equal(await sends(), 1, 'і вдруге кнопку не тиснули');
  });

  test('кнопка не ожила — нічого не надіслано, а поле очищене, щоб чернетка не лишилась у справжньому месенджері', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'dead'; lastOurs = '';
    const portal = stubPortal();
    const result = await send(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /не стала активною/);
    assert.equal(await sends(), 0);
    assert.equal((await field()).trim(), '', 'у полі нічого не лишилось');
  });

  test('два поля на сторінці — не вгадує, у яке писати', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'two'; lastOurs = '';
    const portal = stubPortal();
    const result = await send(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /2 полів/);
    assert.equal(await sends(), 0);
    assert.equal(await field(), '|', 'жодне з полів нічого не отримало');
  });

  test('курсор у поле не став — нічого не набирає (клавіші пішли б у що завгодно)', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'nofocus'; lastOurs = '';
    const portal = stubPortal();
    const result = await send(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /поставити курсор/);
    assert.equal((await field()).trim(), '', 'нічого не набрано');
    assert.equal(await sends(), 0);
  });

  test('у полі після набору не те, що написано — не надсилає, показує, що там було, і очищає поле', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'trunc'; lastOurs = '';
    const portal = stubPortal();
    const result = await send(portal);
    assert.equal(result.failed, 1);
    const reason = portal.calls.find(([name]) => name === 'failed')[2];
    assert.match(reason, /не те, що написано/);
    assert.match(reason, /є: «Дякую, Марто!/, 'видно, що саме опинилось у полі');
    assert.equal(await sends(), 0);
    assert.equal((await field()).trim(), '');
    assert.equal(names(portal).includes('sent'), false);
  });

  test('поля нема зовсім — каже про це', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'none'; lastOurs = '';
    const portal = stubPortal();
    const result = await send(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /не знайшов поле/);
  });

  test('якщо розмова вже закінчується тими самими словами від нас — вдруге не набирає', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ours'; lastOurs = TEXT;
    const portal = stubPortal();
    const result = await send(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /вдруге не надсилав/);
    assert.equal(await sends(), 0, 'нічого не набрано й не натиснуто');
    assert.equal(names(portal).includes('sent'), false);
  });

  test('такі самі слова не від нас (від них) не заважають', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = '';
    const portal = stubPortal();
    portal.texts = { 'r-1': 'Happy to chat next week' };
    const result = await send(portal);
    assert.equal(result.sent, 1);
  });

  test('надіслано, а сказати порталу не вдалось — візит зупиняється, щоб завтра не надіслати знову', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = '';
    const portal = stubPortal({ sentAnswer: { success: false, status: 500, error: 'HTTP 500' } });
    await assert.rejects(() => send(portal), VisitStopped);
    assert.equal(portal.calls.filter(([name]) => name === 'sent').length, 3, 'спробував тричі');
    assert.equal(await sends(), 1, 'але повідомлення за цей час було одне');
  });

  test('портал відмовив «надіслано» як «ні» (4xx) — не повторює й теж зупиняє візит', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = '';
    const portal = stubPortal({ sentAnswer: { success: false, status: 404, error: 'Такої відповіді немає.' } });
    await assert.rejects(() => send(portal), /Reply report refused/);
    assert.equal(portal.calls.filter(([name]) => name === 'sent').length, 1);
  });
});

describe('the composer finder', () => {
  test('exactly one composer is marked, with its button; none or two is a refusal', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    await page.setContent('<form class="msg-form"><div class="msg-form__contenteditable" contenteditable="true" role="textbox"></div><button type="submit">Send</button></form>');
    assert.deepEqual(await page.evaluate(markComposer), { ok: true, how: 'class hint', hasSend: true });
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-outbound-composer]').length), 1);

    await page.setContent('<form><div contenteditable="true" role="textbox"></div><button aria-label="Надіслати"></button></form>');
    assert.deepEqual(await page.evaluate(markComposer), { ok: true, how: 'structure', hasSend: true });

    await page.setContent('<form><div contenteditable="true" role="textbox"></div></form><form><div contenteditable="true" role="textbox"></div></form>');
    const two = await page.evaluate(markComposer);
    assert.equal(two.ok, false);
    assert.equal(two.count, 2);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-outbound-composer]').length), 0, 'нічого не позначено');

    // A search box that happens to be contenteditable, outside any form, is not a composer.
    await page.setContent('<div contenteditable="true" role="textbox"></div>');
    assert.equal((await page.evaluate(markComposer)).count, 0);

    await page.setContent('<form><div contenteditable="true" role="textbox"></div></form>');
    assert.equal((await page.evaluate(markComposer)).hasSend, false, 'без кнопки це видно');
  });
});

describe('typing in runs', () => {
  test('жоден відрізок не розрізає емодзі навпіл, а разом вони дають той самий рядок', () => {
    const lines = [
      `${'а'.repeat(13)}😊${'б'.repeat(40)}😊😊🎉${'в'.repeat(7)}`,
      '👍'.repeat(100),
      'Привіт, Марто! 👋 Надішлю модель у понеділок 😊 — гарного дня 🌞',
      'e\u0301 ' + 'ç'.repeat(30),
    ];
    for (const line of lines) {
      for (let take = 1; take <= 50; take += 1) {
        const chunks = chunkLine(line, () => take);
        assert.equal(chunks.join(''), line, `розмір ${take}`);
        for (const chunk of chunks) {
          assert.equal(/[\uD800-\uDBFF]$/.test(chunk), false, `відрізок закінчується половиною емодзі (розмір ${take})`);
          assert.equal(/^[\uDC00-\uDFFF]/.test(chunk), false, `відрізок починається з половини емодзі (розмір ${take})`);
        }
      }
    }
    assert.deepEqual(chunkLine(''), []);
  });
});

describe('the first message, from the profile', () => {
  const firstItem = (id = 'f-1', slug = 'person-one') => ({
    id, kind: 'first', threadKey: `first:o-${id}`, text: 'Hi Person, thanks for connecting!', name: 'Person One',
    linkedin: `https://www.linkedin.com/in/${slug}/`,
  });
  const firstPortal = (slug = 'person-one') => {
    const portal = stubPortal();
    portal.outboxPrepare = async (id) => {
      portal.calls.push(['prepare', id]);
      return { success: true, allowed: true, stopAll: false,
        reply: { id, kind: 'first', threadKey: `first:o-${id}`, text: 'Hi Person, thanks for connecting!', name: 'Person One',
          linkedin: `https://www.linkedin.com/in/${slug}/` } };
    };
    return portal;
  };
  const sendFirst = (portal, items = [firstItem()]) => sendReplies(page, {
    portal, items, self: SELF, origin, pace: 0.02, confirmMs: 2500, retryWait: async () => {},
  });
  const overlayWho = () => page.evaluate(() => [...document.querySelectorAll('.msg-overlay-conversation-bubble header a')].map((a) => a.textContent));

  test('відкриває профіль, тисне «Повідомлення» у шапці, пише й надсилає — і лише тоді звітує', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = ''; hits = [];
    const portal = firstPortal();
    const result = await sendFirst(portal);
    assert.equal(result.sent, 1);
    assert.deepEqual(names(portal), ['prepare', 'sent'], 'перше повідомлення не перечитується як розмова — ключа ще нема');
    assert.ok(hits.includes('/in/person-one/'), 'відкрито профіль цієї людини');
    assert.deepEqual(await overlayWho(), ['person-one'], 'розмова саме з нею, а не з кимось у «також переглядали»');
    assert.equal(await sends(), 1);
    assert.match(await page.evaluate(() => document.querySelector('.msg-s-message-list-content').innerText), /thanks for connecting/);
  });

  test('не в контактах (2-й ступінь) — нічого не відкриває й не пише: це був би InMail', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'second'; lastOurs = '';
    const portal = firstPortal();
    const result = await sendFirst(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /1-й ступінь/);
    assert.equal(await sends(), 0);
    assert.deepEqual(await overlayWho(), []);
  });

  test('у шапці немає «Повідомлення» — не тисне чужу кнопку з бічної колонки', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'nobutton'; lastOurs = '';
    const portal = firstPortal();
    const result = await sendFirst(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /немає кнопки «Повідомлення»/);
    assert.deepEqual(await overlayWho(), [], 'розмову ні з ким не відкрито');
  });

  test('уже відкрита інша розмова поруч — два поля, не вгадує', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'two'; lastOurs = '';
    const portal = firstPortal();
    const result = await sendFirst(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /2 полів/);
    assert.equal(await sends(), 0);
  });

  test('розмова вже закінчується тими самими словами від нас — вдруге не пише', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ours'; lastOurs = 'Hi Person, thanks for connecting!';
    const portal = firstPortal();
    const result = await sendFirst(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /вдруге не надсилав/);
    assert.equal(await sends(), 0);
  });

  test('натиснув, а повідомлення не з’явилось — «невідомо», а не «надіслано»', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'silent'; lastOurs = '';
    const portal = firstPortal();
    const result = await sendFirst(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /невідомо, чи пішло/);
    assert.equal(names(portal).includes('sent'), false);
  });

  test('натиснув «Повідомлення», а розмова не відкрилась — каже це й нічого не набирає', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'dead'; lastOurs = '';
    const portal = firstPortal();
    const result = await sendFirst(portal);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /розмова не відкрилась/);
    assert.equal(await sends(), 0);
  });

  test('профілю більше немає — каже це', async (t) => {
    if (!page) return t.skip('Chrome не знайдено');
    mode = 'ok'; lastOurs = '';
    const portal = firstPortal('gone-person');
    const result = await sendFirst(portal, [firstItem('f-9', 'gone-person')]);
    assert.equal(result.failed, 1);
    assert.match(portal.calls.find(([name]) => name === 'failed')[2], /профілю більше немає/);
  });
});
