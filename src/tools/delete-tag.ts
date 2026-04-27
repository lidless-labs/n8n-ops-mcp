import { Type } from "@sinclair/typebox";
import { N8nApiError, type N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({
      description: "Tag id (from n8n_list_tags).",
    }),
    confirm: Type.Boolean({
      description:
        "Must be true to actually delete. Cascades — n8n removes the tag from every workflow it was attached to. The workflows themselves are NOT deleted, only their association with this tag.",
    }),
  },
  { additionalProperties: false },
);

export function createDeleteTagTool(getClient: () => N8nClient) {
  return {
    name: "n8n_delete_tag",
    label: "n8n: delete tag",
    description:
      "Permanently delete a workflow tag via DELETE /tags/{id}. Requires enableEdit and explicit confirm=true. The tag is automatically removed from every workflow it was attached to (cascade is server-side). 404 returns `{ ok: false, reason: 'not_found' }`. Workflows are not deleted — only their tag association.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { id, confirm } = rawParams as { id: string; confirm: boolean };
      if (!confirm) {
        return jsonToolResult({
          ok: false,
          action: "delete_tag",
          error: "confirm must be true to delete",
          hint: "Tag deletion cascades — every workflow that has this tag attached will lose the association. Use n8n_get_workflow_tags on affected workflows beforehand if you may want to reattach.",
        });
      }
      const client = getClient();
      try {
        const tag = await client.deleteTag(id);
        return jsonToolResult({
          ok: true,
          action: "delete_tag",
          deleted: tag,
        });
      } catch (err) {
        if (err instanceof N8nApiError && err.status === 404) {
          return jsonToolResult({
            ok: false,
            action: "delete_tag",
            reason: "not_found",
          });
        }
        throw err;
      }
    },
  };
}
