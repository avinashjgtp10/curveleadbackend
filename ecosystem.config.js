module.exports = {
  apps: [{
    name: 'curvelead-api',
    script: './bootstrap.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    max_restarts: 10,
    // This app only ever runs under PM2 in production — local dev uses
    // `npm run dev` (nodemon) directly, never PM2 — so one env block, not a
    // dev/prod split that `pm2 restart --update-env` was never activating anyway.
    env: {
      NODE_ENV: 'production',
      AWS_REGION: 'ap-south-1',
    },
    error_file: '/home/ubuntu/.pm2/logs/curvelead-api-error.log',
    out_file: '/home/ubuntu/.pm2/logs/curvelead-api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
