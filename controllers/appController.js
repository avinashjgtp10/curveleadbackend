const { getAppVersionConfig } = require('../utils/appVersion');

// GET /api/app/version — public (no auth): the app checks this before login.
const getVersion = (req, res) => {
  // Short cache so a version bump propagates quickly but bursts of app launches are cheap.
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, data: getAppVersionConfig() });
};

module.exports = { getVersion };
