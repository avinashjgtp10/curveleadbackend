# Phase 1 design note: conversion milestone integrity

Status: design correction recorded 2026-10-12. No milestone code exists yet (out of scope for the limited start).

**Rule.** Critical conversion milestone writes (first qualified, first won) must be transactionally consistent with the
successful lead stage change. They are written in the same transaction as the stage update, and any milestone-integrity
error propagates and rolls the stage change back. It must not be swallowed (no `EXCEPTION WHEN OTHERS` in a trigger body,
no fire-and-forget write, no `.catch(() => {})`).

**Allowed asynchronous.** Non-critical downstream work may fail independently and be retried: analytics fan-out,
notifications, dashboards caches, optional conversion-upload queueing. These are enqueued after commit.

**Consequences for the plan.**
- The earlier idea of a trigger that swallows errors is withdrawn.
- A milestone trigger (or in-transaction application write) must check `NEW.stage IS DISTINCT FROM OLD.stage`, because
  `UPDATE OF stage` fires on unchanged values, and must be idempotent (unique key on lead + milestone).
- All stage writers share the rule: `updateLead`, `bulkUpdate`, `followupController.reviewFollowup`, `changeLeadStage`,
  merge patch and `leadIngestion`.
- Tests required when implemented: a forced milestone failure leaves the stage unchanged; a forced analytics failure does
  not; replaying the same change creates no second milestone.
