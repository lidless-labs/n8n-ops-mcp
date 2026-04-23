import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeleteWorkflowTool } from "../src/tools/delete-workflow.ts";
import { makeFakeClient } from "./helpers.ts";
import { N8nApiError, type N8nClient, type N8nWorkflow } from "../src/client.ts";

function baseWorkflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: "wf-42",
    name: "my-workflow",
    active: false,
    createdAt: "2026-01-01T00:00:00.000Z",
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

function buildTool(client: N8nClient, backupDir: string) {
  return createDeleteWorkflowTool({ getClient: () => client, backupDir });
}

async function run(
  tool: ReturnType<typeof createDeleteWorkflowTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as { details: Record<string, unknown> };
  return res.details;
}

describe("n8n_delete_workflow", () => {
  let backupDir: string;

  beforeEach(async () => {
    backupDir = await fs.mkdtemp(path.join(tmpdir(), "n8n-delete-test-"));
  });

  afterEach(async () => {
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it("refuses without confirm=true and never touches the client", async () => {
    const client = makeFakeClient();
    const tool = buildTool(client, backupDir);

    const details = await run(tool, { id: "wf-42" });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/confirm/i);
    expect(details.workflowId).toBe("wf-42");
    expect(client.getWorkflow).not.toHaveBeenCalled();
    expect(client.deleteWorkflow).not.toHaveBeenCalled();

    const files = await fs.readdir(backupDir);
    expect(files).toEqual([]);
  });

  it("refuses with confirm:false and never touches the client", async () => {
    const client = makeFakeClient();
    const tool = buildTool(client, backupDir);

    const details = await run(tool, { id: "wf-42", confirm: false });

    expect(details.ok).toBe(false);
    expect(client.getWorkflow).not.toHaveBeenCalled();
    expect(client.deleteWorkflow).not.toHaveBeenCalled();
  });

  it("writes a DELETED-tagged snapshot BEFORE firing the DELETE", async () => {
    const current = baseWorkflow();
    const getWorkflow = vi.fn().mockResolvedValue(current);
    // The deleteWorkflow mock reads backupDir when it is called; this locks in
    // the invariant that the snapshot is flushed to disk before the DELETE
    // hits the network, not just sequenced in JS promise order.
    let snapshotExistsAtDeleteTime = false;
    let filesAtDeleteTime: string[] = [];
    const deleteWorkflow = vi.fn().mockImplementation(async () => {
      filesAtDeleteTime = await fs.readdir(backupDir);
      snapshotExistsAtDeleteTime = filesAtDeleteTime.some((f) =>
        /wf-42-DELETED-.+\.json$/.test(f),
      );
      return current;
    });
    const client = makeFakeClient({ getWorkflow, deleteWorkflow });
    const tool = buildTool(client, backupDir);

    const details = await run(tool, { id: "wf-42", confirm: true });

    expect(snapshotExistsAtDeleteTime).toBe(true);
    expect(filesAtDeleteTime).toHaveLength(1);

    expect(details.ok).toBe(true);
    expect(details.action).toBe("delete");
    expect(details.backupPath).toMatch(/wf-42-DELETED-.+\.json$/);
    expect(String(details.restoreHint)).toContain(String(details.backupPath));
    expect(String(details.restoreHint)).toMatch(/n8n_create_workflow/);

    const files = await fs.readdir(backupDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/wf-42-DELETED-.+\.json$/);

    const backupContent = JSON.parse(
      await fs.readFile(path.join(backupDir, files[0]), "utf8"),
    );
    expect(backupContent.id).toBe("wf-42");
    expect(backupContent.nodes).toEqual(current.nodes);

    const stat = await fs.stat(path.join(backupDir, files[0]));
    expect(stat.mode & 0o777).toBe(0o600);

    // Ordering: getWorkflow → deleteWorkflow. Both called exactly once.
    expect(getWorkflow).toHaveBeenCalledTimes(1);
    expect(deleteWorkflow).toHaveBeenCalledTimes(1);
    expect(deleteWorkflow).toHaveBeenCalledWith("wf-42");
  });

  it("returns ok:false with reason=not_found when the workflow is already gone (pre-snapshot 404)", async () => {
    const getWorkflow = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(404, "/api/v1/workflows/ghost", "not found"),
      );
    const deleteWorkflow = vi.fn();
    const client = makeFakeClient({ getWorkflow, deleteWorkflow });
    const tool = buildTool(client, backupDir);

    const details = await run(tool, { id: "ghost", confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_found");
    expect(deleteWorkflow).not.toHaveBeenCalled();

    const files = await fs.readdir(backupDir);
    expect(files).toEqual([]);
  });

  it("returns ok:false with reason=not_found (plus the snapshot) if the workflow disappears between snapshot and delete", async () => {
    const current = baseWorkflow();
    const getWorkflow = vi.fn().mockResolvedValue(current);
    const deleteWorkflow = vi
      .fn()
      .mockRejectedValue(
        new N8nApiError(404, "/api/v1/workflows/wf-42", "not found"),
      );
    const client = makeFakeClient({ getWorkflow, deleteWorkflow });
    const tool = buildTool(client, backupDir);

    const details = await run(tool, { id: "wf-42", confirm: true });

    expect(details.ok).toBe(false);
    expect(details.reason).toBe("not_found");
    expect(details.backupPath).toMatch(/wf-42-DELETED-.+\.json$/);

    const files = await fs.readdir(backupDir);
    expect(files).toHaveLength(1);
  });

  it("preserves the backup path when the DELETE fails upstream", async () => {
    const current = baseWorkflow();
    const getWorkflow = vi.fn().mockResolvedValue(current);
    const deleteWorkflow = vi
      .fn()
      .mockRejectedValue(new Error("n8n 500 on DELETE"));
    const client = makeFakeClient({ getWorkflow, deleteWorkflow });
    const tool = buildTool(client, backupDir);

    const details = await run(tool, { id: "wf-42", confirm: true });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/delete failed/);
    expect(details.backupPath).toBeDefined();
    expect(String(details.hint)).toContain(String(details.backupPath));

    const files = await fs.readdir(backupDir);
    expect(files).toHaveLength(1);
  });

  it("aborts before DELETE if the backup write fails", async () => {
    // Point backupDir at a path that cannot be created (file-at-parent).
    const blockingFile = path.join(backupDir, "blocker");
    await fs.writeFile(blockingFile, "not-a-dir");
    const poisonedBackupDir = path.join(blockingFile, "nested");

    const current = baseWorkflow();
    const getWorkflow = vi.fn().mockResolvedValue(current);
    const deleteWorkflow = vi.fn();
    const client = makeFakeClient({ getWorkflow, deleteWorkflow });
    const tool = createDeleteWorkflowTool({
      getClient: () => client,
      backupDir: poisonedBackupDir,
    });

    const details = await run(tool, { id: "wf-42", confirm: true });

    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/backup failed; delete aborted/);
    expect(deleteWorkflow).not.toHaveBeenCalled();
  });
});
