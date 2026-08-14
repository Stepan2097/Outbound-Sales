# Advantage CRM <-> Outbound Sales OS Contract

This contract supports deterministic two-way synchronization without coupling Outbound OS to CRM screen behavior.

## Connection

Choose one integration path:

1. Preferred: Supabase REST URL plus a newly generated server-side `service_role` key.
2. Alternative: a CRM API base URL plus a Bearer token implementing the endpoints below.
3. Last resort: Postgres host, port, database, user, password, and TLS requirements.

Secrets must be added to Coolify environment variables, never to frontend code or Git.

## Observed Contact Schema

The 121 CRM records already imported into Outbound OS contain these fields:

`id`, `created_at`, `name`, `email`, `phone`, `lifecycle_stage`, `owner_id`, `lead_status`, `linkedin`, `facebook`, `instagram`, `deleted_owner_email`, `folder_id`, `company`, `position`, `category`, `website`, `description`, `country`, `twitter`, `telegram`, `fts`, `custom_fields`.

The developer must confirm the table name, currently assumed to be `contacts`, and whether `custom_fields` is JSONB.

## Required Objects

### Contacts

- Read contacts by `folder_id`, `id`, and incremental `updated_at` cursor.
- Update only these approved fields: `email`, `phone`, `linkedin`, `facebook`, `telegram`, `website`, `position`, `company`, `lead_status`, `lifecycle_stage`, `owner_id`, and `custom_fields`.
- Add `updated_at timestamptz` if it does not exist.
- Preserve the CRM `id` as the immutable cross-system contact ID.

Recommended Outbound OS values inside `custom_fields.outbound_os`:

```json
{
  "research_status": "complete",
  "product_id": "ad-action-value-exchange-ua",
  "lead_score": 64,
  "reach_probability": 40,
  "close_probability": 29,
  "next_action": "Send LinkedIn invitation",
  "next_action_due_at": "2026-08-17T09:00:00Z",
  "last_researched_at": "2026-08-14T09:00:00Z",
  "source_revision": "outbound-os"
}
```

### Activities

The current bridge writes `contact_id`, `user_id`, `type`, and `content` to the assumed `activities` table.

Required activity types: `linkedin`, `email`, `whatsapp`, `call`, `meeting`, and `note`.

Add or confirm these fields for reliable synchronization:

- `id uuid`
- `contact_id uuid`
- `user_id uuid nullable`
- `type text`
- `content text`
- `external_id text unique` for idempotency
- `channel text nullable`
- `outcome text nullable`
- `occurred_at timestamptz`
- `metadata jsonb default '{}'`
- `created_at timestamptz`

Outbound OS will use a stable `external_id` for each copied/sent/logged action so retries cannot create duplicates.

### Tasks

Create or confirm a `tasks` object with:

- `id uuid`
- `contact_id uuid`
- `owner_id uuid nullable`
- `title text`
- `description text nullable`
- `channel text nullable`
- `due_at timestamptz`
- `status text`: `open`, `completed`, or `cancelled`
- `external_id text unique`
- `metadata jsonb default '{}'`
- `created_at` and `updated_at`

Outbound OS must be able to create a follow-up task, mark it complete, reschedule it, and read CRM-side changes back.

### Opportunities And Outcomes

Provide either an `opportunities` table or an outcome view containing:

- `contact_id`
- `stage`
- `status`: `open`, `won`, or `lost`
- `value` and `currency` when available
- `reply_status`
- `meeting_booked_at`
- `lost_reason`
- `updated_at`

These records are required to train scoring from replies, meetings, opportunities, wins, losses, and no-response outcomes.

## Custom API Alternative

If direct Supabase access is not approved, implement:

```text
GET    /contacts?folder_id={uuid}&updated_after={iso}&limit={n}&cursor={cursor}
GET    /contacts/{id}
PATCH  /contacts/{id}
GET    /contacts/{id}/activities?updated_after={iso}
POST   /contacts/{id}/activities
GET    /contacts/{id}/tasks
POST   /contacts/{id}/tasks
PATCH  /tasks/{id}
GET    /outcomes?updated_after={iso}&cursor={cursor}
```

Responses must be JSON. Create endpoints must accept an `external_id` and return the existing record for duplicate requests.

## Conflict Rules

- CRM owns contact identity, folder, owner, and manually edited contact details.
- Outbound OS owns research snapshots, scores, generated messages, and AI recommendations.
- A seller approval is required before an enriched email or phone replaces an empty CRM value.
- Outbound OS never overwrites a non-empty CRM email or phone automatically.
- Newer manual CRM edits win over automated values.
- Activity records are append-only and idempotent.
- Task completion from either system must synchronize to the other.

## Developer Deliverables

1. Confirm table names and provide the SQL schema for contacts, activities, tasks, users, companies, and opportunities/outcomes.
2. Generate a new server-only Supabase service-role key, or provide the custom API token.
3. Confirm the production CRM project URL and allowed folder IDs.
4. Add `updated_at` and `external_id` fields where missing.
5. Provide one test contact ID and one test CRM user/owner ID.
6. Confirm the mapping from CRM users to Outbound OS login emails.
7. Confirm whether deletes are soft deletes and which field indicates deletion.
8. Confirm GDPR/consent rules and which countries may receive email, phone, WhatsApp, Telegram, or SMS outreach.

## Acceptance Test

The integration is complete when one test lead can be imported, researched, enriched, approved, logged with LinkedIn and email activities, assigned a follow-up task, updated in CRM, changed in CRM, and synchronized back without duplicate records.
