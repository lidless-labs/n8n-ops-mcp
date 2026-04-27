import { describe, it, expect, vi } from "vitest";
import { createDeleteTagTool } from "../src/tools/delete-tag.ts";
import { makeFakeClient } from "./helpers.ts";
import { N8nApiError, type N8nClient, type N8nTag } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createDeleteTagTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createDeleteTagTool(() => client);
}

describe("n8n_delete_tag", () => {
  it("refuses without confirm=true and never touches the client", async () => {
    const deleteTag = vi.fn();
    const client = makeFakeClient({ deleteTag });
    const tool = buildTool(client);

    const details = await run(tool, { id: "t1" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm/i);
    expect(deleteTag).not.toHaveBeenCalled();
  });

  it("refuses with confirm:false and never touches the client", async () => {
    const deleteTag = vi.fn();
    const client = makeFakeClient({ deleteTag });
    const tool = buildTool(client);

    await run(tool, { id: "t1", confirm: false });

    expect(deleteTag).not.toHaveBeenCalled();
  });

  it("deletes when confirm=true and returns the tag", async () => {
    const tag: N8nTag = { id: "t-old", name: "deprecated" };
    const deleteTag = vi.fn().mockResolvedValue(tag);
    const client = makeFakeClient({ deleteTag });
    const tool = buildTool(client);

    const details = await run(tool, { id: "t-old", confirm: true });

    expect(deleteTag).toHaveBeenCalledWith("t-old");
    expect(details).toMatchObject({
      ok: true,
      action: "delete_tag",
      deleted: tag,
    });
  });

  it("returns reason=not_found on 404", async () => {
    const deleteTag = vi
      .fn()
      .mockRejectedValue(new N8nApiError(404, "/api/v1/tags/x", "not found"));
    const client = makeFakeClient({ deleteTag });
    const tool = buildTool(client);

    const details = await run(tool, { id: "x", confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_found");
  });

  it("rethrows non-404 errors", async () => {
    const deleteTag = vi
      .fn()
      .mockRejectedValue(new N8nApiError(500, "/api/v1/tags/x", "boom"));
    const client = makeFakeClient({ deleteTag });
    const tool = buildTool(client);

    await expect(run(tool, { id: "x", confirm: true })).rejects.toThrow(/boom/);
  });
});
