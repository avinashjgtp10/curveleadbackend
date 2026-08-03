const crypto = require('crypto');
const axios = require('axios');
const { query } = require('../config/db');

const GRAPH = 'https://graph.facebook.com/v21.0';

// Meta CAPI requires hashed PII: lowercase/trim for email, digits-only for phone.
const hashSha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const hashEmail = (email) => hashSha256(email.trim().toLowerCase());
const hashPhone = (phone) => hashSha256(phone.replace(/\D/g, ''));

// Sends a lead conversion event to Meta's Conversions API for Lead Ads.
// No-ops if the tenant hasn't configured a dataset ID / access token.
const sendLeadConversionEvent = async ({ tenantId, lead, eventName }) => {
  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const { meta_dataset_id, meta_capi_access_token } = result.rows[0]?.settings || {};
  if (!meta_dataset_id || !meta_capi_access_token) return;

  const userData = { lead_id: lead.meta_lead_id };
  if (lead.email) userData.em = [hashEmail(lead.email)];
  if (lead.phone) userData.ph = [hashPhone(lead.phone)];

  let status = 'success';
  let responseBody;
  try {
    const response = await axios.post(
      `${GRAPH}/${meta_dataset_id}/events`,
      {
        data: [{
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'system_generated',
          user_data: userData,
        }],
      },
      { params: { access_token: meta_capi_access_token } }
    );
    responseBody = JSON.stringify(response.data);
  } catch (e) {
    status = 'error';
    responseBody = JSON.stringify(e.response?.data || { message: e.message });
  }

  await query(
    `INSERT INTO meta_capi_events (tenant_id, lead_id, event_name, status, response_body)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, lead.id, eventName, status, responseBody]
  ).catch(() => {});
};

module.exports = { sendLeadConversionEvent };
