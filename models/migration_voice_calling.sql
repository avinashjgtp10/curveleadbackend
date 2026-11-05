-- ============================================
-- CurveLead Voice (human agent calling, multi-tenant, provider-independent).
-- Run in pgAdmin on RDS curvelead database. Idempotent. Not related to the AI-calling
-- tables (ai_voice_calls) — those are untouched.
--
-- Money rules:
--   * Wallet balances and charges are BIGINT in currency MINOR units (paise / fils / cents).
--   * Per-minute rates are BIGINT in MICRO-units of the major currency (1 INR = 1,000,000), so
--     sub-paisa provider rates are exact. No floats anywhere.
-- Fail-closed: every country policy is seeded DISABLED; nothing can be dialled until a platform
-- admin enables a policy AND the organization's voice_accounts.allowed_destination_countries
-- lists the destination AND a rate card exists.
-- ============================================

-- One calling account per organization (tenant) per provider.
CREATE TABLE IF NOT EXISTS voice_accounts (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider                    VARCHAR(30) NOT NULL,
  provider_account_reference  VARCHAR(200),            -- NON-secret id, e.g. Telnyx connection_id. API keys live in SSM/env.
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','active','suspended','closed')),
  business_verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified'
                              CHECK (business_verification_status IN ('unverified','pending','verified','rejected')),
  default_currency            CHAR(3) NOT NULL DEFAULT 'INR',
  allowed_destination_countries TEXT[] NOT NULL DEFAULT '{}',   -- org-level allow list (ISO-3166 alpha-2)
  max_call_seconds            INTEGER NOT NULL DEFAULT 1800,
  daily_call_limit_per_agent  INTEGER NOT NULL DEFAULT 200,
  daily_spend_limit_minor     BIGINT  NOT NULL DEFAULT 0,       -- 0 = no extra daily cap beyond wallet balance
  recording_enabled           BOOLEAN NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);

-- Caller IDs the organization is authorised to present. Only 'verified' rows are ever used.
CREATE TABLE IF NOT EXISTS voice_phone_numbers (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider            VARCHAR(30) NOT NULL,
  phone_number_e164   VARCHAR(20) NOT NULL,
  country_code        CHAR(2) NOT NULL,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (verification_status IN ('pending','verified','rejected','revoked')),
  assigned_agent_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  capabilities        JSONB NOT NULL DEFAULT '{"voice_outbound": true}',
  verified_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, phone_number_e164)                -- a number belongs to exactly one organization
);
CREATE INDEX IF NOT EXISTS idx_voice_numbers_tenant ON voice_phone_numbers(tenant_id, verification_status);

-- Platform-level policy per (organization country -> destination country). Seeded disabled.
CREATE TABLE IF NOT EXISTS voice_country_policies (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  origin_country          CHAR(2) NOT NULL,
  destination_country     CHAR(2) NOT NULL,
  enabled                 BOOLEAN NOT NULL DEFAULT false,
  approved_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at             TIMESTAMPTZ,
  approval_notes          TEXT,                       -- who verified provider routing + legal position, and when
  requires_business_verification BOOLEAN NOT NULL DEFAULT true,
  requires_verified_caller_id    BOOLEAN NOT NULL DEFAULT true,
  requires_contact_consent       BOOLEAN NOT NULL DEFAULT true,
  recording_allowed       BOOLEAN NOT NULL DEFAULT false,
  allowed_number_types    TEXT[] NOT NULL DEFAULT '{MOBILE,FIXED_LINE,FIXED_LINE_OR_MOBILE}',
  calling_hours_start     TIME NOT NULL DEFAULT '09:00',   -- local time in destination_timezone
  calling_hours_end       TIME NOT NULL DEFAULT '21:00',
  destination_timezone    VARCHAR(60) NOT NULL DEFAULT 'UTC',
  max_call_seconds        INTEGER NOT NULL DEFAULT 1800,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (origin_country, destination_country)
);

-- Placeholders only: disabled, conservative hours. Legal review must set real values before enabling.
INSERT INTO voice_country_policies (origin_country, destination_country, destination_timezone) VALUES
  ('IN','IN','Asia/Kolkata'), ('IN','AE','Asia/Dubai'), ('IN','SG','Asia/Singapore'),
  ('AE','AE','Asia/Dubai'),   ('AE','IN','Asia/Kolkata'), ('AE','SG','Asia/Singapore'),
  ('SG','SG','Asia/Singapore'), ('SG','IN','Asia/Kolkata'), ('SG','AE','Asia/Dubai')
ON CONFLICT (origin_country, destination_country) DO NOTHING;

-- Rate cards. tenant_id NULL = platform price list; non-NULL = organization pricing-plan override.
CREATE TABLE IF NOT EXISTS voice_rate_cards (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  provider                    VARCHAR(30) NOT NULL,
  destination_country         CHAR(2) NOT NULL,
  destination_prefix          VARCHAR(10) NOT NULL,        -- digits after '+', e.g. '9198'; longest match wins
  call_type                   VARCHAR(10) NOT NULL DEFAULT 'any' CHECK (call_type IN ('any','mobile','landline')),
  cost_per_minute_micro       BIGINT NOT NULL CHECK (cost_per_minute_micro >= 0),       -- what the provider charges us
  selling_price_per_minute_micro BIGINT NOT NULL CHECK (selling_price_per_minute_micro >= 0), -- what we charge the org
  billing_increment_seconds   INTEGER NOT NULL DEFAULT 60 CHECK (billing_increment_seconds > 0),
  currency                    CHAR(3) NOT NULL,
  effective_from              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voice_rates_lookup ON voice_rate_cards(destination_country, provider, effective_from DESC);

CREATE TABLE IF NOT EXISTS voice_wallets (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  currency          CHAR(3) NOT NULL DEFAULT 'INR',
  available_balance BIGINT NOT NULL DEFAULT 0,             -- minor units; may dip below 0 only via settlement overage
  reserved_balance  BIGINT NOT NULL DEFAULT 0 CHECK (reserved_balance >= 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, currency)
);

-- A call row doubles as the authorization record: status 'authorized' + authorization_expires_at.
CREATE TABLE IF NOT EXISTS voice_calls (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id                  UUID REFERENCES leads(id) ON DELETE SET NULL,
  agent_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
  provider                 VARCHAR(30) NOT NULL,
  provider_call_id         VARCHAR(200),                   -- Telnyx call_control_id
  provider_session_id      VARCHAR(200),                   -- Telnyx call_session_id
  direction                VARCHAR(10) NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  from_number              VARCHAR(20) NOT NULL,
  to_number                VARCHAR(20) NOT NULL,
  destination_country      CHAR(2) NOT NULL,
  call_type                VARCHAR(10) NOT NULL DEFAULT 'any',
  status                   VARCHAR(20) NOT NULL DEFAULT 'authorized'
                           CHECK (status IN ('authorized','expired','initiating','ringing','answered','completed','no_answer','busy','failed','canceled')),
  authorization_expires_at TIMESTAMPTZ,
  max_duration_seconds     INTEGER NOT NULL,
  reserved_amount          BIGINT NOT NULL DEFAULT 0,      -- minor units currently held in the wallet for this call
  rate_card_id             UUID REFERENCES voice_rate_cards(id),
  selling_rate_micro       BIGINT,                         -- snapshot at authorization, so settlement is stable
  cost_rate_micro          BIGINT,
  billing_increment_seconds INTEGER NOT NULL DEFAULT 60,
  started_at               TIMESTAMPTZ,
  answered_at              TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  duration_seconds         INTEGER,
  billable_seconds         INTEGER,
  provider_cost            BIGINT,                         -- minor units; estimated at settlement, corrected by reconciliation
  provider_cost_reconciled_at TIMESTAMPTZ,
  customer_cost            BIGINT,                         -- minor units actually debited
  currency                 CHAR(3) NOT NULL DEFAULT 'INR',
  settled_at               TIMESTAMPTZ,
  hangup_cause             VARCHAR(100),
  outcome                  VARCHAR(30),                    -- agent-entered after call
  outcome_notes            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voice_calls_tenant_created ON voice_calls(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_calls_lead ON voice_calls(tenant_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_calls_agent_day ON voice_calls(tenant_id, agent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_calls_provider_call ON voice_calls(provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_calls_expiring ON voice_calls(authorization_expires_at) WHERE status = 'authorized';

-- Raw provider events. The unique key IS the replay / duplicate protection.
CREATE TABLE IF NOT EXISTS voice_call_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id           UUID NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  provider          VARCHAR(30) NOT NULL,
  provider_event_id VARCHAR(200) NOT NULL,
  event_type        VARCHAR(60) NOT NULL,
  occurred_at       TIMESTAMPTZ,
  payload           JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_events_call ON voice_call_events(call_id, occurred_at);

-- Append-only ledger. Unique idempotency_key makes reserve/release/settle/top-up replay-safe.
CREATE TABLE IF NOT EXISTS voice_wallet_transactions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wallet_id        UUID NOT NULL REFERENCES voice_wallets(id) ON DELETE CASCADE,
  call_id          UUID REFERENCES voice_calls(id) ON DELETE SET NULL,
  transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('topup','reserve','release','debit','adjustment','refund')),
  amount           BIGINT NOT NULL,                       -- minor units, always positive; direction implied by type
  currency         CHAR(3) NOT NULL,
  idempotency_key  VARCHAR(200) NOT NULL,
  reference        VARCHAR(200),                          -- e.g. confirmed Razorpay payment id for topups
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_voice_wtx_tenant ON voice_wallet_transactions(tenant_id, created_at DESC);

-- Per-device registration (push tokens, which device currently owns an active call session).
CREATE TABLE IF NOT EXISTS voice_agent_devices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     VARCHAR(120) NOT NULL,                    -- client-generated stable id
  platform      VARCHAR(10) NOT NULL CHECK (platform IN ('web','ios','android')),
  push_token    TEXT,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, device_id)
);

-- Provider telephony credential per agent (the id, not the secret token_material).
CREATE TABLE IF NOT EXISTS voice_agent_credentials (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider               VARCHAR(30) NOT NULL,
  provider_credential_id VARCHAR(200) NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, provider)
);

CREATE TABLE IF NOT EXISTS voice_contact_consents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  basis       VARCHAR(40) NOT NULL,                       -- e.g. 'explicit_opt_in','existing_inquiry','contract'
  source      TEXT,
  granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_voice_consents_lead ON voice_contact_consents(tenant_id, lead_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS voice_recordings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id       UUID NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  s3_key        TEXT,                                     -- private bucket; access via short-lived presigned URL + audit row
  provider_recording_id VARCHAR(200),
  duration_seconds INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voice_recordings_call ON voice_recordings(tenant_id, call_id);

CREATE TABLE IF NOT EXISTS voice_audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(60) NOT NULL,                       -- e.g. 'call.denied','policy.enabled','token.issued'
  entity_id   VARCHAR(100),
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voice_audit_tenant ON voice_audit_logs(tenant_id, created_at DESC);

-- DB-enforced single live call per agent: a web tab and a phone cannot both claim a call at once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_calls_agent_live ON voice_calls(agent_id)
  WHERE status IN ('initiating','ringing','answered');

-- Wallet recharge orders (Razorpay). The wallet is credited ONLY after the gateway confirms capture.
CREATE TABLE IF NOT EXISTS voice_topup_orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  razorpay_order_id   VARCHAR(100) NOT NULL UNIQUE,
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3) NOT NULL,
  status              VARCHAR(12) NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  razorpay_payment_id VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_voice_topups_tenant ON voice_topup_orders(tenant_id, created_at DESC);
