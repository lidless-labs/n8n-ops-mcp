import { describe, it, expect, vi } from "vitest";
import { createListTagsTool } from "../src/tools/list-tags.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nTag } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createListTagsTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createListTagsTool(() => client);
}

describe("n8n_list_tags", () => {
  it("returns tag rows + nextCursor", async () => {
    const tags: N8nTag[] = [
      { id: "t1", name: "production" },
      { id: "t2", name: "staging" },
    ];
    const listTags = vi
      .fn()
      .mockResolvedValue({ data: tags, nextCursor: "next-page" });
    const client = makeFakeClient({ listTags });
    const tool = buildTool(client);

    const details = await run(tool, {});

    expect(listTags).toHaveBeenCalledWith({ limit: undefined, cursor: undefined });
    expect(details).toMatchObject({
      count: 2,
      nextCursor: "next-page",
      data: tags,
    });
  });

  it("forwards limit + cursor", async () => {
    const listTags = vi.fn().mockResolvedValue({ data: [] });
    const client = makeFakeClient({ listTags });
    const tool = buildTool(client);

    await run(tool, { limit: 50, cursor: "abc" });

    expect(listTags).toHaveBeenCalledWith({ limit: 50, cursor: "abc" });
  });

  it("normalizes missing nextCursor to null", async () => {
    const listTags = vi.fn().mockResolvedValue({ data: [{ id: "x", name: "y" }] });
    const client = makeFakeClient({ listTags });
    const tool = buildTool(client);

    const details = await run(tool, {});

    expect(details.nextCursor).toBeNull();
  });
});
