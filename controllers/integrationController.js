const crypto = require('crypto');
const { query } = require('../config/db');

// ── helpers ────────────────────────────────────────────────────────────────

const createLeadFromSource = async (tenantId, { name, phone, email, source, source_detail, campaign_id, extra = {} }) => {
  if (!phone) throw new Error('phone required');

  const existing = await query('SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, phone]);
  if (existing.rows.length) return { duplicate: true, id: existing.rows[0].id };

  const result = await query(
    `INSERT INTO leads (tenant_id, name, phone, email, source, source_detail, campaign_id, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'new') RETURNING id`,
    [tenantId, name || 'Unknown', phone, email || null, source, source_detail || null, campaign_id || null]
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
      meta_page_access_token: settings.meta_page_access_token ? '••••••••' : '',
      meta_configured: !!(settings.meta_page_id && settings.meta_page_access_token),
      google_webhook_secret: settings.google_webhook_secret ? '••••••••' : '',
      google_configured: !!settings.google_webhook_secret,
      api_key: apiKey ? `${apiKey.slice(0, 8)}${'•'.repeat(24)}` : null,
      api_key_created_at: settings.api_key_created_at || null,
      webhook_url: `${process.env.FRONTEND_URL || 'https://curvelead.com'}/api/webhook/meta`,
      api_ingest_url: `${process.env.FRONTEND_URL || 'https://curvelead.com'}/api/integrations/ingest`,
      google_webhook_url: `${process.env.FRONTEND_URL || 'https://curvelead.com'}/api/webhook/google`,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// ── PUT /api/integrations/settings ────────────────────────────────────────
const updateSettings = async (req, res) => {
  try {
    const { meta_page_id, meta_page_access_token, google_webhook_secret } = req.body;
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};

    const updated = { ...current };
    if (meta_page_id !== undefined) updated.meta_page_id = meta_page_id;
    if (meta_page_access_token && !meta_page_access_token.startsWith('•')) updated.meta_page_access_token = meta_page_access_token;
    if (google_webhook_secret && !google_webhook_secret.startsWith('•')) updated.google_webhook_secret = google_webhook_secret;

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

module.exports = { getSettings, updateSettings, generateApiKey, revokeApiKey, ingestLead, getEmbedScript };
