# Fixtures — what they are, and what they are not

These are **constructed**, not saved. Saving a real messaging page means opening
a real account's messenger, and an unscheduled session on a warming account is a
signal to LinkedIn — the exact thing the rest of this folder exists to avoid. So
they are built from LinkedIn's *published* structure instead: the parts of the
markup LinkedIn documents by using them, and which it cannot obfuscate without
breaking its own product.

What that means for trust:

- **The spine is safe.** A conversation is a link to `/messaging/thread/<id>`, a
  message author is a link to `/in/<slug>`, a timestamp is a `<time>`. These are
  the router's own URLs and the accessibility tree; they are the same in every
  build, in every locale, and they are what the reader depends on.
- **The class names are a guess.** `msg-s-message-list__event`,
  `msg-conversation-listitem__link` and friends are LinkedIn's semantic names as
  last published. They are used only as a *hint that is tried first*: every
  reader falls through to a structural pass that finds the same elements without
  them, and `harvestThread()` reports which pass answered (`how`). A fixture
  whose classes are wrong therefore still exercises the path that matters.
- **The arrangement is an assumption.** Grouped messages sharing one author
  header, day separators as their own list item, the conversation list living on
  the same page as the open thread — these are how the messenger behaved when
  this was written. If one of them is wrong, the tests pass and production does
  not, which is the honest limit of testing a page you are not allowed to open.

| File | What it is for |
|---|---|
| `messaging-list.html` | The conversation list: five rows, one of them a group thread with no `/in/` link, one with an emoji, one dated `Sep 12` rather than `2h`, plus the composer link that must *not* be read as a conversation. |
| `thread-reply.html` | An open conversation with the list still in the sidebar — the trap that any "biggest list on the page" heuristic falls into. Grouped bubbles, a `SEP 12` separator, an attachment with no text, a body that arrived with markup in it. |
| `thread-ours.html` | A conversation we did all the talking in, where the account's own slug is unknown and the only thing identifying us is our name. The direction test that matters. |
| `messaging-empty.html` | An inbox with nothing in it. Zero threads here is the truth, not a failure. |
| `messaging-rotted.html` | The day the anchors go: conversations rendered as `<button>`s with the id in a data attribute. Zero threads here **is** a failure, and the reader has to say so out loud rather than report a quiet zero. |

Run them with `node --test agent/inbox-dom.test.mjs`. The tests parse these files
in a local headless Chromium over a `data:` URL — a real DOM, no network, and no
LinkedIn.
