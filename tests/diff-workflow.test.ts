import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDiffWorkflowTool } from "../src/tools/diff-workflow.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nWorkflow } from "../src/client.ts";

function workflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: "wf-1",
    name: "intel pipeline",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    nodes: [
      {
        id: "node-A",
        name: "Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        position: [0, 0],
        parameters: { rule: { interval: [{ field: "hours", hoursInterval: 1 }] } },
      },
      {
        id: "node-B",
        name: "HTTP",
        type: "n8n-nodes-base.httpRequest",
        position: [200, 0],
        parameters: {
          url: "https://example.test/v1/feed",
          method: "GET",
        },
      },
    ],
    connections: {
      Schedule: { main: [[{ node: "HTTP", type: "main", index: 0 }]] },
    },
    settings: { executionOrder: "v1" },
    ...overrides,
  };
}

async function run(
  tool: ReturnType<typeof createDiffWorkflowTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient, backupDir?: string) {
  return createDiffWorkflowTool({ getClient: () => client, backupDir });
}

describe("n8n_diff_workflow", () => {
  it("requires exactly one of snapshotPath or snapshot", async () => {
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(workflow()),
    });
    const tool = buildTool(client);

    const neither = await run(tool, { id: "wf-1" });
    expect(neither.ok).toBe(false);
    expect(neither.error).toMatch(/exactly one of/);

    const both = await run(tool, {
      id: "wf-1",
      snapshotPath: "/tmp/x.json",
      snapshot: { name: "x" },
    });
    expect(both.ok).toBe(false);
    expect(both.error).toMatch(/exactly one of/);
  });

  it("returns identical=true when current matches the snapshot exactly", async () => {
    const wf = workflow();
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: wf as unknown as Record<string, unknown> });
    expect(details.ok).toBe(true);
    expect(details.identical).toBe(true);
    const summary = details.summary as Record<string, unknown>;
    expect(summary.nodesAdded).toBe(0);
    expect(summary.nodesRemoved).toBe(0);
    expect(summary.nodesModified).toBe(0);
    expect(summary.nameChanged).toBe(false);
    expect(summary.connectionsChanged).toBe(false);
    expect(summary.settingsChanged).toBe(false);
  });

  it("detects an added node", async () => {
    const before = workflow();
    const after = workflow({
      nodes: [
        ...(before.nodes as Record<string, unknown>[]),
        {
          id: "node-C",
          name: "Set",
          type: "n8n-nodes-base.set",
          position: [400, 0],
          parameters: {},
        },
      ],
    });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: before as unknown as Record<string, unknown> });
    expect((details.summary as { nodesAdded: number }).nodesAdded).toBe(1);
    const added = (details.diff as { nodesAdded: Array<{ name: string }> }).nodesAdded;
    expect(added[0].name).toBe("Set");
  });

  it("detects a removed node", async () => {
    const before = workflow();
    const after = workflow({
      nodes: [(before.nodes as Record<string, unknown>[])[0]], // dropped HTTP
    });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: before as unknown as Record<string, unknown> });
    expect((details.summary as { nodesRemoved: number }).nodesRemoved).toBe(1);
    const removed = (details.diff as { nodesRemoved: Array<{ name: string }> }).nodesRemoved;
    expect(removed[0].name).toBe("HTTP");
  });

  it("detects a modified node and surfaces parameter sub-paths", async () => {
    const before = workflow();
    const afterNodes = JSON.parse(JSON.stringify(before.nodes));
    afterNodes[1].parameters.url = "https://example.test/v2/feed";
    afterNodes[1].parameters.method = "POST";
    const after = workflow({ nodes: afterNodes });

    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: before as unknown as Record<string, unknown> });
    expect((details.summary as { nodesModified: number }).nodesModified).toBe(1);
    const modified = (details.diff as {
      nodesModified: Array<{ name: string; fieldsChanged: string[] }>;
    }).nodesModified;
    expect(modified[0].name).toBe("HTTP");
    expect(modified[0].fieldsChanged.sort()).toEqual([
      "parameters.method",
      "parameters.url",
    ]);
  });

  it("ignores cosmetic position changes by default", async () => {
    const before = workflow();
    const afterNodes = JSON.parse(JSON.stringify(before.nodes));
    afterNodes[0].position = [42, 99];
    afterNodes[1].position = [600, 100];
    const after = workflow({ nodes: afterNodes });

    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: before as unknown as Record<string, unknown> });
    expect(details.identical).toBe(true);
    expect((details.summary as { nodesModified: number }).nodesModified).toBe(0);
  });

  it("surfaces position changes when ignoreCosmetic=false", async () => {
    const before = workflow();
    const afterNodes = JSON.parse(JSON.stringify(before.nodes));
    afterNodes[0].position = [42, 99];
    const after = workflow({ nodes: afterNodes });

    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, {
      id: "wf-1",
      snapshot: before as unknown as Record<string, unknown>,
      ignoreCosmetic: false,
    });
    const modified = (details.diff as {
      nodesModified: Array<{ fieldsChanged: string[] }>;
    }).nodesModified;
    expect(modified[0].fieldsChanged).toContain("position");
  });

  it("flags name and connection changes", async () => {
    const before = workflow();
    const after = workflow({
      name: "intel pipeline v2",
      connections: {
        Schedule: { main: [[{ node: "HTTP", type: "main", index: 1 }]] },
      },
    });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: before as unknown as Record<string, unknown> });
    expect((details.summary as { nameChanged: boolean }).nameChanged).toBe(true);
    expect((details.diff as { name: { before: string; after: string } | null }).name).toEqual({
      before: "intel pipeline",
      after: "intel pipeline v2",
    });
    expect((details.summary as { connectionsChanged: boolean }).connectionsChanged).toBe(true);
  });

  it("flags settings changes with the changed key list", async () => {
    const before = workflow();
    const after = workflow({
      settings: { executionOrder: "v0", timezone: "America/New_York" },
    });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: before as unknown as Record<string, unknown> });
    expect((details.summary as { settingsChanged: boolean }).settingsChanged).toBe(true);
    expect((details.diff as { settingsChangedKeys: string[] }).settingsChangedKeys.sort()).toEqual([
      "executionOrder",
      "timezone",
    ]);
  });

  it("normalizes the nested n8n_get_workflow(includeDefinition=true) snapshot shape", async () => {
    const before = workflow();
    // Snapshot in nested form: top-level metadata + `definition.{nodes, connections, settings}`.
    const nested: Record<string, unknown> = {
      id: "wf-1",
      name: "intel pipeline",
      active: true,
      definition: {
        nodes: before.nodes,
        connections: before.connections,
        settings: before.settings,
      },
    };
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(workflow()),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: nested });
    expect(details.ok).toBe(true);
    expect(details.identical).toBe(true);
  });

  it("matches nodes by name when ids are missing (legacy/hand-edited snapshots)", async () => {
    const before = workflow({
      nodes: [
        // No `id` field — older n8n exports / hand-built snapshots.
        {
          name: "HTTP",
          type: "n8n-nodes-base.httpRequest",
          position: [200, 0],
          parameters: { url: "https://example.test/v1/feed", method: "GET" },
        },
      ],
    });
    const after = workflow({
      nodes: [
        {
          // Now has an id but same name — should still match.
          id: "node-B-new-uuid",
          name: "HTTP",
          type: "n8n-nodes-base.httpRequest",
          position: [200, 0],
          parameters: { url: "https://example.test/v2/feed", method: "GET" },
        },
      ],
    });
    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, { id: "wf-1", snapshot: before as unknown as Record<string, unknown> });
    // Match by name → 1 modified, not 1 added + 1 removed.
    expect((details.summary as { nodesModified: number }).nodesModified).toBe(1);
    expect((details.summary as { nodesAdded: number }).nodesAdded).toBe(0);
    expect((details.summary as { nodesRemoved: number }).nodesRemoved).toBe(0);
  });

  it("caps nodesModified detail entries at maxModifiedDetails but keeps the counter accurate", async () => {
    const beforeNodes = Array.from({ length: 10 }, (_, i) => ({
      id: `n-${i}`,
      name: `node-${i}`,
      type: "n8n-nodes-base.set",
      position: [i * 100, 0],
      parameters: { value: `before-${i}` },
    }));
    const afterNodes = beforeNodes.map((n) => ({
      ...n,
      parameters: { value: `after-${n.id}` },
    }));
    const before = workflow({ nodes: beforeNodes, connections: {} });
    const after = workflow({ nodes: afterNodes, connections: {} });

    const client = makeFakeClient({
      getWorkflow: vi.fn().mockResolvedValue(after),
    });
    const tool = buildTool(client);

    const details = await run(tool, {
      id: "wf-1",
      snapshot: before as unknown as Record<string, unknown>,
      maxModifiedDetails: 3,
    });
    expect((details.summary as { nodesModified: number }).nodesModified).toBe(10);
    const modified = (details.diff as {
      nodesModified: unknown[];
      nodesModifiedTruncated: boolean;
    });
    expect(modified.nodesModified).toHaveLength(3);
    expect(modified.nodesModifiedTruncated).toBe(true);
  });

  describe("snapshotPath", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n8n-diff-test-"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("reads a snapshot from disk and runs the diff", async () => {
      const before = workflow();
      const file = path.join(tmpDir, "snap.json");
      await fs.writeFile(file, JSON.stringify(before));
      const client = makeFakeClient({
        getWorkflow: vi.fn().mockResolvedValue(workflow()),
      });
      const tool = buildTool(client, tmpDir);

      const details = await run(tool, { id: "wf-1", snapshotPath: file });
      expect(details.ok).toBe(true);
      expect(details.identical).toBe(true);
      expect(details.snapshotSource).toBe(file);
    });

    it("resolves a path relative to the configured backupDir", async () => {
      const before = workflow();
      await fs.writeFile(path.join(tmpDir, "rel.json"), JSON.stringify(before));
      const client = makeFakeClient({
        getWorkflow: vi.fn().mockResolvedValue(workflow()),
      });
      const tool = buildTool(client, tmpDir);

      const details = await run(tool, { id: "wf-1", snapshotPath: "rel.json" });
      expect(details.ok).toBe(true);
      expect(details.snapshotSource).toBe(path.join(tmpDir, "rel.json"));
    });

    it("rejects an absolute path outside the configured backupDir", async () => {
      const client = makeFakeClient({
        getWorkflow: vi.fn().mockResolvedValue(workflow()),
      });
      const getWorkflow = client.getWorkflow as ReturnType<typeof vi.fn>;
      const tool = buildTool(client, tmpDir);

      const details = await run(tool, { id: "wf-1", snapshotPath: "/etc/passwd" });
      expect(details.ok).toBe(false);
      expect(details.error).toMatch(/inside the configured backupDir/);
      // Confinement must fail closed before any workflow fetch or file read.
      expect(getWorkflow).not.toHaveBeenCalled();
    });

    it("rejects a relative path that traverses out of the backupDir", async () => {
      const client = makeFakeClient({
        getWorkflow: vi.fn().mockResolvedValue(workflow()),
      });
      const tool = buildTool(client, tmpDir);

      const details = await run(tool, {
        id: "wf-1",
        snapshotPath: "../../etc/passwd",
      });
      expect(details.ok).toBe(false);
      expect(details.error).toMatch(/inside the configured backupDir/);
    });

    it("returns ok=false when the snapshot file is missing", async () => {
      const missing = path.join(tmpDir, "does-not-exist.json");
      const client = makeFakeClient({
        getWorkflow: vi.fn().mockResolvedValue(workflow()),
      });
      const tool = buildTool(client, tmpDir);

      const details = await run(tool, { id: "wf-1", snapshotPath: missing });
      expect(details.ok).toBe(false);
      expect(details.error).toMatch(/failed to read snapshot file/);
    });

    it("returns ok=false when the snapshot file is invalid JSON", async () => {
      const file = path.join(tmpDir, "bad.json");
      await fs.writeFile(file, "not-json{");
      const client = makeFakeClient({
        getWorkflow: vi.fn().mockResolvedValue(workflow()),
      });
      const tool = buildTool(client, tmpDir);

      const details = await run(tool, { id: "wf-1", snapshotPath: file });
      expect(details.ok).toBe(false);
      expect(details.error).toMatch(/failed to read snapshot file/);
    });
  });
});
