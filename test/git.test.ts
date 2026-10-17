import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, before } from "node:test";
import { ToolError } from "../src/errors.ts";
import { FileOps } from "../src/fileops.ts";
import { GitLite } from "../src/git.ts";
import { Sandbox } from "../src/sandbox.ts";
import { tmpDir } from "./helpers.ts";

const builder = { name: "builder", role: "builder" as const };

describe("GitLite", () => {
  let root: string, ops: FileOps, git: GitLite;
  before(() => {
    root = path.join(tmpDir(), "ws");
    const sb = new Sandbox(root);
    ops = new FileOps(sb);
    git = new GitLite(sb);
    git.ensureRepo();
  });

  it("starts with no commits and a clean tree", async () => {
    assert.match(await git.log(), /no commits yet/);
    assert.match(await git.status(), /clean/);
  });

  it("shows changes, commits as the agent, and logs", async () => {
    ops.writeFile("a.txt", "hello\n", builder);
    assert.match(await git.status(), /\?\? a\.txt/);
    const c1 = await git.commit("add a.txt", "builder");
    assert.match(c1, /Committed 1 file\(s\)/);
    assert.match(await git.log(), /builder: add a\.txt/);
    ops.strReplace("a.txt", "hello", "hello world", builder);
    const d = await git.diff();
    assert.match(d, /-hello/);
    assert.match(d, /\+hello world/);
    await git.commit("update a.txt", "builder", ["a.txt"]);
    assert.match(await git.diff({ ref: "HEAD~1" }), /\+hello world/);
    assert.match(await git.log({ max_count: 1 }), /update a\.txt/);
    assert.match(await git.diff(), /no differences/);
  });

  it("rejects empty commits, bad messages, bad refs and escaping paths", async () => {
    await assert.rejects(git.commit("nothing", "builder"), /Nothing to commit/);
    await assert.rejects(git.commit("x", "builder"), /3-500/);
    await assert.rejects(git.commit("fine message", "bad name; rm -rf"), /invalid agent/);
    await assert.rejects(git.diff({ ref: "--output=/tmp/pwned" }), /invalid characters/);
    await assert.rejects(git.diff({ ref: "HEAD; ls" }), /invalid characters/);
    await assert.rejects(git.diff({ path: "../x" }), (e: unknown) => e instanceof ToolError && /traversal/.test((e as Error).message));
    await assert.rejects(git.commit("msg here", "builder", ["../../etc"]), /traversal/);
    await assert.rejects(git.diff({ ref: "does-not-exist" }), /git diff failed/);
  });

  it("cannot be used to run hooks: .git is unreachable and hooks are disabled", async () => {
    assert.throws(() => ops.writeFile(".git/hooks/pre-commit", "#!/bin/sh\ntouch /tmp/pwned", builder), /protected/);
    // even a hook planted by someone with disk access is not executed
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    const marker = path.join(root, "..", "hook-ran");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    ops.writeFile("h.txt", "h", builder);
    await git.commit("trigger hooks?", "builder");
    assert.ok(!fs.existsSync(marker), "hook must not run");
  });

  it("trash directory is excluded from commits", async () => {
    ops.writeFile("t.txt", "t", builder);
    await git.commit("add t", "builder");
    ops.deleteFile("t.txt", true, builder);
    await git.commit("remove t", "builder");
    assert.doesNotMatch(await git.status(), /\.trash/);
  });
});
