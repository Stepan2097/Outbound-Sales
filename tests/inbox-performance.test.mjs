import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { loadMain } from "./app-main-excerpt.mjs";

// Run the real screen functions against instrumented DOM nodes. Lucide and
// browser serialisation change innerHTML here, just as they do in the browser.
const inboxSource = readFileSync(new URL("../app/screens/inbox.js", import.meta.url), "utf8");
const names = [
  "escapeHtml", "escapeAttr", "uaPlural", "warmupCount", "WARMUP_OUTREACH_LABEL", "WARMUP_OUTREACH_TONE",
  ...[...inboxSource.matchAll(/^(?:export )?(?:async function|function|const|let) (\w+)/gm)].map((match) => match[1])
];
const listenerPrefixes = [
  'document.getElementById("warmupInboxSearch")?.addEventListener("input"',
  'document.getElementById("warmupInboxLayout")?.addEventListener("click"',
  'document.getElementById("warmupInboxReplyText")?.addEventListener("input"',
  'onCacheReset(resetWarmupInboxSession);'
];
const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const row = (key, name, minutes = 1) => ({
  accountId: "account", threadKey: key, accountIdentity: "Mary", unread: false,
  participant: { name, headline: "Growth" },
  lastMessage: { direction: "in", body: `Hello from ${name}`, sentAt: at(minutes) }
});

function node() {
  let markup = "";
  let value = "";
  const classes = new Set(["active"]);
  return {
    writes: 0, valueWrites: 0, scrollTop: 0, selectionStart: 0, selectionEnd: 0,
    textContent: "", className: "", hidden: false, disabled: false, title: "",
    get innerHTML() { return markup; },
    set innerHTML(next) {
      this.writes += 1;
      this.scrollTop = 0;
      markup = String(next).replace(/<i data-lucide="([^"]+)"><\/i>/g, '<svg data-lucide="$1"></svg>');
    },
    get value() { return value; },
    set value(next) { this.valueWrites += 1; value = next; this.selectionStart = 0; this.selectionEnd = 0; },
    setAttribute() {},
    classList: { contains: (name) => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) }
  };
}

function fixture({ api = async () => { throw new Error("Unexpected API call"); }, threads, date } = {}) {
  const els = Object.fromEntries([
    "warmupInboxTitle", "warmupInboxSubtitle", "warmupInboxPill", "warmupInboxBody", "warmupInboxNotice",
    "warmupInboxAccounts", "warmupInboxLayout", "warmupInboxThread", "warmupInboxSearch", "warmupNavBadge",
    "warmupInboxReply", "warmupInboxReplyText", "warmupInboxReplyHint", "warmupInboxReplySend", "warmupInboxReplyCount",
    "warmupInboxNext", "view-inbox"
  ].map((id) => [id, node()]));
  const listeners = {};
  for (const id of ["warmupInboxSearch", "warmupInboxLayout", "warmupInboxReplyText"]) {
    els[id].addEventListener = (event, fn) => { listeners[`${id}:${event}`] = fn; };
  }
  const inbox = {
    threads: threads || [row("open", "Owen", 1), { ...row("tara", "Tara", 3), unread: true }, { ...row("marta", "Marta", 5), unread: true }],
    accounts: [], ready: true, available: true, unread: 2, sync: null, error: "",
    openAccountId: "account", openThreadKey: "open", openError: "", openBusy: false,
    open: { thread: row("open", "Owen"), messages: [{ direction: "in", body: "A saved message", sentAt: at(1) }], outbox: [], reply: { canWrite: true, limit: 2000 } }
  };
  const warmupState = { inbox, profiles: [], unreadReplies: 2 };
  const icons = [];
  let reset;
  let saved = 0;
  const dom = { visibilityState: "visible", activeElement: els.warmupInboxReplyText, getElementById: (id) => els[id] || null };
  const main = loadMain(names, {
    document: dom, warmupState, authState: { authenticated: true }, warmupApi: api,
    rememberWarmupInbox: () => { saved += 1; }, refreshIcons: (root) => icons.push(root),
    renderWarmupProfiles: () => {}, onCacheReset: (fn) => { reset = fn; }, clearInterval() {},
    ...(date ? { Date: date } : {})
  }, listenerPrefixes);
  const set = (name, value) => { main.context.__value = value; vm.runInContext(`${name} = __value`, main.context); };
  return {
    els, inbox, warmupState, dom, main, icons, set, get: main.get, reset: () => reset(), saved: () => saved,
    search(value) {
      els.warmupInboxSearch.value = value;
      listeners["warmupInboxSearch:input"]({ target: els.warmupInboxSearch });
    },
    draft(value) {
      els.warmupInboxReplyText.value = value;
      listeners["warmupInboxReplyText:input"]({ target: els.warmupInboxReplyText });
    },
    resetSearch() { listeners["warmupInboxLayout:click"]({ target: { closest: (selector) => selector === "[data-warmup-inbox-reset]" ? {} : null } }); }
  };
}

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const keys = (rows) => [...rows].map((thread) => thread.threadKey);

test("typing and resetting inbox search leave the conversation, draft, caret and scroll untouched", () => {
  const view = fixture();
  view.get("renderWarmupInbox")();
  view.draft("Keep this unfinished reply");
  const area = view.els.warmupInboxReplyText;
  area.selectionStart = 7;
  area.selectionEnd = 12;
  area.scrollTop = 31;
  view.els.warmupInboxThread.scrollTop = 240;
  view.els.warmupInboxBody.scrollTop = 45;
  const writes = view.els.warmupInboxThread.writes;
  const valueWrites = area.valueWrites;
  view.set("warmupThreadViewHtml", () => { throw new Error("Search rebuilt message history"); });
  view.set("renderWarmupReply", () => { throw new Error("Search redrew the editor"); });
  view.icons.length = 0;
  view.search("tara");
  assert.match(view.els.warmupInboxBody.innerHTML, /data-warmup-thread="tara"/);
  assert.doesNotMatch(view.els.warmupInboxBody.innerHTML, /data-warmup-thread="marta"/);
  assert.equal(view.els.warmupInboxBody.scrollTop, 45);
  assert.match(view.els.warmupInboxNext.innerHTML, /Tara/);
  view.search("marta");
  assert.match(view.els.warmupInboxNext.innerHTML, /Marta/);
  view.search("no match");
  assert.equal(view.els.warmupInboxNext.innerHTML, "");
  view.resetSearch();
  assert.equal(view.els.warmupInboxSearch.value, "");
  assert.equal(view.els.warmupInboxThread.writes, writes);
  assert.equal(view.els.warmupInboxThread.scrollTop, 240);
  assert.equal(area.value, "Keep this unfinished reply");
  assert.equal(area.valueWrites, valueWrites);
  assert.equal(area.selectionStart, 7);
  assert.equal(area.selectionEnd, 12);
  assert.equal(area.scrollTop, 31);
  assert.equal(view.dom.activeElement, area);
  assert.ok(view.icons.every((root) => root === view.els.warmupInboxNext), "Lucide scanned beyond the changed next action");
});

test("normalised icon markup does not replace an unchanged conversation, but fresh outbox state does", () => {
  const view = fixture();
  const pane = view.els.warmupInboxThread;
  view.get("renderWarmupInbox")();
  assert.match(pane.innerHTML, /<svg data-lucide=/);
  pane.scrollTop = 150;
  view.get("renderWarmupInbox")();
  assert.equal(pane.writes, 1);
  assert.equal(pane.scrollTop, 150);
  view.search("marta");
  view.get("renderWarmupInbox")();
  assert.equal(pane.writes, 1, "Updating the next action invalidated the whole conversation signature");
  view.inbox.open.outbox = [{ id: "reply", state: "failed", body: "Draft", reason: "Account paused" }];
  view.get("renderWarmupInbox")();
  assert.equal(pane.writes, 2);
  assert.match(pane.innerHTML, /Account paused/);
  assert.equal(pane.scrollTop, 150);
});

test("search reuses chronological order without sorting again and refreshes when a new dataset arrives", () => {
  let parses = 0;
  class TrackedDate extends Date { static parse(value) { parses += 1; return Date.parse(value); } }
  const view = fixture({ date: TrackedDate });
  assert.deepEqual(keys(view.get("warmupInboxRows")()), ["open", "tara", "marta"]);
  const afterIndex = parses;
  view.set("inboxSearch", "tara");
  assert.deepEqual(keys(view.get("warmupInboxRows")()), ["tara"]);
  view.set("inboxSearch", "marta");
  assert.deepEqual(keys(view.get("warmupInboxRows")()), ["marta"]);
  assert.equal(parses, afterIndex, "Every keystroke sorted dates again");
  view.inbox.threads[1].unread = false;
  assert.equal(view.get("warmupInboxAccountOptions")()[0].unread, 1, "Memoisation froze unread state");
  view.inbox.threads = [row("new", "New Person", 0), row("marta", "Marta", 8)];
  view.set("inboxSearch", "new person");
  assert.deepEqual(keys(view.get("warmupInboxRows")()), ["new"]);
  assert.ok(parses > afterIndex);
});

test("overlapping inbox reads share one request and the next read still checks the server", async () => {
  const pending = deferred();
  let requests = 0;
  const view = fixture({ api: async (path) => { assert.equal(path, "/inbox"); requests += 1; return pending.promise; } });
  const first = view.get("loadWarmupInbox")();
  const second = view.get("loadWarmupInbox")();
  assert.equal(requests, 1);
  pending.resolve({ threads: [row("fresh", "Fresh")], unread: 7 });
  await Promise.all([first, second]);
  assert.equal(view.inbox.unread, 7);
  assert.equal(view.saved(), 1);
  await view.get("loadWarmupInbox")();
  assert.equal(requests, 2, "Fresh unread data was hidden behind a timed inbox cache");
});

test("auth reset clears private drafts and ignores an old in-flight inbox response", async () => {
  const old = deferred();
  let requests = 0;
  const view = fixture({ api: async () => ++requests === 1 ? old.promise : { threads: [row("new-user", "New User")], unread: 1 } });
  view.get("renderWarmupInbox")();
  view.draft("Private unfinished message");
  const pending = view.get("loadWarmupInbox")();
  view.reset();
  assert.equal(view.els.warmupInboxReplyText.value, "");
  assert.equal(view.get("inboxDrafts").size, 0);
  assert.equal(view.inbox.openThreadKey, null);
  assert.equal(view.inbox.ready, false);
  await view.get("loadWarmupInbox")();
  old.resolve({ threads: [row("old-user", "Old User")], unread: 99 });
  await pending;
  assert.deepEqual(keys(view.inbox.threads), ["new-user"]);
  assert.equal(view.inbox.unread, 1);
});

test("a late response from an earlier refresh of the same thread cannot replace the latest reply permissions", async () => {
  const old = deferred();
  const fresh = deferred();
  let requests = 0;
  const view = fixture({ api: async (path) => { assert.match(path, /^\/inbox\/thread\?/); return ++requests === 1 ? old.promise : fresh.promise; } });
  const first = view.get("openWarmupThread")("account", "open", { refresh: true });
  const second = view.get("openWarmupThread")("account", "open", { refresh: true });
  fresh.resolve({ thread: row("open", "Owen"), messages: [], reply: { canWrite: false, reason: "Account paused" } });
  await second;
  old.resolve({ thread: row("open", "Owen"), messages: [], reply: { canWrite: true } });
  await first;
  assert.equal(view.inbox.open.reply.canWrite, false);
  assert.equal(view.inbox.open.reply.reason, "Account paused");
});

test("failed inbox reads can retry and do not persist an empty successful answer", async () => {
  let attempts = 0;
  const view = fixture({ api: async () => { if (++attempts === 1) throw new Error("Temporary failure"); return { threads: [row("retry", "Retry")], unread: 0 }; } });
  await view.get("loadWarmupInbox")();
  assert.equal(view.saved(), 0);
  assert.match(view.inbox.error, /Temporary failure/);
  await view.get("loadWarmupInbox")();
  assert.equal(view.saved(), 1);
  assert.equal(view.inbox.error, "");
  assert.deepEqual(keys(view.inbox.threads), ["retry"]);
});


test("a queued reply completing after logout cannot clear the next user's draft", async () => {
  const old = deferred();
  const view = fixture({ api: async (path) => { assert.equal(path, "/inbox/reply"); return old.promise; } });
  view.get("renderWarmupInbox")();
  view.draft("Old user's reply");
  const sending = view.get("submitWarmupReply")();
  view.reset();
  Object.assign(view.inbox, {
    threads: [row("open", "Owen")], ready: true, openAccountId: "account", openThreadKey: "open",
    open: { thread: row("open", "Owen"), messages: [], outbox: [], reply: { canWrite: true } }
  });
  view.get("renderWarmupInbox")();
  view.draft("New user's unfinished reply");
  old.resolve({ success: true });
  await sending;
  assert.equal(view.els.warmupInboxReplyText.value, "New user's unfinished reply");
  assert.equal(view.get("inboxDrafts").get("account|open"), "New user's unfinished reply");
});
