import assert from "node:assert/strict";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * The invite form on a lead, without a browser: what it says about the note,
 * and where today's rule comes from.
 *
 * Both were wrong in ways a seller acts on. The hint said «Записка не піде»
 * and then that the note would be judged on a later day — and «квоту вибрано»
 * on days that never had a quota. And the rule it stated as «сьогодні» was
 * read once per page, so a tab left open overnight said yesterday's.
 */

const FORM = [
  "uaPlural", "escapeHtml", "escapeAttr", "setText", "setHtml", "crmContactIdOf",
  "inviteAccounts", "inviteAccountsLoaded", "inviteAccountsAsked", "inviteState", "inviteLoadedFor", "inviteNotice",
  "INVITE_NOTE_DROPPED", "INVITE_NOTE_CYRILLIC_TLD", "inviteNoteWords", "inviteNoteHasLink", "inviteNoteVerdict",
  "inviteNoteRuleText", "inviteNoneTodayReason", "inviteNoteHintHtml", "inviteQueueLaterText", "inviteQueueNoteHtml",
  "inviteAccountOptionHtml", "readInviteAccounts", "refreshInviteAccounts", "refreshInviteNoteHint",
  "loadInviteContext", "leadSectionOpened"
];
// The listener that picks another account, as the page registers it.
const PICK_LISTENER = 'document.getElementById("inviteContent").addEventListener("change"';

/** A page with just the elements the invite form touches. */
function fakePage() {
  const elements = new Map();
  const element = (id, props = {}) => {
    const listeners = {};
    const node = {
      id, value: "", innerHTML: "", textContent: "", disabled: false, listeners,
      addEventListener(type, handler) {
        (listeners[type] ??= []).push(handler);
      },
      ...props
    };
    elements.set(id, node);
    return node;
  };
  element("inviteContent");
  return { elements, element, document: { getElementById: (id) => elements.get(id) ?? null } };
}

/** The warm-up API, answering `/invites/accounts` with whatever `accounts` holds now. */
function fakeApi() {
  const asked = [];
  const api = {
    accounts: [],
    // When set, the next accounts read waits for the test to answer it.
    held: null,
    asked,
    reads: () => asked.filter((path) => path === "/invites/accounts").length,
    call: async (path) => {
      asked.push(path);
      if (path === "/invites/accounts") {
        if (api.held) return api.held();
        return { accounts: api.accounts };
      }
      if (path.startsWith("/invites?")) return { invite: null };
      throw new Error(`unexpected ${path}`);
    }
  };
  return api;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function loadForm({ api, page, prospects = [], selected = null }) {
  const rendered = [];
  const historyLoads = [];
  const excerpt = loadMain(FORM, {
    document: page.document,
    warmupApi: api.call,
    renderInvite: (prospect) => rendered.push(prospect ?? null),
    refreshIcons: () => {},
    loadHistory: async (prospect) => historyLoads.push(prospect),
    state: { prospects },
    selectedProspectId: selected
  }, [PICK_LISTENER]);
  return { ...excerpt, rendered, historyLoads };
}

const lead = (contactId) => ({ id: `p-${contactId}`, linkedin: `https://linkedin.com/in/${contactId}`, crmSource: { contact_id: contactId } });
const plain = (html) => html.replace(/<[^>]+>/g, "");

// Day 10: four requests, no notes. Day 11: five, and three words.
const DAY_10 = { id: "acc-1", label: "Chloe", canSend: true, connectsLeft: 4, connectQuota: 4, noteRule: false, reason: "" };
const DAY_11 = { ...DAY_10, connectsLeft: 5, connectQuota: 5, noteRule: { maxWords: 3, allowLinks: false } };

// ── what the hint says ────────────────────────────────────────────────────

test("a note on a request that goes later is not declared dead", () => {
  const { context } = loadForm({ api: fakeApi(), page: fakePage() });
  const hint = (account, note) => plain(context.inviteNoteHintHtml(account, note));

  // Day 10, the four requests spent: the request goes on day 11, whose rule
  // lets a two-word note through.
  const spent = hint({ ...DAY_10, connectsLeft: 0 }, "Привіт, Олено");
  assert.doesNotMatch(spent, /Записка не піде/, "it may well go");
  assert.doesNotMatch(spent, /Запит піде без неї/);
  assert.match(spent, /Сьогодні записка б не пройшла: у цій фазі прогріву записки не можна/);
  assert.match(spent, /квоту вибрано — запит піде пізніше, і записку перевірять тоді/);

  // Day 2: nothing was used up; the plan has no requests yet.
  const day2 = hint({ ...DAY_10, connectsLeft: 0, connectQuota: 0 }, "Привіт, Олено");
  assert.doesNotMatch(day2, /вибрано/, "there was no quota to use up");
  assert.doesNotMatch(day2, /Записка не піде/);
  assert.match(day2, /сьогодні запитів немає — запит піде пізніше/);

  // Room today: it goes today, under today's rule, and that is definite.
  assert.equal(
    hint({ ...DAY_11, connectsLeft: 2 }, "Раді знайомству з вами"),
    "Записка не піде: 4 слова, а сьогодні можна до 3. Запит піде без неї."
  );
  assert.equal(hint({ ...DAY_11, connectsLeft: 2 }, "Раді знайомству"), "", "a note that goes as written needs no word");
  assert.equal(hint({ ...DAY_10, noteRule: null, canSend: false }, "Привіт"), "", "an account that cannot send has no rule to judge by");
});

test("the form says «вибрано» only of a quota that was there", () => {
  const { context } = loadForm({ api: fakeApi(), page: fakePage() });
  const later = (usable) => context.inviteQueueLaterText(usable);
  const day2 = { canSend: true, connectsLeft: 0, connectQuota: 0 };
  const spent = { canSend: true, connectsLeft: 0, connectQuota: 4 };

  assert.equal(later([{ ...spent, connectsLeft: 1 }, day2]), "", "one account can still send today");
  assert.match(later([spent, spent]), /Квоту вибрано на всіх акаунтах/);
  assert.match(later([day2, day2]), /запитів немає на жодному акаунті/);
  assert.doesNotMatch(later([day2, day2]), /вибрано/);
  assert.match(later([spent, day2]), /жоден акаунт уже не надішле/);
  assert.equal(later([]), "", "no account at all has its own sentence");
  assert.match(plain(context.inviteQueueNoteHtml([])), /Жоден акаунт зараз не може надсилати/);
});

// ── where today's rule comes from ─────────────────────────────────────────

test("every lead opened reads today's accounts again", async () => {
  const api = fakeApi();
  const page = fakePage();
  const form = loadForm({ api, page });

  api.accounts = [DAY_10];
  await form.context.loadInviteContext(lead("c-1"));
  api.accounts = [DAY_11];
  await form.context.loadInviteContext(lead("c-2"));

  assert.equal(api.reads(), 2, "once a page was yesterday's rule all night");
  assert.deepEqual(form.get("inviteAccounts")[0].noteRule, { maxWords: 3, allowLinks: false });
});

test("picking another account re-says its rule from a fresh read, and keeps the typed note", async () => {
  const api = fakeApi();
  const page = fakePage();
  const form = loadForm({ api, page });
  api.accounts = [DAY_10, { ...DAY_10, id: "acc-2", label: "Mark" }];
  await form.context.loadInviteContext(lead("c-1"));

  // The form as it stood on day 10, with a note typed.
  const select = page.element("inviteAccountSelect", { value: "acc-2" });
  const note = page.element("inviteNoteInput", { value: "Привіт, Олено" });
  const rule = page.element("inviteNoteRule");
  const hint = page.element("inviteNoteHint");
  const queueNote = page.element("inviteQueueNote");
  const send = page.element("inviteSendBtn");
  form.context.refreshInviteNoteHint();
  assert.equal(rule.textContent, "сьогодні без записки");
  assert.match(plain(hint.innerHTML), /Запит із запискою чекатиме/);

  // Past midnight: day 11. The seller picks the first account.
  api.accounts = [DAY_11, { ...DAY_11, id: "acc-2", label: "Mark" }];
  select.value = "acc-1";
  const readsBefore = api.reads();
  for (const handler of page.elements.get("inviteContent").listeners.change) handler({ target: select });
  await settle();

  assert.equal(api.reads(), readsBefore + 1, "the pick reads the accounts again");
  assert.equal(rule.textContent, "сьогодні до 3 слів, без посилань");
  assert.equal(hint.innerHTML, "", "two words go on day 11");
  assert.equal(note.value, "Привіт, Олено", "what was typed stays");
  assert.equal(select.value, "acc-1", "and so does the pick");
  assert.match(select.innerHTML, /Chloe · 5 з 5 на сьогодні/, "the list says today's numbers too");
  assert.equal(queueNote.innerHTML, "");
  assert.equal(send.disabled, false);
});

test("opening the Запрошення tab reads the accounts again; other tabs do not", async () => {
  const api = fakeApi();
  const page = fakePage();
  const opened = lead("c-1");
  const form = loadForm({ api, page, prospects: [opened], selected: opened.id });
  api.accounts = [DAY_11];

  form.context.leadSectionOpened("dashboard-invite");
  await settle();
  assert.equal(api.reads(), 1);
  // No form on screen (a request is already queued): the panel is drawn again
  // with today's accounts rather than patched.
  assert.deepEqual(form.rendered.map((prospect) => prospect?.id), [opened.id]);

  form.context.leadSectionOpened("dashboard-history");
  await settle();
  assert.equal(api.reads(), 1, "the history tab reads the history");
  assert.equal(form.historyLoads.length, 1);

  // A lead with no CRM contact has no form to refresh.
  const stranger = { id: "p-x", linkedin: "https://linkedin.com/in/x", crmSource: null };
  const other = loadForm({ api, page: fakePage(), prospects: [stranger], selected: stranger.id });
  other.context.leadSectionOpened("dashboard-invite");
  await settle();
  assert.equal(api.reads(), 1);
});

test("of two overlapping reads, the one started later is the one kept", async () => {
  const api = fakeApi();
  const page = fakePage();
  const form = loadForm({ api, page });
  const answers = [];
  api.held = () => new Promise((resolve) => answers.push(resolve));

  const first = form.context.refreshInviteAccounts();
  const second = form.context.refreshInviteAccounts();
  await settle();
  assert.equal(answers.length, 2);
  answers[1]({ accounts: [DAY_11] });
  await second;
  answers[0]({ accounts: [DAY_10] });
  await first;

  assert.deepEqual(form.get("inviteAccounts")[0].noteRule, { maxWords: 3, allowLinks: false }, "yesterday's slow answer must not win");
});
