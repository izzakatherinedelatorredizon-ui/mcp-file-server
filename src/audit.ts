import fs from "node:fs";
import path from "node:path";

export interface AuditEntry {
  ts: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  ms: number;
}

/** Keep the log small and free of file contents. */

export function summarizeArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sensitiveKeys =
    /^(content|old_str|new_str|entry|pattern|message|token|password|secret)$/i;

  if (!args || typeof args !== "object" || Array.isArray(args)) return out;

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (sensitiveKeys.test(key)) {
      out[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 80) {
      out[key] = `${value.slice(0, 60)}...(${value.length} chars)`;
    } else {
      out[key] = value;
    }
  }

  return out;
}


export class AuditLog {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(entry: AuditEntry): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.error("audit log write failed:", (e as Error).message);
    }
  }
}
