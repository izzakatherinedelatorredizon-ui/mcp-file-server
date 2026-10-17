import crypto from "node:crypto";

const t = () => crypto.randomBytes(24).toString("base64url"); // 32 URL-safe chars
console.log("# Paste this line into .env (keep it secret, never commit it):");
console.log(`AGENT_TOKENS=planner:${t()},builder:${t()},reviewer:${t()}`);
