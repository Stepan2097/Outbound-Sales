import './env.mjs';

/** All scheduling, recipients and allowances come from Outbound-Sales. */
export class Portal {
  constructor(base, { token = process.env.WARMUP_AGENT_TOKEN ?? null, prefix = '/api/warmup/agent', timeoutMs = 30000 } = {}) {
    this.base = base.replace(/\/$/, '');
    this.token = token && String(token).trim() ? String(token).trim() : null;
    if (prefix !== '/api/warmup/agent') throw new Error('The agent requires the Outbound-Sales API');
    this.prefix = prefix;
    this.prefixConfirmed = true;
    this.accountId = null;
    this.leaseId = null;
    this.timeoutMs = timeoutMs;
  }
  async #json(path, init = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...init, signal: AbortSignal.timeout(this.timeoutMs),
      headers: { ...(init.headers ?? {}), ...(this.token ? { 'X-Agent-Token': this.token } : {}) }
    });
    const body = await res.json();
    return { ...body, ok: res.ok, status: res.status, success: res.ok && body.success === true,
      ...(!res.ok && !body.error ? { error: `HTTP ${res.status}` } : {}) };
  }
  #post(payload) {
    return this.#json(this.prefix, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: this.accountId, ...(this.leaseId ? { leaseId: this.leaseId } : {}), ...payload }) });
  }
  async agentPath() { return this.prefix; }
  window() { return this.#json(this.prefix); }
  due() { return this.#json(`${this.prefix}/due`); }
  lease(accountId) {
    return this.#json(`${this.prefix}/lease`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId }) });
  }
  runFinished({ accountId, leaseId = null, ok, note = null }) {
    return this.#post({ action: 'run.finished', accountId, leaseId, ok: Boolean(ok), note });
  }
  /** Every account the portal knows, health and all — one source for the rest. */
  async accounts() {
    const answer = await this.#json(`${this.prefix}/accounts`);
    if (!answer.success) throw new Error(answer.error || 'Could not list accounts');
    return Array.isArray(answer.accounts) ? answer.accounts : [];
  }
  async warming() {
    const accounts = await this.accounts();
    return accounts.filter((a) => a.status === 'warming' && a.health === 'ok').map((a) => ({ name: a.label, accountId: a.id }));
  }
  async supportsInbox() { return true; }
  async resolve(query) {
    const accounts = await this.accounts();
    const needle = String(query).toLowerCase();
    const exact = accounts.filter((a) => a.id === query || a.profileRemoteId === query ||
      String(a.label ?? '').toLowerCase() === needle || String(a.login ?? '').toLowerCase() === needle);
    const matches = exact.length ? exact : accounts.filter((a) => String(a.label ?? '').toLowerCase().includes(needle) || String(a.login ?? '').toLowerCase().includes(needle));
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous warm-up account "${query}"` : `No warm-up account matches "${query}"`);
    const hit = matches[0];
    this.accountId = hit.id;
    return { accountId: hit.id, profileRemoteId: hit.profileRemoteId, name: hit.label };
  }
  plan() { return this.#json(`${this.prefix}?accountId=${encodeURIComponent(this.accountId)}`); }
  openSession(host) { return this.#post({ action: 'session.open', host }); }
  closeSession(note, failed) { return this.#post({ action: 'session.close', note, failed }); }
  record(kind, detail, count) { return this.#post({ action: 'record', kind, detail, count }); }
  log(type, message, meta, level) { return this.#post({ action: 'log', type, message, meta, level }); }
  health(health, note) { return this.#post({ action: 'health', health, note }); }
  /** What somebody asked to have looked at, by opening the link in the group. */
  async loginChecks() {
    const answer = await this.#json(`${this.prefix}/login-checks`);
    if (!answer.success) throw new Error(answer.error || 'Could not read login checks');
    return Array.isArray(answer.checks) ? answer.checks : [];
  }
  /** The verdict for one of them, so the page can stop promising. */
  loginRecheck(nonce, signedIn, reason = '') {
    return this.#post({ action: 'login.recheck', nonce, signedIn, reason });
  }
  warning(note) { return this.#post({ action: 'warning', note }); }
  prepareInvite(outreachId) { return this.#post({ action: 'invite.prepare', outreachId }); }
  inviteSent(outreachId, outcome, leaseId = this.leaseId) { return this.#post({ action: 'invite.sent', outreachId, outcome, leaseId }); }
  invitesChecked(results) { return this.#post({ action: 'invites.checked', results }); }
  inboxThread(thread) { return this.#post({ action: 'inbox.thread', ...thread }); }
  inboxDone(threadsSeen) { return this.#post({ action: 'inbox.done', threadsSeen }); }
  /** Right before typing: is this reply still wanted, and is the account still allowed to send it? */
  outboxPrepare(replyId) { return this.#post({ action: 'outbox.prepare', replyId }); }
  /** After LinkedIn showed the message in the conversation — never before. */
  outboxSent(replyId) { return this.#post({ action: 'outbox.sent', replyId }); }
  /** It did not go, or nobody can tell. The reason is shown to the person who wrote it. */
  outboxFailed(replyId, reason) { return this.#post({ action: 'outbox.failed', replyId, reason }); }
}
