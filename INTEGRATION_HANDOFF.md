# Integration Handoff

## Current Runtime Truth

The platform supports live OpenRouter generation. Analysis defaults to `anthropic/claude-haiku-4.5`; outreach writing defaults to `anthropic/claude-sonnet-5`. Production secrets should be supplied through Coolify environment variables and are never returned to the browser.

The Advantage CRM Supabase service-role connection has been verified with HTTP 200 access. Its schema exposes 27 tables including `contacts`, `companies`, `activities`, `tasks`, and `deals`. The AdAction EMEA prospect folder is readable, and CRM activity logging works for leads imported with their CRM identifiers. The separate private Supabase knowledge database is also reachable with HTTP 200 and exposes 38 tables including `wiki_pages`, `lesson_embeddings`, and `knowledge_gaps`. These two Supabase connections must remain separate in deployment settings.

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

### Verified Email + Phone

The default enrichment path is a cost-capped Apify waterfall:

- `enrich-crm/enrich-crm-enrich-contact` for person-level work email and phone enrichment.
- `inexhaustible_glass/linkedin-email-finder` as a lower-cost domain/contact fallback.
- `harvestapi/linkedin-company-employees` for the primary company-people map.
- `scraper-engine/linkedin-company-employees-scraper` as the secondary people provider.
- `vtrdev/whatsapp-number-validator` and `akula.marketing/telegram-get-phone-info` only after a phone is found and approved.

The waterfall runs sequentially, stops when a verified work email and phone are available, caps the actors used per lead, and reuses recent verified results. FullEnrich remains an optional legacy webhook integration, not a prerequisite.

Needed from your team: approved countries and channels for phone/messenger outreach, plus confirmation that the selected Apify Actors and target-data sources are permitted for your use case.

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

1. Confirm the exact CRM conflict rules for bidirectional edits to lead status, task dates, and opportunity stage.
2. Map historical replies, meetings, opportunities, and losses into the scoring-training job.
3. Confirm the MCP portal contract if it should supplement the private knowledge Supabase.
4. Run a representative 25-50 lead Apify coverage and cost benchmark before raising per-lead spend caps.
5. Wire the selected call-transcript provider webhook.
6. Define approved countries, consent rules, and channel policies for phone, SMS, WhatsApp, and Telegram.
