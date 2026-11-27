const { query } = require('../config/db');
const { isExpoToken } = require('../services/pushNotifications');
const { isSchemaError, migrationFor } = require('../utils/schemaErrors');
const { NOTIFICATION_GROUPS, isNotificationEnabled, shouldSkipForLostLead } = require('../utils/notificationTypes');

// GET /api/notifications - Get user's notifications
const getNotifications = async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM notifications WHERE tenant_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [req.tenantId, req.user.id]
    );

    const unreadCount = await query(
      `SELECT COUNT(*) FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND is_read = false`,
      [req.tenantId, req.user.id]
    );

    res.json({ notifications: result.rows, unreadCount: parseInt(unreadCount.rows[0].count) });
  } catch (error) { console.error('Get notifications error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/notifications/:id/read - Mark as read
const markAsRead = async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
      [req.params.id, req.tenantId, req.user.id]
    );
    res.json({ message: 'Marked as read.' });
  } catch (error) { console.error('Mark notification read error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/notifications/read-all - Mark all as read
const markAllAsRead = async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET is_read = true WHERE tenant_id = $1 AND user_id = $2 AND is_read = false',
      [req.tenantId, req.user.id]
    );
    res.json({ message: 'All marked as read.' });
  } catch (error) { console.error('Mark all notifications read error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/notifications/read-visible - Mark a given set of notifications as read
// (called by the bell dropdown for whatever's currently visible/unread on screen)
const markVisibleAsRead = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (ids.length) {
      await query(
        'UPDATE notifications SET is_read = true WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])',
        [req.tenantId, req.user.id, ids]
      );
    }
    res.json({ message: 'Marked as read.' });
  } catch (error) { console.error('Mark visible notifications read error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/notifications/count - Unread count only
const getUnreadCount = async (req, res) => {
  try {
    const result = await query(
      'SELECT COUNT(*) FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND is_read = false',
      [req.tenantId, req.user.id]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) { console.error('Get unread count error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// Helper: Create notification — skipped if the target user has turned this
// notification group off (Notification Settings). A missing/unrecognized type
// is never silently dropped — see isNotificationEnabled's default-enabled fallback.
const createNotification = async (tenantId, userId, title, message, type = 'info', referenceType = null, referenceId = null) => {
  try {
    const userResult = await query('SELECT settings FROM users WHERE id = $1', [userId]);
    const userSettings = userResult.rows[0]?.settings;
    if (!isNotificationEnabled(userSettings, type)) return;

    if (referenceType === 'lead' && referenceId && shouldSkipForLostLead(userSettings, type)) {
      const leadIsLost = await query(
        `SELECT 1 FROM leads l WHERE l.id = $1 AND l.tenant_id = $2
           AND LOWER(l.stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $2 AND is_lost = true)`,
        [referenceId, tenantId]
      );
      if (leadIsLost.rows.length) return;
    }

    await query(
      `INSERT INTO notifications (tenant_id, user_id, title, message, type, reference_type, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, userId, title, message, type, referenceType, referenceId]
    );
  } catch (error) { console.error('Create notification error:', error); }
};

// Notifies every active admin in the tenant that a new lead came in, from any source.
// excludeUserId skips the admin who just created it themselves (manual lead entry).
const notifyNewLeadToAdmins = async (tenantId, lead, excludeUserId = null) => {
  try {
    const admins = await query(
      `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true${excludeUserId ? ' AND id != $2' : ''}`,
      excludeUserId ? [tenantId, excludeUserId] : [tenantId]
    );
    const source = (lead.source || 'manual').replace(/_/g, ' ');
    await Promise.all(admins.rows.map(a =>
      createNotification(tenantId, a.id, 'New lead', `${lead.name} — from ${source}`, 'new_lead', 'lead', lead.id)
    ));
  } catch (error) { console.error('Notify admins new lead error:', error); }
};

// GET /api/notifications/groups — static list of togglable notification groups,
// for the Notification Settings UI (kept here so backend and frontend never drift).
const getNotificationGroups = (req, res) => {
  res.json({ groups: NOTIFICATION_GROUPS.map(({ key, label, description }) => ({ key, label, description })) });
};

// POST /api/notifications/push-tokens - remember this phone so it can receive pushes. A token belongs to whoever
// signed in on the phone last, so it moves to the new user when someone else logs in on the same device.
const registerPushToken = async (req, res) => {
  try {
    const { token, platform, device_id } = req.body || {};
    if (!isExpoToken(token)) return res.status(422).json({ error: 'A valid Expo push token is required.' });
    await query(
      `INSERT INTO push_tokens (tenant_id, user_id, token, platform, device_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, user_id = EXCLUDED.user_id,
         platform = EXCLUDED.platform, device_id = EXCLUDED.device_id, updated_at = NOW()`,
      [req.tenantId, req.user.id, token, ['ios', 'android'].includes(platform) ? platform : null, device_id ? String(device_id).slice(0, 255) : null]
    );
    res.json({ message: 'Push token saved.' });
  } catch (error) {
    // Still a 500 (the token was not saved), but the log now names the cause. 42P01 = push_tokens table missing.
    console.error('Register push token error:', error.code, error.message);
    if (isSchemaError(error)) console.error(`MIGRATION_PENDING: run ${migrationFor(error) || 'models/migration_push_notifications.sql'}`);
    res.status(500).json({ error: 'Could not save the push token.' });
  }
};

// DELETE /api/notifications/push-tokens - stop pushing to this phone. Deliberately works without a login: the app
// calls it while signing out, when its session is already gone, and the token itself is the secret.
const unregisterPushToken = async (req, res) => {
  try {
    const token = req.body && req.body.token;
    if (!isExpoToken(token)) return res.status(422).json({ error: 'A valid Expo push token is required.' });
    await query('DELETE FROM push_tokens WHERE token = $1', [token]);
    res.json({ message: 'Push token removed.' });
  } catch (error) { console.error('Unregister push token error:', error); res.status(500).json({ error: 'Could not remove the push token.' }); }
};

module.exports = {
  registerPushToken, unregisterPushToken,
  getNotifications, markAsRead, markAllAsRead, markVisibleAsRead, getUnreadCount, getNotificationGroups,
  createNotification, notifyNewLeadToAdmins,
};
