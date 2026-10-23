/**
 * The LinkedIn session of each profile, kept in step with Anty's cloud (власник
 * 23.10: «воно повинно бути синхронізовано, брати з тієї бази і відправляти в
 * ту базу»).
 *
 * The server's Anty keeps its own copy of every profile and never synced it: a
 * login the owner did in his desktop Anty stayed on his desktop, and the agent
 * went on opening a copy LinkedIn had logged out (gulajpole, 19.10). The
 * runtime's own cloud sync cannot simply be switched on: it pushes the whole
 * profile, and the server copies were imported with one shared fingerprint and
 * not always the same proxy — the first push would have handed every desktop
 * that fingerprint. So only the session travels, and only LinkedIn's part of it:
 *
 * - `take` — as a profile opens: if the cloud holds a LinkedIn session newer
 *   than the last one exchanged and different from ours, it is put into the
 *   browser and checked on the feed. One that does not open the feed is taken
 *   back out and ours restored, so a stale desktop session never breaks a
 *   working one.
 * - `give` — as a profile closes, and only when this visit saw the feed: our
 *   LinkedIn cookies replace the LinkedIn cookies of the cloud's own copy of the
 *   profile. Everything else in that copy — fingerprint, proxy, the other
 *   sites' cookies — goes back exactly as the cloud had it.
 *
 * The cloud login (tokens) lives in a file only this agent reads, written by
 * `anty-cloud-login.mjs` after the owner signs in; without it nothing here does
 * anything. The worker and the login watcher share the file, so every
 * read-change-write of it happens under a lock — two refreshes racing would
 * spend one refresh token twice, and the platform answers that by ending the
 * session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomicSync } from './atomic-write.mjs';

export const SOURCE = 'anty-browser';
export const APP_VERSION = 'outbound-agent';
export const DEFAULT_PLATFORM = 'https://blackaffiliate.duckdns.org/api/desktop/anty';
const PAGE = 500;
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 120_000;
const REFRESH_AHEAD_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** linkedin.com and its subdomains, whatever the leading dot. */
export function isLinkedinCookie(cookie) {
  const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
  return domain === 'linkedin.com' || domain.endsWith('.linkedin.com');
}

/** The li_at cookie of a list — LinkedIn's session — when it is there and not expired. */
export function sessionCookie(cookies, nowMs = Date.now()) {
  const found = (cookies || []).find((cookie) => isLinkedinCookie(cookie) && cookie.name === 'li_at' && cookie.value);
  if (!found) return null;
  const expires = Number(found.expires);
  return !Number.isFinite(expires) || expires <= 0 || expires * 1000 > nowMs ? found : null;
}

const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None' };

/** A stored cookie in the shape `context.addCookies` accepts. */
export function forBrowser(cookie) {
  if (!cookie?.name || !cookie.domain) return null;
  const out = { name: String(cookie.name), value: String(cookie.value ?? ''), domain: String(cookie.domain), path: String(cookie.path || '/') };
  const expires = Number(cookie.expires);
  if (Number.isFinite(expires) && expires > 0) out.expires = expires;
  if (cookie.httpOnly) out.httpOnly = true;
  if (cookie.secure) out.secure = true;
  const sameSite = SAME_SITE[String(cookie.sameSite || '').toLowerCase()];
  if (sameSite) out.sameSite = sameSite;
  // A browser refuses SameSite=None without Secure.
  if (out.sameSite === 'None' && !out.secure) delete out.sameSite;
  return out;
}

/** The LinkedIn session a cloud row carries, from its cookies or its storage state. */
export function cloudLinkedin(row, nowMs = Date.now()) {
  for (const list of [row?.cookies, row?.storageState?.cookies]) {
    if (Array.isArray(list) && sessionCookie(list, nowMs)) return list.filter(isLinkedinCookie);
  }
  return null;
}

/** The cloud's copy of a profile with its LinkedIn cookies swapped for ours, ready to push. */
export function withOurSession(row, ours) {
  const swap = (list) => [...(Array.isArray(list) ? list : []).filter((cookie) => !isLinkedinCookie(cookie)), ...ours];
  const storage = row.storageState && typeof row.storageState === 'object' ? row.storageState : {};
  const profile = {
    remoteId: row.remoteId,
    teamId: row.teamId || '',
    name: row.name,
    status: row.status || 'ready',
    userAgent: row.userAgent || '',
    fingerprint: row.fingerprint || {},
    cookies: swap(row.cookies),
    storageState: { ...storage, cookies: swap(storage.cookies), origins: Array.isArray(storage.origins) ? storage.origins : [] },
    notes: row.notes || '',
    startPage: row.startPage || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    proxy: row.proxy ?? null,
    runningOn: row.runningOn || '',
    lastLaunchedAt: new Date().toISOString()
  };
  if (row.workspaceId) profile.workspaceId = row.workspaceId;
  return profile;
}

function tokensOf(body) {
  const root = body && typeof body === 'object' ? body : {};
  const nested = root.data && typeof root.data === 'object' ? root.data : {};
  return {
    access: String(root.access_token || root.accessToken || root.token || nested.access_token || nested.accessToken || nested.token || ''),
    refresh: String(root.refresh_token || root.refreshToken || nested.refresh_token || nested.refreshToken || ''),
    expiresAt: String(root.expires_at || root.expiresAt || nested.expires_at || nested.expiresAt || '')
  };
}

function expiresMs(value) {
  if (!value) return NaN;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number;
  return Date.parse(value);
}

const OPEN_LOCK_MS = 12 * 3_600_000;

/** Running on some desktop, by a lock fresh enough to be real (a crash leaves one behind). */
export function openElsewhere(row, nowMs = Date.now()) {
  if (!row || String(row.status) !== 'running') return null;
  const launched = Date.parse(row.lastLaunchedAt || '');
  if (Number.isFinite(launched) && nowMs - launched > OPEN_LOCK_MS) return null;
  return { by: row.runningBy || row.runningOn || 'хтось' };
}

/** `http://host:port` or `host:port` → `host:port`. */
export function proxyKey(server) {
  const text = String(server || '').replace(/^[a-z0-9]+:\/\//i, '').replace(/^[^@]*@/, '').replace(/\/.*$/, '');
  const [host, port] = text.split(':');
  return `${host}:${Number(port) || 0}`;
}

export function deviceInfo(deviceId) {
  return { deviceId, deviceName: 'outbound-server', os: `${os.platform()}-${os.release()}`, arch: os.arch() };
}

export class AntyCloud {
  constructor({ file, platform = DEFAULT_PLATFORM, fetchImpl = fetch, log = () => {}, check = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.platform = platform.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.log = log;
    // How a freshly taken session is judged: `(page) => ({ signedIn })` — the
    // probe's own `settle`, passed in so this file does not depend on the page code.
    this.check = check;
    this.now = now;
  }

  /**
   * On when the file holds a login or a device the platform registered for this
   * server (then the first call fetches tokens by `auth/device-token`), and
   * neither has been refused since.
   */
  get enabled() {
    const state = this.read();
    return Boolean(state?.refresh || state?.access || state?.deviceId) && !state.dead;
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomicSync(this.file, JSON.stringify(state));
  }

  async locked(work) {
    const lock = `${this.file}.lock`;
    const deadline = this.now() + LOCK_WAIT_MS;
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (this.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone already */ }
        if (this.now() > deadline) throw new Error('Anty-хмара: файл входу зайнятий іншим процесом');
        await sleep(250);
      }
    }
    try { return await work(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  }

  async post(url, body, token) {
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    });
    let data = {};
    try { data = JSON.parse(await response.text()); } catch { /* not JSON */ }
    return { ok: response.ok, status: response.status, body: data };
  }

  base(state) {
    return { source: SOURCE, appVersion: APP_VERSION, device: deviceInfo(state.deviceId) };
  }

  /**
   * New tokens: by the refresh token, and when that one is spent or rotated
   * away, by the device itself — the platform keeps the device's session after
   * one login (`auth/device-token`, чат Anty 23.10), so the owner signs in once,
   * not every time a refresh token ages out. Only a device someone logged out
   * needs a new login, and then the cloud switches itself off.
   */
  async refresh(state) {
    let result = state.refresh
      ? await this.post(`${this.platform}/refresh`, { refresh_token: state.refresh, ...this.base(state) })
      : { ok: false, status: 0, body: {} };
    let tokens = tokensOf(result.body);
    if ((!result.ok || !tokens.access) && state.deviceId) {
      result = await this.post(`${this.platform}/auth/device-token`, this.base(state));
      tokens = tokensOf(result.body);
    }
    if (!result.ok || !tokens.access) {
      if ([400, 401, 403, 404, 423].includes(result.status)) {
        state.dead = `refresh ${result.status} ${result.body?.error || ''}`.trim();
        this.write(state);
      }
      throw new Error(`Anty-хмара: не оновив вхід (${result.status} ${result.body?.error || ''})`.trim());
    }
    state.access = tokens.access;
    state.refresh = tokens.refresh || state.refresh;
    state.expiresAt = tokens.expiresAt;
    this.write(state);
  }

  /** A signed call; the token is renewed ahead of expiry and once more on a 401. Under the lock. */
  async call(state, url, body) {
    const expires = expiresMs(state.expiresAt);
    if (!state.access || (Number.isFinite(expires) && expires - this.now() < REFRESH_AHEAD_MS)) await this.refresh(state);
    let result = await this.post(url, { ...this.base(state), ...body }, state.access);
    if (result.status === 401) {
      await this.refresh(state);
      result = await this.post(url, { ...this.base(state), ...body }, state.access);
    }
    if (!result.ok) throw new Error(`Anty-хмара: ${url.split('/').slice(-2).join('/')} → ${result.status} ${result.body?.error || ''}`.trim());
    return result.body;
  }

  /**
   * The cloud's changes since the last look, kept for the profiles we follow.
   * A profile seen for the first time costs one full read; after that only
   * what changed is fetched.
   */
  async pull(state, remoteId) {
    state.rows ||= {};
    state.synced ||= {};
    const full = remoteId && !state.rows[remoteId];
    let cursor = full ? '' : (state.cursor || '');
    const follow = new Set([...Object.keys(state.rows), ...(remoteId ? [remoteId] : [])]);
    for (let page = 0; page < 40; page += 1) {
      const body = await this.call(state, `${this.platform}/profiles/pull`, { cursor });
      const rows = Array.isArray(body?.profiles) ? body.profiles : [];
      for (const row of rows) if (follow.has(String(row.remoteId))) state.rows[row.remoteId] = row;
      const next = String(body?.cursor || '');
      if (next) cursor = next;
      if (rows.length < PAGE || !next) break;
    }
    // A full read starts the cursor no earlier than it was: it covers everything up to its end.
    if (cursor && (!state.cursor || cursor > state.cursor)) state.cursor = cursor;
    this.write(state);
    return state.rows[remoteId] ?? null;
  }

  /** The cloud's own copy of a profile, read fresh — to make a server copy of one only a desktop has. */
  async cloudRow(remoteId) {
    if (!this.enabled || !remoteId) return null;
    return this.locked(async () => this.pull(this.read(), remoteId));
  }

  /**
   * As a profile opens: the cloud's LinkedIn session, when it is newer and works.
   * Only through the same proxy the cloud copy uses — a session moved to another
   * IP is a new sign-in to LinkedIn.
   */
  async take(remoteId, context, { proxy = null } = {}) {
    if (!this.enabled || !remoteId) return { skipped: 'off' };
    return this.locked(async () => {
      const state = this.read();
      const row = await this.pull(state, remoteId);
      if (!row || row.deleted) return { skipped: 'not_in_cloud' };
      // Open on a desktop right now: the server still works the profile (власник
      // 23.10: «має відкривати»), but swaps no session with one in use — the
      // desktop writes its own over the cloud as it closes anyway.
      if (openElsewhere(row, this.now())) return { skipped: 'open_elsewhere' };
      // The first look only notes where the cloud stands: a desktop session that
      // was there before the sync existed is not a reason to swap a working one.
      if (!state.synced[remoteId]) {
        state.synced[remoteId] = String(row.updatedAt);
        this.write(state);
        return { skipped: 'first_look' };
      }
      if (proxy && row.proxy?.host && proxyKey(proxy) !== `${row.proxy.host}:${Number(row.proxy.port) || 0}`) {
        return { skipped: 'proxy_differs' };
      }
      if (state.synced[remoteId] && String(row.updatedAt) <= String(state.synced[remoteId])) return { skipped: 'nothing_new' };
      const theirs = cloudLinkedin(row, this.now());
      const mark = () => { state.synced[remoteId] = String(row.updatedAt); this.write(state); };
      if (!theirs) { mark(); return { skipped: 'cloud_has_no_session' }; }

      const before = (await context.cookies()).filter(isLinkedinCookie);
      if (sessionCookie(before, this.now())?.value === sessionCookie(theirs, this.now()).value) { mark(); return { skipped: 'same_session' }; }

      await context.clearCookies({ domain: /(^|\.)linkedin\.com$/ });
      await context.addCookies(theirs.map(forBrowser).filter(Boolean));
      const verdict = await this.verify(context);
      mark();
      if (verdict.signedIn) {
        this.log(`☁️ сесію LinkedIn узято з Anty-хмари (оновлена ${row.updatedAt})`);
        return { taken: true, signedIn: true };
      }
      await context.clearCookies({ domain: /(^|\.)linkedin\.com$/ });
      if (before.length) await context.addCookies(before.map(forBrowser).filter(Boolean));
      this.log(`☁️ сесія з Anty-хмари не відкрила стрічку (${verdict.reason || '?'}) — лишаю свою`);
      return { taken: false, reverted: true, reason: verdict.reason || null };
    });
  }

  async verify(context) {
    if (!this.check) return { signedIn: true };
    const page = await context.newPage();
    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return await this.check(page);
    } catch (error) {
      return { signedIn: false, reason: error.message.slice(0, 80) };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** As a profile closes, after a visit that saw the feed: our LinkedIn session into the cloud's copy. */
  async give(remoteId, context) {
    if (!this.enabled || !remoteId) return { skipped: 'off' };
    const ours = (await context.cookies()).filter(isLinkedinCookie);
    if (!sessionCookie(ours, this.now())) return { skipped: 'no_session' };
    return this.locked(async () => {
      const state = this.read();
      // Read just before writing: a name or proxy changed on the desktop a minute
      // ago must go back as it is now, not as it was at the start of the visit.
      const row = await this.pull(state, remoteId);
      if (!row || row.deleted) return { skipped: 'not_in_cloud' };
      if (openElsewhere(row, this.now())) return { skipped: 'open_elsewhere' };
      const profile = withOurSession(row, ours);
      const body = await this.call(state, `${this.platform}/profiles/push`, { action: 'profile_upsert', payload: { profile } });
      const updatedAt = String(body?.updatedAt || new Date(this.now()).toISOString());
      state.rows[remoteId] = { ...row, cookies: profile.cookies, storageState: profile.storageState, updatedAt };
      state.synced[remoteId] = updatedAt;
      this.write(state);
      return { given: true, updatedAt };
    });
  }
}

/** The agent's cloud, from the environment: the file beside the runs, the platform's address. */
export function cloudFromEnv({ agentDir, log, check } = {}) {
  return new AntyCloud({
    file: process.env.WARMUP_ANTY_CLOUD_FILE || path.join(agentDir, 'runs', 'anty-cloud.json'),
    platform: process.env.WARMUP_ANTY_PLATFORM || DEFAULT_PLATFORM,
    log,
    check
  });
}

/** A fresh state for a login just made — a new device id unless one exists. */
export function newState(previous, tokens, extra = {}) {
  return {
    deviceId: previous?.deviceId || randomUUID().replace(/-/g, ''),
    access: tokens.access,
    refresh: tokens.refresh,
    expiresAt: tokens.expiresAt,
    cursor: '',
    rows: {},
    synced: {},
    ...extra
  };
}

export { tokensOf };
