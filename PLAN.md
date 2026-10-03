# Ads + Social module — implementation plan

Status: **Phase 0 + 1 built** (see `docs/ads-phase-1.md`); migration applied to production 2026-10-03. **Phase 1b built** (see `docs/ads-phase-1b.md`). **Phase 2 built** (see `docs/ads-phase-2.md`; D5 = score on ingest, rule-based, no Groq). **Phase 3 built** (see `docs/ads-phase-3.md`). **Phase 4 built** (see `docs/ads-phase-4.md`). **Phase 5 built** (see `docs/ads-phase-5.md`). **Phase 6 built** (see `docs/ads-phase-6.md`). **Phase 7a built** (Google Ads read; see `docs/ads-phase-7.md`); 7b (AI search ads, created paused) after review. Decisions taken: D1 BullMQ with in-process fallback when `REDIS_URL` is unset; D2 many accounts + one primary; D3 versioned keys; D4 paise/rupees as described; **D8 Campaigns vs Ads Manager (below) — Phase 1b runs before Phase 2.** D5–D7 apply to later phases.

## D8 — Overlap with the existing Campaigns section (decided 2026-10-03)

**What overlaps today (Meta ads only):**

| | Campaigns (Engage) | Ads Manager (Grow, Phase 1) |
|---|---|---|
| Connect Meta ads | Integrations → "Connect Ad Account" (plaintext `settings.meta_ads_access_token`) | Ads Manager → Connect (encrypted `ad_oauth_tokens`) |
| Sync | `jobs/metaAdInsightsSync.js` every 6 h + "Sync ad insights" buttons (Campaigns, Integrations) | `ads:sync-insights` every 4 h + "Sync now" |
| Data | `campaigns.actual_spend/impressions/clicks` (lifetime) + `meta_ads` (ad lifetime totals) | `ad_campaigns/adsets/ads` + `ad_insights_daily` |
| Ad drill-down | Campaign detail → "Ads in this campaign" (lifetime) | Campaign → ad set → ad with creatives (by date range) |
| Lead quality | Verdicts, won/lost, **lifetime** spend ÷ lifetime CRM leads, ROI | Meta CPL vs cost per qualified/converted, **period** spend |

Result: two Meta connections, two syncs, two copies of the same campaigns, and CPL numbers that disagree between the pages.

**What only Campaigns does:** every lead source (Google, referral, walk-in, organic, manual), manual budget/spend, the *Priority campaign* flag (skips automation), `leads.campaign_id` attribution used by assignment/automation/reports, and the "Where to focus" verdicts.

**Decision:** one **Ads Manager** page (`/ads`, sidebar → Grow) with two tabs; `/campaigns` redirects to `/ads?tab=campaigns` (done 2026-10-03):
- **Campaigns tab = the CRM's campaign list** (all sources, lead outcomes, priority, verdicts). For Meta campaigns it *shows* Meta numbers but never edits them.
- **Meta Ads tab = the only place for Meta ad data and controls** (connection, sync, ad sets/ads/creatives, daily insights, and from Phase 3 pause/resume/budgets).
- Linked through `ad_campaigns.campaign_id → campaigns.id`.

### Phase 1b — consolidate (before Phase 2)

1. **One connection.** Integrations' "Connect Ad Account" card becomes a link to Ads Manager; `scripts/migrateAdTokens.js` moves existing tokens; remove the Integrations ad-account picker and its "Sync ad insights" button.
2. **One sync.** The Phase 1 sync also maintains the CRM side: creates/links the `campaigns` row (`findOrCreateMetaCampaign`), and writes status, budgets, lifetime spend (one campaign-level `date_preset=maximum` insights call), impressions and clicks. Then retire `jobs/metaAdInsightsSync.js` and the `meta_ads` table; `resolveCampaignFromAdId` (Click-to-WhatsApp) reads `ad_ads`; delete `settings.meta_ads_access_token`.
3. **Campaigns page, Meta campaigns:** "Sync ad insights" triggers the Ads Manager sync; in the edit modal, status/budget/dates are read-only ("Managed in Meta — change it in Ads Manager"), since the sync overwrites them anyway; "Open in Meta Ads" link on card + detail (`/ads?tab=meta`); the detail page's "Ads in this campaign" table reads `ad_ads` + `ad_insights_daily` for the page's period.
4. **One CPL definition** on both pages: spend in the selected period (`ad_insights_daily`) ÷ CRM leads created in that period. Manual (non-Meta) campaigns keep their manually entered spend.
5. **Meta Ads → CRM:** each row in "Lead quality by campaign" links to its campaign detail page.

**Effect on later phases:** Phase 2 (Lead Ads) extends the existing `/api/webhook/meta` and sets `leads.campaign_id` through `ad_campaigns.campaign_id` — unchanged. Phase 3 controls live only in Ads Manager (point 3 prevents conflicting edits from Campaigns). Phase 4 hardens the existing CAPI queue — unchanged. Phase 5 is new. Phase 6: Facebook/Instagram posting is new; for Google Business Profile, the existing GMB page only handles reviews, so posting is new but must reuse its OAuth connection (no second Google connect).

## 1. What exists today (from the repo)

| Area | Current state | Impact on this plan |
|---|---|---|
| DB access | Raw SQL via `pg` (`config/db.js` → `query`, `transaction`). No ORM. | New code uses the same `query`/`transaction` helpers. |
| Migrations | Hand-run, idempotent SQL files in `models/` (e.g. `migration_phase4_features.sql`), wrapped in `BEGIN/COMMIT`, applied with `psql -v ON_ERROR_STOP=1`. Documented in `docs/phase-*.md`. | One file per phase: `models/migration_ads_phase{N}.sql` + `docs/ads-phase-{N}.md`. |
| Multi-tenancy | `authenticate` sets `req.tenantId` from the user; `tenantContext` requires it. Every query filters `tenant_id = $1`. Permissions via `requirePermission(key)` (`utils/permissions.js`). | Every new table has `tenant_id NOT NULL`, every query filters by it, every unique index leads with `tenant_id`. New permission keys `ads.manage`, `social.publish`. |
| Background jobs | `setInterval` in `server.js` (single PM2 fork process). Postgres-backed queues with `FOR UPDATE SKIP LOCKED` for `meta_capi_queue` and `webhook_deliveries` (`jobs/featureJobs.js`). **No Redis or BullMQ installed.** | See decision D1. |
| Secrets/env | AWS SSM Parameter Store (`/curvelead/backend/production/*`) loaded in `bootstrap.js`; `REQUIRED_VARS` list. | New vars added to SSM + `REQUIRED_VARS` only where startup can't proceed without them. |
| Encryption | `utils/cryptoSecrets.js`: AES-256-GCM, key derived from `JWT_SECRET`. | Reused for tokens (see D3). |
| Meta Graph version | Hard-coded in 12 files: `v25.0` (10) and `v21.0` (`metaCapi.js`, `featureJobs.js`). | Phase 0 adds one constant and migrates all callers. |
| Meta Ads | `utils/metaAdInsights.js` (every 6 h): campaign list + lifetime spend/impressions/clicks into `campaigns`; ad-level lifetime totals into `meta_ads`. Ad-account token stored **in plaintext** in `tenants.settings.meta_ads_access_token`. No adset table, no daily insights, no lead/CPL actions, no rate-limit handling. | Phase 1 replaces this with a full hierarchy + daily insights; keeps `campaigns.actual_spend` etc. updated for existing screens. |
| Lead Ads | `/api/webhook/meta` (`metaWebhookController.js`) already handles `leadgen`: fetches `/{leadgen_id}`, dedupes by `leads.meta_lead_id`, runs assignment/welcome/automation triggers. **No `X-Hub-Signature-256` check.** `utils/metaLeadSync.js` polls `/{page}/leadgen_forms` (first 20 forms, first 100 leads, no paging). No `form_id` column. | Phase 2 hardens and extends this instead of building a second endpoint. |
| CAPI | `utils/metaCapi.js` (v21.0) + `meta_capi_queue` populated by the `phase4_lead_events` trigger on stage change, drained every minute with a fixed retry delay. Hashes email/phone only. Logs to `meta_capi_events`. | Phase 4 is mostly hardening: backoff, fuller user_data, explicit Qualified/Converted mapping. |
| Groq | `services/groqService.js` → `callGroq(messages, { json: true })`. Lead scoring is **on demand** (`aiController.scoreLeadById`); the WhatsApp qualification bot runs on inbound replies when `ai_qualification_enabled`. Nothing scores a lead automatically on creation. | See D5. |
| Google | GBP OAuth (`utils/googleOAuth.js`, scope `business.manage`, encrypted refresh token in `tenants.settings`). Business Profile API access is noted in code as pending Google approval. | Phase 6 reuses it; GBP posting depends on that approval. |
| Media | S3 via `config/s3.js` (`uploadToS3` returns a bucket URL; bucket may not be public). | Phase 6 needs URLs Meta/Google can fetch (D6). |
| Tests | `node --test`, controllers loaded in a `vm` with stubbed `require`s; Postgres tests gated on `PHASE*_TEST_DATABASE_URL`. | Same pattern. |
| Frontend | `CampaignsPage`, `CampaignDetailPage`, `IntegrationsPage` (FB Login via `config_id`). Mobile app exists (`curvelead-mobile`). | Backend-first; minimal screens listed per phase. Mobile out of scope. |

## 2. Decisions needed before coding

- **D1 — Queue: BullMQ + Redis (as specified) vs the existing Postgres queue.**
  Production has no Redis. BullMQ needs one (ElastiCache `cache.t4g.micro`, or `redis-server` on the EC2 box). The existing `SKIP LOCKED` pattern already gives retries without new infrastructure.
  **Recommendation:** BullMQ as specified, with Redis on ElastiCache (survives instance replacement), and workers running in the same PM2 process initially (`jobs/queues/*.js`). If you'd rather not add Redis, I'll use the Postgres queue pattern with exponential backoff — same behaviour, no delayed-job precision below ~1 min.
- **D2 — One ad account per tenant or many?** Today it's one (`settings.meta_ad_account_id`). Plan: `ad_accounts` supports many; UI selects one "primary" for existing screens.
- **D3 — Encryption key.** `cryptoSecrets` derives its key from `JWT_SECRET`, so rotating `JWT_SECRET` would make every stored token unreadable. **Recommendation:** add optional `TOKEN_ENCRYPTION_KEY`; use it when set, fall back to the current derivation so existing encrypted values keep working. A `key_version` column allows later rotation.
- **D4 — Money units.** Meta budgets are in minor units (paise); insights `spend` is in major units (rupees, decimal string). Plan: budgets stored as `BIGINT` paise (`daily_budget_paise`), spend/CPL as `NUMERIC(14,2)` rupees; API returns both explicitly named.
- **D5 — "Trigger existing Groq scoring" on new Lead Ads leads.** No automatic scoring exists today. Options: (a) run `qualifyLead` once on ingest using the form answers (one Groq call per lead); (b) keep current behaviour (welcome message → bot scores on reply). **Recommendation:** (a), behind a per-tenant setting `ai_score_on_ingest` (default on).
- **D6 — Public media URLs for publishing.** Meta and Google fetch media by URL. Plan: upload under `social/{tenantId}/…` and pass a pre-signed GET URL (24 h) at publish time, so the bucket stays private.
- **D7 — Webhook app.** Lead Ads webhooks must be signed by the Curvedlead app (`META_APP_SECRET`). Tenants whose Pages are subscribed through another app won't verify (same issue as WhatsApp today). Pages connected through our Facebook Login are subscribed by our app (`facebookConnectPage` already calls `/{page}/subscribed_apps`), so this is fine for them.

## 3. Phase 0 — groundwork (small, ships with Phase 1)

- `config/meta.js`: `GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0'`, `GRAPH_URL`, and a `graphRequest()` helper (axios) that:
  - reads `x-business-use-case-usage`, `x-ad-account-usage`, `x-app-usage`; when any usage ≥ 75 % or `estimated_time_to_regain_access` > 0, delays further calls for that ad account (in-memory per-account gate, Redis-backed if D1 = BullMQ);
  - retries 429/`code` 4, 17, 32, 613, 80000–80014 with exponential backoff + jitter (max 5);
  - batch helper for `POST /?batch=[…]` (≤ 50 requests).
- Migrate all 12 callers to `GRAPH_URL` (no behaviour change; `metaCapi.js` and `featureJobs.js` move from v21.0 to v25.0 — I'll confirm those calls against v25 docs).
- `npm i zod bullmq ioredis` (bullmq/ioredis only if D1 = BullMQ).
- `utils/permissions.js`: add `ads.manage`, `social.publish`.

## 4. Phase 1 — Meta Ads insights + drill-down

**Migration `migration_ads_phase1.sql`**
- `ad_oauth_tokens` — `id, tenant_id, provider ('meta'), meta_user_id, token_encrypted, key_version, scopes text[], expires_at, last_refreshed_at, status ('active'|'expired'|'revoked'), created_by, created_at`. Unique `(tenant_id, provider, meta_user_id)`.
- `ad_accounts` — `id, tenant_id, provider, external_id ('act_…'), name, currency, timezone_name, account_status, token_id → ad_oauth_tokens, is_primary, last_synced_at, sync_error`. Unique `(tenant_id, provider, external_id)`.
- `ad_campaigns` — `id, tenant_id, ad_account_id, external_id, campaign_id → campaigns(id)` (link to existing table), `name, objective, status, effective_status, daily_budget_paise, lifetime_budget_paise, special_ad_categories text[], start_time, stop_time, raw jsonb, synced_at`. Unique `(tenant_id, external_id)`.
- `ad_adsets` — same shape + `ad_campaign_id, optimization_goal, billing_event, targeting jsonb, promoted_object jsonb`.
- `ad_ads` — `ad_adset_id, creative_id, creative jsonb (thumbnail_url, body, title, image_url, call_to_action)`, status fields.
- `ad_insights_daily` — `tenant_id, entity_type ('account'|'campaign'|'adset'|'ad'), entity_id (external id), date, spend numeric(14,2), impressions bigint, clicks bigint, ctr numeric, cpc numeric, leads int, cpl numeric(14,2), actions jsonb, cost_per_action_type jsonb, synced_at`. PK `(tenant_id, entity_type, entity_id, date)`; index `(tenant_id, date)`.
- One-off data step: encrypt existing `settings.meta_ads_access_token` into `ad_oauth_tokens` and create `ad_accounts` from `settings.meta_ad_account_id` (done by a script, not SQL, since encryption is in Node). `meta_ads` stays read-only for backward compatibility until the frontend moves over.

**New files**
- `services/metaAds/client.js` — token lookup/decrypt, `graphRequest` wrapper per ad account.
- `services/metaAds/hierarchy.js` — one call per account using field expansion:
  `act_X/campaigns?fields=id,name,objective,status,effective_status,daily_budget,lifetime_budget,special_ad_categories,start_time,stop_time,adsets.limit(100){id,name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting,promoted_object,ads.limit(100){id,name,status,effective_status,creative{id,thumbnail_url,body,title,image_url,call_to_action_type}}}`; follows nested `paging.next` via batch requests.
- `services/metaAds/insights.js` — `act_X/insights?level=ad&time_increment=1&time_range={since,until}&fields=campaign_id,adset_id,ad_id,spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type`; async report (`POST …/insights` + poll `report_run_id`) when the range > 7 days. Rolls ad → adset → campaign → account in SQL, so one API call covers every level.
- `services/metaAds/parseInsights.js` — pure: extracts leads from `actions` (`lead`, then `onsite_conversion.lead_grouped`, then `leadgen_grouped`, first match wins, no double counting) and CPL from `cost_per_action_type` (fallback `spend / leads`). **Unit-tested.**
- `jobs/queues/adsQueue.js` — repeatable jobs: `ads:sync-insights` every 4 h (last 3 days re-pulled each run for Meta's attribution lag; 90-day backfill on first connect), `ads:refresh-token` daily (exchange tokens expiring within 10 days via `fb_exchange_token`; mark `expired` + notify admins on failure). Retries: 5 attempts, exponential backoff from 30 s.
- `controllers/adsController.js`, `routes/ads.js` (mounted at `/api/ads`).
- Replace `jobs/metaAdInsightsSync.js` interval with the queue; keep writing `campaigns.actual_spend/impressions/clicks/status/budget` so existing pages keep working.

**API** (all `authenticate, tenantContext`; writes need `ads.manage`)
- `GET /api/ads/accounts`, `POST /api/ads/accounts/connect` (exchange FB Login token → long-lived, list `me/adaccounts`), `POST /api/ads/accounts/:id/primary`, `POST /api/ads/accounts/:id/sync`.
- `GET /api/ads/campaigns?account_id&from&to` → campaigns with period totals.
- `GET /api/ads/campaigns/:id/adsets`, `GET /api/ads/adsets/:id/ads` → drill-down with totals and creative.
- `GET /api/ads/insights/daily?entity_type&entity_id&from&to` → chart series.
- `GET /api/ads/dashboard?from&to` → per campaign: `spend, meta_leads, meta_cpl, crm_leads, qualified_leads, cost_per_qualified, converted_leads, cost_per_converted`. "Qualified" = lead currently or ever in a stage named Qualified or flagged in `lead_stages` (D: new `is_qualified` boolean on `lead_stages`, default true for the stage named "Qualified"); "Converted" = `is_won` stage, using `services/metrics.js` `wonPredicate`. Joined via `leads.meta_ad_id/meta_adset_id/campaign_id`; staff see only their assigned leads (CRM side) — spend is workspace-level.

**Frontend (minimal)**: Ads page with account picker, campaign table → adset → ad drill-down, creative thumbnail, three-CPL comparison card.

## 5. Phase 2 — Lead Ads sync

**Migration**: `leads.meta_form_id varchar(50)`; unique partial index `(tenant_id, meta_lead_id) WHERE meta_lead_id IS NOT NULL` (after a duplicate check query — any existing duplicates are reported, not deleted); `ad_lead_forms (tenant_id, page_id, external_id, name, status, last_backfilled_at)`.

**Changes**
- `/api/webhook/meta` POST: verify `X-Hub-Signature-256` with `META_APP_SECRET` (reuse `utils/metaWebhookSignature.js`), return 401 on mismatch, then `200` immediately and enqueue `leads:ingest-meta {page_id, leadgen_id}` instead of processing inline.
- Worker: fetch `/{leadgen_id}?fields=field_data,ad_id,adset_id,campaign_id,form_id,created_time,platform,is_organic`, resolve `campaign_id/ad_*` via Phase 1 tables (fallback `findOrCreateMetaCampaign`), call existing `ingestLead` (dedupe by `meta_lead_id` is enforced by the new unique index + `ON CONFLICT`), then the existing post-ingest pipeline (assignment, welcome message, automation triggers, admin notification) and, per D5, `qualifyLead` scoring.
- Backfill job `leads:backfill-form {form_id, since}` paging `/{form_id}/leads` fully (replaces the 20-form/100-lead cap); `POST /api/ads/forms/:id/backfill`, `GET /api/ads/forms`. The existing 5-minute poll stays as a safety net, reduced to every 30 min and only for the last 24 h.
- Tests: signature verification (valid, tampered body, wrong secret, missing header).

## 6. Phase 3 — Controls + audit

**Migration**: `ad_audit_log (id, tenant_id, user_id, entity_type, entity_id, action ('pause'|'resume'|'update_budget'|'create'|'activate'), old_value jsonb, new_value jsonb, request jsonb, response jsonb, success bool, created_at)`; tenant setting `ads_daily_budget_cap_paise` (and optional `ads_monthly_spend_cap_paise`) in `tenants.settings`.

**API** (`ads.manage`)
- `POST /api/ads/campaigns/:id/pause|resume`, `POST /api/ads/adsets/:id/pause|resume`.
- `PATCH /api/ads/campaigns/:id/budget`, `PATCH /api/ads/adsets/:id/budget` — body `{ daily_budget_paise }`.
- `GET /api/ads/audit?entity_type&entity_id`.
- `GET/PUT /api/ads/settings` (caps; admin only).

**Rules**: a budget change is rejected (422) if the new sum of active daily budgets across the tenant's accounts would exceed the cap; resuming is rejected the same way. Reads current values from Meta first (not just our cache) so `old_value` is accurate; the audit row is written in the same transaction as the cache update, including failures. Budget changes respect CBO vs ABO (campaign-level budget can't be set on adsets and vice versa — returned as 422 with an explanation).

## 7. Phase 4 — Conversions API feedback

Builds on the existing `meta_capi_queue` + trigger rather than adding a parallel path.
- Mapping: Qualified → `QualifiedLead` (stage flagged `is_qualified`), Converted → `ConvertedLead` (`is_won`), overridable per stage via existing `lead_stages.meta_event_name`. One event per (lead, event_name) — unique index on `meta_capi_events(tenant_id, lead_id, event_name) WHERE status='success'`.
- Payload per Meta CRM-integration spec: `action_source: 'system_generated'`, `event_time`, `event_id` (deterministic `lead_id:event_name` for dedup), `user_data.lead_id` (Meta leadgen id), SHA-256 of normalised `em`, `ph` (E.164 digits), `fn`, `ln`, `ct`, `st`, `zp`, `country` (`in` default) when present, `custom_data.lead_event_source: 'CurveLead'`, `custom_data.event_source: 'crm'`.
- Queue: move draining to BullMQ (`capi:send`), retries 6× exponential backoff from 1 min, then `status='failed'` with the response stored; `GET /api/ads/capi/events` lists results.
- Uses the dataset + CAPI token already configured in Integrations (`meta_dataset_id`, `meta_capi_access_token` — migrated to encrypted storage).
- Tests: normalisation + hashing vectors.

## 8. Phase 5 — AI campaign creation

**Migration**: `ad_ai_drafts (id, tenant_id, user_id, brief jsonb, ai_output jsonb, edited jsonb, validation_errors jsonb, status ('draft'|'approved'|'created'|'activated'|'failed'), meta_ids jsonb, api_log jsonb[], created_at, updated_at)`.

**Flow**
1. `POST /api/ads/ai/drafts` `{ offer, location, budget_per_day_inr, duration_days, goal, language: 'mr'|'hi'|'en' }` → Groq JSON mode. Prompt context: business description, top 5 ads by lowest CPL (≥ 10 leads) in the last 90 days with their body/title/CPL from `ad_insights_daily` + `ad_ads.creative`.
2. Groq returns: `objective`, `location {lat,lng,radius_km}` (geocoded server-side from the text, not trusted from the model), `age_min/max`, `daily_budget_inr`, `duration_days`, `primary_texts[3–5]`, `headlines[]`, `ctas[]`, `destination ('LEAD_FORM'|'WHATSAPP')`, `lead_form.questions[]`, `special_ad_categories[]`.
3. Zod schema (`services/metaAds/aiCampaignSchema.js`): primary text ≤ 125 chars recommended / hard 2 200, headline ≤ 40, description ≤ 30, CTA from Meta's enum, budget ≥ Meta minimum and ≤ tenant cap, duration 1–90 days, radius 1–80 km; banned-claims rule rejects "guaranteed", "100%", before/after phrasing, cure/health claims, and income promises (English + Hindi/Marathi transliterations list). Special categories detected by keyword + model: housing/real estate, employment, credit/loans → forces Meta's restrictions (no age/gender narrowing, ≥ 15 km radius). **Unit-tested.**
4. Preview/edit screen → `PUT /api/ads/ai/drafts/:id` (stores `edited`, re-validates).
5. `POST /api/ads/ai/drafts/:id/create` → campaign → adset (Advantage+ audience, Advantage+ placements) → lead form (if `LEAD_FORM`, needs Page) → adcreative (image from S3 upload) → ad, **all `status=PAUSED`**; each API call logged to `api_log` and `ad_audit_log`; on partial failure, created objects are listed (left paused, not deleted).
6. `POST /api/ads/ai/drafts/:id/activate` with `{ confirm: '<campaign name>' }` → sets ACTIVE after re-checking the budget cap. Two separate user actions by design.

## 9. Phase 6 — Social posting & scheduling

**Migration**: `social_accounts (tenant_id, platform ('facebook'|'instagram'|'gbp'), external_id, name, token_id, meta jsonb)`; `social_posts (id, tenant_id, created_by, platforms text[], caption, media jsonb [{s3_key, type, mime}], post_type ('feed'|'carousel'|'reel'|'photo'|'video'), scheduled_at, status ('draft'|'scheduled'|'publishing'|'published'|'partially_published'|'failed'), created_at, updated_at)`; `social_post_targets (post_id, tenant_id, platform, account_id, status, external_post_id, error, attempts, published_at)` — per-platform result rows (instead of arrays on the post) so retries are per platform.

**Publishers** (`services/social/*.js`)
- Facebook Page: `/{page}/feed` (text/link), `/{page}/photos`, multi-photo via unpublished photos + `attached_media`, `/{page}/videos`. Page token from `me/accounts`.
- Instagram: `/{ig_user}/media` container (image, `REELS`, or `CAROUSEL` with children) → poll `status_code` until `FINISHED` → `/{ig_user}/media_publish`. Checks `content_publishing_limit` first.
- GBP: `accounts/{a}/locations/{l}/localPosts` with the existing encrypted refresh token (requires Business Profile API access).
- One scheduler: BullMQ delayed job `social:publish {post_id}` at `scheduled_at` (job id = post id, so reschedule = remove + re-add); per-target retries 3× backoff; no Facebook native scheduling.
- Groq caption + hashtag generator: `POST /api/social/captions` `{ prompt, language, platforms }` → `{ captions[3], hashtags[] }` with per-platform length limits (IG 2 200, ≤ 30 hashtags; GBP 1 500).

**API**: `GET/POST /api/social/accounts` (connect from Pages/IG linked to the FB Login), `POST /api/social/media` (S3 upload), `GET/POST/PUT/DELETE /api/social/posts`, `POST /api/social/posts/:id/publish-now`, `GET /api/social/calendar?from&to` (posts grouped by day with per-platform status).

## 10. Phase 7 — Google Ads

**7a (built)** — read only. REST API via axios (no `google-ads-api` SDK: one less native dependency, same calls). Connect with Google (`adwords` scope, own callback `/api/ads/google/callback`), accounts incl. MCC clients (`ad_accounts.login_customer_id`), sync campaigns / ad groups / ads and daily metrics into the same `ad_*` tables with `provider='google'`, CRM campaigns via `campaigns.google_campaign_id` (and lead-form leads linked to them), Google Ads tab in Ads Manager. Details: `docs/ads-phase-7.md`.

**7b (next)** — the original plan below: AI RSA generator + create paused, plus pause/resume/budget for Google. Needs Basic Access on the developer token.


`google-ads-api` (Opteo) with MCC `login_customer_id` + developer token; per-tenant customer id + encrypted refresh token (new OAuth scope `adwords`, separate from GBP). Read campaigns/insights via GAQL into the same `ad_*` tables with `provider='google'`. AI RSA generator (15 headlines ≤ 30, 4 descriptions ≤ 90, keywords) validated with Zod; created paused. Detailed plan when Phase 6 is done.

## 11. Env vars (new)

| Var | Phase | Required | Notes |
|---|---|---|---|
| `REDIS_URL` | 1 | yes if D1 = BullMQ | e.g. ElastiCache endpoint |
| `META_GRAPH_VERSION` | 0 | no | default `v25.0` |
| `TOKEN_ENCRYPTION_KEY` | 1 | no | 32-byte base64; falls back to JWT-derived key (D3) |
| `ADS_INSIGHTS_SYNC_CRON` | 1 | no | default every 4 h |
| `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | 7 | yes for 7 | |

Existing and reused: `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `GROQ_API_KEY`, `S3_BUCKET_NAME`, `GOOGLE_CLIENT_ID/SECRET`.

## 12. Meta permissions

`ads_read`, `ads_management`, `business_management`, `leads_retrieval`, `pages_show_list`, `pages_manage_ads`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`. All need Advanced Access (App Review) on the Curvedlead app for use with businesses you don't manage. The Facebook Login for Business configuration (`VITE_FACEBOOK_LOGIN_CONFIG_ID`) must request them.

## 13. Tests (per your rules, plus a few)

- Webhook signature verification (Phase 2).
- Insights parser: lead action precedence, CPL fallback, missing actions, string numbers (Phase 1).
- Zod: char limits, budget cap, banned claims in en/hi/mr, special-category restrictions (Phase 5).
- Rate-limit header parser and backoff decision (Phase 0).
- CAPI normalisation/hashing (Phase 4).
- Tenant isolation: each new controller test asserts `tenant_id` is the first bound parameter / filter.

## 14. Order and review gates

0 + 1 together → review → 1b (consolidate with Campaigns, D8) → review → 2 → review → 3 → review → 4 → review → 5 → review → 6 → review → 7. After each phase: summary of changes, migration file, new env vars, Meta permissions used, and a `docs/ads-phase-N.md` rollout note. Migrations are never run on production by me; I'll give the exact command.

## 15. Risks

- **App Review**: `ads_management`, `pages_manage_posts`, `instagram_content_publish`, `leads_retrieval` need Advanced Access for client businesses; until approved, everything works only for businesses that have a role on the Curvedlead app.
- **Single process**: PM2 runs one fork; BullMQ workers share it. Heavy insight backfills could slow API requests — concurrency per queue is capped (insights 2, publish 3).
- **Existing sync overlap**: the legacy 6-hourly sync is kept for now (Campaigns pages still read lifetime `campaigns.actual_spend` and `meta_ads`); both syncs write the same status/budget values. Removing it, and the plaintext `settings.meta_ads_access_token`, is a follow-up once those readers move to the new tables.
