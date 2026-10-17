# DECISIONS

## 2026-10-17 · assistant
Stateless Streamable HTTP (new server per request): no session state to lose on restart; fits per-request role filtering.

## 2026-10-17 · assistant
Three roles with different tool sets, registered per request; planner writes limited to PROJECT_STATE.md and docs/.

## 2026-10-17 · assistant
Overwrite requires `expected_version` (optimistic locking) and handoff logs are append-only, to stop agents clobbering each other.

## 2026-10-17 · assistant
Delete = move to `.trash` + `confirm=true`; `.git` and `.trash` unreachable; git hooks disabled (hooks would be code execution).

## 2026-10-17 · assistant
Core logic has no MCP/zod imports so it can be unit-tested without installing dependencies; imports use `.ts` extensions (TS 5.7 `rewriteRelativeImportExtensions`).

## 2026-10-17 · assistant
Path-in-URL token auth exists but is off by default (tokens in URLs leak into logs).
