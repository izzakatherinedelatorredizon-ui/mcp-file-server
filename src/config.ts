import os from "node:os";
import path from "node:path";
import { parseAgentTokens, type TokenTable } from "./auth.ts";
import { isInside } from "./sandbox.ts";

export interface Config {
  workspaceRoot: string;
  host: string;
  port: number;
  tokens: TokenTable;
  auditLog: string;
  allowPathToken: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const workspaceRoot = path.resolve(cwd, env.WORKSPACE_ROOT || "./workspace");
  const auditLog = path.resolve(cwd, env.AUDIT_LOG || "./logs/audit.jsonl");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT "${env.PORT}"`);

  // Refuse dangerous workspace roots: the agents must never be able to reach the server's own files.
  if (path.parse(workspaceRoot).root === workspaceRoot) throw new Error("WORKSPACE_ROOT must not be a filesystem root");
  if (path.resolve(os.homedir()) === workspaceRoot) throw new Error("WORKSPACE_ROOT must not be your home folder");
  if (isInside(workspaceRoot, cwd)) {
    throw new Error("WORKSPACE_ROOT must not contain the server project (agents could edit .env / source code)");
  }
  if (isInside(workspaceRoot, auditLog)) throw new Error("AUDIT_LOG must be outside WORKSPACE_ROOT");

  return {
    workspaceRoot,
    host: env.HOST || "127.0.0.1",
    port,
    tokens: parseAgentTokens(env.AGENT_TOKENS),
    auditLog,
    allowPathToken: (env.ALLOW_PATH_TOKEN || "").toLowerCase() === "true",
  };
}
