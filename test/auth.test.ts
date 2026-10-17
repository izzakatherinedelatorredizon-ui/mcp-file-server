import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authenticate, parseAgentTokens } from "../src/auth.ts";
import { ALL_TOOLS, ROLE_TOOLS } from "../src/roles.ts";

const T1 = "a".repeat(32), T2 = "b".repeat(32), T3 = "c-_".repeat(11);

describe("token auth", () => {
  it("parses valid config and authenticates the right role", () => {
    const table = parseAgentTokens(`planner:${T1}, builder:${T2},reviewer:${T3}`);
    assert.equal(authenticate(table, T1), "planner");
    assert.equal(authenticate(table, T2), "builder");
    assert.equal(authenticate(table, T3), "reviewer");
  });
  it("rejects missing, wrong, empty and oversized tokens", () => {
    const table = parseAgentTokens(`planner:${T1}`);
    for (const bad of [undefined, "", "wrong", T1 + "x", T1.slice(1), "x".repeat(10_000)]) assert.equal(authenticate(table, bad), null);
  });
  it("refuses weak or malformed configuration", () => {
    assert.throws(() => parseAgentTokens(undefined), /not set/);
    assert.throws(() => parseAgentTokens("planner:short"), /at least 32/);
    assert.throws(() => parseAgentTokens(`hacker:${T1}`), /Unknown role/);
    assert.throws(() => parseAgentTokens(`planner:${T1},planner:${T2}`), /twice/);
    assert.throws(() => parseAgentTokens(`planner:${T1},builder:${T1}`), /same token/);
    assert.throws(() => parseAgentTokens("nocolon"), /role:token/);
    assert.throws(() => parseAgentTokens(`planner:${T1}with spaces here_____`), /32 characters/);
  });
});

describe("role tool policy", () => {
  it("every role tool exists and there are at least 8 tools", () => {
    assert.ok(ALL_TOOLS.length >= 8);
    for (const tools of Object.values(ROLE_TOOLS)) for (const t of tools) assert.ok(ALL_TOOLS.includes(t));
  });
  it("only the builder can delete or commit; reviewer cannot write", () => {
    assert.ok(ROLE_TOOLS.builder.includes("delete_file"));
    assert.ok(ROLE_TOOLS.builder.includes("git_commit"));
    for (const r of ["planner", "reviewer"] as const) {
      assert.ok(!ROLE_TOOLS[r].includes("delete_file"));
      assert.ok(!ROLE_TOOLS[r].includes("git_commit"));
    }
    assert.ok(!ROLE_TOOLS.reviewer.includes("write_file"));
    assert.ok(!ROLE_TOOLS.reviewer.includes("str_replace"));
  });
});
