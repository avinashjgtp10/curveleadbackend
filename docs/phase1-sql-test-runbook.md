# Running the Phase 1 real-PostgreSQL tests on the RDS server

The tests create a **throwaway database** (`curvelead_test_phase1_<timestamp>`) on the same RDS instance, run, and drop it.
They never touch your application database. The harness refuses an admin URL that names anything but `postgres` / `template1`.

## One-time: get the branch onto the server without touching the live app
The live app runs from `~/curveleadbackend`. Do NOT switch branches there. Use a separate checkout:

    cd ~/curveleadbackend
    git fetch origin feature/phase1-milestone-writes
    git worktree add ~/phase1-test origin/feature/phase1-milestone-writes
    ln -s ~/curveleadbackend/node_modules ~/phase1-test/node_modules

(If the fetch asks for credentials, copy the files with scp from your laptop instead:
`models/migration_phase1_*.sql scripts/backfillMilestones.js scripts/runPhase1SqlTests.js tests/phase1*.js`
into the same relative paths under `~/phase1-test/`.)

## Run
    set +H
    P=/curvelead/backend/production
    g() { aws ssm get-parameter --region us-east-1 --with-decryption --name "$P/$1" --query Parameter.Value --output text; }
    export PHASE1_ADMIN_URL="postgres://$(g DB_USER):$(g DB_PASSWORD)@$(g DB_HOST):$(g DB_PORT)/postgres?sslmode=no-verify"
    cd ~/phase1-test
    node scripts/runPhase1SqlTests.js --i-have-authorization
    unset PHASE1_ADMIN_URL

Expected: `created throwaway database ...`, the test results, then `dropped ...`. Exit code 0 when all pass.
If anything fails, paste the failing test's message (never the URL). `--keep` leaves the database for inspection.

## Clean up the checkout
    cd ~/curveleadbackend && git worktree remove --force ~/phase1-test
