import { Type } from "@sinclair/typebox";
import type { N8nClient, N8nWorkflow } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({ description: "Workflow id (from n8n_list_workflows)." }),
    nodeName: Type.String({
      minLength: 1,
      description:
        "Name of the node to pin data on (case-sensitive). Must be the n8n node 'name' field, not the type. Use n8n_get_workflow(includeDefinition=true) to look up exact names.",
    }),
    data: Type.Array(
      Type.Record(Type.String(), Type.Unknown()),
      {
        minItems: 1,
        maxItems: 50,
        description:
          "Items to pin (max 50). Each item may be a fully-shaped n8n run item (`{json: {...}, binary?: {...}}`) or a raw object — raw objects are auto-wrapped into `{json: <object>}`.",
      },
    ),
    merge: Type.Optional(
      Type.Boolean({
        description:
          "If true, append to existing pinned data on the node instead of replacing it (combined total still capped at 50). Default false (replace).",
      }),
    ),
    confirm: Type.Boolean({
      description:
        "Must be true to actually write. Pinned data persists across executions and overrides node output until cleared via n8n_unpin_node_data — easy to forget about.",
    }),
  },
  { additionalProperties: false },
);

const MAX_TOTAL_ITEMS = 50;

export function createPinNodeDataTool(getClient: () => N8nClient) {
  return {
    name: "n8n_pin_node_data",
    label: "n8n: pin node data",
    description:
      "Pin sample data to a node so downstream nodes use it during testing/development without re-running the upstream node. Useful after scaffolding a browser-bridge call: run it once, capture the output, pin it, then iterate on downstream nodes without re-spawning the browser. Issues PUT /workflows/{id} with merged pinData. Pinned data overrides actual node output on subsequent executions until cleared with n8n_unpin_node_data — easy to forget. Requires enableEdit and explicit confirm=true.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const params = rawParams as {
        id: string;
        nodeName: string;
        data: Array<Record<string, unknown>>;
        merge?: boolean;
        confirm: boolean;
      };
      if (!params.confirm) {
        return jsonToolResult({
          ok: false,
          error: "confirm must be true to pin data",
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

      const nodeExists = nodeNameExists(current.nodes, params.nodeName);
      if (!nodeExists) {
        return jsonToolResult({
          ok: false,
          error: `node "${params.nodeName}" not found in workflow ${params.id}. Use n8n_get_workflow(includeDefinition=true) to look up exact names.`,
        });
      }

      const incoming = params.data.map(normalizeItem);
      const existingForNode = readNodePinData(current.pinData, params.nodeName);
      const merged = params.merge
        ? [...existingForNode, ...incoming]
        : incoming;

      if (merged.length > MAX_TOTAL_ITEMS) {
        return jsonToolResult({
          ok: false,
          error: `combined pinned items (${merged.length}) exceeds cap of ${MAX_TOTAL_ITEMS}. Reduce the input or unpin existing data first.`,
        });
      }

      const newPinData: Record<string, unknown> = {
        ...(current.pinData ?? {}),
        [params.nodeName]: merged,
      };
      const body = buildBody(current, { pinData: newPinData });

      try {
        const saved = await client.saveWorkflow(params.id, body);
        return jsonToolResult({
          ok: true,
          action: "pin",
          workflowId: saved.id,
          nodeName: params.nodeName,
          pinnedItemCount: merged.length,
          replaced: !params.merge && existingForNode.length > 0,
          appended: params.merge ? incoming.length : 0,
          versionId: saved.versionId ?? null,
          updatedAt: saved.updatedAt,
          unpinHint: `To clear: n8n_unpin_node_data(id=${saved.id}, nodeName=${JSON.stringify(params.nodeName)}, confirm=true).`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonToolResult({
          ok: false,
          error: `pin failed: ${client.redact(msg)}`,
        });
      }
    },
  };
}

function nodeNameExists(nodes: unknown, nodeName: string): boolean {
  if (!Array.isArray(nodes)) return false;
  return nodes.some(
    (n) =>
      n &&
      typeof n === "object" &&
      typeof (n as Record<string, unknown>).name === "string" &&
      (n as Record<string, unknown>).name === nodeName,
  );
}

function readNodePinData(
  pinData: Record<string, unknown> | undefined,
  nodeName: string,
): Array<Record<string, unknown>> {
  if (!pinData) return [];
  const existing = pinData[nodeName];
  return Array.isArray(existing)
    ? (existing as Array<Record<string, unknown>>)
    : [];
}

function normalizeItem(item: Record<string, unknown>): Record<string, unknown> {
  // Accept both shapes: full run-item (`{json: ..., binary?: ...}`) or raw
  // payload — raw wraps into `{json: item}` so callers don't have to remember
  // n8n's internal item shape.
  if ("json" in item) return item;
  return { json: item };
}

export function buildBody(
  current: N8nWorkflow,
  patch: { pinData?: Record<string, unknown>; staticData?: unknown },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: current.name,
    nodes: current.nodes,
    connections: current.connections,
    settings: current.settings ?? {},
  };
  if (patch.staticData !== undefined) {
    body.staticData = patch.staticData;
  } else if (current.staticData !== undefined) {
    body.staticData = current.staticData;
  }
  if (patch.pinData !== undefined) {
    body.pinData = patch.pinData;
  } else if (current.pinData !== undefined) {
    body.pinData = current.pinData;
  }
  return body;
}
