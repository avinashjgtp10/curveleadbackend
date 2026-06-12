const errorHandler = (err, req, res, next) => {
  console.error('❌ Error:', {
    message: err.message,
    path: req.path,
    method: req.method,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  // CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }

  // PG unique violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Duplicate entry. Resource already exists.' });
  }

  // PG foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced resource not found.' });
  }

  // PG not null violation
  if (err.code === '23502') {
    return res.status(400).json({ error: 'Required field is missing.' });
  }

  // Default
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
