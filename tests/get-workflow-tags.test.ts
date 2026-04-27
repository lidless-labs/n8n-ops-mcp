import { describe, it, expect, vi } from "vitest";
import { createGetWorkflowTagsTool } from "../src/tools/get-workflow-tags.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nTag } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createGetWorkflowTagsTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

describe("n8n_get_workflow_tags", () => {
  it("returns the tag list with workflowId echo + count", async () => {
    const tags: N8nTag[] = [{ id: "t1", name: "prod" }];
    const getWorkflowTags = vi.fn().mockResolvedValue(tags);
    const client = makeFakeClient({ getWorkflowTags });
    const tool = createGetWorkflowTagsTool(() => client);

    const details = await run(tool, { id: "wf-42" });

    expect(getWorkflowTags).toHaveBeenCalledWith("wf-42");
    expect(details).toMatchObject({
      workflowId: "wf-42",
      count: 1,
      tags,
    });
  });

  it("handles empty tag arrays", async () => {
    const getWorkflowTags = vi.fn().mockResolvedValue([]);
    const client = makeFakeClient({ getWorkflowTags });
    const tool = createGetWorkflowTagsTool(() => client);

    const details = await run(tool, { id: "wf-empty" });

    expect(details).toMatchObject({ workflowId: "wf-empty", count: 0, tags: [] });
  });
});
