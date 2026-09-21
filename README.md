# Outbound Sales OS

Local outbound workspace for researching prospects, generating product-specific outreach, analyzing calls, and tracking follow-ups.

## Sales Workflow

- Upload or paste people profiles as CSV or JSON.
- Select the product being sold so outreach changes by product.
- Describe each product with the eight answers on the Products page, and keep its knowledge files beside them.
- Paste a LinkedIn profile URL to create a target, find contact candidates, and generate LinkedIn message variations.
- Sync product positioning, ICP, use cases, proof points, objection handling, and approved context from the MCP Product Context Portal.
- Save MCP, Apify, CRM, transcript, and follow-up notification settings in one Settings area.
- Connect OpenRouter directly from Settings, with `anthropic/claude-haiku-4.5` for analysis/coaching and `anthropic/claude-sonnet-5` for outreach writing.
- Check Supabase REST and Postgres reachability from Settings.
- Review prospect fit, title, company, location, notes, and account context.
- Open the Account Strategy tab for the complete A-M AdAction brief: recent signals, title analysis, growth hypotheses, stakeholder-specific routes, first touch, conversation tree, consultation CTA, multi-thread sequence, risks, and deterministic 1-10 scores.
- Generate public contact-discovery candidates, including business email patterns, LinkedIn search links, Facebook people-search links, and web search links.
- Prepare AI-generated outreach messages across email, LinkedIn, and call opener.
- Paste call transcripts or connect a transcript webhook to get call-quality analysis, coaching tips, follow-up templates, and a next task.
- Create and log next actions for review, connection, email approval, follow-up, replies, and booked meetings.
- Track historical lead interactions and use them to estimate chance of reaching the lead and chance of closing.
- Use the AI Operator tab for bulk sales actions such as sorting leads, changing statuses, logging interactions, preparing outreach, refreshing contact discovery, and pulling LinkedIn-heavy leads from CRM/Supabase.
- Configure one primary Apify lead database actor plus optional specialist actors for LinkedIn profile enrichment, email/phone discovery, Facebook/person matching, Apollo/ZoomInfo, and WhatsApp/Telegram phone presence checks.
- Use a cost-capped Apify waterfall for company people, work-email, and phone enrichment. It stops when verified email and phone are found, limits actors per lead, and reuses recent verified results.
- Keep email, phone, WhatsApp, Telegram, and SMS locked until the seller approves the matched contact and channel.

## The Panel

The Panel is the seller's working screen: pick a product and a CRM folder, and
the folder is worked from the top down. There is no browsing it — the queue
hands over one person at a time, oldest first, full screen, with everything the
workspace knows about them, and the only navigation is **Назад** / **Далі**. The
position is kept per browser, so somebody who stopped on contact 37 yesterday
opens on contact 37 today. Each person walked past is taken into the lead queue
carrying their CRM id, which is what the research, the drafts and the CRM
activity hang off; the same person opened twice is still one lead.

**Збагатити** runs the whole pipeline on the person in front of you: the
company and its products, the people in it, verified contacts, the fit score,
then a description of the client and ways to open the conversation, then the
message angles and the CRM activity. Each stage says what it found while it
runs.

The company half is done once per company, not once per contact. What the web
research found is written to `accountDossiers` in the workspace's saved state,
keyed by CRM account id, domain, or company name — so the second person from a
company already researched starts from that dossier instead of searching again,
and the stage says so on screen. The dossier is good for thirty days; its news
signals for seven, after which only that one search is repeated. **Перешукати
компанію** ignores the dossier and searches from scratch.

The description and the approaches are written by the model from the new
findings plus whatever the workspace already had — and, with no OpenRouter key
or a provider that is down, by the workspace itself from the same facts, marked
as written without a model.

### The texts

The **Повідомлення** tab holds the drafts themselves: the LinkedIn invitation
and first message, the email with its subject, and Telegram, each with a copy
button that logs the touch against the lead. They are written in the seller's
language — Ukrainian unless the language select says otherwise — and they expand
the approach chosen in the description rather than inventing a fresh reason to
write, because the prompt now carries `clientProfile`, the person's open
channels and the cached company facts. Channel rules (a 300-character
invitation, an email under 90 words, a Telegram message under 60) come from
`contacts/drafts.mjs`, the same file the Контакти tab writes by, so the two
screens cannot drift apart. **Переписати тексти** re-runs only the writing —
one model call, not the seven research stages.

An unconfirmed product fit no longer means no text. It used to short-circuit
before the model and leave an English "Do not send yet" template in every
channel; now it is a constraint the model writes under — no pitch, no offer, no
claimed outcome, one question that would tell the seller whether this is even
the right kind of company — and the panel says on screen what is unverified.
The lead still stays in `review`: writing a first touch and clearing it to be
sent are different things, and this workspace never sends anything by itself.

A Telegram username on a CRM card is now a contact candidate a seller can
approve. It was not one before, so the channel could never be unlocked, which
for a good part of this market is the only channel that answers. Approval is
still a human decision; until it is given, the copy button is locked and says
why.

## Contacts

The Contacts tab reads the CRM directly: its folders, one page of a folder at a
time, and everything the CRM knows about one person. Nothing is written back —
the CRM is somebody else's system of record — and nothing lands in this
workspace until somebody presses **Додати в ліди**, which takes the contact into
the lead queue carrying its CRM id, so importing the same person twice is still
one lead.

With a contact open, one call writes three drafts for three channels: an email
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

## Products and Knowledge Base

The workspace sells two things — **AdAction** and **advantage-course** — and one
page holds both what they are and what the agents read about them.

A product is described by eight answers, and nothing else: what we sell and what
the buyer gets, who it fits, who decides and what they care about, the pain and
when it gets loud, the proof we may use, the first small step we ask for, the
objections and our honest answer, and who we never sell to or claim to. Saving
them derives everything the rest of the app already reads — positioning,
personas, use cases, proof, objections and the memory segments scoring runs on —
so the answers are the source and the derived record is never edited by hand.

Below the answers sits that product's file library. Files are plain Markdown on
the server, beside the workspace state file
(`<STATE_FILE_PATH dir>/knowledge/`), with a small `index.json` recording which
file belongs to which product. They can be created, edited and deleted from the
page. One file can belong to several products: the outbound playbook ships that
way, shared by both, because a copy per product is two documents that disagree
within a month.

Every agent that writes for a product reads that product's brief and files
before it writes. Whole documents do not go into prompts: passages are selected
against the lead in front of the model, one file never takes the whole budget,
and a product with no files gets nothing rather than somebody else's rules.

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
  heavier phase.
- A run stores a snapshot of the strategy it started under, so editing one never
  rewrites what an account part-way through was working to.
- Connection requests go to real people from the CRM lead queue and are recorded
  against the account that sent them, with the person snapshotted. A unique index
  means the same person cannot be approached twice from any account, and the
  quota is checked *before* the outreach row is written — a refused request
  leaves nothing behind.

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

## Optional FullEnrich Webhook

Verified contact results are accepted at:

```http
POST /api/webhooks/fullenrich?token={FULLENRICH_WEBHOOK_SECRET}
```
