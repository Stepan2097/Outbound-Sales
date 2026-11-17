import { allTableWrites } from "../warmup/rest.mjs";

/**
 * Answers of the heavy screens, kept between requests (власник 17.11: «всі сторінки і дані мають
 * кешуватися для того щоб весь інтерфейс літав»).
 *
 * A person's own change is never answered with the screen from before it: a finished write
 * request from the interface throws every kept answer away, and the next request makes a fresh
 * one. Everything else that changes the data — the agents writing events every few seconds, the
 * reconciler, somebody's CRM — makes a kept answer stale, not void: it is given at once and made
 * again behind it, so the next look has the change. Untouched, an answer is fresh for `ttlMs`.
 */
const entries = new Map();
const MAX_ENTRIES = 300;
let requestWrites = 0;

/** A person's write request finished: every kept answer is from before it. */
export function noteWrite() {
  requestWrites += 1;
}

export async function cachedAnswer(key, make, { ttlMs = 20_000, staleMs = 10 * 60_000 } = {}) {
  // The test runner changes its fixtures without writing; there every answer is made.
  if (process.env.NODE_TEST_CONTEXT && !process.env.ANSWER_CACHE_IN_TESTS) return make();
  const kept = entries.get(key);
  if (kept && kept.requests === requestWrites) {
    if (kept.promise) return kept.promise;
    const age = Date.now() - kept.at;
    if (age < ttlMs && kept.tables === allTableWrites()) return kept.value;
    if (age < staleMs) {
      if (!kept.refreshing) {
        kept.refreshing = true;
        const requests = requestWrites;
        Promise.resolve().then(make).then((value) => store(key, value, requests), () => { kept.refreshing = false; });
      }
      return kept.value;
    }
  }
  const requests = requestWrites;
  const pending = { requests, promise: null };
  pending.promise = Promise.resolve().then(make).then((value) => {
    store(key, value, requests);
    return value;
  }, (error) => {
    if (entries.get(key) === pending) entries.delete(key);
    throw error;
  });
  entries.set(key, pending);
  return pending.promise;
}

// A refresh that a person's write overtook is not kept: it may be from before that write.
function store(key, value, requests) {
  if (requests !== requestWrites) return;
  entries.delete(key);
  entries.set(key, { value, at: Date.now(), requests, tables: allTableWrites() });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}
