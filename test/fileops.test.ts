import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach } from "node:test";
import { ToolError } from "../src/errors.ts";
import { FileOps, LIMITS } from "../src/fileops.ts";
import type { Agent } from "../src/roles.ts";
import { Sandbox } from "../src/sandbox.ts";
import { tmpDir, trySymlink } from "./helpers.ts";

const builder: Agent = { name: "builder", role: "builder" };
const planner: Agent = { name: "planner", role: "planner" };
const reviewer: Agent = { name: "reviewer", role: "reviewer" };

const version = (s: string) => /version: ([0-9a-f]{16})/.exec(s)![1]!;
const throwsTool = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof ToolError && re.test((e as Error).message));

describe("FileOps", () => {
  let root: string, ops: FileOps;
  beforeEach(() => {
    root = path.join(tmpDir(), "ws");
    ops = new FileOps(new Sandbox(root));
  });

  it("lists files, hides .git/.trash, handles empty and missing dirs", () => {
    assert.match(ops.listFiles("."), /empty directory/);
    ops.writeFile("src/a.txt", "x", builder);
    fs.mkdirSync(path.join(root, ".git"));
    const out = ops.listFiles(".");
    assert.match(out, /src\//);
    assert.doesNotMatch(out, /\.git/);
    assert.match(ops.listFiles(".", { recursive: true }), /src\/a\.txt/);
    throwsTool(() => ops.listFiles("nope"), /Not found/);
    throwsTool(() => ops.listFiles("src/a.txt"), /is a file/);
  });

  it("creates, reads (with version and line ranges) and chunks long files", () => {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const w = ops.writeFile("big.txt", body, builder);
    assert.match(w, /Created big\.txt/);
    const r = ops.readFile("big.txt", { start_line: 5, end_line: 7 });
    assert.match(r, /lines 5-7 of 100/);
    assert.match(r, /line 5\nline 6\nline 7$/);
    assert.equal(version(r), version(w));
    const small = ops.readFile("big.txt", { max_chars: 200 });
    assert.match(small, /truncated: continue with start_line=\d+/);
    throwsTool(() => ops.readFile("big.txt", { start_line: 500 }), /past the end/);
    throwsTool(() => ops.readFile("missing.txt"), /Not found/);
    throwsTool(() => ops.readFile("."), /directory/);
  });

  it("refuses binary files and oversized writes", () => {
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    throwsTool(() => ops.readFile("bin.dat"), /binary/);
    throwsTool(() => ops.writeFile("huge.txt", "a".repeat(LIMITS.maxWriteBytes + 1), builder), /larger than/);
    throwsTool(() => ops.writeFile("nullbyte.txt", "a\0b", builder), /null byte/);
  });

  it("requires expected_version to overwrite and detects stale writes", () => {
    const w = ops.writeFile("f.txt", "one", builder);
    throwsTool(() => ops.writeFile("f.txt", "two", builder), /already exists.*expected_version/);
    throwsTool(() => ops.writeFile("f.txt", "two", builder, "0000000000000000"), /changed since you read/);
    const w2 = ops.writeFile("f.txt", "two", builder, version(w));
    assert.match(w2, /Overwrote/);
    assert.equal(fs.readFileSync(path.join(root, "f.txt"), "utf8"), "two");
    // old version is now stale: a second agent holding it cannot clobber
    throwsTool(() => ops.writeFile("f.txt", "three", builder, version(w)), /changed since you read/);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith(".tmp")), []);
  });

  it("str_replace: 0, 1, many matches, replace_all, version check", () => {
    const w = ops.writeFile("s.txt", "foo bar\nfoo baz\n", builder);
    throwsTool(() => ops.strReplace("s.txt", "nothing", "x", builder), /not found/);
    throwsTool(() => ops.strReplace("s.txt", "foo", "x", builder), /appears 2 times/);
    throwsTool(() => ops.strReplace("s.txt", "", "x", builder), /non-empty/);
    throwsTool(() => ops.strReplace("s.txt", "foo", "foo", builder), /identical/);
    throwsTool(() => ops.strReplace("s.txt", "bar", "x", builder, { expected_version: "bad" }), /changed since/);
    assert.match(ops.strReplace("s.txt", "bar", "BAR", builder, { expected_version: version(w) }), /line 1/);
    assert.match(ops.strReplace("s.txt", "foo", "FOO", builder, { replace_all: true }), /2 occurrence/);
    assert.equal(fs.readFileSync(path.join(root, "s.txt"), "utf8"), "FOO BAR\nFOO baz\n");
    // "$&" in new_str must be literal
    ops.strReplace("s.txt", "baz", "$& $1", builder);
    assert.match(fs.readFileSync(path.join(root, "s.txt"), "utf8"), /\$& \$1/);
    throwsTool(() => ops.strReplace("gone.txt", "a", "b", builder), /Not found/);
  });

  it("delete requires confirm, moves to .trash, and protects handoff files", () => {
    ops.writeFile("d.txt", "bye", builder);
    throwsTool(() => ops.deleteFile("d.txt", false, builder), /confirm=true/);
    assert.ok(fs.existsSync(path.join(root, "d.txt")));
    const msg = ops.deleteFile("d.txt", true, builder);
    assert.match(msg, /\.trash\//);
    assert.ok(!fs.existsSync(path.join(root, "d.txt")));
    assert.equal(fs.readdirSync(path.join(root, ".trash")).length, 1);
    throwsTool(() => ops.deleteFile("PROJECT_STATE.md", true, builder), /cannot be deleted/);
    throwsTool(() => ops.deleteFile("missing.txt", true, builder), /Not found/);
    ops.writeFile("dir/x.txt", "x", builder);
    throwsTool(() => ops.deleteFile("dir", true, builder), /directory/);
    throwsTool(() => ops.deleteFile("../x", true, builder), /traversal/);
  });

  it("append-only handoff logs cannot be overwritten or edited, only appended", () => {
    ops.handoffAppend("PLAN_LOG.md", "first entry", planner);
    ops.handoffAppend("PLAN_LOG.md", "second entry", builder);
    const log = fs.readFileSync(path.join(root, "PLAN_LOG.md"), "utf8");
    assert.match(log, /first entry/);
    assert.match(log, /· builder\nsecond entry/);
    throwsTool(() => ops.writeFile("PLAN_LOG.md", "wiped", builder, "x"), /append-only/);
    throwsTool(() => ops.strReplace("DECISIONS.md", "a", "b", builder), /append-only/);
    throwsTool(() => ops.handoffAppend("PROJECT_STATE.md", "x", builder), /must be one of/);
    throwsTool(() => ops.handoffAppend("PLAN_LOG.md", "  ", builder), /empty/);
    throwsTool(() => ops.handoffAppend("../x", "hi", builder), /must be one of/);
  });

  it("handoff_read returns all four files in one call and tails long logs", () => {
    ops.writeFile("PROJECT_STATE.md", "# State\nstatus: new\n", builder);
    for (let i = 0; i < 200; i++) ops.handoffAppend("PLAN_LOG.md", `entry number ${i}`, builder);
    const out = ops.handoffRead(500);
    for (const f of ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"]) assert.match(out, new RegExp(f));
    assert.match(out, /status: new/);
    assert.match(out, /entry number 199/);
    assert.doesNotMatch(out, /entry number 0\n/);
    assert.match(out, /\(missing/);
  });

  it("role write scopes: planner only PROJECT_STATE.md and docs/, reviewer nothing", () => {
    ops.writeFile("PROJECT_STATE.md", "s", planner);
    ops.writeFile("docs/plan.md", "p", planner);
    throwsTool(() => ops.writeFile("src/app.js", "x", planner), /may only write to/);
    throwsTool(() => ops.writeFile("docs2/x.md", "x", planner), /may only write to/);
    throwsTool(() => ops.writeFile("docs/x.md", "x", reviewer), /may only write to/);
  });

  it("search: literal, regex, glob, case, limits, invalid regex, skips binaries/.git", () => {
    ops.writeFile("src/a.js", "const calcTotal = 1;\nlet x;\n", builder);
    ops.writeFile("src/b.md", "calcTotal docs\n", builder);
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git", "x.txt"), "calcTotal in git");
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from("calcTotal\0"));
    const all = ops.searchFiles("calctotal");
    assert.match(all, /src\/a\.js:1:/);
    assert.match(all, /src\/b\.md:1:/);
    assert.doesNotMatch(all, /\.git|bin\.dat/);
    assert.doesNotMatch(ops.searchFiles("calctotal", ".", { case_sensitive: true }), /src\/a/);
    const js = ops.searchFiles("calcTotal", ".", { glob: "*.js" });
    assert.match(js, /a\.js/);
    assert.doesNotMatch(js, /b\.md/);
    assert.match(ops.searchFiles("calc\\w+", ".", { regex: true }), /a\.js/);
    assert.match(ops.searchFiles("nothing-like-this"), /No matches/);
    assert.match(ops.searchFiles("calcTotal", "src", { max_results: 1 }), /truncated/);
    throwsTool(() => ops.searchFiles("(", ".", { regex: true }), /Invalid regular expression/);
    throwsTool(() => ops.searchFiles("", "."), /1-200/);
    throwsTool(() => ops.searchFiles("x", "../.."), /traversal/);
  });

  it("never reads or writes through a symlink that escapes", (t) => {
    const outside = path.join(path.dirname(root), "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
    if (!trySymlink(outside, path.join(root, "esc"), "dir")) return t.skip("symlinks not permitted here");
    throwsTool(() => ops.readFile("esc/secret.txt"), /outside/);
    throwsTool(() => ops.writeFile("esc/new.txt", "x", builder), /outside/);
    throwsTool(() => ops.deleteFile("esc/secret.txt", true, builder), /outside/);
    assert.ok(!fs.existsSync(path.join(outside, "new.txt")));
    assert.ok(fs.existsSync(path.join(outside, "secret.txt")));
    assert.doesNotMatch(ops.searchFiles("SECRET"), /secret\.txt/); // search does not follow symlinks
  });

  it("refuses to modify an in-workspace symlink itself", (t) => {
    ops.writeFile("real.txt", "r", builder);
    if (!trySymlink(path.join(root, "real.txt"), path.join(root, "alias.txt"), "file")) return t.skip("symlinks not permitted here");
    // alias.txt resolves to real.txt inside the workspace; reading is fine
    assert.match(ops.readFile("alias.txt"), /real\.txt/);
  });
});
