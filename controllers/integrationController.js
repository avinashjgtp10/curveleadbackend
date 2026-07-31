const crypto = require('crypto');
const { query } = require('../config/db');
const { nextLeadNumber } = require('../utils/leadNumber');
const { formatFieldDataNotes } = require('../utils/metaFieldData');

// ── helpers ────────────────────────────────────────────────────────────────

const createLeadFromSource = async (tenantId, { name, phone, email, source, source_detail, campaign_id, extra = {} }) => {
  if (!phone) throw new Error('phone required');

  const existing = await query('SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, phone]);
  if (existing.rows.length) return { duplicate: true, id: existing.rows[0].id };

  const leadNumber = await nextLeadNumber(tenantId);
  const result = await query(
    `INSERT INTO leads (tenant_id, lead_number, name, phone, email, source, source_detail, campaign_id, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new') RETURNING id`,
    [tenantId, leadNumber, name || 'Unknown', phone, email || null, source, source_detail || null, campaign_id || null]
  );
  return { duplicate: false, id: result.rows[0].id };
};

// ── GET /api/integrations/settings ────────────────────────────────────────
const getSettings = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const settings = result.rows[0]?.settings || {};
    // Never expose the raw api_key — send masked version
    const apiKey = settings.api_key || null;
    res.json({
      meta_page_id: settings.meta_page_id || '',
      meta_page_name: settings.meta_page_name || '',
      meta_page_access_token: settings.meta_page_access_token ? '••••••••' : '',
      meta_configured: !!(settings.meta_page_id && settings.meta_page_access_token),
      google_webhook_secret: settings.google_webhook_secret ? '••••••••' : '',
      google_configured: !!settings.google_webhook_secret,
      api_key: apiKey ? `${apiKey.slice(0, 8)}${'•'.repeat(24)}` : null,
      api_key_created_at: settings.api_key_created_at || null,
      webhook_url: `${process.env.FRONTEND_URL || 'https://curvelead.com'}/api/webhook/meta`,
      api_ingest_url: `${process.env.FRONTEND_URL || 'https://curvelead.com'}/api/integrations/ingest`,
      google_webhook_url: `${process.env.FRONTEND_URL || 'https://curvelead.com'}/api/webhook/google`,
      // WhatsApp Business API (per-tenant)
      whatsapp_phone_number_id: settings.whatsapp_phone_number_id || '',
      whatsapp_access_token: settings.whatsapp_access_token ? '••••••••' : '',
      whatsapp_configured: !!(settings.whatsapp_phone_number_id && settings.whatsapp_access_token),
    });
  } catch (e) {
    console.error('getSettings error:', e.message);
    if (e.message?.includes('settings')) {
      return res.status(500).json({ error: 'DB migration required. Run migration_integrations.sql on your RDS database.' });
    }
    res.status(500).json({ error: 'Failed.' });
  }
};

// ── PUT /api/integrations/settings ────────────────────────────────────────
const updateSettings = async (req, res) => {
  try {
    const { meta_page_id, meta_page_access_token, google_webhook_secret, whatsapp_phone_number_id, whatsapp_access_token } = req.body;
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};

    const updated = { ...current };
    if (meta_page_id !== undefined) updated.meta_page_id = meta_page_id;
    if (meta_page_access_token && !meta_page_access_token.startsWith('•')) updated.meta_page_access_token = meta_page_access_token;
    if (google_webhook_secret && !google_webhook_secret.startsWith('•')) updated.google_webhook_secret = google_webhook_secret;
    if (whatsapp_phone_number_id !== undefined) updated.whatsapp_phone_number_id = whatsapp_phone_number_id;
    if (whatsapp_access_token && !whatsapp_access_token.startsWith('•')) updated.whatsapp_access_token = whatsapp_access_token;

    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(updated), req.tenantId]);
    res.json({ message: 'Integration settings saved.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// ── POST /api/integrations/api-key ─────────────────────────────────────────
const generateApiKey = async (req, res) => {
  try {
    const newKey = `clk_${crypto.randomBytes(24).toString('hex')}`;
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};
    const updated = { ...current, api_key: newKey, api_key_created_at: new Date().toISOString() };
    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(updated), req.tenantId]);
    // Return the full key only once
    res.json({ api_key: newKey, created_at: updated.api_key_created_at });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// ── DELETE /api/integrations/api-key ──────────────────────────────────────
const revokeApiKey = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};
    const { api_key, api_key_created_at, ...rest } = current;
    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(rest), req.tenantId]);
    res.json({ message: 'API key revoked.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// ── POST /api/integrations/ingest  (public — API key auth) ────────────────
const ingestLead = async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) return res.status(401).json({ error: 'API key required.' });

    const result = await query(
      `SELECT id FROM tenants WHERE settings->>'api_key' = $1 AND subscription_status IN ('trial','active')`,
      [apiKey]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired API key.' });
    const tenantId = result.rows[0].id;

    const { name, phone, email, source = 'api', source_detail, campaign_id, assigned_to } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const lead = await createLeadFromSource(tenantId, { name, phone, email, source, source_detail, campaign_id });
    if (lead.duplicate) return res.status(409).json({ error: 'Duplicate lead.', id: lead.id });

    res.status(201).json({ message: 'Lead created.', id: lead.id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// ── GET /api/integrations/embed-script ────────────────────────────────────
const getEmbedScript = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const apiKey = result.rows[0]?.settings?.api_key;
    if (!apiKey) return res.status(400).json({ error: 'Generate an API key first.' });

    const baseUrl = process.env.FRONTEND_URL || 'https://curvelead.com';
    const script = `<!-- CurveLead Lead Capture Form -->
<div id="cl-lead-form"></div>
<script>
(function(){
  var f=document.getElementById('cl-lead-form');
  f.innerHTML='<form id="_clf" style="display:flex;flex-direction:column;gap:10px;max-width:400px">'
    +'<input name="name" placeholder="Full Name *" required style="padding:10px;border:1px solid #ddd;border-radius:6px">'
    +'<input name="phone" placeholder="Phone Number *" required style="padding:10px;border:1px solid #ddd;border-radius:6px">'
    +'<input name="email" placeholder="Email" style="padding:10px;border:1px solid #ddd;border-radius:6px">'
    +'<button type="submit" style="padding:12px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:15px">Submit</button>'
    +'<p id="_clm" style="font-size:13px;text-align:center"></p>'
    +'</form>';
  document.getElementById('_clf').onsubmit=function(e){
    e.preventDefault();
    var d=Object.fromEntries(new FormData(this));
    d.source='website';
    fetch('${baseUrl}/api/integrations/ingest',{
      method:'POST',headers:{'Content-Type':'application/json','x-api-key':'${apiKey}'},body:JSON.stringify(d)
    }).then(function(r){return r.json()}).then(function(r){
      document.getElementById('_clm').textContent=r.error||'Thank you! We will contact you soon.';
      if(!r.error)document.getElementById('_clf').reset();
    }).catch(function(){document.getElementById('_clm').textContent='Something went wrong.'});
  };
})();
</script>`;

    res.json({ script });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// ── Facebook OAuth helpers ─────────────────────────────────────────────────

const GRAPH = 'https://graph.facebook.com/v25.0';

const fbGet = async (path) => {
  const res = await fetch(`${GRAPH}${path}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
};

// ── POST /api/integrations/facebook/auth ──────────────────────────────────
// Receive short-lived user token from FB SDK, exchange for long-lived, return pages list
const facebookAuth = async (req, res) => {
  try {
    const { user_token } = req.body;
    if (!user_token) return res.status(400).json({ error: 'user_token required' });

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) return res.status(500).json({ error: 'META_APP_ID / META_APP_SECRET not configured on server.' });

    const tokenData = await fbGet(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(user_token)}`
    );

    const [pagesData, permsData] = await Promise.all([
      fbGet(`/me/accounts?access_token=${encodeURIComponent(tokenData.access_token)}&fields=id,name,access_token,fan_count`),
      fbGet(`/me/permissions?access_token=${encodeURIComponent(tokenData.access_token)}`).catch(e => ({ data: [], _error: e.message })),
    ]);

    console.log('facebookAuth debug — granted permissions:', JSON.stringify(permsData.data));
    console.log('facebookAuth debug — pages returned:', pagesData.data?.length || 0);

    res.json({ pages: pagesData.data || [] });
  } catch (e) {
    console.error('facebookAuth:', e.message);
    res.status(400).json({ error: e.message });
  }
};

// ── POST /api/integrations/facebook/connect-page ──────────────────────────
const facebookConnectPage = async (req, res) => {
  try {
    const { page_id, page_access_token, page_name } = req.body;
    if (!page_id || !page_access_token) return res.status(400).json({ error: 'page_id and page_access_token required' });

    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};
    const updated = { ...current, meta_page_id: page_id, meta_page_access_token: page_access_token, meta_page_name: page_name };
    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(updated), req.tenantId]);

    // Auto-subscribe page to webhook so real-time leads start flowing
    let webhookStatus = 'not_subscribed';
    try {
      const subRes = await fetch(
        `${GRAPH}/${page_id}/subscribed_apps?access_token=${encodeURIComponent(page_access_token)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscribed_fields: ['leadgen'] }) }
      );
      const subData = await subRes.json();
      if (subData.success) webhookStatus = 'subscribed';
      else console.warn('Webhook subscription warning:', subData);
    } catch (subErr) {
      console.warn('Could not auto-subscribe to webhook:', subErr.message);
    }

    res.json({ message: `Connected to "${page_name}"`, webhook_status: webhookStatus });
  } catch (e) {
    console.error('facebookConnectPage:', e.message);
    res.status(500).json({ error: 'Failed.' });
  }
};

// ── POST /api/integrations/facebook/subscribe-webhook ─────────────────────
const facebookSubscribeWebhook = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const settings = result.rows[0]?.settings || {};
    const { meta_page_id, meta_page_access_token } = settings;
    if (!meta_page_id || !meta_page_access_token) return res.status(400).json({ error: 'Connect a Facebook page first.' });

    const subRes = await fetch(
      `${GRAPH}/${meta_page_id}/subscribed_apps?access_token=${encodeURIComponent(meta_page_access_token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscribed_fields: ['leadgen'] }) }
    );
    const subData = await subRes.json();

    if (subData.success) {
      res.json({ message: 'Webhook subscribed — real-time leads are now active.', subscribed: true });
    } else {
      res.status(400).json({ error: subData.error?.message || 'Subscription failed.', detail: subData });
    }
  } catch (e) {
    console.error('facebookSubscribeWebhook:', e.message);
    res.status(500).json({ error: e.message });
  }
};

// ── GET /api/integrations/facebook/subscription-status ────────────────────
const facebookSubscriptionStatus = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const settings = result.rows[0]?.settings || {};
    const { meta_page_id, meta_page_access_token } = settings;
    if (!meta_page_id || !meta_page_access_token) return res.json({ subscribed: false, reason: 'no_page_connected' });

    const data = await fbGet(`/${meta_page_id}/subscribed_apps?access_token=${encodeURIComponent(meta_page_access_token)}`);
    const app = (data.data || []).find(a => a.id === process.env.META_APP_ID);
    const subscribed = !!(app && (app.subscribed_fields || []).includes('leadgen'));

    res.json({ subscribed, page_id: meta_page_id, page_name: settings.meta_page_name || '', subscribed_fields: app?.subscribed_fields || [] });
  } catch (e) {
    console.error('facebookSubscriptionStatus:', e.message);
    res.status(500).json({ error: e.message });
  }
};

// ── POST /api/integrations/facebook/sync-leads ────────────────────────────
const facebookSyncLeads = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const settings = result.rows[0]?.settings || {};
    const { meta_page_id, meta_page_access_token } = settings;
    if (!meta_page_id || !meta_page_access_token) return res.status(400).json({ error: 'Connect a Facebook page first.' });

    const formsData = await fbGet(
      `/${meta_page_id}/leadgen_forms?access_token=${encodeURIComponent(meta_page_access_token)}&limit=20&fields=id,name`
    );

    let created = 0, skipped = 0;

    for (const form of formsData.data || []) {
      const leadsData = await fbGet(
        `/${form.id}/leads?access_token=${encodeURIComponent(meta_page_access_token)}&limit=100&fields=id,created_time,field_data`
      );

      for (const lead of leadsData.data || []) {
        const dup = await query('SELECT id FROM leads WHERE tenant_id = $1 AND meta_lead_id = $2', [req.tenantId, lead.id]);
        if (dup.rows.length) { skipped++; continue; }

        const fields = {};
        for (const f of lead.field_data || []) fields[f.name] = f.values?.[0] || '';

        const name = fields['full_name'] || fields['name'] || 'Unknown';
        const phone = fields['phone_number'] || fields['phone'] || null;
        const email = fields['email'] || null;
        const notes = formatFieldDataNotes(lead.field_data);

        const leadNumber = await nextLeadNumber(req.tenantId);
        await query(
          `INSERT INTO leads (tenant_id, lead_number, name, phone, email, source, source_detail, meta_lead_id, stage, created_at, notes)
           VALUES ($1,$2,$3,$4,$5,'meta_ads',$6,$7,'new',$8,$9) ON CONFLICT DO NOTHING`,
          [req.tenantId, leadNumber, name, phone, email, form.name || 'Facebook Lead Ad', lead.id, new Date(lead.created_time), notes]
        );
        created++;
      }
    }

    res.json({ message: `Sync complete — ${created} new leads imported, ${skipped} skipped.`, created, skipped });
  } catch (e) {
    console.error('facebookSyncLeads:', e.message);
    res.status(500).json({ error: e.message || 'Failed to sync leads.' });
  }
};

module.exports = { getSettings, updateSettings, generateApiKey, revokeApiKey, ingestLead, getEmbedScript, facebookAuth, facebookConnectPage, facebookSyncLeads, facebookSubscribeWebhook, facebookSubscriptionStatus };
