import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`Configuration error: ${(e as Error).message}`);
  process.exit(1);
}

const { app } = createApp(cfg);
const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`MCP file server listening on http://${cfg.host}:${cfg.port}/mcp`);
  console.log(`Workspace: ${cfg.workspaceRoot}`);
  console.log(`Roles enabled: ${cfg.tokens.map((t) => t.role).join(", ")}`);
  if (cfg.allowPathToken) console.warn("WARNING: ALLOW_PATH_TOKEN=true - tokens in URLs can leak into logs.");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
