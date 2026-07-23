# Integration Handoff

## Current Runtime Truth

The local platform now supports live OpenRouter generation. Analysis/coaching defaults to `anthropic/claude-haiku-4.5`; outreach writing defaults to `anthropic/claude-sonnet-5`. Secrets are stored only in the running server's in-memory encrypted vault, so they must be re-entered after restart until a production secret store is added.

The supplied Supabase REST URL is reachable but requires an API key. The supplied Postgres host and port are reachable, but database authentication requires the Postgres password.

## Needed From Your Team

### OpenRouter

- OpenRouter API key.
- Allowed model list for Fast, Balanced, Strategic outreach.
- Preferred default model for outreach generation, lead analysis, transcript analysis, and CRM note summaries.

### MCP + Knowledge Base

- MCP portal base URL.
- Authentication method and token.
- Product, lead, and knowledge-base resource namespaces or endpoints.
- JSON shape for product records:
  - product id, name, category, positioning
  - target personas
  - use cases
  - proof points
  - differentiators
  - objections
  - approved outreach examples
  - compliance constraints
- JSON shape for lead/account context if MCP should enrich prospects:
  - lead id, CRM id, LinkedIn URL, email
  - account notes, segment, lifecycle stage
  - prior conversations, objections, active opportunities
  - approved knowledge-base snippets or source ids
- Whether MCP is read-only or whether Outbound OS should write training examples back.

### Apify Scrapers

- Apify API token.
- Actor IDs for:
  - primary lead database enrichment; current provided actor is `kVYdvNOefemtiDXO5` / `pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe`
  - LinkedIn profile enrichment
  - generic contact finder
  - Apollo enrichment, if authorized
  - ZoomInfo enrichment, if authorized
  - Facebook/person profile matching, if authorized
  - email and phone discovery
  - WhatsApp/Telegram phone presence checks, if authorized
- Actor input schema for each Actor.
- For the lead database actor, paste a working input JSON template from the Apify console. Supported placeholders include `{{name}}`, `{{firstName}}`, `{{lastName}}`, `{{company}}`, `{{title}}`, `{{location}}`, `{{domain}}`, `{{website}}`, `{{linkedinUrl}}`, and `{{phones}}`.
- Actor output field mapping for email, phone, LinkedIn, Facebook, company, title, confidence, and source.
- Match evidence fields such as name match, company match, geo/location match, mutual connections, and source URL.
- Messenger presence fields such as `whatsappExists`, `hasWhatsapp`, `telegramExists`, or equivalent.
- Maximum charge per run.
- Rate limits and allowed usage policy.

### Apollo / ZoomInfo

Use official APIs or authorized exports where possible. If using Apify Actors against Apollo or ZoomInfo, confirm your account terms allow that workflow. The platform should store source, confidence, and review status for every returned contact detail.

### Custom CRM

- CRM API base URL.
- Authentication method and token.
- Object names for Lead, Contact, Account, Activity/Task, and Opportunity.
- Lead pull endpoint or Supabase table name that contains LinkedIn leads.
- LinkedIn field name, for example `linkedin_url`, `linkedin`, or `profile_url`.
- Activity push endpoint for logging Outbound OS actions back to lead cards.
- Required fields for create/update.
- Field mappings:
  - prospect id
  - name
  - title
  - company
  - LinkedIn URL
  - email
  - phone
  - product
  - outreach status
  - reach probability
  - close probability
  - last interaction
  - next best action
  - follow-up task due date
  - call summary
  - call quality score
- Webhook endpoint or polling strategy for historical activity and outcomes.
- Decision on sync direction:
  - push only from Outbound OS
  - pull CRM history into Outbound OS
  - two-way sync with conflict rules

### Call Transcripts

- Transcript provider: Gong, Zoom, Google Meet, Aircall, Twilio, Fireflies, or custom.
- API token or webhook signing secret.
- Webhook payload sample with prospect matching fields.
- Call metadata fields: call id, owner, start time, duration, participants, recording URL.
- Transcript text format and speaker labels.
- Consent/recording policy by country and channel.

Outbound OS currently accepts:

```http
POST /api/webhooks/call-transcript
```

Matching priority: `prospectId`, `linkedinUrl`, `email`, then `name` + `company`.

### Notifications

- Preferred notification target: CRM task, Slack channel, email, or in-app only.
- Owner assignment rule.
- Follow-up SLA rules by call sentiment, product, and deal stage.

## Next Engineering Steps

1. Provide Supabase anon/service-role key and Postgres password.
2. Confirm CRM lead source: Supabase table name or custom CRM endpoint, plus LinkedIn field mapping.
3. Confirm CRM activity endpoint for logging AI Operator actions back to lead cards.
4. Replace in-memory state with Postgres tables.
5. Persist encrypted credentials in a server-side secret store.
6. Wire MCP product, lead, and knowledge-base sync to your real schema.
7. Add a tested Apify input template for the provided lead database actor, then run a low-charge enrichment test.
8. Wire CRM push/pull, task creation, and activity history ingestion.
9. Wire transcript provider webhooks.
10. Train scoring on real historical outcomes instead of seeded demo priors.
