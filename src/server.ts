import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuditLog, summarizeArgs } from "./audit.ts";
import { ToolError } from "./errors.ts";
import { LIMITS, type FileOps } from "./fileops.ts";
import type { GitLite } from "./git.ts";
import { ROLE_TOOLS, type Agent } from "./roles.ts";
import { TOOLS, type ToolCtx, type ToolDef } from "./tools.ts";

export interface Deps {
  ops: FileOps;
  git: GitLite;
  audit: AuditLog;
}

function clip(text: string): string {
  return text.length > LIMITS.maxOutputChars ? text.slice(0, LIMITS.maxOutputChars) + "\n… output truncated" : text;
}

/** Run one tool call: audit it, and turn every failure into a clean isError result (never a stack trace). */
export async function runTool(def: ToolDef, ctx: ToolCtx, args: unknown, audit: AuditLog) {
  const started = Date.now();
  const base = { ts: new Date().toISOString(), agent: ctx.agent.name, tool: def.name, args: summarizeArgs(args) };
  try {
    const text = clip(await def.handler(ctx, args ?? {}));
    audit.write({ ...base, ok: true, ms: Date.now() - started });
    return { content: [{ type: "text" as const, text }] };
  } catch (e) {
    let message: string;
    if (e instanceof ToolError) message = e.message;
    else {
      console.error(`[${def.name}] unexpected error:`, e);
      message = "Internal server error. The details were logged on the server.";
    }
    audit.write({ ...base, ok: false, error: message, ms: Date.now() - started });
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

/** Build a fresh MCP server exposing only the tools this agent's role may use. */
export function buildServer(agent: Agent, deps: Deps): McpServer {
  const server = new McpServer(
    { name: "mcp-file-server", version: "1.0.0" },
    {
      instructions:
        `You are the "${agent.role}" agent. Start every session with handoff_read. ` +
        "Read before you write, prefer search_files/str_replace over rewriting whole files, " +
        "and record plans, checkpoints and decisions with handoff_append.",
    },
  );
  const ctx: ToolCtx = { agent, ops: deps.ops, git: deps.git };
  const allowed = new Set<string>(ROLE_TOOLS[agent.role]);
  for (const def of TOOLS) {
    if (!allowed.has(def.name)) continue;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.schema,
        annotations: {
          readOnlyHint: def.readOnly,
          destructiveHint: def.destructive,
          idempotentHint: def.readOnly,
          openWorldHint: false,
        },
      } as any,
      (async (args: unknown) => runTool(def, ctx, args, deps.audit)) as any,
    );
  }
  return server;
}
