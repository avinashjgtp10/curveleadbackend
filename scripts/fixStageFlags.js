// Batch 1 (A): find stages wrongly flagged "won" (every converted / revenue / cost-per-customer
// number depends on lead_stages.is_won).
//
//   node scripts/fixStageFlags.js                    dry run across ALL workspaces
//   node scripts/fixStageFlags.js --apply            clear is_won on the AUTO-fix stages only
//   node scripts/fixStageFlags.js --apply --stage <id> [--stage <id> …]
//                                                    also clear is_won on these reviewed stages
//
// AUTO   the first pipeline stage flagged won (new leads would all count as customers),
//        or a stage flagged both won and lost.
// REVIEW other won stages that look like a misunderstanding: an early-funnel name, or a Meta
//        conversion event such as "Lead" set on it (people ticked Won meaning "send to Meta").
//        Never changed unless listed with --stage.
require('dotenv').config();
const { query, pool } = require('../config/db');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const reviewed = args.flatMap((a, i) => (a === '--stage' ? [args[i + 1]] : [])).filter(Boolean);

const EARLY = /\b(new|fresh|contacted|enquir|inquir|interested|qualified|follow|callback|prospect|lead)\b/i;
const EARLY_EVENTS = ['Lead', 'Contact', 'Schedule', 'SubmitApplication', 'Subscribe'];

// Pure: classify one workspace's stages. stages: [{ id, name, pos, is_won, is_lost, is_active, meta_event_name }]
const classifyStages = (stages) => {
  const active = stages.filter(s => s.is_active !== false);
  const firstPos = Math.min(...active.map(s => Number(s.pos)));
  return stages.filter(s => s.is_won).map(s => {
    if (s.is_lost) return { ...s, action: 'auto', reason: 'flagged both won and lost' };
    if (Number(s.pos) === firstPos) return { ...s, action: 'auto', reason: 'first pipeline stage — every new lead would count as a customer' };
    if (EARLY.test(s.name) && !/\b(won|convert|enrol|paid|closed|customer|booked)\b/i.test(s.name)) return { ...s, action: 'review', reason: 'early-funnel stage name' };
    if (EARLY_EVENTS.includes(s.meta_event_name)) return { ...s, action: 'review', reason: `Meta event "${s.meta_event_name}" set — Won may have been ticked to send it to Meta` };
    return null;
  }).filter(Boolean);
};

async function run() {
  const rows = (await query(
    `SELECT t.id AS tenant_id, t.name AS tenant, s.id, s.name, COALESCE(s.pos, s.position) AS pos, s.is_won, s.is_lost, s.is_active, s.meta_event_name,
            (SELECT count(*)::int FROM leads l WHERE l.tenant_id = s.tenant_id AND lower(trim(l.stage)) = lower(trim(s.name))) AS leads_in_stage
     FROM lead_stages s JOIN tenants t ON t.id = s.tenant_id ORDER BY t.name, pos`)).rows;
  const byTenant = new Map();
  for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) || []), r]);

  const toClear = [];
  for (const stages of byTenant.values()) {
    for (const f of classifyStages(stages)) {
      const clear = f.action === 'auto' || reviewed.includes(f.id);
      console.log(`${f.action.toUpperCase().padEnd(6)} ${f.tenant} · "${f.name}" (pos ${f.pos}, ${f.leads_in_stage} leads now) — ${f.reason}${clear ? (apply ? ' → is_won cleared' : ' → would clear') : ''}  [--stage ${f.id}]`);
      if (clear) toClear.push(f);
    }
  }
  if (apply && toClear.length) {
    await query('UPDATE lead_stages SET is_won = false WHERE id = ANY($1::uuid[])', [toClear.map(f => f.id)]);
  }
  console.log(`\n${apply ? 'Cleared' : 'Would clear'} is_won on ${toClear.length} stage(s). ${apply ? '' : 'Run with --apply (and --stage <id> for reviewed ones).'}`);
}

if (require.main === module) run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { classifyStages };
