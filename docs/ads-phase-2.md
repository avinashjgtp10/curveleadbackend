# Ads module — Phase 2: Lead Ads sync

Plan: `PLAN.md` §5. Decision D5 taken: new Meta leads are scored on arrival — scoring is CurveLead's own rule-based intent score (no Groq call), switchable per workspace (`settings.meta_lead_score_on_ingest`, default on).

## What changed

- **One pipeline** — `services/metaLeads.js` handles a Meta lead end to end (deleted-lead check, CRM campaign link, `meta_form_id`, ingestion, scoring, welcome message, assignment, automation triggers, admin notification). The webhook job, the safety poll and form backfills all use it; the copies in `metaWebhookController.js` and `utils/metaLeadSync.js` are gone.
- **Webhook** (`POST /api/webhook/meta`) — verifies `X-Hub-Signature-256` against `META_APP_SECRET` (+ `META_EXTRA_APP_SECRETS`), answers 200 immediately and queues one `leads:ingest-meta` job per lead (job id `meta-lead-<leadgen_id>`, 5 attempts with backoff). Reads **every** entry (before, only the first entry of a batched delivery was processed). Unsigned deliveries are accepted only for connected pages — lead data is always fetched from Meta with the page's own token, so a forged payload can't create a lead — unless `META_WEBHOOK_REQUIRE_SIGNATURE=true` (same rule as the WhatsApp webhook).
- **Safety poll** — every 30 min (was 5), leads created in the last 24 h, on every form (was: first 20 forms × first 100 leads, all time).
- **Backfill** — Ads Manager → **Lead Forms** tab lists the Page's forms (leads on Meta vs in CurveLead) with **Import all leads** (`leads:backfill-form` job, pages through every lead). Old leads (> 2 h) are imported and assigned but not messaged.
- **API** (`ads.manage`): `GET /api/ads/forms`, `POST /api/ads/forms/:id/backfill { since? }`, `PUT /api/ads/lead-settings { score_on_ingest }`.
- **Scoring** — `services/leadScoring.js` (moved from `aiController`, which now uses it too).

## Migration — `models/migration_ads_phase2.sql`

`leads.meta_form_id`, unique partial index `(tenant_id, meta_lead_id)` (no duplicates on production, checked 2026-10-03), `ad_lead_forms`.
**Apply before deploying the backend** — ingestion writes `meta_form_id`.

## Tests

`tests/adsPhase2.test.js`: signed webhook queues every lead of every entry; tampered body / wrong secret / missing header rejected; unsigned accepted for connected pages only and rejected when signatures are required; fresh lead created with form id, scored, welcomed, enrolled; backfilled lead not messaged; scoring switch; no-phone skip; known leads not re-ingested.
