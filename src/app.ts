import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuditLog } from "./audit.ts";
import { authenticate } from "./auth.ts";
import type { Config } from "./config.ts";
import { FileOps } from "./fileops.ts";
import { GitLite } from "./git.ts";
import type { Agent } from "./roles.ts";
import { Sandbox } from "./sandbox.ts";
import { buildServer } from "./server.ts";

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export function createApp(cfg: Config) {
  const sandbox = new Sandbox(cfg.workspaceRoot);
  const git = new GitLite(sandbox);
  git.ensureRepo();
  const deps = { ops: new FileOps(sandbox), git, audit: new AuditLog(cfg.auditLog) };

  const app = express();
  app.disable("x-powered-by");

  // Public, unauthenticated, reveals nothing: only for tunnel / uptime checks.
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Auth runs BEFORE the body is parsed, so unauthenticated callers cost almost nothing.
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
    const presented = bearer ?? (cfg.allowPathToken ? req.params.token : undefined);
    const role = authenticate(cfg.tokens, presented);
    if (!role) {
      res.status(401).set("WWW-Authenticate", "Bearer").json(rpcError(-32001, "Unauthorized"));
      return;
    }
    res.locals.agent = { name: role, role } satisfies Agent;
    next();
  };

  const handle = async (req: Request, res: Response) => {
    const agent = res.locals.agent as Agent;
    const server = buildServer(agent, deps);
    // Stateless mode: a fresh server + transport per request, so there is no session state to lose on restart.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP request failed:", e);
      if (!res.headersSent) res.status(500).json(rpcError(-32603, "Internal server error"));
    }
  };

  const json = express.json({ limit: "1mb" });
  const routes = cfg.allowPathToken ? ["/mcp", "/mcp/:token"] : ["/mcp"];
  app.post(routes, auth, json, handle);
  app.all(routes, (_req, res) => {
    res.status(405).set("Allow", "POST").json(rpcError(-32000, "Method not allowed. Use POST (stateless Streamable HTTP)."));
  });

  // JSON error handler: never leak stack traces (e.g. malformed JSON bodies).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status === 413 ? 413 : 400;
    res.status(status).json(rpcError(status === 413 ? -32000 : -32700, status === 413 ? "Payload too large" : "Invalid request body"));
  });

  return { app, deps, sandbox };
}
