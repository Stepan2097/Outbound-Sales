/**
 * "Is this account still signed in?" — the one question, asked without doing
 * anything else.
 *
 * It exists because of a gap in the schedule: the server hands out only
 * accounts whose health is `ok`, so the moment an account is marked
 * `needs_login` it stops being visited — and nothing ever notices that
 * somebody fixed it. This probe is what checks such an account without putting
 * it back in the rotation: it opens the profile, looks at the feed, and closes.
 * No requests, no likes, no messages, and the messenger is never opened.
 *
 * `settle` lives here rather than in `run-account.mjs` so that both the visit
 * and the probe read the same markers. Two copies of this judgement would
 * eventually disagree, and the disagreement would read as "the watcher says the
 * account is fine, the agent says it is not".
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for LinkedIn to settle, then say what we are looking at.
 *
 * Asking a fixed few seconds after `domcontentloaded` reads the wrong page: a
 * signed-in profile is sent to /login first and bounced back to the feed once
 * the session cookie checks out, so a snapshot taken mid-bounce reports a
 * healthy account as logged out. Poll for something conclusive instead: a real
 * password field, a checkpoint, or the feed.
 */
export async function settle(page, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const url = page.url();
    try {
      if (/\/checkpoint\//.test(url)) return { signedIn: false, url, reason: 'checkpoint' };
      // Read every marker in one pass and keep it: when this is wrong, the
      // question is always "which marker missed", and guessing that from a
      // screenshot after the browser has closed is how an afternoon goes.
      const seen = await page.evaluate(() => ({
        loginForm: Boolean(document.querySelector('input#username, input[name="session_key"], input[name="session_password"]')),
        network: Boolean(document.querySelector('a[href*="/mynetwork"]')),
        post: Boolean(document.querySelector('button[aria-label^="Reaction button state"]')),
        search: Boolean(document.querySelector('input[placeholder*="Search" i], .search-global-typeahead__input')),
        text: (document.body?.innerText ?? '').length,
      }));
      if (seen.loginForm) return { signedIn: false, url, reason: 'login form', seen };
      // The nav, the search box and a post each mean signed in on their own;
      // LinkedIn's class names are hashes, so no single one of them is safe to
      // depend on and `main` alone is on the logged-out page too.
      if (/\/feed/.test(url) && (seen.network || seen.post || seen.search)) {
        return { signedIn: true, url, reason: 'feed', seen };
      }
      last = seen;
    } catch {
      // The bounce navigated out from under the query. That is the very thing
      // being waited for, not a failure — look again on the next page.
    }
    await sleep(1500);
  }
  return { signedIn: false, url: page.url(), reason: 'timed out waiting for the feed', seen: last };
}

/**
 * Open one profile in the runtime, look at the feed, close it.
 *
 * The browser is always closed, including when the look throws: a profile left
 * running is a profile the next visit is refused, and the account would then
 * look broken for a reason that has nothing to do with LinkedIn.
 */
export async function probeLogin({ api, chromium, profileRemoteId, timeoutMs = 40000 }) {
  const session = await api.open(profileRemoteId, chromium);
  try {
    const page = session.context.pages()[0] || await session.context.newPage();
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const state = await settle(page, timeoutMs);
    return { ...state, profile: session.profile?.name ?? null };
  } finally {
    await session.close().catch(() => {});
  }
}
