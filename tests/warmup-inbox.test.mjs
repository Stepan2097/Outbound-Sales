import assert from "node:assert/strict";
import test from "node:test";

import {
  BODY_LIMIT, TRUNCATION_MARKER, byUnreadThenNewest, clampBody, crmContent, deriveThreads, externalIdFor,
  UNNAMED, linkedinSlug, matchOutreachRow, normalizeMessage, normalizeParticipant, normalizeThreadInput,
  splitStored, summarizeAccounts
} from "../warmup/inbox.mjs";

const RECEIVED = "2026-09-16T12:00:00.000Z";

function message(overrides = {}) {
  return { externalId: "x1", direction: "in", body: "hello", sentAt: "2026-09-15T09:00:00.000Z", ...overrides };
}

/** A stored message event, as `wl_events` hands it back. */
function event({ accountId = "acc-1", threadKey = "t-1", direction = "in", body = "hi", sentAt, storedAt, participant }) {
  return {
    account_id: accountId,
    type: direction === "in" ? "message.in" : "message.out",
    created_at: storedAt,
    meta: { threadKey, externalId: `${threadKey}-${sentAt}-${direction}`, direction, body, sentAt, participant }
  };
}

// ── bodies ────────────────────────────────────────────────────────────────

test("a body inside the limit is kept exactly", () => {
  const { body, truncated } = clampBody("a short reply");
  assert.equal(body, "a short reply");
  assert.equal(truncated, false);
});

test("a long body is truncated with a marker rather than rejected", () => {
  const { body, truncated } = clampBody("x".repeat(9000));
  assert.equal(truncated, true);
  assert.ok(body.endsWith(TRUNCATION_MARKER), "a reader has to be able to tell something was cut");
  assert.equal(body.length, BODY_LIMIT, "the marker counts against the limit, it does not push past it");
});

test("a body is stored as it arrived — no stripping, no escaping", () => {
  const raw = "hi <b>there</b> 🙂\nsecond line";
  assert.equal(clampBody(raw).body, raw, "the screen escapes; storing a mangled body loses the original for good");
});

// ── slugs, which arrive spelled three ways ────────────────────────────────

test("every spelling of a LinkedIn profile reduces to the same slug", () => {
  const expected = "jane-doe";
  for (const value of [
    "jane-doe",
    "linkedin.com/in/jane-doe",
    "https://www.linkedin.com/in/jane-doe",
    "https://www.linkedin.com/in/jane-doe/",
    "http://linkedin.com/in/Jane-Doe?originalSubdomain=ua",
    "https://www.linkedin.com/in/jane-doe/#experience"
  ]) {
    assert.equal(linkedinSlug(value), expected, value);
  }
});

test("a company page is not a person and does not become one", () => {
  // The CRM is full of `/company/...` in the column meant for the person, so
  // this collision is not hypothetical.
  assert.notEqual(linkedinSlug("linkedin.com/company/acme"), linkedinSlug("linkedin.com/in/acme"),
    "a company slug must not collide with a person's — it would file a reply against the wrong row");
  assert.equal(linkedinSlug("http://www.linkedin.com/company/contest-o-matik"),
    linkedinSlug("https://linkedin.com/company/Contest-O-Matik/"),
    "two spellings of the same company page still have to meet");
});

test("a bare slug is read as a person, which is what the agent sends", () => {
  assert.equal(linkedinSlug("jane-doe"), linkedinSlug("https://www.linkedin.com/in/jane-doe"));
});

test("nothing in gives nothing out", () => {
  for (const value of [null, undefined, "", "   ", 7]) assert.equal(linkedinSlug(value), "");
});

// ── what the agent posts ──────────────────────────────────────────────────

test("a missing slug and headline are normal, not errors", () => {
  const participant = normalizeParticipant({ name: "Group Thread" });
  assert.deepEqual(participant, { name: "Group Thread", slug: null, headline: null });
});

test("a participant with no name at all becomes Unknown", () => {
  assert.equal(normalizeParticipant(null).name, UNNAMED);
});

test("the placeholders LinkedIn prints instead of a name are not names", () => {
  // A restricted or out-of-network profile renders "LinkedIn Member"; the agent
  // reads exactly what is on screen, so this arrives for real.
  for (const printed of ["LinkedIn Member", "linkedin member", "  LinkedIn User ", "Deleted Member", "Unknown"]) {
    assert.equal(normalizeParticipant({ name: printed }).name, UNNAMED, printed);
  }
});

test("a placeholder split across two elements is still a placeholder", () => {
  // The agent reads a DOM. A name built from two spans arrives with the newline
  // and the indentation between them, and that ragged form is likelier in
  // production than the tidy one — trimming the ends alone would let it through
  // as a "name" and straight back into the matcher.
  for (const ragged of ["linkedin  member", "LinkedIn\n      Member", "  Deleted\tUser  ", "LinkedIn Member"]) {
    assert.equal(normalizeParticipant({ name: ragged }).name, UNNAMED, JSON.stringify(ragged));
  }
});

test("collapsing whitespace cannot swallow a real person", () => {
  // Every comparison stays whole-string, so the near-misses survive.
  assert.equal(normalizeParticipant({ name: "Linda Memberly" }).name, "Linda Memberly");
  assert.equal(normalizeParticipant({ name: "Unknown Petrov" }).name, "Unknown Petrov");
  assert.equal(normalizeParticipant({ name: "Member Okafor" }).name, "Member Okafor");
  assert.equal(normalizeParticipant({ name: "Linda  Memberly" }).name, "Linda Memberly",
    "a name is stored tidied — a newline in a name is an artefact of the page, never the name");
});

test("a headline is tidied too, but a body never is", () => {
  assert.equal(normalizeParticipant({ name: "A", headline: "Head of\n   Nothing" }).headline, "Head of Nothing");
  assert.equal(clampBody("line one\nline two").body, "line one\nline two",
    "newlines are the message in a body and only ever an artefact in a name");
});

test("a ragged placeholder reaches no outreach row", () => {
  const rows = [{ id: "r", person_name: "LinkedIn Member", person_linkedin: null, created_at: "2026-09-01T00:00:00Z" }];
  assert.equal(matchOutreachRow(rows, { name: "LinkedIn\n   Member", slug: null }), null,
    "the collision closed by the fold must not reopen through a line break");
});

test("two unnameable threads are two people, not one outreach row matched twice", () => {
  const rows = [{ id: "r", person_name: "LinkedIn Member", person_linkedin: null, created_at: "2026-09-01T00:00:00Z" }];
  assert.equal(matchOutreachRow(rows, normalizeParticipant({ name: "LinkedIn Member" })), null);
  assert.equal(matchOutreachRow(rows, { name: "LinkedIn Member", slug: null }), null,
    "safe even when the participant skipped the normalizer");
});

test("a message with no body is the only fatal thing", () => {
  assert.equal(normalizeMessage(message({ body: "   " }), { threadKey: "t", receivedAt: RECEIVED }), null);
  assert.equal(normalizeMessage(message({ body: undefined }), { threadKey: "t", receivedAt: RECEIVED }), null);
});

test("a direction that is neither in nor out is dropped, not guessed", () => {
  assert.equal(normalizeMessage(message({ direction: "sideways" }), { threadKey: "t", receivedAt: RECEIVED }), null);
});

test("an unparseable sentAt becomes the time we learned of it, with the original kept", () => {
  const stored = normalizeMessage(message({ sentAt: "2h" }), { threadKey: "t", receivedAt: RECEIVED });
  assert.equal(stored.sentAt, RECEIVED);
  assert.equal(stored.sentAtGiven, false, "a screen showing a clock reading nobody took is lying");
  assert.equal(stored.sentAtRaw, "2h", "the label is what a person would check the substitute against");
});

test("a day-resolution timestamp is taken as given", () => {
  const stored = normalizeMessage(message({ sentAt: "2026-09-16T00:00:00.000Z" }), { threadKey: "t", receivedAt: RECEIVED });
  assert.equal(stored.sentAt, "2026-09-16T00:00:00.000Z");
  assert.equal(stored.sentAtGiven, true);
});

test("a missing externalId is derived, and the same payload derives the same one", () => {
  const options = { threadKey: "t", receivedAt: RECEIVED };
  const first = normalizeMessage(message({ externalId: undefined }), options);
  const second = normalizeMessage(message({ externalId: undefined }), { threadKey: "t", receivedAt: "2026-09-17T00:00:00.000Z" });
  assert.ok(first.externalId);
  assert.equal(first.externalId, second.externalId,
    "derived from what was sent, not from when it arrived — otherwise re-posting stores a second copy");
});

test("the derived id changes when the message does", () => {
  const base = { threadKey: "t", direction: "in", body: "hello", sentAt: "2h" };
  assert.notEqual(externalIdFor(base), externalIdFor({ ...base, body: "goodbye" }));
  assert.notEqual(externalIdFor(base), externalIdFor({ ...base, direction: "out" }));
  assert.notEqual(externalIdFor(base), externalIdFor({ ...base, threadKey: "other" }));
});

test("a thread needs a key and nothing else", () => {
  assert.equal(normalizeThreadInput({ messages: [] }).error, "A thread needs a threadKey");
  assert.equal(normalizeThreadInput({ threadKey: "   " }).error, "A thread needs a threadKey");
  assert.equal(normalizeThreadInput({ threadKey: "t", messages: "nope" }).error, "messages must be an array");
});

test("an empty conversation is accepted — the agent opened it and could not read it", () => {
  const input = normalizeThreadInput({ threadKey: "t", participant: { name: "Nobody" }, messages: [] });
  assert.equal(input.error, undefined);
  assert.deepEqual(input.messages, []);
  assert.equal(input.invalid, 0);
});

test("one unreadable message does not cost the ones around it", () => {
  const input = normalizeThreadInput({
    threadKey: "t",
    participant: { name: "Somebody" },
    messages: [
      message({ externalId: "a", body: "first" }),
      message({ externalId: "b", body: "" }),
      message({ externalId: "c", direction: "up" }),
      message({ externalId: "d", body: "last", sentAt: "yesterday" })
    ]
  });
  assert.equal(input.messages.length, 2);
  assert.equal(input.invalid, 2);
  assert.equal(input.undated, 1);
});

// ── duplicate suppression ─────────────────────────────────────────────────

test("what is already stored is skipped, not stored twice", () => {
  const messages = [{ externalId: "a" }, { externalId: "b" }, { externalId: "c" }];
  const { fresh, skipped } = splitStored(messages, new Set(["a", "c"]));
  assert.deepEqual(fresh.map((m) => m.externalId), ["b"]);
  assert.equal(skipped.length, 2);
});

test("a payload that repeats itself is deduplicated too", () => {
  const { fresh, skipped } = splitStored([{ externalId: "a" }, { externalId: "a" }], new Set());
  assert.equal(fresh.length, 1, "the read-before-write cannot see the second copy inside one array");
  assert.equal(skipped.length, 1);
});

test("nothing stored yet means everything is new", () => {
  const { fresh, skipped } = splitStored([{ externalId: "a" }, { externalId: "b" }], new Set());
  assert.equal(fresh.length, 2);
  assert.equal(skipped.length, 0);
});

// ── matching a reply to an approach ───────────────────────────────────────

const ROWS = [
  { id: "old", person_name: "Jane Doe", person_linkedin: "https://www.linkedin.com/in/jane-doe/", status: "declined", created_at: "2026-01-01T00:00:00Z" },
  { id: "new", person_name: "Jane Doe", person_linkedin: "linkedin.com/in/JANE-DOE", status: "pending", created_at: "2026-09-01T00:00:00Z" },
  { id: "nolink", person_name: "Namely Matched", person_linkedin: null, status: "pending", created_at: "2026-09-02T00:00:00Z" }
];

test("the slug matches across spellings and prefers the live attempt", () => {
  const match = matchOutreachRow(ROWS, { name: "Someone Else", slug: "jane-doe" });
  assert.equal(match.id, "new", "a person approached twice is credited to the newest row");
});

test("the slug wins over the name when they disagree", () => {
  const match = matchOutreachRow(ROWS, { name: "Namely Matched", slug: "jane-doe" });
  assert.equal(match.id, "new", "a link is the same string on both sides; a name is a guess");
});

test("an exact name matches when there is no link on file", () => {
  const match = matchOutreachRow(ROWS, { name: "  namely matched  ", slug: null });
  assert.equal(match.id, "nolink");
});

test("no match is the ordinary case, not a failure", () => {
  assert.equal(matchOutreachRow(ROWS, { name: "Complete Stranger", slug: "stranger" }), null);
  assert.equal(matchOutreachRow([], { name: "Jane Doe", slug: "jane-doe" }), null);
});

test("a near-miss name does not match", () => {
  assert.equal(matchOutreachRow(ROWS, { name: "Jane Doe Jr", slug: null }), null,
    "the cost of a wrong match is a reply filed against a stranger and a status moved on somebody who never answered");
});

test("an unreadable participant matches nobody", () => {
  assert.equal(matchOutreachRow([{ id: "u", person_name: "Unknown", person_linkedin: null, created_at: "2026-09-01T00:00:00Z" }],
    { name: "Unknown", slug: null }), null, "Unknown is what a missing name becomes, and it is not a name");
});

test("the CRM line names the account the reply arrived on", () => {
  const content = crmContent("chloe@example.co", "Yes, interested.");
  assert.match(content, /chloe@example\.co/, "the sales team has no other way to know which login they answered");
  assert.match(content, /Yes, interested\./);
  assert.ok(crmContent("a@b.co", "x".repeat(5000)).length <= 2000);
});

// ── grouping and unread ───────────────────────────────────────────────────

test("messages group into threads by account and key", () => {
  const threads = deriveThreads([
    event({ threadKey: "t-1", sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" }),
    event({ threadKey: "t-1", direction: "out", body: "reply", sentAt: "2026-09-15T10:00:00Z", storedAt: "2026-09-15T10:05:00Z" }),
    event({ threadKey: "t-2", sentAt: "2026-09-14T09:00:00Z", storedAt: "2026-09-14T09:05:00Z" })
  ]);
  assert.equal(threads.length, 2);
  assert.equal(threads.find((thread) => thread.threadKey === "t-1").messageCount, 2);
});

test("one conversation on two accounts is two threads", () => {
  const threads = deriveThreads([
    event({ accountId: "acc-1", threadKey: "same", sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" }),
    event({ accountId: "acc-2", threadKey: "same", sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" })
  ]);
  assert.equal(threads.length, 2, "LinkedIn's conversation id is stable per account, not across them");
});

test("lastMessage is the newest by sentAt, whatever order the events arrived in", () => {
  const [thread] = deriveThreads([
    event({ body: "newest", sentAt: "2026-09-15T12:00:00Z", storedAt: "2026-09-15T09:00:00Z" }),
    event({ body: "oldest", sentAt: "2026-09-15T08:00:00Z", storedAt: "2026-09-15T13:00:00Z" })
  ]);
  assert.equal(thread.lastMessage.body, "newest");
});

test("an inbound message nobody has opened is unread", () => {
  const [thread] = deriveThreads([event({ sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" })]);
  assert.equal(thread.unread, true);
});

test("a thread with only outbound messages is never unread", () => {
  const [thread] = deriveThreads([
    event({ direction: "out", sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" })
  ]);
  assert.equal(thread.unread, false, "our own message arriving back is not somebody writing to us");
});

test("a read mark after the message clears it", () => {
  const [thread] = deriveThreads(
    [event({ sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" })],
    { readMarks: new Map([[JSON.stringify(["acc-1", "t-1"]), "2026-09-15T10:00:00Z"]]) }
  );
  assert.equal(thread.unread, false);
});

test("a reply stored after the read mark makes it unread again, even when dated before it", () => {
  const [thread] = deriveThreads(
    [
      event({ body: "read this one", sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" }),
      // Written at 09:30, synced at 11:00 — after you opened the thread at 10:00.
      event({ body: "never seen", sentAt: "2026-09-15T09:30:00Z", storedAt: "2026-09-15T11:00:00Z" })
    ],
    { readMarks: new Map([[JSON.stringify(["acc-1", "t-1"]), "2026-09-15T10:00:00Z"]]) }
  );
  assert.equal(thread.unread, true,
    "unread is derived from when we stored it, not when LinkedIn says it was sent — otherwise a late sync is invisible");
});

test("a read mark on another thread does not clear this one", () => {
  const [thread] = deriveThreads(
    [event({ threadKey: "t-1", sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" })],
    { readMarks: new Map([[JSON.stringify(["acc-1", "t-other"]), "2026-09-16T00:00:00Z"]]) }
  );
  assert.equal(thread.unread, true);
});

test("the newest participant wins, so a headline that changed is current", () => {
  const [thread] = deriveThreads([
    event({ sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z", participant: { name: "Jane", headline: "Old role" } }),
    event({ sentAt: "2026-09-16T09:00:00Z", storedAt: "2026-09-16T09:05:00Z", participant: { name: "Jane Doe", headline: "New role" } })
  ]);
  assert.equal(thread.participant.name, "Jane Doe");
  assert.equal(thread.participant.headline, "New role");
});

test("each thread carries its own account's last sync", () => {
  const [thread] = deriveThreads(
    [event({ sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" })],
    { syncedAt: new Map([["acc-1", "2026-09-16T08:00:00Z"]]) }
  );
  assert.equal(thread.lastSyncedAt, "2026-09-16T08:00:00Z");
});

test("unread first, then newest — a reply outranks a plan", () => {
  const threads = [
    { unread: false, lastMessage: { sentAt: "2026-09-16T00:00:00Z" } },
    { unread: true, lastMessage: { sentAt: "2026-09-10T00:00:00Z" } },
    { unread: true, lastMessage: { sentAt: "2026-09-14T00:00:00Z" } },
    { unread: false, lastMessage: { sentAt: "2026-09-12T00:00:00Z" } }
  ].sort(byUnreadThenNewest);
  assert.deepEqual(threads.map((thread) => `${thread.unread ? "u" : "r"}:${thread.lastMessage.sentAt.slice(8, 10)}`),
    ["u:14", "u:10", "r:16", "r:12"]);
});

test("an event with no thread key is skipped rather than grouped into nothing", () => {
  const threads = deriveThreads([
    { account_id: "acc-1", type: "message.in", created_at: "2026-09-15T09:00:00Z", meta: { body: "orphan" } },
    event({ sentAt: "2026-09-15T09:00:00Z", storedAt: "2026-09-15T09:05:00Z" })
  ]);
  assert.equal(threads.length, 1);
});

// ── counted per account ───────────────────────────────────────────────────

/** A thread as the list hands it on, which is all the summary reads. */
function listed({ accountId = "acc-1", threadKey = "t-1", unread = false, sentAt = "2026-09-15T09:00:00.000Z" }) {
  return { accountId, threadKey, unread, lastMessage: { direction: "in", body: "hi", sentAt } };
}

test("each account is counted once, with its own unread", () => {
  const [first, second] = summarizeAccounts([
    listed({ accountId: "acc-1", threadKey: "a", unread: true }),
    listed({ accountId: "acc-1", threadKey: "b" }),
    listed({ accountId: "acc-2", threadKey: "c" })
  ]);
  assert.equal(first.accountId, "acc-1");
  assert.deepEqual([first.threads, first.unread], [2, 1]);
  assert.deepEqual([second.threads, second.unread], [1, 0]);
});

test("an account with something waiting outranks a busier one with nothing", () => {
  const order = summarizeAccounts([
    listed({ accountId: "quiet", threadKey: "a" }),
    listed({ accountId: "quiet", threadKey: "b" }),
    listed({ accountId: "quiet", threadKey: "c" }),
    listed({ accountId: "waiting", threadKey: "d", unread: true })
  ]).map((account) => account.accountId);
  assert.deepEqual(order, ["waiting", "quiet"], "unread is what needs a person, volume is not");
});

test("two waiting accounts are ordered by how much is waiting", () => {
  const order = summarizeAccounts([
    listed({ accountId: "one", threadKey: "a", unread: true }),
    listed({ accountId: "many", threadKey: "b", unread: true }),
    listed({ accountId: "many", threadKey: "c", unread: true })
  ]).map((account) => account.accountId);
  assert.deepEqual(order, ["many", "one"]);
});

test("accounts with nothing unread fall back to the freshest reply", () => {
  const order = summarizeAccounts([
    listed({ accountId: "old", threadKey: "a", sentAt: "2026-09-01T09:00:00.000Z" }),
    listed({ accountId: "new", threadKey: "b", sentAt: "2026-09-20T09:00:00.000Z" })
  ]).map((account) => account.accountId);
  assert.deepEqual(order, ["new", "old"]);
});

test("the newest reply on an account is the newest of its threads", () => {
  const [account] = summarizeAccounts([
    listed({ threadKey: "a", sentAt: "2026-09-10T09:00:00.000Z" }),
    listed({ threadKey: "b", sentAt: "2026-09-18T09:00:00.000Z" }),
    listed({ threadKey: "c", sentAt: "2026-09-14T09:00:00.000Z" })
  ]);
  assert.equal(account.newestAt, "2026-09-18T09:00:00.000Z");
});

test("a thread with no account is not a group of its own", () => {
  assert.deepEqual(summarizeAccounts([{ threadKey: "orphan", unread: true }]), []);
});

test("no threads is no accounts, not an account holding nothing", () => {
  assert.deepEqual(summarizeAccounts([]), []);
});
