# Outbound Sales OS

## Що це і навіщо

Головна ціль — **холодна розсилка**, і все тут збудоване навколо неї, щоб
спростити цей процес від початку до кінця:

1. **Вибрати базу контактів** — це має бути легко: кампанія бере людей із
   папки в CRM.
2. **ШІ допомагає написати листи** — у картці контакту чернетки повідомлень
   для LinkedIn, пошти й Telegram, під продукт і мову.
3. **Скрипт гріє LinkedIn-акаунти** — щодня, за розкладом, щоб акаунти жили
   як люди і їм можна було довіряти розсилку.
4. **Скрипт розсилає** — запити в друзі людям із папки, у межах денної норми
   кожного акаунта.
5. **Показує, що відповіли** — усі відповіді з усіх акаунтів в одному місці,
   на екрані «Вхідні».
6. **Усе записується у відомість про контакт** — кожен запит (і записка, якщо
   була), кожне наше повідомлення і кожна відповідь лягають рядком у картку
   людини в CRM.

Що не допомагає цьому процесу, в інтерфейсі не тримається.

## Інтерфейс — чотири екрани

**Прогрів** (where it opens) — the accounts, what each did today and does next,
and the campaign that feeds them people from a CRM folder. **Вхідні** — the
replies from every account, unread first; narrow them to one account or search
them (name, position, account, the words of the reply), and at the end of a
conversation step straight to the next unread one. The list refreshes itself when
a new reply arrives. **Контакти** — the CRM: a folder, its
people, one person's card with where their LinkedIn request stands, the whole
conversation, and a small form (product, language, an optional note) whose
button «Згенерувати три чернетки» has the model write them a letter, a Telegram
message and two LinkedIn texts to copy (nothing is sent by itself).
**Налаштування** — users, your password.

That is the whole menu, on purpose. On 08.10.2026 the owner asked for
everything superfluous to go (task 87001c96), and it went: the lead workspace
(«Панель»: enrichment, scoring, drafts, follow-ups), the AI operator,
«Продукти», and six hidden screens of an OpenRouter gateway. None of it was in
use — the lead workspace had not changed since 02.10 and the model had been
called once, ever. Only the interface went: the saved state, the server routes
and their tests are untouched, so nothing anybody entered is lost.

**Removed screens must not come back by a merge.** They did once — the merge
`f20ee6d` on 02.10 brought a long-lived branch's screens back with it.
`tests/ui-screens-fence.test.mjs` now fails when the menu is anything but these
four, or when a removed screen's markup or code reappears under `app/`. If a
screen really has to return, change that test in the same commit and say why.

## Connection requests

Writing to a stranger on LinkedIn means connecting first. The campaign on
**Прогрів** takes people from a CRM folder and puts each into one warmed
account's queue. The note follows the warm-up: none on days 4–10, at most three
words and no link from day 11 and in working mode. A note that breaks the rule
on the day the request goes out is dropped, never the request.

Into the queue, not out the door. **The daily allowance belongs to the account**
— the folder adds no more people to an account than its day allows. Nothing is
sent by this app itself: the agent does the clicking, and reports each result.

**One person gets one approach, from every account and every campaign.** A
unique index says so, and the folder steps over anybody already approached.

Then the account looks, once a day, at everything it has sent and reports what
LinkedIn shows: accepted, still pending, or gone. **It opens for this even after
its warm-up plan has finished** — warming has a last day and watching what it
sent does not, and an account reaches that last day holding exactly the requests
it sent most recently. It only opens when something is actually outstanding.

A reply in the inbox counts as an acceptance too. That is deliberate
duplication: the sent-invitations page is a screen somebody else controls and
its markup will change, and when it does, the record has to keep moving on the
evidence that matters more — that the person wrote back.

Accepted and silent is its own state, separate from "they replied". The first
message after acceptance is then written **by a person**. That is a decision about where judgement belongs, not a missing
feature: the mechanical half — sending, checking, recording — is the machine's,
and the conversation is not.

### One history per person

The contact card in **Контакти** answers the question somebody actually has in
front of a person: what has anybody here ever said to them, and what came back. It is
keyed by the contact, not by the conversation — a thread is one exchange on one
login, and the request, the messages and (when email lands) the letters are all
the same story.

Entries stored from this version on carry the contact's id and are exact.
Older ones are matched on a LinkedIn slug or a name, which is the matching that
breaks when somebody renames their profile, so those lines **say on screen that
they were matched by name**. A history that quietly guessed would be worse than
one that admits which half it is sure about.

**The same story is written to the CRM.** Each account's inbox is read once a
day, and every message of a thread it finds — what we wrote and what they
answered — becomes one line on the person's CRM activity timeline, once, with
its real time in the text; so does each connection request that goes out, with
the note it actually carried. A thread is tied to the person through the
account's approach, or, failing that, through the contact whose LinkedIn link
is that profile. A copy the CRM refused is made again on the next day's read.
The Contacts card shows the same conversation.

## Contacts

The Contacts tab reads the CRM directly: its folders, one page of a folder at a
time, and everything the CRM knows about one person, with the person's LinkedIn
conversation under it. The contact itself is never edited from here — the CRM
is somebody else's system of record; the only thing written to it is the
append-only activity line per message and per request described above.

With a contact open, the card has a small form: the product, the language, an
optional note (`Що врахувати`) and the button «Згенерувати три чернетки». The
language starts as Ukrainian for a contact from Ukraine and English for the rest,
and once somebody has been written to, the form comes back set as it was then.
The product starts as the one picked last time in this browser (the workspace's
own product only when nothing was picked), and the caption under the drafts names
the product they were written for.
The OpenRouter key is the server's (`OPENROUTER_API_KEY`); the card has no key
field. One call writes three drafts for three channels: an email
(subject and body), a Telegram message, and LinkedIn (an invitation note plus
the first message after it is accepted). The model is given the contact record,
the product's eight answers and passages from that product's knowledge files,
and it is told to invent nothing: a guess has to read as a guess. Each draft
says what it leaned on and what a human should verify. Drafts are saved per
contact, so reopening someone shows what was already written for them.

Without OpenRouter the page still answers, with plain drafts assembled from the
product brief and marked as such. Reading `WARMUP_CRM_SUPABASE_URL` /
`WARMUP_CRM_SERVICE_ROLE_KEY` (falling back to `SUPABASE_URL` /
`SUPABASE_API_KEY`); with neither set the tab says which variables are missing
rather than looking broken.

## LinkedIn Warm-up

The Warm-up tab warms LinkedIn accounts on a schedule that is data rather than
code. It reads the Supabase Anty syncs into, so the list *is* Anty's profiles for
the team in `ANTY_TEAM_ID` with this app's warm-up state joined on — an account
here that Anty does not have would be a browser profile nobody can open.

- A strategy is a row: phases carry day ranges and a `[min, max]` per action, so
  "run this account slower" is an edit, not a deploy.
- **An action with no quota in a phase is forbidden, not unlimited.** The API
  refuses it and says which day it was refused on.
- **Daily figures are seeded per account per day**, as is the session time —
  every account doing exactly five views a day is itself a pattern, and a figure
  that changed on refresh would leave nobody knowing what today's plan was.
- **A warning stops everything for the strategy's pause length**, and those days
  are subtracted from progress, so a flagged account does not return into a
  heavier phase. The operator's button, the agent's `warning` report and an
  invitation reported `blocked` all start it, and it ends by itself. Days after
  it on which nobody took the account count as paused too, so an account that
  sat stalled comes back on the day after its warning, not weeks further on.
- **One account at a time, first sessions first.** An account that has not had
  a session today goes before one that has, and the same account is not opened
  again until an hour after its last session finished
  (`WARMUP_SAME_DAY_GAP_MINUTES`); a failed one waits out the cool-off instead
  (`WARMUP_COOL_OFF_MINUTES`). On a day with more requests than one run
  carries, and people for them, the first session leaves two profile views
  for the next, so that one does not open on a Connect — even when the first
  failed part-way.
- A run stores a snapshot of the strategy it started under, so editing one never
  rewrites what an account part-way through was working to.
- Connection requests go to real people from the CRM lead queue and are recorded
  against the account that sent them, with the person snapshotted. A unique index
  means the same person cannot be approached twice from any account.
- **A running campaign feeds its accounts by itself.** From each ticked
  account's warm-up day N — the campaign's `fromDay`, 7 by default (days 4–6
  are the team's, picked by hand) — every ticked account's queue is topped up
  from the campaign's folder to what today still allows, after whatever a
  seller picked by hand, skipping anybody without a LinkedIn profile link or
  already approached from any account — by contact and by profile, so a person
  entered twice in the CRM is still one person.
  Somebody the browser could not reach, or a seller cancelled, is let go and
  never offered by the folder again — except after a `no_note` from an agent
  too old to send a bare request, or a report that came while an earlier
  block page already had the account paused, neither of which says anything
  about the person, so they go back to the pool; and no account takes more
  than twice its day's quota from a folder in one day, however many of those
  it hits. A person picked by hand whose request LinkedIn answered with a
  block page is parked for a seller at once (not when the account was
  already paused), and a report the agent retries is recorded once.
- **A request the campaign queue sends is refused before anything is written**,
  so a request that was never allowed leaves no trace claiming the person was
  approached. A request *asked for from the lead workspace* is the other way
  round: it is written first and waits for an allowance, because the seller is
  recording an intention rather than causing a send. And a request somebody
  already made by hand is recorded whatever the allowance says, flagged as over
  it — refusing a fact does not undo it.

Requests are recorded, not sent: the portal holds the plan and the record, and a
person or the local agent performs the actions. See `.env.example` for the
`ANTY_*`, `LINKEDIN_SECRET_KEY` and `WARMUP_CRM_*` variables it needs.

### The agent

`POST /api/warmup/agent` is the seam. The agent asks what is left of today and
reports each action as it lands, carrying no idea of the quota itself, so the
strategy on screen is the strategy that runs. It drives a real browser through
an Anty profile, which needs Anty and that profile's own browser directory on
the machine it runs on — see `cloud/` in the Anty repo for running one in a
container.

Contact discovery is intentionally review-first. It creates public/business search candidates and confidence labels; it does not scrape private profiles or silently approve personal contact data.

See [INTEGRATION_HANDOFF.md](./INTEGRATION_HANDOFF.md) for the developer checklist and [CRM_API_CONTRACT.md](./CRM_API_CONTRACT.md) for the exact two-way CRM contract.

## Run

```bash
node server.mjs
```

Open [http://localhost:4173](http://localhost:4173).

The platform keeps OpenRouter and integration keys server-side in an in-memory encrypted vault. Workspace records persist to the configured state volume, while production credentials should come from Coolify environment variables or a real secret store. If OpenRouter is unavailable, research still produces a conservative deterministic brief and visibly blocks unsupported outreach.

## Transcript Webhook

External call systems can POST transcripts to:

```http
POST /api/webhooks/call-transcript
```

Supported matching fields: `prospectId`, `linkedinUrl`, `email`, or `name` + `company`. Include `transcript` or `text` in the payload.

The webhook is closed until it has a token. Set `TRANSCRIPT_WEBHOOK_TOKEN` in the environment (and `TRANSCRIPT_PROVIDER`, optionally) to keep it open across deploys: the app has no screen for it, and a token set through the API is held in memory only and is gone at the next restart.

## Optional FullEnrich Webhook

Verified contact results are accepted at:

```http
POST /api/webhooks/fullenrich?token={FULLENRICH_WEBHOOK_SECRET}
```

## Local LinkedIn agent

The Mac browser agent is part of this repository in `agent/`. Install it with `npm ci --prefix agent`, configure `WARMUP_PORTAL` and `WARMUP_AGENT_TOKEN` in the root environment, and start it with `npm run agent`. The server controls the schedule and queues and enforces the daily strategy plus 60 requests per account over seven UTC dates. See `agent/README.md` for local verification and generating a LaunchAgent. The server container continues to run the API; the agent runs on the Mac that holds the Anty profiles.
