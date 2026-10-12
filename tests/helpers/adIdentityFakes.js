// Test doubles for the ad identity work. No database is involved: everything here is in memory.
// They model the CONTROL FLOW (modes, transitions, batching, rollback of a failed batch); SQL semantics against a
// real PostgreSQL are covered by tests/adIdentitySql.test.js, which is skipped without ADS_TEST_DATABASE_URL.
const ai = require('../../services/adIdentity');

const idxDef = (name, table, cols) => `CREATE UNIQUE INDEX ${name} ON public.${table} USING btree (${cols.join(', ')})`;
const index = (name, table, cols, over = {}) => ({ table_name: table, index_name: name, indisvalid: true, indisready: true, predicate: null, definition: idxDef(name, table, cols), ...over });

const legacyIndexes = () => Object.entries(ai.LEGACY_UNIQUE).map(([table, cols]) => index(`${table}_legacy_uq`, table, cols));
const scopedIndexes = () => Object.entries(ai.SCOPED_INDEX_SPECS).map(([name, s]) => index(name, s.table, s.columns));
const keyConstraints = (over = {}) => Object.entries(ai.KEY_PRESENT_CONSTRAINTS).map(([conname, table_name]) => ({ conname, table_name, convalidated: true, ...over }));
const allColumns = () => ai.REQUIRED_COLUMNS.map(([t, c]) => `${t}.${c}`);

// Catalog + rollout probes. Returns undefined for anything that is not a probe.
const structureDb = (spec = {}) => {
  const s = { rolloutPresent: true, state: 'legacy', columns: allColumns(), indexes: legacyIndexes(), constraints: [], ageSeconds: 3600, fail: false, ...spec };
  const answer = (sql) => {
    if (/to_regclass/.test(sql)) return { rows: [{ present: s.rolloutPresent }] };
    if (/extract\(epoch/.test(sql)) return { rows: [{ s: s.ageSeconds }] };
    if (/FROM ad_identity_rollout/.test(sql)) return { rows: s.state ? [{ state: s.state, updated_at: new Date(), updated_by: null, note: null }] : [] };
    if (/information_schema\.columns/.test(sql)) return { rows: s.columns.map((c) => { const [table_name, column_name] = c.split('.'); return { table_name, column_name }; }) };
    if (/FROM pg_index/.test(sql)) return { rows: s.indexes };
    if (/FROM pg_constraint/.test(sql)) return { rows: s.constraints };
    return undefined;
  };
  return { spec: s, answer, query: async (sql) => { if (s.fail) throw new Error('boom'); return answer(sql) || { rows: [] }; } };
};

// What the database looks like in each application mode.
const MODE_SPECS = {
  legacy: () => ({ rolloutPresent: false, state: null, columns: [], indexes: [], constraints: [] }),
  dual_write: () => ({ state: 'dual_write' }),
  scoped: () => ({ state: 'scoped', indexes: [...legacyIndexes(), ...scopedIndexes()], constraints: keyConstraints() }),
};

// A db for the writers/readers: answers the mode probe from `mode`, logs everything else, and remembers
// whether a probe ever went through the TRANSACTION client (it must not).
const modeDb = (mode) => {
  const st = structureDb(MODE_SPECS[mode]());
  const log = []; const probesInTxn = [];
  const run = (via) => async (sql, params) => {
    const probe = st.answer(sql);
    if (probe) { if (via === 'client') probesInTxn.push(sql); return probe; }
    log.push({ sql, params, via });
    if (/RETURNING id/.test(sql)) return { rows: [{ id: `row-${log.length}`, campaign_id: 'crm-1' }] };
    return { rows: [] };
  };
  const client = { query: run('client') };
  return { log, probesInTxn, query: run('pool'), transaction: async (fn) => fn(client) };
};

// ---- in-memory tables for the backfill ----------------------------------------------------------------
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
const KEY = { ad_campaigns: (r) => [r.id], ad_adsets: (r) => [r.id], ad_ads: (r) => [r.id], ad_insights_daily: (r) => [r.tenant_id, r.entity_type, r.entity_id, r.date_s] };
const PENDING = {
  ad_campaigns: (r) => r.external_key == null || r.provider == null,
  ad_adsets: (r) => r.external_key == null || r.provider == null || r.ad_account_id == null,
  ad_ads: (r) => r.external_key == null || r.provider == null || r.ad_account_id == null,
  ad_insights_daily: (r) => r.entity_key == null || r.provider == null || (r.currency == null && r.account_currency != null),
};
// Row fields the fake stores are exactly the aliases the backfill SELECT returns (the joins are pre-resolved).
const backfillDb = ({ campaigns = [], adsets = [], ads = [], insights = [], state = 'dual_write', failUpdateAt = null } = {}) => {
  const tables = { ad_campaigns: campaigns, ad_adsets: adsets, ad_ads: ads, ad_insights_daily: insights };
  const log = []; let snapshot = null; let updateCalls = 0;
  const db = {
    tables, log,
    setFailUpdateAt(n) { failUpdateAt = n; },
    updateCalls: () => updateCalls,
    query: async (sql, params = []) => {
      log.push(sql.trim().split('\n')[0].slice(0, 60));
      if (sql === 'BEGIN') { snapshot = JSON.stringify(tables); return { rows: [] }; }
      if (sql === 'COMMIT') { snapshot = null; return { rows: [] }; }
      if (sql === 'ROLLBACK') { if (snapshot) { const s = JSON.parse(snapshot); for (const k of Object.keys(tables)) tables[k].splice(0, tables[k].length, ...s[k]); } snapshot = null; return { rows: [] }; }
      if (/^SET LOCAL/.test(sql)) return { rows: [] };
      if (/to_regclass/.test(sql)) return { rows: [{ present: state != null }] };
      if (/FROM ad_identity_rollout/.test(sql)) return { rows: state ? [{ state }] : [] };
      let m = /^\s*SELECT [\s\S]*? FROM (ad_\w+) x/.exec(sql);
      if (m) {
        const name = m[1]; const limit = params[params.length - 1]; const cursor = params.slice(0, -1);
        let rows = tables[name].filter(PENDING[name]);
        if (cursor.length) rows = rows.filter((r) => cmp(KEY[name](r), cursor) > 0);
        rows.sort((a, b) => cmp(KEY[name](a), KEY[name](b)));
        return { rows: rows.slice(0, limit).map((r) => ({ ...r })) };
      }
      m = /^\s*UPDATE (ad_\w+) x SET/.exec(sql);
      if (m) {
        const name = m[1]; updateCalls++;
        if (snapshot === null) throw new Error('UPDATE outside a transaction');
        let changed = 0;
        const rows = tables[name];
        const apply = (row, set) => { let c = false; for (const [k, v] of Object.entries(set)) if (row[k] == null && v != null) { row[k] = v; c = true; } if (c) changed++; };
        if (name === 'ad_insights_daily') {
          const [t, et, eid, d, k, p, c] = params;
          t.forEach((_, i) => { const row = rows.find((r) => r.tenant_id === t[i] && r.entity_type === et[i] && r.entity_id === eid[i] && r.date_s === d[i]); if (row) apply(row, { entity_key: k[i], provider: p[i], currency: c[i] }); });
        } else {
          const [ids, k, p, a] = params;
          ids.forEach((id, i) => { const row = rows.find((r) => r.id === id); if (row) apply(row, { external_key: k[i], provider: p[i], ...(a ? { ad_account_id: a[i] } : {}) }); });
        }
        if (failUpdateAt === updateCalls) throw new Error('connection lost'); // after the rows changed in memory: the ROLLBACK must undo them
        return { rowCount: changed, rows: [] };
      }
      throw new Error(`unexpected SQL in fake: ${sql.slice(0, 80)}`);
    },
  };
  return db;
};

module.exports = { structureDb, modeDb, backfillDb, legacyIndexes, scopedIndexes, keyConstraints, allColumns, index, MODE_SPECS, PENDING };
