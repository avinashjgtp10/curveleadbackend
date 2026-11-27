-- Business details shown in Settings -> Business and printed on quotations.
-- Older databases lack these; without them GET/PUT /api/settings fails with a 500.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS gst_number text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pan_number text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS website text;
