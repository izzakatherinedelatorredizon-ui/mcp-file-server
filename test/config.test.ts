import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

const tokens = `planner:${"a".repeat(32)},builder:${"b".repeat(32)}`;
const proj = path.join(os.tmpdir(), "proj");

describe("loadConfig safety checks", () => {
  it("loads defaults", () => {
    const c = loadConfig({ AGENT_TOKENS: tokens }, proj);
    assert.equal(c.workspaceRoot, path.join(proj, "workspace"));
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.port, 3000);
    assert.equal(c.allowPathToken, false);
  });
  it("refuses dangerous workspace roots", () => {
    assert.throws(() => loadConfig({ AGENT_TOKENS: tokens, WORKSPACE_ROOT: path.parse(proj).root }, proj), /filesystem root/);
    assert.throws(() => loadConfig({ AGENT_TOKENS: tokens, WORKSPACE_ROOT: os.homedir() }, proj), /home folder/);
    assert.throws(() => loadConfig({ AGENT_TOKENS: tokens, WORKSPACE_ROOT: ".." }, proj), /must not contain the server project/);
    assert.throws(() => loadConfig({ AGENT_TOKENS: tokens, WORKSPACE_ROOT: "./ws", AUDIT_LOG: "./ws/a.jsonl" }, proj), /outside WORKSPACE_ROOT/);
  });
  it("validates port and tokens", () => {
    assert.throws(() => loadConfig({ AGENT_TOKENS: tokens, PORT: "abc" }, proj), /Invalid PORT/);
    assert.throws(() => loadConfig({}, proj), /AGENT_TOKENS/);
  });
});
