// Tests the tool table (schemas + handlers) directly, without the MCP transport.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, before } from "node:test";
import { z } from "zod";
import { FileOps } from "../src/fileops.ts";
import { GitLite } from "../src/git.ts";
import { ALL_TOOLS } from "../src/roles.ts";
import { Sandbox } from "../src/sandbox.ts";
import { TOOLS, type ToolCtx } from "../src/tools.ts";
import { tmpDir } from "./helpers.ts";

const parse = (name: string, input: unknown) => z.object(TOOLS.find((t) => t.name === name)!.schema).safeParse(input);
const byName = (name: string) => TOOLS.find((t) => t.name === name)!;

describe("tool definitions", () => {
  let ctx: ToolCtx;
  before(() => {
    const sb = new Sandbox(path.join(tmpDir(), "ws"));
    const git = new GitLite(sb);
    git.ensureRepo();
    ctx = { agent: { name: "builder", role: "builder" }, ops: new FileOps(sb), git };
  });

  it("defines exactly the tools the role policy knows about (12, all single-purpose)", () => {
    assert.deepEqual(TOOLS.map((t) => t.name).sort(), [...ALL_TOOLS].sort());
    assert.ok(TOOLS.length >= 8);
    for (const t of TOOLS) assert.ok(t.description.length >= 60, `${t.name} description too short`);
  });

  it("schemas reject bad input and apply defaults", () => {
    assert.equal(parse("read_file", {}).success, false);
    assert.equal(parse("read_file", { path: "" }).success, false);
    assert.equal(parse("read_file", { path: "a.txt", start_line: 0 }).success, false);
    assert.equal(parse("read_file", { path: "a.txt", start_line: "1" }).success, false);
    assert.equal(parse("write_file", { path: "a.txt" }).success, false);
    assert.equal(parse("write_file", { path: "a.txt", content: "x", expected_version: "zzz" }).success, false);
    assert.equal(parse("delete_file", { path: "a.txt" }).success, false, "confirm is required");
    assert.equal(parse("delete_file", { path: "a.txt", confirm: "yes" }).success, false);
    assert.equal(parse("handoff_append", { file: "PROJECT_STATE.md", entry: "x" }).success, false);
    assert.equal(parse("handoff_append", { file: "PLAN_LOG.md", entry: "" }).success, false);
    assert.equal(parse("git_commit", { message: "x" }).success, false);
    const ok = parse("list_files", {});
    assert.ok(ok.success && ok.data.path === "." && ok.data.recursive === false);
  });

  it("destructive tool is flagged and handlers work end to end", async () => {
    assert.equal(byName("delete_file").destructive, true);
    for (const t of TOOLS.filter((t) => t.readOnly)) assert.equal(t.destructive, false);
    const run = async (name: string, input: Record<string, unknown>) => {
      const parsed = z.object(byName(name).schema).parse(input);
      return byName(name).handler(ctx, parsed);
    };
    assert.match(String(await run("write_file", { path: "x/y.txt", content: "one\ntwo\n" })), /Created x\/y\.txt/);
    assert.match(String(await run("list_files", { recursive: true })), /x\/y\.txt/);
    assert.match(String(await run("read_file", { path: "x/y.txt", start_line: 2 })), /two/);
    assert.match(String(await run("str_replace", { path: "x/y.txt", old_str: "two", new_str: "2" })), /Replaced 1/);
    assert.match(String(await run("search_files", { pattern: "2", glob: "*.txt" })), /x\/y\.txt:2/);
    assert.match(String(await run("handoff_append", { file: "DECISIONS.md", entry: "use zod" })), /Appended/);
    assert.match(String(await run("handoff_read", {})), /use zod/);
    assert.match(String(await run("git_status", {})), /x\//);
    assert.match(String(await run("git_commit", { message: "add y" })), /Committed/);
    assert.match(String(await run("git_log", {})), /builder: add y/);
    assert.match(String(await run("git_diff", {})), /no differences/);
    assert.match(String(await run("delete_file", { path: "x/y.txt", confirm: true })), /\.trash/);
  });
});
