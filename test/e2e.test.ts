// End-to-end test: real HTTP server + real MCP client (official SDK) over Streamable HTTP.
// Needs `npm install` first (SDK, express, zod).
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { tmpDir } from "./helpers.ts";

const TOK = { planner: "p".repeat(40), builder: "b".repeat(40), reviewer: "r".repeat(40) };

describe("MCP server end-to-end (HTTP + real SDK client)", () => {
  let base: string, url: string, close: () => Promise<void>, workspace: string, auditFile: string;
  const clients: Client[] = [];

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "e2e-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(client);
    return client;
  }
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
  };

  before(async () => {
    base = tmpDir("mcp-e2e-");
    workspace = path.join(base, "ws");
    auditFile = path.join(base, "audit.jsonl");
    const cfg = loadConfig(
      { AGENT_TOKENS: `planner:${TOK.planner},builder:${TOK.builder},reviewer:${TOK.reviewer}`, WORKSPACE_ROOT: workspace, AUDIT_LOG: auditFile },
      path.join(base, "project"),
    );
    const { app } = createApp(cfg);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  after(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await close();
  });

  it("endpoint check: no token, wrong token and wrong method are rejected; /health leaks nothing", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(init) })).status, 401);
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: JSON.stringify(init) })).status, 401);
    assert.equal((await fetch(`${url}/mcp/${TOK.builder}`, { method: "POST", headers, body: JSON.stringify(init) })).status, 404, "path tokens are off by default");
    assert.equal((await fetch(`${url}/mcp`, { method: "GET", headers: { authorization: `Bearer ${TOK.builder}` } })).status, 405);
    const health = await fetch(`${url}/health`);
    assert.deepEqual(await health.json(), { ok: true });
    const bad = await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer ${TOK.builder}` }, body: "{not json" });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(await bad.text(), /\bat \w+.*\.(js|ts):\d+/, "no stack traces");
  });

  it("each role sees only its own tools; builder exposes 8+ tools with schemas and descriptions", async () => {
    const names = async (t: string) => (await (await connect(t)).listTools()).tools.map((x) => x.name);
    const planner = await names(TOK.planner), builder = await names(TOK.builder), reviewer = await names(TOK.reviewer);
    assert.ok(builder.length >= 8);
    assert.ok(builder.includes("delete_file") && builder.includes("git_commit"));
    assert.ok(!planner.includes("delete_file") && !planner.includes("git_commit"));
    assert.ok(!reviewer.includes("write_file") && !reviewer.includes("delete_file") && !reviewer.includes("str_replace"));
    const tools = (await clients[clients.length - 2]!.listTools()).tools; // builder client
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 30, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, "object");
    }
  });

  it("multi-step task across three agent sessions (planner -> builder -> reviewer)", async () => {
    // Session 1: planner
    const planner = await connect(TOK.planner);
    const h0 = await call(planner, "handoff_read");
    assert.match(h0.text, /missing/);
    assert.equal((await call(planner, "write_file", { path: "PROJECT_STATE.md", content: "# State\nGoal: add hello.txt\n" })).isError, false);
    assert.equal((await call(planner, "handoff_append", { file: "PLAN_LOG.md", entry: "Plan: builder creates hello.txt then commits" })).isError, false);
    const denied = await call(planner, "write_file", { path: "hello.txt", content: "x" });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /may only write/);
    await planner.close();

    // Session 2: builder (a brand-new connection that only has the files to go on)
    const builder = await connect(TOK.builder);
    const h1 = await call(builder, "handoff_read");
    assert.match(h1.text, /Goal: add hello\.txt/);
    assert.match(h1.text, /Plan: builder creates hello\.txt/);
    await call(builder, "write_file", { path: "hello.txt", content: "hello\n" });
    const again = await call(builder, "write_file", { path: "hello.txt", content: "clobber" });
    assert.equal(again.isError, true);
    assert.match(again.text, /expected_version/);
    assert.equal((await call(builder, "str_replace", { path: "hello.txt", old_str: "hello", new_str: "hello world" })).isError, false);
    assert.equal((await call(builder, "delete_file", { path: "hello.txt", confirm: false })).isError, true);
    const commit = await call(builder, "git_commit", { message: "add hello.txt" });
    assert.match(commit.text, /Committed/);
    await call(builder, "handoff_append", { file: "CHECKPOINTS.md", entry: "hello.txt committed" });
    await builder.close();

    // Session 3: reviewer (read-only)
    const reviewer = await connect(TOK.reviewer);
    assert.match((await call(reviewer, "git_diff", { ref: "HEAD~1" }).catch(() => ({ text: "" }))).text + (await call(reviewer, "git_log")).text, /add hello\.txt/);
    assert.match((await call(reviewer, "search_files", { pattern: "hello world" })).text, /hello\.txt:1/);
    assert.match((await call(reviewer, "read_file", { path: "hello.txt" })).text, /hello world/);
    assert.equal(fs.readFileSync(path.join(workspace, "hello.txt"), "utf8"), "hello world\n");
    await assert.rejects(call(reviewer, "delete_file", { path: "hello.txt", confirm: true }).then((r) => { if (r.isError) throw new Error(r.text); }));
  });

  it("security: traversal, absolute paths, .git access and bad input come back as isError, never a crash or stack", async () => {
    const builder = await connect(TOK.builder);
    for (const [tool, args] of [
      ["read_file", { path: "../../etc/passwd" }],
      ["read_file", { path: "/etc/passwd" }],
      ["read_file", { path: "C:\\Windows\\win.ini" }],
      ["write_file", { path: "../escape.txt", content: "x" }],
      ["write_file", { path: ".git/hooks/pre-commit", content: "x" }],
      ["list_files", { path: ".." }],
      ["delete_file", { path: "..\\..\\x", confirm: true }],
      ["search_files", { pattern: "root", path: "../.." }],
    ] as const) {
      const r = await call(builder, tool, args as Record<string, unknown>);
      assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} should be an error`);
      assert.doesNotMatch(r.text, /\bat .*\.(js|ts):\d+/);
    }
    assert.ok(!fs.existsSync(path.join(base, "escape.txt")));
    // schema validation: wrong types / missing fields -> error (as isError result or protocol error), not a crash
    let rejected = false;
    try { rejected = (await call(builder, "write_file", { path: 42 })).isError; } catch { rejected = true; }
    assert.ok(rejected);
    assert.match((await call(builder, "list_files")).text, /hello\.txt/, "server still healthy");
  });

  it("every call was written to the audit log with the agent's role", () => {
    const entries = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(entries.length > 10);
    for (const role of ["planner", "builder", "reviewer"]) assert.ok(entries.some((e) => e.agent === role), `missing ${role}`);
    assert.ok(entries.some((e) => e.ok === false && e.tool === "read_file"));
    assert.ok(!JSON.stringify(entries).includes("clobber"), "file contents must not be logged");
  });
});
