// Public mobile-app version metadata. Values come from env (SSM Parameter Store
// in deployed environments), so shipping a new Play Store build only needs a
// parameter change + `pm2 restart --update-env`, never a code deploy or migration.

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

const DEFAULT_VERSION = '1.0.0';
const DEFAULT_ANDROID_STORE_URL = 'https://play.google.com/store/apps/details?id=com.curvelead';
const DEFAULT_RELEASE_NOTES = 'Latest CurveLead app improvements and fixes.';

// Strict MAJOR.MINOR.PATCH (a leading "v" and surrounding whitespace tolerated).
// Returns [major, minor, patch] or null.
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = SEMVER_RE.exec(value.trim().replace(/^v/i, ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// -1 / 0 / 1, or null if either side is not a valid version.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function normalize(value) {
  const p = parseVersion(value);
  return p ? p.join('.') : null;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

function platformConfig(env, prefix, defaultStoreUrl) {
  let latest = normalize(env[`${prefix}_LATEST_VERSION`]) || DEFAULT_VERSION;
  let minimum = normalize(env[`${prefix}_MINIMUM_VERSION`]) || DEFAULT_VERSION;
  // A misconfigured minimum above latest would lock everyone out of an update
  // that doesn't exist yet — clamp it.
  if (compareVersions(minimum, latest) === 1) minimum = latest;
  const rawUrl = env[`${prefix}_STORE_URL`];
  const storeUrl = isHttpUrl(rawUrl) ? rawUrl.trim() : defaultStoreUrl;
  return { latestVersion: latest, minimumVersion: minimum, storeUrl };
}

function getAppVersionConfig(env = process.env) {
  const notes = typeof env.APP_RELEASE_NOTES === 'string' ? env.APP_RELEASE_NOTES.trim() : '';
  return {
    android: platformConfig(env, 'APP_ANDROID', DEFAULT_ANDROID_STORE_URL),
    // No App Store listing yet — null until APP_IOS_STORE_URL is set.
    ios: platformConfig(env, 'APP_IOS', null),
    releaseNotes: notes || DEFAULT_RELEASE_NOTES,
  };
}

module.exports = { parseVersion, compareVersions, getAppVersionConfig };
