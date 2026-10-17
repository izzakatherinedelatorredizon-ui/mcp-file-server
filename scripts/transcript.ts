import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import type { AuditEntry } from "../src/audit.ts";

// Usage: npm run transcript -- [--since=2026-10-17T00:00:00Z] [--out=docs/transcript.md]
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const cfg = loadConfig();
const since = arg("since");
const out = arg("out");

if (!fs.existsSync(cfg.auditLog)) {
  console.error(`No audit log yet at ${cfg.auditLog}. Make some tool calls first.`);
  process.exit(1);
}
const entries: AuditEntry[] = fs
  .readFileSync(cfg.auditLog, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as AuditEntry)
  .filter((e) => !since || e.ts >= since);

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const lines = [
  "# Tool-call transcript (generated from the server's audit log)",
  "",
  `Source: \`${path.basename(cfg.auditLog)}\` · ${entries.length} calls · generated ${new Date().toISOString()}`,
  "",
  "| # | Time (UTC) | Agent | Tool | Arguments | Result | ms |",
  "|---|---|---|---|---|---|---|",
  ...entries.map((e, i) =>
    `| ${i + 1} | ${e.ts.slice(11, 19)} | ${e.agent} | ${e.tool} | ${cell(JSON.stringify(e.args))} | ${e.ok ? "ok" : "ERROR: " + cell(e.error ?? "")} | ${e.ms} |`,
  ),
  "",
  `Summary: ${entries.filter((e) => e.ok).length} ok, ${entries.filter((e) => !e.ok).length} errors; ` +
    Object.entries(entries.reduce<Record<string, number>>((m, e) => ((m[e.agent] = (m[e.agent] ?? 0) + 1), m), {}))
      .map(([a, c]) => `${a}: ${c} calls`)
      .join(", "),
];
const text = lines.join("\n") + "\n";
if (out) {
  fs.writeFileSync(out, text);
  console.log(`Wrote ${out}`);
} else console.log(text);
