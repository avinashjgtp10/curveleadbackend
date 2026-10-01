# Phase 1 critical fixes — review and rollout

Lead Automation previously downloaded 500 leads and put their UUIDs in a GET URL. It now uses a paginated, tenant/staff-scoped endpoint with server aggregates and filters. Billing supports the legacy `max_staff` schema and offers a retry after loading fails. Workspace date formatting, UTC picker conversion, appointment validation, bounded Meta retries/cache, and a missing playbook schema migration address the other Phase 1 failures.

## Confirmed causes

Read-only checks against the backend's configured database returned `42703: column max_users does not exist` for the old billing query and `42P01: relation sales_playbooks does not exist` for playbooks. The database also lacks `lead_activities.metadata`. No records or schema were changed in that database.

The activity description was formatted in server local time; the frontend overview used browser local time. The new formatter defaults to Asia/Kolkata and reads `tenant.settings.timezone` or `tenant.timezone`. New scheduled activities retain their UTC instant in metadata. The database connection uses UTC and parses legacy timestamp-without-time-zone values as UTC.

## Migration and deployment order

1. Apply backend `models/migration_phase1_critical.sql` using the normal migration process. It adds activity metadata and creates `sales_playbooks` without changing existing rows. It is safe to rerun.
2. Deploy the backend before the frontend: the frontend calls the new `GET /api/automations/leads`. The existing enrollment GET remains available; POST `/api/automations/enrollments/query` accepts up to 500 UUIDs.
3. If the historical server process used UTC, run `node scripts/backfillScheduledActivity.js --source-timezone=UTC --dry-run`, inspect the counts, then use `--apply`. The script only repairs recognizable scheduling descriptions without existing timestamp metadata. Do not apply it to records authored under a different server timezone. Existing descriptions are preserved.

The Meta last-good cache is in process memory, credential-scoped, limited to 500 entries, fresh for one minute, and available for transient failures for at most 24 hours. Cold-cache failures and invalid credentials still return errors. Meta remains authoritative when sending.

## Validation

Use Node 22 or newer; the machine's default Node cannot run this Vite version.

- Frontend: `npm test` and `npm run build`.
- Backend: `npm test`. Set `PHASE1_TEST_DATABASE_URL` to an isolated test database to enable SQL integration tests; those tests create disposable tables/schemas and must not target production.
- Real PostgreSQL tests cover 600 leads, pages beyond 500, filtered/global counts, staff/tenant scope, legacy/current billing columns, and running the migration twice.
- Regression tests cover billing retry, null/epoch dates, timezone conversion and DST gaps, endpoint validation, playbook empty results, Meta retry/cache isolation/expiry, UTC parsing, and legacy activity parsing.
- Neither repository defines lint or typecheck commands. They were attempted and are unavailable; the Vite build checks frontend compilation. Backend changed JavaScript files receive `node --check` syntax checks.

## Manual QA checklist (pending authenticated deployment)

- [ ] Billing loads on the legacy database. Simulate a failed request, restore it, click Retry, and verify plans recover.
- [ ] With more than 500 leads, Automation shows the true total; navigate past lead 500. Search/status/step filters work across all pages. Confirm staff cannot see another staff member's leads or enrollment status.
- [ ] In a browser configured to UTC or US time, create a 7 Oct 2026, 7:00 pm Asia/Kolkata follow-up. Request payload must be `2026-10-07T13:30:00.000Z`; overview, activity and appointment must agree. Repeat with a different workspace timezone.
- [ ] Confirm null/zero appointment dates show No date and do not increase Overdue. Create/update APIs reject missing, invalid and timezone-free dates.
- [ ] Load Meta templates successfully, then simulate timeouts after cache freshness expires. Verify one retry, stale templates, and no cross-credential cache reuse. Verify cold-cache and expired-token errors remain visible.
- [ ] A tenant without a playbook receives 200 with `{ playbook: null }` after migration. Generate a playbook and verify it displays.
- [ ] Review and apply the legacy activity repair only after confirming historical server timezone. Check LD-04501 and rerun dry-run to confirm repaired records are excluded.
- [ ] Visit every sidebar page in an authenticated normal workspace; check browser console/network for failures. No authenticated browser QA was available in this session.

Cross-page metric reconciliation belongs to Phase 2 and is not included here. No production deployment, migration, or backfill has been performed.

## Files changed

Frontend:

- `docs/phase-1-critical.md`
- `package.json`
- `src/components/layout/NotificationBell.jsx`
- `src/components/lead/LeadAiCalls.jsx`
- `src/components/lead/LeadAttachments.jsx`
- `src/components/lead/LeadIntentCard.jsx`
- `src/components/lead/LeadNotes.jsx`
- `src/components/lead/LeadRecordings.jsx`
- `src/components/lead/WhatsAppBroadcastModal.jsx`
- `src/components/whatsapp/hubUi.jsx`
- `src/context/AuthContext.jsx`
- `src/pages/AppointmentsPage.jsx`
- `src/pages/BillingPage.jsx`
- `src/pages/CampaignDetailPage.jsx`
- `src/pages/CoachingPage.jsx`
- `src/pages/DashboardPage.jsx`
- `src/pages/FollowupsPage.jsx`
- `src/pages/HelpPage.jsx`
- `src/pages/IntegrationsPage.jsx`
- `src/pages/LeadAutomation/LeadAutomationPage.jsx`
- `src/pages/LeadDetailPage.jsx`
- `src/pages/LeadsPage.jsx`
- `src/pages/QuotationPublicPage.jsx`
- `src/pages/QuotationViewPage.jsx`
- `src/pages/ReportsPage.jsx`
- `src/pages/StaffPage.jsx`
- `src/pages/WhatsAppInboxPage.jsx`
- `src/services/api.js`
- `src/utils/dateTime.js`
- `tests/billingRetry.test.js`
- `tests/dateTime.test.js`

Backend:

- `config/db.js`
- `controllers/automationEnrollmentController.js`
- `controllers/followupController.js`
- `controllers/leadController.js`
- `controllers/paymentController.js`
- `controllers/playbookController.js`
- `controllers/whatsappBroadcastController.js`
- `docs/phase-1-critical.md`
- `models/migration_phase1_critical.sql`
- `package.json`
- `routes/automations.js`
- `scripts/backfillScheduledActivity.js`
- `services/whatsappService.js`
- `tests/phase1.test.js`
- `tests/phase1Sql.test.js`
- `utils/dateTime.js`
