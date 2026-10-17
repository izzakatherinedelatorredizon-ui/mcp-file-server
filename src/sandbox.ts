import fs from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.ts";

const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const ILLEGAL_CHARS = /[<>"|?*]/;
const PROTECTED_DIRS = new Set([".git", ".trash"]);

export interface Resolved {
  /** Real absolute path (symlinks resolved) that file operations should use. */
  abs: string;
  /** Lexical absolute path (before symlink resolution); use for lstat checks. */
  lexical: string;
  /** Path relative to the workspace root, always with "/" separators ("" = root). */
  rel: string;
  /** True if the final path already exists. */
  exists: boolean;
}

export function isInside(root: string, target: string): boolean {
  const r = path.relative(root, target);
  if (r === "") return true;
  return !(r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r));
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export class Sandbox {
  readonly root: string;

  constructor(rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
    this.root = fs.realpathSync.native(rootDir);
  }

  private segments(input: unknown): string[] {
    if (typeof input !== "string") throw new ToolError("path must be a string");
    if (input.length > 1024) throw new ToolError("path is too long (max 1024 characters)");
    if (input.includes("\0")) throw new ToolError("path contains a null byte");
    if (/^[a-zA-Z]:/.test(input) || input.startsWith("/") || input.startsWith("\\")) {
      throw new ToolError(
        `Absolute paths are not allowed: "${input}". Use a path relative to the workspace root, e.g. "src/app.ts".`,
      );
    }
    if (input.includes(":")) {
      throw new ToolError(`":" is not allowed in paths (drive letters / NTFS streams): "${input}"`);
    }
    const segs = input.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
    for (const s of segs) {
      if (s === "..") {
        throw new ToolError(`Path traversal ("..") is not allowed: "${input}". Stay inside the workspace.`);
      }
      if (/[. ]$/.test(s)) throw new ToolError(`Path segment "${s}" must not end with a dot or space`);
      if (ILLEGAL_CHARS.test(s)) throw new ToolError(`Path segment "${s}" contains illegal characters`);
      if (RESERVED_WIN.test(s)) throw new ToolError(`"${s}" is a reserved device name`);
      if (PROTECTED_DIRS.has(s.toLowerCase())) {
        throw new ToolError(`"${s}" is a protected directory and cannot be accessed through this server`);
      }
    }
    return segs;
  }

  /** Validate a user-supplied path and map it to a real path inside the workspace. */
  resolve(input: unknown): Resolved {
    const segs = this.segments(input);
    const lexical = path.join(this.root, ...segs);

    // Walk up to the deepest component that exists (lstat, so dangling symlinks count).
    let existing = lexical;
    const rest: string[] = [];
    while (!lexists(existing)) {
      rest.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }

    let real: string;
    try {
      real = fs.realpathSync.native(existing);
    } catch {
      throw new ToolError("Path is a broken symbolic link and cannot be used");
    }
    if (!isInside(this.root, real)) {
      throw new ToolError("Path resolves outside the workspace (symbolic-link escape is blocked)");
    }

    const abs = path.join(real, ...rest);
    if (!isInside(this.root, abs)) {
      throw new ToolError("Path resolves outside the workspace");
    }
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    // A symlink inside the workspace must not lead into protected directories either.
    for (const s of rel.split("/")) {
      if (PROTECTED_DIRS.has(s.toLowerCase())) {
        throw new ToolError(`"${s}" is a protected directory and cannot be accessed through this server`);
      }
    }
    return { abs, lexical, rel, exists: rest.length === 0 };
  }

  isSymlink(lexicalPath: string): boolean {
    try {
      return fs.lstatSync(lexicalPath).isSymbolicLink();
    } catch {
      return false;
    }
  }
}
