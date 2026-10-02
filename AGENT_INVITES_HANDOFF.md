# LinkedIn agent integration

The browser agent now lives in `agent/` in Outbound-Sales. Its source came from the supplied archive; no separate warm-up repository or Next.js application is needed.

`agent/README.md` describes installation, the worker, manual launches, local tests and the LaunchAgent generator. `CONTACT_OUTREACH_CONTRACT.md` describes the queue and report vocabulary.

## Implemented

- Worker lease → `GET /api/warmup/agent` → quota work → queued invitations → daily checks and inbox → session close → `run.finished`.
- Independent `playwright-core` dependency under `agent/`, with no absolute imports from another checkout.
- `invite.prepare` before a queued recipient: a fresh allowance and ownership check; a pause stops all browser work.
- Bare requests, approved notes, Connect in More, Pending reconciliation and first-degree acceptance checks. A request is reported sent only after Pending is confirmed.
- One retry for a failed send report; then stop. Stop sending on `stopSending`/`overQuota`; stop everything on warning or pause.
- Inbox reading only on `inbox.due`; both directions, full visible thread, stable IDs and raw labels when actual time is unavailable.
- A server limit of 60 requests per account over seven UTC dates including today. All runs contribute. Counter and out-of-allowance observation records are read from the existing tables, without a schema migration. Concurrent counter writers on the server are serialized by account.

## Activation still requires

A Mac with the relevant local Anty profiles, Chrome, the agent dependency installed, and a root environment pointing to the Outbound-Sales server with its agent token. Run a supervised test account before enabling the generated LaunchAgent. The code integration does not deploy the server or activate a worker on real accounts.
