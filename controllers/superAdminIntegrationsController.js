const { query } = require('../config/db');

// Same idea as the AI overview: a missing table/column on an un-migrated environment
// yields an empty result instead of failing the whole page.
const safeRows = async (sql, params = []) => {
  try { return (await query(sql, params)).rows; }
  catch (e) { console.error('Integrations overview query skipped:', e.message); return []; }
};

const num = (v) => Number(v || 0);
const latest = (...dates) => dates.filter(Boolean).reduce((max, d) => (!max || d > max ? d : max), null);

// GET /api/super-admin/integrations/overview
// Platform-wide integration picture. Only configuration flags and counts are returned —
// tokens, secrets, webhook keys and API keys are never selected into the response.
const getIntegrationsOverview = async (req, res) => {
  try {
    const [tenants, googleForms, metaLeads, googleLeads, waMessages, waUsers] = await Promise.all([
      safeRows(`
        SELECT id, name, subscription_status,
               (COALESCE(settings->>'meta_page_id', '') <> '' AND COALESCE(settings->>'meta_page_access_token', '') <> '') AS meta_page,
               (COALESCE(settings->>'meta_dataset_id', '') <> '' AND COALESCE(settings->>'meta_capi_access_token', '') <> '') AS meta_capi,
               (COALESCE(settings->>'meta_ad_account_id', '') <> '' AND COALESCE(settings->>'meta_ads_access_token', '') <> '') AS meta_ads,
               (COALESCE(settings->>'google_webhook_secret', '') <> '') AS google_webhook,
               (COALESCE(settings->>'whatsapp_phone_number_id', '') <> '' AND COALESCE(settings->>'whatsapp_access_token', '') <> '') AS whatsapp,
               (COALESCE(settings->>'api_key', '') <> '') AS api_key
        FROM tenants ORDER BY name`),
      safeRows(`SELECT tenant_id, COUNT(*) AS forms, MAX(created_at) AS last_at FROM google_ads_integrations GROUP BY tenant_id`),
      safeRows(`SELECT tenant_id, COUNT(*) AS leads, MAX(created_at) AS last_at FROM leads WHERE meta_lead_id IS NOT NULL GROUP BY tenant_id`),
      safeRows(`SELECT tenant_id, COUNT(*) AS leads, MAX(created_at) AS last_at FROM leads WHERE source = 'google_ads' GROUP BY tenant_id`),
      safeRows(`SELECT tenant_id, COUNT(*) AS messages, MAX(sent_at) AS last_at FROM whatsapp_messages GROUP BY tenant_id`),
      safeRows(`SELECT tenant_id, COUNT(*) AS numbers FROM users WHERE COALESCE(whatsapp_phone_number_id, '') <> '' AND COALESCE(whatsapp_access_token, '') <> '' GROUP BY tenant_id`),
    ]);

    const by = (rows) => new Map(rows.map(r => [r.tenant_id, r]));
    const formsBy = by(googleForms);
    const metaBy = by(metaLeads);
    const googleBy = by(googleLeads);
    const waBy = by(waMessages);
    const waUsersBy = by(waUsers);

    const organizations = tenants.map(t => {
      const forms = num(formsBy.get(t.id)?.forms);
      const repNumbers = num(waUsersBy.get(t.id)?.numbers);
      return {
        id: t.id, name: t.name, status: t.subscription_status,
        meta: t.meta_page || t.meta_capi || t.meta_ads,
        google: t.google_webhook || forms > 0,
        whatsapp: t.whatsapp || repNumbers > 0,
        api: t.api_key,
      };
    });

    const count = (key) => organizations.filter(o => o[key]).length;

    res.json({
      total_organizations: tenants.length,
      integrations: [
        {
          key: 'meta', name: 'Meta', connected_orgs: count('meta'),
          stats: [
            { label: 'Facebook pages', value: tenants.filter(t => t.meta_page).length },
            { label: 'Conversion API', value: tenants.filter(t => t.meta_capi).length },
            { label: 'Ad accounts', value: tenants.filter(t => t.meta_ads).length },
            { label: 'Leads captured', value: metaLeads.reduce((s, r) => s + num(r.leads), 0) },
          ],
          last_activity: latest(...metaLeads.map(r => r.last_at)),
        },
        {
          key: 'google', name: 'Google', connected_orgs: count('google'),
          stats: [
            { label: 'Lead form integrations', value: googleForms.reduce((s, r) => s + num(r.forms), 0) },
            { label: 'Leads captured', value: googleLeads.reduce((s, r) => s + num(r.leads), 0) },
          ],
          last_activity: latest(...googleLeads.map(r => r.last_at), ...googleForms.map(r => r.last_at)),
        },
        {
          key: 'whatsapp', name: 'WhatsApp', connected_orgs: count('whatsapp'),
          stats: [
            { label: 'Organization numbers', value: tenants.filter(t => t.whatsapp).length },
            { label: 'Rep-connected numbers', value: waUsers.reduce((s, r) => s + num(r.numbers), 0) },
            { label: 'Messages', value: waMessages.reduce((s, r) => s + num(r.messages), 0) },
          ],
          last_activity: latest(...waMessages.map(r => r.last_at)),
        },
        {
          key: 'webhooks', name: 'Webhooks', connected_orgs: count('api'),
          stats: [
            { label: 'Organizations with an API key', value: count('api') },
            { label: 'Google webhook secrets', value: tenants.filter(t => t.google_webhook).length },
          ],
          last_activity: null,
        },
      ],
      organizations,
    });
  } catch (error) {
    console.error('Integrations overview error:', error);
    res.status(500).json({ error: 'Failed to load integrations overview.' });
  }
};

module.exports = { getIntegrationsOverview };
