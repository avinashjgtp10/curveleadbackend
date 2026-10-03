# Ads module — Phase 3: controls + audit

Plan: `PLAN.md` §6.

## What changed

- **Pause / resume** campaigns and ad sets, and **change daily budgets**, from Ads Manager → Meta Ads (row buttons). `services/metaAds/controls.js`:
  1. reads the entity's current status/budget from Meta (so the audit's old value is real, not our cache);
  2. enforces Meta's budget model — ad-set budgets can't be set inside an Advantage-campaign-budget (CBO) campaign, a campaign without its own budget is changed through its ad sets, lifetime budgets are left to Meta Ads Manager;
  3. enforces the workspace **daily budget cap** (`settings.ads_daily_budget_cap_paise`): a resume or budget increase that would push the total daily budget set to spend above the cap is refused (decreases and pauses always pass);
  4. writes to Meta, re-reads the result, then updates `ad_campaigns`/`ad_adsets` (+ the CRM campaign's status/budget) and writes the audit row in one transaction. A failed Meta call is audited too (`success = false`, error kept).
- Requires the `ads_management` permission on the connected token; without it the API answers 403 with "Reconnect and allow Manage your ads".
- **Change history** (audit log) and **daily budget cap** editor on the Meta Ads tab.
- **API** (`ads.manage`): `POST /api/ads/{campaigns|adsets}/:id/{pause|resume}`, `PATCH /api/ads/{campaigns|adsets}/:id/budget { daily_budget_paise }`, `GET /api/ads/audit?entity_type&entity_id&limit`, `GET /api/ads/settings`, `PUT /api/ads/settings { daily_budget_cap_paise | null }` (admins only).

## Migration — `models/migration_ads_phase3.sql`

`ad_audit_log`. Apply before deploying.

## Meta permissions

`ads_management` (new for writes). The Facebook Login for Business configuration (`VITE_FACEBOOK_LOGIN_CONFIG_ID`) must request it; workspaces connected with read-only access reconnect once. Salonox's legacy token already has it.

## Tests

`tests/adsPhase3.test.js`: daily-budget total (CBO vs ABO, paused), missing `ads_management` refused before any Meta call, pause writes Meta + cache + CRM + audit, CBO/ABO/lifetime rules, cap blocks increases but not decreases, failed Meta write audited and not cached, no-op pause.
