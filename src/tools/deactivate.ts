import { Type } from "@sinclair/typebox";
import type { N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({ description: "Workflow id to deactivate." }),
    confirm: Type.Boolean({
      description:
        "Must be true to actually deactivate. Deactivating stops the workflow's triggers from firing — scheduled/webhook automation will no longer run until re-activated.",
    }),
  },
  { additionalProperties: false },
);

export function createDeactivateTool(getClient: () => N8nClient) {
  return {
    name: "n8n_deactivate",
    label: "n8n: deactivate workflow",
    description:
      "Deactivate an n8n workflow so its triggers stop firing. Running executions are not cancelled. Idempotent. Requires enableEdit and explicit confirm=true (deactivation halts the workflow's automation).",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { id, confirm } = rawParams as { id: string; confirm: boolean };
      if (!confirm) {
        return jsonToolResult({
          ok: false,
          action: "deactivate",
          error: "confirm must be true to deactivate",
        });
      }
      const wf = await getClient().deactivateWorkflow(id);
      return jsonToolResult({
        ok: true,
        action: "deactivate",
        workflowId: wf.id,
        workflowName: wf.name,
        active: wf.active,
        updatedAt: wf.updatedAt,
      });
    },
  };
}
