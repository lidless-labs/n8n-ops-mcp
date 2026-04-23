import { Type } from "@sinclair/typebox";
import type { N8nBatchDeleteResult, N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 3;

const Schema = Type.Object(
  {
    ids: Type.Array(Type.String(), {
      description:
        "Execution ids to delete (from n8n_search_executions or n8n_list_executions). Deduped before fan-out; non-empty required.",
      minItems: 1,
    }),
    confirm: Type.Boolean({
      description:
        "Must be true to actually delete. Deletion is irreversible: execution logs, run data, and error payloads are gone from n8n after this call. If you may need the records later, fetch n8n_get_execution first and save the output.",
    }),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
        description:
          "Parallel DELETE requests against the n8n API. Default 3. Keep low — n8n shares a database.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createDeleteExecutionsTool(getClient: () => N8nClient) {
  return {
    name: "n8n_delete_executions",
    label: "n8n: delete executions (batch)",
    description:
      "Permanently delete multiple n8n execution records by id via DELETE /executions/{id}, client-side fan-out with bounded concurrency. Irreversible: per-node run data and error payloads are erased. Requires enableEdit and explicit confirm=true. Per-id outcome is surfaced in results (order is completion order, not input order; look up by id). 404 per id is treated as already_deleted (idempotent). A 5xx per id aborts the batch via AbortController; no new ids are claimed after the abort and any already-in-flight requests are cancelled client-side. Under concurrency N, up to N-1 in-flight deletes may have already reached the server by the time the 5xx is observed — the batch is best-effort, not transactional. `skipped` counts both never-claimed ids and in-flight cancellations. Batch size is capped at " +
      DEFAULT_MAX_BATCH_SIZE +
      " ids.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { ids, confirm, concurrency } = rawParams as {
        ids: string[];
        confirm: boolean;
        concurrency?: number;
      };

      if (!confirm) {
        return jsonToolResult({
          ok: false,
          action: "delete_batch",
          error: "confirm must be true to delete",
          hint: "Batch deletion is irreversible. Fetch n8n_get_execution first for any record you may need later.",
        });
      }

      if (!Array.isArray(ids) || ids.length === 0) {
        return jsonToolResult({
          ok: false,
          action: "delete_batch",
          reason: "empty_ids",
          error: "ids must be a non-empty array",
        });
      }

      const deduped = Array.from(new Set(ids));

      if (deduped.length > DEFAULT_MAX_BATCH_SIZE) {
        return jsonToolResult({
          ok: false,
          action: "delete_batch",
          reason: "batch_too_large",
          error: `ids count ${deduped.length} exceeds maxBatchSize ${DEFAULT_MAX_BATCH_SIZE}`,
          hint: `Split into batches of at most ${DEFAULT_MAX_BATCH_SIZE} ids.`,
        });
      }

      const client = getClient();
      const results: N8nBatchDeleteResult[] = await client.deleteExecutions(
        deduped,
        { concurrency: concurrency ?? DEFAULT_CONCURRENCY },
      );

      const attempted = results.length;
      const deleted = results.filter(
        (r) => r.ok && r.reason !== "already_deleted",
      ).length;
      const alreadyDeleted = results.filter(
        (r) => r.reason === "already_deleted",
      ).length;
      const failed = results.filter((r) => !r.ok).length;
      const aborted = results.some((r) => r.reason === "server_error");
      const skipped = deduped.length - attempted;

      return jsonToolResult({
        ok: failed === 0,
        action: "delete_batch",
        requested: deduped.length,
        attempted,
        deleted,
        alreadyDeleted,
        failed,
        skipped,
        aborted,
        results,
      });
    },
  };
}
