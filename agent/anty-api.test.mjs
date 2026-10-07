import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntyApi } from './lib/anty-api.mjs';

function harness({ profile = {}, start = {}, connectError = false } = {}) {
  const calls = [];
  const context = {};
  const api = new AntyApi('http://127.0.0.1:3032', { fetchImpl: async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    const payload = opts.method === 'GET'
      ? { profile: { id: 47, remote_id: 'cloud-id', name: 'Fixture', hasProxy: true, running: false, ...profile } }
      : url.endsWith('/start') ? { protocol: 'cdp', wsEndpoint: 'ws://127.0.0.1:34123/devtools/browser/abc-123', ...start } : {};
    return { ok: true, json: async () => ({ ok: true, ...payload }) };
  } });
  const chromium = { connectOverCDP: async url => {
    calls.push({ connect: url });
    if (connectError) throw new Error('connect failed');
    return { contexts: () => [context], close: async () => calls.push({ disconnected: true }) };
  } };
  return { api, chromium, calls, context };
}

test('requires private loopback HTTP configuration', () => {
  for (const url of ['http://example.org:3032', 'https://127.0.0.1', 'http://u:p@127.0.0.1', 'http://127.0.0.1/api']) {
    assert.throws(() => new AntyApi(url), /loopback/);
  }
});

test('uses cloud id, existing context and flushes through runtime before disconnect', async () => {
  const h = harness();
  const session = await h.api.open('cloud-id', h.chromium);
  assert.equal(session.context, h.context);
  assert.equal(session.profile.managedByAnty, true);
  await Promise.all([session.close(), session.close()]);
  assert.ok(h.calls[0].url.endsWith('/by-remote/cloud-id'));
  assert.equal(h.calls[1].body.requireProxy, true);
  const stops = h.calls.filter(call => call.url?.endsWith('/stop'));
  assert.equal(stops.length, 1);
  assert.equal(stops[0].body.ownerToken, h.calls[1].body.ownerToken);
  assert.ok(h.calls.at(-1).disconnected);
});

test('does not start or stop foreign, busy or unproxied profiles', async () => {
  for (const profile of [{ remote_id: 'wrong' }, { running: true }, { hasProxy: false }, { id: -1 }]) {
    const h = harness({ profile });
    await assert.rejects(h.api.open('cloud-id', h.chromium));
    assert.equal(h.calls.length, 1);
  }
});

test('failed connection cleans only the browser owned by this visit', async () => {
  const h = harness({ connectError: true });
  await assert.rejects(h.api.open('cloud-id', h.chromium), /connect failed/);
  assert.equal(h.calls.at(-1).body.ownerToken, h.calls[1].body.ownerToken);
  assert.ok(h.calls.at(-1).url.endsWith('/stop'));
});

test('rejects foreign or incompatible browser endpoint before connecting', async () => {
  for (const start of [{ protocol: 'playwright' }, { wsEndpoint: 'ws://example.org/devtools/browser/abc' }]) {
    const h = harness({ start });
    await assert.rejects(h.api.open('cloud-id', h.chromium), /private CDP/);
    assert.equal(h.calls.some(call => call.connect), false);
  }
});
