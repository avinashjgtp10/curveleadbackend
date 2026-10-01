const { normalizePhone, normalizeSource, repairMojibake } = require('../utils/dataQuality');
const { mapMetaFields } = require('../utils/metaFieldData');
function repairLead(row) {
  const patch = { source: normalizeSource(row.source), name: repairMojibake(row.name), notes: repairMojibake(row.notes) };
  let invalidPhone = false;
  try { patch.phone = normalizePhone(row.phone); } catch { invalidPhone = true; }
  if (patch.source === 'meta_ads' && row.notes?.includes('Meta Lead Form Submission:')) {
    const fields = row.notes.split('Meta Lead Form Submission:')[1].trim().split('\n\n')[0].split('\n').flatMap(line => {
      const split = line.indexOf(':'); return split < 0 ? [] : [{ name: line.slice(0,split).trim(), values: [line.slice(split+1).trim()] }];
    });
    const mapped = mapMetaFields(fields);
    for (const key of ['business_name','city','location']) if (!row[key] && mapped[key]) patch[key] = mapped[key];
    patch.custom_fields = { ...mapped.custom_fields, ...(row.custom_fields || {}) };
  }
  for (const key of Object.keys(patch)) if (JSON.stringify(patch[key]) === JSON.stringify(row[key])) delete patch[key];
  return { patch, invalidPhone };
}
async function run(db, apply = false) {
  let cursor = '00000000-0000-0000-0000-000000000000', changed = 0, invalid = 0;
  while (true) {
    const rows = await db.query('SELECT * FROM leads WHERE id > $1 ORDER BY id LIMIT 250', [cursor]);
    if (!rows.rows.length) break;
    for (const row of rows.rows) {
      const { patch, invalidPhone } = repairLead(row);
      if (invalidPhone) { invalid++; console.log(JSON.stringify({ invalid_phone_lead_id: row.id })); }
      if (Object.keys(patch).length) {
        changed++;
        console.log(JSON.stringify({ lead_id: row.id, fields: Object.keys(patch), apply }));
        if (apply) {
          // Compare-and-swap avoids overwriting records edited since the batch was read.
          const entries = Object.entries(patch);
          await db.query(`UPDATE leads SET ${entries.map(([key],i) => `${key}=$${i+3}`).join(',')}, updated_at=now() WHERE id=$1 AND updated_at IS NOT DISTINCT FROM $2`, [row.id,row.updated_at,...entries.map(([key,v]) => key === 'custom_fields' ? JSON.stringify(v) : v)]);
        }
      }
    }
    cursor = rows.rows.at(-1).id;
  }
  let campaignCursor = '00000000-0000-0000-0000-000000000000';
  while (true) {
    const result = await db.query('SELECT id,source FROM campaigns WHERE id > $1 ORDER BY id LIMIT 250', [campaignCursor]);
    if (!result.rows.length) break;
    for (const row of result.rows) {
      const source = normalizeSource(row.source);
      if (source !== row.source) {
        console.log(JSON.stringify({ campaign_id: row.id, fields: ['source'], apply }));
        if (apply) await db.query('UPDATE campaigns SET source=$2 WHERE id=$1 AND source IS NOT DISTINCT FROM $3', [row.id, source, row.source]);
      }
    }
    campaignCursor = result.rows.at(-1).id;
  }
  console.log(JSON.stringify({ changed, invalid, apply }));
  return { changed, invalid };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--dry-run','--apply'].includes(args[0])) { console.error('Usage: node scripts/backfillDataQuality.js --dry-run|--apply'); process.exitCode=1; }
  else {
    const db = require('../config/db');
    run(db, args[0] === '--apply').catch(e => { console.error(e.message); process.exitCode=1; }).finally(() => db.pool.end());
  }
}
module.exports = { repairLead, run };
