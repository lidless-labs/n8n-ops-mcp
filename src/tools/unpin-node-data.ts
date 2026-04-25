import { Type } from "@sinclair/typebox";
import type { N8nClient, N8nWorkflow } from "../client.ts";
import { jsonToolResult } from "./result.ts";
import { buildBody } from "./pin-node-data.ts";

const Schema = Type.Object(
  {
    id: Type.String({ description: "Workflow id (from n8n_list_workflows)." }),
    nodeName: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Name of the node to unpin (case-sensitive). Omit to clear ALL pinned data on the workflow.",
      }),
    ),
    confirm: Type.Boolean({
      description:
        "Must be true to actually clear the pinned data. Idempotent: nodes with no pinned data are a no-op (returns ok=true with noop=true).",
    }),
  },
  { additionalProperties: false },
);

export function createUnpinNodeDataTool(getClient: () => N8nClient) {
  return {
    name: "n8n_unpin_node_data",
    label: "n8n: unpin node data",
    description:
      "Clear pinned data on one node (or the whole workflow when nodeName is omitted) so executions return to using live node output. Idempotent — clearing a node that wasn't pinned returns ok=true with noop=true. Issues PUT /workflows/{id} with the modified pinData. Requires enableEdit and explicit confirm=true.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const params = rawParams as {
        id: string;
        nodeName?: string;
        confirm: boolean;
      };
      if (!params.confirm) {
        return jsonToolResult({
          ok: false,
          error: "confirm must be true to unpin data",
        });
      }
      const client = getClient();

      let current: N8nWorkflow;
      try {
        current = await client.getWorkflow(params.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonToolResult({
          ok: false,
          error: `failed to fetch workflow: ${client.redact(msg)}`,
        });
      }

      const existing = current.pinData ?? {};
      const existingKeys = Object.keys(existing);

      // Whole-workflow unpin path.
      if (!params.nodeName) {
        if (existingKeys.length === 0) {
          return jsonToolResult({
            ok: true,
            action: "unpin",
            workflowId: current.id,
            scope: "workflow",
            noop: true,
            clearedNodes: [],
          });
        }
        const body = buildBody(current, { pinData: {} });
        try {
          const saved = await client.saveWorkflow(params.id, body);
          return jsonToolResult({
            ok: true,
            action: "unpin",
            workflowId: saved.id,
            scope: "workflow",
            noop: false,
            clearedNodes: existingKeys,
            versionId: saved.versionId ?? null,
            updatedAt: saved.updatedAt,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonToolResult({
            ok: false,
            error: `unpin failed: ${client.redact(msg)}`,
          });
        }
      }

      // Single-node unpin path.
      const nodeName = params.nodeName;
      if (!(nodeName in existing)) {
        return jsonToolResult({
          ok: true,
          action: "unpin",
          workflowId: current.id,
          scope: "node",
          nodeName,
          noop: true,
        });
      }
      const newPinData: Record<string, unknown> = { ...existing };
      delete newPinData[nodeName];
      const body = buildBody(current, { pinData: newPinData });
      try {
        const saved = await client.saveWorkflow(params.id, body);
        return jsonToolResult({
          ok: true,
          action: "unpin",
          workflowId: saved.id,
          scope: "node",
          nodeName,
          noop: false,
          versionId: saved.versionId ?? null,
          updatedAt: saved.updatedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonToolResult({
          ok: false,
          error: `unpin failed: ${client.redact(msg)}`,
        });
      }
    },
  };
}
