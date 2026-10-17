import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ToolError } from "./errors.ts";
import { LIMITS } from "./fileops.ts";
import { Sandbox } from "./sandbox.ts";

const execFileAsync = promisify(execFile);


/** Hardened environment: no user/system git config, no prompts. */
const GIT_ISOLATION_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "mcp-file-server-git-"),
);
const GIT_EMPTY_CONFIG = path.join(GIT_ISOLATION_DIR, "config");
const GIT_HOOKS_DIR = path.join(GIT_ISOLATION_DIR, "hooks");

fs.writeFileSync(GIT_EMPTY_CONFIG, "", { flag: "wx" });
fs.mkdirSync(GIT_HOOKS_DIR);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: GIT_EMPTY_CONFIG,
};

const BASE_ARGS = [
  "--literal-pathspecs",
  "-c", `core.hooksPath=${GIT_HOOKS_DIR}`,
  "-c", "core.fsmonitor=false",
  "-c", "core.quotepath=false",
];


const clip = (s: string) =>
  s.length > LIMITS.maxOutputChars ? s.slice(0, LIMITS.maxOutputChars) + "\n… output truncated" : s;

export class GitLite {
  private readonly sandbox: Sandbox;
  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  /** Create the workspace repo if needed (called once at startup, by the operator - not by agents). */
  ensureRepo(): void {
    const root = this.sandbox.root;
    if (fs.existsSync(path.join(root, ".git"))) return;
    const opts = { cwd: root, env: GIT_ENV, stdio: "pipe" as const };
    execFileSync("git", [...BASE_ARGS, "init", "-q"], opts);
    execFileSync("git", [...BASE_ARGS, "symbolic-ref", "HEAD", "refs/heads/main"], opts);
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), ".trash/\n");
  }

  private async git(args: string[], identity?: string): Promise<string> {
    const id = identity ? ["-c", `user.name=${identity}`, "-c", `user.email=${identity}@mcp.local`] : [];
    try {
      const { stdout } = await execFileAsync("git", [...BASE_ARGS, ...id, ...args], {
        cwd: this.sandbox.root,
        env: GIT_ENV,
        timeout: 10_000,
        maxBuffer: 2_000_000,
      });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; code?: string | number; killed?: boolean; message: string };
      if (err.code === "ENOENT") throw new ToolError("git is not installed on the server");
      if (err.killed) throw new ToolError("git timed out");
      const msg = (err.stderr || err.stdout || err.message || "").toString().trim().split("\n").slice(0, 3).join(" ");
      throw new ToolError(`git ${args[0]} failed: ${msg.slice(0, 300)}`);
    }
  }

  async status(): Promise<string> {
    const out = (await this.git(["status", "--porcelain=v1", "--branch"])).trim();
    const lines = out.split("\n");
    return lines.length === 1 ? `${out}\n(working tree clean)` : out;
  }

  async diff(opts: { path?: string; ref?: string } = {}): Promise<string> {
    const args = ["diff", "--no-color", "--stat", "--patch"];
    if (opts.ref !== undefined) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]{0,99}$/.test(opts.ref)) throw new ToolError("ref contains invalid characters");
      args.push(opts.ref);
    }
    args.push("--");
    if (opts.path) args.push(this.sandbox.resolve(opts.path).rel || ".");
    const out = (await this.git(args)).trim();
    return out ? clip(out) : "(no differences)";
  }

  async log(opts: { max_count?: number; path?: string } = {}): Promise<string> {
    const n = Math.min(Math.max(opts.max_count ?? 10, 1), 50);
    const args = ["log", `--max-count=${n}`, "--date=short", "--pretty=format:%h %ad %an: %s"];
    if (opts.path) args.push("--", this.sandbox.resolve(opts.path).rel || ".");
    try {
      const out = (await this.git(args)).trim();
      return out || "(no commits yet)";
    } catch (e) {
      if (/does not have any commits|bad default revision/i.test((e as Error).message)) return "(no commits yet)";
      throw e;
    }
  }

  async commit(message: string, agentName: string, paths?: string[]): Promise<string> {
    const msg = (message ?? "").trim();
    if (msg.length < 3 || msg.length > 500) throw new ToolError("message must be 3-500 characters");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(agentName)) throw new ToolError("invalid agent name");
    const rels = (paths ?? []).slice(0, 50).map((p) => this.sandbox.resolve(p).rel).filter((r) => r !== "");
    await this.git(["add", "-A", "--", ...(rels.length ? rels : ["."])]);
    const staged = (await this.git(["diff", "--cached", "--name-only"])).trim();
    if (!staged) throw new ToolError("Nothing to commit (no changes).");
    await this.git(["commit", "--no-verify", "-q", "-m", msg], agentName);
    const head = (await this.git(["log", "-1", "--pretty=format:%h %s"])).trim();
    const files = staged.split("\n").length;
    return `Committed ${files} file(s): ${head}`;
  }
}
