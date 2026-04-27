import { Type } from "@sinclair/typebox";
import type { N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({
      description: "Workflow id (from n8n_list_workflows).",
    }),
  },
  { additionalProperties: false },
);

export function createGetWorkflowTagsTool(getClient: () => N8nClient) {
  return {
    name: "n8n_get_workflow_tags",
    label: "n8n: get workflow tags",
    description:
      "Read the tags currently attached to a workflow via GET /workflows/{id}/tags. Returns the array of `{id, name}` tag objects (also includes createdAt/updatedAt). Read-only. Pairs with n8n_set_workflow_tags for diffs and reattach flows.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { id } = rawParams as { id: string };
      const client = getClient();
      const tags = await client.getWorkflowTags(id);
      return jsonToolResult({
        workflowId: id,
        count: tags.length,
        tags,
      });
    },
  };
}
