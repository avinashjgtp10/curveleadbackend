-- ============================================
-- Razorpay recurring subscriptions - Run in pgAdmin on RDS curvelead database
-- (also safe to run against local dev DB)
-- ============================================

-- Cache the Razorpay Plan ID created for each of our plans/billing periods
-- so we only ever create it once via the Razorpay API (never hardcoded).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_id_monthly VARCHAR(64);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_id_yearly VARCHAR(64);

-- Track the active Razorpay customer/subscription for each workspace so the
-- webhook can find the right tenant for subscription.* events, and so we can
-- extend/cancel the subscription later.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS razorpay_customer_id VARCHAR(64);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS razorpay_subscription_id VARCHAR(64);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_period VARCHAR(10);

CREATE INDEX IF NOT EXISTS idx_tenants_razorpay_subscription ON tenants(razorpay_subscription_id);

-- De-dupe Razorpay webhook deliveries (Razorpay retries webhooks on timeout,
-- so the same event can arrive more than once).
CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_key VARCHAR(255) UNIQUE NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
