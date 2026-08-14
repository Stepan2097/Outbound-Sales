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
- Generate public contact-discovery candidates, including business email patterns, LinkedIn search links, Facebook people-search links, and web search links.
- Prepare AI-generated outreach messages across email, LinkedIn, and call opener.
- Paste call transcripts or connect a transcript webhook to get call-quality analysis, coaching tips, follow-up templates, and a next task.
- Create and log next actions for review, connection, email approval, follow-up, replies, and booked meetings.
- Track historical lead interactions and use them to estimate chance of reaching the lead and chance of closing.
- Use the AI Operator tab for bulk sales actions such as sorting leads, changing statuses, logging interactions, preparing outreach, refreshing contact discovery, and pulling LinkedIn-heavy leads from CRM/Supabase.
- Configure one primary Apify lead database actor plus optional specialist actors for LinkedIn profile enrichment, email/phone discovery, Facebook/person matching, Apollo/ZoomInfo, and WhatsApp/Telegram phone presence checks.
- Use FullEnrich as the primary verified work-email and mobile-phone waterfall. Results arrive through an authenticated webhook and remain locked until seller approval.

Contact discovery is intentionally review-first. It creates public/business search candidates and confidence labels; it does not scrape private profiles or silently approve personal contact data.

See [INTEGRATION_HANDOFF.md](./INTEGRATION_HANDOFF.md) for the developer checklist and [CRM_API_CONTRACT.md](./CRM_API_CONTRACT.md) for the exact two-way CRM contract.

## Run

```bash
node server.mjs
```

Open [http://localhost:4173](http://localhost:4173).

The platform keeps OpenRouter and integration keys server-side in an in-memory encrypted vault. If no OpenRouter key is configured and tested, the app stays functional in mock AI mode. Local memory is reset when the server restarts; production should use a real secret store.

## Transcript Webhook

External call systems can POST transcripts to:

```http
POST /api/webhooks/call-transcript
```

Supported matching fields: `prospectId`, `linkedinUrl`, `email`, or `name` + `company`. Include `transcript` or `text` in the payload.

## FullEnrich Webhook

Verified contact results are accepted at:

```http
POST /api/webhooks/fullenrich?token={FULLENRICH_WEBHOOK_SECRET}
```
