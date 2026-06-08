import { describe, it, expect, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createCreateWorkflowTool } from "../src/tools/create-workflow.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nWorkflow } from "../src/client.ts";

function baseCreated(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: "wf-new-1",
    name: "restored-workflow",
    active: false,
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
    nodes: [
      {
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        parameters: {},
      },
    ],
    connections: {},
    settings: {},
    ...overrides,
  };
}

function buildTool(client: N8nClient) {
  return createCreateWorkflowTool({ getClient: () => client });
}

async function run(
  tool: ReturnType<typeof createCreateWorkflowTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

describe("n8n_create_workflow", () => {
  it("POSTs a cleaned body and returns the new workflow's id + inactive hint", async () => {
    const created = baseCreated();
    const createWorkflow = vi.fn().mockResolvedValue(created);
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      definition: {
        name: "restored-workflow",
        nodes: [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: {},
          },
        ],
        connections: {},
      },
      confirm: true,
    });

    expect(details).toMatchObject({
      ok: true,
      action: "create",
      workflowId: "wf-new-1",
      workflowName: "restored-workflow",
      active: false,
    });
    expect(String(details.hint)).toMatch(/inactive/i);
    expect(createWorkflow).toHaveBeenCalledTimes(1);
  });

  it("strips read-only fields before POSTing (accepts n8n_get_workflow output directly)", async () => {
    const created = baseCreated();
    const createWorkflow = vi.fn().mockResolvedValue(created);
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    // Simulate the shape of a backup file written by n8n_delete_workflow.
    await run(tool, {
      definition: {
        // read-only fields that n8n will 400 on if we forward them
        id: "wf-42",
        active: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        isArchived: false,
        versionId: "abc-123",
        triggerCount: 1,
        tags: [{ id: "t1", name: "prod" }],
        shared: [{ role: "owner" }],
        meta: { templateId: "x" },
        pinData: { Webhook: [] },
        // editable fields that must pass through
        name: "restored-workflow",
        nodes: [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: {},
          },
        ],
        connections: {},
        settings: { executionTimeout: 30 },
        staticData: { counter: 7 },
      },
      confirm: true,
    });

    expect(createWorkflow).toHaveBeenCalledTimes(1);
    const [body] = createWorkflow.mock.calls[0] as [Record<string, unknown>];

    // ALL read-only fields stripped
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("active");
    expect(body).not.toHaveProperty("createdAt");
    expect(body).not.toHaveProperty("updatedAt");
    expect(body).not.toHaveProperty("isArchived");
    expect(body).not.toHaveProperty("versionId");
    expect(body).not.toHaveProperty("triggerCount");
    expect(body).not.toHaveProperty("tags");
    expect(body).not.toHaveProperty("shared");
    expect(body).not.toHaveProperty("meta");
    expect(body).not.toHaveProperty("pinData");

    // Editable fields preserved
    expect(body.name).toBe("restored-workflow");
    expect(body.settings).toEqual({ executionTimeout: 30 });
    expect(body.staticData).toEqual({ counter: 7 });
    expect((body.nodes as unknown[])).toHaveLength(1);
  });

  it("accepts the nested n8n_get_workflow(includeDefinition=true) shape and flattens it", async () => {
    const created = baseCreated();
    const createWorkflow = vi.fn().mockResolvedValue(created);
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    // Matches what n8n_get_workflow emits: flat metadata + nested `definition`,
    // including settings: null (which n8n would 400 on) and staticData: null.
    await run(tool, {
      definition: {
        id: "wf-42",
        name: "cloned-workflow",
        active: true,
        archived: false,
        tags: ["prod"],
        versionId: "abc-123",
        nodeCount: 1,
        nodeTypes: { "n8n-nodes-base.webhook": 1 },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        definition: {
          nodes: [
            {
              name: "Webhook",
              type: "n8n-nodes-base.webhook",
              parameters: {},
            },
          ],
          connections: {},
          settings: null,
          staticData: null,
          pinData: null,
        },
      },
      confirm: true,
    });

    expect(createWorkflow).toHaveBeenCalledTimes(1);
    const [body] = createWorkflow.mock.calls[0] as [Record<string, unknown>];

    // Top-level `definition` key must not leak through (n8n rejects unknown fields).
    expect(body).not.toHaveProperty("definition");
    // Read-only fields stripped (including `tags` which is flat in this shape).
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("tags");
    expect(body).not.toHaveProperty("archived");

    // Nested graph data flattened into the POST body.
    expect((body.nodes as unknown[])).toHaveLength(1);
    expect(body.name).toBe("cloned-workflow");
    // settings: null normalized to {}
    expect(body.settings).toEqual({});
    // staticData: null is dropped (not passed as null)
    expect(body).not.toHaveProperty("staticData");
  });

  it("defaults settings to {} when caller omits it (n8n requires the field)", async () => {
    const created = baseCreated();
    const createWorkflow = vi.fn().mockResolvedValue(created);
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    await run(tool, {
      definition: {
        name: "no-settings-workflow",
        nodes: [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: {},
          },
        ],
        connections: {},
        // settings omitted
      },
      confirm: true,
    });

    const [body] = createWorkflow.mock.calls[0] as [Record<string, unknown>];
    expect(body.settings).toEqual({});
  });

  it("aborts on validation errors without touching the client", async () => {
    const createWorkflow = vi.fn();
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    // An orphan non-trigger node is a validation error.
    const details = await run(tool, {
      definition: {
        name: "broken",
        nodes: [
          {
            name: "Lonely Set",
            type: "n8n-nodes-base.set",
            parameters: {},
          },
        ],
        connections: {},
      },
      confirm: true,
    });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/validation failed/i);
    expect(Array.isArray(details.issues)).toBe(true);
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("skipValidation=true bypasses the validation gate", async () => {
    const created = baseCreated();
    const createWorkflow = vi.fn().mockResolvedValue(created);
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      definition: {
        name: "broken-but-skipped",
        nodes: [
          {
            name: "Lonely Set",
            type: "n8n-nodes-base.set",
            parameters: {},
          },
        ],
        connections: {},
      },
      skipValidation: true,
      confirm: true,
    });

    expect(details.ok).toBe(true);
    expect(createWorkflow).toHaveBeenCalledTimes(1);
  });

  it("the TypeBox parameter schema accepts the nested n8n_get_workflow shape with null settings (round-2 regression lock)", () => {
    const client = makeFakeClient({
      createWorkflow: vi.fn().mockResolvedValue(baseCreated()),
    });
    const tool = buildTool(client);
    const schema = tool.parameters;

    // This payload mirrors exactly what `n8n_get_workflow(includeDefinition=true)`
    // emits when a workflow has no explicit settings: nested definition + null
    // for settings/staticData/pinData. The MCP parameter schema MUST accept it
    // before buildCreateBody has a chance to normalize — otherwise the direct
    // forward path documented in the tool description would 400 at the schema
    // layer before runtime sees the payload.
    const payload = {
      definition: {
        id: "wf-42",
        name: "cloned",
        active: true,
        archived: false,
        tags: ["prod"],
        definition: {
          nodes: [
            {
              name: "Webhook",
              type: "n8n-nodes-base.webhook",
              parameters: {},
            },
          ],
          connections: {},
          settings: null,
          staticData: null,
          pinData: null,
        },
      },
    };

    expect(Value.Check(schema, payload)).toBe(true);
    const errors = [...Value.Errors(schema, payload)];
    expect(errors).toEqual([]);
  });

  it("the TypeBox parameter schema accepts the flat snapshot shape with null settings", () => {
    const client = makeFakeClient({
      createWorkflow: vi.fn().mockResolvedValue(baseCreated()),
    });
    const tool = buildTool(client);
    const schema = tool.parameters;

    const payload = {
      definition: {
        id: "wf-42",
        name: "restored",
        nodes: [],
        connections: {},
        settings: null,
      },
    };

    expect(Value.Check(schema, payload)).toBe(true);
  });

  it("surfaces upstream errors with the redacted message", async () => {
    const createWorkflow = vi
      .fn()
      .mockRejectedValue(new Error("n8n 400 on POST: additionalProperties"));
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      definition: {
        name: "valid-workflow",
        nodes: [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: {},
          },
        ],
        connections: {},
      },
      confirm: true,
    });

    expect(details.ok).toBe(false);
    expect(String(details.error)).toMatch(/create failed/);
    expect(String(details.error)).toMatch(/additionalProperties/);
  });

  it("refuses to write without confirm=true (and without dryRun)", async () => {
    const createWorkflow = vi.fn();
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      definition: {
        name: "needs-confirm",
        nodes: [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: {},
          },
        ],
        connections: {},
      },
    });

    expect(details.ok).toBe(false);
    expect(String(details.error)).toMatch(/confirm must be true/);
    expect(createWorkflow).not.toHaveBeenCalled();
  });
});

describe("n8n_create_workflow targets and dry-run", () => {
  it("supports dryRun=true without touching the client", async () => {
    const createWorkflow = vi.fn();
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      definition: {
        name: "dry run workflow",
        nodes: [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: {},
          },
        ],
        connections: {},
      },
      projectId: "proj-1",
      folderId: "folder-1",
      dryRun: true,
    });

    expect(details.ok).toBe(true);
    expect(details.dryRun).toBe(true);
    expect(details.wouldWrite).toBe(false);
    expect(details.target).toEqual({ projectId: "proj-1", folderId: "folder-1" });
    expect(details.body).toMatchObject({ name: "dry run workflow", settings: {} });
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("passes projectId and folderId through to the client create call", async () => {
    const created = baseCreated();
    const createWorkflow = vi.fn().mockResolvedValue(created);
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      definition: {
        name: "targeted workflow",
        nodes: [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: {},
          },
        ],
        connections: {},
      },
      projectId: "proj-1",
      folderId: "folder-1",
      confirm: true,
    });

    expect(details.ok).toBe(true);
    expect(details.target).toEqual({ projectId: "proj-1", folderId: "folder-1" });
    expect(createWorkflow).toHaveBeenCalledTimes(1);
    expect(createWorkflow.mock.calls[0][1]).toEqual({
      projectId: "proj-1",
      folderId: "folder-1",
    });
  });

  it("dryRun=true returns the cleaned body even when validation would block", async () => {
    const createWorkflow = vi.fn();
    const client = makeFakeClient({ createWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, {
      definition: {
        name: "broken dry run",
        nodes: [
          {
            name: "Lonely Set",
            type: "n8n-nodes-base.set",
            parameters: {},
          },
        ],
        connections: {},
      },
      dryRun: true,
    });

    expect(details.ok).toBe(false);
    expect(details.dryRun).toBe(true);
    expect(details.body).toMatchObject({ name: "broken dry run" });
    expect(String(details.hint)).toMatch(/Validation errors/);
    expect(createWorkflow).not.toHaveBeenCalled();
  });
});
