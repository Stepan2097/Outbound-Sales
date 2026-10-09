// The last answer each screen drew, kept for this tab.
//
// Opening a screen — or reloading the page — draws what was there a moment ago
// at once, and the fresh answer replaces it when it arrives. Before this the
// warm-up screen sat empty through eight requests in a row on every visit.
//
// Session storage, not local: what is here is account lists, CRM names and
// conversation snippets, and it should go when the tab does. Signing out
// clears it too (`forgetScreens`), so the next person in this tab never sees
// the previous one's screens, not even for the second before their own load.
// Every read and write is guarded: a private window or a full quota only means
// the screen loads the slow way, as it always did.

const PREFIX = "outbound:screen:v1:";

/** `{ at, value }` as last remembered, or null. */
export function recallScreen(key) {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return saved && typeof saved === "object" && "value" in saved ? saved : null;
  } catch {
    return null;
  }
}

export function rememberScreen(key, value) {
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // Over quota or no storage: the screen still works, only not from memory.
  }
}

export function forgetScreens() {
  try {
    const keys = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // Nothing stored, nothing to forget.
  }
}
