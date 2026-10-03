// Merging duplicate leads (Batch 1 B). Used by scripts/mergeDuplicateLeads.js and the
// manual "merge duplicates" action. Rules:
//  * keep the OLDEST lead (its id survives); the others are soft-deleted
//    (merged_into_id / merged_at) — never hard-deleted;
//  * stage: the most recently changed one, except that a Won/Lost lead is never moved
//    back to an earlier stage (a terminal stage beats a non-terminal one);
//  * owner: the user behind the most recent human activity on any of the leads;
//  * attribution: first touch (the kept lead's) is kept; the others are logged;
//  * blanks on the kept lead are filled from the newest duplicate that has a value;
//  * every related row moves to the kept lead; rows that can't (unique conflicts) stay
//    on the merged lead and are recorded; an active automation left behind is cancelled.

const FILL_COLUMNS = [
  'city', 'email', 'location', 'business_name', 'address', 'lead_status', 'intent_score', 'suggested_action',
  'won_lost_reason', 'lost_reason', 'expected_close_date', 'score_reason', 'course_interest_id',
];
// First-touch attribution — kept from the oldest lead, never overwritten, logged for the rest.
const ATTRIBUTION_COLUMNS = [
  'source', 'source_detail', 'campaign_id', 'meta_lead_id', 'meta_ad_id', 'meta_adset_id', 'meta_form_id',
  'google_lead_id', 'google_campaign_id', 'google_adgroup_id', 'google_creative_id', 'gclid', 'created_at',
];
const STAGE_COLUMNS = ['stage', 'won_at', 'lost_reason', 'won_lost_reason'];

const time = (v) => (v ? new Date(v).getTime() : 0);
const blank = (v) => v === null || v === undefined || v === '' || (typeof v === 'string' && /^unknown$/i.test(v.trim()));

/**
 * Pure: decides what the kept lead looks like after merging.
 * @param leads rows of one duplicate group (any order)
 * @param ctx { stageFlags: Map(lowerStageName → { is_won, is_lost }),
 *              lastStageChange: Map(leadId → Date), lastHuman: Map(leadId → { at, userId }) }
 */
const planMerge = (leads, { stageFlags = new Map(), lastStageChange = new Map(), lastHuman = new Map() } = {}) => {
  const ordered = [...leads].sort((a, b) => time(a.created_at) - time(b.created_at) || String(a.id).localeCompare(String(b.id)));
  const [keep, ...merged] = ordered;
  const newestFirst = [...merged].sort((a, b) => time(b.updated_at || b.created_at) - time(a.updated_at || a.created_at));
  const patch = {};

  // Blanks on the kept lead, from the newest duplicate that has a value.
  for (const col of FILL_COLUMNS) {
    if (!blank(keep[col])) continue;
    const from = newestFirst.find(l => !blank(l[col]));
    if (from) patch[col] = from[col];
  }
  if (blank(keep.name)) { const from = newestFirst.find(l => !blank(l.name)); if (from) patch.name = from.name; }
  const maxOf = (col) => Math.max(...ordered.map(l => Number(l[col]) || 0));
  if (maxOf('deal_value') > (Number(keep.deal_value) || 0)) patch.deal_value = maxOf('deal_value');
  if (maxOf('advance_received') > (Number(keep.advance_received) || 0)) patch.advance_received = maxOf('advance_received');
  const notes = ordered.map(l => (l.notes || '').trim()).filter(Boolean);
  if (new Set(notes).size > 1) patch.notes = [...new Set(notes)].join('\n');
  const tags = [...new Set(ordered.flatMap(l => l.tags || []))];
  if (tags.length > (keep.tags || []).length) patch.tags = tags;
  const custom = Object.assign({}, ...newestFirst.slice().reverse().map(l => l.custom_fields || {}), keep.custom_fields || {});
  if (Object.keys(custom).length > Object.keys(keep.custom_fields || {}).length) patch.custom_fields = custom;

  // Stage: terminal (won/lost) beats non-terminal; otherwise the most recent change wins.
  const flags = (l) => stageFlags.get(String(l.stage || '').trim().toLowerCase()) || {};
  const changedAt = (l) => time(lastStageChange.get(l.id)) || time(l.updated_at) || time(l.created_at);
  const terminal = ordered.filter(l => flags(l).is_won || flags(l).is_lost);
  const stageFrom = (terminal.length ? terminal : ordered).reduce((best, l) => (changedAt(l) > changedAt(best) ? l : best));
  if (stageFrom.id !== keep.id) for (const col of STAGE_COLUMNS) if (stageFrom[col] !== undefined && stageFrom[col] !== keep[col]) patch[col] = stageFrom[col];

  // Owner: whoever did the most recent human activity on any of them.
  const human = ordered.map(l => lastHuman.get(l.id)).filter(h => h?.userId).sort((a, b) => time(b.at) - time(a.at))[0];
  if (human && human.userId !== keep.assigned_to) patch.assigned_to = human.userId;

  const fieldChanges = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { from: keep[k] ?? null, to: v }]));
  const otherTouches = merged.map(l => Object.fromEntries([['lead_id', l.id], ...ATTRIBUTION_COLUMNS.filter(c => !blank(l[c])).map(c => [c, l[c]])]));
  return { keepId: keep.id, mergedIds: merged.map(l => l.id), patch, fieldChanges, otherTouches, stageFromId: stageFrom.id };
};

// Context for planMerge, read in one go for a group.
const loadContext = async (db, tenantId, ids) => {
  const [stages, history, human] = await Promise.all([
    db.query('SELECT lower(trim(name)) AS name, bool_or(COALESCE(is_won,false)) AS is_won, bool_or(COALESCE(is_lost,false)) AS is_lost FROM lead_stages WHERE tenant_id = $1 GROUP BY 1', [tenantId]),
    db.query('SELECT lead_id, max(changed_at) AS at FROM lead_stage_history WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[]) GROUP BY lead_id', [tenantId, ids]),
    db.query(
      `SELECT DISTINCT ON (lead_id) lead_id, at, user_id FROM (
         SELECT a.lead_id, a.created_at AS at, a.created_by AS user_id FROM lead_activities a WHERE a.tenant_id = $1 AND a.lead_id = ANY($2::uuid[]) AND a.created_by IS NOT NULL
         UNION ALL SELECT m.lead_id, m.sent_at, m.sent_by FROM whatsapp_messages m WHERE m.tenant_id = $1 AND m.lead_id = ANY($2::uuid[]) AND m.sent_by IS NOT NULL
         UNION ALL SELECT f.lead_id, f.created_at, f.created_by FROM lead_followups f WHERE f.tenant_id = $1 AND f.lead_id = ANY($2::uuid[]) AND f.created_by IS NOT NULL
       ) x JOIN users u ON u.id = x.user_id AND u.tenant_id = $1 AND u.is_active
       ORDER BY lead_id, at DESC`, [tenantId, ids]),
  ]);
  return {
    stageFlags: new Map(stages.rows.map(r => [r.name, r])),
    lastStageChange: new Map(history.rows.map(r => [r.lead_id, r.at])),
    lastHuman: new Map(human.rows.map(r => [r.lead_id, { at: r.at, userId: r.user_id }])),
  };
};

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Tables with a lead foreign key (except the merge bookkeeping itself).
const childTables = async (db) => (await db.query(
  `SELECT DISTINCT ns.nspname AS schema, cl.relname AS table_name, a.attname AS column_name
   FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.confrelid = 'leads'::regclass AND array_length(c.conkey, 1) = 1
     AND cl.relname NOT IN ('leads', 'lead_merges')
   ORDER BY 2`
)).rows;

// Moves one table's rows to the kept lead. Bulk first; on a unique conflict, row by row,
// leaving conflicting rows on the merged lead.
const moveRows = async (client, child, keepId, mergedIds) => {
  const t = `${quote(child.schema)}.${quote(child.table_name)}`, col = quote(child.column_name);
  await client.query('SAVEPOINT move_bulk');
  try {
    const r = await client.query(`UPDATE ${t} SET ${col} = $1 WHERE ${col} = ANY($2::uuid[])`, [keepId, mergedIds]);
    await client.query('RELEASE SAVEPOINT move_bulk');
    return { moved: r.rowCount, left: [] };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT move_bulk');
    if (e.code !== '23505') throw e;
  }
  const rows = (await client.query(`SELECT ctid::text AS ctid, row_to_json(x) AS row FROM ${t} x WHERE ${col} = ANY($1::uuid[])`, [mergedIds])).rows;
  let moved = 0; const left = [];
  for (const r of rows) {
    await client.query('SAVEPOINT move_row');
    try { await client.query(`UPDATE ${t} SET ${col} = $1 WHERE ctid = $2::tid`, [keepId, r.ctid]); await client.query('RELEASE SAVEPOINT move_row'); moved++; }
    catch (e) { await client.query('ROLLBACK TO SAVEPOINT move_row'); if (e.code !== '23505') throw e; left.push(r.row); }
  }
  return { moved, left };
};

/**
 * Applies one merge inside the caller's transaction. Returns a summary.
 * @param leads full rows of the group (locked FOR UPDATE by the caller)
 */
const applyMerge = async (client, { tenantId, leads, reason, userId = null, ctx }) => {
  const plan = planMerge(leads, ctx || await loadContext(client, tenantId, leads.map(l => l.id)));
  const byId = new Map(leads.map(l => [l.id, l]));
  const keep = byId.get(plan.keepId);
  const moved = {}, leftBehind = {};
  for (const child of await childTables(client)) {
    const r = await moveRows(client, child, plan.keepId, plan.mergedIds);
    if (r.moved) moved[child.table_name] = r.moved;
    if (r.left.length) leftBehind[child.table_name] = r.left;
  }
  // An enrollment that couldn't move (already enrolled in that sequence) must not keep messaging.
  if (leftBehind.automation_enrollments) {
    await client.query(`UPDATE automation_enrollments SET status = 'cancelled' WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[]) AND status = 'active'`, [tenantId, plan.mergedIds]);
  }

  const cols = Object.keys(plan.patch);
  if (cols.length) {
    await client.query(
      `UPDATE leads SET ${cols.map((c, i) => `${quote(c)} = $${i + 3}`).join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, plan.keepId, ...cols.map(c => (c === 'custom_fields' ? JSON.stringify(plan.patch[c]) : plan.patch[c]))]
    );
  }
  await client.query('UPDATE leads SET merged_into_id = $3, merged_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, plan.mergedIds, plan.keepId]);

  for (const mergedId of plan.mergedIds) {
    await client.query(
      `INSERT INTO lead_merges (tenant_id, kept_lead_id, merged_lead_id, kept_before, merged_before, field_changes, moved, left_behind, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, plan.keepId, mergedId, JSON.stringify(keep), JSON.stringify(byId.get(mergedId)),
        JSON.stringify({ ...plan.fieldChanges, other_touches: plan.otherTouches }), JSON.stringify(moved), JSON.stringify(leftBehind), reason, userId]
    );
  }
  await client.query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, metadata, created_by)
     VALUES ($1, $2, 'merge', $3, $4, $5, $6)`,
    [tenantId, plan.keepId, `Merged ${plan.mergedIds.length} duplicate lead${plan.mergedIds.length > 1 ? 's' : ''}`,
      plan.otherTouches.map(t => [t.source, t.source_detail].filter(Boolean).join(' — ')).filter(Boolean).join('; ') || null,
      JSON.stringify({ merged_lead_ids: plan.mergedIds, field_changes: plan.fieldChanges, other_touches: plan.otherTouches, moved, left_behind: Object.keys(leftBehind) }), userId]
  );
  return { ...plan, moved, leftBehind };
};

module.exports = { FILL_COLUMNS, ATTRIBUTION_COLUMNS, planMerge, loadContext, applyMerge, childTables };
