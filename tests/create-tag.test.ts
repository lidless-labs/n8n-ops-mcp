import { describe, it, expect, vi } from "vitest";
import { createCreateTagTool } from "../src/tools/create-tag.ts";
import { makeFakeClient } from "./helpers.ts";
import { N8nApiError, type N8nClient, type N8nTag } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createCreateTagTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createCreateTagTool(() => client);
}

describe("n8n_create_tag", () => {
  it("creates a tag and returns it", async () => {
    const tag: N8nTag = { id: "t-new", name: "production" };
    const createTag = vi.fn().mockResolvedValue(tag);
    const client = makeFakeClient({ createTag });
    const tool = buildTool(client);

    const details = await run(tool, { name: "production", confirm: true });

    expect(createTag).toHaveBeenCalledWith("production");
    expect(details).toMatchObject({
      ok: true,
      action: "create_tag",
      tag,
    });
  });

  it("trims whitespace before sending", async () => {
    const createTag = vi
      .fn()
      .mockResolvedValue({ id: "t1", name: "production" });
    const client = makeFakeClient({ createTag });
    const tool = buildTool(client);

    await run(tool, { name: "  production  ", confirm: true });

    expect(createTag).toHaveBeenCalledWith("production");
  });

  it("rejects empty-after-trim names defensively (MCP schema also rejects)", async () => {
    const createTag = vi.fn();
    const client = makeFakeClient({ createTag });
    const tool = buildTool(client);

    const details = await run(tool, { name: "   ", confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("empty_name");
    expect(createTag).not.toHaveBeenCalled();
  });

  it("returns reason=conflict on 409", async () => {
    const createTag = vi
      .fn()
      .mockRejectedValue(new N8nApiError(409, "/api/v1/tags", "exists"));
    const client = makeFakeClient({ createTag });
    const tool = buildTool(client);

    const details = await run(tool, { name: "production", confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("conflict");
  });

  it("rethrows non-409 API errors", async () => {
    const createTag = vi
      .fn()
      .mockRejectedValue(new N8nApiError(500, "/api/v1/tags", "boom"));
    const client = makeFakeClient({ createTag });
    const tool = buildTool(client);

    await expect(run(tool, { name: "x", confirm: true })).rejects.toThrow(/boom/);
  });

  it("refuses to create without confirm=true", async () => {
    const createTag = vi.fn();
    const client = makeFakeClient({ createTag });
    const tool = buildTool(client);

    const details = await run(tool, { name: "production" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm must be true/);
    expect(createTag).not.toHaveBeenCalled();
  });
});
