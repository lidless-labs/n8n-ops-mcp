import { describe, it, expect, vi } from "vitest";
import { createFindWorkflowsUsingNodeTypeTool } from "../src/tools/find-workflows-using-node-type.ts";
import { makeFakeClient } from "./helpers.ts";
import type {
  N8nClient,
  N8nWorkflow,
  N8nWorkflowSummary,
} from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createFindWorkflowsUsingNodeTypeTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createFindWorkflowsUsingNodeTypeTool(() => client);
}

function summary(id: string, archived = false): N8nWorkflowSummary {
  return {
    id,
    name: `Workflow ${id}`,
    active: true,
    isArchived: archived,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

function workflow(
  id: string,
  nodes: Array<{ type: string; name: string; id?: string; disabled?: boolean }>,
): N8nWorkflow {
  return {
    id,
    name: `Workflow ${id}`,
    active: true,
    isArchived: false,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    nodes,
    connections: {},
  };
}

describe("n8n_find_workflows_using_node_type", () => {
  it("emits one finding per matching node and per-workflow summary rows", async () => {
    const listWorkflows = vi
      .fn()
      .mockResolvedValueOnce({ data: [summary("1"), summary("2")] });
    const getWorkflow = vi
      .fn()
      .mockResolvedValueOnce(
        workflow("1", [
          { type: "n8n-nodes-base.slack", name: "Slack 1" },
          { type: "n8n-nodes-base.slack", name: "Slack 2" },
          { type: "n8n-nodes-base.set", name: "Set" },
        ]),
      )
      .mockResolvedValueOnce(
        workflow("2", [
          { type: "n8n-nodes-base.httpRequest", name: "HTTP" },
        ]),
      );
    const client = makeFakeClient({ listWorkflows, getWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, { nodeType: "n8n-nodes-base.slack" });

    expect(details).toMatchObject({
      target: "n8n-nodes-base.slack",
      match: "exact",
      scannedWorkflows: 2,
      findingCount: 2,
      workflowsWithMatches: 1,
    });
    const findings = details.findings as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      workflowId: "1",
      nodeType: "n8n-nodes-base.slack",
    });
  });

  it("'contains' match is case-insensitive substring", async () => {
    const listWorkflows = vi
      .fn()
      .mockResolvedValueOnce({ data: [summary("1")] });
    const getWorkflow = vi.fn().mockResolvedValueOnce(
      workflow("1", [
        { type: "@n8n/n8n-nodes-langchain.slackTrigger", name: "Slack LC" },
        { type: "n8n-nodes-base.set", name: "Set" },
      ]),
    );
    const client = makeFakeClient({ listWorkflows, getWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      nodeType: "Slack",
      match: "contains",
    });

    expect(details.findingCount).toBe(1);
  });

  it("excludes archived workflows by default and includes them when requested", async () => {
    const listWorkflows = vi.fn().mockResolvedValueOnce({
      data: [summary("1"), summary("2", true)],
    });
    const getWorkflow = vi
      .fn()
      .mockResolvedValueOnce(workflow("1", [{ type: "x", name: "X" }]));
    const client = makeFakeClient({ listWorkflows, getWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, { nodeType: "x" });
    expect(details.scannedWorkflows).toBe(1);

    listWorkflows.mockResolvedValueOnce({
      data: [summary("1"), summary("2", true)],
    });
    getWorkflow
      .mockResolvedValueOnce(workflow("1", [{ type: "x", name: "X" }]))
      .mockResolvedValueOnce(workflow("2", [{ type: "x", name: "X2" }]));

    const all = await run(tool, { nodeType: "x", includeArchived: true });
    expect(all.scannedWorkflows).toBe(2);
  });

  it("excludes disabled nodes when includeDisabledNodes:false", async () => {
    const listWorkflows = vi
      .fn()
      .mockResolvedValueOnce({ data: [summary("1")] });
    const getWorkflow = vi.fn().mockResolvedValueOnce(
      workflow("1", [
        { type: "n8n-nodes-base.slack", name: "Live" },
        { type: "n8n-nodes-base.slack", name: "Disabled", disabled: true },
      ]),
    );
    const client = makeFakeClient({ listWorkflows, getWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      nodeType: "n8n-nodes-base.slack",
      includeDisabledNodes: false,
    });

    expect(details.findingCount).toBe(1);
    const findings = details.findings as Array<Record<string, unknown>>;
    expect(findings[0].nodeName).toBe("Live");
  });

  it("rejects empty-after-trim nodeType (defensive — MCP schema also rejects)", async () => {
    const listWorkflows = vi.fn();
    const getWorkflow = vi.fn();
    const client = makeFakeClient({ listWorkflows, getWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, { nodeType: "   " });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("empty_node_type");
    expect(listWorkflows).not.toHaveBeenCalled();
    expect(getWorkflow).not.toHaveBeenCalled();
  });

  it("captures per-workflow fetch errors without failing the scan", async () => {
    const listWorkflows = vi
      .fn()
      .mockResolvedValueOnce({ data: [summary("1"), summary("2")] });
    const getWorkflow = vi
      .fn()
      .mockResolvedValueOnce(workflow("1", [{ type: "x", name: "X" }]))
      .mockRejectedValueOnce(new Error("fetch failed for 2"));
    const client = makeFakeClient({ listWorkflows, getWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, { nodeType: "x" });

    expect(details.scannedWorkflows).toBe(1);
    const errs = details.fetchErrors as Array<Record<string, unknown>>;
    expect(errs).toHaveLength(1);
    expect(errs[0].workflowId).toBe("2");
  });
});
