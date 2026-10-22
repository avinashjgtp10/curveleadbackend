const axios = require('axios');
const { query } = require('../config/db');
const { isNotificationEnabled, shouldSkipForLostLead } = require('../utils/notificationTypes');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_CHUNK = 100;
// Notifications older than this are never pushed (e.g. created while the server was down) - a "new lead" alert an hour late is noise.
const MAX_AGE_MINUTES = 15;
const BATCH_SIZE = 100;

const isExpoToken = (token) => typeof token === 'string' && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);

const sendToExpo = async (messages) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const response = await axios.post(EXPO_PUSH_URL, messages, { timeout: 30000, headers });
  return response.data?.data || [];
};

/**
 * Sends every in-app notification that hasn't been pushed yet to the phones of the user it belongs to.
 * Rows are claimed with UPDATE ... SKIP LOCKED, so two server processes never send the same notification twice.
 * Returns how many pushes were handed to Expo.
 */
const dispatchPendingPushes = async () => {
  const claimed = await query(
    `UPDATE notifications SET pushed_at = NOW()
     WHERE id IN (
       SELECT id FROM notifications
       WHERE pushed_at IS NULL AND created_at > NOW() - ($1 || ' minutes')::interval
       ORDER BY created_at ASC LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, user_id, title, message, type, reference_type, reference_id`,
    [String(MAX_AGE_MINUTES), BATCH_SIZE]
  );
  if (!claimed.rows.length) return 0;

  const userIds = [...new Set(claimed.rows.map((row) => row.user_id))];
  // Some code paths write notifications straight to the table and skip the user's Notification Settings, so the
  // switches are applied here too - whatever created the notification, a switched-off group never reaches the phone.
  const settingsRows = (await query('SELECT id, settings FROM users WHERE id = ANY($1::uuid[])', [userIds])).rows;
  const settingsByUser = new Map(settingsRows.map((row) => [row.id, row.settings]));
  const tokenRows = (await query('SELECT token, user_id FROM push_tokens WHERE user_id = ANY($1::uuid[])', [userIds])).rows;
  if (!tokenRows.length) return 0;
  const tokensByUser = new Map();
  for (const row of tokenRows) {
    if (!isExpoToken(row.token)) continue;
    if (!tokensByUser.has(row.user_id)) tokensByUser.set(row.user_id, []);
    tokensByUser.get(row.user_id).push(row.token);
  }

  const leadIds = [...new Set(claimed.rows.filter((row) => row.reference_type === 'lead' && row.reference_id).map((row) => row.reference_id))];
  const leads = new Map();
  if (leadIds.length) {
    const leadRows = await query(
      `SELECT l.id, l.name, l.phone, l.stage,
              EXISTS (SELECT 1 FROM lead_stages s WHERE s.tenant_id = l.tenant_id AND LOWER(s.name) = LOWER(l.stage) AND s.is_lost = true) AS is_lost
       FROM leads l WHERE l.id = ANY($1::uuid[])`,
      [leadIds]
    );
    for (const lead of leadRows.rows) leads.set(lead.id, lead);
  }

  const messages = [];
  const messageNotificationIds = []; // same order as `messages`, so a failed batch can be put back in the queue
  for (const row of claimed.rows) {
    const lead = row.reference_type === 'lead' ? leads.get(row.reference_id) : null;
    const userSettings = settingsByUser.get(row.user_id);
    if (!isNotificationEnabled(userSettings, row.type)) continue;
    if (lead && lead.is_lost && shouldSkipForLostLead(userSettings, row.type)) continue;
    const data = {
      notification_id: row.id,
      type: row.type,
      ...(lead ? { lead_id: lead.id, lead_name: lead.name, lead_phone: lead.phone, lead_stage: lead.stage } : {}),
    };
    for (const token of tokensByUser.get(row.user_id) || []) {
      messageNotificationIds.push(row.id);
      messages.push({
        to: token,
        title: row.title,
        body: row.message || '',
        data,
        sound: 'default',
        priority: 'high',
        channelId: 'lead-alerts',
      });
    }
  }
  if (!messages.length) return 0;

  let sent = 0;
  const deadTokens = [];
  const retryIds = new Set();
  for (let start = 0; start < messages.length; start += EXPO_CHUNK) {
    const batch = messages.slice(start, start + EXPO_CHUNK);
    try {
      const tickets = await sendToExpo(batch);
      batch.forEach((message, index) => {
        const ticket = tickets[index];
        if (ticket?.status === 'ok') sent += 1;
        else if (ticket?.details?.error === 'DeviceNotRegistered') deadTokens.push(message.to);
        else if (ticket?.status === 'error') console.error('Push rejected:', ticket.message || ticket.details?.error);
      });
    } catch (error) {
      // Expo couldn't be reached at all: put these notifications back so the next tick tries again
      // (they stop being retried once they are older than MAX_AGE_MINUTES).
      console.error('Push send failed:', error.response?.data?.errors?.[0]?.message || error.message);
      for (const id of messageNotificationIds.slice(start, start + EXPO_CHUNK)) retryIds.add(id);
    }
  }
  if (retryIds.size) await query('UPDATE notifications SET pushed_at = NULL WHERE id = ANY($1::uuid[])', [[...retryIds]]).catch(() => {});

  // The phone uninstalled the app or turned notifications off for good - stop sending to that token.
  if (deadTokens.length) await query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [deadTokens]).catch(() => {});
  return sent;
};

let running = false;
let disabled = false;
/** Safe to call on a timer: skips a tick if the previous one is still running and never throws. */
const runPushDispatcher = async () => {
  if (running || disabled) return;
  running = true;
  try { await dispatchPendingPushes(); }
  catch (error) {
    // 42703 / 42P01 = the migration hasn't been run yet. Say so once instead of failing every few seconds.
    if (error.code === '42703' || error.code === '42P01') {
      disabled = true;
      console.error('Push notifications are off: run models/migration_push_notifications.sql, then restart the server.');
    } else console.error('Push dispatcher error:', error.message);
  }
  finally { running = false; }
};

module.exports = { dispatchPendingPushes, runPushDispatcher, isExpoToken };
