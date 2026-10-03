-- Batch 1 (E): workspace localisation.
-- Quotations remember the currency and country they were written in, so changing the
-- workspace currency later never relabels old quotes (amounts are never converted).
-- Backfill: every existing quotation was written in its workspace's current currency
-- (INR / IN for workspaces that never set one). Safe to re-run.
BEGIN;

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS currency varchar(3);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS business_country varchar(2);

UPDATE quotations q
SET currency = COALESCE(q.currency, NULLIF(t.settings->>'currency', ''), 'INR'),
    business_country = COALESCE(q.business_country, NULLIF(t.settings->>'country', ''), 'IN')
FROM tenants t
WHERE t.id = q.tenant_id AND (q.currency IS NULL OR q.business_country IS NULL);

COMMIT;
