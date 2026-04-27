import { Type } from "@sinclair/typebox";
import type { N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 250,
        description: "Max tags returned (default 100).",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        description:
          "Pagination cursor from a previous call's `nextCursor`. Omit on first page.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createListTagsTool(getClient: () => N8nClient) {
  return {
    name: "n8n_list_tags",
    label: "n8n: list tags",
    description:
      "List workflow tags via GET /tags. Returns `{ data: [{id, name, createdAt, updatedAt}], nextCursor }`. Read-only; pairs with n8n_set_workflow_tags + n8n_get_workflow_tags for cross-cutting workflow metadata.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { limit, cursor } = rawParams as {
        limit?: number;
        cursor?: string;
      };
      const client = getClient();
      const page = await client.listTags({ limit, cursor });
      return jsonToolResult({
        count: page.data.length,
        nextCursor: page.nextCursor ?? null,
        data: page.data,
      });
    },
  };
}
