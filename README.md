# n8n-ops-mcp

Ops-focused n8n tools for Claude-compatible clients. List, inspect, trigger, validate, and safely edit n8n workflows from any MCP host — with first-class [OpenClaw](https://github.com/openclaw/openclaw) support.

Works with Claude Desktop, Claude Code, OpenClaw, Hermes Agent, Codex CLI, and any other MCP-compatible client.

## Why

Your AI agent has no native awareness of your n8n footprint. If a pipeline breaks, you SSH to the host or open the n8n UI. With this package, your agent can answer "what's broken in my n8n?" from chat, and trigger manual workflows without you leaving your client.

This is an **ops** tool — focused on listing, triggering, validating, and editing workflows. If you want a catalog/docs tool that indexes n8n's node library, see [n8n-mcp](https://www.npmjs.com/package/n8n-mcp).

## Tools

**`n8n_list_workflows`** - list workflows with optional `active`, `tags`, `name` (substring), `limit` filters. Returns id, name, active state, tags, updatedAt.

**`n8n_get_workflow`** - fetch one workflow by id. Returns metadata by default. Pass `includeDefinition: true` to get the full node graph + connections.

**`n8n_list_executions`** - list recent executions with optional `workflowId`, `status` (success/error/running/waiting/canceled), `limit` filters. Returns id, workflowId, workflowName, status, mode, startedAt, stoppedAt.

**`n8n_get_execution`** - fetch one execution by id. Includes per-node run log (truncated to `maxExecutionLogBytes`, default 64 KB, with a tail hint when it exceeds) and the raw error object verbatim when status is `error`. Pass `includeRunData: false` to skip the run log and get just status + error.

**`n8n_search_executions`** - text-search recent executions without paging through them. Defaults to scanning executions with `status=error` for a `query` fragment (e.g. `ECONNREFUSED`) and returning matches with workflow context + a snippet around each hit. `scope: "error"` (default) greps the error payload only. `scope: "all"` also greps the full per-node run log — slower and may return node output data, so treat snippets as sensitive. Optional `workflowId`, `status` (override default `error`), `limit` (default 50, max 250), `maxMatches` (default 20), `snippetChars` (default 160). Returns `matches`, plus `skipped` entries for any execution that failed to fetch.

**`n8n_list_webhooks`** - scan workflows for webhook and form-trigger nodes and return their paths + fully-formed `triggerUrl`. Pairs with `n8n_trigger` mode='webhook' so agents can discover and call webhooks without opening n8n. Optional `workflowId` for a single workflow, `activeOnly` (default true), `limit` (default 50).

**`n8n_validate_workflow`** - static checks on a workflow: deprecated node types (function → code), legacy Code-node API (`$node[]`, `items` global, `require()`), orphan nodes, disabled nodes, missing trigger. Returns issues with severity (error/warning/info) and a summary count.

### Write tools (behind `enableEdit`)

**`n8n_activate`** - activate a workflow so its triggers start firing. Idempotent.

**`n8n_deactivate`** - deactivate a workflow so triggers stop firing. Running executions are not cancelled. Idempotent.

**`n8n_save_workflow`** - overwrite a workflow. Before writing: fetches the current version, snapshots it to `backupDir` as `<id>-<timestamp>.json` (mode 0600), runs `validateWorkflow` on the proposed new state, and aborts on error-severity issues (pass `skipValidation: true` to bypass). Requires `confirm: true` to actually PUT. Response includes the backup path and a `restoreHint` describing how to roll back.

**`n8n_trigger`** - run a workflow. Two modes:
- `mode: "webhook"` + `webhookPath` - POST (or GET/PUT/DELETE) to the configured base URL + path, with an optional JSON `payload`. This is the reliable path.
- `mode: "workflow"` + `workflowId` - attempts `POST /api/v1/workflows/:id/execute`. Pre-checks that the workflow is active and has a webhook/manual/form trigger node. Most n8n builds do not expose this endpoint on the Public API and will 405; the tool surfaces a hint to switch to webhook mode in that case.

## Install

```bash
npm install -g n8n-ops-mcp
```

Or from source:

```bash
git clone https://github.com/solomonneas/n8n-ops-mcp.git
cd n8n-ops-mcp
npm install
npm run build
```

## Configuration

Generate an API key in n8n under Settings -> API, then set these env vars in your MCP client config:

| Variable | Required | Default | Description |
|---|---|---|---|
| `N8N_BASE_URL` | yes | — | n8n base URL, e.g. `http://localhost:5678` |
| `N8N_API_KEY` | yes | — | n8n Public API key (`X-N8N-API-KEY`) |
| `N8N_ENABLE_EDIT` | no | `false` | Set to `true` to expose `n8n_activate`, `n8n_deactivate`, `n8n_save_workflow` |
| `N8N_BACKUP_DIR` | no | `~/.n8n-backups` | Where `n8n_save_workflow` writes pre-save snapshots |
| `N8N_MAX_EXECUTION_LOG_BYTES` | no | `65536` | Cap on inline execution log bytes |
| `N8N_REQUEST_TIMEOUT_MS` | no | `15000` | HTTP timeout for n8n API calls |

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

### Claude Code

```bash
claude mcp add n8n \
  --env N8N_BASE_URL=http://localhost:5678 \
  --env N8N_API_KEY=your-api-key-here \
  -- n8n-ops-mcp
```

Add `--scope user` to make it available from any directory instead of only the current project.

### OpenClaw (as a native plugin)

n8n-ops-mcp is a first-class OpenClaw plugin — not an MCP bridge — which means it shares the gateway's process, auth profiles, and hooks. Register it in `~/.openclaw/openclaw.json`:

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

Put the API key in your OpenClaw workspace env so the plugin can read it without inlining:

```bash
# ~/.openclaw/workspace/.env
N8N_API_KEY=eyJhbGciOi...
```

Restart the gateway:

```bash
systemctl --user restart openclaw-gateway
```

OpenClaw plugin config keys (passed via `plugins.entries.n8n.config`): `baseUrl`, `apiKey`, `apiKeyEnv`, `enableEdit`, `maxExecutionLogBytes`, `requestTimeoutMs`, `backupDir`. See [`openclaw.plugin.json`](./openclaw.plugin.json) for the full schema.

### OpenClaw (via ClawHub)

If you prefer the registry path:

```bash
openclaw plugins install clawhub:n8n-ops-mcp
```

Then add a `plugins.entries.n8n` config block as above, restart the gateway, and you're done. ClawHub handles install + updates.

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) reads MCP config from `~/.hermes/config.yaml` under the `mcp_servers` key:

```yaml
mcp_servers:
  n8n:
    command: "n8n-ops-mcp"
    env:
      N8N_BASE_URL: "http://localhost:5678"
      N8N_API_KEY: "your-api-key-here"
```

Then reload MCP from inside a Hermes session:

```
/reload-mcp
```

### Codex CLI

[Codex CLI](https://github.com/openai/codex) registers MCP servers via `codex mcp add`:

```bash
codex mcp add n8n \
  --env N8N_BASE_URL=http://localhost:5678 \
  --env N8N_API_KEY=your-api-key-here \
  -- n8n-ops-mcp
```

Codex writes the entry to `~/.codex/config.toml` under `[mcp_servers.n8n]`. Verify with:

```bash
codex mcp list
```

## Example prompts

> What n8n workflows broke today?

Calls `n8n_list_executions` with `status=error`, then optionally `n8n_get_execution` for the failing run log.

> Trigger the "nightly intel" workflow

Calls `n8n_list_webhooks` to find the webhook path, then `n8n_trigger` with `mode=webhook`.

> Audit my workflows for deprecated Code-node API usage

Calls `n8n_list_workflows` then `n8n_validate_workflow` per id, filters for `code-node-old-node-ref` and `code-node-items-global` warnings.

> Deactivate the "experimental-bot" workflow (requires `N8N_ENABLE_EDIT=true`)

Calls `n8n_list_workflows` with a name filter, then `n8n_deactivate` on the matching id.

## Development

```bash
npm install
npm run dev       # tsx on mcp-server.ts (MCP stdio)
npm run typecheck # tsc --noEmit
npm run build     # tsup bundle to dist/mcp-server.js
npm start         # node dist/mcp-server.js (post-build)
```

## Roadmap

- [x] `n8n_list_workflows`
- [x] `n8n_get_workflow`
- [x] `n8n_list_executions`
- [x] `n8n_get_execution`
- [x] `n8n_trigger` (webhook + manual)
- [x] `n8n_list_webhooks` (surface webhook paths for mode='webhook')
- [x] `n8n_validate_workflow` (Code node + deprecated node checks)
- [x] `n8n_activate` / `n8n_deactivate` (behind `enableEdit`)
- [x] `n8n_save_workflow` with auto-backup + validation gate (behind `enableEdit`)
- [x] MCP wrapper (stdio)
- [x] `n8n_search_executions` (text search across run logs)

## License

MIT
