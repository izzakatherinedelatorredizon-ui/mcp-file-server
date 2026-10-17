# Handoff protocol (read me first)

Several agents share this workspace but never share a chat. These files are their shared memory.

## Start of every session
1. Call `handoff_read` (one call returns all four files).
2. Do only what PROJECT_STATE.md "Next steps" says for your role.

## During the session
- Read before you write. Use `search_files` instead of reading whole files.
- Prefer `str_replace` for edits; `write_file` on an existing file needs `expected_version` from `read_file`.
- Log intentions in PLAN_LOG, verified milestones in CHECKPOINTS, choices in DECISIONS (all via `handoff_append`).

## End of every session
1. Rewrite PROJECT_STATE.md (status, done, next steps) - keep it short.
2. Add a final CHECKPOINTS entry saying what is verified.

## Roles
| Role | Can do | Cannot do |
|---|---|---|
| planner | read everything; edit PROJECT_STATE.md and docs/; append logs | change code, delete, commit |
| builder | read, write, str_replace, delete (to .trash), commit | - |
| reviewer | read, search, git diff/log/status; append logs | write, delete, commit |
