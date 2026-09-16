# Outbound Sales OS

Local outbound workspace for researching prospects, generating product-specific outreach, analyzing calls, and tracking follow-ups.

## Sales Workflow

- Upload or paste people profiles as CSV or JSON.
- Select the product being sold so outreach changes by product.
- Add or edit product definitions directly in Product Studio.
- Load approved outreach examples per product as training context.
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
