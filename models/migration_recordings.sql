-- Run this on RDS
CREATE TABLE IF NOT EXISTS call_recordings (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id          UUID REFERENCES leads(id) ON DELETE CASCADE,
  uploaded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  recording_type   VARCHAR(10) NOT NULL DEFAULT 'audio',   -- audio | video
  title            VARCHAR(200),
  file_name        VARCHAR(255),
  file_url         TEXT,
  file_size        BIGINT,
  transcription    TEXT,
  analysis         JSONB,
  analysis_status  VARCHAR(20) DEFAULT 'pending',           -- pending | processing | done | failed | too_large
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recordings_lead     ON call_recordings(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_tenant   ON call_recordings(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_uploader ON call_recordings(tenant_id, uploaded_by);
