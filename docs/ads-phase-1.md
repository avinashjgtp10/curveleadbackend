# Ads module — Phase 0 + 1: Meta Ads insights and drill-down

Plan: `PLAN.md`. Nothing here has been run against production.

## What changed

- **One Graph API version** — `config/meta.js` (`META_GRAPH_VERSION`, default `v25.0`). All 12 former hard-coded URLs use it; `utils/metaCapi.js` and the health check in `jobs/featureJobs.js` move from v21.0 to v25.0.
- **Graph client** — `utils/metaGraph.js`: token sent as a Bearer header (never in URLs), reads `x-business-use-case-usage` / `x-ad-account-usage` / `x-app-usage` and pauses calls per ad account from 75 % usage (or for Meta's regain time), retries throttling and transient errors with exponential backoff + jitter, plus paging and batch helpers.
- **Encrypted tokens** — `ad_oauth_tokens` stores Meta tokens AES-256-GCM encrypted with a key version (`utils/cryptoSecrets.js` `encryptToken`/`decryptToken`). Version 1 = key derived from `JWT_SECRET` (as before); version 2 = optional `TOKEN_ENCRYPTION_KEY`.
- **Hierarchy + daily insights** — `services/metaAds/*`: campaign → adset → ad (+ creative thumbnail/body/title) via field expansion; daily ad-level insights via an async insights report; leads/CPL from `actions` / `cost_per_action_type` (one lead action type per row, so no double counting); roll-ups to adset/campaign/account in SQL. First sync backfills 90 days, later syncs re-pull the last 3 days.
- **Jobs** — `jobs/queues/index.js`: BullMQ when `REDIS_URL` is set; otherwise the same jobs run in-process. `jobs/adsJobs.js`: sync every 4 h (`ADS_INSIGHTS_SYNC_MINUTES`), daily token check (marks expired tokens, tries to extend tokens expiring within 10 days, notifies admins).
- **API** (`/api/ads`, all require the new `ads.manage` permission; admins have it): `GET accounts`, `POST accounts/connect`, `POST accounts/:id/primary`, `POST accounts/:id/sync`, `GET campaigns`, `GET campaigns/:id/adsets`, `GET adsets/:id/ads`, `GET insights/daily`, `GET dashboard`.
- **Dashboard** — per campaign: Meta CPL vs cost per qualified lead vs cost per converted lead. "Qualified" uses the new `lead_stages.is_qualified` flag (defaults to the stage named Qualified and every later non-lost stage) or a won stage; "converted" = won stage; current stage or stage history both count.
- **Frontend** — new **Grow → Ads Manager** page (connect, account/date pickers, CPL cards, drill-down with creatives). Facebook SDK loader moved to `src/utils/facebookSdk.js`.
- **Permissions** — new keys `ads.manage`, `social.publish` (appear in Team → permissions automatically).

## Deliberately unchanged (for now)

- The legacy 6-hourly sync (`jobs/metaAdInsightsSync.js`) still runs: the Campaigns pages read `campaigns.actual_spend` (lifetime) and `meta_ads`, which the new sync doesn't replace yet. Both syncs update `campaigns.status`/budgets with the same values.
- The plaintext `tenants.settings.meta_ads_access_token` is copied (encrypted) by the migration script but **not removed**, because the legacy sync, Click-to-WhatsApp attribution (`resolveCampaignFromAdId`) and the Integrations ad-account picker still read it. Moving those readers to `ad_oauth_tokens` and deleting the plaintext copy is a follow-up.

## Rollout

1. `npm ci` (adds `bullmq`, `ioredis`).
2. Apply `models/migration_ads_phase1.sql` (transactional, safe to rerun):
   `psql -h $DB_HOST -U $DB_USER -d $DB_NAME -v ON_ERROR_STOP=1 -f models/migration_ads_phase1.sql`
3. Deploy backend, then frontend.
4. `node scripts/migrateAdTokens.js --dry-run`, review, then `--apply`. Workspaces with an invalid token are listed and skipped (they reconnect from Ads Manager).
5. Optional: set `REDIS_URL` (ElastiCache) for persistent queues; set `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) **before** step 4 if you want tokens on the new key from the start.

## New env vars

| Var | Required | Default |
|---|---|---|
| `META_GRAPH_VERSION` | no | `v25.0` |
| `REDIS_URL` | no (in-process fallback) | — |
| `TOKEN_ENCRYPTION_KEY` | no | JWT-derived key |
| `ADS_INSIGHTS_SYNC_MINUTES` | no | `240` |

## Meta permissions used in this phase

`ads_read` (required to connect; checked at connect time), `business_management` (ad accounts owned through a Business portfolio). The Facebook Login for Business configuration (`VITE_FACEBOOK_LOGIN_CONFIG_ID`) must request them; Advanced Access (App Review) is needed for client businesses.

## Tests

`tests/adsPhase1.test.js` — insights parser, budget parser, usage-header slowdown, retry/backoff, token-in-header, async report polling, sync range, in-process job runner, account-id normalisation, date-range validation, and a PostgreSQL test (set `ADS_TEST_DATABASE_URL`) covering the migration (twice), hierarchy upsert, insights replace-not-double, roll-ups, CTR/CPC/CPL, the CPL dashboard and tenant isolation.
