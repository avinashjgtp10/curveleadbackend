// Global API rate limiting, split in two budgets so background polling can never starve foreground work:
//   foreground  = everything a person does (loading leads, saving, searching)
//   background  = cheap GETs the UI polls on a timer (unread counts, inbox/conversation refresh, health, sync status)
// Both are keyed per logged-in user (a whole office behind one IP must not share a bucket); unauthenticated
// traffic is keyed by IP. When a request is limited the client gets a clear message, Retry-After, and the
// server logs ONE structured line per key per window, so the next occurrence names its cause.
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const WINDOW_MS = 15 * 60 * 1000;

// GET-only, read-only endpoints that the web UI polls. Anything not listed here is foreground.
const BACKGROUND_GET = [
  /^\/api\/notifications(\/count)?$/,
  /^\/api\/whatsapp\/(unread-count|inbox)$/,
  /^\/api\/whatsapp\/conversation\/[^/]+$/,
  /^\/api\/integrations\/facebook\/sync-status$/,
  /^\/api\/features\/health$/,
  /^\/api\/cohort\/health$/,
];
const isBackgroundPoll = (req) => req.method === 'GET' && BACKGROUND_GET.some((re) => re.test((req.originalUrl || req.url).split('?')[0]));

const userIdFrom = (req) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  try { return jwt.verify(auth.slice(7), process.env.JWT_SECRET).userId || null; } catch { return null; }
};

const envInt = (env, name, fallback) => { const n = parseInt(env[name], 10); return n > 0 ? n : fallback; };

const humanWait = (s) => (s < 90 ? `${s} second${s === 1 ? '' : 's'}` : `${Math.ceil(s / 60)} minutes`);

function createApiLimiter({ env = process.env, log = console.warn, now = Date.now } = {}) {
  const userMax = envInt(env, 'RATE_LIMIT_USER_MAX', 2000);
  const ipMax = envInt(env, 'RATE_LIMIT_IP_MAX', 500);
  const bgUserMax = envInt(env, 'RATE_LIMIT_BACKGROUND_USER_MAX', 3000);

  const logged = new Map(); // key -> window end; log once per key per window
  const logOnce = (req, bucket, key, limit, resetAt) => {
    const t = now();
    if ((logged.get(`${bucket}|${key}`) || 0) > t) return;
    logged.set(`${bucket}|${key}`, resetAt);
    if (logged.size > 5000) for (const [k, end] of logged) if (end <= t) logged.delete(k);
    log(JSON.stringify({ evt: 'rate_limited', bucket, key, limit, method: req.method, path: (req.originalUrl || req.url).split('?')[0].slice(0, 120) }));
  };

  const make = (bucket, skip) => {
    const limiter = rateLimit({
      windowMs: WINDOW_MS,
      limit: (req) => (userIdFrom(req) ? (bucket === 'background' ? bgUserMax : userMax) : ipMax),
      keyGenerator: (req) => { const id = userIdFrom(req); return id ? `user:${id}` : `ip:${req.ip}`; },
      standardHeaders: true,   // RateLimit-* and Retry-After
      legacyHeaders: false,
      skip,
      handler: (req, res) => {
        const resetAt = req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).getTime() : now() + WINDOW_MS;
        const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now()) / 1000));
        logOnce(req, bucket, userIdFrom(req) ? `user:${userIdFrom(req)}` : `ip:${req.ip}`, req.rateLimit?.limit, resetAt);
        res.set('Retry-After', String(retryAfterSeconds));
        res.status(429).json({ error: `Too many requests. Please try again in ${humanWait(retryAfterSeconds)}.`, code: 'RATE_LIMITED', retryAfterSeconds });
      },
    });
    return limiter;
  };

  const foreground = make('foreground', isBackgroundPoll);
  const background = make('background', (req) => !isBackgroundPoll(req));
  // One middleware, mounted exactly where apiLimiter was.
  return (req, res, next) => (isBackgroundPoll(req) ? background(req, res, next) : foreground(req, res, next));
}

module.exports = { createApiLimiter, isBackgroundPoll, BACKGROUND_GET };
