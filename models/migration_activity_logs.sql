-- ============================================
-- Platform-wide activity log for the Super Admin console.
-- Run in pgAdmin on RDS curvelead database (or locally).
-- ============================================

CREATE TABLE IF NOT EXISTS activity_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor_name  VARCHAR(255),
  action      VARCHAR(255) NOT NULL,
  module      VARCHAR(100) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'Success',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant ON activity_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
