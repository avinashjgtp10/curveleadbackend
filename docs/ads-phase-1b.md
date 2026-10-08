# Ads module — Phase 1b: one Ads Manager for Campaigns and Meta ads

Decision D8 in `PLAN.md`. No migration in this phase.

## What changed

- **One page.** Ads Manager (`/ads`) has two tabs: **Campaigns** (the CRM campaign list, every lead source) and **Meta Ads** (accounts, drill-down, CPL dashboard). `/campaigns` redirects to the Campaigns tab; campaign detail pages are unchanged.
- **One sync.** The Ads module sync now also writes each CRM campaign's lifetime spend, impressions and clicks (`date_preset=maximum`) and its overall budget, so the Campaigns tab no longer needs the legacy sync. `jobs/metaAdInsightsSync.js` skips any workspace with an active Ads Manager account.
- **One "sync now".** `POST /api/integrations/facebook/sync-ad-insights` (Campaigns tab button) queues the Ads Manager sync when the workspace is connected there.
- **One connection.** The Integrations "Ad Spend & Performance" card links to Ads Manager instead of its own ad-account picker.
- **Meta campaigns are read-only in Campaigns.** `PUT /api/campaigns/:id` ignores `status`, `budget`, `actual_spend`, `start_date`, `end_date` for Meta-synced campaigns (409 if nothing else was sent); the edit modal hides them and links to Meta Ads.
- **One CPL formula.** For campaigns synced by Ads Manager, the Campaigns tab's CPL is spend in the selected period ÷ CRM leads in that period (`cpl_basis: 'period'`); other campaigns keep lifetime spend ÷ lifetime leads.
- **Ads table + attribution.** Campaign detail's "Ads in this campaign" reads `ad_ads` + `ad_insights_daily` (legacy `meta_ads` as fallback). Click-to-WhatsApp attribution resolves ads from the synced tables first, then via the Ads Manager token, then the legacy token.
- **Links both ways.** Campaign cards/detail → Meta Ads; Meta Ads "Lead quality by campaign" → campaign detail.

## Rollout

1. Deploy backend, then frontend.
2. `node scripts/migrateAdTokens.js --dry-run`, then `--apply` (moves the legacy Integrations ad token into Ads Manager). Dry run on 2026-10-03: Salonox would migrate (`act_1522239009407533`); Curve Lead's token is invalid and must reconnect in Ads Manager.

## Follow-up

Once every workspace is on Ads Manager: delete `jobs/metaAdInsightsSync.js`, `utils/metaAdInsights.js`, the `meta_ads` table and `settings.meta_ads_access_token`.

## Tests

`tests/adsPhase1b.test.js`: Meta-managed fields are protected, manual campaigns still editable, ads table source + fallback, attribution without a Graph call, lifetime totals written by Meta campaign id.
