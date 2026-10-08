# Phase 3: Search and performance

Branch: `fix/phase-3-search-performance`, based on local `fix/phase-2-data` work. Both phases must be published in dependency order. No production deployment or database migration was performed.

## Behavior

Lead search waits 300 ms, cancels obsolete requests and rejects late responses. The server ranks exact, prefix, then contains matches while retaining tenant, assignment, filter and pagination scope. Names use Unicode NFKC normalization, case folding and accent removal. Phone searches accept formatting and digit suffixes; lead numbers and exact UUIDs are supported. LIKE metacharacters are literal. Conservative fuzzy name matching runs only when the entire filtered direct result set is empty, with a visible similar-results notice. Matching text is highlighted without inserting HTML.

New users consistently exclude Unqualified and Lost. Existing saved preferences are respected, resolved before the first list request and cached per tenant/user. Selecting an excluded stage explicitly makes it visible. Active filter chips remain visible outside the filter panel and can be removed.

Opening Leads performs no Meta sync POST. The existing five-minute background job and manual button remain. A read-only tenant-scoped endpoint supplies the last successful completion timestamp; failed syncs do not advance it. Existing Meta pagination behavior is unchanged.

A shared TanStack Query API cache deduplicates simultaneous reads: auth/profile, preferences, staff and GMB settings stay fresh for 60 seconds; stages/statuses for five minutes; lead lists/followups for 15 seconds; sync status for 30 seconds. Successful mutations invalidate related paths. Session changes cancel and discard the prior account cache. One consumer cancelling does not cancel other consumers of the same request.

## Rollout

Apply backend `models/migration_phase3_search.sql` before deploying the backend and frontend. It installs `unaccent` and `pg_trgm`, a normalized-name function and three expression indexes over existing leads; no data backfill is required. The migration is transactional and repeatable. It uses regular index creation, so schedule a maintenance window for a large leads table because writes can be blocked. The database role needs extension/index creation privileges. Reindex normalized-name indexes if unaccent dictionary rules change.

## Validation

- Frontend: 19 tests passed, including rendered Leads behavior, debounce, cancellation, stale-response rejection, filter preferences, safe highlighting, shared caching and account changes.
- Backend: 31 tests passed with no skips against an isolated local PostgreSQL cluster. Tests include applying the migration twice, ranking, Unicode/accent matching, phone suffixes, literal search characters, fuzzy fallback, pagination, tenant/staff scope and sync timestamps.
- Production frontend build passed (existing large-chunk warning remains). Backend JavaScript syntax checks and both whitespace checks passed.
- Neither repository defines lint or typecheck scripts. Live browser QA was unavailable; automated component rendering is not a substitute for the manual checks below.

## Manual QA before release

1. Type Harish or Sunita quickly on a slow connection: one request after typing settles, obsolete requests cancelled, no stale result flashes. Verify exact names rank above prefixes and contains matches.
2. Search accented/compatibility Unicode names, formatted phone suffixes, lead numbers and literal `%`/`_`. Try a misspelling with zero direct matches and verify the similar-results notice. A later empty page must not trigger fuzzy matching.
3. Reload with saved hidden stages. Confirm first request uses saved filters, chips remain visible when filters collapse, removing chips changes results, and explicitly selecting Lost can reveal Lost leads.
4. Open Leads and inspect Network: no Meta sync POST. Check last-sync display, then use the manual button and verify the timestamp comes from successful server completion.
5. Visit components sharing auth, stage, staff and GMB data within freshness windows and confirm read deduplication. Change a lead or preference and confirm related reads refresh.
6. Log out or switch accounts while requests are pending. Confirm old responses never populate the new account's cache or list.

## Changed files

Frontend: package manifest/lock; `src/context/AuthContext.jsx`; `src/pages/LeadsPage.jsx`; `src/services/api.js`; new `src/services/queryCache.js`, `src/hooks/useDebouncedValue.js`, `src/utils/leadSearch.js`, `src/components/ui/SearchHighlight.jsx`; three new test files (`leadSearch`, `leadsPage`, `queryCache`); this document.

Backend: lead/integration controllers, integrations routes and Meta sync utility; new search utility, migration and two test files (`phase3`, `phase3Sql`); this document.
