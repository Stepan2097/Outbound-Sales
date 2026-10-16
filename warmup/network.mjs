import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { writeFileAtomic } from "../state/atomic-write.mjs";

/**
 * Усі друзі LinkedIn акаунта (власник 14.10: «тут було б добре побачити весь
 * список друзів»). «Друзі й запрошення» знають лише тих, кого запросила ця
 * система; решту контактів агент читає зі сторінки LinkedIn «Контакти» раз на
 * кілька днів, або коли на сторінці акаунта натиснули «Оновити».
 *
 * Список — це знімок, а не історія: окремий файл поруч зі станом робочого
 * простору, по акаунту. До бази Anty не пишемо — нова таблиця там була б
 * змінами продової бази, а цьому списку достатньо файлу.
 *
 * Агент шле список частинами (`batch`, перша з `first: true`) і закриває
 * читання `done`. Повне читання замінює список; неповне (агент зупинився на
 * межі чи на помилці) лише доповнює його — нікого не викреслює, бо «не дочитав»
 * не означає «видалили з друзів».
 */

export const NETWORK_EVERY_DAYS = 3;
export const NETWORK_MAX = 3000;
const BATCH_MAX = 500;
const DAY = 86_400_000;

const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** One person as the agent read them; null when there is no profile to point at. */
export function cleanPerson(raw) {
  let slug = String(raw?.slug ?? "").trim();
  try { slug = decodeURIComponent(slug); } catch {}
  slug = slug.toLowerCase().replace(/^\/+|\/+$/g, "").slice(0, 100);
  if (!slug || /[\s/?#]/.test(slug)) return null;
  const connectedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.connectedAt ?? "")) ? raw.connectedAt : null;
  return { slug, name: text(raw?.name, 120), headline: text(raw?.headline, 220), connectedAt };
}

/** Is today's session to read the list: never read, read long ago, or asked for since. */
export function networkDue(entry, now = new Date()) {
  if (!entry?.syncedAt) return true;
  const synced = Date.parse(entry.syncedAt);
  if (entry.requestedAt && Date.parse(entry.requestedAt) > synced) return true;
  return now.getTime() - synced >= NETWORK_EVERY_DAYS * DAY;
}

export function networkStore(path, { now = () => new Date() } = {}) {
  let data = null;
  let chain = Promise.resolve();

  // Read from the file every time, never kept between calls: during a deploy
  // two copies of the server share the file, and one that wrote from what it
  // remembered put back a list the other had already replaced (14.10: Chloe's
  // full 423 was overwritten with an earlier 40 that way).
  async function load() {
    data = { accounts: {} };
    if (path && existsSync(path)) {
      try {
        const saved = JSON.parse(await readFile(path, "utf8"));
        if (saved && typeof saved.accounts === "object") data = saved;
      } catch {}
    }
    return data;
  }
  async function save() {
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, JSON.stringify(data));
  }
  // One writer at a time: two batches of one read must not race each other's save.
  const serial = (work) => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };
  const entryOf = async (accountId) => {
    const all = await load();
    all.accounts[accountId] ||= { syncedAt: null, requestedAt: null, complete: false, total: null, people: [] };
    return all.accounts[accountId];
  };

  return {
    async view(accountId) {
      const entry = (await load()).accounts[accountId];
      if (!entry) return { syncedAt: null, requestedAt: null, complete: false, total: null, people: [], due: true };
      return { syncedAt: entry.syncedAt, requestedAt: entry.requestedAt, complete: entry.complete, total: entry.total, people: entry.people, due: networkDue(entry, now()) };
    },
    async due(accountId) {
      return networkDue((await load()).accounts[accountId], now());
    },
    request(accountId) {
      return serial(async () => {
        const entry = await entryOf(accountId);
        entry.requestedAt = now().toISOString();
        await save();
        return entry.requestedAt;
      });
    },
    /** A part of the list; `first` starts a new read. Kept aside until `done`. */
    batch(accountId, people, { first = false } = {}) {
      return serial(async () => {
        const entry = await entryOf(accountId);
        if (first || !entry.staging) entry.staging = { startedAt: now().toISOString(), people: [] };
        const seen = new Set(entry.staging.people.map((person) => person.slug));
        let added = 0;
        for (const raw of (Array.isArray(people) ? people : []).slice(0, BATCH_MAX)) {
          const person = cleanPerson(raw);
          if (!person || seen.has(person.slug) || entry.staging.people.length >= NETWORK_MAX) continue;
          seen.add(person.slug);
          entry.staging.people.push(person);
          added += 1;
        }
        await save();
        return { added, held: entry.staging.people.length };
      });
    },
    /** The read is over: a complete one replaces the list, a partial one only adds to it. */
    done(accountId, { total = null, complete = false } = {}) {
      return serial(async () => {
        const entry = await entryOf(accountId);
        const read = entry.staging?.people || [];
        if (complete) entry.people = read;
        else {
          const bySlug = new Map(entry.people.map((person) => [person.slug, person]));
          for (const person of read) bySlug.set(person.slug, { ...bySlug.get(person.slug), ...person });
          entry.people = [...bySlug.values()];
        }
        const count = Number(total);
        entry.total = Number.isFinite(count) && count >= 0 ? Math.trunc(count) : entry.total;
        entry.complete = Boolean(complete);
        entry.syncedAt = now().toISOString();
        delete entry.staging;
        await save();
        return { count: entry.people.length, read: read.length, syncedAt: entry.syncedAt };
      });
    }
  };
}
