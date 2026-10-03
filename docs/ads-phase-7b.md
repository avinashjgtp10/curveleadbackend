# Ads & Social — Phase 7b: Google Ads controls and AI search ads

Plan: `PLAN.md` §10. Tested with fake Google responses and against a copy of the production schema. Nothing here has been run against a real Google Ads account.

## What changed

- **Google Ads API version: default `v22` → `v25`.** Google switches v22 off in October 2026; after that the 7a sync fails. None of the fields 7a reads changed in v23–v25. v25 runs until about August 2027. If Parameter Store sets `GOOGLE_ADS_API_VERSION`, set it to `v25` or delete it (rollout step 2).
- **Controls on the Google Ads tab** (same buttons as Meta): pause/resume campaigns and ad groups, and change a campaign's daily budget. Same order as Phase 3: read the current value from Google, check the cap, write to Google, then update the cache, the CRM campaign and the audit log.
  - Budgets: only on campaigns, because Google ad groups have no budget of their own. A budget shared by several campaigns is refused with an explanation, since changing it would change all of them. Total-budget (custom period) campaigns are refused too.
  - Same endpoints as Meta (`POST /api/ads/campaigns|adsets/:id/pause|resume`, `PATCH …/budget`). The server routes the request by the campaign's ad account.
- **One daily budget cap for Meta and Google.** The "set to spend per day" total now counts Google `ENABLED` campaigns, and counts a shared Google budget once. **Effect on Meta:** if Google campaigns are running, a Meta budget increase or resume can now hit the cap where it didn't before.
- **Change history per platform**: `ad_audit_log.provider`; `GET /api/ads/audit?provider=google|meta`. The Google tab shows its own history.
- **Create with AI (Google Ads tab)**: brief (offer, city, landing page, language, budget, days) → Groq writes 12–15 headlines (≤ 30 characters), 4 descriptions (≤ 90), 10–20 keywords (phrase/exact), negative keywords and display paths. Over-long variants are dropped when at least 8 good headlines remain.
  - **Review / edit** with a Google-style preview. It's re-validated on every save and again before creation (`services/googleAds/aiSearchSchema.js`):
    - limits: 3–15 headlines, 2–4 descriptions, display paths ≤ 15 characters;
    - no duplicate text and no "!" in headlines;
    - no phone numbers and no repeated punctuation;
    - the banned claims from Phase 5 (English/Hindi/Marathi);
    - keyword symbols Google refuses, and keywords that are also negatives;
    - landing page, budget ≥ 100, 1–90 days, the daily cap.
    - Warnings, not errors: words in capitals (except common acronyms), fewer than 8 headlines, and loans/credit/insurance (needs Google's financial services verification in India).
  - **Create**: one atomic `googleAds:mutate` creates the budget, campaign, location, languages, negative keywords, ad group, keywords and ad. Either all of it is created or none of it, so a failure leaves nothing half-made.
    - The campaign is **PAUSED**; the ad group and ad are enabled, so Google reviews the ad while nothing spends.
    - Settings: Search network only; "Maximize clicks" bidding (works without conversion tracking); people *in* the city, not people interested in it; English plus the ad's language.
    - `contains_eu_political_advertising = DOES_NOT_CONTAIN…` is declared, as Google now requires.
    - If Google refuses something, the error names the item (e.g. `Keyword "…": …`). The request is never retried automatically: a write that timed out may still have gone through, and Google refuses a second campaign with the same name anyway.
  - **Activate**: type the campaign name. This re-checks the cap, enables the campaign and moves its end date so it runs the full number of days from activation.
- **API** (`ads.manage`): `GET/POST /api/ads/google/ai/drafts`, `GET/PUT /api/ads/google/ai/drafts/:id`, `POST …/:id/create`, `POST …/:id/activate`. Drafts are stored in `ad_ai_drafts` with `provider = 'google'`, so the Meta wizard doesn't show them, and vice versa.

## Rollout

1. **Migration first.** The sync writes the new budget columns, so deploying before the migration breaks the Google sync. The migration is transactional and safe to re-run:
   `psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase7b.sql`
2. **Parameter Store** (`/curvelead/backend/production/`): if `GOOGLE_ADS_API_VERSION` exists and isn't `v25`, set it to `v25` or delete it. Do this **before Google switches v22 off this month.**
3. Deploy the backend, then the frontend; `pm2 restart curvelead-api`. No new npm packages and no new required env vars.
4. Changing campaigns in real accounts needs the developer token's **Basic Access**, the same as reading them. With test access, it works only on Google Ads test accounts.

## How to test

With a test developer token and a test client account:
1. Google Ads tab → Create with AI → draft → fix anything flagged → Create in Google Ads (paused).
2. Check the campaign in Google Ads: Search only, paused, city targeting, ad under review.
3. Activate it by typing the name.
4. Pause/resume it and change its budget from the campaign table, then check the change history.
5. Set a cap lower than the total and confirm a budget increase is refused.

## Not in this phase

- Changing shared budgets, total budgets or bid strategies; keyword-level controls.
- Call assets, sitelinks and other assets (the AI ad is headlines + descriptions only).
- Radius targeting around an address (city targeting only).
- Policy exemption requests: if Google flags a keyword or text, edit it and create again.
