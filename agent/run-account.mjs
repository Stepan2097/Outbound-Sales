#!/usr/bin/env node
/**
 * One account's visit for today, start to finish.
 *
 *   node agent/run-account.mjs --account "Profile 47"
 *
 * The portal decides what may happen; this decides how. It asks the portal what
 * is left of today's quota, opens the profile's own Chrome through the profile's
 * own proxy, does that much and no more, and reports each action the moment it
 * lands. Nothing about the strategy lives here — change the plan on screen and
 * the next run follows it without being redeployed.
 *
 * It uses its own playwright-core dependency against the profile's real user-data-dir. The
 * browser is therefore the one the account already lives in rather than a clean
 * one wearing its cookies.
 */
import { chromium } from 'playwright-core';
import { DEFAULT_PORTAL, CHROME_PATH } from './lib/env.mjs';
import { checkInvitations, sendQueuedInvitations, stopOnWarning, VisitStopped, reportWithRetry } from './lib/connections.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Portal } from './lib/portal.mjs';
import { readProfile, normalizeCookie } from './lib/anty.mjs';
import { syncInbox } from './lib/inbox.mjs';
import { sendReplies } from './lib/outbox.mjs';
import { AntyApi } from './lib/anty-api.mjs';
import { settle } from './lib/login-probe.mjs';

// ── arguments ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const ACCOUNT = arg('account');
const PORTAL = arg('portal', DEFAULT_PORTAL);
const ANYTIME = argv.includes('--anytime');
if (!ACCOUNT) {
  console.error('usage: node agent/run-account.mjs --account "<profile name or id>" [--portal URL] [--shots DIR] [--no-inbox|--inbox] [--anytime] [--no-replies]');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOTS = arg('shots', path.join(process.cwd(), 'agent', 'runs', `${stamp}-${ACCOUNT.replace(/\W+/g, '_')}`));
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portal = new Portal(PORTAL);
const report = { account: ACCOUNT, shots: SHOTS, actions: [], errors: [], shotFiles: [] };

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file }).catch((e) => report.errors.push(`screenshot ${name}: ${e.message}`));
  report.shotFiles.push(file);
  log(`  📸 ${path.basename(file)}`);
  return file;
}

/**
 * Do one thing and tell the portal, in that order.
 *
 * The portal can still refuse — the quota is checked there, not here — and a
 * refusal ends that kind of action for the day rather than being retried,
 * because the only thing that clears it is tomorrow.
 */
async function count(kind, detail) {
  const res = await portal.record(kind, detail);
  if (!res.success) {
    log(`  ⛔ портал не зарахував ${kind}: ${res.error}`);
    throw new VisitStopped(`Server refused ${kind}: ${res.error}`);
  }
  report.actions.push({ kind, detail });
  log(`  ✅ ${kind} ${res.done}/${res.quota} — ${detail}`);
  return true;
}

// ── the account, and what it is allowed to do today ────────────────────────
let ownLeaseId = null;
let closeBrowser = null;
const suppliedLeaseId = arg('lease-id');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void closeBrowser?.().catch(error => { console.error(`Browser cleanup: ${error.message}`); });
  });
}
async function main() {
const found = await portal.resolve(ACCOUNT);
if (!suppliedLeaseId) {
  const lease = await portal.lease(found.accountId);
  if (!lease.success || !lease.lease?.leaseId) throw new Error(lease.error || 'Server did not grant a lease');
  ownLeaseId = lease.lease.leaseId;
}
portal.leaseId = suppliedLeaseId || ownLeaseId;
log(`акаунт: ${found.name} (${found.accountId})`);

const plan = await portal.plan();
if (!plan.runnable) {
  log(`нічого робити: ${plan.reason}`);
  return 0;
}
// The window is the portal's, not the script's. A schedule nothing enforces is
// a suggestion, and a profile that opens at 22:00 is a signal in itself —
// --anytime is there for a deliberate catch-up, not for the daily run.
if (!plan.window?.open && !ANYTIME) {
  log(`зараз поза вікном прогріву (${plan.window?.label ?? '?'}) — не запускаю`);
  return 0;
}
if (!plan.window?.open) log(`поза вікном прогріву (${plan.window?.label ?? '?'}) — запуск вручну, --anytime`);

log(`день ${plan.day} — «${plan.phase}»`);
for (const row of plan.plan ?? []) log(`  план: ${row.label} ${row.done}/${row.quota} (лишилось ${row.remaining})`);

const remaining = Object.fromEntries((plan.plan ?? []).map((r) => [r.kind, r.remaining]));
if (!Object.values(remaining).some((n) => n > 0) && !plan.inbox?.due && !(plan.invites?.toCheck?.length) && !(plan.outbox?.toSend?.length)) {
  log('денний план уже виконано');
  await portal.log('agent.skipped', `Day ${plan.day} was already complete when the agent ran`);
  return 0;
}

// ── the browser this account lives in ──────────────────────────────────────
const runtime = process.env.WARMUP_ANTY_API
  ? await new AntyApi(process.env.WARMUP_ANTY_API).open(found.profileRemoteId, chromium)
  : null;
if (runtime) closeBrowser = runtime.close;
const profile = runtime?.profile || readProfile(found.profileRemoteId);
if (!profile) throw new Error(`Anty has no local copy of profile ${found.profileRemoteId} — open it in Anty once`);
if (!runtime && profile.openInAnty) {
  throw new Error(`${profile.name} is open in Anty right now — two browsers on one profile corrupt the session`);
}
if (!runtime && !profile.proxy) throw new Error(`${profile.name} has no proxy; refusing to show LinkedIn this machine's IP`);

// A profile that has never been launched on this machine has no user-data-dir.
// Its session is in Anty's database instead, and has to be poured in — the same
// thing Anty's launcher does on a first run.
const firstRun = !runtime && !fs.existsSync(profile.userDataDir);
log(`профіль ${profile.name} → ${runtime ? 'Linux Anty API' : path.basename(profile.userDataDir)}${firstRun ? ' (створюю, переношу куки)' : ''}`);

const context = runtime?.context || await chromium.launchPersistentContext(profile.userDataDir, {
  headless: false,
  executablePath: CHROME_PATH,
  viewport: { width: 1440, height: 900 },
  proxy: profile.proxy,
  // Anty launches these profiles with the fingerprint's own user agent and the
  // proxy's timezone. Presenting anything else would have the account change
  // operating system and time zone between visits, which is exactly the pattern
  // a warm-up exists to avoid.
  ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
  ...(profile.timezoneId ? { timezoneId: profile.timezoneId } : {}),
  args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
});

if (!runtime) closeBrowser = () => context.close();
let failed = false;
try {
// The user agent says Windows; without this navigator still says the host. The
// pair is the first thing a fingerprinting script cross-checks.
if (!runtime && /Windows/i.test(profile.userAgent ?? '') && os.platform() !== 'win32') {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      if (navigator.userAgentData) {
        const original = navigator.userAgentData;
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => ({
            brands: original.brands,
            mobile: false,
            platform: 'Windows',
            getHighEntropyValues: (hints) =>
              original
                .getHighEntropyValues(hints)
                .then((v) => ({ ...v, platform: 'Windows', platformVersion: '15.0.0' })),
            toJSON: () => ({ brands: original.brands, mobile: false, platform: 'Windows' }),
          }),
        });
      }
    } catch {}
  });
}

if (firstRun) {
  const cookies = (profile.cookies ?? []).map(normalizeCookie).filter(Boolean);
  if (cookies.length) await context.addCookies(cookies);
  const origins = (profile.storageState?.origins ?? []).filter((o) => o?.origin && Array.isArray(o.localStorage));
  if (origins.length) {
    await context.addInitScript((saved) => {
      try {
        const match = saved.find((entry) => entry.origin === window.location.origin);
        if (!match) return;
        for (const item of match.localStorage) {
          try { window.localStorage.setItem(item.name, String(item.value ?? '')); } catch {}
        }
      } catch {}
    }, origins);
  }
  log(`  перенесено ${cookies.length} куків і ${origins.length} сховищ`);
}

const session = await portal.openSession(os.hostname());
if (!session.success) throw new Error(session.error || 'Server refused to open the session');
log(`сесію відкрито (${session.sessionId}${session.resumed ? ', продовжено' : ''})`);

  const page = context.pages()[0] ?? (await context.newPage());
  const guard = async () => {
    await stopOnWarning(page, portal);
    const fresh = await portal.plan();
    if (!fresh.success || !fresh.runnable) throw new VisitStopped(fresh.error || fresh.reason || 'Server stopped this visit');
  };

  // ── the proxy actually carries the traffic ───────────────────────────────
  await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const ip = (await page.textContent('body').catch(() => ''))?.match(/[\d.]+/)?.[0] ?? null;
  log('IP через проксі:', ip);
  await portal.log('agent.proxy', `Proxy exit ${ip ?? 'unknown'}`, { ip, server: profile.proxy.server });

  // ── are we signed in, and as whom ────────────────────────────────────────
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const { signedIn, url, reason, seen } = await settle(page);
  // The bounce can still be in flight for a moment after the feed paints;
  // anything read during it throws "execution context was destroyed".
  await sleep(rand(2500, 4000));

  // Who this profile is. Every class name that used to answer this is now a
  // hash, so it is read from the two things LinkedIn cannot obfuscate: the
  // first link to a profile on the page is the account's own identity card,
  // and the avatar's alt text is the account's own name.
  const identity = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/in/"]');
    const slug = link?.href.match(/\/in\/([^/?#]+)/)?.[1] ?? null;
    const alt = [...document.querySelectorAll('img[alt]')]
      .map((img) => (img.getAttribute('alt') || '').trim())
      .find((text) => text && text.length > 2 && !/linkedin|logo|banner|background|icon/i.test(text));
    const card = link?.innerText?.trim().split('\n')[0] || null;
    return { slug, name: alt || card || null };
  }).catch(() => ({ slug: null, name: null }));
  const me = identity.name;
  const selfSlug = identity.slug;
  await shot(page, '1-feed');

  await guard();
  if (!signedIn) {
    await portal.health(reason === 'checkpoint' ? 'captcha' : 'needs_login', `LinkedIn: ${reason} at ${url}`);
    await portal.log('agent.login', `Not signed in — ${reason} at ${url}`, { url, reason, seen }, 'error');
    throw new Error(`не залогінено (${reason}): ${url}`);
  }
  log(`✅ залогінено${me ? ' як ' + me : ''}`);
  await portal.health('ok', me ? `Signed in as ${me}` : 'Signed in');
  // The slug goes with the name: the name is what a person recognises, and the
  // slug is the only half that can be linked to or matched against a contact.
  // Both were already read from the page; only one of them used to be kept.
  await portal.log('agent.login', `Signed in${me ? ` as ${me}` : ''} from ${ip ?? 'unknown IP'}`, { who: me, slug: selfSlug, ip, url });

  // ── read the feed, the way the day starts for a person ───────────────────
  let scrolled = 0;
  for (let i = 0; i < 5; i += 1) {
    await page.mouse.wheel(0, rand(500, 900));
    scrolled += 1;
    await sleep(rand(1200, 2600));
  }
  await portal.log('agent.feed', `Read the feed — ${scrolled} scrolls`, { scrolled });
  await shot(page, '2-feed-read');

  // ── profile views ────────────────────────────────────────────────────────
  if (remaining.profile_view > 0) {
    log(`переглядаю профілі: треба ${remaining.profile_view}`);
    const seen = new Set(selfSlug ? [selfSlug] : []);
    let done = 0;

    for (let round = 0; round < 4 && done < remaining.profile_view; round += 1) {
      const slugs = await page.$$eval('a[href*="/in/"]', (els) =>
        els.map((e) => e.href.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1]).filter(Boolean));
      const fresh = [...new Set(slugs)].filter((s) => !seen.has(s));

      if (!fresh.length) {
        await page.mouse.wheel(0, rand(900, 1400));
        await sleep(rand(1800, 2800));
        continue;
      }

      for (const slug of fresh) {
        if (done >= remaining.profile_view) break;
        seen.add(slug);
        try {
          await page.goto(`https://www.linkedin.com/in/${slug}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(rand(2500, 4000));
          await guard();
          // Whose profile this was, in words. The heading is the obvious place
          // and is sometimes not painted yet; the tab title is "Name | LinkedIn"
          // from the first byte, and the slug is the last resort — a log line
          // reading "melissa-su%C3%A1rez-horta-325324125" is one nobody reads.
          const name = await page.evaluate(() => {
            const heading = document.querySelector('h1')?.innerText?.trim();
            if (heading) return heading;
            const title = document.title.replace(/\s*[|(].*$/, '').trim();
            return title && !/^linkedin$/i.test(title) ? title : null;
          }).catch(() => null)
            ?? decodeURIComponent(slug).replace(/-[0-9a-f]{6,}$/i, '').replace(/-/g, ' ');
          // A profile view that is a bounce is not a view. Read down the page
          // the way somebody deciding whether to connect would.
          for (let s = 0; s < 3; s += 1) { await page.mouse.wheel(0, rand(400, 800)); await sleep(rand(1400, 2600)); }
          if (done === 0) await shot(page, '3-profile-view');
          if (await count('profile_view', `переглянув профіль ${name}`)) done += 1;
        } catch (e) {
          if (e instanceof VisitStopped) throw e;
          report.errors.push(`profile_view ${slug}: ${e.message}`);
          log(`  ⚠️ профіль ${slug}: ${e.message}`);
        }
      }

      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(rand(2000, 3500));
      await page.mouse.wheel(0, rand(1200, 2000));
      await sleep(rand(1500, 2500));
    }
  }

  // ── likes ────────────────────────────────────────────────────────────────
  // LinkedIn's class names are hashes that change under you. The reaction
  // button's aria-label states its own state in words, so it is both the
  // selector and the proof that a click landed.
  const REACTION = 'button[aria-label^="Reaction button state"]';
  if (remaining.like > 0) {
    log(`лайки: треба ${remaining.like}`);
    if (!page.url().includes('/feed')) {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(rand(2500, 4000));
    }
    let placed = 0;
    for (let round = 0; round < 8 && placed < remaining.like; round += 1) {
      // A pinned handle, not a locator: a locator filtered on "no reaction"
      // re-resolves after the click and hands back the *next* unliked button,
      // so the verification was reading a different element every time.
      const [btn] = await page.$$(`${REACTION}[aria-label*="no reaction"]`);
      if (!btn) {
        await page.mouse.wheel(0, rand(700, 1100));
        await sleep(rand(1500, 2500));
        continue;
      }

      const author = await btn.evaluate((el) => {
        let node = el;
        for (let i = 0; i < 8 && node; i += 1) {
          node = node.parentElement;
          const text = node?.innerText?.trim() ?? '';
          if (text.length > 80) {
            return (text.split('\n').map((x) => x.trim())
              .find((x) => x && !/^(like|comment|repost|send|follow)$/i.test(x)) ?? '').slice(0, 60);
          }
        }
        return 'невідомо';
      }).catch(() => 'невідомо');

      await guard();
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(rand(1200, 2400));            // read it before reacting to it
      const box = await btn.boundingBox();
      if (box) {
        // Moved and pressed where the button is: a click dispatched at a
        // detached centre is what a bot check is built to notice.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
        await sleep(rand(200, 500));
        await page.mouse.down(); await sleep(rand(40, 110)); await page.mouse.up();
      } else {
        await btn.click({ timeout: 8000 }).catch((e) => report.errors.push('click: ' + e.message));
      }
      await sleep(rand(1800, 2800));

      await guard();
      const after = await btn.getAttribute('aria-label').catch(() => null);
      if (after && !/no reaction/i.test(after)) {
        if (await count('like', `лайк під постом: ${author}`)) {
          placed += 1;
          await shot(page, `4-like-${placed}`);
        }
      } else {
        log(`  ⚠️ не підтвердилось (${after}) у: ${author}`);
        await page.mouse.wheel(0, rand(600, 900));
        await sleep(rand(1200, 2000));
      }
    }
  }

  await sendQueuedInvitations(page, portal, plan.invites?.toSend, {
    guard, leaseId: portal.leaseId,
    onSent: (invite) => report.actions.push({ kind: 'connect', detail: `Запит до ${invite.name}` })
  });
  if (plan.invites?.toCheck?.length) await checkInvitations(page, portal, plan.invites.toCheck, { guard });

  for (const kind of ['post_comment', 'follow']) {
    if (remaining[kind] > 0) {
      await portal.log('agent.deferred', `${remaining[kind]} ${kind} left — the agent cannot do these yet`,
        { kind, remaining: remaining[kind] }, 'warn');
    }
  }

  // ── the inbox, last ──────────────────────────────────────────────────────
  // After the quota work and before the session closes, because the day's
  // actions are what the visit is for and a messenger that misbehaves must not
  // cost the account its likes.
  //
  // Asked, not assumed, in two ways. Whether the portal has an inbox at all:
  // the Mac portal does not, and opening the messenger for a portal that will
  // refuse the result still marks the operator's conversations read, because
  // LinkedIn marks a thread read the moment it is displayed. And how far back
  // to read: the last sync time is the portal's, so a replaced Mac or a
  // re-pointed portal does not re-read a year of history, and a cap that lives
  // in one place is a cap that can be changed in one place.
  const inboxWanted = !argv.includes('--no-inbox') && plan.inbox?.due === true;
  if (inboxWanted) {
    const since = plan.inbox?.lastSyncedAt ? Date.parse(plan.inbox.lastSyncedAt) : null;
    try {
      report.inbox = await syncInbox(page, {
        portal,
        guard,
        self: { slug: selfSlug, name: me },
        log,
        shot,
        since: Number.isFinite(since) ? since : null,
        limit: Number(plan.inbox?.maxThreads) > 0 ? Number(plan.inbox.maxThreads) : 20,
      });
    } catch (e) {
      // Its own catch: the visit already happened and the quota work already
      // counted. A messenger that fell over is worth a line in the log, not a
      // failed run and a red account on the screen.
      if (e instanceof VisitStopped) throw e;
      report.errors.push(`inbox: ${e.message}`);
      log(`  ⚠️ вхідні впали: ${e.message}`);
      await portal.log('agent.inbox', `Inbox sweep failed — ${e.message}`, null, 'warn').catch(() => {});
    }
  } else {
    log('вхідні: сьогодні вже прочитано або читання вимкнено');
  }

  // ── replies somebody wrote on the Inbox screen ───────────────────────────
  // After the inbox read, so the conversation is up to date when it is opened,
  // and last of all, because a message is the one thing here that cannot be
  // taken back. Its own catch for the same reason as above: a reply that did
  // not go is reported on the page for the person who wrote it, not a failed
  // run — only a warning or a report the portal refused stops the visit.
  const replies = plan.outbox?.toSend ?? [];
  if (replies.length && !argv.includes('--no-replies')) {
    try {
      report.replies = await sendReplies(page, {
        portal, guard, log, shot, items: replies, self: { slug: selfSlug, name: me },
      });
    } catch (e) {
      if (e instanceof VisitStopped) throw e;
      report.errors.push(`відповіді: ${e.message}`);
      log(`  ⚠️ відповіді впали: ${e.message}`);
      await portal.log('agent.outbox', `Sending replies failed — ${e.message}`, null, 'warn').catch(() => {});
    }
  }

  await shot(page, '6-final');
} catch (err) {
  failed = true;
  report.errors.push(err.message);
  log('❌', err.message);
  await portal.log('agent.error', err.message, null, 'error').catch(() => {});
} finally {
  const summary = report.actions.length
    ? report.actions.map((a) => a.detail).join('; ')
    : 'нічого не виконано';
  // The inbox goes in the session note as well as the log, because the note is
  // what somebody reads on the account's screen — and a run of zeros is only
  // visible as a pattern if every run says its number out loud.
  const inboxNote = report.inbox
    ? ` | розмов: ${report.inbox.threadsSeen}/${report.inbox.listed}, нових повідомлень: ${report.inbox.stored}`
    : '';
  const repliesNote = report.replies
    ? ` | відповідей: надіслано ${report.replies.sent}, не пішло ${report.replies.failed}, пропущено ${report.replies.skipped}`
    : '';
  try { await closeBrowser?.(); } catch (error) {
    failed = true;
    report.errors.push(`Browser cleanup: ${error.message}`);
    await portal.log('agent.error', `Browser cleanup: ${error.message}`, null, 'error').catch(() => {});
  }
  await portal.closeSession(`${summary}${inboxNote}${repliesNote}`.slice(0, 500), failed).catch(() => {});
  fs.writeFileSync(path.join(SHOTS, 'result.json'), JSON.stringify(report, null, 2));
  log(`готово. дій: ${report.actions.length} | помилок: ${report.errors.length}${inboxNote}${repliesNote} | скріни: ${SHOTS}`);
  if (!failed) closeBrowser = null;
}
return failed ? 1 : 0;
}
let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(error.message);
  await closeBrowser?.().catch(error => console.error(`Browser cleanup: ${error.message}`));
} finally {
  if (ownLeaseId) {
    try {
      await reportWithRetry(() => portal.runFinished({ accountId: portal.accountId, leaseId: ownLeaseId, ok: exitCode === 0 }));
    } catch (error) { console.error(error.message); exitCode = 1; }
  }
}
process.exitCode = exitCode;
