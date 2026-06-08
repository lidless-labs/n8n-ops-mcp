import { Type } from "@sinclair/typebox";
import type { N8nClient, N8nWorkflow } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    mode: Type.Union([Type.Literal("workflow"), Type.Literal("webhook")], {
      description:
        "'workflow' triggers by workflow id (manual-style). 'webhook' POSTs to a webhook path.",
    }),
    workflowId: Type.Optional(
      Type.String({
        description: "Required when mode=workflow. Id from n8n_list_workflows.",
      }),
    ),
    webhookPath: Type.Optional(
      Type.String({
        description:
          "Required when mode=webhook. Path portion after the base URL, e.g. /webhook/my-hook.",
      }),
    ),
    payload: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Optional JSON body. Sent as request body for either mode.",
      }),
    ),
    method: Type.Optional(
      Type.Union(
        [
          Type.Literal("POST"),
          Type.Literal("GET"),
          Type.Literal("PUT"),
          Type.Literal("DELETE"),
        ],
        {
          description: "HTTP method for webhook mode. Default POST.",
        },
      ),
    ),
    confirm: Type.Boolean({
      description:
        "Must be true to actually run the workflow. Triggering executes the workflow's nodes (Code/Execute Command/HTTP, etc.) and POSTs to webhooks, which can have arbitrary real-world side effects.",
    }),
  },
  { additionalProperties: false },
);

const TRIGGER_ALLOWLIST = new Set([
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.formTrigger",
  "n8n-nodes-base.executeWorkflowTrigger",
]);

export function createTriggerTool(getClient: () => N8nClient) {
  return {
    name: "n8n_trigger",
    label: "n8n: trigger workflow",
    description:
      "Run an n8n workflow. mode='webhook' POSTs to a webhook path with an optional JSON payload — this is the supported path on n8n's Public API. mode='workflow' tries POST /api/v1/workflows/:id/execute with an active/manual/webhook/form pre-check; most n8n builds do NOT expose this endpoint and return 405 — prefer mode='webhook' for reliable triggers. Requires enableEdit and explicit confirm=true (triggering runs arbitrary workflow nodes with real side effects).",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const params = rawParams as {
        mode: "workflow" | "webhook";
        workflowId?: string;
        webhookPath?: string;
        payload?: Record<string, unknown>;
        method?: "POST" | "GET" | "PUT" | "DELETE";
        confirm: boolean;
      };
      if (!params.confirm) {
        return jsonToolResult({
          ok: false,
          error: "confirm must be true to trigger a workflow",
        });
      }
      const client = getClient();

      if (params.mode === "workflow") {
        if (!params.workflowId) {
          return jsonToolResult({
            ok: false,
            error: "workflowId is required when mode=workflow",
          });
        }
        const wf = await client.getWorkflow(params.workflowId);
        const gate = checkTriggerable(wf);
        if (!gate.ok) {
          return jsonToolResult({
            ok: false,
            error: gate.reason,
            workflowId: wf.id,
            workflowName: wf.name,
            active: wf.active,
            triggerNodeType: gate.triggerNodeType,
          });
        }
        try {
          const result = await client.executeWorkflow(
            params.workflowId,
            params.payload,
          );
          return jsonToolResult({
            ok: true,
            mode: "workflow",
            workflowId: wf.id,
            workflowName: wf.name,
            triggerNodeType: gate.triggerNodeType,
            response: result,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const hint =
            /\b40[45]\b/.test(msg)
              ? " — this n8n build likely does not expose /api/v1/workflows/:id/execute; use mode='webhook' with the trigger node's webhook path instead"
              : "";
          return jsonToolResult({
            ok: false,
            mode: "workflow",
            workflowId: wf.id,
            workflowName: wf.name,
            triggerNodeType: gate.triggerNodeType,
            error: msg + hint,
          });
        }
      }

      if (!params.webhookPath) {
        return jsonToolResult({
          ok: false,
          error: "webhookPath is required when mode=webhook",
        });
      }
      const res = await client.postWebhook(params.webhookPath, params.payload, {
        method: params.method,
      });
      return jsonToolResult({
        ok: res.status >= 200 && res.status < 300,
        mode: "webhook",
        webhookPath: params.webhookPath,
        method: params.method ?? "POST",
        status: res.status,
        response: res.body,
      });
    },
  };
}

interface TriggerCheck {
  ok: boolean;
  reason?: string;
  triggerNodeType?: string | null;
}

function checkTriggerable(wf: N8nWorkflow): TriggerCheck {
  const triggerNode = findTriggerNode(wf);
  const triggerNodeType = triggerNode?.type ?? null;
  if (!wf.active) {
    return {
      ok: false,
      reason: `workflow '${wf.name}' is not active; activate it in n8n before triggering`,
      triggerNodeType,
    };
  }
  if (!triggerNode) {
    return {
      ok: false,
      reason: "workflow has no recognizable trigger node",
      triggerNodeType,
    };
  }
  if (!TRIGGER_ALLOWLIST.has(String(triggerNode.type))) {
    return {
      ok: false,
      reason: `trigger node type '${triggerNode.type}' is not supported for external triggering (need webhook, manual, form, or executeWorkflow)`,
      triggerNodeType,
    };
  }
  return { ok: true, triggerNodeType };
}

function findTriggerNode(
  wf: N8nWorkflow,
): { type: string; name?: string } | null {
  if (!Array.isArray(wf.nodes)) return null;
  for (const raw of wf.nodes) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const type = typeof n.type === "string" ? n.type : "";
    if (!type) continue;
    if (type.toLowerCase().includes("trigger") || type === "n8n-nodes-base.webhook") {
      return { type, name: typeof n.name === "string" ? n.name : undefined };
    }
  }
  return null;
}
