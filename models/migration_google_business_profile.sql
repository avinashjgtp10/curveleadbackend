-- ============================================
-- Google Business Profile integration migration - Run in pgAdmin on RDS curvelead database
-- OAuth tokens live in tenants.settings JSONB (google_business_*), matching
-- how Meta/WhatsApp credentials are already stored per-tenant. Locations and
-- reviews get their own tables since they're structured, per-location data
-- that needs to be queried/joined, not opaque config.
-- ============================================

CREATE TABLE IF NOT EXISTS gbp_locations (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  google_account_id   VARCHAR(255) NOT NULL,
  google_location_id  VARCHAR(255) NOT NULL, -- Google resource name, e.g. "locations/12345"
  title               VARCHAR(255),
  address             TEXT,
  phone               VARCHAR(50),
  maps_uri            TEXT,
  average_rating      NUMERIC(2,1),
  review_count        INTEGER NOT NULL DEFAULT 0,
  last_synced_at      TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, google_location_id)
);

CREATE TABLE IF NOT EXISTS gbp_reviews (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id         UUID NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,
  google_review_id    VARCHAR(255) NOT NULL,
  reviewer_name       VARCHAR(255),
  reviewer_photo_url  TEXT,
  star_rating         VARCHAR(20), -- Google's enum: ONE..FIVE
  comment             TEXT,
  review_reply        TEXT,
  create_time         TIMESTAMP,
  update_time         TIMESTAMP,
  fetched_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, google_review_id)
);

CREATE INDEX IF NOT EXISTS idx_gbp_locations_tenant ON gbp_locations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_tenant ON gbp_reviews(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_location ON gbp_reviews(location_id);
