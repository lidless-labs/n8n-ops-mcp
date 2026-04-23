import { describe, it, expect, vi } from "vitest";
import { createSearchExecutionsTool } from "../src/tools/search-executions.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nExecution, N8nExecutionSummary } from "../src/client.ts";

function summary(overrides: Partial<N8nExecutionSummary> = {}): N8nExecutionSummary {
  return {
    id: "1",
    finished: true,
    mode: "trigger",
    workflowId: "wf-1",
    status: "error",
    ...overrides,
  };
}

function errorExecution(
  id: string,
  errorMessage: string,
  overrides: Partial<N8nExecution> = {},
): N8nExecution {
  return {
    id,
    finished: true,
    mode: "trigger",
    workflowId: "wf-1",
    status: "error",
    data: {
      resultData: {
        error: {
          message: errorMessage,
          stack: `Error: ${errorMessage}\n  at fetch`,
        },
      },
    },
    ...overrides,
  };
}

async function run(
  tool: ReturnType<typeof createSearchExecutionsTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as { details: Record<string, unknown> };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createSearchExecutionsTool(() => client);
}

describe("n8n_search_executions", () => {
  it("surfaces getExecution failures in the skipped[] array instead of silently dropping them", async () => {
    const client = makeFakeClient({
      listExecutions: vi.fn().mockResolvedValue({
        data: [summary({ id: "ok-1" }), summary({ id: "broken-1" })],
      }),
      listWorkflows: vi.fn().mockResolvedValue({ data: [] }),
      getExecution: vi.fn().mockImplementation(async (id: string) => {
        if (id === "broken-1") {
          throw new Error("n8n 500 on /api/v1/executions/broken-1: upstream blew up");
        }
        return errorExecution("ok-1", "ECONNREFUSED to https://example.test");
      }),
    });
    const tool = buildTool(client);

    const details = await run(tool, { query: "ECONNREFUSED" });

    expect(details.scannedCount).toBe(2);
    expect(details.matchCount).toBe(1);
    expect(details.skippedCount).toBe(1);
    const skipped = details.skipped as Array<{ executionId: string; error: string }>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0].executionId).toBe("broken-1");
    expect(skipped[0].error).toContain("upstream blew up");
  });

  it("redacts the API key from snippets and error messages", async () => {
    const API_KEY = "secret-token-abcdef";
    const exec = errorExecution(
      "1",
      `Request to https://n8n.test?apikey=${API_KEY} failed with ECONNREFUSED`,
    );
    const client = makeFakeClient({
      listExecutions: vi.fn().mockResolvedValue({ data: [summary({ id: "1" })] }),
      listWorkflows: vi.fn().mockResolvedValue({ data: [] }),
      getExecution: vi.fn().mockResolvedValue(exec),
      redact: vi.fn((t: string) => t.split(API_KEY).join("***REDACTED***")),
    });
    const tool = buildTool(client);

    const details = await run(tool, { query: "ECONNREFUSED" });

    // redact must have been called on both the error message AND each snippet
    expect(client.redact).toHaveBeenCalled();
    const matches = details.matches as Array<{
      errorMessage: string | null;
      snippets: Array<{ where: string; text: string }>;
    }>;
    expect(matches).toHaveLength(1);
    expect(matches[0].errorMessage).not.toContain(API_KEY);
    expect(matches[0].errorMessage).toContain("***REDACTED***");
    for (const s of matches[0].snippets) {
      expect(s.text).not.toContain(API_KEY);
    }
  });

  it("defaults to status='error' when the caller omits it", async () => {
    const listExecutions = vi.fn().mockResolvedValue({ data: [] });
    const client = makeFakeClient({
      listExecutions,
      listWorkflows: vi.fn().mockResolvedValue({ data: [] }),
    });
    const tool = buildTool(client);

    await run(tool, { query: "anything" });

    expect(listExecutions).toHaveBeenCalledTimes(1);
    const [opts] = listExecutions.mock.calls[0];
    expect(opts.status).toBe("error");
  });

  it("scope='error' ignores matches inside runData", async () => {
    const exec: N8nExecution = {
      id: "1",
      finished: true,
      mode: "trigger",
      workflowId: "wf-1",
      status: "error",
      data: {
        resultData: {
          error: { message: "generic boom" },
          runData: {
            HTTP: [{ data: { main: [[{ json: { msg: "needle-here" } }]] } }],
          },
        },
      },
    };
    const client = makeFakeClient({
      listExecutions: vi.fn().mockResolvedValue({ data: [summary({ id: "1" })] }),
      listWorkflows: vi.fn().mockResolvedValue({ data: [] }),
      getExecution: vi.fn().mockResolvedValue(exec),
    });
    const tool = buildTool(client);

    const details = await run(tool, { query: "needle-here", scope: "error" });
    expect(details.matchCount).toBe(0);
  });

  it("scope='all' picks up matches inside runData", async () => {
    const exec: N8nExecution = {
      id: "1",
      finished: true,
      mode: "trigger",
      workflowId: "wf-1",
      status: "error",
      data: {
        resultData: {
          error: { message: "generic boom" },
          runData: {
            HTTP: [{ data: { main: [[{ json: { msg: "needle-here" } }]] } }],
          },
        },
      },
    };
    const client = makeFakeClient({
      listExecutions: vi.fn().mockResolvedValue({ data: [summary({ id: "1" })] }),
      listWorkflows: vi.fn().mockResolvedValue({ data: [] }),
      getExecution: vi.fn().mockResolvedValue(exec),
    });
    const tool = buildTool(client);

    const details = await run(tool, { query: "needle-here", scope: "all" });
    expect(details.matchCount).toBe(1);
    const matches = details.matches as Array<{ matchedIn: string[] }>;
    expect(matches[0].matchedIn).toEqual(["node:HTTP"]);
  });

  it("stops scanning once maxMatches is reached and marks truncated=true", async () => {
    const summaries = [1, 2, 3, 4, 5].map((i) => summary({ id: String(i) }));
    const client = makeFakeClient({
      listExecutions: vi.fn().mockResolvedValue({ data: summaries }),
      listWorkflows: vi.fn().mockResolvedValue({ data: [] }),
      getExecution: vi
        .fn()
        .mockImplementation(async (id: string) =>
          errorExecution(id, "ECONNREFUSED happens"),
        ),
    });
    const tool = buildTool(client);

    const details = await run(tool, { query: "ECONNREFUSED", maxMatches: 2 });

    expect(details.matchCount).toBe(2);
    expect(details.truncated).toBe(true);
    // scannedCount reflects only the executions we looked at before hitting cap
    expect(details.scannedCount).toBe(2);
    // getExecution called exactly twice, not five times
    expect(client.getExecution).toHaveBeenCalledTimes(2);
  });
});
