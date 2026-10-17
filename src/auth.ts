import crypto from "node:crypto";
import { isRole, type Role } from "./roles.ts";

export type TokenTable = Array<{ role: Role; hash: Buffer }>;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

/** Parse AGENT_TOKENS="planner:tok1,builder:tok2". Throws a readable Error if invalid. */
export function parseAgentTokens(raw: string | undefined): TokenTable {
  if (!raw || !raw.trim()) {
    throw new Error("AGENT_TOKENS is not set. Run `npm run gen-tokens` and copy the line into .env");
  }
  const table: TokenTable = [];
  const seenRoles = new Set<string>();
  const seenTokens = new Set<string>();
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const idx = item.indexOf(":");
    if (idx < 1) throw new Error(`AGENT_TOKENS entry "${item.slice(0, 12)}..." must look like role:token`);
    const role = item.slice(0, idx).trim();
    const token = item.slice(idx + 1).trim();
    if (!isRole(role)) throw new Error(`Unknown role "${role}" in AGENT_TOKENS (use planner, builder, reviewer)`);
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
      throw new Error(`Token for role "${role}" must be at least 32 characters of A-Z a-z 0-9 _ -`);
    }
    if (seenRoles.has(role)) throw new Error(`Role "${role}" appears twice in AGENT_TOKENS`);
    if (seenTokens.has(token)) throw new Error("Two roles share the same token");
    seenRoles.add(role);
    seenTokens.add(token);
    table.push({ role, hash: sha(token) });
  }
  if (table.length === 0) throw new Error("AGENT_TOKENS contains no valid entries");
  return table;
}

/** Constant-time check of a presented token against every configured token. */
export function authenticate(table: TokenTable, presented: string | undefined): Role | null {
  if (!presented || presented.length > 512) return null;
  const h = sha(presented);
  let found: Role | null = null;
  for (const entry of table) {
    if (crypto.timingSafeEqual(entry.hash, h)) found = entry.role; // no early exit
  }
  return found;
}
