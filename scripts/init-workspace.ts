import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { GitLite } from "../src/git.ts";
import { Sandbox } from "../src/sandbox.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const withDemo = process.argv.includes("--demo");

function copyMissing(srcDir: string, destDir: string): number {
  let copied = 0;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copied += copyMissing(s, d);
    else if (!fs.existsSync(d)) {
      fs.copyFileSync(s, d);
      copied++;
    }
  }
  return copied;
}

const cfg = loadConfig();
const sandbox = new Sandbox(cfg.workspaceRoot);
let n = copyMissing(path.join(projectRoot, "templates", "handoff"), sandbox.root);
if (withDemo) n += copyMissing(path.join(projectRoot, "demo-seed"), sandbox.root);

const git = new GitLite(sandbox);
git.ensureRepo();
try {
  console.log(await git.commit(withDemo ? "Seed demo project and handoff files" : "Initial handoff files", "operator"));
} catch (e) {
  console.log(`(${(e as Error).message})`);
}
console.log(`Workspace ready at ${sandbox.root} (${n} file(s) copied; existing files were never overwritten).`);
