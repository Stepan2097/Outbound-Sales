import { randomUUID } from 'node:crypto';

export class AntyApi {
  /**
   * `cloud` — an AntyCloud (lib/anty-cloud.mjs): the profile's LinkedIn session
   * is taken from Anty's cloud as it opens and given back as it closes, when
   * the visit said it saw the feed (`session.signedIn(true)`). It never stops a
   * visit: a cloud that fails is a line in the log.
   */
  constructor(baseUrl, { fetchImpl = fetch, cloud = null, log = () => {} } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('WARMUP_ANTY_API must be a loopback HTTP origin; share the runtime network namespace');
    }
    this.baseUrl = url.origin;
    this.fetch = fetchImpl;
    this.cloud = cloud;
    this.log = log;
  }

  async request(route, body) {
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body === undefined ? 15000 : 180000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Anty API: ${data.error || response.status}`);
    return data;
  }

  async open(remoteId, chromium) {
    const { profile } = await this.request(`/api/profiles/by-remote/${encodeURIComponent(remoteId)}`);
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
        ? await this.cloud.take(remoteId, context).catch(error => {
          this.log(`☁️ не взяв сесію з Anty-хмари: ${error.message}`);
          return {};
        })
        : {};
      if (taken.signedIn) sawFeed = true;
      return {
        profile: { ...profile, proxy: { server: profile.proxyServer }, managedByAnty: true },
        context,
        close,
        signedIn: (yes) => { sawFeed = Boolean(yes); }
      };
    } catch (error) {
      // The request may have reached the server before the client lost its response.
      // The owner token prevents cleanup from stopping a concurrent user's browser.
      try { await close(); } catch (cleanupError) { error.message += `; cleanup failed: ${cleanupError.message}`; }
      throw error;
    }
  }
}
