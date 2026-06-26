module.exports = {
  apps: [{
    name: "grab-server",
    script: "server.js",
    cwd: "/root/grab",
    instances: 1,
    exec_mode: "fork",
    max_memory_restart: "500M",
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 3000,
    kill_timeout: 8000,
    listen_timeout: 5000,
    watch: false,
    autorestart: true,
    env: {
      NODE_ENV: "production",
      PORT: 3000,
    },
    error_file: "/root/grab/logs/err.log",
    out_file: "/root/grab/logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    merge_logs: true,
    // Log rotation
    max_size: "10M",
    retain: 5,
    // Health check
    wait_ready: false,
    exp_backoff_restart_delay: 100,
  }]
};
