const crypto = require('crypto');
const axios = require('axios');
const { query } = require('../config/db');

const { GRAPH_URL: GRAPH } = require('../config/meta');

// Meta Conversions API for CRM leads (Lead Ads): tells Meta which of its leads became
// qualified / converted, so campaigns optimise for lead quality. Payload per Meta's
// CRM integration spec: action_source system_generated, the leadgen id in user_data.lead_id,
// SHA-256 of normalised customer fields, and a deterministic event_id for de-duplication.

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Normalisation before hashing (Meta: lowercase, trimmed; phone digits with country code;
// names and city without spaces/punctuation; 2-letter country code).
const normalize = {
  email: (v) => String(v || '').trim().toLowerCase(),
  phone: (v, country = 'in') => {
    let d = String(v || '').replace(/\D/g, '');
    if (country === 'in' && d.length === 10) d = `91${d}`;
    return d;
  },
  name: (v) => String(v || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''),
  city: (v) => String(v || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\d]/gu, ''),
  country: (v) => String(v || '').trim().toLowerCase().slice(0, 2),
};

const hashed = (value) => (value ? [sha256(value)] : undefined);

const buildUserData = (lead, country = 'in') => {
  const [first, ...rest] = String(lead.name || '').trim().split(/\s+/);
  const data = {
    lead_id: lead.meta_lead_id,
    em: hashed(lead.email && normalize.email(lead.email)),
    ph: hashed(lead.phone && normalize.phone(lead.phone, country)),
    fn: hashed(first && first.toLowerCase() !== 'unknown' && normalize.name(first)),
    ln: hashed(rest.length && normalize.name(rest.join(''))),
    ct: hashed(lead.city && normalize.city(lead.city)),
    country: hashed(normalize.country(country)),
    external_id: hashed(lead.id && String(lead.id)),
  };
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== ''));
};

const eventIdFor = (lead, eventName) => `${lead.id}:${eventName}`;

const buildEvent = ({ lead, eventName, eventTime, country }) => ({
  event_name: eventName,
  event_time: Math.floor((eventTime ? new Date(eventTime).getTime() : Date.now()) / 1000),
  event_id: eventIdFor(lead, eventName),
  action_source: 'system_generated',
  user_data: buildUserData(lead, country),
  custom_data: { lead_event_source: 'CurveLead', event_source: 'crm' },
});

// Returns 'success' | 'error' (retry) | 'skipped' (CAPI off / not a Meta lead) |
// 'not_configured' (on, but no dataset id / token — retrying won't help).
const sendLeadConversionEvent = async ({ tenantId, lead, eventName, eventTime }) => {
  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const settings = result.rows[0]?.settings || {};
  const { meta_dataset_id, meta_capi_access_token } = settings;
  if (!settings.meta_capi_enabled || !lead.meta_lead_id) return 'skipped';
  if (!eventName) {
    const stage = (lead.stage || '').toLowerCase();
    if (stage === 'qualified') eventName = settings.meta_qualified_event || 'QualifiedLead';
    else if (stage === 'won') eventName = settings.meta_won_event || 'ConvertedLead';
    else return 'skipped';
  }
  if (!meta_dataset_id || !meta_capi_access_token) return 'not_configured';

  const event = buildEvent({ lead, eventName, eventTime, country: settings.meta_capi_country || 'in' });
  let status = 'success';
  let responseBody;
  try {
    const response = await axios.post(`${GRAPH}/${meta_dataset_id}/events`, { data: [event] },
      { timeout: 10000, headers: { Authorization: `Bearer ${meta_capi_access_token}` } });
    responseBody = JSON.stringify(response.data);
  } catch (e) {
    status = 'error';
    responseBody = JSON.stringify(e.response?.data || { message: e.message });
  }

  // The event already reached Meta: a log failure must not turn it into a retry.
  await query(
    `INSERT INTO meta_capi_events (tenant_id, lead_id, event_name, status, response_body, event_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, lead_id, event_name) WHERE status = 'success' DO NOTHING`,
    [tenantId, lead.id, eventName, status, responseBody, event.event_id]
  ).catch(async (e) => {
    if (!['42P10', '42703'].includes(e.code)) throw e;   // before migration_ads_phase4.sql
    await query('INSERT INTO meta_capi_events (tenant_id, lead_id, event_name, status, response_body) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, lead.id, eventName, status, responseBody]).catch(() => {});
  });
  return status;
};

module.exports = { sendLeadConversionEvent, buildEvent, buildUserData, normalize, eventIdFor };
