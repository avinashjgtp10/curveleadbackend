const { query } = require('../config/db');

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
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/notifications/:id/read - Mark as read
const markAsRead = async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
      [req.params.id, req.tenantId, req.user.id]
    );
    res.json({ message: 'Marked as read.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/notifications/read-all - Mark all as read
const markAllAsRead = async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET is_read = true WHERE tenant_id = $1 AND user_id = $2 AND is_read = false',
      [req.tenantId, req.user.id]
    );
    res.json({ message: 'All marked as read.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/notifications/count - Unread count only
const getUnreadCount = async (req, res) => {
  try {
    const result = await query(
      'SELECT COUNT(*) FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND is_read = false',
      [req.tenantId, req.user.id]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// Helper: Create notification
const createNotification = async (tenantId, userId, title, message, type = 'info', referenceType = null, referenceId = null) => {
  try {
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

module.exports = { getNotifications, markAsRead, markAllAsRead, getUnreadCount, createNotification, notifyNewLeadToAdmins };
