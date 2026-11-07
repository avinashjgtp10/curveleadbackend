const { query } = require('../config/db');
const whatsapp = require('../services/whatsappService');
const { templatePlan } = require('../utils/automationPolicy');
const { substituteVars } = require('../utils/templateVars');

// "Send test to my own number": sends one step to the signed-in user's own profile phone.
// It never takes a destination from the request, never touches a lead, and writes nothing to
// any lead's conversation or activity history.
const WINDOW_NOTE = 'Free-text messages reach your phone only if you messaged the business number in the last 24 hours. Template messages always go through.';
const fail = (res, code, error, extra = {}) => res.status(code).json({ error, window_note: WINDOW_NOTE, ...extra });

const buildHandler = (deps = {}) => async (req, res) => {
  const db = deps.query || query;
  const wa = deps.whatsapp || whatsapp;
  try {
    const step = req.body?.step;
    if (!step || typeof step !== 'object' || step.channel !== 'whatsapp') return fail(res, 422, 'Only WhatsApp steps can be tested.');
    const user = (await db('SELECT id, name, email, phone FROM users WHERE id = $1 AND tenant_id = $2', [req.user.id, req.tenantId])).rows[0];
    if (!user?.phone) return fail(res, 422, 'Add your phone number to your profile first. Tests are only ever sent to your own number.', { code: 'NO_PROFILE_PHONE' });
    const settings = (await db('SELECT settings FROM tenants WHERE id = $1', [req.tenantId])).rows[0]?.settings || {};
    const { whatsapp_phone_number_id: phoneNumberId, whatsapp_access_token: accessToken, whatsapp_business_account_id: wabaId } = settings;
    if (!phoneNumberId || !accessToken) return fail(res, 422, 'WhatsApp is not connected for this workspace.', { code: 'NOT_CONNECTED' });
    const credentials = { phone_number_id: phoneNumberId, access_token: accessToken };
    const sample = { name: user.name || 'there', phone: user.phone, email: user.email || '', location: 'Sample city', source: 'Sample source', product: 'Sample product' };

    let result;
    let sentAs;
    if (step.approved_template_name) {
      const list = await wa.listMessageTemplates(wabaId, accessToken);
      if (!list?.success) return fail(res, 502, 'Could not read your templates from WhatsApp. Try again in a minute.');
      const plan = templatePlan(step, list.templates, sample, null);
      if (plan.blocked) return fail(res, 422, plan.blocked);
      result = await wa.sendTemplate(user.phone, step.approved_template_name, plan.language, plan.parameters, credentials);
      sentAs = 'template';
    } else {
      const message = substituteVars(String(step.message || ''), sample).trim();
      if (!message) return fail(res, 422, 'This step has no message to test.');
      result = await wa.sendTextMessage(user.phone, message, credentials);
      sentAs = 'text';
    }
    if (!result?.success) {
      return fail(res, result?.code === 131047 ? 422 : 502, result?.error || 'The test could not be sent.', { code: result?.code });
    }
    return res.json({ sent: true, sent_as: sentAs, to_last4: String(user.phone).replace(/\D/g, '').slice(-4), window_note: WINDOW_NOTE });
  } catch (error) {
    console.error('[AutomationTestSend]', error.message);
    return fail(res, 500, 'The test could not be sent.');
  }
};

module.exports = { WINDOW_NOTE, buildHandler, testSend: buildHandler() };
