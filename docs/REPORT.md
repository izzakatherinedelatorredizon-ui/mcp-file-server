# Report: MCP File Server (stack, tool design, security trade-offs)

> Draft prepared with an AI assistant. Edit it in your own words, and replace the **[EVIDENCE]** markers with real results from your machine before submitting.

## 1. Goal
A shared-memory connector: agents in separate sessions read/write one sandboxed workspace through MCP and hand work to each other through four files (PROJECT_STATE, PLAN_LOG, CHECKPOINTS, DECISIONS).

## 2. Stack and why
| Layer | Choice | Why (and the alternative I rejected) |
|---|---|---|
| Runtime / SDK | Node.js 20+, TypeScript, official `@modelcontextprotocol/sdk` | Reference SDK, types catch schema mistakes; Python would also work but adds a second toolchain for the tests I already wrote. |
| Transport | Streamable HTTP, **stateless** (new server+transport per request) | Required for a public URL. Stateless means nothing is lost on a restart and no session table to leak. stdio is local-only. |
| Validation | `zod` on every tool input | Strict schema = clear errors to the agent and a single source of truth that doubles as the JSON schema the client sees. |
| Exposure | ngrok with a static domain | Stable HTTPS URL on a free account; server itself only binds to `127.0.0.1`. |
| Process manager | pm2 (server **and** tunnel) | Auto-restart on crash, logs, `pm2 save` survives restarts. systemd/Docker would be fine on a VPS but are heavier for a laptop. |
| Version control | git on the host, plus a separate git repo inside the workspace | Agent work is committed with the agent's name, separate from this project's own history. |
| Tests | `node:test` via `tsx`, MCP Inspector, real client | No extra test framework; unit tests need no network; e2e uses the real SDK client. |

Layout: `sandbox` (paths) -> `fileops`/`git` (behaviour, no MCP imports) -> `tools` (schemas + descriptions) -> `server`/`app` (protocol + HTTP + auth). Secrets only in `.env`. Core logic has no MCP dependency, so it is unit-testable offline.

## 3. Tool design choices
- **12 single-purpose tools**; descriptions say *when* to use each and what the output means.
- **Efficiency features**: `handoff_read` returns all four handoff files in one call; `read_file` pages by line range and truncates with a "continue at line N" hint; `search_files` returns `path:line: snippet` so agents avoid reading whole files; `str_replace` avoids resending whole files; outputs are capped at 20k chars.
- **Safety by design**: `write_file` on an existing file requires `expected_version` (optimistic locking) so a stale agent cannot overwrite newer work; `delete_file` needs `confirm=true` and moves to `.trash`; logs are append-only.
- **Errors** are returned as `isError` results with a corrective hint ("Re-read it and merge", "add surrounding context..."); unexpected errors are logged server-side and returned as a generic message, never a stack trace.
- **Roles**: planner / builder / reviewer. Tools a role should not use are not even registered; planner writes are additionally limited to `PROJECT_STATE.md` and `docs/`.

## 4. Security trade-offs
| Threat | Mitigation | Residual risk |
|---|---|---|
| Path traversal (`../`, absolute, `C:\`, UNC, `file:stream`) | Lexical rejection, then `realpath` containment check | - |
| Symlink escape | `realpath` of deepest existing ancestor; write/delete refuse symlinks | TOCTOU: a process with local disk access could swap a symlink between check and use. Agents cannot create symlinks (no such tool). |
| Code execution via git hooks/config | `.git` unreachable; hooks path disabled; `--no-verify`; git run with `execFile` (no shell) and no user/system config | Low |
| Public endpoint abuse | Bearer tokens (32+ chars, constant-time compare), 401 before body parsing, 1 MB body limit | No rate limiting; shared static tokens (rotate by editing `.env`). ngrok policies can add IP/rate rules. |
| Data loss | Overwrite needs version; delete -> `.trash`; workspace is a git repo | An agent with builder rights can still make bad (but recoverable) edits. |
| Regex DoS in `search_files` | Pattern <=200 chars, lines cut at 1000, 5 s time budget | A pathological regex can still block the event loop briefly. |
| Leaking secrets in logs | Audit log stores tool, agent, truncated args - never file contents; tokens never logged | `ALLOW_PATH_TOKEN=true` puts tokens in URLs (off by default). |
| Wrong folder exposed | Server refuses a workspace that contains the project, `$HOME` or `/` | Operator must still pick a dedicated folder. |

Not handled: TLS is terminated by ngrok (traffic between ngrok and the laptop is local); no per-user identity beyond role; no encryption at rest.

## 5. Evidence to attach  **[EVIDENCE]**
- `npm test` output (unit + e2e) - **[EVIDENCE: paste real output]**
- MCP Inspector screenshot listing the tools - **[EVIDENCE]**
- `curl` 401 / 200 checks against the public URL - **[EVIDENCE]**
- `docs/transcript.generated.md` from the real demo (`npm run transcript`) - **[EVIDENCE]**
- `pm2 status` screenshot, and after `pm2 restart all` - **[EVIDENCE]**
- `git log --oneline` of this repo and of `workspace/` - **[EVIDENCE]**

## 6. What I would improve
OAuth instead of static tokens; per-role path allow-lists in config; rate limiting; `list_files` glob; a `restore_file` tool; a Windows-native file-lock test.
