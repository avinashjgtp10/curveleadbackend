-- ============================================
-- Team invitations migration - Run in pgAdmin on RDS curvelead database
-- ============================================

CREATE TABLE IF NOT EXISTS invitations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,
  name        VARCHAR(255),
  role        VARCHAR(20) NOT NULL DEFAULT 'staff',
  team_id     UUID REFERENCES teams(id) ON DELETE SET NULL,
  token       VARCHAR(255) UNIQUE NOT NULL,
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMP NOT NULL,
  accepted_at TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_invitations_tenant ON invitations(tenant_id);
