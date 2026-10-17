# Demo guide: multi-step task across 3 agent sessions

**Task ("rename refactor")**: in the demo project (`workspace/`), rename the function `calcTotal` to `calculateTotal`
everywhere (code and docs), remove the deprecated duplicate `legacy/old_totals.js`, and commit - without breaking the program.

Why this task: it needs *planning* (find every usage), *careful edits* (str_replace, one destructive delete), *handoff*
(three sessions that share nothing but files) and has an objective check (`node src/index.js` prints the same output before and after).

## 0. Before you start (once)
```bash
npm run init-workspace:demo           # workspace/ with handoff files, demo project, baseline commit
cd workspace && node src/index.js     # BEFORE output - should be: Items: 6 / Total: 12.50 / Report: 2 line(s), total 12.50
cd ..
npm run dev                           # or: pm2 start ecosystem.config.cjs  (then use the https URL in client configs)
```
Empty the audit log first so the transcript contains only the demo: delete `logs/audit.jsonl` while the server is stopped.

## 1. Session A - planner (new client session, planner token)
Prompt to paste:
> You are the **planner**. Task: rename `calcTotal` to `calculateTotal` across the project, delete the deprecated `legacy/old_totals.js`, keep `node src/index.js` output unchanged, and commit. Do NOT edit code. Start with `handoff_read`. Find every usage with `search_files` (do not read whole files). Then update PROJECT_STATE.md with the goal, the exact list of files and occurrences, and numbered next steps for the builder. Log your plan in PLAN_LOG and any decision in DECISIONS. Stop when the plan is written.

Expected calls (about 5-7): `handoff_read` -> `search_files(calcTotal)` -> `str_replace`/`write_file` on `PROJECT_STATE.md` (write_file needs the version shown by handoff_read) -> `handoff_append(PLAN_LOG)` -> `handoff_append(DECISIONS)`.
Also try once (good for Q&A): ask it to edit `src/cart.js` -> refused (planner may only write PROJECT_STATE.md / docs/). `delete_file` is not even in its tool list.

## 2. Session B - builder (brand-new session, builder token; it remembers nothing)
> You are the **builder**. Start with `handoff_read` and follow PROJECT_STATE.md. Before deleting anything, confirm with `search_files` that nothing imports `legacy/old_totals.js`. Make the edits with `str_replace` (no whole-file rewrites), delete the deprecated file, verify with `search_files` that no `calcTotal` remains, then `git_commit`. Update PROJECT_STATE.md and add a CHECKPOINTS entry. Stop when done.

Expected (about 10-14 calls): `handoff_read` -> `search_files` (x2) -> `str_replace` on `src/cart.js`, `src/index.js` (replace_all), `src/report.js` (replace_all), `docs/API.md`, `README.md` -> `delete_file(confirm=true)` -> `search_files` (expect none) -> `git_commit` -> `str_replace` PROJECT_STATE.md -> `handoff_append(CHECKPOINTS)`.
Red flags to point out: reading whole files repeatedly, retrying an identical failed call, overwriting with `write_file`.

## 3. Session C - reviewer (new session, reviewer token, read-only)
> You are the **reviewer**. Start with `handoff_read`. Verify the builder's claims: `git_log`, `git_diff` with ref `HEAD~1`, and `search_files` for any leftover `calcTotal`. Do not modify code. Append your verdict (pass/fail and why) to CHECKPOINTS.

Expected (about 5 calls): `handoff_read`, `git_log`, `git_diff`, `search_files`, `handoff_append(CHECKPOINTS)`.

## 4. Verify the final result yourself (outside the agents)
```bash
cd workspace
node src/index.js                      # AFTER: identical three lines to the BEFORE output
grep -r calcTotal . --include="*" --exclude-dir=.git --exclude-dir=.trash   # (PowerShell: Select-String -Path . -Pattern calcTotal -Recurse) -> no hits
ls legacy                              # old_totals.js gone; copy is in .trash/
git log --oneline --format="%h %an: %s"    # commits authored by "builder"
cat PROJECT_STATE.md PLAN_LOG.md CHECKPOINTS.md DECISIONS.md
cd .. && npm run transcript -- --out=docs/transcript.generated.md
```

## 5. Evidence to capture
Screenshots/pastes of: each client session's tool calls; `docs/transcript.generated.md`; the before/after program output; `git log` of `workspace/`; `pm2 status`; the 401 `curl`; test output; MCP Inspector tool list.

## 6. Five-minute live demo script
| Time | Do | Say |
|---|---|---|
| 0:00-0:45 | Show repo tree + `pm2 status` + 401 vs 200 `curl` on the public URL | "Server and tunnel are kept alive by pm2; the endpoint needs a token." |
| 0:45-1:30 | Run `npm test` (pre-recorded if slow) and show `sandbox.test.ts` names | "Traversal, absolute, UNC, symlink escapes are all tested." |
| 1:30-3:30 | Run session B only (plan is pre-written by a prior session A); show tool calls | "A fresh agent resumes from the handoff files. Read -> search -> small edits -> commit." |
| 3:30-4:15 | Ask the client to read `../../etc/passwd` -> error; reviewer tries to write -> not offered | "Sandbox and roles hold." |
| 4:15-5:00 | Show before/after program output, `git log`, transcript | "Same output, no leftover references, auditable." |

Likely Q&A: why stateless HTTP? why separate roles? what if two agents write at once (expected_version)? what if the token leaks (rotate in `.env`, restart)? why not give the agent a shell? (execution = no sandbox).

## 7. Example transcript format - **EXAMPLE ONLY, NOT PRODUCED BY A REAL RUN**
```
[example] planner  handoff_read            -> 4 files (PROJECT_STATE version 1a2b...)
[example] planner  search_files calcTotal  -> 7 matches in 5 files
[example] planner  str_replace PROJECT_STATE.md -> ok
...
```
Your real transcript comes from `npm run transcript`; never paste an invented one.
