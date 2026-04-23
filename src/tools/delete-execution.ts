import { Type } from "@sinclair/typebox";
import { N8nApiError, type N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({
      description:
        "Execution id to delete (from n8n_list_executions or n8n_search_executions).",
    }),
    confirm: Type.Boolean({
      description:
        "Must be true to actually delete. Deletion is irreversible: execution logs, run data, and error payloads are gone from n8n after this call. If you may need the record later, fetch n8n_get_execution first and save the output.",
    }),
  },
  { additionalProperties: false },
);

export function createDeleteExecutionTool(getClient: () => N8nClient) {
  return {
    name: "n8n_delete_execution",
    label: "n8n: delete execution",
    description:
      "Permanently delete an n8n execution record by id via DELETE /executions/{id}. Irreversible: execution logs, per-node run data, and error payloads are erased. Requires enableEdit and explicit confirm=true. If the id no longer matches an execution (404), returns ok:false with reason 'not_found'. All other API errors rethrow.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { id, confirm } = rawParams as { id: string; confirm: boolean };
      if (!confirm) {
        return jsonToolResult({
          ok: false,
          action: "delete",
          executionId: id,
          error: "confirm must be true to delete",
          hint: "Deletion is irreversible. Fetch n8n_get_execution first if you need the record.",
        });
      }
      const client = getClient();
      try {
        const ex = await client.deleteExecution(id);
        const status = ex.status ?? (ex.finished ? "success" : "running");
        return jsonToolResult({
          ok: true,
          action: "delete",
          executionId: String(ex.id ?? id),
          workflowId: String(ex.workflowId ?? ""),
          workflowName: ex.workflowData?.name ?? null,
          status,
          finished: ex.finished ?? null,
          startedAt: ex.startedAt ?? null,
          stoppedAt: ex.stoppedAt ?? null,
        });
      } catch (err) {
        if (err instanceof N8nApiError && err.status === 404) {
          return jsonToolResult({
            ok: false,
            action: "delete",
            executionId: id,
            reason: "not_found",
            message:
              "Execution not found. It may have already been deleted or never existed.",
          });
        }
        throw err;
      }
    },
  };
}
