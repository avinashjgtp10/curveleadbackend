// Static guarantees of the payment ledger migration (the behaviour itself runs in tests/phase1LedgerSql.test.js
// against a throwaway PostgreSQL database).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sql = read('models/migration_phase1_lead_payments.sql');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('the migration is additive: it creates tables/functions/triggers/views and never drops or rewrites existing data', () => {
  assert.doesNotMatch(code, /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
  assert.doesNotMatch(code, /\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(code, /\bTRUNCATE\b/i);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(code, /\n\s*UPDATE\s+(?!leads SET merged_into_id)\w+\s+SET/i, 'the only UPDATE is the re-pointing of merged leads inside the flatten trigger');
});

test('every integrity rule is a database rule, not an application convention', () => {
  assert.match(code, /RAISE EXCEPTION 'lead_payments rows are never deleted/);
  assert.match(code, /IMMUTABLE: the amount, currency, kind, lead and links/);
  assert.match(code, /STATUS_FINAL/);
  assert.match(code, /AUDITED_ONLY/);
  assert.match(code, /OVER_REFUND/);
  assert.match(code, /REVERSAL_AMOUNT/);
  assert.match(code, /CURRENCY_MISMATCH/);
  assert.match(code, /LEAD_MERGED/);
  assert.match(code, /FROM lead_payments WHERE id = NEW\.parent_id FOR UPDATE/, 'concurrent refunds serialize on the payment row');
  assert.match(code, /FROM leads WHERE id = NEW\.lead_id FOR SHARE/, 'a payment and a merge serialize on the lead row');
});

test('duplicate prevention layers exist: idempotency key, method+reference, one reversal per payment', () => {
  assert.match(code, /lead_payments_idempotency_uq ON lead_payments \(tenant_id, idempotency_key\)/);
  assert.match(code, /lead_payments_reference_uq/);
  assert.match(code, /lead_payments_one_reversal_uq ON lead_payments \(parent_id\) WHERE kind = 'reversal'/);
});

test('the audit log is append-only, has no foreign key to leads, and the lead foreign key is RESTRICT', () => {
  assert.match(code, /financial_audit_log_append_only/);
  const audit = code.slice(code.indexOf('CREATE TABLE IF NOT EXISTS financial_audit_log'), code.indexOf('financial_audit_lead_idx'));
  assert.doesNotMatch(audit, /REFERENCES/);
  assert.match(code, /lead_id\s+uuid NOT NULL REFERENCES leads\(id\) ON DELETE RESTRICT/);
});

test('only completed entries count in the net, and merged leads resolve to their root', () => {
  assert.match(code, /FILTER \(WHERE p\.status = 'completed'\)/);
  assert.match(code, /COALESCE\(l\.merged_into_id, l\.id\) AS root_lead_id/);
});

test('the ledger is excluded from the generic merge mover (money never changes owner)', () => {
  assert.match(read('services/leadMerge.js'), /NOT IN \('leads', 'lead_merges', 'lead_milestone_events', 'lead_payments'\)/);
});

test('only a COMPLETED confirmed payment needs its date: pending entries can be cancelled or failed without one', () => {
  assert.match(code, /paid_on IS NOT NULL OR status <> 'completed'/);
  assert.doesNotMatch(code, /paid_on IS NOT NULL OR status = 'pending'/);
});

test('the real-database ledger test is picked up by the harness', () => {
  assert.ok(require('../scripts/runPhase1SqlTests').testFiles().includes('tests/phase1LedgerSql.test.js'));
});
