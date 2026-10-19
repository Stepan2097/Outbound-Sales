import assert from 'node:assert/strict';
import test from 'node:test';
import { Portal } from './lib/portal.mjs';

// `accounts()` is the one list three callers read — the watch wants the parked
// ones, `warming()` wants only the healthy, `resolve()` wants a name. It is
// tested directly because the day it was added it shipped calling itself, and
// the symptom on the server was a stack overflow rather than a wrong answer.

const ACCOUNTS = [
  { id: 'a-1', label: 'Profile 47 - linkedin', login: null, profileRemoteId: 'r-47', status: 'warming', health: 'needs_login' },
  { id: 'a-2', label: 'Profile 48- linkedin', login: null, profileRemoteId: 'r-48', status: 'warming', health: 'ok' },
  { id: 'a-3', label: 'Idle one', login: null, profileRemoteId: 'r-9', status: 'idle', health: 'ok' }
];

function withFetch(body, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => body };
  };
  return run(calls).finally(() => { globalThis.fetch = original; });
}

test('accounts() віддає список як він є — із тими, кого розклад не роздає', async () => {
  await withFetch({ success: true, accounts: ACCOUNTS }, async (calls) => {
    const portal = new Portal('https://portal.example', { token: 'test-token' });
    const accounts = await portal.accounts();
    assert.equal(accounts.length, 3);
    assert.equal(accounts.find((a) => a.id === 'a-1').health, 'needs_login');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/api\/warmup\/agent\/accounts$/);
  });
});

test('warming() лишає тільки здорові акаунти в прогріві, resolve() знаходить за назвою', async () => {
  await withFetch({ success: true, accounts: ACCOUNTS }, async () => {
    const portal = new Portal('https://portal.example', { token: 'test-token' });
    assert.deepEqual(await portal.warming(), [{ name: 'Profile 48- linkedin', accountId: 'a-2' }]);
    const found = await portal.resolve('Profile 48- linkedin');
    assert.equal(found.accountId, 'a-2');
  });
});

test('відмова порталу — це помилка з текстом, а не порожній список', async () => {
  await withFetch({ success: false, error: 'Agent authentication failed.' }, async () => {
    const portal = new Portal('https://portal.example', { token: 'wrong' });
    await assert.rejects(() => portal.accounts(), /Agent authentication failed/);
  });
});

test('502/503 — портал саме перезапускається: запит повторюється після паузи, а не валить сесію (19.10: «Bad Gateway» у Profile 48)', async () => {
  const original = globalThis.fetch;
  const answers = [
    { ok: false, status: 502, text: async () => 'Bad Gateway' },
    { ok: false, status: 503, text: async () => 'Service Unavailable' },
    { ok: true, status: 200, text: async () => JSON.stringify({ success: true, accounts: ACCOUNTS }) }
  ];
  const waits = [];
  globalThis.fetch = async () => answers.shift();
  try {
    const portal = new Portal('https://portal.example', { token: 't', gatewayWaitsMs: [5, 10], wait: async (ms) => { waits.push(ms); } });
    assert.equal((await portal.accounts()).length, 3);
    assert.deepEqual(waits, [5, 10]);
  } finally { globalThis.fetch = original; }
});

test('портал довго лежить — після всіх пауз помилка словами, а не «Unexpected token B»', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'Bad Gateway' });
  try {
    const portal = new Portal('https://portal.example', { token: 't', gatewayWaitsMs: [1], wait: async () => {} });
    await assert.rejects(portal.accounts(), /HTTP 502: Bad Gateway/);
  } finally { globalThis.fetch = original; }
});
