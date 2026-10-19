/**
 * One tab per stage of a visit, and its memory said out loud.
 *
 * 08.10, 09.10 (twice) and 11.10.2026: the kernel killed Chromium inside the
 * Anty container for running out of memory — one LinkedIn tab had grown to
 * 3.6 GB against the container's 4 GB, and the visit died mid-request. A visit
 * kept one tab from the IP check to the last reply: the feed, eight profiles,
 * the likes, the invitations and the messenger, all on top of each other. Now
 * each stage starts in a fresh tab, and the tab it leaves says how big it got,
 * so a growth is a line in the log instead of a dead session.
 */

/** The tab's JavaScript heap and DOM size, from Chromium itself; null when it will not say. */
export async function tabMemory(page) {
  let cdp = null;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const value = Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
    return {
      heapMb: Math.round((value.JSHeapUsedSize ?? 0) / 1048576),
      heapTotalMb: Math.round((value.JSHeapTotalSize ?? 0) / 1048576),
      nodes: value.Nodes ?? null,
      documents: value.Documents ?? null,
    };
  } catch {
    return null;
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

/**
 * How big a tab may get before the next profile opens in a fresh one. A stage
 * that walks profile after profile in one tab grows by ~100 MB of JS a profile
 * (19.10: 161 → 932 MB over eight profile views, ~3.5 GB for the whole
 * renderer), and the container's 4 GB ends the visit. Checked before each
 * profile, so a stage stays a few profiles' worth of memory at most.
 */
export const TAB_HEAP_LIMIT_MB = 350;

/** A tab that died under us: Chromium's own words for it. */
export function isTabCrash(error) {
  return /Target crashed|Page crashed|Target closed|Target page, context or browser has been closed/i.test(String(error?.message ?? error ?? ''));
}

/** The numbers in words, for the log line. */
export function describeMemory(memory) {
  if (!memory) return 'пам\'ять вкладки невідома';
  return `${memory.heapMb} МБ JS (з ${memory.heapTotalMb}), ${memory.nodes ?? '?'} вузлів DOM`;
}

/**
 * A fresh tab, and every other tab of this profile closed. The new one is
 * opened first: a persistent context whose last tab closes may take the whole
 * browser with it.
 */
export async function freshTab(context) {
  const page = await context.newPage();
  for (const other of context.pages()) {
    if (other !== page) await other.close({ runBeforeUnload: false }).catch(() => {});
  }
  return page;
}

/** Only the first tab kept — the one a profile restores is enough; the rest are last session's leftovers. */
export async function oneTab(context) {
  const [first, ...rest] = context.pages();
  for (const other of rest) await other.close({ runBeforeUnload: false }).catch(() => {});
  return first ?? context.newPage();
}
