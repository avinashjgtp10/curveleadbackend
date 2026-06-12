const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 requests per window
  message: { error: 'Too many attempts. Please try again after 15 minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,
  message: { error: 'Too many requests. Please slow down.' },
});

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files (uploads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/leads', apiLimiter, require('./routes/leads'));
app.use('/api/leads', apiLimiter, require('./routes/activities'));
app.use('/api/lead-stages', apiLimiter, require('./routes/leadStages'));
app.use('/api/courses', apiLimiter, require('./routes/courses'));
app.use('/api/batches', apiLimiter, require('./routes/batches'));
app.use('/api/students', apiLimiter, require('./routes/students'));
app.use('/api/attendance', apiLimiter, require('./routes/attendance'));
app.use('/api/fees', apiLimiter, require('./routes/fees'));
app.use('/api/staff', apiLimiter, require('./routes/staff'));
app.use('/api/expenses', apiLimiter, require('./routes/expenses'));
app.use('/api/salary', apiLimiter, require('./routes/salary'));
app.use('/api/reports', apiLimiter, require('./routes/reports'));
app.use('/api/super-admin', apiLimiter, require('./routes/superAdmin'));
app.use('/api/settings', apiLimiter, require('./routes/settings'));
app.use('/api/templates', apiLimiter, require('./routes/templates'));
app.use('/api/quotations', apiLimiter, require('./routes/quotations'));
app.use('/api/brochures', apiLimiter, require('./routes/brochures'));
app.use('/api/notes', apiLimiter, require('./routes/notes'));
app.use('/api/attachments', apiLimiter, require('./routes/attachments'));
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/billing', apiLimiter, require('./routes/billing'));
app.use('/api/notifications', apiLimiter, require('./routes/notifications'));
app.use('/api/dashboard', apiLimiter, require('./routes/dashboard'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'CurveLead API', version: '1.0.0' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   CurveLead API Server               ║
  ║   Running on port ${PORT}               ║
  ║   Environment: ${process.env.NODE_ENV || 'development'}       ║
  ╚═══════════════════════════════════════╝
  `);
});

module.exports = app;
