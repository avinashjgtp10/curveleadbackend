-- Super Admin features — platform AI integrations + template activation.
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_super_admin_features.sql
-- Safe to run more than once. The API degrades gracefully if it has not been run.

-- Templates can be deactivated by a Super Admin; inactive ones are hidden from the template picker.
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Platform-level AI provider credentials managed from Super Admin → AI Agent.
-- The credential is stored AES-256-GCM encrypted (utils/cryptoSecrets.js); only a masked hint is ever returned by the API.
CREATE TABLE IF NOT EXISTS platform_ai_integrations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider              VARCHAR(30)  NOT NULL,                 -- groq
  integration_type      VARCHAR(40)  NOT NULL DEFAULT 'llm',   -- llm
  name                  VARCHAR(120),
  credential_encrypted  TEXT         NOT NULL,
  credential_hint       VARCHAR(60)  NOT NULL,                 -- e.g. gsk_••••••••••1234
  status                VARCHAR(20)  NOT NULL DEFAULT 'active', -- active | disabled
  last_tested_at        TIMESTAMP,
  last_test_ok          BOOLEAN,
  last_test_error       TEXT,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- At most one active integration per provider/type, so there is never ambiguity about which key is used.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_ai_active_unique
  ON platform_ai_integrations(provider, integration_type) WHERE status = 'active';
