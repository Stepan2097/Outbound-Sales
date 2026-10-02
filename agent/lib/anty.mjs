/**
 * Reading Anty's own store, read-only.
 *
 * The portal knows a profile by the id the cloud gave it; the browser on this
 * machine is a directory named after Anty's local row id, with its proxy,
 * fingerprint and saved session in SQLite beside it. This maps one to the other
 * and hands back everything needed to open that exact browser.
 *
 * Opened read-only on purpose: Anty may be running, and its writes are synced
 * to the team. The agent borrows the profile, it does not own it.
 */
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

import './env.mjs';
export const ANTY_DIR = process.env.WARMUP_ANTY_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'anty-browser');
const DB_PATH = path.join(ANTY_DIR, 'anty_browser.db');

const parse = (raw, fallback) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};

export function readProfile(remoteId) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT p.id, p.name, p.remote_id, p.user_agent, p.fingerprint, p.cookies, p.storage_state,
             p.status, p.running_on,
             x.type AS proxy_type, x.host AS proxy_host, x.port AS proxy_port,
             x.username AS proxy_user, x.password AS proxy_pass
      FROM profiles p LEFT JOIN proxies x ON x.id = p.proxy_id
      WHERE p.remote_id = ?
    `).get(remoteId);
    if (!row) return null;

    const fingerprint = parse(row.fingerprint, {});
    return {
      localId: row.id,
      name: row.name,
      userDataDir: path.join(ANTY_DIR, 'profiles', `profile_${row.id}`),
      // Anty launches with the fingerprint's UA, not the column's, and so must
      // this: a profile that has always looked like Windows to LinkedIn should
      // not turn into a Mac because the agent runs on one.
      userAgent: fingerprint.userAgent || row.user_agent || null,
      timezoneId: fingerprint.locale?.timezone || null,
      openInAnty: row.status === 'running' || Boolean(String(row.running_on || '').trim()),
      proxy: row.proxy_host
        ? {
            server: `${(row.proxy_type || 'http').toLowerCase().replace('sock5', 'socks5')}://${row.proxy_host}:${row.proxy_port}`,
            username: row.proxy_user || undefined,
            password: row.proxy_pass || undefined,
          }
        : null,
      cookies: parse(row.cookies, []),
      storageState: parse(row.storage_state, null),
    };
  } finally {
    db.close();
  }
}

/** Copied from Anty's launcher: Playwright rejects cookies it cannot place. */
export function normalizeCookie(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;

  const cookie = { name, value: raw.value == null ? '' : String(raw.value) };
  const url = String(raw.url || '').trim();
  const domain = String(raw.domain || '').trim();
  if (url) cookie.url = url;
  else if (domain) { cookie.domain = domain; cookie.path = String(raw.path || '/').trim() || '/'; }
  else return null;

  if (typeof raw.httpOnly === 'boolean') cookie.httpOnly = raw.httpOnly;
  if (typeof raw.secure === 'boolean') cookie.secure = raw.secure;

  const sameSite = { strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None', unspecified: 'Lax' }[
    String(raw.sameSite || '').toLowerCase()
  ];
  if (sameSite) cookie.sameSite = sameSite;
  if (cookie.sameSite === 'None' && cookie.secure !== true) cookie.secure = true;

  const expires = Number(raw.expires ?? raw.expirationDate);
  if (Number.isFinite(expires) && expires > 0 && !raw.session) cookie.expires = expires;

  return cookie;
}
