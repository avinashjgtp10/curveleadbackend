const crypto = require('crypto');
const { query } = require('../config/db');
const { nextLeadNumber } = require('../utils/leadNumber');
const { checkNewLeadTriggers } = require('../utils/automationTriggers');
const { applyAssignmentRules } = require('../utils/leadAssignment');
const { notifyNewLead } = require('../utils/leadNotifyEmail');
const { notifyNewLeadToAdmins } = require('./notificationController');

// POST /api/webhook/google — Google Ads Lead Form Extension webhook
const receiveGoogleLead = async (req, res) => {
  res.sendStatus(200);

  try {
    const { google_key, user_column_data = [], lead_id, campaign_id: gCampaignId, adgroup_id, creative_id } = req.body;

    if (!google_key) { console.warn('Google webhook: missing google_key'); return; }

    // Find tenant by google_webhook_secret
    const tenantResult = await query(
      `SELECT id FROM tenants WHERE settings->>'google_webhook_secret' = $1 AND subscription_status IN ('trial','active') LIMIT 1`,
      [google_key]
    );
    if (!tenantResult.rows.length) { console.warn('Google webhook: no tenant for key'); return; }
    const tenantId = tenantResult.rows[0].id;

    // Parse column data array: [{ column_name, string_value }]
    const fields = {};
    user_column_data.forEach(col => { fields[col.column_name] = col.string_value; });

    const name = fields['Full Name'] || fields['FULL_NAME'] || fields['name'] || 'Unknown';
    const phone = fields['Phone Number'] || fields['PHONE_NUMBER'] || fields['phone'] || '';
    const email = fields['Email'] || fields['EMAIL'] || fields['email'] || '';

    if (!phone) { console.warn('Google webhook: no phone'); return; }

    const existing = await query('SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, phone]);
    if (existing.rows.length) { console.log(`Google webhook: duplicate phone ${phone}`); return; }

    const leadNumber = await nextLeadNumber(tenantId);
    const inserted = await query(
      `INSERT INTO leads (tenant_id, lead_number, name, phone, email, source, source_detail, stage)
       VALUES ($1,$2,$3,$4,$5,'google_ads',$6,'new') RETURNING *`,
      [tenantId, leadNumber, name, phone, email, `Campaign: ${gCampaignId || 'unknown'}`]
    );
    applyAssignmentRules({ tenantId, lead: inserted.rows[0] })
      .then(() => notifyNewLead({ tenantId, lead: inserted.rows[0] }))
      .catch(() => {});
    checkNewLeadTriggers({ tenantId, lead: inserted.rows[0] }).catch(() => {});
    notifyNewLeadToAdmins(tenantId, inserted.rows[0]).catch(() => {});

    console.log(`✅ Google Ads lead captured: ${name} (${phone})`);
  } catch (e) {
    console.error('Google webhook error:', e);
  }
};

module.exports = { receiveGoogleLead };
