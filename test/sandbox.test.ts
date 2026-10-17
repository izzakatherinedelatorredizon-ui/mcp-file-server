import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, before } from "node:test";
import { ToolError } from "../src/errors.ts";
import { Sandbox, isInside } from "../src/sandbox.ts";
import { tmpDir, trySymlink } from "./helpers.ts";

describe("Sandbox path validation", () => {
  let base: string, root: string, outside: string, sb: Sandbox;
  before(() => {
    base = tmpDir();
    root = path.join(base, "ws");
    outside = path.join(base, "ws-evil"); // sibling that shares the prefix "ws"
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.txt"), "hi");
    sb = new Sandbox(root);
  });

  const rejects = (input: unknown, re?: RegExp) =>
    assert.throws(() => sb.resolve(input), (e: unknown) => e instanceof ToolError && (!re || re.test((e as Error).message)));

  it("accepts normal relative paths and the root", () => {
    assert.equal(sb.resolve("src/a.txt").rel, "src/a.txt");
    assert.equal(sb.resolve("./src//a.txt").rel, "src/a.txt");
    assert.equal(sb.resolve("src\\a.txt").rel, "src/a.txt");
    assert.equal(sb.resolve("").rel, "");
    assert.equal(sb.resolve(".").rel, "");
    assert.equal(sb.resolve("new/dir/file.txt").exists, false);
  });

  it("rejects .. traversal in many spellings", () => {
    for (const p of ["..", "../x", "a/../../x", "..\\x", "a\\..\\..\\x", "src/../../ws-evil/secret.txt", "./../x", "src/.."]) rejects(p, /traversal/i);
  });

  it("rejects absolute and platform-specific paths", () => {
    for (const p of ["/etc/passwd", "\\windows\\system32", "C:\\Windows\\win.ini", "c:foo", "\\\\server\\share\\f", "//server/share", "file.txt:stream"]) rejects(p);
  });

  it("rejects null bytes, non-strings, huge paths, wildcards, reserved names, trailing dots", () => {
    rejects("a\0b");
    rejects(undefined);
    rejects(123);
    rejects("a".repeat(2000));
    rejects("x*.txt");
    rejects("NUL");
    rejects("docs/con.txt");
    rejects("name.");
    rejects("name ");
    rejects(".. ");
    rejects("...");
  });

  it("protects .git and .trash in any case", () => {
    for (const p of [".git", ".git/config", ".GIT/hooks/pre-commit", "a/.Trash/x", ".trash"]) rejects(p, /protected/i);
  });

  it("isInside does not confuse sibling directories sharing a prefix", () => {
    assert.equal(isInside(root, outside), false);
    assert.equal(isInside(root, path.join(root, "src")), true);
    assert.equal(isInside(root, root), true);
    assert.equal(isInside(root, base), false);
  });

  it("blocks a directory symlink that points outside", (t) => {
    if (!trySymlink(outside, path.join(root, "escape"), "dir")) return t.skip("symlinks not permitted here");
    rejects("escape", /outside/i);
    rejects("escape/secret.txt", /outside/i);
    rejects("escape/new-file.txt", /outside/i); // not-yet-existing file below an escaping link
  });

  it("blocks a file symlink that points outside", (t) => {
    if (!trySymlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"), "file")) return t.skip("symlinks not permitted here");
    rejects("link.txt", /outside/i);
  });

  it("blocks a symlink to the sibling-prefix directory (../ws-evil)", (t) => {
    if (!trySymlink("../ws-evil", path.join(root, "sibling"), "dir")) return t.skip("symlinks not permitted here");
    rejects("sibling/secret.txt", /outside/i);
  });

  it("blocks a dangling symlink", (t) => {
    if (!trySymlink(path.join(base, "does-not-exist"), path.join(root, "dangling"))) return t.skip("symlinks not permitted here");
    rejects("dangling");
  });

  it("allows a symlink that stays inside, but not into .git", (t) => {
    if (!trySymlink(path.join(root, "src"), path.join(root, "inner"), "dir")) return t.skip("symlinks not permitted here");
    assert.equal(sb.resolve("inner/a.txt").rel, "src/a.txt");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    if (trySymlink(path.join(root, ".git"), path.join(root, "gitlink"), "dir")) rejects("gitlink/config", /protected/i);
  });
});
