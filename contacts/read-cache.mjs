/** Bounded read cache. Pending reads are shared; failed reads are never saved. */
export function createReadCache({ maxEntries = 256, maxBytes = 4 * 1024 * 1024, now = Date.now, cloneValues = true } = {}) {
  const entries = new Map();
  const pending = new Map();
  let bytes = 0;
  const copy = (value) => cloneValues ? structuredClone(value) : value;

  function remove(key) {
    const saved = entries.get(key);
    if (saved) bytes -= saved.bytes;
    entries.delete(key);
  }

  return {
    async read(key, { ttl, tags = [], fresh = false }, load) {
      if (!key) return load();
      const cached = entries.get(key);
      if (!fresh && cached && cached.expires > now()) {
        entries.delete(key);
        entries.set(key, cached);
        return copy(cached.value);
      }
      remove(key);
      // An authoritative read after a write must not join a pre-write flight.
      // Replacing its identity below also prevents that older answer from
      // repopulating the cache when it eventually completes.
      if (!fresh && pending.has(key)) return copy(await pending.get(key).promise);
      const flight = { tags, promise: null };
      flight.promise = Promise.resolve().then(load).then((value) => {
        // Invalidation removes the flight too: a read started before a write
        // must not repopulate the cache after that write has completed.
        if (pending.get(key) === flight) {
          const size = Buffer.byteLength(JSON.stringify(value));
          if (size <= maxBytes) {
            while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value);
            entries.set(key, { value: copy(value), bytes: size, expires: now() + ttl, tags });
            bytes += size;
          }
        }
        return value;
      });
      pending.set(key, flight);
      try { return copy(await flight.promise); }
      finally { if (pending.get(key) === flight) pending.delete(key); }
    },
    invalidate(tags = null) {
      const matches = (entry) => !tags || entry.tags.some((tag) => tags.includes(tag));
      for (const [key, entry] of entries) if (matches(entry)) remove(key);
      for (const [key, entry] of pending) if (matches(entry)) pending.delete(key);
    }
  };
}
