# Ad identity migration (Phase 1) — NOT APPLIED ANYWHERE

Nothing in this directory has been run against any database. The application has three modes, chosen **only** by
the rollout state stored in `ad_identity_rollout` and changed **only** by `scripts/adIdentityRollout.js`. Columns,
or indexes, appearing in a database never change behaviour by themselves.

| Mode | Writers | Readers / conflict targets |
|---|---|---|
| `legacy` (default; also when the table or row is absent) | exactly as before the migration | legacy keys |
| `dual_write` | also fill the new key columns | legacy keys |
| `scoped` | fill keys, upsert on the account-scoped keys | account + canonical key; degrades to `dual_write` if any index/constraint is not valid |

| Step | What | How | Gate |
|---|---|---|---|
| 0 | Diagnostics + readiness (read-only) | `scripts/adIdentityDiagnostics.js`, `scripts/adIdentityReadiness.js` | authorization to touch a named database |
| 1 | Additive columns + rollout table | `models/migration_ad_identity_columns.sql`, `models/migration_ad_identity_rollout.sql` (psql) | approval per environment |
| 2 | Deploy the code to **every** instance | deploy | state is still `legacy`, so nothing changes |
| 3 | `node scripts/adIdentityRollout.js set dual_write` | script | step 1 and 2 done |
| 4 | Backfill: dry-run, review `unresolvable`, then `--apply`. Wait 15+ minutes after step 3 first | `scripts/backfillAdIdentity.js` | `--apply` refuses unless state is `dual_write`/`scoped` |
| 5 | Key-present CHECKs + scoped unique indexes | `03_constraints_and_indexes.sql` (psql, **not** in a transaction) | readiness shows no backfillable rows; unresolvable records resolved by the owner |
| 6 | `node scripts/adIdentityRollout.js set scoped` | script | re-runs readiness inside the same transaction and refuses unless PASS |
| 7 | Soak >= 14 days | — | collision monitor stays at zero |
| 8 | `99_key_swap_DO_NOT_RUN.sql` | psql | **separate explicit approval**; point of no return |

## Rollback
* `set dual_write` — instant (<= 60 s cache) return from scoped reads/writes; keys keep being written. Always safe.
* `set legacy` — only after `rollback_03_indexes.sql` removed the CHECK constraints (the script refuses otherwise).
* `rollback_01_columns.sql` / `DROP TABLE ad_identity_rollout` — only from `legacy` with no constraints/indexes.
After step 8 there is no clean rollback once legitimate duplicates exist: forward-fix, quarantine tables, or backup restore.

## Why dual_write exists
A backfill is only "complete" at an instant. While writers still insert rows without keys, new NULL-key rows appear behind it,
and the CHECK constraints would then reject those writers. `dual_write` makes writers produce keys first; the validated CHECK
constraints then keep the table complete by construction.

## Records that cannot be keyed
A Google ad insight row with no ad group id (or an ad whose ad group has no id), an account with an unknown provider, or an
empty external id cannot be given a canonical key without guessing. The backfill leaves them NULL, lists them under
`unresolvable` with a reason and exits 3; readiness FAILs on them. Nothing assigns them a key. The owner decides whether to
repair the source data or retire the rows; that is a data change and needs its own approval.

## Legacy constraints
The legacy unique keys are neither dropped nor assumed gone before step 8. In `scoped` mode a duplicate external id across
accounts (or the same Google ad id in two ad groups) still violates the legacy unique key and fails loudly (SQLSTATE 23505)
until the key swap. Readiness checks that the legacy keys are still present.
