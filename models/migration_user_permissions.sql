-- ============================================
-- Per-user permission overrides migration - Run in pgAdmin on RDS curvelead database
-- ============================================

CREATE TABLE IF NOT EXISTS user_permissions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key VARCHAR(100) NOT NULL,
  granted        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_permissions_unique ON user_permissions(user_id, permission_key);
CREATE INDEX IF NOT EXISTS idx_user_permissions_tenant ON user_permissions(tenant_id);
