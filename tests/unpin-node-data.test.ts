import { describe, it, expect, vi } from "vitest";
import { createUnpinNodeDataTool } from "../src/tools/unpin-node-data.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nWorkflow } from "../src/client.ts";

function workflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: "wf-1",
    name: "intel pipeline",
    active: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    nodes: [
      { id: "a", name: "Webhook", type: "n8n-nodes-base.webhook", parameters: {} },
      { id: "b", name: "HTTP", type: "n8n-nodes-base.httpRequest", parameters: {} },
    ],
    connections: {},
    settings: {},
    ...overrides,
  };
}

async function run(
  tool: ReturnType<typeof createUnpinNodeDataTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createUnpinNodeDataTool(() => client);
}

describe("n8n_unpin_node_data", () => {
  it("rejects when confirm is missing or false", async () => {
    const client = makeFakeClient({});
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      confirm: false,
    });
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm/);
    expect(client.getWorkflow).not.toHaveBeenCalled();
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  it("returns noop=true when the node had no pinned data (single-node mode)", async () => {
    const wf = workflow({ pinData: { Webhook: [{ json: { x: 1 } }] } });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow: vi.fn(),
    });
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP", // not pinned
      confirm: true,
    });
    expect(details.ok).toBe(true);
    expect(details.noop).toBe(true);
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  it("clears a single node's pinned data and preserves the others", async () => {
    const wf = workflow({
      pinData: {
        Webhook: [{ json: { keep: 1 } }],
        HTTP: [{ json: { drop: 1 } }],
      },
    });
    const saveWorkflow = vi.fn().mockResolvedValue(wf);
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow,
    });
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      confirm: true,
    });
    expect(details.ok).toBe(true);
    expect(details.noop).toBe(false);
    const [, body] = saveWorkflow.mock.calls[0];
    expect(body.pinData).toEqual({ Webhook: [{ json: { keep: 1 } }] });
    expect(body.pinData).not.toHaveProperty("HTTP");
  });

  it("clears ALL pinned data when nodeName is omitted", async () => {
    const wf = workflow({
      pinData: {
        Webhook: [{ json: { x: 1 } }],
        HTTP: [{ json: { y: 2 } }],
      },
    });
    const saveWorkflow = vi.fn().mockResolvedValue(wf);
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow,
    });
    const tool = buildTool(client);
    const details = await run(tool, { id: "wf-1", confirm: true });
    expect(details.ok).toBe(true);
    expect(details.scope).toBe("workflow");
    expect(details.clearedNodes).toEqual(
      expect.arrayContaining(["Webhook", "HTTP"]),
    );
    const [, body] = saveWorkflow.mock.calls[0];
    expect(body.pinData).toEqual({});
  });

  it("returns noop=true when whole-workflow unpin runs against a workflow with no pinned data", async () => {
    const wf = workflow();
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow: vi.fn(),
    });
    const tool = buildTool(client);
    const details = await run(tool, { id: "wf-1", confirm: true });
    expect(details.ok).toBe(true);
    expect(details.noop).toBe(true);
    expect(details.scope).toBe("workflow");
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  it("redacts the API key from save-failure error messages", async () => {
    const API_KEY = "unpin-secret";
    const wf = workflow({ pinData: { HTTP: [{ json: { x: 1 } }] } });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow: vi
        .fn()
        .mockRejectedValue(new Error(`server says token=${API_KEY}`)),
      redact: vi.fn((t: string) => t.split(API_KEY).join("***REDACTED***")),
    });
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      confirm: true,
    });
    expect(details.ok).toBe(false);
    expect(String(details.error)).not.toContain(API_KEY);
    expect(String(details.error)).toContain("***REDACTED***");
  });
});
