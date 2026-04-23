#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { N8nClient } from "./src/client.ts";
import { makeClient, type N8nPluginConfig } from "./src/config.ts";

import { createListWorkflowsTool } from "./src/tools/list-workflows.ts";
import { createGetWorkflowTool } from "./src/tools/get-workflow.ts";
import { createListExecutionsTool } from "./src/tools/list-executions.ts";
import { createGetExecutionTool } from "./src/tools/get-execution.ts";
import { createSearchExecutionsTool } from "./src/tools/search-executions.ts";
import { createTriggerTool } from "./src/tools/trigger.ts";
import { createListWebhooksTool } from "./src/tools/list-webhooks.ts";
import { createValidateWorkflowTool } from "./src/tools/validate-workflow.ts";
import { createActivateTool } from "./src/tools/activate.ts";
import { createDeactivateTool } from "./src/tools/deactivate.ts";
import { createSaveWorkflowTool } from "./src/tools/save-workflow.ts";
import { createCancelExecutionTool } from "./src/tools/cancel-execution.ts";
import { createRetryExecutionTool } from "./src/tools/retry-execution.ts";

const VERSION = "0.4.0";

function readConfigFromEnv(): N8nPluginConfig {
  const baseUrl = (process.env.N8N_BASE_URL ?? "").trim();
  if (!baseUrl) {
    throw new Error(
      "N8N_BASE_URL is required (e.g. http://localhost:5678). Set it in your MCP client env config.",
    );
  }
  const apiKeyEnv = (process.env.N8N_API_KEY_ENV ?? "N8N_API_KEY").trim() || "N8N_API_KEY";
  const apiKey = (process.env[apiKeyEnv] ?? "").trim();
  if (!apiKey) {
    throw new Error(
      `${apiKeyEnv} is required. Set it in your MCP client env config (generate an API key in n8n under Settings -> API).`,
    );
  }
  return {
    baseUrl,
    apiKeyInline: apiKey,
    apiKeyEnv,
    enableEdit: parseBool(process.env.N8N_ENABLE_EDIT) ?? false,
    maxExecutionLogBytes: parsePosInt("N8N_MAX_EXECUTION_LOG_BYTES", 65_536, 1024),
    requestTimeoutMs: parsePosInt("N8N_REQUEST_TIMEOUT_MS", 15_000, 1000),
    backupDir: (process.env.N8N_BACKUP_DIR ?? "").trim() || undefined,
  };
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

function parsePosInt(envName: string, fallback: number, min: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new Error(
      `${envName} must be an integer >= ${min} (got ${JSON.stringify(raw)}).`,
    );
  }
  return n;
}

function lazyClient(config: N8nPluginConfig): () => N8nClient {
  let cached: N8nClient | undefined;
  return () => {
    if (!cached) cached = makeClient(config);
    return cached;
  };
}

type ToolFactoryResult = {
  name: string;
  description: string;
  execute: (toolCallId: string, rawParams: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }>;
};

function bind<Shape extends z.ZodRawShape>(
  server: McpServer,
  tool: ToolFactoryResult,
  shape: Shape,
): void {
  const handler = async (args: unknown): Promise<CallToolResult> => {
    const res = await tool.execute("mcp", args as Record<string, unknown>);
    return { content: res.content };
  };
  server.tool(tool.name, tool.description, shape, handler as never);
}

async function main(): Promise<void> {
  const config = readConfigFromEnv();
  const getClient = lazyClient(config);

  const server = new McpServer({
    name: "n8n-ops-mcp",
    version: VERSION,
    description:
      "Ops-focused n8n tools: list, inspect, trigger, validate, and safely edit workflows via the n8n Public API.",
  });

  bind(server, createListWorkflowsTool(getClient), {
    active: z.boolean().optional().describe("Filter by active state. Omit for all."),
    tags: z.string().optional().describe("Comma-separated tag names to filter by."),
    name: z.string().optional().describe("Case-insensitive substring match on workflow name."),
    limit: z.number().int().min(1).max(250).optional().describe("Max rows (default 100)."),
  });

  bind(server, createGetWorkflowTool(getClient), {
    id: z.string().describe("Workflow id (from n8n_list_workflows)."),
    includeDefinition: z
      .boolean()
      .optional()
      .describe(
        "Include full nodes+connections JSON. Off by default. Turn on when you need to inspect or edit.",
      ),
  });

  bind(server, createListExecutionsTool(getClient), {
    workflowId: z.string().optional().describe("Filter to a single workflow id. Omit for all."),
    status: z
      .enum(["success", "error", "running", "waiting", "canceled"])
      .optional()
      .describe("Filter by execution status."),
    limit: z.number().int().min(1).max(250).optional().describe("Max rows (default 50)."),
  });

  bind(
    server,
    createGetExecutionTool({
      getClient,
      maxLogBytes: config.maxExecutionLogBytes,
    }),
    {
      id: z.string().describe("Execution id (from n8n_list_executions)."),
      includeRunData: z
        .boolean()
        .optional()
        .describe(
          "Include per-node run log. Default true. Turn off for just status + error summary.",
        ),
    },
  );

  bind(server, createSearchExecutionsTool(getClient), {
    query: z
      .string()
      .min(1)
      .describe(
        "Case-insensitive text to search for (e.g. 'ECONNREFUSED').",
      ),
    workflowId: z
      .string()
      .optional()
      .describe("Filter to a single workflow id. Omit to scan across all workflows."),
    status: z
      .enum(["success", "error", "running", "waiting", "canceled"])
      .optional()
      .describe(
        "Filter executions by status before searching. Default 'error'.",
      ),
    scope: z
      .enum(["error", "all"])
      .optional()
      .describe(
        "'error' (default) searches only the execution error payload. 'all' also greps the full per-node run log — slower and may return raw node output in snippets.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(250)
      .optional()
      .describe("Max executions to scan (default 50)."),
    maxMatches: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Stop after this many matches (default 20)."),
    snippetChars: z
      .number()
      .int()
      .min(40)
      .max(600)
      .optional()
      .describe("Context window around each match (default 160)."),
  });

  bind(server, createTriggerTool(getClient), {
    mode: z
      .enum(["workflow", "webhook"])
      .describe(
        "'workflow' triggers by workflow id (manual-style; most builds 405). 'webhook' POSTs to a webhook path.",
      ),
    workflowId: z
      .string()
      .optional()
      .describe("Required when mode=workflow. Id from n8n_list_workflows."),
    webhookPath: z
      .string()
      .optional()
      .describe("Required when mode=webhook. Path after the base URL, e.g. /webhook/my-hook."),
    payload: z.record(z.string(), z.unknown()).optional().describe("Optional JSON body."),
    method: z
      .enum(["POST", "GET", "PUT", "DELETE"])
      .optional()
      .describe("HTTP method for webhook mode. Default POST."),
  });

  bind(
    server,
    createListWebhooksTool({ getClient, baseUrl: config.baseUrl }),
    {
      workflowId: z.string().optional().describe("Restrict to a single workflow."),
      activeOnly: z.boolean().optional().describe("Only include active workflows. Default true."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max workflows to scan when workflowId is omitted (default 50)."),
    },
  );

  bind(server, createValidateWorkflowTool(getClient), {
    id: z.string().describe("Workflow id (from n8n_list_workflows)."),
  });

  if (config.enableEdit) {
    bind(server, createActivateTool(getClient), {
      id: z.string().describe("Workflow id to activate."),
    });

    bind(server, createDeactivateTool(getClient), {
      id: z.string().describe("Workflow id to deactivate."),
    });

    bind(
      server,
      createSaveWorkflowTool({ getClient, backupDir: config.backupDir }),
      {
        id: z.string().describe("Workflow id to overwrite."),
        definition: z
          .object({
            name: z.string().optional(),
            nodes: z.array(z.record(z.string(), z.unknown())),
            connections: z.record(z.string(), z.unknown()),
            settings: z.record(z.string(), z.unknown()).optional(),
            staticData: z.unknown().optional(),
          })
          .loose()
          .describe(
            "Full new workflow body. Copy from n8n_get_workflow with includeDefinition=true, modify, then pass back.",
          ),
        skipValidation: z
          .boolean()
          .optional()
          .describe("Skip the validate-workflow pre-check. Default false."),
        confirm: z
          .boolean()
          .describe("Must be true to actually write. Snapshot to backupDir happens regardless."),
      },
    );

    bind(server, createCancelExecutionTool(getClient), {
      id: z
        .string()
        .describe(
          "Execution id to stop (from n8n_list_executions or n8n_search_executions).",
        ),
    });

    bind(server, createRetryExecutionTool(getClient), {
      id: z
        .string()
        .describe(
          "Execution id to retry (from n8n_list_executions or n8n_search_executions). The response contains a NEW execution id.",
        ),
      loadWorkflow: z
        .boolean()
        .optional()
        .describe(
          "If true, retry against the currently saved workflow instead of the version captured at the original execution time. Omit to accept n8n's default.",
        ),
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`n8n-ops-mcp fatal: ${msg}`);
  process.exit(1);
});
