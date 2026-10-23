import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntyCloud, forBrowser, sessionCookie, withOurSession } from './lib/anty-cloud.mjs';
import { AntyApi } from './lib/anty-api.mjs';

const FUTURE = Math.floor(Date.now() / 1000) + 86_400 * 300;
const li = (value, extra = {}) => ({ name: 'li_at', value, domain: '.www.linkedin.com', path: '/', expires: FUTURE, httpOnly: true, secure: true, sameSite: 'None', ...extra });
const other = (name) => ({ name, value: 'x', domain: '.google.com', path: '/', expires: FUTURE });

function cloudRow(extra = {}) {
  return {
    remoteId: 'r1', teamId: 't1', workspaceId: 'w1', name: 'gulajpole', status: 'ready', userAgent: 'UA',
    fingerprint: { canvas: 'desk' }, proxy: { type: 'http', host: '1.2.3.4', port: 1, username: 'u', password: 'p' },
    cookies: [other('NID'), li('desk')], storageState: { cookies: [other('NID'), li('desk')], origins: [{ origin: 'https://a.com', localStorage: [] }] },
    tags: ['li'], notes: '', startPage: 'about:blank', updatedAt: '2026-10-23T10:00:00.000Z', ...extra
  };
}

function setup({ rows = [cloudRow()], state = {}, refresh = null, verdict = { signedIn: true }, pushStatus = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anty-cloud-'));
  const file = path.join(dir, 'anty-cloud.json');
  fs.writeFileSync(file, JSON.stringify({ deviceId: 'dev', access: 'A1', refresh: 'R1', expiresAt: '', cursor: '', rows: {}, synced: {}, ...state }));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, auth: opts.headers.Authorization });
    let status = 200;
    let data = {};
    if (url.endsWith('/refresh')) ({ status, data } = refresh ? refresh(body) : { status: 200, data: { access_token: 'A2', refresh_token: 'R2' } });
    else if (opts.headers.Authorization === 'Bearer EXPIRED') status = 401;
    else if (url.endsWith('/profiles/pull')) data = { profiles: rows, cursor: rows.at(-1)?.updatedAt || body.cursor };
    else if (url.endsWith('/profiles/push')) { status = pushStatus; data = { remoteId: 'r1', updatedAt: '2026-10-23T11:00:00.000Z' }; }
    return { ok: status < 300, status, text: async () => JSON.stringify(data) };
  };
  const logs = [];
  const cloud = new AntyCloud({ file, platform: 'https://platform.test/api/desktop/anty', fetchImpl, log: (line) => logs.push(line), check: async () => verdict });
  return { cloud, calls, file, logs, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function browserContext(cookies) {
  let jar = [...cookies];
  const pages = [];
  return {
    jar: () => jar,
    pages,
    cookies: async () => jar.map((cookie) => ({ ...cookie })),
    clearCookies: async ({ domain }) => { jar = jar.filter((cookie) => !domain.test(cookie.domain.replace(/^\./, ''))); },
    addCookies: async (list) => { jar = [...jar, ...list]; },
    newPage: async () => {
      const page = { goto: async (url) => { page.url = url; }, close: async () => { page.closed = true; } };
      pages.push(page);
      return page;
    }
  };
}

test('a newer working session in the cloud is put into the browser', async () => {
  const h = setup();
  const context = browserContext([li('server-stale'), other('SID')]);
  const result = await h.cloud.take('r1', context);
  assert.deepEqual(result, { taken: true, signedIn: true });
  assert.equal(sessionCookie(context.jar()).value, 'desk');
  assert.ok(context.jar().some((cookie) => cookie.name === 'SID'), 'other sites are left alone');
  assert.equal(context.pages[0].url, 'https://www.linkedin.com/feed/');
  assert.ok(context.pages[0].closed);
  assert.equal(h.read().synced.r1, '2026-10-23T10:00:00.000Z');
  // Asked again with nothing new: not even a look at the feed.
  assert.deepEqual(await h.cloud.take('r1', context), { skipped: 'nothing_new' });
  assert.equal(context.pages.length, 1);
});

test('a cloud session that does not open the feed is taken out and ours put back', async () => {
  const h = setup({ verdict: { signedIn: false, reason: 'login form' } });
  const context = browserContext([li('server-ok'), { name: 'JSESSIONID', value: 'j', domain: '.www.linkedin.com', path: '/' }]);
  const result = await h.cloud.take('r1', context);
  assert.equal(result.reverted, true);
  assert.equal(sessionCookie(context.jar()).value, 'server-ok');
  assert.ok(context.jar().some((cookie) => cookie.name === 'JSESSIONID'));
  assert.equal(h.read().synced.r1, '2026-10-23T10:00:00.000Z', 'the same stale row is not tried again');
});

test('nothing is taken from a cloud copy without a LinkedIn session, or the same one', async () => {
  const empty = setup({ rows: [cloudRow({ cookies: [other('NID')], storageState: {} })] });
  assert.deepEqual(await empty.cloud.take('r1', browserContext([li('server')])), { skipped: 'cloud_has_no_session' });
  const same = setup();
  const context = browserContext([li('desk')]);
  assert.deepEqual(await same.cloud.take('r1', context), { skipped: 'same_session' });
  assert.equal(context.pages.length, 0);
});

test('without a login on disk the cloud is off and nothing is called', async () => {
  const h = setup({ state: { access: '', refresh: '' } });
  assert.deepEqual(await h.cloud.take('r1', browserContext([])), { skipped: 'off' });
  assert.deepEqual(await h.cloud.give('r1', browserContext([li('server')])), { skipped: 'off' });
  assert.equal(h.calls.length, 0);
});

test('our session goes back inside the cloud copy — fingerprint, proxy and other cookies as they were', async () => {
  const h = setup();
  const context = browserContext([li('server'), { name: 'JSESSIONID', value: 'j', domain: '.www.linkedin.com', path: '/' }, other('SERVER_ONLY')]);
  const result = await h.cloud.give('r1', context);
  assert.equal(result.given, true);
  const push = h.calls.find((call) => call.url.endsWith('/profiles/push'));
  const profile = push.body.payload.profile;
  assert.equal(push.body.action, 'profile_upsert');
  assert.deepEqual(profile.fingerprint, { canvas: 'desk' });
  assert.deepEqual(profile.proxy, cloudRow().proxy);
  assert.equal(profile.workspaceId, 'w1');
  assert.deepEqual(profile.cookies.map((cookie) => cookie.name).sort(), ['JSESSIONID', 'NID', 'li_at']);
  assert.equal(sessionCookie(profile.cookies).value, 'server');
  assert.equal(sessionCookie(profile.storageState.cookies).value, 'server');
  assert.deepEqual(profile.storageState.origins, cloudRow().storageState.origins);
  assert.equal('lastOpenTabs' in profile, false, 'absent fields keep what the cloud has');
  assert.equal(h.read().synced.r1, '2026-10-23T11:00:00.000Z');
});

test('a browser without a LinkedIn session gives nothing', async () => {
  const h = setup();
  assert.deepEqual(await h.cloud.give('r1', browserContext([other('NID')])), { skipped: 'no_session' });
  assert.equal(h.calls.length, 0);
});

test('an expired token is renewed once and the new pair is kept', async () => {
  const h = setup({ state: { access: 'EXPIRED' } });
  await h.cloud.take('r1', browserContext([li('desk')]));
  const refreshes = h.calls.filter((call) => call.url.endsWith('/refresh'));
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].body.refresh_token, 'R1');
  assert.equal(h.read().access, 'A2');
  assert.equal(h.read().refresh, 'R2');
  assert.equal(h.calls.at(-1).auth, 'Bearer A2');
});

test('a refused renewal switches the cloud off instead of retrying forever', async () => {
  const h = setup({ state: { access: 'EXPIRED' }, refresh: () => ({ status: 401, data: { error: 'invalid_refresh_token' } }) });
  await assert.rejects(h.cloud.take('r1', browserContext([])), /не оновив вхід/);
  assert.match(h.read().dead, /refresh 401/);
  assert.equal(h.cloud.enabled, false);
});

test('only the first look at a profile reads the whole cloud; later ones read what changed', async () => {
  const h = setup();
  await h.cloud.take('r1', browserContext([li('desk')]));
  await h.cloud.take('r1', browserContext([li('desk')]));
  const pulls = h.calls.filter((call) => call.url.endsWith('/profiles/pull'));
  assert.equal(pulls[0].body.cursor, '');
  assert.equal(pulls[1].body.cursor, '2026-10-23T10:00:00.000Z');
});

test('stored cookies become cookies a browser accepts', () => {
  assert.deepEqual(forBrowser({ name: 'a', value: 'b', domain: '.linkedin.com', expires: -1, sameSite: 'no_restriction', secure: false }),
    { name: 'a', value: 'b', domain: '.linkedin.com', path: '/' });
  assert.equal(forBrowser({ name: 'a', domain: '' }), null);
  assert.equal(sessionCookie([li('old', { expires: 1000 })]), null);
  assert.equal(withOurSession(cloudRow({ workspaceId: '' }), []).workspaceId, undefined);
});

test('the runtime client takes on open and gives on close only after the feed was seen', async () => {
  const calls = [];
  const context = {};
  const cloud = {
    take: async () => { calls.push('take'); return {}; },
    give: async () => { calls.push('give'); return {}; }
  };
  const api = new AntyApi('http://127.0.0.1:3032', { cloud, fetchImpl: async (url, opts) => {
    const payload = opts.method === 'GET'
      ? { profile: { id: 3, remote_id: 'r1', name: 'Fixture', hasProxy: true, running: false } }
      : url.endsWith('/start') ? { protocol: 'cdp', wsEndpoint: 'ws://127.0.0.1:34123/devtools/browser/abc-123' } : {};
    if (url.endsWith('/stop')) calls.push('stop');
    return { ok: true, json: async () => ({ ok: true, ...payload }) };
  } });
  const chromium = { connectOverCDP: async () => ({ contexts: () => [context], close: async () => {} }) };

  const quiet = await api.open('r1', chromium);
  await quiet.close();
  assert.deepEqual(calls, ['take', 'stop']);

  calls.length = 0;
  const seen = await api.open('r1', chromium);
  seen.signedIn(true);
  await seen.close();
  assert.deepEqual(calls, ['take', 'give', 'stop']);

  calls.length = 0;
  cloud.give = async () => { calls.push('give'); throw new Error('platform down'); };
  const failing = await api.open('r1', chromium);
  failing.signedIn(true);
  await failing.close();
  assert.deepEqual(calls, ['take', 'give', 'stop'], 'a cloud failure never keeps the profile open');
});
