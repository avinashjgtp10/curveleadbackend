const { query } = require('../config/db');

// Workspace country / currency / timezone (tenants.settings). Defaults keep existing
// India workspaces unchanged.
const DEFAULT_LOCALE = { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' };

const validTimezone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

const localeFromSettings = (settings = {}) => ({
  country: /^[A-Z]{2}$/.test(settings.country || '') ? settings.country : DEFAULT_LOCALE.country,
  currency: /^[A-Z]{3}$/.test(settings.currency || '') ? settings.currency : DEFAULT_LOCALE.currency,
  timezone: settings.timezone && validTimezone(settings.timezone) ? settings.timezone : DEFAULT_LOCALE.timezone,
});

const getWorkspaceLocale = async (tenantId, db = { query }) =>
  localeFromSettings((await db.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]?.settings || {});

module.exports = { DEFAULT_LOCALE, localeFromSettings, getWorkspaceLocale, validTimezone };
