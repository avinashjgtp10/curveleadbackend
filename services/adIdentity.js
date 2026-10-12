// Account-scoped, provider-safe identity for ad entities.
//
// Legacy tables key ads on (tenant_id, external_id) / (tenant_id, entity_type, entity_id, date),
// which cannot tell two ad accounts apart and, for Google, treats the bare ad ID as global
// even though Google scopes an ad ID to its ad group. The Phase 1 migrations add
// entity_key / external_key / provider columns and scoped unique indexes BESIDE the legacy keys
// (the legacy keys stay in force until a separately approved key swap).
//
// The application runs in exactly one of three modes, chosen by an EXPLICIT rollout state that an
// operator sets after the readiness command passes (scripts/adIdentityRollout.js). The presence of
// columns, or even of valid indexes, never changes the mode on its own:
//   'legacy'     - the default. SQL exactly as before the migration. Used whenever no rollout row exists.
//   'dual_write' - writers also fill the new key columns (so the backfill can complete and stay complete);
//                  conflict targets and every read still use the legacy keys.
//   'scoped'     - writers upsert on the account-scoped keys and readers join on account + canonical key.
//                  Only honoured while the full structure is verified; otherwise it degrades to 'dual_write'.

const GOOGLE = 'google';
const META = 'meta';
const MODES = ['legacy', 'dual_write', 'scoped'];
const ROLLOUT_TABLE = 'ad_identity_rollout';
const TABLES = ['ad_insights_daily', 'ad_campaigns', 'ad_adsets', 'ad_ads'];

const REQUIRED_COLUMNS = [
  ['ad_insights_daily', 'entity_key'], ['ad_insights_daily', 'provider'],
  ['ad_campaigns', 'external_key'], ['ad_campaigns', 'provider'],
  ['ad_adsets', 'external_key'], ['ad_adsets', 'provider'], ['ad_adsets', 'ad_account_id'],
  ['ad_ads', 'external_key'], ['ad_ads', 'provider'], ['ad_ads', 'ad_account_id'],
];

// Account-scoped unique indexes: name -> table and exact column list.
const SCOPED_INDEX_SPECS = {
  ad_insights_daily_scoped_uq: { table: 'ad_insights_daily', columns: ['tenant_id', 'ad_account_id', 'entity_type', 'entity_key', 'date'] },
  ad_campaigns_scoped_uq: { table: 'ad_campaigns', columns: ['tenant_id', 'ad_account_id', 'external_key'] },
  ad_adsets_scoped_uq: { table: 'ad_adsets', columns: ['tenant_id', 'ad_account_id', 'external_key'] },
  ad_ads_scoped_uq: { table: 'ad_ads', columns: ['tenant_id', 'ad_account_id', 'external_key'] },
};
const SCOPED_INDEXES = Object.keys(SCOPED_INDEX_SPECS);

// "Key present" CHECK constraints added NOT VALID then VALIDATEd by step 3. Once validated the database
// itself rejects a row without its keys, so a completed backfill cannot silently regress.
const KEY_PRESENT_CONSTRAINTS = {
  ad_insights_entity_key_present: 'ad_insights_daily',
  ad_campaigns_key_present: 'ad_campaigns',
  ad_adsets_key_present: 'ad_adsets',
  ad_ads_key_present: 'ad_ads',
};

// The legacy unique keys. They must still exist until the key swap; nothing here assumes they are gone.
const LEGACY_UNIQUE = {
  ad_insights_daily: ['tenant_id', 'entity_type', 'entity_id', 'date'],
  ad_campaigns: ['tenant_id', 'external_id'],
  ad_adsets: ['tenant_id', 'external_id'],
  ad_ads: ['tenant_id', 'external_id'],
};

const str = (v) => (v == null ? '' : String(v));

// Canonical key for an entity within its ad account.
//  Meta: Graph IDs are global, key = id.
//  Google: campaign and ad group IDs are global, key = id; an ad ID is only unique inside its
//  ad group, so the key is "<adGroupId>~<adId>" (the suffix of Google's own resource name).
const adEntityKey = (provider, level, { id, adGroupId } = {}) => {
  const base = str(id).trim();
  if (!base) return null;
  if (provider === GOOGLE && level === 'ad') {
    const g = str(adGroupId).trim();
    if (!g) return null; // never fall back to the bare ID: that is the collision we are removing
    return `${g}~${base}`;
  }
  return base;
};

const providerOf = (account) => (account && account.provider === GOOGLE ? GOOGLE : META);

// ---- mode helpers -------------------------------------------------------------------------------
const writesKeys = (mode) => mode === 'dual_write' || mode === 'scoped';
const readsScoped = (mode) => mode === 'scoped';

// ON CONFLICT targets per mode. Only 'scoped' leaves the legacy keys; dual_write keeps using them.
const conflictTarget = (mode, table) => {
  if (mode === 'scoped') {
    return {
      ad_insights_daily: '(tenant_id, ad_account_id, entity_type, entity_key, date)',
      ad_campaigns: '(tenant_id, ad_account_id, external_key)',
      ad_adsets: '(tenant_id, ad_account_id, external_key)',
      ad_ads: '(tenant_id, ad_account_id, external_key)',
    }[table];
  }
  return {
    ad_insights_daily: '(tenant_id, entity_type, entity_id, date)',
    ad_campaigns: '(tenant_id, external_id)',
    ad_adsets: '(tenant_id, external_id)',
    ad_ads: '(tenant_id, external_id)',
  }[table];
};

// Extra DO UPDATE assignments so the denormalized key columns follow the row when a legacy-keyed upsert
// re-points it (e.g. the same external id arriving from another account before the key swap).
// Leading comma included; empty in legacy mode. ad_campaigns / ad_insights_daily already assign ad_account_id.
const dualWriteSet = (mode, table) => {
  if (!writesKeys(mode)) return '';
  return {
    ad_insights_daily: ', entity_key = EXCLUDED.entity_key, provider = EXCLUDED.provider',
    ad_campaigns: ', provider = EXCLUDED.provider, external_key = EXCLUDED.external_key',
    ad_adsets: ', ad_account_id = EXCLUDED.ad_account_id, provider = EXCLUDED.provider, external_key = EXCLUDED.external_key',
    ad_ads: ', ad_account_id = EXCLUDED.ad_account_id, provider = EXCLUDED.provider, external_key = EXCLUDED.external_key',
  }[table];
};

// SQL join fragments for readers. `ins` is the insights alias, `ent` the entity alias.
// Scoped mode joins on account + canonical key; every other mode on the legacy pair, unchanged.
const insightsJoinOn = (mode, ins, ent, { keyCol = 'external_key' } = {}) => (
  readsScoped(mode)
    ? `${ins}.tenant_id = ${ent}.tenant_id AND ${ins}.ad_account_id = ${ent}.ad_account_id AND ${ins}.entity_key = ${ent}.${keyCol}`
    : `${ins}.tenant_id = ${ent}.tenant_id AND ${ins}.entity_id = ${ent}.external_id`
);
const entityJoinOn = (mode, ins, ent, entityType) => `${insightsJoinOn(mode, ins, ent)} AND ${ins}.entity_type = '${entityType}'`;

// ---- structure reads (every query is a catalog read that cannot fail on a missing table) -----------
const readRollout = async (db) => {
  const reg = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [ROLLOUT_TABLE]);
  const present = !!(reg.rows[0] && reg.rows[0].present);
  if (!present) return { present: false, state: null, row: null };
  const r = await db.query(`SELECT state, updated_at, updated_by, note FROM ${ROLLOUT_TABLE} WHERE id = 1`);
  const row = r.rows[0] || null;
  return { present: true, state: row ? row.state : null, row };
};

const readColumns = async (db) => {
  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY($1)`, [TABLES]);
  return new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
};

const readUniqueIndexes = async (db) => (await db.query(
  `SELECT t.relname AS table_name, c.relname AS index_name, i.indisvalid, i.indisready,
          pg_get_expr(i.indpred, i.indrelid) AS predicate, pg_get_indexdef(i.indexrelid) AS definition
   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
   JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = current_schema() AND t.relname = ANY($1) AND i.indisunique`, [TABLES])).rows;

const readKeyConstraints = async (db) => (await db.query(
  `SELECT t.relname AS table_name, con.conname, con.convalidated
   FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = current_schema() AND con.contype = 'c' AND con.conname = ANY($1)`, [Object.keys(KEY_PRESENT_CONSTRAINTS)])).rows;

// "CREATE UNIQUE INDEX x ON public.t USING btree (a, b, c)" -> ['a','b','c']
const indexColumns = (definition) => {
  const m = /USING\s+\w+\s*\(([^)]*)\)/i.exec(str(definition));
  return m ? m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : [];
};
const sameColumns = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

// ---- pure evaluation of the structure -------------------------------------------------------------
const missingColumns = (haveCols) => REQUIRED_COLUMNS.filter(([t, c]) => !haveCols.has(`${t}.${c}`)).map(([t, c]) => `${t}.${c}`);

// Why the account-scoped structure is NOT usable. Empty array = usable.
const scopedProblems = ({ indexes = [], constraints = [] }) => {
  const out = [];
  for (const [name, spec] of Object.entries(SCOPED_INDEX_SPECS)) {
    const ix = indexes.find((i) => i.index_name === name && i.table_name === spec.table);
    if (!ix) { out.push(`index ${name} is missing`); continue; }
    if (!ix.indisvalid || !ix.indisready) out.push(`index ${name} is INVALID or not ready (failed CONCURRENTLY build): drop and rebuild it`);
    if (ix.predicate) out.push(`index ${name} is partial (WHERE ${ix.predicate}) and cannot enforce uniqueness`);
    if (!sameColumns(indexColumns(ix.definition), spec.columns)) out.push(`index ${name} does not cover (${spec.columns.join(', ')})`);
  }
  for (const [name, table] of Object.entries(KEY_PRESENT_CONSTRAINTS)) {
    const c = constraints.find((k) => k.conname === name && k.table_name === table);
    if (!c) out.push(`constraint ${name} is missing`);
    else if (!c.convalidated) out.push(`constraint ${name} is NOT VALID (never validated)`);
  }
  return out;
};

// The legacy unique keys that are missing (should be none before the key swap).
const missingLegacyKeys = (indexes) => Object.entries(LEGACY_UNIQUE)
  .filter(([table, cols]) => !indexes.some((i) => i.table_name === table && i.indisvalid && !i.predicate && sameColumns(indexColumns(i.definition), cols)))
  .map(([table, cols]) => `${table} (${cols.join(', ')})`);

// ---- mode decision --------------------------------------------------------------------------------
const decideMode = async (db) => {
  const rollout = await readRollout(db);
  if (!rollout.present || !MODES.includes(rollout.state) || rollout.state === 'legacy') return { mode: 'legacy', reasons: [] };
  const missing = missingColumns(await readColumns(db));
  if (missing.length) return { mode: 'legacy', reasons: [`rollout is '${rollout.state}' but columns are missing: ${missing.join(', ')}`] };
  if (rollout.state === 'dual_write') return { mode: 'dual_write', reasons: [] };
  const problems = scopedProblems({ indexes: await readUniqueIndexes(db), constraints: await readKeyConstraints(db) });
  return problems.length
    ? { mode: 'dual_write', reasons: [`rollout is 'scoped' but the structure is not usable: ${problems.join('; ')}`] }
    : { mode: 'scoped', reasons: [] };
};

let cache = { mode: null, at: 0 };
let lastLogged = '';
const TTL_MS = 60 * 1000;

// db: anything with .query(). Pass the pool, never a client that is inside a transaction (a failed probe
// would poison it). Any probe failure yields 'legacy', the pre-migration behaviour.
const getIdentityMode = async (db, { force = false } = {}) => {
  if (!force && cache.mode && Date.now() - cache.at < TTL_MS) return cache.mode;
  let result = { mode: 'legacy', reasons: [] };
  try { result = await decideMode(db); } catch (e) { result = { mode: 'legacy', reasons: [`probe failed: ${e.message}`] }; }
  cache = { mode: result.mode, at: Date.now() };
  const note = `${result.mode}|${result.reasons.join(';')}`;
  if (note !== lastLogged) {
    lastLogged = note;
    if (result.mode !== 'legacy' || result.reasons.length) console.warn(`[adIdentity] mode=${result.mode}${result.reasons.length ? ` (${result.reasons.join('; ')})` : ''}`);
  }
  return cache.mode;
};
const resetIdentityModeCache = () => { cache = { mode: null, at: 0 }; lastLogged = ''; };

module.exports = {
  GOOGLE, META, MODES, ROLLOUT_TABLE, TABLES, REQUIRED_COLUMNS, SCOPED_INDEXES, SCOPED_INDEX_SPECS, KEY_PRESENT_CONSTRAINTS, LEGACY_UNIQUE,
  adEntityKey, providerOf, writesKeys, readsScoped, conflictTarget, dualWriteSet, insightsJoinOn, entityJoinOn,
  readRollout, readColumns, readUniqueIndexes, readKeyConstraints, indexColumns, sameColumns,
  missingColumns, scopedProblems, missingLegacyKeys, decideMode, getIdentityMode, resetIdentityModeCache,
};
