require('dotenv').config();
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

// ============================================
// Security middleware
// ============================================
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// CORS - parse from env
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174,https://www.curvelead.com,https://curvelead.com')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
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

app.use('/api/lead-stages', apiLimiter, require('./routes/leadStages'));
app.use('/api/notes', apiLimiter, require('./routes/notes'));
app.use('/api/attachments', apiLimiter, require('./routes/attachments'));
app.use('/api/brochures', apiLimiter, require('./routes/brochures'));
app.use('/api/quotations', apiLimiter, require('./routes/quotations'));
app.use('/api/templates', apiLimiter, require('./routes/templates'));
app.use('/api/notifications', apiLimiter, require('./routes/notifications'));

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
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;
