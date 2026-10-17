// PM2 process file: keeps the MCP server AND the ngrok tunnel alive and restarts them if they crash.
// Usage:  npm run build && pm2 start ecosystem.config.cjs && pm2 save
const fs = require("node:fs");

function readEnv(key, fallback = "") {
  try {
    const line = fs.readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(key + "="));
    return line ? line.slice(key.length + 1).trim() : fallback;
  } catch {
    return fallback;
  }
}

const port = readEnv("PORT", "3000");
const domain = readEnv("NGROK_DOMAIN");
if (!domain) console.warn("NGROK_DOMAIN is empty in .env - the tunnel app will fail to start.");

module.exports = {
  apps: [
    {
      name: "mcp-server",
      script: "dist/src/index.js",
      node_args: "--env-file=.env", // secrets stay in .env, never in this file
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      env: { NODE_ENV: "production" },
    },
    {
      name: "mcp-tunnel",
      script: "ngrok",
      args: `http --url=${domain} ${port}`, // older ngrok versions use --domain instead of --url
      interpreter: "none",
      autorestart: true,
      restart_delay: 3000,
    },
  ],
};
