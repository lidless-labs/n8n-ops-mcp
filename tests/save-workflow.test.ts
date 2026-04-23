import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSaveWorkflowTool } from "../src/tools/save-workflow.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nWorkflow } from "../src/client.ts";

function baseWorkflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: "wf-42",
    name: "my-workflow",
    active: false,
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
    settings: {},
    ...overrides,
  };
}

function buildTool(client: N8nClient, backupDir: string) {
  return createSaveWorkflowTool({ getClient: () => client, backupDir });
}

async function run(
  tool: ReturnType<typeof createSaveWorkflowTool>,
  params: Record<string, unknown>,
): Promise<{
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}> {
  // execute's first arg is toolCallId (unused) and the result is already shaped
  // as { content, details } by jsonToolResult.
  return (await tool.execute("call-1", params)) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  };
}

describe("n8n_save_workflow", () => {
  let backupDir: string;

  beforeEach(async () => {
    backupDir = await fs.mkdtemp(path.join(tmpdir(), "n8n-save-test-"));
  });

  afterEach(async () => {
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it("refuses without confirm and never touches the client", async () => {
    const client = makeFakeClient();
    const tool = buildTool(client, backupDir);

    const res = await run(tool, {
      id: "wf-42",
      definition: { nodes: [], connections: {} },
      // confirm omitted
    });

    expect(res.details.ok).toBe(false);
    expect(res.details.error).toMatch(/confirm/i);
    expect(client.getWorkflow).not.toHaveBeenCalled();
    expect(client.saveWorkflow).not.toHaveBeenCalled();

    const files = await fs.readdir(backupDir);
    expect(files).toEqual([]);
  });

  it("writes a backup BEFORE attempting the save", async () => {
    const current = baseWorkflow();
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(current),
      saveWorkflow: vi.fn().mockResolvedValue({ ...current, updatedAt: "now" }),
    });
    const tool = buildTool(client, backupDir);

    const res = await run(tool, {
      id: "wf-42",
      definition: {
        nodes: [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: {},
          },
          {
            name: "Edit",
            type: "n8n-nodes-base.set",
            parameters: {},
          },
        ],
        connections: {},
      },
      confirm: true,
    });

    expect(res.details.ok).toBe(true);
    expect(res.details.backupPath).toMatch(/wf-42-.+\.json$/);
    expect(res.details.restoreHint).toContain(String(res.details.backupPath));

    const files = await fs.readdir(backupDir);
    expect(files).toHaveLength(1);

    const backupContent = JSON.parse(
      await fs.readFile(path.join(backupDir, files[0]), "utf8"),
    );
    expect(backupContent.id).toBe("wf-42");
    expect(backupContent.name).toBe("my-workflow");

    // mode 0o600 — only owner read/write
    const stat = await fs.stat(path.join(backupDir, files[0]));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("aborts on validation errors and still writes the backup", async () => {
    const current = baseWorkflow();
    const saveWorkflow = vi.fn();
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(current),
      saveWorkflow,
    });
    const tool = buildTool(client, backupDir);

    // An orphan node with no trigger is an error-severity issue per
    // validateWorkflow (missing-trigger).
    const res = await run(tool, {
      id: "wf-42",
      definition: {
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

    expect(res.details.ok).toBe(false);
    expect(res.details.error).toMatch(/validation failed/i);
    expect(res.details.backupPath).toBeDefined();
    expect(Array.isArray(res.details.issues)).toBe(true);
    expect(saveWorkflow).not.toHaveBeenCalled();

    // backup was still written
    const files = await fs.readdir(backupDir);
    expect(files).toHaveLength(1);
  });

  it("skipValidation=true bypasses the validation gate", async () => {
    const current = baseWorkflow();
    const saveWorkflow = vi
      .fn()
      .mockResolvedValue({ ...current, updatedAt: "now" });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(current),
      saveWorkflow,
    });
    const tool = buildTool(client, backupDir);

    const res = await run(tool, {
      id: "wf-42",
      // intentionally a no-trigger proposal that would fail validation
      definition: {
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
      skipValidation: true,
    });

    expect(res.details.ok).toBe(true);
    expect(saveWorkflow).toHaveBeenCalledTimes(1);
  });

  it("preserves the backup path when the save call throws", async () => {
    const current = baseWorkflow();
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(current),
      saveWorkflow: vi.fn().mockRejectedValue(new Error("n8n 500 on PUT")),
    });
    const tool = buildTool(client, backupDir);

    const res = await run(tool, {
      id: "wf-42",
      definition: {
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

    expect(res.details.ok).toBe(false);
    expect(res.details.error).toMatch(/save failed/);
    expect(res.details.backupPath).toBeDefined();
    expect(res.details.restoreHint).toContain(String(res.details.backupPath));

    const files = await fs.readdir(backupDir);
    expect(files).toHaveLength(1);
  });

  it("only passes editable fields through to saveWorkflow (no read-only fields)", async () => {
    const current = baseWorkflow({
      staticData: { counter: 7 },
      settings: { executionTimeout: 30 },
    });
    const saveWorkflow = vi
      .fn()
      .mockResolvedValue({ ...current, updatedAt: "now" });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(current),
      saveWorkflow,
    });
    const tool = buildTool(client, backupDir);

    await run(tool, {
      id: "wf-42",
      // Send a "read-only" field and common extras that n8n would 400 on
      definition: {
        name: "renamed",
        nodes: current.nodes,
        connections: {},
        active: true, // should NOT be passed through
        id: "malicious",
        createdAt: "2020-01-01",
        versionId: "spoofed",
      },
      confirm: true,
    });

    expect(saveWorkflow).toHaveBeenCalledTimes(1);
    const [, body] = saveWorkflow.mock.calls[0];
    expect(Object.keys(body).sort()).toEqual(
      ["connections", "name", "nodes", "settings", "staticData"].sort(),
    );
    expect(body.name).toBe("renamed");
    expect(body.staticData).toEqual({ counter: 7 });
  });
});
