import { describe, it, expect, vi } from "vitest";
import { createDeleteExecutionsTool } from "../src/tools/delete-executions.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nBatchDeleteResult, N8nClient } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createDeleteExecutionsTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createDeleteExecutionsTool(() => client);
}

describe("n8n_delete_executions", () => {
  it("refuses without confirm=true and never touches the client", async () => {
    const deleteExecutions = vi.fn();
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    const details = await run(tool, { ids: ["1", "2", "3"] });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm/i);
    expect(deleteExecutions).not.toHaveBeenCalled();
  });

  it("refuses with confirm:false and never touches the client", async () => {
    const deleteExecutions = vi.fn();
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    const details = await run(tool, { ids: ["1", "2"], confirm: false });

    expect(details.ok).toBe(false);
    expect(deleteExecutions).not.toHaveBeenCalled();
  });

  it("returns ok:true when all ids are deleted cleanly", async () => {
    const fanout: N8nBatchDeleteResult[] = [
      { id: "1", ok: true },
      { id: "2", ok: true },
      { id: "3", ok: true },
    ];
    const deleteExecutions = vi.fn().mockResolvedValue(fanout);
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    const details = await run(tool, {
      ids: ["1", "2", "3"],
      confirm: true,
    });

    expect(deleteExecutions).toHaveBeenCalledWith(["1", "2", "3"], {
      concurrency: 3,
    });
    expect(details).toMatchObject({
      ok: true,
      action: "delete_batch",
      requested: 3,
      attempted: 3,
      deleted: 3,
      alreadyDeleted: 0,
      failed: 0,
      aborted: false,
      results: fanout,
    });
  });

  it("returns a mixed summary when some ids 404 (already_deleted, idempotent)", async () => {
    const fanout: N8nBatchDeleteResult[] = [
      { id: "1", ok: true },
      { id: "2", ok: true },
      { id: "3", ok: true, reason: "already_deleted" },
    ];
    const deleteExecutions = vi.fn().mockResolvedValue(fanout);
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    const details = await run(tool, {
      ids: ["1", "2", "3"],
      confirm: true,
    });

    expect(details).toMatchObject({
      ok: true,
      action: "delete_batch",
      requested: 3,
      attempted: 3,
      deleted: 2,
      alreadyDeleted: 1,
      failed: 0,
      aborted: false,
    });
    expect((details.results as N8nBatchDeleteResult[])[2].reason).toBe(
      "already_deleted",
    );
  });

  it("returns ok:false with aborted:true + partial results when a 5xx halts the batch", async () => {
    const fanout: N8nBatchDeleteResult[] = [
      { id: "1", ok: true },
      {
        id: "2",
        ok: false,
        reason: "server_error",
        message: "n8n 500 on /api/v1/executions/2: boom",
      },
    ];
    const deleteExecutions = vi.fn().mockResolvedValue(fanout);
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    const details = await run(tool, {
      ids: ["1", "2", "3"],
      confirm: true,
    });

    expect(details).toMatchObject({
      ok: false,
      action: "delete_batch",
      requested: 3,
      attempted: 2,
      deleted: 1,
      failed: 1,
      skipped: 1,
      aborted: true,
    });
  });

  it("refuses with reason=batch_too_large when ids exceed the cap", async () => {
    const deleteExecutions = vi.fn();
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const details = await run(tool, { ids, confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("batch_too_large");
    expect(deleteExecutions).not.toHaveBeenCalled();
  });

  it("dedupes duplicate ids before fan-out", async () => {
    const deleteExecutions = vi
      .fn()
      .mockResolvedValue([
        { id: "1", ok: true },
        { id: "2", ok: true },
      ] satisfies N8nBatchDeleteResult[]);
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    const details = await run(tool, {
      ids: ["1", "2", "1", "2", "1"],
      confirm: true,
    });

    expect(deleteExecutions).toHaveBeenCalledWith(["1", "2"], {
      concurrency: 3,
    });
    expect(details.requested).toBe(2);
  });

  it("refuses with reason=empty_ids on empty array (defensive — MCP schema also rejects)", async () => {
    const deleteExecutions = vi.fn();
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    const details = await run(tool, { ids: [], confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("empty_ids");
    expect(deleteExecutions).not.toHaveBeenCalled();
  });

  it("forwards custom concurrency to the client", async () => {
    const deleteExecutions = vi.fn().mockResolvedValue([{ id: "1", ok: true }]);
    const client = makeFakeClient({ deleteExecutions });
    const tool = buildTool(client);

    await run(tool, { ids: ["1"], confirm: true, concurrency: 5 });

    expect(deleteExecutions).toHaveBeenCalledWith(["1"], { concurrency: 5 });
  });
});
