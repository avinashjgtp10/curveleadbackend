-- Run this on RDS
-- AI Voice Calling Agent feature

CREATE TABLE IF NOT EXISTS ai_voice_agents (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name             VARCHAR(200) NOT NULL,
  voice_provider   VARCHAR(30) DEFAULT '11labs',
  voice_id         VARCHAR(100) NOT NULL,
  voice_name       VARCHAR(100),
  language         VARCHAR(10) DEFAULT 'en',
  system_prompt    TEXT NOT NULL,
  first_message    TEXT,
  is_default       BOOLEAN DEFAULT false,
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_voice_calls (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id           UUID REFERENCES leads(id) ON DELETE CASCADE,
  agent_id          UUID REFERENCES ai_voice_agents(id) ON DELETE SET NULL,
  initiated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  provider          VARCHAR(30) DEFAULT 'vapi',
  provider_call_id  VARCHAR(200),
  phone_number      VARCHAR(20),
  status            VARCHAR(20) DEFAULT 'queued',   -- queued | ringing | in_progress | completed | failed | no_answer
  ended_reason      VARCHAR(100),
  duration_seconds  INT,
  recording_url     TEXT,
  transcript        TEXT,
  analysis          JSONB,
  cost_usd          NUMERIC(10,4),
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_voice_agents_tenant     ON ai_voice_agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ai_voice_calls_lead        ON ai_voice_calls(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_voice_calls_tenant      ON ai_voice_calls(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_voice_calls_provider_id ON ai_voice_calls(provider_call_id);
