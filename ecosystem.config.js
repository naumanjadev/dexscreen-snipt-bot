// ecosystem.config.js

module.exports = {
    apps: [
      {
        name: "solana-trading-bot", // Name of the application
        script: "dist/index.js",     // Path to the compiled JavaScript file
        cwd: "./",                   // Current working directory
        watch: false,                // Watch files for changes (disable for production)
        instances: 1,                // Number of instances to run
        autorestart: true,           // Automatically restart on crash
        max_memory_restart: "1G",    // Restart if memory usage exceeds 1GB
        env: {
          NODE_ENV: "production",
        },
        log_date_format: "YYYY-MM-DD HH:mm:ss",
        error_file: "logs/pm2-error.log",
        out_file: "logs/pm2-out.log",
        merge_logs: true,            // Merge logs from all instances
      },
    ],
  };
  