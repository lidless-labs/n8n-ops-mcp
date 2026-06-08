import { Type } from "@sinclair/typebox";
import { N8nApiError, type N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 100,
      description:
        "Tag name (e.g. 'production', 'cron-3am'). Must be unique — n8n returns 409 if a tag with this name already exists.",
    }),
    confirm: Type.Boolean({
      description:
        "Must be true to actually create the tag. Reversible via n8n_delete_tag.",
    }),
  },
  { additionalProperties: false },
);

export function createCreateTagTool(getClient: () => N8nClient) {
  return {
    name: "n8n_create_tag",
    label: "n8n: create tag",
    description:
      "Create a workflow tag via POST /tags. Tags are global to the n8n instance — once created, attach to workflows via n8n_set_workflow_tags. Requires enableEdit and explicit confirm=true (reversible via n8n_delete_tag). Returns 409 surface as `{ ok: false, reason: 'conflict' }`.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { name, confirm } = rawParams as { name: string; confirm: boolean };
      if (!confirm) {
        return jsonToolResult({
          ok: false,
          action: "create_tag",
          error: "confirm must be true to create a tag",
        });
      }
      const trimmed = name.trim();
      if (!trimmed) {
        return jsonToolResult({
          ok: false,
          action: "create_tag",
          reason: "empty_name",
          error: "name must be non-empty after trim",
        });
      }
      const client = getClient();
      try {
        const tag = await client.createTag(trimmed);
        return jsonToolResult({
          ok: true,
          action: "create_tag",
          tag,
        });
      } catch (err) {
        if (err instanceof N8nApiError && err.status === 409) {
          return jsonToolResult({
            ok: false,
            action: "create_tag",
            reason: "conflict",
            error: client.redact(err.message),
            hint: "A tag with this name already exists. Use n8n_list_tags to find its id.",
          });
        }
        throw err;
      }
    },
  };
}
