import { describe, it, expect, vi } from "vitest";
import { createRetryExecutionsTool } from "../src/tools/retry-executions.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nBatchRetryResult, N8nClient } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createRetryExecutionsTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createRetryExecutionsTool(() => client);
}

describe("n8n_retry_executions", () => {
  it("refuses without confirm=true and never touches the client", async () => {
    const retryExecutions = vi.fn();
    const client = makeFakeClient({ retryExecutions });
    const tool = buildTool(client);

    const details = await run(tool, { ids: ["1", "2"] });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm/i);
    expect(retryExecutions).not.toHaveBeenCalled();
  });

  it("refuses with confirm:false", async () => {
    const retryExecutions = vi.fn();
    const client = makeFakeClient({ retryExecutions });
    const tool = buildTool(client);

    await run(tool, { ids: ["1"], confirm: false });

    expect(retryExecutions).not.toHaveBeenCalled();
  });

  it("returns ok:true with newExecutionId per row when retries succeed", async () => {
    const fanout: N8nBatchRetryResult[] = [
      { id: "1", ok: true, newExecutionId: "100" },
      { id: "2", ok: true, newExecutionId: "101" },
    ];
    const retryExecutions = vi.fn().mockResolvedValue(fanout);
    const client = makeFakeClient({ retryExecutions });
    const tool = buildTool(client);

    const details = await run(tool, {
      ids: ["1", "2"],
      confirm: true,
    });

    expect(retryExecutions).toHaveBeenCalledWith(["1", "2"], {
      concurrency: 3,
      loadWorkflow: undefined,
    });
    expect(details).toMatchObject({
      ok: true,
      action: "retry_batch",
      requested: 2,
      attempted: 2,
      retried: 2,
      notFound: 0,
      failed: 0,
      aborted: false,
      results: fanout,
    });
  });

  it("counts not_retryable rows separately from generic errors", async () => {
    const fanout: N8nBatchRetryResult[] = [
      { id: "1", ok: true, newExecutionId: "100" },
      { id: "2", ok: false, reason: "not_retryable", message: "still running" },
    ];
    const retryExecutions = vi.fn().mockResolvedValue(fanout);
    const client = makeFakeClient({ retryExecutions });
    const tool = buildTool(client);

    const details = await run(tool, { ids: ["1", "2"], confirm: true });

    expect(details).toMatchObject({
      ok: false,
      retried: 1,
      notRetryable: 1,
      failed: 1,
      aborted: false,
    });
  });

  it("counts not_found rows as failed (NOT idempotent like delete)", async () => {
    const fanout: N8nBatchRetryResult[] = [
      { id: "1", ok: true, newExecutionId: "100" },
      { id: "2", ok: false, reason: "not_found" },
    ];
    const retryExecutions = vi.fn().mockResolvedValue(fanout);
    const client = makeFakeClient({ retryExecutions });
    const tool = buildTool(client);

    const details = await run(tool, { ids: ["1", "2"], confirm: true });

    expect(details).toMatchObject({
      ok: false,
      retried: 1,
      notFound: 1,
      failed: 1,
      aborted: false,
    });
  });

  it("returns aborted:true when a 5xx halts the batch", async () => {
    const fanout: N8nBatchRetryResult[] = [
      { id: "1", ok: true, newExecutionId: "100" },
      {
        id: "2",
        ok: false,
        reason: "server_error",
        message: "n8n 500: boom",
      },
    ];
    const retryExecutions = vi.fn().mockResolvedValue(fanout);
    const client = makeFakeClient({ retryExecutions });
    const tool = buildTool(client);

    const details = await run(tool, { ids: ["1", "2", "3"], confirm: true });

    expect(details).toMatchObject({
      ok: false,
      requested: 3,
      attempted: 2,
      retried: 1,
      failed: 1,
      skipped: 1,
      aborted: true,
    });
  });

  it("dedupes ids and refuses on batch_too_large", async () => {
    const retryExecutions = vi.fn().mockResolvedValue([]);
    const client = makeFakeClient({ retryExecutions });
    const tool = buildTool(client);

    await run(tool, { ids: ["1", "2", "1"], confirm: true });
    expect(retryExecutions).toHaveBeenCalledWith(["1", "2"], {
      concurrency: 3,
      loadWorkflow: undefined,
    });

    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const details = await run(tool, { ids, confirm: true });
    expect(details.ok).toBe(false);
    expect(details.reason).toBe("batch_too_large");
  });

  it("forwards loadWorkflow + concurrency", async () => {
    const retryExecutions = vi.fn().mockResolvedValue([]);
    const client = makeFakeClient({ retryExecutions });
    const tool = buildTool(client);

    await run(tool, {
      ids: ["1"],
      confirm: true,
      loadWorkflow: true,
      concurrency: 5,
    });

    expect(retryExecutions).toHaveBeenCalledWith(["1"], {
      concurrency: 5,
      loadWorkflow: true,
    });
  });
});
