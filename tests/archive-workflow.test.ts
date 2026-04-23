import { describe, it, expect, vi } from "vitest";
import {
  createArchiveWorkflowTool,
  createUnarchiveWorkflowTool,
} from "../src/tools/archive-workflow.ts";
import { makeFakeClient } from "./helpers.ts";
import { N8nApiError, type N8nClient, type N8nWorkflow } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createArchiveWorkflowTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as { details: Record<string, unknown> };
  return res.details;
}

function baseWorkflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: "wf-42",
    name: "my-workflow",
    active: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
    nodes: [],
    connections: {},
    ...overrides,
  };
}

describe("n8n_archive_workflow", () => {
  it("archives a workflow and surfaces isArchived + deactivated state", async () => {
    const archived = baseWorkflow({ active: false, isArchived: true });
    const archiveWorkflow = vi.fn().mockResolvedValue(archived);
    const client = makeFakeClient({ archiveWorkflow });
    const tool = createArchiveWorkflowTool(() => client);

    const details = await run(tool, { id: "wf-42" });

    expect(archiveWorkflow).toHaveBeenCalledWith("wf-42");
    expect(details).toMatchObject({
      ok: true,
      action: "archive",
      workflowId: "wf-42",
      workflowName: "my-workflow",
      active: false,
      isArchived: true,
    });
  });

  it("is idempotent - a second archive call on an already-archived workflow still returns ok", async () => {
    const archived = baseWorkflow({ isArchived: true });
    const archiveWorkflow = vi.fn().mockResolvedValue(archived);
    const client = makeFakeClient({ archiveWorkflow });
    const tool = createArchiveWorkflowTool(() => client);

    const first = await run(tool, { id: "wf-42" });
    const second = await run(tool, { id: "wf-42" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(archiveWorkflow).toHaveBeenCalledTimes(2);
  });

  it("returns ok:false with reason=not_found on 404", async () => {
    const archiveWorkflow = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(404, "/api/v1/workflows/ghost/archive", "not found"),
      );
    const client = makeFakeClient({ archiveWorkflow });
    const tool = createArchiveWorkflowTool(() => client);

    const details = await run(tool, { id: "ghost" });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_found");
    expect(details.workflowId).toBe("ghost");
  });

  it("rethrows non-404 API errors", async () => {
    const archiveWorkflow = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(500, "/api/v1/workflows/wf-42/archive", "upstream exploded"),
      );
    const client = makeFakeClient({ archiveWorkflow });
    const tool = createArchiveWorkflowTool(() => client);

    await expect(run(tool, { id: "wf-42" })).rejects.toThrow(/upstream exploded/);
  });

  it("falls back to action-derived isArchived when upstream omits the flag", async () => {
    // Older n8n responses may not include isArchived; we infer from the action.
    const archived = baseWorkflow();
    delete (archived as Partial<N8nWorkflow>).isArchived;
    const archiveWorkflow = vi.fn().mockResolvedValue(archived);
    const client: N8nClient = makeFakeClient({ archiveWorkflow });
    const tool = createArchiveWorkflowTool(() => client);

    const details = await run(tool, { id: "wf-42" });

    expect(details.isArchived).toBe(true);
  });
});

describe("n8n_unarchive_workflow", () => {
  it("unarchives a workflow and reports that it is NOT reactivated", async () => {
    const unarchived = baseWorkflow({ active: false, isArchived: false });
    const unarchiveWorkflow = vi.fn().mockResolvedValue(unarchived);
    const client = makeFakeClient({ unarchiveWorkflow });
    const tool = createUnarchiveWorkflowTool(() => client);

    const details = await run(tool, { id: "wf-42" });

    expect(unarchiveWorkflow).toHaveBeenCalledWith("wf-42");
    expect(details).toMatchObject({
      ok: true,
      action: "unarchive",
      workflowId: "wf-42",
      active: false, // explicitly NOT reactivated
      isArchived: false,
    });
  });

  it("returns ok:false with reason=not_found on 404", async () => {
    const unarchiveWorkflow = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(404, "/api/v1/workflows/ghost/unarchive", "not found"),
      );
    const client = makeFakeClient({ unarchiveWorkflow });
    const tool = createUnarchiveWorkflowTool(() => client);

    const details = await run(tool, { id: "ghost" });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_found");
  });
});
