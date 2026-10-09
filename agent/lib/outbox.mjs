/**
 * Sending the replies somebody wrote on the Inbox screen.
 *
 * The portal owns no browser, so a reply written there is only asked for. It is
 * sent here, from the account's own session, after the day's actions and the
 * inbox read — the same visit, the same window, the same hands: opened by its
 * address, read for a moment, typed key by key, sent with the button, and
 * confirmed only when the message is on the page.
 *
 * **Three things this is careful about, because none of them can be undone.**
 *
 * 1. *A cancelled reply is not typed.* The plan was cut earlier; before every one
 *    the portal is asked `outbox.prepare`, and a person may have taken it back in
 *    between. A no — or "stop everything" because a warning arrived — ends it.
 * 2. *Nothing is sent that is not certain.* The field must be found exactly (a
 *    page with two is not guessed at), must hold exactly what was written, and
 *    the button must be live. Anything else is reported as not sent, the field is
 *    cleared so no half-typed draft sits in somebody's real messenger, and the
 *    person is told why.
 * 3. *Never twice.* Sent is reported only when the message is on the page, and a
 *    reply that went out but could not be reported is the dangerous case: the
 *    portal would hand it out again tomorrow. So the report is retried, the visit
 *    stops if it cannot be made, and — the second guard — a conversation whose
 *    last message is already ours with the very same words is not typed into again.
 *
 * What this cannot prove is that LinkedIn's composer behaves like the saved copy
 * of it (`agent/fixtures`). The hints are tried first and the structure after,
 * exactly as the reader does, and `how` says which one answered.
 */
import { VisitStopped, reportWithRetry } from './connections.mjs';
import { harvestThread, buildThread } from './inbox-dom.mjs';
import { settleThread } from './inbox.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/** The text as it is compared: what the page shows is not what was typed, to the whitespace. */
export function flatText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Mark the composer and its send button on the page, or say why not.
 *
 * Runs in the page. Exactly one composer or none: a messenger overlay open on
 * top of the thread gives two, and typing into the wrong one sends words to the
 * wrong person.
 */
export function markComposer() {
  for (const old of document.querySelectorAll('[data-outbound-composer], [data-outbound-send]')) {
    old.removeAttribute('data-outbound-composer');
    old.removeAttribute('data-outbound-send');
  }
  let how = 'class hint';
  let found = [];
  for (const selector of [
    'form[class*="msg-form"] [contenteditable="true"][role="textbox"]',
    '[class*="msg-form__contenteditable"][contenteditable="true"]',
  ]) {
    found = [...document.querySelectorAll(selector)];
    if (found.length) break;
  }
  if (!found.length) {
    how = 'structure';
    found = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter((el) => el.closest('form'));
  }
  if (found.length !== 1) return { ok: false, count: found.length, how };

  const composer = found[0];
  composer.setAttribute('data-outbound-composer', '1');
  const form = composer.closest('form') || composer.parentElement || document;
  let send = form.querySelector('button[class*="send-button"], button[type="submit"]');
  if (!send) {
    send = [...form.querySelectorAll('button')].find((button) =>
      /^(send|надіслати|відправити)$/i.test((button.getAttribute('aria-label') || button.textContent || '').trim()));
  }
  if (send) send.setAttribute('data-outbound-send', '1');
  return { ok: true, how, hasSend: Boolean(send) };
}

const composerText = (page) => page.evaluate(() => document.querySelector('[data-outbound-composer]')?.innerText ?? '');
const composerFocused = (page) => page.evaluate(() => {
  const composer = document.querySelector('[data-outbound-composer]');
  return Boolean(composer) && (document.activeElement === composer || composer.contains(document.activeElement));
});
const sendIsLive = (page) => page.evaluate(() => {
  const button = document.querySelector('[data-outbound-send]');
  return Boolean(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
});

/** Press where the element is, the way every other click in this folder does. */
async function pressOn(page, handle, pace) {
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  const box = await handle.boundingBox().catch(() => null);
  if (!box) { await handle.click({ timeout: 8000 }); return; }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await sleep(rand(150, 400) * pace);
  await page.mouse.down(); await sleep(rand(40, 110) * pace); await page.mouse.up();
}

/**
 * A line cut into the runs it is typed in, 14 to 48 characters each — by
 * characters and not by code units. A run that ends between the two halves of an
 * emoji is typed as two broken halves, or not at all, and a reply that loses its
 * ending is exactly what is checked for after typing and refused.
 */
export function chunkLine(line, pick = () => rand(14, 48)) {
  const characters = Array.from(line);
  const chunks = [];
  for (let from = 0; from < characters.length;) {
    const size = Math.max(1, Math.round(pick()));
    chunks.push(characters.slice(from, from + size).join(''));
    from += size;
  }
  return chunks;
}

/** Type it as a person would: in runs, with pauses between them, a new line being Shift+Enter. */
async function typeOut(page, text, pace) {
  const lines = text.split('\n');
  for (let at = 0; at < lines.length; at += 1) {
    const chunks = chunkLine(lines[at]);
    for (let index = 0; index < chunks.length; index += 1) {
      await page.keyboard.type(chunks[index], { delay: Math.max(1, rand(35, 95) * pace) });
      if (index + 1 < chunks.length) await sleep(rand(80, 380) * pace);
    }
    if (at + 1 < lines.length) {
      await page.keyboard.press('Shift+Enter');
      await sleep(rand(150, 500) * pace);
    }
  }
}

/** Empty the field, so a reply that did not go does not wait in a real messenger as a draft. */
async function clearComposer(page) {
  try {
    const field = await page.$('[data-outbound-composer]');
    if (!field) return;
    if (!(await composerText(page)).trim()) return;
    await field.click({ timeout: 4000 });
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`);
    await page.keyboard.press('Backspace');
  } catch { /* the page is going away anyway */ }
}

/** How many times these words stand in the conversation as it is drawn. */
function timesSaid(harvest, snippet) {
  return (harvest?.items ?? []).filter((item) => {
    const said = item.paragraphs?.length ? item.paragraphs.join(' ') : (item.text ?? '');
    return flatText(said).includes(snippet);
  }).length;
}

const snippetOf = (text) => flatText(text).slice(0, 60);

/**
 * Send each reply in the plan, one conversation at a time.
 *
 * Returns what happened to each — `sent`, `failed` or `skipped` — and never
 * throws for a reply that did not go: that is one reply's failure, reported on
 * the page for the person who wrote it. A warning on the page, or a report the
 * portal would not take, stops the visit (`VisitStopped`), as everywhere else.
 */
export async function sendReplies(page, {
  portal,
  items = [],
  self,
  guard = async () => {},
  log = () => {},
  shot = async () => {},
  nowMs = Date.now(),
  origin = 'https://www.linkedin.com',
  pace = 1,
  // How long to wait for the sent message to show up in the conversation, and
  // how long between two tries at a report. Parameters with one real value each,
  // so the failures can be run in seconds against a saved page; a live run
  // leaves them alone.
  confirmMs = 20_000,
  retryWait = sleep,
} = {}) {
  const result = { sent: 0, failed: 0, skipped: 0, notes: [] };
  const fail = async (item, reason) => {
    result.failed += 1;
    result.notes.push(`${item.threadKey}: ${reason}`);
    log(`  ⚠️ відповідь не пішла (${item.name ?? item.threadKey}): ${reason}`);
    await clearComposer(page);
    await reportWithRetry(() => portal.outboxFailed(item.id, reason), { sleep: retryWait, attempts: 3 });
  };

  for (const item of items) {
    await guard();
    const who = item.name ?? item.threadKey;

    const prepared = await reportWithRetry(() => portal.outboxPrepare(item.id), { sleep: retryWait, attempts: 3 });
    if (prepared.stopAll) throw new VisitStopped('Server stopped this account');
    if (!prepared.allowed || !prepared.reply) {
      result.skipped += 1;
      result.notes.push(`${item.threadKey}: пропущено — ${prepared.reason ?? 'не дозволено'}`);
      log(`  ↷ відповідь для ${who} пропущена: ${prepared.reason ?? 'не дозволено'}`);
      // The day's limit ends the lot; a cancelled one is only itself.
      if (prepared.reason === 'limit') break;
      continue;
    }
    // What is typed is what the portal says now, not what the plan said earlier.
    const { text, threadKey } = prepared.reply;

    try {
      await page.goto(`${origin}/messaging/thread/${encodeURIComponent(threadKey)}/`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await guard();
      const settled = await settleThread(page, { threadKey }, { pace });
      await guard();
      if (!settled.ok) { await fail(item, 'розмова не відкрилась'); continue; }

      // The second guard against sending the same words twice.
      const before = buildThread({ threadKey, harvest: settled.harvest, self, nowMs });
      const last = before.payload?.messages?.at(-1);
      if (last && last.direction === 'out' && flatText(last.body) === flatText(text)) {
        await fail(item, 'такі самі слова вже стоять останніми в розмові від цього акаунта — вдруге не надсилав; перевірте розмову');
        continue;
      }

      await sleep(rand(2500, 6000) * pace);   // reading what they wrote
      const marked = await page.evaluate(markComposer);
      if (!marked.ok) {
        await fail(item, marked.count > 1
          ? `на сторінці ${marked.count} полів для повідомлення — не знаю, у яке писати`
          : 'не знайшов поле для повідомлення');
        continue;
      }
      if (!marked.hasSend) { await fail(item, 'не знайшов кнопку «Надіслати»'); continue; }
      await guard();

      const field = await page.$('[data-outbound-composer]');
      await pressOn(page, field, pace);
      await sleep(rand(400, 1100) * pace);
      // Keys go to whatever has the cursor. A click at the spot the field was
      // measured at can land beside it when the page shifted in between (an
      // image arriving above it), and typing then would go nowhere — or, worse,
      // into something else. So: once more, by the element itself, and if the
      // cursor is still not in the field, nothing is typed.
      if (!await composerFocused(page)) {
        await field.click({ timeout: 4000 }).catch(() => {});
        await sleep(rand(200, 500) * pace);
      }
      if (!await composerFocused(page)) { await fail(item, 'не вдалось поставити курсор у поле — нічого не набирав'); continue; }
      await typeOut(page, text, pace);
      await sleep(rand(700, 1800) * pace);
      await guard();

      const typed = await composerText(page);
      if (flatText(typed) !== flatText(text)) {
        await fail(item, `у полі після набору не те, що написано (є: «${typed.replace(/\s+/g, ' ').trim().slice(0, 80)}») — нічого не надсилав`);
        continue;
      }
      let live = false;
      for (let tries = 0; tries < 8 && !live; tries += 1) {
        live = await sendIsLive(page);
        if (!live) await sleep(Math.max(50, 500 * pace));
      }
      if (!live) { await fail(item, 'кнопка «Надіслати» не стала активною — нічого не надсилав'); continue; }

      const snippet = snippetOf(text);
      const said = timesSaid(await page.evaluate(harvestThread), snippet);
      await shot(page, '7-reply-typed');
      await pressOn(page, await page.$('[data-outbound-send]'), pace);

      // Sent means seen: the message is in the conversation, one more time than
      // before. The field emptying is not enough — it empties on a failure too.
      let seen = null;
      const deadline = Date.now() + confirmMs;
      while (Date.now() < deadline) {
        await sleep(Math.max(50, 1000 * pace));
        const harvest = await page.evaluate(harvestThread).catch(() => null);
        if (harvest && timesSaid(harvest, snippet) > said) { seen = harvest; break; }
      }
      if (!seen) {
        await fail(item, 'натиснув «Надіслати», але повідомлення в розмові не з’явилось — невідомо, чи пішло; перевірте розмову й не надсилайте вдруге');
        continue;
      }

      // The one report that must not be lost: a reply that went out and is not
      // recorded is handed out again tomorrow.
      const answer = await reportWithRetry(() => portal.outboxSent(item.id), { sleep: retryWait, attempts: 3 });
      if (!answer.success) throw new VisitStopped(`Reply report refused: ${answer.error}`);
      result.sent += 1;
      log(`  ✉️ відповідь надіслано: ${who}`);

      // And the conversation as it is now, through the ordinary door, so the
      // message the portal shows is LinkedIn's own and not a copy of what was typed.
      const built = buildThread({ threadKey, harvest: seen, self, nowMs: Date.now() });
      if (!built.skip) await portal.inboxThread(built.payload).catch(() => {});
    } catch (error) {
      if (error instanceof VisitStopped) throw error;
      // Whatever happened after the typing began, it is not known to have sent.
      await fail(item, `збій під час відправки: ${error.message}`);
    }

    await sleep(rand(20_000, 60_000) * pace);
  }
  return result;
}
