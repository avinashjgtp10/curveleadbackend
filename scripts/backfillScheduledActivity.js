// Only use for records created while the legacy server process ran in UTC.
// node scripts/backfillScheduledActivity.js --source-timezone=UTC --dry-run
// node scripts/backfillScheduledActivity.js --source-timezone=UTC --apply
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function parseLegacySchedule(description) {
  const match = /^Scheduled for (\d{1,2}) ([A-Za-z]{3}) (\d{4}), (\d{1,2}):(\d{2})\s*(am|pm)(?: · Link: (.*))?$/i.exec(description || '');
  if (!match) return null;
  const [, day, month, year, hour, minute, period, meetingUrl] = match;
  const m = MONTHS.findIndex(value => value.toLowerCase() === month.toLowerCase());
  if (m < 0 || +hour < 1 || +hour > 12 || +minute > 59) return null;
  const date = new Date(Date.UTC(+year, m, +day, +hour % 12 + (period.toLowerCase() === 'pm' ? 12 : 0), +minute));
  if (date.getUTCDate() !== +day || date.getUTCMonth() !== m) return null;
  return { scheduled_at: date.toISOString(), meeting_url: meetingUrl || null };
}
async function main() {
  if (!process.argv.includes('--source-timezone=UTC') || (!process.argv.includes('--dry-run') && !process.argv.includes('--apply'))) {
    throw new Error('Specify --source-timezone=UTC and --dry-run or --apply. Verify the historical server timezone first.');
  }
  const db = require('../config/db');
  const dryRun = process.argv.includes('--dry-run');
  try {
    let eligible = 0, skipped = 0, cursor = '00000000-0000-0000-0000-000000000000';
    while (true) {
      const result = await db.query(`SELECT id, description FROM lead_activities
        WHERE activity_type IN ('followup_scheduled', 'demo_scheduled')
          AND NOT (COALESCE(metadata, '{}') ? 'scheduled_at') AND id > $1
        ORDER BY id LIMIT 500`, [cursor]);
      if (!result.rows.length) break;
      for (const row of result.rows) {
        cursor = row.id;
        const metadata = parseLegacySchedule(row.description);
        if (!metadata) { skipped++; continue; }
        eligible++;
        if (!dryRun) await db.query(`UPDATE lead_activities SET metadata = COALESCE(metadata, '{}') || $2::jsonb
          WHERE id = $1 AND NOT (COALESCE(metadata, '{}') ? 'scheduled_at')`, [row.id, JSON.stringify(metadata)]);
      }
    }
    console.log(JSON.stringify({ dryRun, eligible, skipped }));
  } finally { await db.pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseLegacySchedule };
