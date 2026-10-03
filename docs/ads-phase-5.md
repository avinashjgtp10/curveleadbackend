# Ads module — Phase 5: AI campaign creation

Plan: `PLAN.md` §8.

## Flow (Ads Manager → Meta Ads → **Create with AI**)

1. **Brief** — offer, goal, city, ₹/day, days, language (English / Hindi / Marathi), destination (instant lead form or WhatsApp). `POST /api/ads/ai/drafts`.
2. **Draft** — Groq (JSON mode) writes 3–5 primary texts, headlines, descriptions, CTA, radius and ages, given the business description and the workspace's 5 best ads by CPL (≥ 10 leads, last 90 days). The city and budget are the user's, not the model's.
3. **Validate** (`services/metaAds/aiCampaignSchema.js`, pure, run on every save and again before creating): primary text ≤ 2 200 (warning over 125), headline ≤ 40, description ≤ 30, CTA from Meta's list for the destination, ≥ ₹100/day and within the daily budget cap, 1–90 days, radius 17–80 km (Meta's city-radius range), ages 18–65; banned claims in English/Hindi/Marathi (guarantees, "100%", before/after, cures/miracles, income promises, specific weight loss); special ad categories (housing, employment, credit/financial) detected from the offer → ages forced to 18–65. New lead forms need the business's privacy-policy link (remembered for next time), or an existing form is reused.
4. **Review/edit** — pick and edit the variant, change targeting/budget, choose the lead form, upload the image (goes straight into the ad account's image library). `PUT /api/ads/ai/drafts/:id`, `POST …/:id/image`.
5. **Create on Meta — everything PAUSED** (`POST …/:id/create`): campaign (`OUTCOME_LEADS`, campaign daily budget, lowest cost) → city lookup → ad set (lead generation or WhatsApp conversations, Advantage+ audience when ages are broad) → lead form (if new) → creative → ad. Each call is logged on the draft (no tokens); a failure part-way marks the draft failed and **a retry continues from the failed step** (ids already created are reused, never duplicated). Audit row `create`.
6. **Activate** (`POST …/:id/activate { confirm: '<campaign name>' }`) — a separate action: the exact campaign name must be typed, the budget cap is re-checked, then ad → ad set → campaign are set ACTIVE. Audit row `activate` (failures audited too).

Requires `ads_management` on the connected token and a connected Facebook Page.

## Deviations from the plan

- No Zod: it isn't installed; the rules are a plain, unit-tested function.
- Location: Meta's own city search (`/search?type=adgeolocation`) instead of a separate geocoder; radius 17–80 km (Meta's city range) instead of 1–80.
- One image per campaign (no multi-image / video yet); the chosen primary text + headline go into one ad.

## Migration — `models/migration_ads_phase5.sql`

`ad_ai_drafts`. Apply before deploying.

## Not tested against Meta

Unit-tested against a fake Graph API only — no real campaign has been created. First real run: create a draft with a small budget, create it (paused), check it in Meta Ads Manager, then delete or activate it there.

## Tests

`tests/adsPhase5.test.js`: limits, banned claims (en/hi/mr), special categories, privacy link and cap; create builds the four objects all paused with the right budget, city, dates, form and image; partial failure + resume without duplicates; no `ads_management` / double create refused; activation needs the exact name and cap room and starts ad, ad set, campaign; lead forms always ask name + phone.
