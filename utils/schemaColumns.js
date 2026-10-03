const { query } = require('../config/db');

// Which of `columns` exist on `table` — lets code ship before its migration is run.
// Cached for 5 minutes.
const cache = new Map();
const presentColumns = async (table, columns, db = { query }) => {
  const key = `${table}:${[...columns].sort().join(',')}`;
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - 5 * 60 * 1000) return hit.cols;
  const cols = new Set((await db.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = ANY($2::text[])',
    [table, columns])).rows.map(r => r.column_name));
  cache.set(key, { at: Date.now(), cols });
  return cols;
};

module.exports = { presentColumns };
