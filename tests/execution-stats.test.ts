import { describe, it, expect, vi } from "vitest";
import { createExecutionStatsTool } from "../src/tools/execution-stats.ts";
import { makeFakeClient } from "./helpers.ts";
import type {
  N8nClient,
  N8nExecutionSummary,
  N8nWorkflowSummary,
} from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createExecutionStatsTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createExecutionStatsTool(() => client);
}

function ex(
  id: string,
  workflowId: string,
  status: string,
  startedAt: string,
  durationMs: number,
): N8nExecutionSummary {
  const start = new Date(startedAt);
  return {
    id,
    finished: status !== "running" && status !== "waiting",
    mode: "trigger",
    status: status as N8nExecutionSummary["status"],
    workflowId,
    startedAt,
    stoppedAt: new Date(start.getTime() + durationMs).toISOString(),
  };
}

function wfSummary(id: string, name: string): N8nWorkflowSummary {
  return {
    id,
    name,
    active: true,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

describe("n8n_execution_stats", () => {
  it("aggregates per-workflow counts, failure rate, and runtime stats", async () => {
    const now = Date.now();
    const recent = (m: number) =>
      new Date(now - m * 60_000).toISOString();
    const data: N8nExecutionSummary[] = [
      ex("1", "wf-a", "success", recent(10), 1_000),
      ex("2", "wf-a", "success", recent(20), 2_000),
      ex("3", "wf-a", "error", recent(30), 500),
      ex("4", "wf-b", "success", recent(15), 5_000),
    ];
    const listExecutions = vi.fn().mockResolvedValueOnce({ data });
    const listWorkflows = vi.fn().mockResolvedValueOnce({
      data: [wfSummary("wf-a", "A"), wfSummary("wf-b", "B")],
    });
    const client = makeFakeClient({ listExecutions, listWorkflows });
    const tool = buildTool(client);

    const details = await run(tool, { sinceHours: 24 });

    expect(details.scannedExecutions).toBe(4);
    expect(details.workflowCount).toBe(2);
    const perWf = details.perWorkflow as Array<Record<string, unknown>>;
    const a = perWf.find((p) => p.workflowId === "wf-a");
    expect(a).toMatchObject({
      total: 3,
      success: 2,
      error: 1,
      workflowName: "A",
    });
    expect(a!.failureRate).toBeCloseTo(1 / 3, 4);
    expect(a!.avgRuntimeMs).toBeGreaterThan(0);
  });

  it("does NOT abort mid-page when an old execution sits between recent ones (n8n sort is not contractually newest-first)", async () => {
    const now = Date.now();
    const recentIso = new Date(now - 5 * 60_000).toISOString();
    const oldIso = new Date(now - 48 * 60 * 60_000).toISOString();
    // Two recent rows around an old row in the same page. Older fix would
    // have stopped at row 2 and silently dropped row 3.
    const listExecutions = vi.fn().mockResolvedValueOnce({
      data: [
        ex("1", "wf-a", "success", recentIso, 1_000),
        ex("99", "wf-a", "success", oldIso, 1_000),
        ex("3", "wf-a", "success", recentIso, 1_000),
      ],
    });
    const listWorkflows = vi.fn().mockResolvedValue({ data: [] });
    const client = makeFakeClient({ listExecutions, listWorkflows });
    const tool = buildTool(client);

    const details = await run(tool, { sinceHours: 24 });

    expect(details.scannedExecutions).toBe(2);
  });

  it("stops paginating when a whole page is past the window", async () => {
    const now = Date.now();
    const recentIso = new Date(now - 5 * 60_000).toISOString();
    const oldIso = new Date(now - 48 * 60 * 60_000).toISOString();
    const listExecutions = vi
      .fn()
      .mockResolvedValueOnce({
        data: [ex("1", "wf-a", "success", recentIso, 1_000)],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        // Whole page outside window → should stop here.
        data: [
          ex("90", "wf-a", "success", oldIso, 1_000),
          ex("91", "wf-a", "success", oldIso, 1_000),
        ],
        nextCursor: "should-not-fetch",
      });
    const listWorkflows = vi.fn().mockResolvedValue({ data: [] });
    const client = makeFakeClient({ listExecutions, listWorkflows });
    const tool = buildTool(client);

    const details = await run(tool, { sinceHours: 24 });

    expect(listExecutions).toHaveBeenCalledTimes(2);
    expect(details.scannedExecutions).toBe(1);
    expect(details.stoppedReason).toBe("window");
  });

  it("caps on rows INSPECTED (not just collected) so mostly-old pages can't blow past maxExecutions", async () => {
    // 50 rows per page, 1 recent + 49 old. Without an inspected counter the
    // loop would keep fetching pages indefinitely (each page only adds 1 to
    // collected) and silently exceed maxExecutions=50.
    const now = Date.now();
    const recentIso = new Date(now - 60_000).toISOString();
    const oldIso = new Date(now - 48 * 60 * 60_000).toISOString();
    const oneRecent49Old = (pageId: number) => ({
      data: [
        ex(`r${pageId}`, "wf-a", "success", recentIso, 1_000),
        ...Array.from({ length: 49 }, (_, i) =>
          ex(`o${pageId}-${i}`, "wf-a", "success", oldIso, 1_000),
        ),
      ],
      // Don't terminate via cursor — let the cap stop us.
      nextCursor: `next-${pageId}`,
    });
    const listExecutions = vi
      .fn()
      .mockImplementationOnce(async () => oneRecent49Old(1))
      .mockImplementationOnce(async () => oneRecent49Old(2))
      .mockImplementationOnce(async () => oneRecent49Old(3));
    const listWorkflows = vi.fn().mockResolvedValue({ data: [] });
    const client = makeFakeClient({ listExecutions, listWorkflows });
    const tool = buildTool(client);

    const details = await run(tool, {
      sinceHours: 24,
      maxExecutions: 50,
      pageSize: 50,
    });

    expect(listExecutions).toHaveBeenCalledTimes(1);
    expect(details.inspectedExecutions).toBe(50);
    expect(details.scannedExecutions).toBe(1);
    expect(details.stoppedReason).toBe("cap");
  });

  it("respects maxExecutions cap and reports truncated", async () => {
    const now = Date.now();
    const recentIso = new Date(now - 1_000).toISOString();
    const data: N8nExecutionSummary[] = Array.from({ length: 50 }, (_, i) =>
      ex(String(i), "wf-a", "success", recentIso, 100),
    );
    const listExecutions = vi.fn().mockResolvedValueOnce({
      data,
      nextCursor: "more-after",
    });
    const listWorkflows = vi.fn().mockResolvedValue({ data: [] });
    const client = makeFakeClient({ listExecutions, listWorkflows });
    const tool = buildTool(client);

    const details = await run(tool, {
      sinceHours: 1,
      maxExecutions: 50,
      pageSize: 50,
    });

    expect(details.scannedExecutions).toBe(50);
    expect(details.stoppedReason).toBe("cap");
    expect(details.truncated).toBe(true);
  });

  it("computes overall failure rate across all workflows", async () => {
    const now = Date.now();
    const recentIso = new Date(now - 1_000).toISOString();
    const data: N8nExecutionSummary[] = [
      ex("1", "wf-a", "success", recentIso, 100),
      ex("2", "wf-a", "error", recentIso, 100),
      ex("3", "wf-b", "error", recentIso, 100),
      ex("4", "wf-b", "success", recentIso, 100),
    ];
    const listExecutions = vi.fn().mockResolvedValueOnce({ data });
    const listWorkflows = vi.fn().mockResolvedValue({ data: [] });
    const client = makeFakeClient({ listExecutions, listWorkflows });
    const tool = buildTool(client);

    const details = await run(tool, { sinceHours: 1 });

    const totals = details.totals as Record<string, number>;
    expect(totals.total).toBe(4);
    expect(totals.error).toBe(2);
    expect(totals.failureRate).toBeCloseTo(0.5, 4);
  });
});
