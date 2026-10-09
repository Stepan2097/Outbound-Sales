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
| `thread-cards.html` | A thread that holds only picture rows — avatars described to a screen reader as «Переглянути профіль Sinan», no text, no attachment. Production showed these as «conversations» whose message was `[no text]`; they are not messages, and a thread of nothing else is not sent. |
| `thread-cards-mixed.html` | A real conversation with a picture row in the middle of it and a file at the end: three messages out, not four. The picture must not become `[no text]` and must not decide who the next bubble belongs to. |
| `thread-composer.html` | An open conversation with a composer that works: a contenteditable textbox and a send button, live only when there is text. The test server writes a `MODE` into the page so the button can do the thing under test — show the message (`ok`), swallow it (`silent`, the failure that looks like success from the field alone), never come alive (`dead`), sit beside a second composer (`two`), vanish (`none`), refuse the cursor (`nofocus`), stop taking text after thirty characters (`trunc`), or follow a conversation that already ends with our message (`ours`). Used by `outbox.test.mjs`. |
| `messaging-empty.html` | An inbox with nothing in it. Zero threads here is the truth, not a failure. |
| `messaging-rotted.html` | The day the anchors go: conversations rendered as `<button>`s with the id in a data attribute. Zero threads here **is** a failure, and the reader has to say so out loud rather than report a quiet zero. |

Run them with `node --test agent/inbox-dom.test.mjs`. The tests parse these files
in a local headless Chromium over a `data:` URL — a real DOM, no network, and no
LinkedIn.

## messaging-list-nolinks.html

Список розмов, як LinkedIn віддав його 08.10.2026: на сторінці **немає жодного**
посилання на `/messaging/thread/`. Рядок — це `li` з `tabindex`, аватаркою,
`time` і обробником кліку всередині; id розмови існує лише в адресному рядку
після того, як рядок відкрили.

Зібрана з read-only огляду живого месенджера (ember-id і хешовані класи
лишені такими, як на живій сторінці — читач, що спирається на будь-який із них,
ловиться тут). `messaging-rotted.html` поруч — це та сама поломка, передбачена
заздалегідь; тепер обидві читаються за формою рядка, а голосний нуль лишився
для сторінки, де немає навіть форми.
