import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.ts";
import type { Agent } from "./roles.ts";
import { ROLE_WRITE_SCOPE } from "./roles.ts";
import { Sandbox } from "./sandbox.ts";

export const HANDOFF_FILES = ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"] as const;
export const APPEND_ONLY = ["PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"] as const;

export const LIMITS = {
  maxReadBytes: 5_000_000,
  maxWriteBytes: 1_000_000,
  maxSearchFileBytes: 1_000_000,
  maxEntryChars: 4000,
  maxOutputChars: 20_000,
};

const SKIP_DIRS = new Set([".git", ".trash", "node_modules"]);

export const versionOf = (buf: Buffer | string): string =>
  crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

function fsGuard<T>(rel: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ToolError) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    const where = rel || ".";
    switch (code) {
      case "ENOENT": throw new ToolError(`Not found: ${where}`);
      case "EACCES":
      case "EPERM": throw new ToolError(`Permission denied: ${where}`);
      case "ENOTDIR": throw new ToolError(`A parent of ${where} is a file, not a directory`);
      case "EISDIR": throw new ToolError(`${where} is a directory`);
      case "EEXIST": throw new ToolError(`Already exists: ${where}`);
      default: throw new ToolError(`Filesystem error (${code ?? "unknown"}) on ${where}`);
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

export class FileOps {
  readonly sandbox: Sandbox;
  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  // ---------- helpers ----------
  private assertWritable(rel: string, agent: Agent, forDelete = false): void {
    if (rel === "") throw new ToolError("Cannot modify the workspace root");
    if ((HANDOFF_FILES as readonly string[]).includes(rel) && forDelete) {
      throw new ToolError(`${rel} is part of the handoff protocol and cannot be deleted`);
    }
    if ((APPEND_ONLY as readonly string[]).includes(rel) && !forDelete) {
      throw new ToolError(`${rel} is append-only. Use handoff_append to add an entry.`);
    }
    const scope = ROLE_WRITE_SCOPE[agent.role];
    if (scope !== null && !forDelete) {
      const ok = scope.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
      if (!ok) {
        throw new ToolError(
          `Role "${agent.role}" may only write to: ${scope.length ? scope.join(", ") : "(nothing)"}. Ask the builder instead.`,
        );
      }
    }
  }

  private assertNotSymlink(lexical: string, rel: string): void {
    if (this.sandbox.isSymlink(lexical)) throw new ToolError(`${rel} is a symbolic link; refusing to modify it`);
  }

  private atomicWrite(abs: string, content: string): void {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, content, { flag: "wx" });
      fs.renameSync(tmp, abs);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already renamed */ }
    }
  }

  private readText(abs: string, rel: string): { text: string; buf: Buffer } {
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new ToolError(`${rel || "."} is a directory. Use list_files.`);
    if (st.size > LIMITS.maxReadBytes) {
      throw new ToolError(`${rel} is ${st.size} bytes (limit ${LIMITS.maxReadBytes}). Use search_files to find what you need.`);
    }
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) throw new ToolError(`${rel} looks like a binary file; only text files can be read`);
    return { text: buf.toString("utf8"), buf };
  }

  // ---------- tools ----------
  listFiles(p = ".", opts: { recursive?: boolean; max_entries?: number } = {}): string {
    const { abs, rel } = this.sandbox.resolve(p);
    const max = Math.min(Math.max(opts.max_entries ?? 200, 1), 500);
    return fsGuard(rel, () => {
      if (!fs.statSync(abs).isDirectory()) throw new ToolError(`${rel} is a file. Use read_file.`);
      const lines: string[] = [];
      let truncated = false;
      const walk = (dir: string, prefix: string, depth: number) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => !SKIP_DIRS.has(e.name.toLowerCase()))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (lines.length >= max) { truncated = true; return; }
          const r = prefix ? `${prefix}/${e.name}` : e.name;
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) lines.push(`${r}  (symlink)`);
          else if (e.isDirectory()) {
            lines.push(`${r}/`);
            if (opts.recursive && depth < 6) walk(full, r, depth + 1);
          } else lines.push(`${r}  (${fs.statSync(full).size} bytes)`);
        }
      };
      walk(abs, rel, 0);
      if (lines.length === 0) return `${rel || "."}: (empty directory)`;
      return lines.join("\n") + (truncated ? `\n… truncated at ${max} entries; narrow the path or lower the depth.` : "");
    });
  }

  readFile(p: string, opts: { start_line?: number; end_line?: number; max_chars?: number } = {}): string {
    const { abs, rel, exists } = this.sandbox.resolve(p);
    if (!exists) throw new ToolError(`Not found: ${rel}`);
    return fsGuard(rel, () => {
      const { text, buf } = this.readText(abs, rel);
      const version = versionOf(buf);
      if (text.length === 0) return `# ${rel} | version: ${version} | (empty file)`;
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const total = lines.length;
      const start = Math.max(opts.start_line ?? 1, 1);
      if (start > total) throw new ToolError(`start_line ${start} is past the end of ${rel} (${total} lines)`);
      const wantedEnd = Math.min(opts.end_line ?? total, total);
      if (wantedEnd < start) throw new ToolError("end_line must be >= start_line");
      const maxChars = Math.min(Math.max(opts.max_chars ?? 20_000, 200), LIMITS.maxOutputChars);
      const out: string[] = [];
      let used = 0;
      let last = start - 1;
      for (let i = start; i <= wantedEnd; i++) {
        const line = lines[i - 1]!;
        if (used + line.length + 1 > maxChars && out.length > 0) break;
        out.push(line);
        used += line.length + 1;
        last = i;
      }
      let header = `# ${rel} | version: ${version} | lines ${start}-${last} of ${total}`;
      if (last < wantedEnd) header += ` | truncated: continue with start_line=${last + 1}`;
      return `${header}\n${out.join("\n")}`;
    });
  }

  writeFile(p: string, content: string, agent: Agent, expectedVersion?: string): string {
    const { abs, lexical, rel, exists } = this.sandbox.resolve(p);
    this.assertWritable(rel, agent);
    if (typeof content !== "string") throw new ToolError("content must be a string");
    if (content.includes("\0")) throw new ToolError("content contains a null byte; only text is supported");
    if (Buffer.byteLength(content) > LIMITS.maxWriteBytes) {
      throw new ToolError(`content is larger than ${LIMITS.maxWriteBytes} bytes. Split it into several files.`);
    }
    return fsGuard(rel, () => {
      if (exists) {
        this.assertNotSymlink(lexical, rel);
        const st = fs.statSync(abs);
        if (st.isDirectory()) throw new ToolError(`${rel} is a directory`);
        const current = versionOf(fs.readFileSync(abs));
        if (!expectedVersion) {
          throw new ToolError(
            `${rel} already exists (version ${current}). Read it first, then pass expected_version="${current}" to overwrite, or use str_replace for a small edit.`,
          );
        }
        if (expectedVersion !== current) {
          throw new ToolError(`${rel} changed since you read it (current version ${current}, you sent ${expectedVersion}). Re-read it and merge your change.`);
        }
      }
      this.atomicWrite(abs, content);
      const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      return `${exists ? "Overwrote" : "Created"} ${rel} (${Buffer.byteLength(content)} bytes, ${lines} lines). version: ${versionOf(content)}`;
    });
  }

  strReplace(
    p: string,
    oldStr: string,
    newStr: string,
    agent: Agent,
    opts: { replace_all?: boolean; expected_version?: string } = {},
  ): string {
    const { abs, lexical, rel, exists } = this.sandbox.resolve(p);
    this.assertWritable(rel, agent);
    if (!exists) throw new ToolError(`Not found: ${rel}`);
    if (typeof oldStr !== "string" || oldStr.length === 0) throw new ToolError("old_str must be a non-empty string");
    if (typeof newStr !== "string") throw new ToolError("new_str must be a string");
    if (oldStr === newStr) throw new ToolError("old_str and new_str are identical; nothing to do");
    return fsGuard(rel, () => {
      this.assertNotSymlink(lexical, rel);
      const { text, buf } = this.readText(abs, rel);
      const current = versionOf(buf);
      if (opts.expected_version && opts.expected_version !== current) {
        throw new ToolError(`${rel} changed since you read it (current version ${current}). Re-read it first.`);
      }
      const count = text.split(oldStr).length - 1;
      if (count === 0) throw new ToolError(`old_str was not found in ${rel}. Re-read the file; whitespace must match exactly.`);
      if (count > 1 && !opts.replace_all) {
        throw new ToolError(`old_str appears ${count} times in ${rel}. Add surrounding context to make it unique, or set replace_all=true.`);
      }
      const firstLine = text.slice(0, text.indexOf(oldStr)).split("\n").length;
      const updated = opts.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
      if (Buffer.byteLength(updated) > LIMITS.maxWriteBytes) throw new ToolError("Result would exceed the maximum file size");
      this.atomicWrite(abs, updated);
      return `Replaced ${opts.replace_all ? count : 1} occurrence(s) in ${rel} (first at line ${firstLine}). version: ${versionOf(updated)}`;
    });
  }

  deleteFile(p: string, confirm: boolean, agent: Agent): string {
    const { abs, lexical, rel, exists } = this.sandbox.resolve(p);
    this.assertWritable(rel, agent, true);
    if (confirm !== true) {
      throw new ToolError(`Deleting is destructive. Call again with confirm=true if you really want to delete ${rel}.`);
    }
    if (!exists) throw new ToolError(`Not found: ${rel}`);
    return fsGuard(rel, () => {
      this.assertNotSymlink(lexical, rel);
      if (!fs.statSync(abs).isFile()) throw new ToolError(`${rel} is a directory; only single files can be deleted`);
      const trashDir = path.join(this.sandbox.root, ".trash");
      fs.mkdirSync(trashDir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}__${rel.replace(/\//g, "__")}`;
      fs.renameSync(abs, path.join(trashDir, name));
      return `Deleted ${rel}. It was moved to .trash/${name} (the operator can restore it).`;
    });
  }

  searchFiles(
    pattern: string,
    p = ".",
    opts: { glob?: string; regex?: boolean; case_sensitive?: boolean; max_results?: number } = {},
  ): string {
    if (typeof pattern !== "string" || pattern.length < 1 || pattern.length > 200) {
      throw new ToolError("pattern must be 1-200 characters");
    }
    const { abs, rel } = this.sandbox.resolve(p);
    const max = Math.min(Math.max(opts.max_results ?? 50, 1), 200);
    const flags = opts.case_sensitive ? "" : "i";
    let test: (line: string) => boolean;
    if (opts.regex) {
      let re: RegExp;
      try { re = new RegExp(pattern, flags); } catch (e) { throw new ToolError(`Invalid regular expression: ${(e as Error).message}`); }
      test = (l) => re.test(l);
    } else {
      const needle = opts.case_sensitive ? pattern : pattern.toLowerCase();
      test = (l) => (opts.case_sensitive ? l : l.toLowerCase()).includes(needle);
    }
    const globRe = opts.glob ? globToRegExp(opts.glob) : null;
    const globHasSlash = !!opts.glob && opts.glob.includes("/");

    return fsGuard(rel, () => {
      const results: string[] = [];
      let filesScanned = 0;
      let truncated = false;
      const deadline = Date.now() + 5000;
      const visit = (full: string, r: string): void => {
        if (truncated) return;
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) return;
        if (st.isDirectory()) {
          for (const name of fs.readdirSync(full).sort()) {
            if (SKIP_DIRS.has(name.toLowerCase())) continue;
            visit(path.join(full, name), r ? `${r}/${name}` : name);
            if (truncated) return;
          }
          return;
        }
        if (!st.isFile() || st.size > LIMITS.maxSearchFileBytes) return;
        if (globRe && !globRe.test(globHasSlash ? r : path.posix.basename(r))) return;
        if (++filesScanned > 5000 || Date.now() > deadline) { truncated = true; return; }
        const buf = fs.readFileSync(full);
        if (looksBinary(buf)) return;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!.slice(0, 1000);
          if (test(line)) {
            results.push(`${r}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (results.length >= max) { truncated = true; return; }
          }
        }
      };
      const st = fs.statSync(abs);
      visit(abs, st.isDirectory() ? rel : rel);
      if (results.length === 0) return `No matches for "${pattern}" under ${rel || "."} (${filesScanned} files scanned).`;
      return results.join("\n") + `\n(${results.length} match(es), ${filesScanned} files scanned${truncated ? "; results truncated, narrow your search" : ""})`;
    });
  }

  // ---------- handoff protocol ----------
  handoffRead(maxCharsEach = 3000): string {
    const max = Math.min(Math.max(maxCharsEach, 200), 6000);
    const parts: string[] = [];
    for (const name of HANDOFF_FILES) {
      const { abs, rel, exists } = this.sandbox.resolve(name);
      if (!exists) { parts.push(`=== ${name} ===\n(missing - run init-workspace or create it)`); continue; }
      const { text, buf } = fsGuard(rel, () => this.readText(abs, rel));
      const isLog = (APPEND_ONLY as readonly string[]).includes(name);
      let body = text;
      if (text.length > max) {
        body = isLog
          ? `…(${text.length - max} earlier chars omitted; use read_file for the full log)\n${text.slice(-max)}`
          : `${text.slice(0, max)}\n…(truncated; use read_file for the rest)`;
      }
      parts.push(`=== ${name} (version: ${versionOf(buf)}) ===\n${body.trim()}`);
    }
    return parts.join("\n\n");
  }

  handoffAppend(file: string, entry: string, agent: Agent): string {
    if (!(APPEND_ONLY as readonly string[]).includes(file)) {
      throw new ToolError(`file must be one of: ${APPEND_ONLY.join(", ")}. PROJECT_STATE.md is edited with write_file/str_replace.`);
    }
    if (typeof entry !== "string" || entry.trim().length === 0) throw new ToolError("entry must not be empty");
    if (entry.length > LIMITS.maxEntryChars) throw new ToolError(`entry is too long (max ${LIMITS.maxEntryChars} characters)`);
    const { abs, lexical, rel } = this.sandbox.resolve(file);
    return fsGuard(rel, () => {
      this.assertNotSymlink(lexical, rel);
      if (!fs.existsSync(abs)) fs.writeFileSync(abs, `# ${file.replace(".md", "")}\n`);
      fs.appendFileSync(abs, `\n## ${new Date().toISOString()} · ${agent.name}\n${entry.trim()}\n`);
      return `Appended to ${file}.`;
    });
  }
}
