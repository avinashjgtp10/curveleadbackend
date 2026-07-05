-- Fix FK constraints on users(id) that are missing ON DELETE SET NULL.
-- Without this, deleting a user fails with FK violation if they created any records.

-- campaigns.created_by
DO $$ BEGIN
  ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_created_by_fkey;
  ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- followups.created_by
DO $$ BEGIN
  ALTER TABLE followups DROP CONSTRAINT IF EXISTS followups_created_by_fkey;
  ALTER TABLE followups
    ADD CONSTRAINT followups_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- quotations.created_by
DO $$ BEGIN
  ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_created_by_fkey;
  ALTER TABLE quotations
    ADD CONSTRAINT quotations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- brochures.uploaded_by
DO $$ BEGIN
  ALTER TABLE brochures DROP CONSTRAINT IF EXISTS brochures_uploaded_by_fkey;
  ALTER TABLE brochures
    ADD CONSTRAINT brochures_uploaded_by_fkey
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- brochure_shares.shared_by
DO $$ BEGIN
  ALTER TABLE brochure_shares DROP CONSTRAINT IF EXISTS brochure_shares_shared_by_fkey;
  ALTER TABLE brochure_shares
    ADD CONSTRAINT brochure_shares_shared_by_fkey
    FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;
