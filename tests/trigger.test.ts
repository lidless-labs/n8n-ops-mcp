import { describe, it, expect, vi } from "vitest";
import { createTriggerTool } from "../src/tools/trigger.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nWorkflow } from "../src/client.ts";

function workflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: "wf-1",
    name: "my-flow",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    nodes: [
      {
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        parameters: {},
      },
    ],
    connections: {},
    ...overrides,
  };
}

async function run(
  tool: ReturnType<typeof createTriggerTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as { details: Record<string, unknown> };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createTriggerTool(() => client);
}

describe("n8n_trigger mode='workflow'", () => {
  it("surfaces a 'switch to webhook' hint when /execute returns 405", async () => {
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(workflow()),
      executeWorkflow: vi
        .fn()
        .mockRejectedValue(new Error("n8n 405 on /api/v1/workflows/wf-1/execute: Method not allowed")),
    });
    const tool = buildTool(client);

    const details = await run(tool, { mode: "workflow", workflowId: "wf-1" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/use mode='webhook'/);
  });

  it("surfaces the same hint on 404 (endpoint missing entirely)", async () => {
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(workflow()),
      executeWorkflow: vi
        .fn()
        .mockRejectedValue(new Error("n8n 404 on /api/v1/workflows/wf-1/execute: Not found")),
    });
    const tool = buildTool(client);

    const details = await run(tool, { mode: "workflow", workflowId: "wf-1" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/use mode='webhook'/);
  });

  it("does NOT add the hint on a 500 (different failure class)", async () => {
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(workflow()),
      executeWorkflow: vi
        .fn()
        .mockRejectedValue(new Error("n8n 500 on /api/v1/workflows/wf-1/execute: internal")),
    });
    const tool = buildTool(client);

    const details = await run(tool, { mode: "workflow", workflowId: "wf-1" });

    expect(details.ok).toBe(false);
    expect(details.error).not.toMatch(/use mode='webhook'/);
  });

  it("refuses to call /execute on an inactive workflow", async () => {
    const executeWorkflow = vi.fn();
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(workflow({ active: false })),
      executeWorkflow,
    });
    const tool = buildTool(client);

    const details = await run(tool, { mode: "workflow", workflowId: "wf-1" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/not active/i);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it("refuses on a non-allowlisted trigger type", async () => {
    const executeWorkflow = vi.fn();
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(
        workflow({
          nodes: [
            {
              name: "Cron",
              type: "n8n-nodes-base.scheduleTrigger",
              parameters: {},
            },
          ],
        }),
      ),
      executeWorkflow,
    });
    const tool = buildTool(client);

    const details = await run(tool, { mode: "workflow", workflowId: "wf-1" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/not supported for external triggering/);
    expect(details.triggerNodeType).toBe("n8n-nodes-base.scheduleTrigger");
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it("refuses when no trigger node exists", async () => {
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(
        workflow({
          nodes: [
            {
              name: "Set",
              type: "n8n-nodes-base.set",
              parameters: {},
            },
          ],
        }),
      ),
    });
    const tool = buildTool(client);

    const details = await run(tool, { mode: "workflow", workflowId: "wf-1" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/no recognizable trigger/i);
  });
});

describe("n8n_trigger mode='webhook'", () => {
  it("requires webhookPath", async () => {
    const postWebhook = vi.fn();
    const client = makeFakeClient({ postWebhook });
    const tool = buildTool(client);

    const details = await run(tool, { mode: "webhook" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/webhookPath is required/);
    expect(postWebhook).not.toHaveBeenCalled();
  });

  it("maps a 2xx response to ok:true and surfaces the body", async () => {
    const client = makeFakeClient({
      postWebhook: vi.fn().mockResolvedValue({
        status: 200,
        body: { triggered: true },
      }),
    });
    const tool = buildTool(client);

    const details = await run(tool, {
      mode: "webhook",
      webhookPath: "/webhook/intel",
      payload: { topic: "hn" },
    });

    expect(details.ok).toBe(true);
    expect(details.mode).toBe("webhook");
    expect(details.status).toBe(200);
    expect(details.response).toEqual({ triggered: true });
    expect(client.postWebhook).toHaveBeenCalledWith(
      "/webhook/intel",
      { topic: "hn" },
      { method: undefined },
    );
  });

  it("maps a 4xx response to ok:false without throwing", async () => {
    const client = makeFakeClient({
      postWebhook: vi.fn().mockResolvedValue({
        status: 404,
        body: { message: "not registered" },
      }),
    });
    const tool = buildTool(client);

    const details = await run(tool, {
      mode: "webhook",
      webhookPath: "/webhook/gone",
    });

    expect(details.ok).toBe(false);
    expect(details.status).toBe(404);
  });
});
