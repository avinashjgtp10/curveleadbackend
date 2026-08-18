require('dotenv').config({ override: true });

// Meta App ID is not secret (it's embedded in client-side Facebook SDK calls),
// so it's safe to log in full. This makes prod/env drift on the Facebook
// integration ("Invalid Client ID" from Graph API) visible in pm2 logs at boot.
console.log(
  `[startup] META_APP_ID=${process.env.META_APP_ID || '(not set)'} ` +
  `META_APP_SECRET=${process.env.META_APP_SECRET ? 'set (' + process.env.META_APP_SECRET.length + ' chars)' : '(not set)'}`
);

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3002;

// ============================================
// Create upload directories
// ============================================
['public/uploads/leads', 'public/uploads/brochures'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Trust Nginx reverse proxy (fixes express-rate-limit X-Forwarded-For warning)
app.set('trust proxy', 1);

// ============================================
// Security middleware
// ============================================
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// CORS - parse from env
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174,https://www.curvelead.com,https://curvelead.com')
  .split(',').map(o => o.trim()).filter(Boolean);

// Endpoints meant to be embedded on arbitrary third-party business websites
// (e.g. the lead-capture widget from /api/integrations/embed-script) must accept
// any origin — they're authenticated by API key in a header, not by cookies.
const PUBLIC_CORS_PATHS = ['/api/integrations/ingest'];

app.use(cors((req, callback) => {
  if (PUBLIC_CORS_PATHS.includes(req.path)) {
    return callback(null, { origin: true, credentials: false });
  }
  callback(null, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        console.warn(`CORS blocked: ${origin}`);
        cb(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  });
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Serve uploaded files
app.use('/uploads', require('express').static(require('path').join(__dirname, 'public/uploads')));
app.use('/uploads', require('express').static(require('path').join(__dirname, 'uploads')));


// ============================================
// Rate limiting
// ============================================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: { error: 'Too many requests, please try again later.' },
});

// ============================================
// Health check (no rate limit)
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'CurveLead API',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// API Routes
// ============================================
app.use('/api/auth', apiLimiter, require('./routes/auth'));
app.use('/api/leads', apiLimiter, require('./routes/leads'));
app.use('/api/followups', apiLimiter, require('./routes/followups'));
app.use('/api/staff', apiLimiter, require('./routes/staff'));
app.use('/api/campaigns', apiLimiter, require('./routes/campaigns'));
app.use('/api/whatsapp', apiLimiter, require('./routes/whatsapp'));
app.use('/api/ai', apiLimiter, require('./routes/ai'));
app.use('/api/reports', apiLimiter, require('./routes/reports'));
app.use('/api/settings', apiLimiter, require('./routes/settings'));
app.use('/api/payments', apiLimiter, require('./routes/payments'));
app.use('/api/super-admin', apiLimiter, require('./routes/superAdmin'));
app.use('/api/webhook', require('./routes/webhook')); // No rate limit - external service
app.use('/api/integrations', apiLimiter, require('./routes/integrations'));

app.use('/api/lead-stages',    apiLimiter, require('./routes/leadStages'));
app.use('/api/lead-statuses', apiLimiter, require('./routes/leadStatuses'));
app.use('/api/notes', apiLimiter, require('./routes/notes'));
app.use('/api/attachments', apiLimiter, require('./routes/attachments'));
app.use('/api/brochures', apiLimiter, require('./routes/brochures'));
app.use('/api/quotations', apiLimiter, require('./routes/quotations'));
app.use('/api/templates', apiLimiter, require('./routes/templates'));
app.use('/api/notifications', apiLimiter, require('./routes/notifications'));
app.use('/api/recordings', apiLimiter, require('./routes/recordings'));
app.use('/api/ai-calling', apiLimiter, require('./routes/aiCalling'));
app.use('/api/playbook', apiLimiter, require('./routes/playbook'));
app.use('/api/automations', apiLimiter, require('./routes/automations'));
app.use('/api/teams', apiLimiter, require('./routes/teams'));

// ============================================
// 404 handler
// ============================================
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// Global error handler
app.use(require('./middleware/errorHandler'));

// ============================================
// Start server
// ============================================
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   🚀 CurveLead API V2                    ║
  ║   Running on port ${PORT}                    ║
  ║   Environment: ${process.env.NODE_ENV || 'development'}             ║
  ║   Features: Notes, Files, Brochures,      ║
  ║             Quotations + AI + WhatsApp    ║
  ╚═══════════════════════════════════════════╝
  `);

  // Follow-up reminder job — runs every 15 minutes
  const { runFollowupReminder } = require('./jobs/followupReminder');
  setTimeout(runFollowupReminder, 15 * 1000);          // first run 15s after boot
  setInterval(runFollowupReminder, 15 * 60 * 1000);    // then every 15 min

  // Sales playbook generation — batch job, run daily (not time-sensitive)
  const { runPlaybookGeneration } = require('./jobs/playbookGenerator');
  setTimeout(runPlaybookGeneration, 60 * 1000);            // first run 60s after boot
  setInterval(runPlaybookGeneration, 24 * 60 * 60 * 1000); // then every 24h

  // Lead Response SLA monitor — runs every 1 minute (5-min target requires tight polling)
  const { runLeadSlaMonitor } = require('./jobs/leadSlaMonitor');
  setTimeout(runLeadSlaMonitor, 20 * 1000);
  setInterval(runLeadSlaMonitor, 60 * 1000);

  // Automation sequence runner — sends due WhatsApp/email steps, runs every 5 minutes
  const { runAutomationSequences } = require('./jobs/automationSequenceRunner');
  setTimeout(runAutomationSequences, 30 * 1000);
  setInterval(runAutomationSequences, 5 * 60 * 1000);

  // Meta ad spend/performance sync — runs every 6 hours
  const { runMetaAdInsightsSync } = require('./jobs/metaAdInsightsSync');
  setTimeout(runMetaAdInsightsSync, 45 * 1000);
  setInterval(runMetaAdInsightsSync, 6 * 60 * 60 * 1000);

  // Daily report email — polls every 15 min, only actually sends once per
  // tenant per day (inside the target UTC hour, guarded by last-sent date)
  const { runDailyReportEmail } = require('./jobs/dailyReportEmail');
  setTimeout(runDailyReportEmail, 40 * 1000);
  setInterval(runDailyReportEmail, 15 * 60 * 1000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;
