#!/usr/bin/env node
/**
 * Sign the agent into Anty's cloud, once (see lib/anty-cloud.mjs).
 *
 *   node agent/anty-cloud-login.mjs
 *
 * Prints one line, `LOGIN_URL <address>`, for the owner to open and sign in
 * with the account of the team the warm-up profiles live in; nobody types a
 * password here. The login is kept only if that account sees every profile the
 * server's Anty holds — on 16.10 a login into another team hid them all — and
 * the cloud's current copies are marked as already exchanged, so only what
 * changes from now on travels.
 *
 * Needs `WARMUP_ANTY_API` (the server's Anty, to know its profiles).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AntyCloud, APP_VERSION, SOURCE, cloudFromEnv, deviceInfo, newState, tokensOf } from './lib/anty-cloud.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TIMEOUT_MS = 20 * 60_000;

const cloud = cloudFromEnv({ agentDir: here });
const previous = cloud.read();
const state = newState(previous, { access: '', refresh: '', expiresAt: '' });
const device = deviceInfo(state.deviceId);

const api = process.env.WARMUP_ANTY_API;
if (!api) throw new Error('WARMUP_ANTY_API не заданий');
const listed = await (await fetch(`${api.replace(/\/+$/, '')}/api/profiles`)).json();
const wanted = (listed.profiles || []).map((profile) => String(profile.remote_id || '')).filter(Boolean);
if (!wanted.length) throw new Error('серверний Anty не має профілів з remote_id');

const started = await cloud.post(`${cloud.platform}/auth/start`, { source: SOURCE, appVersion: APP_VERSION, device });
const start = started.body?.data && typeof started.body.data === 'object' ? { ...started.body, ...started.body.data } : started.body;
if (!started.ok || (!start.authUrl && !start.url)) throw new Error(`auth/start → ${started.status} ${start?.error || ''}`);
console.log(`LOGIN_URL ${start.authUrl || start.url}`);

const deadline = Date.now() + TIMEOUT_MS;
let tokens = null;
while (Date.now() < deadline) {
  await sleep(2000);
  const poll = await cloud.post(start.pollUrl || start.poll_url || `${cloud.platform}/auth/poll`, {
    requestId: start.requestId || start.request_id || '', pollToken: start.pollToken || start.poll_token || '',
    source: SOURCE, appVersion: APP_VERSION, device
  });
  const status = String(poll.body?.status || poll.body?.state || poll.body?.data?.status || '').toLowerCase();
  if (poll.status === 202 || status === 'pending' || status === 'waiting') continue;
  if (!poll.ok) throw new Error(`auth/poll → ${poll.status} ${poll.body?.error || ''}`);
  tokens = tokensOf(poll.body);
  if (tokens.access) break;
}
if (!tokens?.access) { console.log('LOGIN_FAILED час вийшов'); process.exit(1); }

// Checked on a throwaway object: nothing reaches the file before the team is right.
const trial = { ...state, ...tokens };
const probe = new AntyCloud({ file: `${cloud.file}.trial`, platform: cloud.platform });
probe.write = () => {};
let cursor = '';
const seen = new Map();
for (let page = 0; page < 40; page += 1) {
  const body = await probe.call(trial, `${probe.platform}/profiles/pull`, { cursor });
  for (const row of body?.profiles || []) seen.set(String(row.remoteId), row);
  if (!body?.cursor || (body.profiles || []).length < 500) { cursor = body?.cursor || cursor; break; }
  cursor = body.cursor;
}
const missing = wanted.filter((id) => !seen.has(id));
if (missing.length) {
  console.log(`LOGIN_WRONG_TEAM цей акаунт не бачить ${missing.length} з ${wanted.length} профілів сервера — вхід не збережено`);
  process.exit(2);
}

const rows = Object.fromEntries(wanted.map((id) => [id, seen.get(id)]));
const synced = Object.fromEntries(wanted.map((id) => [id, String(seen.get(id).updatedAt || '')]));
cloud.write({ ...trial, cursor, rows, synced, loggedInAt: new Date().toISOString() });
console.log(`LOGIN_OK ${wanted.length} профілів сервера видно в хмарі`);
