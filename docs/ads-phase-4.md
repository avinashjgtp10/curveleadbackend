# Ads module — Phase 4: Conversions API feedback

Plan: `PLAN.md` §7. Builds on the existing `meta_capi_queue` + `phase4_lead_events` trigger (Postgres queue kept — it already retries with `SKIP LOCKED`; moving it to BullMQ would add nothing).

## What changed

- **Which events** (trigger, `models/migration_ads_phase4.sql`): a stage's own `meta_event_name` still wins; otherwise a won stage queues `ConvertedLead` (or `settings.meta_won_event`) and a stage flagged `lead_stages.is_qualified` (or named Qualified) queues `QualifiedLead` (or `settings.meta_qualified_event`). A won stage that is also qualified queues both.
- **Once per lead and event** — not re-queued while pending or after success; `meta_capi_events` has a unique index on successful (lead, event); `event_id` is deterministic (`<lead id>:<event name>`) so Meta de-duplicates retries too.
- **Payload** (`utils/metaCapi.js`) per Meta's CRM spec: `action_source: system_generated`, `user_data.lead_id` (leadgen id) plus SHA-256 of normalised `em`, `ph` (digits with country code; 10-digit numbers get 91), `fn`, `ln`, `ct`, `country` (`settings.meta_capi_country`, default `in`) and `external_id`; `custom_data: { lead_event_source: 'CurveLead', event_source: 'crm' }`.
- **Queue** (`jobs/featureJobs.js`): exponential backoff (2, 4, 8 … min), 6 attempts; `last_error` and `sent_at` recorded. CAPI switched on without a dataset ID / token now fails at once with that reason (before, events retried 5 times silently — Salonox had 7 such events).
- **Visible** — Ads Manager → Lead Forms → "Lead quality feedback to Meta": on/off/not-set-up state and the latest events with errors. `GET /api/ads/capi/events`.

## Migration — `models/migration_ads_phase4.sql`

New columns `meta_capi_queue.last_error`, `sent_at`, `meta_capi_events.event_id`; unique index on successful events; replaces `phase4_lead_events()` (identical except the CAPI block). **Apply before deploying** — the event log insert uses the new index. Validated on production in a rolled-back transaction (2026-10-03), including the trigger: 4 stage changes on one lead queued each event once.

## Tests

`tests/adsPhase4.test.js`: normalisation vectors, hashed user data and omitted fields, event shape + deterministic id, not-configured vs off, queue transitions (not configured → failed with reason; error → retry → failed after 6; success).
