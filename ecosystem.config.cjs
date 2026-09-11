// pm2 process definition.
//   pm2 start ecosystem.config.cjs
//   pm2 logs rocketchat-claude
//   pm2 restart rocketchat-claude
//   pm2 save   (so it survives a reboot, after `pm2 startup`)
module.exports = {
  apps: [
    {
      name: "rocketchat-claude",
      script: "src/index.js",
      cwd: __dirname,
      // .env is read by Node itself rather than pm2, so the same file works for
      // `pnpm start`, the MCP server, and pm2 without being duplicated.
      node_args: "--env-file=.env",
      interpreter: process.execPath,
      autorestart: true,
      max_restarts: 20,
      // A crash loop backs off instead of hammering Rocket.Chat's login endpoint.
      restart_delay: 3000,
      max_memory_restart: "600M",
      time: true,
      out_file: "logs/out.log",
      error_file: "logs/err.log",
      merge_logs: true,
    },
    {
      // Mirrors .rc-usage.json into the #claude-usage-data snapshot message that
      // the "Claude Usage" Rocket.Chat app reads for /usage. Separate process so
      // it can be restarted without interrupting a live Claude turn.
      name: "usage-sync",
      script: "src/usage-sync.js",
      cwd: __dirname,
      node_args: "--env-file=.env",
      interpreter: process.execPath,
      env: {
        USAGE_ROOM_ID: "6aa3965c77d67a76dfe3f278",
        USAGE_MSG_ID: "Djjhz8YDcLsbzaKdn",
      },
      autorestart: true,
      restart_delay: 5000,
      time: true,
      out_file: "logs/usage-sync.log",
      error_file: "logs/usage-sync.log",
      merge_logs: true,
    },
  ],
};
