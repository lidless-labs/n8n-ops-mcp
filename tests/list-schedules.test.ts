import { describe, it, expect, vi } from "vitest";
import { createListSchedulesTool } from "../src/tools/list-schedules.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient, N8nWorkflow, N8nWorkflowSummary } from "../src/client.ts";

function summary(overrides: Partial<N8nWorkflowSummary> = {}): N8nWorkflowSummary {
  return {
    id: "wf-1",
    name: "intel pipeline",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    ...overrides,
  };
}

function workflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: "wf-1",
    name: "intel pipeline",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    nodes: [],
    connections: {},
    ...overrides,
  };
}

async function run(
  tool: ReturnType<typeof createListSchedulesTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createListSchedulesTool(() => client);
}

describe("n8n_list_schedules", () => {
  it("decodes a 'every N hours' scheduleTrigger rule", async () => {
    const wf = workflow({
      nodes: [
        {
          name: "Schedule",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [
                { field: "hours", hoursInterval: 2, triggerAtMinute: 30 },
              ],
            },
          },
        },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary()] }),
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    expect(details.count).toBe(1);
    const schedules = details.schedules as Array<Record<string, unknown>>;
    expect(schedules[0].schedule).toBe("every 2 hours at :30");
    expect(schedules[0].field).toBe("hours");
  });

  it("decodes a 'daily at HH:MM' rule with the singular 'daily' form", async () => {
    const wf = workflow({
      nodes: [
        {
          name: "Daily",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [
                {
                  field: "days",
                  daysInterval: 1,
                  triggerAtHour: 3,
                  triggerAtMinute: 0,
                },
              ],
            },
          },
        },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary()] }),
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    const schedules = details.schedules as Array<{ schedule: string }>;
    expect(schedules[0].schedule).toBe("daily at 03:00");
  });

  it("decodes a weekly schedule with multiple days of week", async () => {
    const wf = workflow({
      nodes: [
        {
          name: "Weekdays",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [
                {
                  field: "weeks",
                  weeksInterval: 1,
                  triggerAtDay: [1, 3, 5], // Mon, Wed, Fri
                  triggerAtHour: 9,
                  triggerAtMinute: 15,
                },
              ],
            },
          },
        },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary()] }),
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    const schedules = details.schedules as Array<{ schedule: string }>;
    expect(schedules[0].schedule).toBe(
      "weekly on Monday, Wednesday, Friday at 09:15",
    );
  });

  it("surfaces the raw cron expression for cronExpression-mode rules", async () => {
    const wf = workflow({
      nodes: [
        {
          name: "Custom",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [
                { field: "cronExpression", expression: "0 */6 * * *" },
              ],
            },
          },
        },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary()] }),
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    const schedules = details.schedules as Array<{
      schedule: string;
      cronExpression: string;
    }>;
    expect(schedules[0].schedule).toBe("cron: 0 */6 * * *");
    expect(schedules[0].cronExpression).toBe("0 */6 * * *");
  });

  it("emits one entry per interval when a rule has multiple", async () => {
    const wf = workflow({
      nodes: [
        {
          name: "Multi",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [
                { field: "hours", hoursInterval: 1, triggerAtMinute: 0 },
                { field: "days", daysInterval: 1, triggerAtHour: 6, triggerAtMinute: 0 },
              ],
            },
          },
        },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary()] }),
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    expect(details.count).toBe(2);
    const schedules = details.schedules as Array<{ schedule: string }>;
    expect(schedules.map((s) => s.schedule).sort()).toEqual([
      "daily at 06:00",
      "every 1 hour at :00",
    ]);
  });

  it("handles legacy n8n-nodes-base.cron nodes with mode='everyDay'", async () => {
    const wf = workflow({
      nodes: [
        {
          name: "Old Cron",
          type: "n8n-nodes-base.cron",
          parameters: {
            triggerTimes: {
              item: [{ mode: "everyDay", hour: 4, minute: 0 }],
            },
          },
        },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary()] }),
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    const schedules = details.schedules as Array<{ schedule: string }>;
    expect(schedules[0].schedule).toBe("daily at 04:00");
  });

  it("handles legacy cron with a custom expression", async () => {
    const wf = workflow({
      nodes: [
        {
          name: "Old Custom",
          type: "n8n-nodes-base.cron",
          parameters: {
            triggerTimes: {
              item: [{ mode: "custom", cronExpression: "*/5 * * * *" }],
            },
          },
        },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary()] }),
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    const schedules = details.schedules as Array<{
      schedule: string;
      cronExpression: string;
    }>;
    expect(schedules[0].schedule).toBe("cron: */5 * * * *");
    expect(schedules[0].cronExpression).toBe("*/5 * * * *");
  });

  it("ignores non-schedule trigger nodes", async () => {
    const wf = workflow({
      nodes: [
        { name: "Webhook", type: "n8n-nodes-base.webhook", parameters: {} },
        { name: "HTTP", type: "n8n-nodes-base.httpRequest", parameters: {} },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary()] }),
      getWorkflow: vi.fn().mockResolvedValue(wf),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    expect(details.count).toBe(0);
  });

  it("filters out inactive workflows by default", async () => {
    const inactive = workflow({
      id: "wf-inactive",
      active: false,
      nodes: [
        {
          name: "Schedule",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: { interval: [{ field: "hours", hoursInterval: 1, triggerAtMinute: 0 }] },
          },
        },
      ],
    });
    // listWorkflows is called with active:true so it returns nothing for an
    // inactive workflow — but the tool should also defensively skip inactive
    // workflows from any returned definitions. Simulate that by returning the
    // inactive one even though we asked for active:true.
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary({ id: "wf-inactive", active: false })] }),
      getWorkflow: vi.fn().mockResolvedValue(inactive),
    });
    const tool = buildTool(client);

    const details = await run(tool, {});
    expect(details.count).toBe(0);
  });

  it("includes inactive workflows when activeOnly=false", async () => {
    const inactive = workflow({
      active: false,
      nodes: [
        {
          name: "Schedule",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: { interval: [{ field: "minutes", minutesInterval: 5 }] },
          },
        },
      ],
    });
    const client = makeFakeClient({
      listWorkflows: vi.fn().mockResolvedValue({ data: [summary({ active: false })] }),
      getWorkflow: vi.fn().mockResolvedValue(inactive),
    });
    const tool = buildTool(client);

    const details = await run(tool, { activeOnly: false });
    expect(details.count).toBe(1);
    const schedules = details.schedules as Array<{ schedule: string }>;
    expect(schedules[0].schedule).toBe("every 5 minutes");
  });

  it("scans a single workflow when workflowId is supplied", async () => {
    const wf = workflow({
      nodes: [
        {
          name: "Schedule",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: { interval: [{ field: "hours", hoursInterval: 6, triggerAtMinute: 0 }] },
          },
        },
      ],
    });
    const listWorkflows = vi.fn().mockResolvedValue({ data: [] });
    const getWorkflow = vi.fn().mockResolvedValue(wf);
    const client = makeFakeClient({ listWorkflows, getWorkflow });
    const tool = buildTool(client);

    const details = await run(tool, { workflowId: "wf-1" });
    expect(getWorkflow).toHaveBeenCalledWith("wf-1");
    expect(listWorkflows).not.toHaveBeenCalled();
    expect(details.count).toBe(1);
  });
});
