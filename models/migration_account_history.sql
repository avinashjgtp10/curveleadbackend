-- Account history — Super Admin → History (Delete Account History / Clean Up Account History).
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_account_history.sql
-- Safe to run more than once. Deleting accounts works without it; the history is simply not recorded.

-- One row per deleted account. No foreign keys to the deleted rows, so history survives the deletion itself.
CREATE TABLE IF NOT EXISTS account_deletion_history (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_type     VARCHAR(20)  NOT NULL,               -- user | organization
  name             VARCHAR(200),
  email            VARCHAR(200),
  role             VARCHAR(50),
  tenant_id        UUID,
  tenant_name      VARCHAR(200),
  deleted_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_by_name  VARCHAR(200),
  deleted_by_email VARCHAR(200),
  reason           TEXT,
  deleted_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_deletion_history_at ON account_deletion_history(deleted_at DESC);

-- One row per organization data clean-up (data cleared, account kept).
CREATE TABLE IF NOT EXISTS account_cleanup_history (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID,
  tenant_name      VARCHAR(200),
  owner_email      VARCHAR(200),
  cleared_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  cleared_by_name  VARCHAR(200),
  cleared_by_email VARCHAR(200),
  reason           TEXT,
  cleared_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_cleanup_history_at ON account_cleanup_history(cleared_at DESC);
