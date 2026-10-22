const path = require("path");

module.exports = {
  apps: [
    {
      name: "checkingwallet",
      script: path.join(__dirname, "index.js"),
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
