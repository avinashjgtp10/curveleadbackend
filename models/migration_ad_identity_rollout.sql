-- Phase 1 / ad identity, rollout control: ONE row that says which identity mode the application may use.
-- Additive and inert: nothing reads it until services/adIdentity.js runs, and with no row (or state 'legacy')
-- the application behaves exactly as before. The state is changed only by scripts/adIdentityRollout.js,
-- which refuses 'scoped' unless scripts/adIdentityReadiness.js passes.
-- Not yet applied to any database. Rollback: DROP TABLE IF EXISTS ad_identity_rollout;
CREATE TABLE IF NOT EXISTS ad_identity_rollout (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state      varchar(20) NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy', 'dual_write', 'scoped')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  note       text,
  readiness  jsonb            -- the readiness report that justified the last change to 'scoped'
);
