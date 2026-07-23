module.exports = {
  apps: [
    {
      name: 'lando-gifts',
      script: 'src/server.js',
      cwd: __dirname,
      autorestart: true,        // اگه به هر دلیلی کرش کرد، خودکار دوباره بالا میاد
      restart_delay: 3000,
      max_restarts: 1000,
      min_uptime: '10s',
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
