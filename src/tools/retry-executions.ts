import { Type } from "@sinclair/typebox";
import type { N8nBatchRetryResult, N8nClient } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 3;

const Schema = Type.Object(
  {
    ids: Type.Array(Type.String(), {
      description:
        "Execution ids to retry (from n8n_search_executions or n8n_list_executions). Deduped before fan-out; non-empty required. Each retry creates a NEW execution — the response includes the new id per row.",
      minItems: 1,
    }),
    confirm: Type.Boolean({
      description:
        "Must be true to actually retry. Each retry consumes API calls + spawns a new execution that may write to external systems again. Idempotency depends on the workflow.",
    }),
    loadWorkflow: Type.Optional(
      Type.Boolean({
        description:
          "If true, retry against the currently saved workflow instead of the version captured at the original execution time. Applied to every id in the batch. Omit to accept n8n's default (replay against the captured version).",
      }),
    ),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
        description:
          "Parallel POST /executions/{id}/retry requests. Default 3. Keep low — each retry starts a real workflow run.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createRetryExecutionsTool(getClient: () => N8nClient) {
  return {
    name: "n8n_retry_executions",
    label: "n8n: retry executions (batch)",
    description:
      "Retry multiple n8n executions by id via POST /executions/{id}/retry, client-side fan-out with bounded concurrency. Each retry creates a NEW execution; the response surfaces `newExecutionId` per row. 404 per id surfaces as `{ ok: false, reason: 'not_found' }` (NOT idempotent like delete — a missing execution is a real failure). 5xx aborts the batch via AbortController; in-flight retries are cancelled client-side, but up to N-1 retries may have already reached the server and started real runs. Batch size capped at " +
      DEFAULT_MAX_BATCH_SIZE +
      " ids. Confirm-gated.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { ids, confirm, loadWorkflow, concurrency } = rawParams as {
        ids: string[];
        confirm: boolean;
        loadWorkflow?: boolean;
        concurrency?: number;
      };

      if (!confirm) {
        return jsonToolResult({
          ok: false,
          action: "retry_batch",
          error: "confirm must be true to retry",
          hint: "Each retry spawns a new execution that may re-run side effects (HTTP calls, DB writes, etc). Verify the workflow is safe to re-run before confirming.",
        });
      }

      if (!Array.isArray(ids) || ids.length === 0) {
        return jsonToolResult({
          ok: false,
          action: "retry_batch",
          reason: "empty_ids",
          error: "ids must be a non-empty array",
        });
      }

      const deduped = Array.from(new Set(ids));

      if (deduped.length > DEFAULT_MAX_BATCH_SIZE) {
        return jsonToolResult({
          ok: false,
          action: "retry_batch",
          reason: "batch_too_large",
          error: `ids count ${deduped.length} exceeds maxBatchSize ${DEFAULT_MAX_BATCH_SIZE}`,
          hint: `Split into batches of at most ${DEFAULT_MAX_BATCH_SIZE} ids.`,
        });
      }

      const client = getClient();
      const results: N8nBatchRetryResult[] = await client.retryExecutions(
        deduped,
        {
          concurrency: concurrency ?? DEFAULT_CONCURRENCY,
          loadWorkflow,
        },
      );

      const attempted = results.length;
      const retried = results.filter((r) => r.ok).length;
      const notFound = results.filter((r) => r.reason === "not_found").length;
      const notRetryable = results.filter(
        (r) => r.reason === "not_retryable",
      ).length;
      const failed = results.filter((r) => !r.ok).length;
      const aborted = results.some((r) => r.reason === "server_error");
      const skipped = deduped.length - attempted;

      return jsonToolResult({
        ok: failed === 0,
        action: "retry_batch",
        requested: deduped.length,
        attempted,
        retried,
        notFound,
        notRetryable,
        failed,
        skipped,
        aborted,
        results,
      });
    },
  };
}
