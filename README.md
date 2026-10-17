# MCP File Server (sandboxed workspace connector)

A small, security-focused [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents
read, search, edit and commit files **inside one sandbox folder**, over HTTPS, with three agent roles and a
file-based handoff protocol so agents in different sessions can continue each other's work.

```
 MCP client (agent) ──HTTPS──▶ ngrok tunnel ──▶ 127.0.0.1:3000 ──▶ Express ──▶ token auth ──▶ role-filtered MCP server
                                                                                          └▶ sandbox ──▶ workspace/  (own git repo)
                                                                                          └▶ audit log (logs/audit.jsonl)
 pm2 keeps the server and the tunnel alive.
```

## Features (maps to the assignment)

| Requirement | Where |
|---|---|
| Sandboxed root, escapes rejected | `src/sandbox.ts` (+ `test/sandbox.test.ts`) |
| 8+ tools | 12 tools in `src/tools.ts` |
| HTTPS tunnel + process manager | ngrok + pm2 in `ecosystem.config.cjs` |
| Handoff protocol | `templates/handoff/` -> `workspace/` (PROJECT_STATE, PLAN_LOG, CHECKPOINTS, DECISIONS) |
| Real client, 2+ sessions | `docs/DEMO_GUIDE.md` |
| Report | `docs/REPORT.md` |
| Stretch | `expected_version` locking, `search_files` (regex), token auth |

### The 12 tools

| Tool | Purpose | planner | builder | reviewer |
|---|---|:-:|:-:|:-:|
| `list_files` | list a directory (names/sizes) | ✔ | ✔ | ✔ |
| `read_file` | read text, by line range, with version | ✔ | ✔ | ✔ |
| `search_files` | find text/regex across files | ✔ | ✔ | ✔ |
| `handoff_read` | read all 4 handoff files in one call | ✔ | ✔ | ✔ |
| `handoff_append` | append to PLAN_LOG / CHECKPOINTS / DECISIONS | ✔ | ✔ | ✔ |
| `git_status`, `git_diff`, `git_log` | inspect repository | ✔ | ✔ | ✔ |
| `write_file` | create / overwrite (needs `expected_version`) | docs only | ✔ | – |
| `str_replace` | exact-text edit | docs only | ✔ | – |
| `delete_file` | delete to `.trash`, needs `confirm=true` | – | ✔ | – |
| `git_commit` | commit as the agent | – | ✔ | – |

"docs only" = planner may write only `PROJECT_STATE.md` and `docs/`.

## Prerequisites

- Node.js **20.6 or newer** (`node -v`), npm, and git.
- A free [ngrok](https://ngrok.com) account with a **static domain** (dashboard -> Domains) and the ngrok agent installed and authenticated (`ngrok config add-authtoken <token>`).
- pm2: `npm install -g pm2`.

## Setup (from a fresh clone)

```bash
npm install
npm run gen-tokens            # prints a line starting with AGENT_TOKENS=...
cp .env.example .env          # Windows cmd: copy .env.example .env
# edit .env: paste the AGENT_TOKENS line, set NGROK_DOMAIN=your-name.ngrok-free.app
npm run typecheck             # should print nothing
npm test                      # unit + end-to-end tests
npm run init-workspace:demo   # creates workspace/ with handoff files + demo project, makes the first git commit
npm run dev                   # starts on http://127.0.0.1:3000/mcp
```

Environment variables (all in `.env`, see `.env.example`): `AGENT_TOKENS`, `WORKSPACE_ROOT`, `HOST`, `PORT`,
`AUDIT_LOG`, `ALLOW_PATH_TOKEN`, `NGROK_DOMAIN`. The server refuses to start if tokens are missing/short or if
`WORKSPACE_ROOT` contains the project, your home folder, or the filesystem root.

### Quick local check (no tunnel needed)

```bash
curl -i http://127.0.0.1:3000/health                                   # 200 {"ok":true}
curl -i -X POST http://127.0.0.1:3000/mcp -H "content-type: application/json" \
     -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 401: no token
```

Then use MCP Inspector (`npm run inspector`): transport *Streamable HTTP*, URL `http://127.0.0.1:3000/mcp`,
header `Authorization: Bearer <builder token>`, press **Connect -> Tools -> List Tools**.

## Deploy: tunnel + process manager

```bash
npm run build
pm2 start ecosystem.config.cjs      # starts "mcp-server" and "mcp-tunnel" (ngrok)
pm2 status                          # both should be "online"
pm2 save                            # remember the process list
pm2 startup                         # Linux/macOS: prints a command to run so pm2 restarts on boot
```

Windows: `pm2 startup` is not supported there; use the `pm2-installer` project or a Task Scheduler task that runs
`pm2 resurrect` at logon. Verify the public endpoint:

```bash
curl -i https://YOUR-DOMAIN.ngrok-free.app/health                       # 200
curl -i -X POST https://YOUR-DOMAIN.ngrok-free.app/mcp -d '{}'          # 401  <- endpoint is not open
```

**Survives a restart?** `pm2 restart all` (or reboot + `pm2 resurrect`) brings both back; the server is stateless,
and all data lives in `workspace/`.

## Connect a real MCP client

See `client-configs/README.md`. One session per role, each with its own token:

```bash
export MCP_BUILDER_TOKEN=...      # PowerShell: $env:MCP_BUILDER_TOKEN="..."
claude --strict-mcp-config --mcp-config client-configs/claude-code-builder.json
```

Some web-based clients cannot send an `Authorization` header. For those only, set `ALLOW_PATH_TOKEN=true` and use
`https://YOUR-DOMAIN.ngrok-free.app/mcp/<token>` (tokens in URLs can show up in logs: rotate them afterwards).

## Run the demo

Follow `docs/DEMO_GUIDE.md` (three short sessions: planner -> builder -> reviewer). Afterwards:

```bash
npm run transcript -- --out=docs/transcript.generated.md    # real tool-call transcript from the audit log
```

## Security model (short)

- Every path is validated lexically (no `..`, absolute, drive, UNC, `:`, reserved Windows names) **and** resolved with
  `realpath`, so symlinks that leave the workspace are rejected. `.git` and `.trash` are unreachable for agents.
- Bearer tokens (32+ chars, constant-time comparison), one per role; the server only *registers* the tools a role needs.
- Destructive actions: `delete_file` needs `confirm=true` and moves to `.trash`; overwrites need `expected_version`;
  handoff logs are append-only; hooks are disabled for git; every call is audit-logged (file contents are not).
- Server binds to `127.0.0.1`; only the tunnel exposes it. Use a **dedicated** workspace, never real personal files.
- Known limits: see `docs/REPORT.md` (TOCTOU race on symlinks, no rate limiting, shared static tokens).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Configuration error: AGENT_TOKENS ...` | Run `npm run gen-tokens`, paste into `.env`. |
| 401 from the client | Token mismatch or missing `Bearer ` prefix; check the header. |
| ngrok `ERR_NGROK_...` / tunnel offline | `pm2 logs mcp-tunnel`; confirm `ngrok config add-authtoken` and `NGROK_DOMAIN`; older ngrok needs `--domain`. |
| Tools missing in the client | Roles only see their own tools (reviewer has no `write_file` by design). |
| `git ... failed` | Install git; make sure `workspace/.git` exists (`npm run init-workspace`). |
| Symlink tests skipped on Windows | Enable Developer Mode (allows symlinks) or run tests in WSL. |
| Recover a deleted file | Copy it back from `workspace/.trash/`. |

## Project layout

```
src/        sandbox.ts fileops.ts git.ts roles.ts auth.ts config.ts audit.ts tools.ts server.ts app.ts index.ts
test/       unit tests (sandbox, fileops, git, tools, auth, config) + e2e.test.ts (real HTTP + SDK client)
scripts/    gen-tokens, init-workspace, transcript
templates/  handoff file templates          demo-seed/  sample project used by the demo
docs/       REPORT.md  DEMO_GUIDE.md         client-configs/  ecosystem.config.cjs  .env.example
PROJECT_STATE.md PLAN_LOG.md CHECKPOINTS.md DECISIONS.md   <- this repo's own handoff files
```
