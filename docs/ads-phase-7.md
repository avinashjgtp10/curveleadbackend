# Ads & Social — Phase 7a: Google Ads (read)

Plan: `PLAN.md` §10. Nothing here has been run against production or a real Google Ads account (tests use recorded-shape fake responses).

Phase 7 is split: **7a (this)** reads Google Ads into Ads Manager; **7b** (AI-written responsive search ads, created paused) comes after 7a is reviewed and the developer token has Basic Access, because it creates things that spend money.

## What changed

- **Ads Manager → Google Ads tab**: the same screen as Meta Ads (spend, clicks, CTR, CPC, Google-reported conversions, then "In CurveLead" leads, cost per qualified lead and per customer; drill-down campaign → ad group → ad with the ad's headlines/descriptions). Read-only: no pause/budget controls, budget cap, change history or AI wizard for Google yet.
- **Connect**: "Connect with Google" → Google consent (`adwords` scope, offline) → `GET /api/ads/google/callback` (public; the encrypted, 10-minute `state` ties it to the workspace and user that started it) → refresh token saved encrypted in `ad_oauth_tokens` (provider `google`) → every usable account saved to `ad_accounts` (provider `google`): accounts the user can open directly, plus client accounts under any manager (MCC) account they can open (stored with `login_customer_id`). "Refresh accounts" re-lists them.
- **Sync** (`services/googleAds/sync.js`, same 4-hourly job and "Sync now" as Meta — `ads:sync-account` now routes by provider): campaigns / ad groups / ads (`ad_campaigns` / `ad_adsets` / `ad_ads`), daily cost, impressions, clicks and conversions (`ad_insights_daily`; 90-day backfill, then the last 3 days each run). Campaign rows come from Google directly so Performance Max (no ad groups/ads) is counted; the account row is the sum of campaigns. Conversions are stored as the platform's lead count (rounded; the exact value is kept in `actions.conversions`) and labelled "conversions" in the UI.
- **CRM link**: each Google campaign gets a CRM campaign (`campaigns.google_campaign_id`, source `google_ads`) with status, budget and lifetime spend kept in step. Google lead-form leads are linked to it: new ones on arrival, earlier ones on each sync (`leads.campaign_id` where `google_campaign_id` matches and no campaign is set). Google spend therefore appears in Campaigns, Reports and the dashboard through the shared metrics.
- **API**: `GET /api/ads/google/status`, `GET /api/ads/google/connect`, `POST /api/ads/google/refresh`, `GET /api/ads/google/callback`; existing `/api/ads/accounts|campaigns|dashboard|…` take `?provider=google`.
- REST API via axios — no new npm package.

## Rollout

1. Migration (transactional, safe to re-run), with the Parameter Store DB settings loaded:
   `psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase7.sql`
2. Google Cloud project (the one whose `GOOGLE_CLIENT_ID` the backend uses):
   - Enable **Google Ads API**.
   - OAuth client → Authorised redirect URIs: add `https://curvelead.com/api/ads/google/callback` (or whatever `GOOGLE_ADS_OAUTH_REDIRECT_URI` is set to).
   - OAuth consent screen → add the scope `https://www.googleapis.com/auth/adwords`. It is a sensitive scope: for users outside your organisation the app needs Google's OAuth verification; until then only test users listed on the consent screen can connect.
3. Google Ads manager (MCC) account → Admin → API Center → **developer token**. A new token has *test access* (test accounts only); apply for **Basic Access** to read real client accounts.
4. Parameter Store (`/curvelead/backend/production/`):

| Name | Required | Value |
|---|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | yes | from step 3 |
| `GOOGLE_ADS_OAUTH_REDIRECT_URI` | recommended | `https://curvelead.com/api/ads/google/callback` (default is `$API_URL/api/ads/google/callback`) |
| `GOOGLE_ADS_API_VERSION` | no | default `v25` since Phase 7b (v22 is switched off in October 2026); set to the current version from Google's release notes (old versions are switched off about a year after release) |

5. Deploy backend, then frontend; `pm2 restart curvelead-api`. Ads Manager → Google Ads → Connect with Google.

Without the developer token the tab says Google Ads isn't set up; nothing else is affected.

## How to test

With a **test** developer token: create a Google Ads test manager account and a test client under it, sign in with a user that's on the OAuth consent screen's test users, connect, then "Sync now". Test accounts have no real spend; campaigns, ad groups and ads appear, metrics stay at zero.
With **Basic Access**: connect a real account; spend and conversions for the last 90 days appear after the first sync (a few minutes).

## Not in this phase (7b and later)

- Creating campaigns/ads (AI responsive search ads, created paused), pausing, budgets.
- Nested manager accounts more than one level deep (only direct clients of a manager are listed).
- Google lead-form leads arriving before a campaign has ever been synced are linked on the next sync, not instantly.
