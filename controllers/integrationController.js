const { ingestLead: ingestNormalizedLead } = require('../services/leadIngestion');
const crypto = require('crypto');
const { query } = require('../config/db');
const { nextLeadNumber } = require('../utils/leadNumber');
const { formatFieldDataNotes } = require('../utils/metaFieldData');
const { sendWelcomeMessage } = require('../utils/whatsappAutoResponder');
const { verifyWhatsAppNumber } = require('../services/whatsappService');
const { checkNewLeadTriggers } = require('../utils/automationTriggers');
const { applyAssignmentRules } = require('../utils/leadAssignment');
const { notifyNewLead } = require('../utils/leadNotifyEmail');
const { notifyNewLeadToAdmins } = require('./notificationController');
const { findOrCreateMetaCampaign } = require('../utils/metaCampaignMatch');
const { syncTenantAdInsights } = require('../utils/metaAdInsights');
const { syncFacebookLeadsForTenant } = require('../utils/metaLeadSync');

// ── helpers ────────────────────────────────────────────────────────────────

const createLeadFromSource = async (tenantId, { name, phone, email, source, source_detail, campaign_id, extra = {} }) => {
  const ingestion = await ingestNormalizedLead(tenantId, { name, phone, email, source, source_detail, campaign_id: campaign_id || null, stage: 'new', ...extra });
  if (ingestion.duplicate) return { duplicate: true, id: ingestion.lead.id };
  const result = { rows: [ingestion.lead] };
  sendWelcomeMessage({ tenantId, lead: result.rows[0] }).catch(() => {});
  applyAssignmentRules({ tenantId, lead: result.rows[0] })
    .then(() => notifyNewLead({ tenantId, lead: result.rows[0] }))
    .catch(() => {});
  checkNewLeadTriggers({ tenantId, lead: result.rows[0] }).catch(() => {});
  notifyNewLeadToAdmins(tenantId, result.rows[0]).catch(() => {});
  return { duplicate: false, id: result.rows[0].id };
};

// ── GET /api/integrations/settings ────────────────────────────────────────
const getSettings = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    let settings = result.rows[0]?.settings || {};
    // Never expose the raw api_key — send masked version
    const apiKey = settings.api_key || settings.api_key_prefix || null;

    // Legacy rows saved before verification existed have never been checked
    // against Meta — verify them now so stale/invalid credentials don't keep
    // showing as "Connected".
    let whatsappError = '';
    if (settings.whatsapp_phone_number_id && settings.whatsapp_access_token && !settings.whatsapp_verified_name && !settings.whatsapp_display_number) {
      const verify = await verifyWhatsAppNumber(settings.whatsapp_phone_number_id, settings.whatsapp_access_token);
      if (verify.verified) {
        settings = { ...settings, whatsapp_display_number: verify.display_phone_number, whatsapp_verified_name: verify.verified_name };
        query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(settings), req.tenantId]).catch(() => {});
      } else {
        whatsappError = verify.error;
      }
    }

    // The 15-minute health job (jobs/featureJobs) re-checks the token; surface a failure here.
    if (!whatsappError && settings.whatsapp_phone_number_id && settings.whatsapp_access_token) {
      const health = (await query("SELECT token_valid FROM integration_health WHERE tenant_id = $1 AND provider = 'whatsapp'", [req.tenantId])
        .catch(() => ({ rows: [] }))).rows[0];
      if (health?.token_valid === false) whatsappError = 'Meta rejected the saved access token (expired or revoked)';
    }

    res.json({
      meta_page_id: settings.meta_page_id || '',
      meta_page_name: settings.meta_page_name || '',
      meta_page_access_token: settings.meta_page_access_token ? '••••••••' : '',
      meta_configured: !!(settings.meta_page_id && settings.meta_page_access_token),
      meta_dataset_id: settings.meta_dataset_id || '',
      meta_capi_access_token: settings.meta_capi_access_token ? '••••••••' : '',
      meta_capi_configured: !!(settings.meta_dataset_id && settings.meta_capi_access_token),
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
      whatsapp_business_account_id: settings.whatsapp_business_account_id || '',
      whatsapp_app_id: settings.whatsapp_app_id || '',
      whatsapp_webhook_url: `${process.env.FRONTEND_URL || 'https://curvelead.com'}/api/whatsapp/webhook`,
      whatsapp_webhook_verify_token: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
      whatsapp_configured: !!(settings.whatsapp_phone_number_id && settings.whatsapp_access_token) && !whatsappError,
      whatsapp_display_number: settings.whatsapp_display_number || '',
      whatsapp_verified_name: settings.whatsapp_verified_name || '',
      whatsapp_connected_via: settings.whatsapp_connected_via || 'manual',
      whatsapp_error: whatsappError,
      whatsapp_auto_responder_enabled: !!settings.whatsapp_auto_responder_enabled,
      whatsapp_auto_responder_message: settings.whatsapp_auto_responder_message || '',
      ai_qualification_enabled: !!settings.ai_qualification_enabled,
      business_description: settings.business_description || '',
      meta_ad_account_id: settings.meta_ad_account_id || '',
      meta_ads_configured: !!(settings.meta_ad_account_id && settings.meta_ads_access_token),
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
    const {
      meta_page_id, meta_page_access_token, google_webhook_secret, whatsapp_phone_number_id, whatsapp_access_token,
      whatsapp_business_account_id, whatsapp_app_id,
      meta_dataset_id, meta_capi_access_token, whatsapp_auto_responder_enabled, whatsapp_auto_responder_message,
      ai_qualification_enabled, business_description, meta_ad_account_id,
    } = req.body;
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};

    const updated = { ...current };
    if (meta_page_id !== undefined) updated.meta_page_id = meta_page_id;
    if (meta_page_access_token && !meta_page_access_token.startsWith('•')) updated.meta_page_access_token = meta_page_access_token;
    if (google_webhook_secret && !google_webhook_secret.startsWith('•')) updated.google_webhook_secret = google_webhook_secret;
    const whatsappCredsChanged = whatsapp_phone_number_id !== undefined
      || (whatsapp_access_token !== undefined && !whatsapp_access_token.startsWith('•'));
    if (whatsapp_phone_number_id !== undefined) updated.whatsapp_phone_number_id = whatsapp_phone_number_id;
    if (whatsapp_access_token !== undefined && !whatsapp_access_token.startsWith('•')) updated.whatsapp_access_token = whatsapp_access_token;
    if (whatsapp_business_account_id !== undefined) updated.whatsapp_business_account_id = whatsapp_business_account_id;
    if (whatsapp_app_id !== undefined) updated.whatsapp_app_id = whatsapp_app_id;

    if (whatsappCredsChanged) {
      // Manually entered credentials replace any one-click connection.
      delete updated.whatsapp_connected_via;
      if (updated.whatsapp_phone_number_id && updated.whatsapp_access_token) {
        const verify = await verifyWhatsAppNumber(updated.whatsapp_phone_number_id, updated.whatsapp_access_token);
        if (!verify.verified) {
          return res.status(400).json({ error: `Could not connect to WhatsApp: ${verify.error}` });
        }
        updated.whatsapp_display_number = verify.display_phone_number;
        updated.whatsapp_verified_name = verify.verified_name;
      } else {
        updated.whatsapp_display_number = '';
        updated.whatsapp_verified_name = '';
      }
    }
    if (meta_dataset_id !== undefined) updated.meta_dataset_id = meta_dataset_id;
    if (meta_capi_access_token && !meta_capi_access_token.startsWith('•')) updated.meta_capi_access_token = meta_capi_access_token;
    if (whatsapp_auto_responder_enabled !== undefined) updated.whatsapp_auto_responder_enabled = whatsapp_auto_responder_enabled;
    if (whatsapp_auto_responder_message !== undefined) updated.whatsapp_auto_responder_message = whatsapp_auto_responder_message;
    if (ai_qualification_enabled !== undefined) updated.ai_qualification_enabled = ai_qualification_enabled;
    if (business_description !== undefined) updated.business_description = business_description;
    if (meta_ad_account_id !== undefined) updated.meta_ad_account_id = meta_ad_account_id;

    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(updated), req.tenantId]);
    // The credentials were just verified with Meta, so reflect that now instead
    // of showing the old "Disconnected" until the next 15-minute health check.
    if (whatsappCredsChanged) {
      if (updated.whatsapp_phone_number_id && updated.whatsapp_access_token)
        await query(
          `INSERT INTO integration_health(tenant_id,provider,token_valid,checked_at) VALUES($1,'whatsapp',true,now())
           ON CONFLICT(tenant_id,provider) DO UPDATE SET token_valid=true,checked_at=now(),alerted_at=NULL`,
          [req.tenantId]
        );
      else await query("DELETE FROM integration_health WHERE tenant_id=$1 AND provider='whatsapp'", [req.tenantId]);
    }
    res.json({ message: 'Integration settings saved.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// ── POST /api/integrations/api-key ─────────────────────────────────────────
const generateApiKey = async (req, res) => {
  try {
    const newKey = `clk_${crypto.randomBytes(24).toString('hex')}`;
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};
    const updated = { api_key: null, api_key_hash: crypto.createHash('sha256').update(newKey).digest('hex'), api_key_prefix: newKey.slice(0,8), api_key_created_at: new Date().toISOString() };
    await query("UPDATE tenants SET settings = (COALESCE(settings,'{}'::jsonb)-'api_key') || $1::jsonb WHERE id = $2", [JSON.stringify(updated), req.tenantId]);
    // Return the full key only once
    res.json({ api_key: newKey, created_at: updated.api_key_created_at });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// ── DELETE /api/integrations/api-key ──────────────────────────────────────
const revokeApiKey = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};
    const { api_key, api_key_hash, api_key_prefix, api_key_created_at, ...rest } = current;
    await query("UPDATE tenants SET settings=COALESCE(settings,'{}'::jsonb)-'api_key'-'api_key_hash'-'api_key_prefix'-'api_key_created_at' WHERE id=$1",[req.tenantId]);
    res.json({ message: 'API key revoked.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// ── POST /api/integrations/ingest  (public — API key auth) ────────────────
const ingestLead = async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) return res.status(401).json({ error: 'API key required.' });

    const result = await query(
      `SELECT id FROM tenants WHERE (settings->>'api_key' = $1 OR settings->>'api_key_hash' = $2) AND subscription_status IN ('trial','active')`,
      [apiKey, crypto.createHash('sha256').update(String(apiKey)).digest('hex')]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired API key.' });
    const tenantId = result.rows[0].id;

    const { name, phone, email, source = 'api', source_detail, campaign_id, assigned_to } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const lead = await createLeadFromSource(tenantId, { name, phone, email, source, source_detail, campaign_id });
    if (lead.duplicate) return res.status(200).json({ message: 'Duplicate submission attached to existing lead.', duplicate: true, id: lead.id });

    res.status(201).json({ message: 'Lead created.', id: lead.id });
  } catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed.' }); }
};

// ── GET /api/integrations/embed-script ────────────────────────────────────
const getEmbedScript = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const apiKey = result.rows[0]?.settings?.api_key || (result.rows[0]?.settings?.api_key_hash ? 'PASTE_YOUR_SAVED_API_KEY_HERE' : null);
    if (!apiKey) return res.status(400).json({ error: 'Generate an API key first.' });

    const baseUrl = process.env.FRONTEND_URL || 'https://curvelead.com';
    const script = `<!-- CurveLead Lead Capture Form. Replace PASTE_YOUR_SAVED_API_KEY_HERE with your saved API key before using this form. -->
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

const { GRAPH_URL: GRAPH } = require('../config/meta');

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

    // Persist the long-lived USER token (not just the per-page tokens derived below)
    // — this is what's needed for ad-account listing and ads Insights, which are
    // user-level, not page-level, permissions.
    const grantedScopes = (permsData.data || []).filter(p => p.status === 'granted').map(p => p.permission);
    if (grantedScopes.includes('ads_read') || grantedScopes.includes('ads_management')) {
      const settingsResult = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
      const current = settingsResult.rows[0]?.settings || {};
      await query('UPDATE tenants SET settings = $1 WHERE id = $2', [
        JSON.stringify({ ...current, meta_ads_access_token: tokenData.access_token }), req.tenantId,
      ]);
    }

    // Resolve which Business Portfolio the user authorized, if they granted business_management.
    let businesses = [];
    if (grantedScopes.includes('business_management')) {
      const businessesData = await fbGet(
        `/me/businesses?access_token=${encodeURIComponent(tokenData.access_token)}&fields=id,name`
      ).catch(e => ({ data: [], _error: e.message }));
      businesses = businessesData.data || [];
      if (businesses.length) {
        const settingsResult = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
        const current = settingsResult.rows[0]?.settings || {};
        await query('UPDATE tenants SET settings = $1 WHERE id = $2', [
          JSON.stringify({ ...current, meta_business_id: businesses[0].id, meta_business_name: businesses[0].name }), req.tenantId,
        ]);
      }
    }

    res.json({ pages: pagesData.data || [], businesses });
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

// ── GET /api/integrations/facebook/ad-accounts ─────────────────────────────
const getAdAccounts = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const { meta_ads_access_token } = result.rows[0]?.settings || {};
    if (!meta_ads_access_token) {
      return res.status(400).json({ error: 'Reconnect Facebook to grant ads access first.', needs_reconnect: true });
    }

    const data = await fbGet(
      `/me/adaccounts?fields=id,name,account_status&access_token=${encodeURIComponent(meta_ads_access_token)}`
    );
    res.json({ ad_accounts: data.data || [] });
  } catch (e) {
    console.error('getAdAccounts:', e.message);
    res.status(400).json({ error: e.message });
  }
};

// ── POST /api/integrations/facebook/sync-ad-insights ───────────────────────
const syncAdInsightsNow = async (req, res) => {
  try {
    // Workspaces connected in Ads Manager sync through the Ads module's queue.
    const adAccounts = await query(
      "SELECT id FROM ad_accounts WHERE tenant_id = $1 AND provider = 'meta' AND is_active", [req.tenantId]
    ).catch(e => { if (e.code === '42P01') return { rows: [] }; throw e; });
    if (adAccounts.rows.length) {
      const queues = require('../jobs/queues');
      for (const a of adAccounts.rows) await queues.enqueue('ads:sync-account', { tenantId: req.tenantId, adAccountId: a.id }, { jobId: `sync-${a.id}` });
      return res.json({ message: 'Sync started — new numbers appear in a few minutes.', queued: adAccounts.rows.length });
    }
    const result = await syncTenantAdInsights(req.tenantId);
    if (result.reason === 'not_configured') {
      return res.status(400).json({ error: 'Connect an ad account first.' });
    }
    res.json({ message: `Synced ${result.synced} campaign(s).`, synced: result.synced });
  } catch (e) {
    console.error('syncAdInsightsNow:', e.message);
    res.status(400).json({ error: e.message });
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
    res.status(e.status || 500).json({ error: e.message });
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
    res.status(e.status || 500).json({ error: e.message });
  }
};

const facebookSyncStatus = async (req, res) => {
  try {
    const result = await query(`SELECT settings->>'meta_leads_last_synced_at' AS last_synced_at,
      (COALESCE(settings->>'meta_page_id','') <> '' AND COALESCE(settings->>'meta_page_access_token','') <> '') AS configured
      FROM tenants WHERE id=$1`, [req.tenantId]);
    res.json({ last_synced_at: result.rows[0]?.last_synced_at || null, configured: !!result.rows[0]?.configured });
  } catch (error) {
    console.error('Facebook sync status error:', error.message);
    res.status(500).json({ error: 'Failed to load sync status.' });
  }
};
const facebookSyncLeads = async (req, res) => {
  try {
    const { created, skipped, last_synced_at } = await syncFacebookLeadsForTenant(req.tenantId);
    res.json({ message: `Sync complete — ${created} new leads imported, ${skipped} skipped.`, created, skipped, last_synced_at });
  } catch (e) {
    if (e.code === 'NO_PAGE') return res.status(400).json({ error: e.message });
    console.error('facebookSyncLeads:', e.message);
    res.status(500).json({ error: e.message || 'Failed to sync leads.' });
  }
};

// ── GET /api/integrations/meta/capi-stats ──────────────────────────────────
const getCapiStats = async (req, res) => {
  try {
    const defaultStage = await query(
      `SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_active = true ORDER BY pos ASC LIMIT 1`,
      [req.tenantId]
    );
    const defaultStageName = defaultStage.rows[0]?.name || 'new';

    const stats = await query(
      `SELECT
         COUNT(*) FILTER (WHERE meta_lead_id IS NOT NULL) AS total_meta_leads,
         COUNT(*) FILTER (WHERE meta_lead_id IS NOT NULL AND LOWER(stage) != LOWER($2)) AS leads_with_stage
       FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL`,
      [req.tenantId, defaultStageName]
    );

    const total = Number(stats.rows[0].total_meta_leads);
    const withStage = Number(stats.rows[0].leads_with_stage);
    res.json({
      total_meta_leads: total,
      leads_with_stage: withStage,
      percent: total > 0 ? Math.round((withStage / total) * 100) : 0,
    });
  } catch (e) {
    console.error('getCapiStats error:', e.message);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
};

// ── POST /api/integrations/whatsapp/embedded-signup ───────────────────────
// One-click connect via Meta's WhatsApp Embedded Signup. The browser popup
// returns a one-time code plus the WABA and phone number the customer picked;
// everything then runs through the platform Meta app (META_APP_ID), so its
// webhook and META_APP_SECRET cover every connected workspace.
const fbPost = async (path, token, body) => {
  const res = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.error_user_msg || data.error.message);
  return data;
};

const whatsappEmbeddedSignup = async (req, res) => {
  try {
    const { code, waba_id, phone_number_id } = req.body;
    const isId = (v) => typeof v === 'string' && /^\d{5,25}$/.test(v);
    if (typeof code !== 'string' || !code || !isId(waba_id) || !isId(phone_number_id))
      return res.status(400).json({ error: 'Signup did not return a WhatsApp account and number. Please try again.' });

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) return res.status(500).json({ error: 'META_APP_ID / META_APP_SECRET not configured on server.' });

    // Business integration token: scoped to the assets the customer granted, no expiry.
    const { access_token: token } = await fbGet(
      `/oauth/access_token?client_id=${appId}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`
    );
    const auth = `access_token=${encodeURIComponent(token)}`;

    // The IDs come from the browser, so confirm the number really is in that WABA.
    const numbers = await fbGet(`/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,platform_type&${auth}`);
    const number = (numbers.data || []).find((n) => n.id === phone_number_id);
    if (!number) return res.status(400).json({ error: 'That phone number is not part of the selected WhatsApp Business Account.' });

    // Route this WABA's messages and status updates to our webhook.
    await fbPost(`/${waba_id}/subscribed_apps`, token);

    // Numbers added during signup still need registering on the Cloud API.
    // The PIN becomes the number's two-step verification PIN, so keep it.
    let pin = null;
    if (number.platform_type !== 'CLOUD_API') {
      pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await fbPost(`/${phone_number_id}/register`, token, { messaging_product: 'whatsapp', pin });
    }

    const current = (await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId])).rows[0]?.settings || {};
    const updated = {
      ...current,
      whatsapp_phone_number_id: phone_number_id,
      whatsapp_access_token: token,
      whatsapp_business_account_id: waba_id,
      whatsapp_app_id: appId,
      whatsapp_display_number: number.display_phone_number || '',
      whatsapp_verified_name: number.verified_name || '',
      whatsapp_connected_via: 'embedded_signup',
      ...(pin ? { whatsapp_two_step_pin: pin } : {}),
    };
    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(updated), req.tenantId]);
    await query(
      `INSERT INTO integration_health(tenant_id,provider,token_valid,checked_at) VALUES($1,'whatsapp',true,now())
       ON CONFLICT(tenant_id,provider) DO UPDATE SET token_valid=true,checked_at=now(),alerted_at=NULL`,
      [req.tenantId]
    );
    res.json({ connected: true, display_phone_number: updated.whatsapp_display_number, verified_name: updated.whatsapp_verified_name });
  } catch (e) {
    console.error('whatsappEmbeddedSignup:', e.message);
    res.status(400).json({ error: `Could not connect WhatsApp: ${e.message}` });
  }
};

// ── POST /api/integrations/whatsapp/reconnect ─────────────────────────────
// Re-checks the saved WhatsApp credentials with Meta and re-subscribes our app to the
// WABA's webhooks (fixes replies/delivery statuses that stopped arriving). An invalid
// token can't be repaired here — the client asks for a new one (needs_new_token).
const whatsappReconnect = async (req, res) => {
  try {
    const current = (await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId])).rows[0]?.settings || {};
    const { whatsapp_phone_number_id: phoneId, whatsapp_access_token: token, whatsapp_business_account_id: wabaId } = current;
    if (!phoneId || !token) return res.status(400).json({ error: 'WhatsApp is not connected yet.', needs_new_token: true });

    const markHealth = valid => query(
      `INSERT INTO integration_health(tenant_id,provider,token_valid,checked_at) VALUES($1,'whatsapp',$2,now())
       ON CONFLICT(tenant_id,provider) DO UPDATE SET token_valid=$2,checked_at=now(),alerted_at=CASE WHEN $2 THEN NULL ELSE integration_health.alerted_at END`,
      [req.tenantId, valid]
    ).catch(() => {});

    const verify = await verifyWhatsAppNumber(phoneId, token);
    if (!verify.verified) {
      await markHealth(false);
      return res.status(400).json({ error: `Meta rejected the saved credentials: ${verify.error}`, needs_new_token: true });
    }

    let webhookSubscribed = false, warning = null;
    if (wabaId) {
      try { await fbPost(`/${wabaId}/subscribed_apps`, token); webhookSubscribed = true; }
      catch (e) { warning = `Connected, but re-subscribing webhooks failed: ${e.message}`; }
    } else {
      warning = 'Connected. Add your WhatsApp Business Account ID to also re-subscribe webhooks and use templates.';
    }

    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({
      ...current, whatsapp_display_number: verify.display_phone_number, whatsapp_verified_name: verify.verified_name,
    }), req.tenantId]);
    await markHealth(true);
    res.json({ connected: true, display_phone_number: verify.display_phone_number, verified_name: verify.verified_name, webhook_subscribed: webhookSubscribed, warning });
  } catch (e) {
    console.error('whatsappReconnect:', e.message);
    res.status(500).json({ error: 'Could not reconnect WhatsApp.' });
  }
};

module.exports = { whatsappEmbeddedSignup, whatsappReconnect, getSettings, updateSettings, generateApiKey, revokeApiKey, ingestLead, getEmbedScript, facebookAuth, facebookConnectPage, facebookSyncLeads, facebookSubscribeWebhook, facebookSubscriptionStatus, getCapiStats, getAdAccounts, syncAdInsightsNow };

module.exports.facebookSyncStatus = facebookSyncStatus;
