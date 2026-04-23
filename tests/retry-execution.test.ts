import { describe, it, expect, vi } from "vitest";
import { createRetryExecutionTool } from "../src/tools/retry-execution.ts";
import { makeFakeClient } from "./helpers.ts";
import { N8nApiError, type N8nClient, type N8nExecution } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createRetryExecutionTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as { details: Record<string, unknown> };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createRetryExecutionTool(() => client);
}

describe("n8n_retry_execution", () => {
  it("retries a failed execution and surfaces both the original and new execution ids", async () => {
    const retried: N8nExecution = {
      id: "43",
      finished: false,
      mode: "trigger",
      workflowId: "wf-1",
      status: "running",
      startedAt: "2026-04-23T00:01:00.000Z",
      workflowData: { id: "wf-1", name: "My Workflow" },
    };
    const retryExecution = vi.fn().mockResolvedValue(retried);
    const client = makeFakeClient({ retryExecution });
    const tool = buildTool(client);

    const details = await run(tool, { id: "42" });

    expect(retryExecution).toHaveBeenCalledWith("42", {});
    expect(details).toMatchObject({
      ok: true,
      action: "retry",
      originalExecutionId: "42",
      newExecutionId: "43",
      workflowId: "wf-1",
      workflowName: "My Workflow",
      status: "running",
      finished: false,
      startedAt: "2026-04-23T00:01:00.000Z",
    });
    expect(details.newExecutionId).not.toBe(details.originalExecutionId);
  });

  it("plumbs loadWorkflow:true through to the client", async () => {
    const retried: N8nExecution = {
      id: "100",
      finished: false,
      mode: "trigger",
      workflowId: "wf-1",
      status: "running",
    };
    const retryExecution = vi.fn().mockResolvedValue(retried);
    const client = makeFakeClient({ retryExecution });
    const tool = buildTool(client);

    const details = await run(tool, { id: "99", loadWorkflow: true });

    expect(retryExecution).toHaveBeenCalledWith("99", { loadWorkflow: true });
    expect(details.loadWorkflow).toBe(true);
  });

  it("returns ok:false with reason=not_found on 404", async () => {
    const retryExecution = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(404, "/api/v1/executions/999/retry", "not found"),
      );
    const client = makeFakeClient({ retryExecution });
    const tool = buildTool(client);

    const details = await run(tool, { id: "999" });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_found");
    expect(details.originalExecutionId).toBe("999");
  });

  it("returns ok:false with reason=not_retryable on 409", async () => {
    const retryExecution = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(409, "/api/v1/executions/77/retry", "conflict"),
      );
    const client = makeFakeClient({ retryExecution });
    const tool = buildTool(client);

    const details = await run(tool, { id: "77" });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_retryable");
    expect(details.originalExecutionId).toBe("77");
  });

  it("rethrows non-{404,409} API errors so the agent sees the real failure", async () => {
    const retryExecution = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(500, "/api/v1/executions/7/retry", "upstream exploded"),
      );
    const client = makeFakeClient({ retryExecution });
    const tool = buildTool(client);

    await expect(run(tool, { id: "7" })).rejects.toThrow(/upstream exploded/);
  });
});
