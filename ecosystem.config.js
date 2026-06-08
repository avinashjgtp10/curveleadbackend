module.exports = {
  apps: [{
    name: 'curvelead-api',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    max_restarts: 10,
    env: {
      NODE_ENV: 'development',
    },
    env_production: {
      NODE_ENV: 'production',
    },
    error_file: '/home/ubuntu/.pm2/logs/curvelead-api-error.log',
    out_file: '/home/ubuntu/.pm2/logs/curvelead-api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
