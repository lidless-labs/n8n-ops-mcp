import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { N8nApiError, type N8nClient, type N8nWorkflow } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({ description: "Workflow id to delete (from n8n_list_workflows)." }),
    confirm: Type.Boolean({
      description:
        "Must be true to actually delete. A snapshot of the workflow is written to backupDir before the DELETE fires. Deletion is irreversible via the Public API; restore is not a one-call operation (see restoreHint). Prefer n8n_archive_workflow for reversible cleanup.",
    }),
  },
  { additionalProperties: false },
);

export interface DeleteWorkflowDeps {
  getClient: () => N8nClient;
  backupDir?: string;
}

export function createDeleteWorkflowTool(deps: DeleteWorkflowDeps) {
  return {
    name: "n8n_delete_workflow",
    label: "n8n: delete workflow",
    description:
      "Permanently delete an n8n workflow via DELETE /workflows/{id}. Irreversible. Snapshots the current workflow (nodes + connections + settings) to backupDir BEFORE firing the DELETE; if the snapshot fails, the delete is aborted. Does NOT cancel running executions first; those become orphans. Use n8n_list_executions(workflowId, status='running') + n8n_cancel_execution first if needed. Prefer n8n_archive_workflow for reversible cleanup. Requires enableEdit and explicit confirm=true.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { id, confirm } = rawParams as { id: string; confirm: boolean };
      if (!confirm) {
        return jsonToolResult({
          ok: false,
          action: "delete",
          workflowId: id,
          error: "confirm must be true to delete",
          hint: "Deletion is irreversible. Prefer n8n_archive_workflow for reversible cleanup, or fetch n8n_get_workflow with includeDefinition=true and save the output before calling this with confirm=true.",
        });
      }

      const client = deps.getClient();

      let current: N8nWorkflow;
      try {
        current = await client.getWorkflow(id);
      } catch (err) {
        if (err instanceof N8nApiError && err.status === 404) {
          return jsonToolResult({
            ok: false,
            action: "delete",
            workflowId: id,
            reason: "not_found",
            message:
              "Workflow not found. It may have already been deleted or never existed.",
          });
        }
        throw err;
      }

      let backupPath: string;
      try {
        backupPath = await writeBackup(resolveBackupDir(deps.backupDir), current);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonToolResult({
          ok: false,
          action: "delete",
          workflowId: id,
          error: `backup failed; delete aborted: ${msg}`,
          hint: "The workflow was NOT deleted because the safety snapshot could not be written. Check backupDir permissions and retry.",
        });
      }

      try {
        const deleted = await client.deleteWorkflow(id);
        return jsonToolResult({
          ok: true,
          action: "delete",
          workflowId: deleted.id ?? id,
          workflowName: deleted.name ?? current.name,
          backupPath,
          restoreHint: `Snapshot saved at ${backupPath}. Restore is NOT a one-call operation: n8n_save_workflow overwrites an existing workflow id, it does not recreate a deleted one. To restore, create a new workflow in the n8n UI (or via a future n8n_create_workflow) and paste the nodes/connections/settings from the snapshot.`,
        });
      } catch (err) {
        if (err instanceof N8nApiError && err.status === 404) {
          return jsonToolResult({
            ok: false,
            action: "delete",
            workflowId: id,
            reason: "not_found",
            message:
              "Workflow disappeared between snapshot and delete (404). A snapshot was still captured.",
            backupPath,
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        return jsonToolResult({
          ok: false,
          action: "delete",
          workflowId: id,
          error: `delete failed: ${msg}`,
          backupPath,
          hint: `Snapshot preserved at ${backupPath}. Server state may or may not have been mutated; fetch n8n_get_workflow to verify.`,
        });
      }
    },
  };
}

function resolveBackupDir(configured?: string): string {
  const raw = configured?.trim() || "~/.n8n-backups";
  return raw.startsWith("~")
    ? path.join(homedir(), raw.slice(1).replace(/^\/+/, ""))
    : raw;
}

async function writeBackup(dir: string, wf: N8nWorkflow): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const safeName = String(wf.id).replace(/[^A-Za-z0-9_-]/g, "_");
  const file = path.join(dir, `${safeName}-DELETED-${stamp}.json`);
  await fs.writeFile(file, JSON.stringify(wf, null, 2), { mode: 0o600 });
  return file;
}
