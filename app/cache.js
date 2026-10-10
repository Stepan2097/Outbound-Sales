// Tab-local display snapshots and short-lived safe reads. Every key belongs to
// the authenticated person, role and workspace; nothing is recalled before the
// shell has established that scope. Writes invalidate answers, never get cached.
const PREFIX = "outbound:screen:v2:";
const LEGACY_PREFIX = "outbound:screen:v1:";
const MAX_SNAPSHOT_CHARS = 512_000;
const MAX_SNAPSHOTS = 12;
const MAX_READS = 80;
const MAX_READ_CHARS = 2_000_000;
let scope = "";
let epoch = 0;
const resetHooks = new Set();
const invalidationHooks = new Set();
const reads = new Map();
const flights = new Set();
let readChars = 0;

export function getCacheScope() {
  return scope;
}

export function getCacheEpoch() {
  return epoch;
}

export function onCacheReset(hook) {
  resetHooks.add(hook);
  return () => resetHooks.delete(hook);
}

export function onReadsInvalidated(hook) {
  invalidationHooks.add(hook);
  return () => invalidationHooks.delete(hook);
}

export function setCacheScope(value) {
  const next = String(value || "");
  if (scope === next) return;
  // A reload starts with no scope. Preserve only this authenticated person's
  // snapshots then; a real session switch clears every previous answer.
  if (!scope && next) {
    invalidateScreens(next);
    resetScreenMemory();
  } else {
    forgetScreens();
  }
  scope = next;
}

/** `{ at, value }` as last remembered, or null. A snapshot is display-only. */
export function recallScreen(key) {
  if (!scope) return null;
  try {
    const raw = window.sessionStorage.getItem(PREFIX + scope + ":" + key);
    if (!raw || raw.length > MAX_SNAPSHOT_CHARS) return null;
    const saved = JSON.parse(raw);
    return saved && Number.isFinite(saved.at) && "value" in saved ? saved : null;
  } catch { return null; }
}

export function rememberScreen(key, value) {
  if (!scope) return;
  try {
    const raw = JSON.stringify({ at: Date.now(), value });
    if (raw.length > MAX_SNAPSHOT_CHARS) return;
    const ownPrefix = PREFIX + scope + ":";
    const keys = storageKeys().filter((stored) => stored.startsWith(ownPrefix));
    if (keys.length >= MAX_SNAPSHOTS && !keys.includes(ownPrefix + key)) window.sessionStorage.removeItem(keys[0]);
    window.sessionStorage.setItem(ownPrefix + key, raw);
  } catch { /* Storage unavailable/full: load normally. */ }
}

function storageKeys() {
  const keys = [];
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

export function invalidateScreens(keepScope = "") {
  try {
    const keepPrefix = keepScope ? PREFIX + keepScope + ":" : "";
    for (const key of storageKeys()) {
      if ((key.startsWith(PREFIX) || key.startsWith(LEGACY_PREFIX)) && (!keepPrefix || !key.startsWith(keepPrefix))) window.sessionStorage.removeItem(key);
    }
  } catch { /* Nothing stored, nothing to forget. */ }
}

export function forgetScreens() {
  invalidateScreens();
  resetScreenMemory();
}

function resetScreenMemory() {
  epoch += 1;
  invalidateReads();
  for (const hook of resetHooks) {
    try { hook(); } catch { /* One screen cannot keep another person's memory alive. */ }
  }
}

function abortFailure() {
  const error = new Error("Read cancelled");
  error.name = "AbortError";
  return error;
}

function removeRead(key, entry) {
  if (reads.get(key) !== entry) return;
  reads.delete(key);
  readChars -= entry.chars || 0;
}

export function invalidateReads(prefix = "", { retryPending = false } = {}) {
  for (const hook of invalidationHooks) {
    try { hook(prefix); } catch { /* Invalidation must finish even if a screen is gone. */ }
  }
  const affected = new Set();
  for (const [key, entry] of reads) {
    if (!entry.key.startsWith(prefix)) continue;
    removeRead(key, entry);
    affected.add(entry);
  }
  // Include resolved cache hits awaiting delivery, and retired reads still
  // serving callers. A write can land between resolution and that delivery.
  for (const entry of flights) if (entry.key.startsWith(prefix)) affected.add(entry);
  for (const entry of affected) {
    if (retryPending) {
      entry.retired = true;
      entry.version += 1;
    } else entry.controller.abort();
  }
}

/** Only call for GET-like, safe reads; loader receives a shared abort signal. */
export function cachedRead(key, loader, { ttlMs = 60_000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortFailure());
  // In particular, an auth request must not share an anonymous cache entry.
  if (!scope) return Promise.resolve().then(() => loader({ signal }));
  const scopedKey = scope + ":" + key;
  const retry = (current) => {
    if (current.controller.signal.aborted || current.scope !== scope || current.epoch !== epoch) return Promise.reject(abortFailure());
    const version = current.version;
    return cachedRead(key, loader, { ttlMs, signal: current.controller.signal }).then((value) => {
      if (current.controller.signal.aborted || current.scope !== scope || current.epoch !== epoch) throw abortFailure();
      // Another write may land while the replacement itself is resolving.
      if (version !== current.version) return retry(current);
      current.retired = false;
      return value;
    });
  };
  let entry = reads.get(scopedKey);
  if (entry && !entry.pending && entry.expires <= Date.now()) {
    removeRead(scopedKey, entry);
    entry = null;
  }
  if (!entry) {
    entry = { key, scope, epoch, retired: false, version: 0, controller: new AbortController(), pending: true, waiters: 0, chars: 0 };
    reads.set(scopedKey, entry);
    const current = entry;
    flights.add(current);
    try {
      current.promise = Promise.resolve(loader({ signal: current.controller.signal }));
    } catch (error) { current.promise = Promise.reject(error); }
    current.promise = current.promise.then((value) => {
      if (current.retired) return retry(current);
      if (current.controller.signal.aborted || current.scope !== scope || current.epoch !== epoch || reads.get(scopedKey) !== current) throw abortFailure();
      current.pending = false;
      current.value = value;
      current.expires = Date.now() + ttlMs;
      // Bound this tab's memory even when somebody searches many folders.
      try { current.chars = JSON.stringify(value).length; } catch { current.chars = MAX_READ_CHARS + 1; }
      readChars += current.chars;
      while (reads.size > MAX_READS || readChars > MAX_READ_CHARS) {
        const oldest = [...reads].find(([, candidate]) => !candidate.pending);
        if (!oldest) break;
        removeRead(...oldest);
      }
      return value;
    }, (error) => {
      if (current.retired) return retry(current);
      removeRead(scopedKey, current);
      throw error;
    }).finally(() => {
      current.pending = false;
      if (!current.waiters) flights.delete(current);
    });
  }
  const current = entry;
  const answer = current.pending ? current.promise : Promise.resolve(current.value);
  current.waiters += 1;
  flights.add(current);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", cancel);
      current.waiters -= 1;
      if (!current.pending && !current.waiters) flights.delete(current);
      callback(value);
    };
    const cancel = () => {
      finish(reject, abortFailure());
      if (!current.waiters) {
        removeRead(scopedKey, current);
        current.controller.abort();
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const deliver = (value) => {
      if (finished) return;
      if (current.controller.signal.aborted || current.scope !== scope || current.epoch !== epoch) finish(reject, abortFailure());
      else if (current.retired) retry(current).then(deliver, (error) => finish(reject, error));
      else finish(resolve, value);
    };
    answer.then(deliver, (error) => finish(reject, error));
    if (signal?.aborted) cancel();
  });
}
