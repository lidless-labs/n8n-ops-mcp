import { describe, it, expect, vi } from "vitest";
import { createPinNodeDataTool } from "../src/tools/pin-node-data.ts";
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
    settings: { executionOrder: "v1" },
    ...overrides,
  };
}

async function run(
  tool: ReturnType<typeof createPinNodeDataTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createPinNodeDataTool(() => client);
}

describe("n8n_pin_node_data", () => {
  it("rejects when confirm is missing or false", async () => {
    const client = makeFakeClient({});
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      data: [{ ok: true }],
      confirm: false,
    });
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm/);
    expect(client.getWorkflow).not.toHaveBeenCalled();
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  it("rejects when the named node does not exist in the workflow", async () => {
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(workflow()),
    });
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "Missing",
      data: [{ x: 1 }],
      confirm: true,
    });
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/not found/);
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  it("auto-wraps raw items into {json: ...} shape", async () => {
    const wf = workflow();
    const saveWorkflow = vi.fn().mockResolvedValue(wf);
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow,
    });
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      data: [{ value: "raw-payload" }, { value: "second" }],
      confirm: true,
    });
    expect(details.ok).toBe(true);
    const [, body] = saveWorkflow.mock.calls[0];
    expect(body.pinData.HTTP).toEqual([
      { json: { value: "raw-payload" } },
      { json: { value: "second" } },
    ]);
  });

  it("passes through items that already have a `json` field unchanged", async () => {
    const wf = workflow();
    const saveWorkflow = vi.fn().mockResolvedValue(wf);
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow,
    });
    const tool = buildTool(client);
    await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      data: [{ json: { keep: 1 }, binary: { foo: { data: "x" } } }],
      confirm: true,
    });
    const [, body] = saveWorkflow.mock.calls[0];
    expect(body.pinData.HTTP).toEqual([
      { json: { keep: 1 }, binary: { foo: { data: "x" } } },
    ]);
  });

  it("preserves pinData on OTHER nodes when pinning a single node", async () => {
    const wf = workflow({ pinData: { Webhook: [{ json: { kept: true } }] } });
    const saveWorkflow = vi.fn().mockResolvedValue(wf);
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow,
    });
    const tool = buildTool(client);
    await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      data: [{ x: 1 }],
      confirm: true,
    });
    const [, body] = saveWorkflow.mock.calls[0];
    expect(body.pinData.Webhook).toEqual([{ json: { kept: true } }]);
    expect(body.pinData.HTTP).toEqual([{ json: { x: 1 } }]);
  });

  it("merges with existing pinned data on the same node when merge=true", async () => {
    const wf = workflow({
      pinData: { HTTP: [{ json: { existing: 1 } }] },
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
      data: [{ new: 2 }],
      merge: true,
      confirm: true,
    });
    const [, body] = saveWorkflow.mock.calls[0];
    expect(body.pinData.HTTP).toEqual([
      { json: { existing: 1 } },
      { json: { new: 2 } },
    ]);
    expect(details.appended).toBe(1);
    expect(details.replaced).toBe(false);
  });

  it("replaces existing pinned data by default and reports replaced=true", async () => {
    const wf = workflow({
      pinData: { HTTP: [{ json: { old: 1 } }] },
    });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      data: [{ new: 1 }],
      confirm: true,
    });
    expect(details.replaced).toBe(true);
    expect(details.pinnedItemCount).toBe(1);
  });

  it("rejects when combined items exceed the cap of 50 in merge mode", async () => {
    const existing = Array.from({ length: 49 }, (_, i) => ({ json: { i } }));
    const wf = workflow({ pinData: { HTTP: existing } });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow: vi.fn(),
    });
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      data: [{ a: 1 }, { b: 2 }],
      merge: true,
      confirm: true,
    });
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/exceeds cap/);
    expect(client.saveWorkflow).not.toHaveBeenCalled();
  });

  it("includes the existing nodes/connections/settings in the PUT body so n8n's PUT does not blank them", async () => {
    const wf = workflow({
      staticData: { foo: "bar" },
      settings: { executionOrder: "v1", timezone: "America/New_York" },
    });
    const saveWorkflow = vi.fn().mockResolvedValue(wf);
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      saveWorkflow,
    });
    const tool = buildTool(client);
    await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      data: [{ x: 1 }],
      confirm: true,
    });
    const [id, body] = saveWorkflow.mock.calls[0];
    expect(id).toBe("wf-1");
    expect(body.name).toBe("intel pipeline");
    expect(body.nodes).toHaveLength(2);
    expect(body.settings.timezone).toBe("America/New_York");
    expect(body.staticData).toEqual({ foo: "bar" });
  });

  it("redacts the API key from save-failure error messages", async () => {
    const API_KEY = "secret-pin-token";
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(workflow()),
      saveWorkflow: vi
        .fn()
        .mockRejectedValue(new Error(`upstream rejected token=${API_KEY}`)),
      redact: vi.fn((t: string) => t.split(API_KEY).join("***REDACTED***")),
    });
    const tool = buildTool(client);
    const details = await run(tool, {
      id: "wf-1",
      nodeName: "HTTP",
      data: [{ x: 1 }],
      confirm: true,
    });
    expect(details.ok).toBe(false);
    expect(String(details.error)).not.toContain(API_KEY);
    expect(String(details.error)).toContain("***REDACTED***");
  });
});
