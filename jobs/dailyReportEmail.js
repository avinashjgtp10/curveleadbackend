const { query } = require('../config/db');
const { sendEmail } = require('../utils/email');
const { ESCALATION_AFTER_MINUTES } = require('../utils/leadSla');

// Send time is per-tenant (settings.daily_report_time, "HH:MM", default "08:00"),
// interpreted in IST — the whole user base is India-based today. Revisit once
// there's a real reason to let a tenant pick their own timezone too.
const DEFAULT_REPORT_TIME = '08:00';
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const POLL_WINDOW_MINUTES = 15; // matches how often this job is polled from server.js

const todayDateStr = () => new Date().toISOString().slice(0, 10);

// True if `now` (UTC) falls inside the 15-minute window starting at the
// tenant's configured local send time. Falls back to the default time for
// anything missing/malformed rather than silently never sending.
const isWithinSendWindow = (now, timeStr) => {
  const valid = /^(\d{1,2}):(\d{2})$/.test(timeStr || '') ? timeStr : DEFAULT_REPORT_TIME;
  const [hour, minute] = valid.split(':').map(Number);
  const targetUtcMinutes = ((hour * 60 + minute) - IST_OFFSET_MINUTES + 1440) % 1440;
  const nowUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const diff = (nowUtcMinutes - targetUtcMinutes + 1440) % 1440;
  return diff < POLL_WINDOW_MINUTES;
};

// Gathers one scope's worth of digest data — either the whole tenant (assignedTo
// null, admin view) or a single staff member's own leads (assignedTo set).
const gatherDigest = async ({ tenantId, since, assignedTo }) => {
  const scope = assignedTo ? 'AND l.assigned_to = $3' : '';
  const scopeParams = assignedTo ? [tenantId, since, assignedTo] : [tenantId, since];

  const [bySource, hot, followups, slaBreaches, won] = await Promise.all([
    query(
      `SELECT source, COUNT(*) as count FROM leads l
       WHERE l.tenant_id = $1 AND l.created_at >= $2 ${scope}
       GROUP BY source ORDER BY count DESC`,
      scopeParams
    ),
    query(
      `SELECT COUNT(*) as count FROM leads l WHERE l.tenant_id = $1 AND l.lead_score = 'hot' ${assignedTo ? 'AND l.assigned_to = $2' : ''}`,
      assignedTo ? [tenantId, assignedTo] : [tenantId]
    ),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE DATE(f.next_followup_at) = CURRENT_DATE) as due_today,
         COUNT(*) FILTER (WHERE DATE(f.next_followup_at) < CURRENT_DATE) as overdue
       FROM lead_followups f
       JOIN leads l ON f.lead_id = l.id
       WHERE f.tenant_id = $1 AND f.is_completed = false AND DATE(f.next_followup_at) <= CURRENT_DATE
         ${assignedTo ? 'AND l.assigned_to = $2' : ''}`,
      assignedTo ? [tenantId, assignedTo] : [tenantId]
    ),
    query(
      `SELECT COUNT(*) as count FROM leads l
       WHERE l.tenant_id = $1 AND l.first_response_at IS NULL
         AND EXTRACT(EPOCH FROM (NOW() - l.created_at)) / 60 >= $2
         ${assignedTo ? 'AND l.assigned_to = $3' : ''}`,
      assignedTo ? [tenantId, ESCALATION_AFTER_MINUTES, assignedTo] : [tenantId, ESCALATION_AFTER_MINUTES]
    ),
    query(
      `SELECT COUNT(*) as count, COALESCE(SUM(l.deal_value), 0) as revenue FROM leads l
       WHERE l.tenant_id = $1 AND l.won_at >= $2 ${scope}`,
      scopeParams
    ),
  ]);

  return {
    newLeadsBySource: bySource.rows,
    newLeadsTotal: bySource.rows.reduce((sum, r) => sum + parseInt(r.count), 0),
    hotLeads: parseInt(hot.rows[0]?.count || 0),
    followupsDueToday: parseInt(followups.rows[0]?.due_today || 0),
    followupsOverdue: parseInt(followups.rows[0]?.overdue || 0),
    slaBreaches: parseInt(slaBreaches.rows[0]?.count || 0),
    wonCount: parseInt(won.rows[0]?.count || 0),
    wonRevenue: parseFloat(won.rows[0]?.revenue || 0),
  };
};

const gatherCampaignSnapshot = async (tenantId) => {
  const result = await query(
    `SELECT c.name, c.actual_spend,
            COUNT(l.id) as total_leads
     FROM campaigns c
     LEFT JOIN leads l ON l.campaign_id = c.id
     WHERE c.tenant_id = $1 AND c.status = 'active'
     GROUP BY c.id
     ORDER BY c.actual_spend DESC NULLS LAST
     LIMIT 5`,
    [tenantId]
  );
  return result.rows.map(r => ({
    name: r.name,
    spend: parseFloat(r.actual_spend || 0),
    leads: parseInt(r.total_leads),
    cpl: r.total_leads > 0 ? (parseFloat(r.actual_spend || 0) / r.total_leads).toFixed(2) : null,
  }));
};

const row = (label, value) => `
  <tr>
    <td style="padding:6px 0;color:#666;font-size:13px;">${label}</td>
    <td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px;">${value}</td>
  </tr>`;

const buildHtml = ({ tenantName, personName, digest, campaigns, dateLabel }) => `
  <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 20px;">
    <h2 style="margin-bottom:2px;">Daily Report — ${tenantName}</h2>
    <p style="color:#999;font-size:13px;margin-top:0;">${dateLabel}${personName ? ` · ${personName}'s leads` : ' · Business overview'}</p>

    <table style="width:100%;border-collapse:collapse;margin-top:12px;">
      ${row('New leads (last 24h)', digest.newLeadsTotal)}
      ${digest.newLeadsBySource.map(s => row(`&nbsp;&nbsp;— ${(s.source || 'unknown').replace(/_/g, ' ')}`, s.count)).join('')}
      ${row('Hot leads right now', digest.hotLeads)}
      ${row('Follow-ups due today', digest.followupsDueToday)}
      ${row('Follow-ups overdue', digest.followupsOverdue)}
      ${row('SLA breaches (no response yet)', digest.slaBreaches)}
      ${row('Deals won (last 24h)', digest.wonCount)}
      ${row('Revenue won (last 24h)', `₹${digest.wonRevenue.toLocaleString('en-IN')}`)}
    </table>

    ${campaigns?.length ? `
      <h3 style="margin-top:20px;margin-bottom:8px;font-size:14px;">Active campaigns</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="font-size:11px;color:#999;text-transform:uppercase;">
          <td style="padding:4px 0;">Campaign</td>
          <td style="padding:4px 0;text-align:right;">Spend</td>
          <td style="padding:4px 0;text-align:right;">Leads</td>
          <td style="padding:4px 0;text-align:right;">CPL</td>
        </tr>
        ${campaigns.map(c => `
          <tr style="border-top:1px solid #eee;">
            <td style="padding:6px 0;font-size:13px;">${c.name}</td>
            <td style="padding:6px 0;text-align:right;font-size:13px;">₹${c.spend.toLocaleString('en-IN')}</td>
            <td style="padding:6px 0;text-align:right;font-size:13px;">${c.leads}</td>
            <td style="padding:6px 0;text-align:right;font-size:13px;">${c.cpl != null ? `₹${c.cpl}` : '—'}</td>
          </tr>`).join('')}
      </table>
    ` : ''}

    <p style="color:#999;font-size:13px;margin-top:24px;">Log in to CurveLead for the full picture.</p>
  </div>
`;

const sendDigestEmail = async ({ to, tenantName, personName, digest, campaigns, dateLabel }) => {
  if (!to) return;
  return sendEmail({
    to,
    fromName: tenantName,
    subject: `Daily Report — ${tenantName}${personName ? ` (${personName})` : ''} — ${dateLabel}`,
    html: buildHtml({ tenantName, personName, digest, campaigns, dateLabel }),
    text: `Daily Report — ${tenantName}\nNew leads: ${digest.newLeadsTotal}\nHot leads: ${digest.hotLeads}\nFollow-ups due today: ${digest.followupsDueToday}\nOverdue: ${digest.followupsOverdue}\nSLA breaches: ${digest.slaBreaches}\nDeals won: ${digest.wonCount} (₹${digest.wonRevenue})`,
  });
};

const runDailyReportEmail = async () => {
  const now = new Date();
  const today = todayDateStr();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateLabel = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  try {
    const tenants = await query(
      `SELECT id, name, email, settings FROM tenants
       WHERE COALESCE(settings->>'daily_report_enabled', 'false') = 'true'
         AND COALESCE(settings->>'daily_report_last_sent', '') != $1`,
      [today]
    );

    for (const tenant of tenants.rows) {
      if (!isWithinSendWindow(now, tenant.settings?.daily_report_time)) continue;
      try {
        const [adminDigest, campaigns, staff] = await Promise.all([
          gatherDigest({ tenantId: tenant.id, since, assignedTo: null }),
          gatherCampaignSnapshot(tenant.id),
          query(`SELECT id, name, email FROM users WHERE tenant_id = $1 AND role = 'staff' AND is_active = true`, [tenant.id]),
        ]);

        await sendDigestEmail({ to: tenant.email, tenantName: tenant.name, personName: null, digest: adminDigest, campaigns, dateLabel });

        for (const member of staff.rows) {
          const staffDigest = await gatherDigest({ tenantId: tenant.id, since, assignedTo: member.id });
          await sendDigestEmail({ to: member.email, tenantName: tenant.name, personName: member.name, digest: staffDigest, campaigns: null, dateLabel });
        }

        await query(
          `UPDATE tenants SET settings = settings || $1 WHERE id = $2`,
          [JSON.stringify({ daily_report_last_sent: today }), tenant.id]
        );
        console.log(`✅ Daily report sent for tenant ${tenant.id}`);
      } catch (e) {
        console.error(`Daily report failed for tenant ${tenant.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Daily report job error:', e.message);
  }
};

module.exports = { runDailyReportEmail };
