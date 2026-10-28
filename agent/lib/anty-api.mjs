import { randomUUID } from 'node:crypto';

/** A browser a run left open: closed with the run's own token, which only that run had. */
export async function stopLeftOpen(api, held) {
  const running = await api.request('/api/running');
  if (!(running.running || []).some((row) => Number(row.id) === Number(held.profileId))) return false;
  // `force`: a normal close for up to ~20 s, then the runtime kills the browser (pavlo-ch/anty a6817be).
  await api.request(`/api/profiles/${held.profileId}/stop`, { ownerToken: held.ownerToken, force: true });
  return true;
}

export class AntyApi {
  /**
   * `cloud` — an AntyCloud (lib/anty-cloud.mjs): the profile's LinkedIn session
   * is taken from Anty's cloud as it opens and given back as it closes, when
   * the visit said it saw the feed (`session.signedIn(true)`). It never stops a
   * visit: a cloud that fails is a line in the log.
   */
  constructor(baseUrl, { fetchImpl = fetch, cloud = null, log = () => {}, onImported = async () => {}, onLeftOpen = () => {} } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('WARMUP_ANTY_API must be a loopback HTTP origin; share the runtime network namespace');
    }
    this.baseUrl = url.origin;
    this.fetch = fetchImpl;
    this.cloud = cloud;
    this.log = log;
    this.onImported = onImported;
    // A browser this client could not close itself (a start that outlived its
    // wait goes on starting in the runtime): handed on, so the worker closes it.
    this.onLeftOpen = onLeftOpen;
  }

  async request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      // A start with the cloud's session can take minutes on a profile with a
      // long storage state (gulajpole 28.10: 141 origins seeded, over 3 min).
      signal: AbortSignal.timeout(body === undefined ? 15000 : 360000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Anty API: ${data.error || response.status}`);
    return data;
  }

  /**
   * A profile made only in a desktop Anty has no copy on the server (власник
   * 23.10: «якщо така фігня ти мусиш сам запускатися і перевіряти»): the copy
   * is made from the cloud's own — its name, proxy, fingerprint, user agent and
   * session — and people are told it was.
   */
  async copyFromCloud(remoteId) {
    const row = this.cloud ? await this.cloud.cloudRow(remoteId) : null;
    if (!row || row.deleted) throw new Error('Профілю немає ні на серверній Anty, ні в хмарі Anty');
    if (!row.proxy?.host) throw new Error(`«${row.name}» у хмарі Anty без проксі — без нього сервер LinkedIn не відкриває`);
    const made = await this.request('/api/profiles', {
      name: row.name, platform: 'linkedin', userAgent: row.userAgent || '', proxy: row.proxy
    });
    const id = made.profile?.id;
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Anty API не створив копію профілю');
    await this.request(`/api/profiles/${id}`, {
      remote_id: row.remoteId, team_id: row.teamId || '', fingerprint: row.fingerprint || {},
      cookies: row.cookies || [], storage_state: row.storageState || {}, user_agent: row.userAgent || '',
      start_page: row.startPage || 'https://www.linkedin.com/feed/'
    }, 'PATCH');
    await this.onImported(row).catch(() => {});
    this.log(`☁️ «${row.name}» не було на серверній Anty — копію зроблено з хмари`);
    return row;
  }

  /** The server copy of a profile, made from the cloud when there is none yet. True when one was made. */
  async ensureCopy(remoteId) {
    try {
      await this.request(`/api/profiles/by-remote/${encodeURIComponent(remoteId)}`);
      return false;
    } catch (error) {
      if (!/not available in this server scope/i.test(error.message) || !this.cloud?.enabled) throw error;
      await this.copyFromCloud(remoteId);
      return true;
    }
  }

  async open(remoteId, chromium) {
    let found;
    try {
      found = await this.request(`/api/profiles/by-remote/${encodeURIComponent(remoteId)}`);
    } catch (error) {
      if (!/not available in this server scope/i.test(error.message) || !this.cloud?.enabled) throw error;
      await this.copyFromCloud(remoteId);
      found = await this.request(`/api/profiles/by-remote/${encodeURIComponent(remoteId)}`);
    }
    const { profile } = found;
    if (!profile || profile.remote_id !== remoteId || !Number.isSafeInteger(profile.id) || profile.id <= 0) {
      throw new Error('Anty API resolved a different profile');
    }
    if (profile.running) throw new Error(`${profile.name} is already running in Anty`);
    if (!profile.hasProxy) throw new Error(`${profile.name} has no proxy; refusing a direct LinkedIn visit`);
    const ownerToken = randomUUID();
    let browser;
    let closing;
    let context;
    let sawFeed = false;
    const close = () => {
      if (closing) return closing;
      closing = (async () => {
        if (sawFeed && context && this.cloud) {
          await this.cloud.give(remoteId, context)
            .catch(error => this.log(`☁️ не віддав сесію в Anty-хмару: ${error.message}`));
        }
        // Runtime owns the persistent context and flushes it before closing Chrome.
        // Closing the attached context first would lose the last session changes.
        await this.request(`/api/profiles/${profile.id}/stop`, { ownerToken });
        await browser?.close();
      })().catch(error => { closing = null; throw error; });
      return closing;
    };
    try {
      const result = await this.request(`/api/profiles/${profile.id}/start`, { requireProxy: true, ownerToken });
      const endpoint = new URL(result.wsEndpoint);
      if (result.protocol !== 'cdp' || endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' ||
          endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
          !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint.pathname)) {
        throw new Error('Anty returned an invalid private CDP endpoint');
      }
      browser = await chromium.connectOverCDP(endpoint.href, { timeout: 30000 });
      context = browser.contexts()[0];
      if (!context) throw new Error('Anty did not expose its persistent context');
      const taken = this.cloud
        ? await this.cloud.take(remoteId, context, { proxy: profile.proxyServer }).catch(error => {
          this.log(`☁️ не взяв сесію з Anty-хмари: ${error.message}`);
          return {};
        })
        : {};
      if (taken.signedIn) sawFeed = true;
      return {
        profile: { ...profile, proxy: { server: profile.proxyServer }, managedByAnty: true },
        context,
        close,
        // Kept on disk by the run, so the worker can still close this browser
        // if the run dies with it open (28.10: gulajpole's held 2.3 GB for two hours).
        ownerToken,
        signedIn: (yes) => { sawFeed = Boolean(yes); }
      };
    } catch (error) {
      // The request may have reached the server before the client lost its response.
      // The owner token prevents cleanup from stopping a concurrent user's browser.
      // A timeout is a DOMException whose message cannot be added to (28.10:
      // «Cannot set property message … which has only a getter» hid the real cause).
      let cleanup = null;
      try { await close(); } catch (cleanupError) {
        cleanup = cleanupError;
        try { this.onLeftOpen({ profileId: profile.id, ownerToken }); } catch { /* the caller's file, best effort */ }
      }
      if (!cleanup) throw error;
      throw new Error(`${error.message}; браузер не вдалося закрити одразу (${cleanup.message}) — воркер закриє його після сесії`, { cause: error });
    }
  }
}
