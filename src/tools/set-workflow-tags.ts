import { Type } from "@sinclair/typebox";
import { N8nApiError, type N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({
      description: "Workflow id (from n8n_list_workflows).",
    }),
    tagIds: Type.Array(Type.String(), {
      description:
        "Tag ids to attach (from n8n_list_tags). REPLACES the workflow's tag set — pass the full desired list, not a delta. Empty array clears all tags.",
    }),
  },
  { additionalProperties: false },
);

export function createSetWorkflowTagsTool(getClient: () => N8nClient) {
  return {
    name: "n8n_set_workflow_tags",
    label: "n8n: set workflow tags",
    description:
      "Replace the tag set on a workflow via PUT /workflows/{id}/tags. Pass the full desired list of tag ids — this is a SET operation, not append. To compute a delta, fetch n8n_get_workflow_tags first. Empty `tagIds` clears all tags. No confirm gate (reversible by re-setting). Tag ids are deduped before send. 404 surfaces as `{ ok: false, reason: 'not_found' }` (workflow or tag id).",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { id, tagIds } = rawParams as { id: string; tagIds: string[] };
      const deduped = Array.from(new Set(tagIds));
      const client = getClient();
      try {
        const tags = await client.setWorkflowTags(id, deduped);
        return jsonToolResult({
          ok: true,
          action: "set_workflow_tags",
          workflowId: id,
          requested: deduped.length,
          attached: tags.length,
          tags,
        });
      } catch (err) {
        if (err instanceof N8nApiError && err.status === 404) {
          return jsonToolResult({
            ok: false,
            action: "set_workflow_tags",
            reason: "not_found",
            error: client.redact(err.message),
            hint: "404 means the workflow id OR one of the tag ids does not exist. Verify both with n8n_list_workflows and n8n_list_tags.",
          });
        }
        throw err;
      }
    },
  };
}
