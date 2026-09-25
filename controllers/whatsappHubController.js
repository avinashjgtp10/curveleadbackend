const axios = require('axios');
const { query } = require('../config/db');

const META_API_URL = 'https://graph.facebook.com/v25.0';

const getSettings = async (tenantId) => {
  const r = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  return r.rows[0]?.settings || {};
};

const saveSettings = async (tenantId, patch) => {
  const current = await getSettings(tenantId);
  await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({ ...current, ...patch }), tenantId]);
};

// Postgres "undefined table/column" — the opt-in migration hasn't been run yet.
const isMissingSchema = (e) => e?.code === '42P01' || e?.code === '42703';

const clampDays = (v, def) => Math.min(Math.max(parseInt(v) || def, 1), 365);

// ── GET /hub/analytics?days=30 ──────────────────────────────────────────────
const getAnalytics = async (req, res) => {
  try {
    const days = clampDays(req.query.days, 30);
    const [totals, daily, templates, response] = await Promise.all([
      query(
        `SELECT
           COUNT(*) FILTER (WHERE direction = 'outbound') AS sent,
           COUNT(*) FILTER (WHERE direction = 'outbound' AND status IN ('delivered','read')) AS delivered,
           COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'read') AS read,
           COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'failed') AS failed,
           COUNT(*) FILTER (WHERE direction = 'inbound') AS received,
           COUNT(*) FILTER (WHERE direction = 'outbound' AND is_ai_generated) AS ai_replies,
           COUNT(*) FILTER (WHERE direction = 'outbound' AND is_automated) AS automated,
           COUNT(DISTINCT lead_id) FILTER (WHERE direction = 'inbound') AS leads_replied
         FROM whatsapp_messages
         WHERE tenant_id = $1 AND sent_at >= NOW() - ($2 || ' days')::interval`,
        [req.tenantId, String(days)]
      ),
      query(
        `SELECT DATE(sent_at) AS day,
                COUNT(*) FILTER (WHERE direction = 'outbound') AS sent,
                COUNT(*) FILTER (WHERE direction = 'inbound') AS received
         FROM whatsapp_messages
         WHERE tenant_id = $1 AND sent_at >= NOW() - ($2 || ' days')::interval
         GROUP BY 1 ORDER BY 1`,
        [req.tenantId, String(days)]
      ),
      // Template performance: of the leads a template went to, how many replied afterwards
      query(
        `SELECT m.template_name,
                COUNT(*) AS sent,
                COUNT(*) FILTER (WHERE m.status IN ('delivered','read')) AS delivered,
                COUNT(*) FILTER (WHERE m.status = 'read') AS read,
                COUNT(*) FILTER (WHERE m.status = 'failed') AS failed,
                COUNT(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM whatsapp_messages r
                  WHERE r.lead_id = m.lead_id AND r.direction = 'inbound' AND r.sent_at > m.sent_at
                    AND r.sent_at < m.sent_at + INTERVAL '3 days')) AS replied
         FROM whatsapp_messages m
         WHERE m.tenant_id = $1 AND m.direction = 'outbound' AND m.message_type = 'template'
           AND m.template_name IS NOT NULL AND m.sent_at >= NOW() - ($2 || ' days')::interval
         GROUP BY m.template_name ORDER BY sent DESC LIMIT 20`,
        [req.tenantId, String(days)]
      ),
      // Median time from an inbound message to the next outbound reply, for chats in the window
      query(
        `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY secs) AS median_seconds FROM (
           SELECT EXTRACT(EPOCH FROM (
             (SELECT MIN(o.sent_at) FROM whatsapp_messages o
              WHERE o.lead_id = i.lead_id AND o.direction = 'outbound' AND o.sent_at > i.sent_at) - i.sent_at)) AS secs
           FROM whatsapp_messages i
           WHERE i.tenant_id = $1 AND i.direction = 'inbound' AND i.sent_at >= NOW() - ($2 || ' days')::interval
         ) x WHERE secs IS NOT NULL AND secs < 86400`,
        [req.tenantId, String(days)]
      ),
    ]);

    const t = totals.rows[0];
    const n = (v) => parseInt(v) || 0;
    const sent = n(t.sent);
    res.json({
      days,
      totals: {
        sent, delivered: n(t.delivered), read: n(t.read), failed: n(t.failed), received: n(t.received),
        ai_replies: n(t.ai_replies), automated: n(t.automated), leads_replied: n(t.leads_replied),
        delivery_rate: sent ? Math.round((n(t.delivered) / sent) * 100) : 0,
        read_rate: sent ? Math.round((n(t.read) / sent) * 100) : 0,
      },
      median_response_seconds: response.rows[0]?.median_seconds != null ? Math.round(response.rows[0].median_seconds) : null,
      daily: daily.rows.map(r => ({ day: r.day, sent: n(r.sent), received: n(r.received) })),
      templates: templates.rows.map(r => ({
        template_name: r.template_name, sent: n(r.sent), delivered: n(r.delivered), read: n(r.read),
        failed: n(r.failed), replied: n(r.replied),
        reply_rate: n(r.sent) ? Math.round((n(r.replied) / n(r.sent)) * 100) : 0,
      })),
    });
  } catch (e) { console.error('getAnalytics:', e.message); res.status(500).json({ error: 'Failed to load analytics.' }); }
};

// ── GET /hub/broadcasts?days=90 ─────────────────────────────────────────────
// Broadcast sends are stored as outbound template messages, so history is
// grouped from those: one row per template, sender and hour.
const getBroadcastHistory = async (req, res) => {
  try {
    const days = clampDays(req.query.days, 90);
    const result = await query(
      `SELECT m.template_name, DATE_TRUNC('hour', m.sent_at) AS sent_hour, u.name AS sent_by_name,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE m.status IN ('delivered','read')) AS delivered,
              COUNT(*) FILTER (WHERE m.status = 'read') AS read,
              COUNT(*) FILTER (WHERE m.status = 'failed') AS failed,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM whatsapp_messages r
                WHERE r.lead_id = m.lead_id AND r.direction = 'inbound' AND r.sent_at > m.sent_at
                  AND r.sent_at < m.sent_at + INTERVAL '3 days')) AS replied
       FROM whatsapp_messages m
       LEFT JOIN users u ON u.id = m.sent_by
       WHERE m.tenant_id = $1 AND m.direction = 'outbound' AND m.message_type = 'template'
         AND COALESCE(m.is_automated, false) = false AND m.template_name IS NOT NULL
         AND m.sent_at >= NOW() - ($2 || ' days')::interval
       GROUP BY m.template_name, sent_hour, u.name
       ORDER BY sent_hour DESC LIMIT 100`,
      [req.tenantId, String(days)]
    );
    const n = (v) => parseInt(v) || 0;
    res.json({
      days,
      broadcasts: result.rows.map(r => ({
        template_name: r.template_name, sent_at: r.sent_hour, sent_by_name: r.sent_by_name,
        total: n(r.total), delivered: n(r.delivered), read: n(r.read), failed: n(r.failed), replied: n(r.replied),
      })),
    });
  } catch (e) { console.error('getBroadcastHistory:', e.message); res.status(500).json({ error: 'Failed to load broadcast history.' }); }
};

// ── GET /hub/optins ─────────────────────────────────────────────────────────
const getOptIns = async (req, res) => {
  try {
    const settings = await getSettings(req.tenantId);
    const base = { require_opt_in: !!settings.whatsapp_require_opt_in };

    const optedOut = await query(
      `SELECT id, name, phone, opted_out_at FROM leads
       WHERE tenant_id = $1 AND opted_out = true ORDER BY opted_out_at DESC NULLS LAST LIMIT 200`,
      [req.tenantId]
    );
    const counts = await query(
      `SELECT COUNT(*) FILTER (WHERE opted_out) AS opted_out, COUNT(*) AS total FROM leads WHERE tenant_id = $1`,
      [req.tenantId]
    );

    let optedIn = [], optInCount = 0, needsMigration = false;
    try {
      const r = await query(
        `SELECT id, name, phone, whatsapp_opt_in_at, whatsapp_opt_in_source FROM leads
         WHERE tenant_id = $1 AND whatsapp_opt_in_at IS NOT NULL AND opted_out = false
         ORDER BY whatsapp_opt_in_at DESC LIMIT 200`,
        [req.tenantId]
      );
      optedIn = r.rows;
      optInCount = (await query(
        'SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND whatsapp_opt_in_at IS NOT NULL AND opted_out = false',
        [req.tenantId]
      )).rows[0].count;
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
      needsMigration = true;
    }

    res.json({
      ...base, needs_migration: needsMigration,
      summary: { total: parseInt(counts.rows[0].total), opted_in: parseInt(optInCount), opted_out: parseInt(counts.rows[0].opted_out) },
      opted_in: optedIn, opted_out: optedOut.rows,
    });
  } catch (e) { console.error('getOptIns:', e.message); res.status(500).json({ error: 'Failed to load opt-ins.' }); }
};

// ── POST /hub/optins { lead_ids?, phones?, action: 'opt_in' | 'opt_out', source? } ──
const updateOptIns = async (req, res) => {
  try {
    const { lead_ids, phones, action, source } = req.body;
    if (!['opt_in', 'opt_out'].includes(action)) return res.status(400).json({ error: 'action must be opt_in or opt_out.' });

    const ids = Array.isArray(lead_ids) ? lead_ids : [];
    const phoneList = (Array.isArray(phones) ? phones : []).map(p => String(p).replace(/\D/g, '')).filter(Boolean).slice(0, 2000);
    if (!ids.length && !phoneList.length) return res.status(400).json({ error: 'Provide lead_ids or phones.' });

    const match = `tenant_id = $1 AND (id = ANY($2::uuid[]) OR regexp_replace(phone, '\\D', '', 'g') = ANY($3::text[])
                   OR RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = ANY($3::text[]))`;
    const params = [req.tenantId, ids, phoneList.map(p => (p.length > 10 ? p.slice(-10) : p))];

    let result;
    try {
      result = action === 'opt_in'
        ? await query(
            `UPDATE leads SET whatsapp_opt_in_at = NOW(), whatsapp_opt_in_source = $4, opted_out = false, opted_out_at = NULL
             WHERE ${match}`, [...params, (source || 'manual').slice(0, 50)])
        : await query(`UPDATE leads SET opted_out = true, opted_out_at = NOW() WHERE ${match}`, params);
    } catch (e) {
      if (isMissingSchema(e)) return res.status(409).json({ error: 'Opt-in tracking needs the database migration (migration_whatsapp_hub.sql) first.', needs_migration: true });
      throw e;
    }
    res.json({ updated: result.rowCount });
  } catch (e) { console.error('updateOptIns:', e.message); res.status(500).json({ error: 'Failed to update opt-ins.' }); }
};

// ── PUT /hub/optin-settings { require_opt_in } ──────────────────────────────
const updateOptInSettings = async (req, res) => {
  try {
    await saveSettings(req.tenantId, { whatsapp_require_opt_in: !!req.body.require_opt_in });
    res.json({ require_opt_in: !!req.body.require_opt_in });
  } catch (e) { console.error('updateOptInSettings:', e.message); res.status(500).json({ error: 'Failed to save.' }); }
};

// ── GET /hub/numbers ────────────────────────────────────────────────────────
const getNumbers = async (req, res) => {
  try {
    const settings = await getSettings(req.tenantId);
    const shared = {
      configured: !!(settings.whatsapp_phone_number_id && settings.whatsapp_access_token),
      phone_number_id: settings.whatsapp_phone_number_id || null,
      display_number: settings.whatsapp_display_number || null,
      verified_name: settings.whatsapp_verified_name || null,
      waba_id: settings.whatsapp_business_account_id || null,
      live: null, live_error: null,
    };

    if (shared.configured) {
      try {
        const { data } = await axios.get(`${META_API_URL}/${shared.phone_number_id}`, {
          params: {
            fields: 'verified_name,display_phone_number,quality_rating,messaging_limit_tier,code_verification_status,name_status',
            access_token: settings.whatsapp_access_token,
          },
          timeout: 10000,
        });
        shared.live = data;
      } catch (e) { shared.live_error = e.response?.data?.error?.message || e.message; }
    }

    const reps = await query(
      `SELECT id, name, whatsapp_phone_number_id FROM users
       WHERE tenant_id = $1 AND whatsapp_phone_number_id IS NOT NULL AND is_active = true ORDER BY name`,
      [req.tenantId]
    );
    res.json({ shared, rep_numbers: reps.rows });
  } catch (e) { console.error('getNumbers:', e.message); res.status(500).json({ error: 'Failed to load numbers.' }); }
};

// ── GET /hub/ctwa?days=30 ───────────────────────────────────────────────────
const getClickToWhatsApp = async (req, res) => {
  try {
    const days = clampDays(req.query.days, 30);
    const [summary, byCampaign, recent] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE campaign_id IS NULL) AS unattributed,
                COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('day', NOW())) AS today
         FROM leads WHERE tenant_id = $1 AND source = 'whatsapp' AND meta_ad_id IS NOT NULL
           AND created_at >= NOW() - ($2 || ' days')::interval`,
        [req.tenantId, String(days)]
      ),
      query(
        `SELECT c.id AS campaign_id, c.name AS campaign_name, COUNT(l.id) AS leads,
                COUNT(l.id) FILTER (WHERE l.lead_score = 'hot') AS hot,
                COUNT(l.id) FILTER (WHERE l.stage IN (SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) AS won,
                c.actual_spend
         FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id
         WHERE l.tenant_id = $1 AND l.source = 'whatsapp' AND l.meta_ad_id IS NOT NULL
           AND l.created_at >= NOW() - ($2 || ' days')::interval
         GROUP BY c.id, c.name, c.actual_spend ORDER BY leads DESC LIMIT 50`,
        [req.tenantId, String(days)]
      ),
      query(
        `SELECT l.id, l.name, l.phone, l.stage, l.created_at, l.source_detail, c.name AS campaign_name
         FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id
         WHERE l.tenant_id = $1 AND l.source = 'whatsapp' AND l.meta_ad_id IS NOT NULL
         ORDER BY l.created_at DESC LIMIT 25`,
        [req.tenantId]
      ),
    ]);
    const n = (v) => parseInt(v) || 0;
    const s = summary.rows[0];
    res.json({
      days,
      summary: { total: n(s.total), unattributed: n(s.unattributed), today: n(s.today) },
      campaigns: byCampaign.rows.map(r => {
        const leads = n(r.leads); const spend = parseFloat(r.actual_spend) || 0;
        return {
          campaign_id: r.campaign_id, campaign_name: r.campaign_name || 'Unattributed', leads,
          hot: n(r.hot), won: n(r.won), spend, cost_per_lead: leads && spend ? +(spend / leads).toFixed(2) : null,
        };
      }),
      recent: recent.rows,
    });
  } catch (e) { console.error('getClickToWhatsApp:', e.message); res.status(500).json({ error: 'Failed to load Click-to-WhatsApp leads.' }); }
};

// ── Auto messages (welcome + away) ──────────────────────────────────────────
const AUTO_KEYS = ['whatsapp_auto_responder_enabled', 'whatsapp_auto_responder_message',
  'whatsapp_away_enabled', 'whatsapp_away_message', 'whatsapp_business_hours'];

const getAutoMessages = async (req, res) => {
  try {
    const s = await getSettings(req.tenantId);
    res.json({
      welcome_enabled: !!s.whatsapp_auto_responder_enabled,
      welcome_message: s.whatsapp_auto_responder_message || '',
      away_enabled: !!s.whatsapp_away_enabled,
      away_message: s.whatsapp_away_message || '',
      business_hours: s.whatsapp_business_hours || { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5, 6], timezone: 'Asia/Kolkata' },
    });
  } catch (e) { console.error('getAutoMessages:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const updateAutoMessages = async (req, res) => {
  try {
    const { welcome_enabled, welcome_message, away_enabled, away_message, business_hours } = req.body;
    const patch = {};
    if (welcome_enabled !== undefined) patch.whatsapp_auto_responder_enabled = !!welcome_enabled;
    if (welcome_message !== undefined) patch.whatsapp_auto_responder_message = String(welcome_message).slice(0, 1000);
    if (away_enabled !== undefined) patch.whatsapp_away_enabled = !!away_enabled;
    if (away_message !== undefined) patch.whatsapp_away_message = String(away_message).slice(0, 1000);
    if (business_hours) {
      const ok = /^\d{2}:\d{2}$/.test(business_hours.start || '') && /^\d{2}:\d{2}$/.test(business_hours.end || '')
        && Array.isArray(business_hours.days);
      if (!ok) return res.status(400).json({ error: 'Invalid business hours.' });
      patch.whatsapp_business_hours = {
        start: business_hours.start, end: business_hours.end,
        days: business_hours.days.map(Number).filter(d => d >= 0 && d <= 6),
        timezone: business_hours.timezone || 'Asia/Kolkata',
      };
    }
    if (patch.whatsapp_away_enabled && !(patch.whatsapp_away_message || (await getSettings(req.tenantId)).whatsapp_away_message)) {
      return res.status(400).json({ error: 'Write the away message before turning it on.' });
    }
    await saveSettings(req.tenantId, patch);
    res.json({ ok: true });
  } catch (e) { console.error('updateAutoMessages:', e.message); res.status(500).json({ error: 'Failed to save.' }); }
};

// ── AI auto-reply training ──────────────────────────────────────────────────
const KNOWLEDGE_FIELDS = ['about', 'services_prices', 'faqs', 'tone', 'goal', 'never_say', 'handoff_rules', 'example_chats'];

const getAiKnowledge = async (req, res) => {
  try {
    const s = await getSettings(req.tenantId);
    res.json({ enabled: !!s.ai_qualification_enabled, knowledge: s.ai_knowledge || {} });
  } catch (e) { console.error('getAiKnowledge:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const updateAiKnowledge = async (req, res) => {
  try {
    const { enabled, knowledge } = req.body;
    const patch = {};
    if (enabled !== undefined) patch.ai_qualification_enabled = !!enabled;
    if (knowledge && typeof knowledge === 'object') {
      patch.ai_knowledge = {};
      for (const k of KNOWLEDGE_FIELDS) patch.ai_knowledge[k] = String(knowledge[k] || '').slice(0, 4000);
    }
    await saveSettings(req.tenantId, patch);
    res.json({ ok: true });
  } catch (e) { console.error('updateAiKnowledge:', e.message); res.status(500).json({ error: 'Failed to save.' }); }
};

// Recent AI replies for review (helps the owner spot bad answers and add examples)
const getAiReplies = async (req, res) => {
  try {
    const r = await query(
      `SELECT m.id, m.lead_id, l.name AS lead_name, m.message AS reply, m.sent_at,
              (SELECT i.message FROM whatsapp_messages i
               WHERE i.lead_id = m.lead_id AND i.direction = 'inbound' AND i.sent_at < m.sent_at
               ORDER BY i.sent_at DESC LIMIT 1) AS lead_message
       FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id
       WHERE m.tenant_id = $1 AND m.direction = 'outbound' AND m.is_ai_generated = true
       ORDER BY m.sent_at DESC LIMIT 20`,
      [req.tenantId]
    );
    res.json({ replies: r.rows });
  } catch (e) { console.error('getAiReplies:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

// ── Scheduled broadcasts ────────────────────────────────────────────────────
const getScheduledBroadcasts = async (req, res) => {
  try {
    const r = await query(
      `SELECT b.id, b.template_name, b.scheduled_at, b.status, b.sent_count, b.failed_count, b.error,
              cardinality(b.lead_ids) AS lead_count, u.name AS created_by_name
       FROM whatsapp_scheduled_broadcasts b LEFT JOIN users u ON u.id = b.created_by
       WHERE b.tenant_id = $1 AND (b.status IN ('pending','sending') OR b.completed_at > NOW() - INTERVAL '14 days' OR b.status = 'cancelled')
       ORDER BY CASE WHEN b.status IN ('pending','sending') THEN 0 ELSE 1 END, b.scheduled_at DESC LIMIT 50`,
      [req.tenantId]
    );
    res.json({ scheduled: r.rows.map(x => ({ ...x, lead_count: parseInt(x.lead_count) })) });
  } catch (e) {
    if (isMissingSchema(e)) return res.json({ scheduled: [], needs_migration: true });
    console.error('getScheduledBroadcasts:', e.message); res.status(500).json({ error: 'Failed to load scheduled broadcasts.' });
  }
};

const cancelScheduledBroadcast = async (req, res) => {
  try {
    const r = await query(
      `UPDATE whatsapp_scheduled_broadcasts SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING id`,
      [req.params.id, req.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Only broadcasts that have not started can be cancelled.' });
    res.json({ cancelled: true });
  } catch (e) { console.error('cancelScheduledBroadcast:', e.message); res.status(500).json({ error: 'Failed to cancel.' }); }
};

module.exports = {
  getScheduledBroadcasts, cancelScheduledBroadcast,
  getAnalytics, getBroadcastHistory, getOptIns, updateOptIns, updateOptInSettings, getNumbers,
  getClickToWhatsApp, getAutoMessages, updateAutoMessages, getAiKnowledge, updateAiKnowledge, getAiReplies,
};
