// Mounts every auth route. apiLimiter must appear exactly ONCE on any request path: a request that passes two
// limiter mounts is counted twice and burns the user's/IP's budget at double speed (see tests/authRateLimitOnce.test.js).
module.exports = function mountAuthRoutes(app, apiLimiter) {
  app.use('/api/auth', apiLimiter, require('./auth')); // includes the Google redirect routes
  app.use('/api/v1/auth', apiLimiter, require('./googleAuth')); // GOOGLE_REDIRECT_URI uses the /api/v1 path
};
