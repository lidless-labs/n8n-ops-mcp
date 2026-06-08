import { describe, it, expect, vi } from "vitest";
import { createSetWorkflowTagsTool } from "../src/tools/set-workflow-tags.ts";
import { makeFakeClient } from "./helpers.ts";
import { N8nApiError, type N8nClient, type N8nTag } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createSetWorkflowTagsTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createSetWorkflowTagsTool(() => client);
}

describe("n8n_set_workflow_tags", () => {
  it("sends the deduped tag id list and returns the new tag set", async () => {
    const result: N8nTag[] = [
      { id: "t1", name: "prod" },
      { id: "t2", name: "cron" },
    ];
    const setWorkflowTags = vi.fn().mockResolvedValue(result);
    const client = makeFakeClient({ setWorkflowTags });
    const tool = buildTool(client);

    const details = await run(tool, {
      id: "wf-1",
      tagIds: ["t1", "t2", "t1"],
      confirm: true,
    });

    expect(setWorkflowTags).toHaveBeenCalledWith("wf-1", ["t1", "t2"]);
    expect(details).toMatchObject({
      ok: true,
      action: "set_workflow_tags",
      workflowId: "wf-1",
      requested: 2,
      attached: 2,
      tags: result,
    });
  });

  it("clears all tags when tagIds is empty", async () => {
    const setWorkflowTags = vi.fn().mockResolvedValue([]);
    const client = makeFakeClient({ setWorkflowTags });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", tagIds: [], confirm: true });

    expect(setWorkflowTags).toHaveBeenCalledWith("wf-1", []);
    expect(details).toMatchObject({
      ok: true,
      requested: 0,
      attached: 0,
    });
  });

  it("returns reason=not_found on 404 (workflow OR tag missing)", async () => {
    const setWorkflowTags = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(404, "/api/v1/workflows/wf-x/tags", "not found"),
      );
    const client = makeFakeClient({ setWorkflowTags });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-x", tagIds: ["t1"], confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_found");
  });

  it("rethrows non-404 errors", async () => {
    const setWorkflowTags = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(500, "/api/v1/workflows/wf/tags", "boom"),
      );
    const client = makeFakeClient({ setWorkflowTags });
    const tool = buildTool(client);

    await expect(run(tool, { id: "wf", tagIds: [], confirm: true })).rejects.toThrow(/boom/);
  });

  it("refuses to write without confirm=true", async () => {
    const setWorkflowTags = vi.fn();
    const client = makeFakeClient({ setWorkflowTags });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", tagIds: ["t1"] });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm must be true/);
    expect(setWorkflowTags).not.toHaveBeenCalled();
  });
});
