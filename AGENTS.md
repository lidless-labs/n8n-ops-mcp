# Repository Guidance

## Definition of Done
A change is done only when all three pass, re-verified after your last edit:
- `npm test`
- `npm run typecheck`
- `npm run build`

Report the actual results you observed. If anything fails, report the failure
verbatim and do not claim success. Never describe a change as complete with a
failing or unrun check.

## Project Shape
- TypeScript package exposing ops-focused n8n tools (workflow + execution lifecycle, tags, credentials metadata, security audit, composed scanners) two ways: a stdio MCP server and an OpenClaw plugin.
- `mcp-server.ts` is the MCP entry point (config from `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_ENABLE_EDIT`, etc.). `index.ts` is the OpenClaw plugin entry point (config via `resolveConfig()` in `src/config.ts`).
- Tools live one per file under `src/tools/` as `create<Name>Tool(getClient)` factories. There is no central tool index.
- HTTP access goes through `N8nClient` in `src/client.ts`. ESM, Node >= 20, builds with tsup to `dist/`.

## Hard Prohibitions
- The live n8n instance runs real automations. Never run write tools against it during development or review unless the user explicitly asks in this session. That includes `scripts/smoke.ts`, `npm run dev`, and ad hoc tool calls. Tests use mocked fetch helpers and need no instance.
- Never weaken the `enableEdit` gate, the `enableCredentialsWrite` gate, or the runtime `confirm: true` requirement. If a gate blocks the task, report the blocker to the user; do not route around it.
- Never weaken or remove the pre-write backups or the `backupDir` path confinement (details below).
- Never weaken, skip, or delete a failing test to make a run green. Fix the code or report the failure.
- Never push with `--no-verify`. `hooks/pre-push` runs content-guard for a reason; fix the flagged content instead.
- Hit any other blocker (missing creds, ambiguous spec, broken tooling): stop and report it exactly. Do not invent a workaround that bypasses a safety rule.

## Dual Registration
- Trigger: adding, removing, or renaming a tool.
- Rule: `mcp-server.ts` and `index.ts` register tools independently. Update both, plus the README tool table, in the same commit.
- If you find only one entry point updated, stop and fix the other before doing anything else.

## Write-Tool Gate Layering
Preserve all three layers when touching write tools:
- Write tools are registered only when `enableEdit` is true (`N8N_ENABLE_EDIT` for MCP, plugin config for OpenClaw).
- Credential writes (`n8n_create_credential`, `n8n_delete_credential`) sit behind a second gate, `enableCredentialsWrite`, because create handles plaintext secrets and delete can break every referencing workflow.
- Every write tool requires `confirm: true` at call time and must return `ok: false` without touching the API when confirm is missing or false. New write tools must implement the same check.

## Backups and Path Confinement
- `n8n_save_workflow` and `n8n_delete_workflow` snapshot the current workflow to `backupDir` before writing; delete aborts if the snapshot cannot be written. Keep that ordering.
- `n8n_diff_workflow` file reads must stay confined to `backupDir` via `resolveConfinedPath()`. Do not loosen the traversal checks.
- `n8n_list_credentials` returns metadata only. Never echo credential secrets in any tool output.

## Verification Commands
- Targeted change: `npm test -- tests/<specific>.test.ts` (vitest).
- API or type change: `npm run typecheck`.
- Packaging or entry-point change: `npm run build`.
- Before claiming done: all three Definition of Done commands.
- Release: `prepublishOnly` runs typecheck + test + build; all must pass.

## Gotchas
- `VERSION` is hardcoded in `mcp-server.ts`. On a version bump, change it to match `package.json` or the server reports the wrong version.
- The npm payload ships `src/` and `index.ts` alongside `dist/` because the OpenClaw plugin loads TypeScript directly. Do not drop them from `files` in `package.json`.
- `hooks/pre-push` scans the working tree with content-guard (`~/repos/content-guard`, policy `policies/public-repo.json`) and blocks the push on violations. Fix the leak or add an inline `content-guard: allow <rule-id>` tag.
- `n8n_trigger` mode `workflow` hits an endpoint most n8n builds do not expose (405). Webhook mode is the reliable path; keep tool descriptions steering that way.

## Memory Handoff
At the end of any substantial task, write a handoff note to `.claude/memory-handoffs/` using that directory's `TEMPLATE.md`. Record durable discoveries, gotchas, and decisions. Do not wait to be reminded.
