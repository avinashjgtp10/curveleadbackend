# Phase 2 — data correctness and consistency

Dashboard, Reports, Campaigns and Coaching now use one backend metric service. Lead creation/import/sync uses E.164 validation and transactional workspace deduplication. Duplicate submissions become activities; an admin can preview and merge existing duplicates while keeping the oldest lead. Meta form answers populate business/city/custom fields, budgets sync at campaign or ad-set level, CSV reads UTF-8, and avatars preserve Unicode graphemes.

## Metric definitions

- `from` is inclusive, `to` exclusive. Explicit timestamps require an offset. Named periods and custom date ranges use workspace timezone, default Asia/Kolkata.
- Total leads: created within the period. Won: distinct leads that **entered the literal Won stage** within the period, including leads subsequently reopened. Repeated entries count once per selected period. Stage flags do not turn other stages into Won.
- Legacy `won_at` is used only for a current Won lead with no recorded Won history. Unknown historical transition dates are not fabricated.
- Conversion: period wins / period lead creations × 100 (one decimal); zero when no creations. This is a period flow ratio, not cohort conversion, and can exceed 100% when older leads close.
- Unassigned: period-created leads whose assignee is null. Staff scopes include only their assigned leads.
- Active campaigns: currently active campaigns created before the period ends with a scheduled date range overlapping the period. This is not a reconstructed historical campaign-status count.
- Campaign spend is stored as lifetime data. CPL/cost per won/ROI use lifetime lead metrics and are labelled accordingly; lead counts and conversion use the selected period.
- Coaching playbook counts are explicitly labelled training samples; the selected-period workspace metrics and rep metrics are separate from the historical training sample.

## Migration and rollout

1. Apply backend `models/migration_phase2_data.sql` using the normal migration process. Requires the Phase 1 and existing stage-history migrations. It adds `city`, `custom_fields`, provider submission idempotency, daily/lifetime budgets, the canonical source check, indexes, and a transactionally recorded stage-history trigger. The migration is safe to rerun.
2. Stage the backend release and run `node scripts/backfillDataQuality.js --dry-run`. Review the lead IDs and changed field names; invalid phone records are reported without rewriting their numbers. Unknown source values become `other`. Common reversible mojibake is repaired; truncated corruption such as `Hakimâs` is intentionally left for manual review.
3. In a maintenance window, run the same script with `--apply`, then rerun `--dry-run`. The script uses optimistic concurrency checks and preserves existing business/city/custom-field values. It does **not** merge records. Complete normalization before resuming ordinary writes: the NOT VALID source check permits historical rows but enforces canonical source values on new/updated rows.
4. Deploy the backend and then the frontend. Default `dedupe_mode` is `phone`; Settings supports `phone_or_email` and `off`. Provider retry IDs remain idempotent in every mode. New invalid phone submissions return 422; imports with any invalid phone reject the entire file before importing rows.
5. Use Leads → More actions → Duplicates to preview matching groups and merge intentionally. The oldest ID is enforced server-side. Removed lead data and colliding automation enrollment state are archived in merge activities; linked notes/chats/history/files are repointed in one transaction. One oldest enrollment per sequence is retained to avoid running duplicate sequences.
6. Run the existing Meta insights sync to populate campaign budgets, including paginated ad-set budgets when the campaign does not own its budget. Values convert minor currency units to major units (paise → rupees for INR).

No production migration, backfill, merge, sync or deployment was performed in this session.

## Validation

Use Node 22 or newer.

- Frontend: `npm test` (8 passing), `npm run build` (passing).
- Backend: `npm test` with `PHASE1_TEST_DATABASE_URL` and `PHASE2_TEST_DATABASE_URL` set to an **isolated disposable PostgreSQL database** (26 passing, no skips). Tests create and drop their own schemas. Never point these variables at production.
- SQL coverage includes migration reruns, period boundaries in Asia/Kolkata, source/won counts, reopened leads, workspace/staff isolation, provider retry idempotency, concurrent dedupe, oldest-record merge, notes/chats/enrollment preservation.
- Unit/API coverage includes shared metrics across all four endpoints, invalid create/import/API-key phones, source normalization, Meta mapping, UTF-8 CSV, Unicode avatars, status old→new labels, paginated budgets, and idempotent dry-run repairs.
- Changed backend JavaScript passes `node --check`; both diffs pass `git diff --check`.
- Neither repository defines lint or typecheck scripts; both were attempted and are unavailable. Vite reports its existing large bundle and stale Browserslist warnings.
- Browser automation is unavailable in this session; authenticated browser/network verification remains pending.

## Manual QA checklist

- [ ] Select the same month on Dashboard, Reports, Campaigns and Coaching; verify identical workspace Won/conversion and active campaign counts. Compare unassigned against period-filtered leads. Repeat as staff.
- [ ] Move an older lead to Won, reopen it, and verify its win remains in that period. Saving the same stage must not add another win.
- [ ] Verify Manual/manual collapse into one source and won counts count actual Won entries. Check Meta Ads and Google Ads display labels.
- [ ] Create/import `8980235151`, `918980235151`, and `+91 89802 35151`: stored E.164 and one lead in phone mode, with duplicate activities. Invalid `+99917935110` returns 422. Test email mode and off mode.
- [ ] Preview and merge a duplicate group with notes, WhatsApp chats and sequence enrollments. Verify the oldest ID survives and child records remain accessible.
- [ ] Submit a Meta form with Business Name, City, Staff and Chairs. Verify mapped fields, custom fields and raw form data in notes. Retry the same provider submission and verify no second activity.
- [ ] Import UTF-8 CSV containing `Hakim’s Aalim Salon` and `𝐒𝐮𝐧𝐢𝐭𝐚`. Verify names, initials and NFKC search.
- [ ] Sync campaign/ad-set budgets with known INR amounts; verify daily/lifetime labels and paise conversion.
- [ ] Clear a lead status, set it again and resave unchanged: explicit old→new labels, no blank or duplicate status activity.
- [ ] Visit every sidebar route in a normal authenticated workspace; check console and API failures.

## Files changed

Frontend:

- `docs/phase-2-data.md`
- `package-lock.json`
- `package.json`
- `src/components/layout/Sidebar.jsx`
- `src/components/whatsapp/TemplateCreateForm.jsx`
- `src/pages/AppointmentsPage.jsx`
- `src/pages/CampaignsPage.jsx`
- `src/pages/CoachingPage.jsx`
- `src/pages/DashboardPage.jsx`
- `src/pages/LeadAutomation/LeadAutomationPage.jsx`
- `src/pages/LeadDetailPage.jsx`
- `src/pages/LeadsPage.jsx`
- `src/pages/ReportsPage.jsx`
- `src/pages/SettingsPage.jsx`
- `src/pages/StaffPage.jsx`
- `src/pages/WhatsAppInboxPage.jsx`
- `src/services/api.js`
- `src/utils/leadData.js`
- `tests/leadData.test.js`

Backend:

- `controllers/campaignController.js`
- `controllers/googleAdsIntegrationController.js`
- `controllers/googleWebhookController.js`
- `controllers/integrationController.js`
- `controllers/leadController.js`
- `controllers/metaWebhookController.js`
- `controllers/playbookController.js`
- `controllers/reportsController.js`
- `controllers/settingsController.js`
- `controllers/whatsappController.js`
- `docs/phase-2-data.md`
- `models/migration_phase2_data.sql`
- `package-lock.json`
- `package.json`
- `scripts/backfillDataQuality.js`
- `services/duplicates.js`
- `services/leadIngestion.js`
- `services/metrics.js`
- `tests/phase2.test.js`
- `tests/phase2Sql.test.js`
- `utils/dataQuality.js`
- `utils/metaAdInsights.js`
- `utils/metaBudget.js`
- `utils/metaFieldData.js`
- `utils/metaLeadSync.js`
