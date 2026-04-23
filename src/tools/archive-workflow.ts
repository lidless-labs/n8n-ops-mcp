import { Type } from "@sinclair/typebox";
import { N8nApiError, type N8nClient, type N8nWorkflow } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({ description: "Workflow id (from n8n_list_workflows)." }),
  },
  { additionalProperties: false },
);

type Action = "archive" | "unarchive";

export function createArchiveWorkflowTool(getClient: () => N8nClient) {
  return buildTool(getClient, "archive");
}

export function createUnarchiveWorkflowTool(getClient: () => N8nClient) {
  return buildTool(getClient, "unarchive");
}

function buildTool(getClient: () => N8nClient, action: Action) {
  const name = action === "archive" ? "n8n_archive_workflow" : "n8n_unarchive_workflow";
  const label =
    action === "archive" ? "n8n: archive workflow" : "n8n: unarchive workflow";
  const description =
    action === "archive"
      ? "Soft-delete (archive) an n8n workflow via POST /workflows/{id}/archive. Reversible: pair with n8n_unarchive_workflow to restore. Idempotent: archiving an already-archived workflow returns the current state. Side effect: archiving deactivates the workflow, so triggers (webhooks, schedules) stop firing. Prefer this over n8n_delete_workflow for cleanup; it keeps history and definitions intact. Requires enableEdit."
      : "Restore an archived workflow via POST /workflows/{id}/unarchive. Does NOT reactivate: triggers stay off until n8n_activate is called explicitly. Requires enableEdit.";

  return {
    name,
    label,
    description,
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { id } = rawParams as { id: string };
      const client = getClient();
      try {
        const wf: N8nWorkflow =
          action === "archive"
            ? await client.archiveWorkflow(id)
            : await client.unarchiveWorkflow(id);
        return jsonToolResult({
          ok: true,
          action,
          workflowId: wf.id,
          workflowName: wf.name,
          active: wf.active,
          isArchived: wf.isArchived ?? (action === "archive"),
          updatedAt: wf.updatedAt,
        });
      } catch (err) {
        if (err instanceof N8nApiError && err.status === 404) {
          return jsonToolResult({
            ok: false,
            action,
            workflowId: id,
            reason: "not_found",
            message:
              "Workflow not found. It may have been deleted or never existed.",
          });
        }
        throw err;
      }
    },
  };
}
