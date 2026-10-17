import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpDir(prefix = "mcp-test-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Try to create a symlink; returns false if the OS/user is not allowed (e.g. Windows without dev mode). */
export function trySymlink(target: string, linkPath: string, type?: "dir" | "file"): boolean {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}
