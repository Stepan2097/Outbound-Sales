/**
 * The last thing a visit does: read the messenger and tell the portal.
 *
 * Everything before this is outbound — a profile viewed, a post liked, a
 * request sent — and then the trail stops. Somebody writes back and nothing
 * sees it; the account's own operator finds out by opening LinkedIn, and
 * nobody else finds out at all. This step closes that, and it runs at the end
 * on purpose: the quota work is what the day is for, and a messenger that
 * fails must not cost the account its likes.
 *
 * Three things shape how it behaves, and all three are about being wrong
 * safely.
 *
 * **Reading is not free.** LinkedIn marks a conversation read the moment it is
 * displayed, so every thread opened here is one the operator no longer sees as
 * new in their own inbox. That is why the cap is 20 and why it stops at the
 * first conversation older than the last sync, and why it asks whether the
 * portal even has an inbox before opening the messenger at all.
 *
 * **A zero is ambiguous and dangerous.** An inbox nobody wrote to and a reader
 * whose selectors have rotted both produce zero threads, quietly, every morning,
 * for as long as nobody looks. So the zero is never reported bare: it carries
 * how much text was on the page, which pass found the messages, and what the
 * reader was looking for when it found nothing.
 *
 * **A crash here must not fail the run.** The visit already happened. Every
 * conversation is opened inside its own try, and the sweep ends by telling the
 * portal it finished even when it finished badly — a sync mark with zero on it
 * is what separates "nothing arrived" from "nobody looked".
 */
import { VisitStopped } from './connections.mjs';
import { harvestConversations, harvestThread, conversationRow, pickConversations, buildThread } from './inbox-dom.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/**
 * Wait for the messenger, then say what we are looking at.
 *
 * The same shape as `settle()` in `run-account.mjs`, and for the same reason:
 * a fixed wait after `domcontentloaded` reads the page mid-render and reports a
 * full inbox as empty. Poll for something conclusive instead.
 *
 * The conclusive thing is a link to a conversation — except on an inbox that
 * genuinely has none, where waiting for one is waiting forever. So the
 * messenger's own furniture (the search box, the composer) counts as proof the
 * page painted, but only after it has stood there a few seconds with nothing in
 * the list: the chrome arrives before the conversations do, and a hasty "empty"
 * is the same silent zero by another route.
 */
async function settleMessenger(page, { timeoutMs = 30_000, pace = 1 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let chromeSince = null;
  let last = null;

  while (Date.now() < deadline) {
    try {
      const seen = await page.evaluate(() => ({
        threads: document.querySelectorAll('a[href*="/messaging/thread/"]').length,
        // 11.10.2026: a list without links, in a LinkedIn set to Ukrainian, was
        // «не дочекався месенджера» with two conversations on screen. The rows
        // count by the shape `harvestConversations` reads them by, and the
        // search box by its name, not by English words in its placeholder.
        cards: [...document.querySelectorAll('li')]
          .filter((li) => li.querySelector('time') && li.querySelector('img[alt]') && !li.querySelector('li')).length,
        chrome: Boolean(document.querySelector(
          'input[name="searchTerm"], input[placeholder*="essage" i], input[placeholder*="повідомл" i], '
          + '[contenteditable="true"][role="textbox"], a[href*="/messaging/thread/new"]',
        )),
        login: Boolean(document.querySelector('input#username, input[name="session_key"], input[name="session_password"]')),
        chars: (document.body?.innerText ?? '').length,
        url: location.href,
      }));
      if (seen.login) return { ok: false, reason: 'форма входу', seen };
      if (/\/checkpoint\//.test(seen.url)) return { ok: false, reason: 'checkpoint', seen };
      if (seen.threads > 0) return { ok: true, reason: `${seen.threads} посилань на розмови`, seen };
      if (seen.cards > 0) return { ok: true, reason: `${seen.cards} рядків розмов без посилань`, seen };
      if (seen.chrome) {
        chromeSince ??= Date.now();
        if (Date.now() - chromeSince > 6000 * pace) return { ok: true, reason: 'месенджер без розмов', seen };
      }
      last = seen;
    } catch {
      // The page navigated out from under the query — LinkedIn's own routing.
      // That is what we are waiting for, not a failure.
    }
    await sleep(Math.max(50, 1500 * pace));
  }
  return { ok: false, reason: 'не дочекався месенджера', seen: last };
}

/**
 * The thread id out of the address bar.
 *
 * The one place it still exists for a list that has no links: LinkedIn routes
 * to `/messaging/thread/<id>/` whether the row that opened it was an anchor or
 * a div with a click handler. Read after the click, never before it.
 */
export function threadKeyFromUrl(url = '') {
  const raw = (String(url).match(/\/messaging\/thread\/([^/?#]+)/) || [])[1];
  if (!raw || /^(new|compose)$/i.test(raw)) return null;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** Wait for one conversation to paint, using the same reader the sweep uses. */
export async function settleThread(page, row, { timeoutMs = 20_000, pace = 1 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const harvest = await page.evaluate(harvestThread);
      const url = page.url();
      // A row that came without a key is "here" as soon as any thread is open:
      // which thread it turned out to be is read from the address bar after.
      const here = row.threadKey
        ? (url.includes(encodeURIComponent(row.threadKey)) || url.includes(row.threadKey))
        : Boolean(threadKeyFromUrl(url));
      if (here && harvest.items.length) return { ok: true, harvest };
      last = harvest;
    } catch { /* still routing */ }
    await sleep(Math.max(50, 1200 * pace));
  }
  return { ok: false, harvest: last };
}

/**
 * Open a conversation the way a person does.
 *
 * By clicking the row, not by navigating to the thread URL: the messenger is a
 * single page application, so a click is one small request and a `goto` is a
 * full page load of LinkedIn, twenty times in a row, from an account that is
 * supposed to be behaving like somebody reading their messages. The navigation
 * is kept as the fallback for when the row has scrolled out from under us.
 */
async function openConversation(page, row, origin, pace = 1) {
  const here = () => (row.threadKey
    ? (page.url().includes(encodeURIComponent(row.threadKey)) || page.url().includes(row.threadKey))
    : Boolean(threadKeyFromUrl(page.url())));
  // A row with no link is the marked element the harvest read, clicked where
  // it sits. There is no navigation to fall back on: the id it would need is
  // exactly what the page no longer carries.
  const link = row.href
    ? await page.$(`a[href="${row.href}"]`)
    : (row.rowMark != null ? await page.$(`[data-outbound-row="${row.rowMark}"]`) : null);

  if (link) {
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(rand(400, 900) * pace);
    const box = await link.boundingBox().catch(() => null);
    if (box) {
      // Moved and pressed where the row is, for the same reason the like does
      // it: a click dispatched at a detached centre is what a bot check is
      // built to notice.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
      await sleep(rand(150, 400) * pace);
      await page.mouse.down(); await sleep(rand(40, 110) * pace); await page.mouse.up();
    } else {
      await link.click({ timeout: 8000 }).catch(() => {});
    }

    /**
     * Did it land? A click at a point is a click on whatever is topmost at
     * that point, and a row can be under something — a banner, a hover card, a
     * filter bar that appeared while the list settled. Nothing throws; the
     * page simply does not move, and the sweep then spends its twenty second
     * wait discovering that a conversation "did not paint". Checking here
     * turns a silent stall into a navigation.
     */
    for (let i = 0; i < 8; i += 1) {
      if (here()) return 'клік';
      await sleep(Math.max(100, 500 * pace));
    }
  }

  if (!row.threadKey) return link ? 'клік не спрацював' : 'рядок зник зі списку';
  await page.goto(`${origin}/messaging/thread/${encodeURIComponent(row.threadKey)}/`,
    { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return link ? 'клік не спрацював, перехід' : 'перехід';
}

/**
 * One sweep of the messenger.
 *
 * `self` is who LinkedIn says we are, read off the feed earlier in the run.
 * It is required: direction is the one field here that is worse wrong than
 * missing, because an outbound message filed as inbound tells the portal a
 * stranger replied, which moves an outreach row to `connected` and writes an
 * activity into the CRM that a seller reads as a lead answering.
 */
/**
 * Down the conversation list, the way somebody scrolling back through their
 * messages would. The list is its own scrolling box (16.10.2026:
 * `ul.msg-conversations-container__conversations-list`, the leftmost box on
 * the page with rows in it) and loads more when that box reaches its end —
 * the rows are not always links, so the box is found by its shape, not by a
 * link inside it. A wheel over it first, then its end, which is what loads.
 */
async function scrollConversationList(page, pace) {
  const box = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('*')].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)
      && el.scrollHeight > el.clientHeight + 40 && el.querySelectorAll('li').length >= 3);
    const list = boxes.sort((left, right) => left.getBoundingClientRect().x - right.getBoundingClientRect().x)[0];
    if (!list) return null;
    list.setAttribute('data-outbound-list', '1');
    const rect = list.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 300) };
  }).catch(() => null);
  if (!box) return;
  await page.mouse.move(box.x, box.y, { steps: 6 });
  for (let step = 0; step < 3; step += 1) {
    await page.mouse.wheel(0, 700);
    await sleep(Math.max(20, 250 * pace));
  }
  await page.evaluate(() => {
    const list = document.querySelector('[data-outbound-list]');
    if (list) list.scrollTop = list.scrollHeight;
  }).catch(() => {});
}

export async function syncInbox(page, {
  portal,
  self,
  guard = async () => {},
  log = () => {},
  shot = async () => {},
  since = null,
  limit = 20,
  // The past month, read back a portion a session (owner 16.10): `{ from, before, maxThreads }`
  // in ms — conversations from `from` up to `before` (or up to what the fresh read covers).
  backfill = null,
  nowMs = Date.now(),
  // Where the messenger lives. A parameter with one real value, so that the
  // sweep — the polling, the clicking, the order things happen in — can be run
  // end to end against saved copies of the page served from this machine. A
  // live session on a warming account is not a test budget; see
  // `inbox-sweep.test.mjs`.
  origin = 'https://www.linkedin.com',
  // How long the human-sized pauses are, as a multiplier. It exists so the
  // tests can run the whole sweep in seconds; a run leaves it alone. Setting it
  // below 1 on a real account would read twenty conversations in twenty
  // seconds, which is not something a person does and is the one signal this
  // whole folder is built to avoid sending.
  pace = 1,
} = {}) {
  const result = {
    listed: 0, threadsSeen: 0, stored: 0, skipped: 0, invalid: 0, undated: 0,
    notes: [], suspicious: false, reason: null,
  };

  if (!self?.slug && !self?.name) {
    result.reason = 'не знаю, хто ми — напрямок повідомлень визначити нічим';
    log(`  ⛔ вхідні: ${result.reason}`);
    await portal.inboxDone(0).catch(() => {});
    return result;
  }

  log(`вхідні: відкриваю месенджер${since ? ` (з ${new Date(since).toISOString()})` : ' (перша синхронізація)'}`);
  await page.goto(`${origin}/messaging/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await guard();
  const settled = await settleMessenger(page, { pace });
  await guard();
  await sleep(rand(1500, 3000) * pace);
  await shot(page, '5-inbox');

  if (!settled.ok) {
    result.reason = settled.reason;
    result.suspicious = true;
    log(`  ⚠️ месенджер не відкрився: ${settled.reason}`);
    await portal.log('agent.inbox', `Messenger did not open — ${settled.reason}`, { seen: settled.seen ?? null }, 'warn').catch(() => {});
    await portal.inboxDone(0).catch(() => {});
    return result;
  }

  let raw = await page.evaluate(harvestConversations).catch((e) => ({ rows: [], notes: [`читання списку впало: ${e.message}`], chars: 0 }));
  // Reading back the month: the list loads further down as it is scrolled, so
  // it is scrolled until it reaches the month's start, stops growing (the end of
  // all conversations) or holds 300 rows.
  let listEnded = false;
  if (backfill?.from) {
    let stalled = 0;
    for (let round = 0; round < 40; round += 1) {
      const now = (raw.rows ?? []).map((r) => conversationRow(r, nowMs));
      const oldest = Math.min(...now.map((r) => r.at ?? Infinity));
      if (now.length >= 300 || (Number.isFinite(oldest) && oldest < backfill.from)) break;
      await guard();
      await scrollConversationList(page, pace);
      await sleep(rand(1500, 2800) * pace);
      const next = await page.evaluate(harvestConversations).catch(() => null);
      if (!next) break;
      stalled = (next.rows ?? []).length > now.length ? 0 : stalled + 1;
      raw = next;
      if (stalled >= 3) { listEnded = true; break; }
    }
  }
  result.notes.push(...(raw.notes ?? []));
  const rows = (raw.rows ?? []).map((r) => conversationRow(r, nowMs));
  result.listed = rows.length;

  // The zero that matters. An inbox nobody has written to has no conversations
  // and no timestamps either; a page carrying nine timestamps and no links to
  // conversations is a list that stopped being links. The two look identical in
  // a count of threads and they need different people to do different things,
  // so the difference is said out loud here rather than left in the number.
  if (!rows.length && ((raw.times ?? 0) >= 2 || (raw.chars ?? 0) > 400)) {
    result.suspicious = true;
    log(`  ⚠️ жодної розмови, але на сторінці ${raw.times ?? 0} міток часу і ${raw.chars ?? 0} символів — схоже, селектори протухли`);
  }

  const fresh = pickConversations(rows, { since, limit });
  const { skipped } = fresh;
  // The month's older ones, after the fresh: not already picked, dated, inside
  // [from, before) — `before` is where the previous session stopped.
  const backlog = new Set();
  let backlogMore = false;
  if (backfill?.from) {
    const chosen = new Set(fresh.picked.map((row) => row.threadKey ?? row.rowMark));
    const ceiling = backfill.before ?? nowMs + 1;
    const pool = rows.filter((row) => !chosen.has(row.threadKey ?? row.rowMark) && row.at != null && row.at >= backfill.from && row.at < ceiling);
    for (const row of pool.slice(0, backfill.maxThreads ?? 30)) backlog.add(row);
    backlogMore = pool.length > backlog.size;
  }
  const picked = [...fresh.picked, ...backlog];
  let oldestRead = null;
  log(`  розмов у списку: ${rows.length}, беру ${fresh.picked.length}${backlog.size ? ` + ${backlog.size} за минулий місяць` : ''}${skipped.length ? `, пропускаю ${skipped.length}` : ''}`);

  const opened = new Set();
  for (const row of picked) {
    // Two names for one row: the key is what a reader of the notes greps for,
    // the person is what a reader of the log recognises. A row from a list
    // without links has no key until it is open, so there the two are the same.
    const label = row.threadKey ?? row.name ?? `рядок ${row.rowMark ?? '?'}`;
    const who = row.name ?? label;
    try {
      await guard();
      const how = await openConversation(page, row, origin, pace);
      await guard();
      await sleep(rand(1200, 2400) * pace);
      const { ok, harvest } = await settleThread(page, row, { pace });
      if (!ok) {
        result.notes.push(`${label}: розмова не відкрилась (${how})`);
        log(`  ⚠️ не відкрилась: ${who}`);
        continue;
      }
      // For a list without links this is where the conversation finally gets
      // its name: before the click there was nothing to call it.
      const threadKey = row.threadKey ?? threadKeyFromUrl(page.url());
      if (!threadKey) {
        result.notes.push(`${label}: розмова відкрилась, але ключа в адресі немає`);
        continue;
      }
      if (opened.has(threadKey)) {
        result.notes.push(`${label}: той самий ключ ${threadKey} вже читали цього прогону`);
        continue;
      }
      opened.add(threadKey);

      // Read down it the way somebody reading their messages would, rather
      // than opening twenty conversations in twenty seconds.
      await sleep(rand(1500, 3200) * pace);

      const built = buildThread({ threadKey, harvest, self, listRow: row, nowMs });
      if (built.skip) {
        result.notes.push(`${threadKey}: ${built.skip}`);
        continue;
      }
      result.notes.push(...built.notes.map((n) => `${threadKey}: ${n}`));

      const res = await portal.inboxThread(backlog.has(row) ? { ...built.payload, backfill: true } : built.payload);
      if (!res.success) {
        // "Unknown action" means this portal has no inbox — asking it nineteen
        // more times teaches nobody anything.
        if (/unknown action/i.test(res.error ?? '')) {
          result.reason = 'портал не приймає inbox.thread';
          log(`  ⛔ ${result.reason} — припиняю читати`);
          break;
        }
        result.notes.push(`${threadKey}: портал відмовив — ${res.error}`);
        log(`  ⚠️ портал відмовив (${who}): ${res.error}`);
        continue;
      }

      result.threadsSeen += 1;
      if (backlog.has(row) && row.at != null) oldestRead = Math.min(oldestRead ?? Infinity, row.at);
      result.stored += Number(res.stored ?? 0);
      result.skipped += Number(res.skipped ?? 0);
      result.invalid += Number(res.invalid ?? 0);
      result.undated += Number(res.undated ?? 0);
      const inbound = built.inbound ? `, вхідних ${built.inbound}` : '';
      log(`  💬 ${built.payload.participant.name}: +${res.stored ?? 0} нових, ${res.skipped ?? 0} вже було${inbound}`);

      await sleep(rand(1800, 4200) * pace);
    } catch (e) {
      if (e instanceof VisitStopped) throw e;
      result.notes.push(`${label}: ${e.message}`);
      log(`  ⚠️ розмова ${who}: ${e.message}`);
    }
  }

  // Always, even after a bad sweep: the mark is what tells the portal somebody
  // looked, and a zero with a mark on it is a different fact from a zero
  // without one.
  await guard();
  // Read to the month's start, or to the end of all conversations, with
  // nothing left over: done. Otherwise the next session goes on from the
  // oldest one read here.
  let backfillReport = null;
  if (backfill?.from) {
    const oldestListed = Math.min(...rows.map((row) => row.at ?? Infinity));
    const complete = !backlogMore && (listEnded || rows.length >= 300
      || (Number.isFinite(oldestListed) && oldestListed < backfill.from) || (!backlog.size && !rows.length));
    backfillReport = {
      from: new Date(backfill.from).toISOString(),
      before: oldestRead != null ? new Date(oldestRead).toISOString() : (backfill.before ? new Date(backfill.before).toISOString() : null),
      complete, read: [...backlog].length,
      // 16.10: the first version's scroll did not reach the list's box and called
      // a ten-row list the end of all conversations — the portal reads only these.
      version: 2
    };
    log(`  минулий місяць: ${complete ? 'дочитано' : `прочитано до ${backfillReport.before ?? '—'}, решта — наступного разу`}`);
  }
  const done = await portal.inboxDone(result.threadsSeen, backfillReport).catch((e) => ({ success: false, error: e.message }));
  if (!done?.success) result.notes.push(`inbox.done: ${done?.error ?? 'не пройшов'}`);

  // `invalid` climbing is the portal's own view of the same rot: messages that
  // arrived with no body or no direction. It is worth a warning before it is
  // worth a morning.
  if (result.invalid > 0) {
    log(`  ⚠️ портал відкинув ${result.invalid} повідомлень як некоректні`);
  }

  log(`вхідні: прочитано розмов ${result.threadsSeen}/${result.listed}, нових повідомлень ${result.stored}`);
  await portal.log(
    'agent.inbox',
    `Inbox sweep — ${result.threadsSeen} thread(s) read of ${result.listed} listed, ${result.stored} new message(s)`,
    {
      listed: result.listed, threadsSeen: result.threadsSeen, stored: result.stored,
      skippedDuplicates: result.skipped, invalid: result.invalid, undated: result.undated,
      since: since ? new Date(since).toISOString() : null,
      chars: raw.chars ?? null,
      notes: result.notes.slice(0, 20),
    },
    result.suspicious || result.invalid > 0 ? 'warn' : 'info',
  ).catch(() => {});

  return result;
}
