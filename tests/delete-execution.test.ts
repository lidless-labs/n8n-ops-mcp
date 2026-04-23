import { describe, it, expect, vi } from "vitest";
import { createDeleteExecutionTool } from "../src/tools/delete-execution.ts";
import { makeFakeClient } from "./helpers.ts";
import { N8nApiError, type N8nClient, type N8nExecution } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createDeleteExecutionTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as { details: Record<string, unknown> };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createDeleteExecutionTool(() => client);
}

describe("n8n_delete_execution", () => {
  it("refuses without confirm=true and never touches the client", async () => {
    const deleteExecution = vi.fn();
    const client = makeFakeClient({ deleteExecution });
    const tool = buildTool(client);

    const details = await run(tool, { id: "42" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm/i);
    expect(details.executionId).toBe("42");
    expect(deleteExecution).not.toHaveBeenCalled();
  });

  it("refuses with confirm:false and never touches the client", async () => {
    const deleteExecution = vi.fn();
    const client = makeFakeClient({ deleteExecution });
    const tool = buildTool(client);

    const details = await run(tool, { id: "42", confirm: false });

    expect(details.ok).toBe(false);
    expect(deleteExecution).not.toHaveBeenCalled();
  });

  it("deletes an execution and returns a success summary when confirm=true", async () => {
    const deleted: N8nExecution = {
      id: "42",
      finished: true,
      mode: "trigger",
      workflowId: "wf-1",
      status: "error",
      startedAt: "2026-04-23T00:00:00.000Z",
      stoppedAt: "2026-04-23T00:00:05.000Z",
      workflowData: { id: "wf-1", name: "My Workflow" },
    };
    const deleteExecution = vi.fn().mockResolvedValue(deleted);
    const client = makeFakeClient({ deleteExecution });
    const tool = buildTool(client);

    const details = await run(tool, { id: "42", confirm: true });

    expect(deleteExecution).toHaveBeenCalledWith("42");
    expect(details).toMatchObject({
      ok: true,
      action: "delete",
      executionId: "42",
      workflowId: "wf-1",
      workflowName: "My Workflow",
      status: "error",
      finished: true,
      startedAt: "2026-04-23T00:00:00.000Z",
      stoppedAt: "2026-04-23T00:00:05.000Z",
    });
  });

  it("returns ok:false with reason=not_found on 404", async () => {
    const deleteExecution = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(404, "/api/v1/executions/999", "not found"),
      );
    const client = makeFakeClient({ deleteExecution });
    const tool = buildTool(client);

    const details = await run(tool, { id: "999", confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_found");
    expect(details.executionId).toBe("999");
  });

  it("rethrows non-404 API errors so the agent sees the real failure", async () => {
    const deleteExecution = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(500, "/api/v1/executions/7", "upstream exploded"),
      );
    const client = makeFakeClient({ deleteExecution });
    const tool = buildTool(client);

    await expect(run(tool, { id: "7", confirm: true })).rejects.toThrow(
      /upstream exploded/,
    );
  });
});
