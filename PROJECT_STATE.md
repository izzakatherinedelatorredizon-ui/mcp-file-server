# PROJECT_STATE (this repository)

_Last updated: 2026-10-17 by the AI assistant (first build session)._

## Goal
Midterms Pt 1: sandboxed MCP file-server connector, deployed over HTTPS, proven on a multi-step task across 2+ agent sessions.

## Status
Code, tests, deployment config and docs are written. **Nothing has been run on the student's machine yet**: `npm install`, e2e tests, ngrok/pm2 deployment, real-client connection and the demo are all still to do.

## Done (see CHECKPOINTS for evidence)
- Core (sandbox, file ops, git-lite, roles, auth, config, audit): implemented; 39 unit tests passed in the build environment.
- MCP wiring (`tools.ts`, `server.ts`, `app.ts`, `index.ts`): implemented, NOT executed (SDK could not be installed offline).
- `test/e2e.test.ts`, `ecosystem.config.cjs`, client configs, README, REPORT, DEMO_GUIDE: written, unexecuted.

## Next steps (student)
1. `npm install && npm run typecheck && npm test` - fix anything that fails (most likely spot: SDK typings in `src/server.ts` / `src/app.ts`).
2. Configure `.env`, run `npm run init-workspace:demo`, test with MCP Inspector.
3. ngrok static domain + `pm2 start ecosystem.config.cjs`; capture 401/200 curl evidence.
4. Connect a real client, run the 3-session demo (`docs/DEMO_GUIDE.md`), generate the transcript.
5. Fill the **[EVIDENCE]** markers in `docs/REPORT.md`; make meaningful git commits (suggested split: scaffold -> sandbox+tests -> tools/fileops -> git-lite -> HTTP/auth -> deployment -> docs).

## Known limitations
See `docs/REPORT.md` section 4.
