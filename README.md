# n8n-ops-mcp

[![npm version](https://img.shields.io/npm/v/n8n-ops-mcp.svg)](https://www.npmjs.com/package/n8n-ops-mcp)
[![license](https://img.shields.io/npm/l/n8n-ops-mcp.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

Ops-focused n8n tools for Claude-compatible clients. List, inspect, trigger, validate, and safely edit n8n workflows from any MCP host — with first-class [OpenClaw](https://github.com/openclaw/openclaw) support.

Works with Claude Desktop, Claude Code, OpenClaw, Hermes Agent, Codex CLI, and any other MCP-compatible client.

## Why

Your AI agent has no native awareness of your n8n footprint. With this package, it can answer "what's broken in my n8n?" and trigger workflows from chat without you leaving your client.

For a catalog/docs tool that indexes n8n's node library, see [n8n-mcp](https://www.npmjs.com/package/n8n-mcp). This one is ops-focused — list, trigger, validate, edit.

## Tools

| Tool | Purpose | Write |
|---|---|---|
| `n8n_list_workflows` | List workflows, filter by `active` / `tags` / `name` | |
| `n8n_get_workflow` | Fetch one workflow, optionally with full node graph | |
| `n8n_list_executions` | List recent executions, filter by workflow / status | |
| `n8n_get_execution` | Fetch an execution with per-node run log + raw error | |
| `n8n_search_executions` | Text-search recent executions for an error fragment | |
| `n8n_list_webhooks` | Enumerate webhook + form-trigger URLs | |
| `n8n_validate_workflow` | Static checks: deprecated nodes, legacy Code-node API, orphans | |
| `n8n_trigger` | Run a workflow via webhook (reliable) or workflow-id | |
| `n8n_activate` | Enable a workflow's triggers | ✓ |
| `n8n_deactivate` | Disable a workflow's triggers | ✓ |
| `n8n_save_workflow` | Overwrite a workflow with auto-backup + validation + confirm gate | ✓ |
| `n8n_archive_workflow` | Soft-delete a workflow (reversible; prefer over delete) | ✓ |
| `n8n_unarchive_workflow` | Restore an archived workflow (does NOT reactivate) | ✓ |
| `n8n_delete_workflow` | Permanently delete a workflow (confirm-gated, snapshot-before-delete) | ✓ |
| `n8n_cancel_execution` | Stop a running or waiting execution by id | ✓ |
| `n8n_retry_execution` | Retry a failed execution by id (returns a new execution) | ✓ |
| `n8n_delete_execution` | Permanently delete an execution record (confirm-gated, irreversible) | ✓ |
| `n8n_delete_executions` | Batch form of delete (client-side fan-out, confirm-gated, irreversible, max 50 ids) | ✓ |

Write tools are hidden unless `N8N_ENABLE_EDIT=true`.

<details>
<summary><b>Detailed tool reference</b></summary>

**`n8n_list_workflows`** — filter by `active`, `tags`, `name` (substring), `limit`. Returns id, name, active state, tags, updatedAt.

**`n8n_get_workflow`** — fetch one by id. Returns metadata by default. Pass `includeDefinition: true` for the full node graph + connections.

**`n8n_list_executions`** — filter by `workflowId`, `status` (success/error/running/waiting/canceled), `limit`. Returns id, workflowId, workflowName, status, mode, startedAt, stoppedAt.

**`n8n_get_execution`** — includes per-node run log (truncated to `maxExecutionLogBytes`, default 64 KB) and the raw error object verbatim when status is `error`. Pass `includeRunData: false` to skip the run log.

**`n8n_search_executions`** — defaults to scanning `status=error` executions for a `query` fragment (e.g. `ECONNREFUSED`) and returning matches with workflow context + a snippet around each hit. `scope: "error"` (default) greps the error payload only; `scope: "all"` also greps full per-node run data (slower, may return node outputs — treat snippets as sensitive). Optional `workflowId`, `status`, `limit` (default 50, max 250), `maxMatches` (default 20), `snippetChars` (default 160). Returns `matches` plus a `skipped` array for any execution that failed to fetch.

**`n8n_list_webhooks`** — scans workflows for webhook and form-trigger nodes and returns their paths + fully-formed `triggerUrl`. Pairs with `n8n_trigger` mode='webhook'. Optional `workflowId`, `activeOnly` (default true), `limit` (default 50).

**`n8n_validate_workflow`** — checks for deprecated node types (function → code), legacy Code-node API (`$node[]`, `items` global, `require()`), orphan nodes, disabled nodes, missing trigger. Returns issues with severity (error/warning/info) plus a summary count.

**`n8n_trigger`** — two modes:
- `mode: "webhook"` + `webhookPath` — POST (or GET/PUT/DELETE) to the configured base URL + path, with an optional JSON `payload`. This is the reliable path.
- `mode: "workflow"` + `workflowId` — attempts `POST /api/v1/workflows/:id/execute`. Pre-checks that the workflow is active and has a webhook/manual/form trigger. Most n8n builds don't expose this endpoint on the Public API and will 405; the tool surfaces a hint to switch to webhook mode.

**`n8n_activate`** / **`n8n_deactivate`** — idempotent. Deactivating does not cancel running executions.

**`n8n_save_workflow`** — before writing: fetches the current version, snapshots it to `backupDir` as `<id>-<timestamp>.json` (mode 0600), runs `validateWorkflow` on the proposed state, and aborts on error-severity issues (pass `skipValidation: true` to bypass). Requires `confirm: true` to actually PUT; calling with `confirm: false` returns `ok: false` and never touches the API (omitting `confirm` is rejected at the MCP schema layer). Response includes the backup path and a `restoreHint`.

**`n8n_archive_workflow`** — `POST /workflows/{id}/archive`. Soft-deletes a workflow: triggers stop firing, the workflow disappears from the default UI list, but the definition and execution history are preserved. Idempotent (archiving an already-archived workflow returns the current state). No confirm gate — this is the safe cleanup path. Archiving deactivates as a side effect; the response surfaces `active: false` explicitly. Returns `ok: false` with `reason: "not_found"` on 404.

**`n8n_unarchive_workflow`** — `POST /workflows/{id}/unarchive`. Restores an archived workflow. Does NOT reactivate — triggers stay off until you call `n8n_activate` explicitly. Returns `ok: false` with `reason: "not_found"` on 404.

**`n8n_delete_workflow`** — `DELETE /workflows/{id}`. Permanent, irreversible. Before firing the DELETE: fetches the current workflow and snapshots it to `backupDir` as `<id>-DELETED-<timestamp>.json` (mode 0600). If the snapshot can't be written, the DELETE is aborted — there is no un-safety-netted path. Requires `confirm: true`; omitting it or passing `false` returns `ok: false` and never touches the API. Returns `ok: false` with `reason: "not_found"` on 404 (either before or after the snapshot). **Restore is NOT a one-call operation:** `n8n_save_workflow` overwrites an existing id, it does not recreate a deleted one. To restore, create a new workflow in the n8n UI (or via a future `n8n_create_workflow`) and paste the snapshot's nodes/connections/settings. Deleting does NOT cancel running executions — use `n8n_list_executions(workflowId, status='running')` + `n8n_cancel_execution` first if needed. **Prefer `n8n_archive_workflow` for cleanup** unless you truly need to scrub the workflow from n8n.

**`n8n_cancel_execution`** — `POST /executions/{id}/stop`. Closes the triage loop after `n8n_search_executions` locates a stuck run. Returns a success summary with the execution's final status, or `ok: false` with `reason: "not_found_or_finished"` if the id no longer matches a running execution (404).

**`n8n_retry_execution`** — `POST /executions/{id}/retry`. Creates a NEW execution — the response surfaces both `originalExecutionId` and `newExecutionId` so agents can follow up with `n8n_get_execution` on the retry. Optional `loadWorkflow: true` retries against the currently saved workflow instead of the version captured at original execution time. Returns `ok: false` with `reason: "not_found"` on 404 or `reason: "not_retryable"` on 409 (e.g. still running); all other API errors rethrow.

**`n8n_delete_execution`** — `DELETE /executions/{id}`. Permanently removes an execution record: logs, per-node run data, and error payloads are erased from n8n. Requires `confirm: true` to actually delete; calling with `confirm: false` returns `ok: false` and never touches the API (omitting `confirm` is rejected at the MCP schema layer). Returns `ok: false` with `reason: "not_found"` on 404; all other API errors rethrow. Not idempotent from an agent's perspective: the record is gone after the first successful call, so fetch `n8n_get_execution` first if you may need it later.

**`n8n_delete_executions`** — batch form. Client-side fan-out over `DELETE /executions/{id}` with bounded concurrency (default 3, max 10). Takes an `ids` array (deduped before fan-out, capped at 50), requires `confirm: true`. Response surfaces `requested`/`attempted`/`deleted`/`alreadyDeleted`/`failed`/`skipped`/`aborted` counters plus a `results: Array<{id, ok, reason?, message?}>` — order is completion order, not input order, so look up by id. 404 per id is treated as `already_deleted` (idempotent). A 5xx on any id aborts the batch via an `AbortController`: no new ids are claimed and any already-in-flight `fetch`es are cancelled client-side. Under concurrency N, up to N-1 deletes may have already reached the server before the 5xx is observed, so the batch is best-effort, not transactional — clear signal the server is sick; don't retry blindly. Per-id error messages are passed through the API-key redactor. Compose with `n8n_search_executions` to purge a known set of noisy runs in one call.

</details>

## Install

```bash
npm install -g n8n-ops-mcp
```

## Configuration

Generate an API key in n8n under **Settings → API**, then set these env vars in your MCP client config:

| Variable | Required | Default | Description |
|---|---|---|---|
| `N8N_BASE_URL` | yes | — | n8n base URL, e.g. `http://localhost:5678` |
| `N8N_API_KEY` | yes | — | n8n Public API key (`X-N8N-API-KEY`) |
| `N8N_ENABLE_EDIT` | no | `false` | Expose write tools |
| `N8N_BACKUP_DIR` | no | `~/.n8n-backups` | Where `n8n_save_workflow` writes pre-save snapshots |
| `N8N_MAX_EXECUTION_LOG_BYTES` | no | `65536` | Cap on inline execution log bytes |
| `N8N_REQUEST_TIMEOUT_MS` | no | `15000` | HTTP timeout for n8n API calls |

### Claude Code

```bash
claude mcp add n8n \
  --env N8N_BASE_URL=http://localhost:5678 \
  --env N8N_API_KEY=your-api-key-here \
  -- n8n-ops-mcp
```

Add `--scope user` to make it available from any directory instead of only the current project.

### OpenClaw

n8n-ops-mcp is a first-class OpenClaw plugin — not an MCP bridge — so it shares the gateway's process, auth profiles, and hooks.

```bash
openclaw plugins install clawhub:n8n-ops-mcp
```

Add the config block to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "n8n": {
        "enabled": true,
        "config": {
          "baseUrl": "http://your-n8n-host:5678",
          "enableEdit": false
        }
      }
    }
  }
}
```

Put the API key in your OpenClaw workspace env:

```bash
# ~/.openclaw/workspace/.env
N8N_API_KEY=eyJhbGciOi...
```

Restart the gateway:

```bash
systemctl --user restart openclaw-gateway
```

Config keys: `baseUrl`, `apiKey`, `apiKeyEnv`, `enableEdit`, `maxExecutionLogBytes`, `requestTimeoutMs`, `backupDir`. See [`openclaw.plugin.json`](./openclaw.plugin.json) for the full schema.

<details>
<summary><b>Other clients</b> — Claude Desktop, Hermes Agent, Codex CLI, manual OpenClaw install</summary>

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "n8n": {
      "command": "n8n-ops-mcp",
      "env": {
        "N8N_BASE_URL": "http://localhost:5678",
        "N8N_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) reads MCP config from `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  n8n:
    command: "n8n-ops-mcp"
    env:
      N8N_BASE_URL: "http://localhost:5678"
      N8N_API_KEY: "your-api-key-here"
```

Then reload from inside a session:

```
/reload-mcp
```

### Codex CLI

```bash
codex mcp add n8n \
  --env N8N_BASE_URL=http://localhost:5678 \
  --env N8N_API_KEY=your-api-key-here \
  -- n8n-ops-mcp
```

Writes the entry to `~/.codex/config.toml` under `[mcp_servers.n8n]`. Verify with `codex mcp list`.

### OpenClaw — manual (non-ClawHub) install

If you want to point OpenClaw at a local clone instead of the registry:

```json
{
  "plugins": {
    "allow": ["n8n"],
    "load": {
      "paths": ["/absolute/path/to/n8n-ops-mcp"]
    },
    "entries": {
      "n8n": {
        "enabled": true,
        "config": {
          "baseUrl": "http://your-n8n-host:5678",
          "enableEdit": false
        }
      }
    }
  }
}
```

</details>

## Example prompts

> What n8n workflows broke today?

Calls `n8n_list_executions` with `status=error`, then `n8n_get_execution` for the failing run.

> Which workflow errored with "ECONNREFUSED"?

Calls `n8n_search_executions` with `query: "ECONNREFUSED"`.

> Trigger the "nightly intel" workflow

Calls `n8n_list_webhooks` to find the path, then `n8n_trigger` with `mode=webhook`.

> Audit my workflows for deprecated Code-node API usage

Calls `n8n_list_workflows` then `n8n_validate_workflow` per id, filters for `code-node-old-node-ref` and `code-node-items-global` warnings.

> Deactivate the "experimental-bot" workflow *(requires `N8N_ENABLE_EDIT=true`)*

Calls `n8n_list_workflows` with a name filter, then `n8n_deactivate` on the matching id.

> Kill the execution stuck on ECONNREFUSED *(requires `N8N_ENABLE_EDIT=true`)*

Calls `n8n_search_executions` with `query: "ECONNREFUSED"`, then `n8n_cancel_execution` on the match.

> Retry yesterday's failed "nightly intel" run against the current workflow *(requires `N8N_ENABLE_EDIT=true`)*

Calls `n8n_search_executions` to find the failed id, then `n8n_retry_execution` with `loadWorkflow: true`.

> Purge the noisy test-run execution logs from last week *(requires `N8N_ENABLE_EDIT=true`)*

Calls `n8n_search_executions` to find the ids, then `n8n_delete_executions` with `confirm: true` to purge up to 50 in one call. Deletion is irreversible.

> Archive the old "staging-bot" workflow — I might need it back someday *(requires `N8N_ENABLE_EDIT=true`)*

Calls `n8n_list_workflows` with a name filter, then `n8n_archive_workflow` on the match. Reversible via `n8n_unarchive_workflow` (you'll still need `n8n_activate` to turn triggers back on).

> Delete the abandoned "poc-scraper" workflow — it's been dead for months *(requires `N8N_ENABLE_EDIT=true`)*

Calls `n8n_list_workflows` to find the id, then `n8n_delete_workflow` with `confirm: true`. A snapshot lands in `backupDir` first, but restore from backup is not a one-call operation — prefer `n8n_archive_workflow` unless you're sure.

## Development

```bash
npm install
npm run dev       # tsx on mcp-server.ts (MCP stdio)
npm run typecheck
npm test          # vitest run
npm run build     # tsup bundle to dist/mcp-server.js
npm start         # node dist/mcp-server.js (post-build)
```

Or install from source:

```bash
git clone https://github.com/solomonneas/n8n-ops-mcp.git
cd n8n-ops-mcp
npm install
npm run build
```

## License

MIT
