-- Ads & Social Phase 6: social posting and scheduling (Facebook Pages, Instagram, Google Business Profile).
-- Additive only; safe to re-run.
BEGIN;

-- One row per place a workspace can post to. Facebook and Instagram publish with the
-- Page access token (stored encrypted, like ad_oauth_tokens); token_id points at the
-- Facebook login it came from. GBP rows use the workspace's Google connection
-- (tenants.settings.gmb_refresh_token_encrypted), so they carry no token here.
CREATE TABLE IF NOT EXISTS social_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform           text NOT NULL CHECK (platform IN ('facebook', 'instagram', 'gbp')),
  external_id        text NOT NULL,              -- Page id, IG user id, or GBP "locations/123"
  parent_external_id text,                       -- IG: its Facebook Page; GBP: "accounts/456"
  name               text,
  username           text,
  picture_url        text,
  token_id           uuid REFERENCES ad_oauth_tokens(id) ON DELETE SET NULL,
  token_encrypted    text,
  key_version        smallint,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'error')),
  last_error         text,
  is_active          boolean NOT NULL DEFAULT true,  -- shown in the composer
  meta               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS social_accounts_tenant ON social_accounts (tenant_id, platform) WHERE is_active;

CREATE TABLE IF NOT EXISTS social_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  caption         text NOT NULL DEFAULT '',
  link_url        text,
  media           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ s3_key, type: 'image'|'video', mime }]
  post_type       text NOT NULL DEFAULT 'feed' CHECK (post_type IN ('feed', 'photo', 'carousel', 'video', 'reel')),
  scheduled_at    timestamptz,                          -- null = publish now / draft
  next_attempt_at timestamptz,                          -- retry time for failed targets
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled')),
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_posts_tenant_time ON social_posts (tenant_id, COALESCE(scheduled_at, created_at));
-- The scheduler's sweep: scheduled posts that are due.
CREATE INDEX IF NOT EXISTS social_posts_due ON social_posts (COALESCE(next_attempt_at, scheduled_at)) WHERE status = 'scheduled';

-- One row per post × account, so each platform succeeds, fails and retries on its own.
CREATE TABLE IF NOT EXISTS social_post_targets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          uuid NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform         text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  external_post_id text,
  permalink        text,
  error            text,
  attempts         int NOT NULL DEFAULT 0,
  published_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, account_id)
);
CREATE INDEX IF NOT EXISTS social_post_targets_tenant ON social_post_targets (tenant_id, post_id);

COMMIT;
