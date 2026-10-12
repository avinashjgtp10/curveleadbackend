#!/usr/bin/env node
// Explicit rollout control for account-scoped ad identity. This is the ONLY thing that moves the
// application between identity modes; migrations and schema never do.
//
//   AD_IDENTITY_ROLLOUT_URL=postgres://... node scripts/adIdentityRollout.js status --i-have-authorization
//   AD_IDENTITY_ROLLOUT_URL=postgres://... node scripts/adIdentityRollout.js set <legacy|dual_write|scoped> --i-have-authorization [--note="why"]
//
// Transition rules (enforced here, inside one transaction holding a lock on the rollout row):
//   -> dual_write  columns must all exist. Also the safe ROLLBACK from 'scoped' (keys keep being written).
//   -> scoped      only from dual_write/scoped, and only if the readiness report PASSES in the same transaction.
//   -> legacy      refused while the key-present CHECK constraints exist, because legacy-mode writers do not
//                  fill the keys and the database would reject their rows. Drop the constraints first
//                  (db/phase1/ad_identity/rollback_03_indexes.sql), or roll back to dual_write instead.
// It ignores DATABASE_URL and refuses to run without --i-have-authorization.
const ai = require('../services/adIdentity');
const { collectFacts, evaluateReadiness } = require('./adIdentityReadiness');

const fail = (msg, extra = {}) => Object.assign(new Error(msg), extra);

const status = async ({ client }) => {
  const rollout = await ai.readRollout(client);
  const decided = await ai.decideMode(client);
  return { rollout_state: rollout.state, rollout_table_present: rollout.present, effective_mode: decided.mode, reasons: decided.reasons };
};

// `check` computes the readiness verdict inside the transition's transaction (injectable for tests).
const transition = async ({ client, to, by = null, note = null, check = async (c) => evaluateReadiness(await collectFacts(c)) }) => {
  if (!ai.MODES.includes(to)) throw fail(`unknown state '${to}' (expected ${ai.MODES.join(', ')})`);
  const rollout = await ai.readRollout(client);
  if (!rollout.present) throw fail(`${ai.ROLLOUT_TABLE} does not exist: apply models/migration_ad_identity_rollout.sql (separately approved) first`);

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`INSERT INTO ${ai.ROLLOUT_TABLE} (id, state) VALUES (1, 'legacy') ON CONFLICT (id) DO NOTHING`);
    const current = (await client.query(`SELECT state FROM ${ai.ROLLOUT_TABLE} WHERE id = 1 FOR UPDATE`)).rows[0].state;

    let readiness = null;
    if (to === 'dual_write') {
      const missing = ai.missingColumns(await ai.readColumns(client));
      if (missing.length) throw fail(`cannot enter dual_write: columns missing (${missing.join(', ')})`);
    } else if (to === 'scoped') {
      if (current !== 'dual_write' && current !== 'scoped') throw fail(`cannot enter scoped from '${current}': go through dual_write, run the backfill, then pass readiness`);
      readiness = await check(client);
      if (readiness.status !== 'PASS') throw fail(`readiness FAILED (${readiness.failing.join(', ')}); not enabling scoped`, { readiness });
    } else if (to === 'legacy') {
      const present = await ai.readKeyConstraints(client);
      if (present.length) throw fail(`refusing legacy: key-present constraint(s) exist (${present.map((c) => c.conname).join(', ')}); legacy-mode writers would be rejected. Roll back to dual_write instead.`);
    }

    await client.query(
      `UPDATE ${ai.ROLLOUT_TABLE} SET state = $1, updated_at = now(), updated_by = $2, note = $3, readiness = $4 WHERE id = 1`,
      [to, by, note, readiness ? JSON.stringify(readiness) : null]);
    await client.query('COMMIT');
    return { from: current, to, readiness };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  if (!args.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization once a database has been approved.'); process.exit(2); }
  const url = process.env.AD_IDENTITY_ROLLOUT_URL;
  if (!url) { console.error('Refusing: set AD_IDENTITY_ROLLOUT_URL (this script ignores DATABASE_URL).'); process.exit(2); }
  const cmd = args[0];
  if (cmd !== 'status' && cmd !== 'set') { console.error('Usage: adIdentityRollout.js status|set <state> --i-have-authorization'); process.exit(2); }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  let code = 0;
  try {
    if (cmd === 'status') console.log(JSON.stringify(await status({ client }), null, 2));
    else {
      const note = (args.find((a) => a.startsWith('--note=')) || '').slice(7) || null;
      console.log(JSON.stringify(await transition({ client, to: args[1], by: process.env.USER || null, note }), null, 2));
    }
  } catch (e) {
    console.error(`Not changed: ${e.message}`);
    if (e.readiness) console.error(JSON.stringify(e.readiness.checks.filter((c) => c.status === 'FAIL').map((c) => ({ check: c.name, reason: c.reason })), null, 2));
    code = 1;
  } finally { await client.end(); }
  process.exit(code);
};

if (require.main === module) main();
module.exports = { status, transition };
