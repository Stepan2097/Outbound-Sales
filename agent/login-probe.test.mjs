import assert from 'node:assert/strict';
import test from 'node:test';
import { settle } from './lib/login-probe.mjs';

// `settle` is the one judgement both the visit and the daily check read. It is
// tested against a page double rather than a browser: what matters is the
// order of its rules, not LinkedIn's markup.

function fakePage(steps) {
  let index = 0;
  return {
    url: () => steps[Math.min(index, steps.length - 1)].url,
    async evaluate() {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step.throws) throw new Error('navigated away');
      return step.seen;
    }
  };
}

const EMPTY = { loginForm: false, network: false, post: false, search: false, text: 0 };

test('справжнє поле пароля — це розлогінений акаунт, і без очікування', async () => {
  const page = fakePage([{ url: 'https://www.linkedin.com/login', seen: { ...EMPTY, loginForm: true } }]);
  const state = await settle(page, 5000);
  assert.equal(state.signedIn, false);
  assert.equal(state.reason, 'login form');
});

test('фід із навігацією — це вхід, навіть якщо перший погляд застав редірект', async () => {
  const page = fakePage([
    { url: 'https://www.linkedin.com/login?session_redirect=%2Ffeed%2F', seen: EMPTY },
    { url: 'https://www.linkedin.com/feed/', seen: { ...EMPTY, network: true, text: 4000 } }
  ]);
  const state = await settle(page, 9000);
  assert.equal(state.signedIn, true);
  assert.equal(state.reason, 'feed');
});

test('чекпоінт — окрема відповідь, не «розлогінений»', async () => {
  const page = fakePage([{ url: 'https://www.linkedin.com/checkpoint/challenge/', seen: EMPTY }]);
  assert.deepEqual(await settle(page, 5000), {
    signedIn: false, url: 'https://www.linkedin.com/checkpoint/challenge/', reason: 'checkpoint'
  });
});

test('просидівши все очікування на сторінці входу, кажемо саме це', async () => {
  const page = fakePage([{ url: 'https://www.linkedin.com/login/', seen: EMPTY }]);
  const state = await settle(page, 1600);
  assert.equal(state.signedIn, false);
  assert.equal(state.reason, 'сторінка входу');
});

test('сторінка, яка поїхала з-під запиту, не вважається відповіддю', async () => {
  const page = fakePage([
    { url: 'https://www.linkedin.com/feed/', throws: true },
    { url: 'https://www.linkedin.com/feed/', seen: { ...EMPTY, search: true } }
  ]);
  const state = await settle(page, 9000);
  assert.equal(state.signedIn, true);
});
