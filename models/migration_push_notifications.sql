-- ============================================
-- Push notifications migration - run once in pgAdmin on the curvelead database
-- ============================================
-- push_tokens: the Expo push token of every phone that is signed in to the mobile app.
-- notifications.pushed_at: set when a notification has been sent to the phones (so it is sent only once).

CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       VARCHAR(255) NOT NULL UNIQUE,
  platform    VARCHAR(10),
  device_id   VARCHAR(255),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMP;

-- Existing notifications were never meant to be pushed: mark them as done so the first run doesn't send old ones.
UPDATE notifications SET pushed_at = NOW() WHERE pushed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_unpushed ON notifications(created_at) WHERE pushed_at IS NULL;
