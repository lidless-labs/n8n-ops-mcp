import { describe, it, expect, vi } from "vitest";
import { createRunAuditTool } from "../src/tools/run-audit.ts";
import { makeFakeClient } from "./helpers.ts";
import type { N8nClient } from "../src/client.ts";

async function run(
  tool: ReturnType<typeof createRunAuditTool>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await tool.execute("call-1", params)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

function buildTool(client: N8nClient) {
  return createRunAuditTool(() => client);
}

describe("n8n_run_audit", () => {
  it("returns the audit body with computed report counts", async () => {
    const audit = {
      "Credentials Risk Report": {
        risk: "credentials",
        sections: [
          {
            title: "Unused credentials",
            location: [
              { kind: "credential", id: "1", name: "Old API" },
              { kind: "credential", id: "2", name: "Stale" },
            ],
          },
        ],
      },
      "Database Risk Report": {
        risk: "database",
        sections: [
          {
            title: "SQL injection in expressions",
            location: [{ kind: "node", workflowId: "wf-1" }],
          },
          { title: "Other thing", location: [] },
        ],
      },
    };
    const runAudit = vi.fn().mockResolvedValue(audit);
    const client = makeFakeClient({ runAudit });
    const tool = buildTool(client);

    const details = await run(tool, {});

    expect(runAudit).toHaveBeenCalledWith({
      categories: undefined,
      daysAbandonedWorkflow: undefined,
    });
    expect(details).toMatchObject({
      ok: true,
      action: "audit",
      reportCount: 2,
      totalSections: 3,
      totalLocations: 3,
    });
    const reports = details.reports as Array<Record<string, unknown>>;
    const cred = reports.find((r) => r.key === "Credentials Risk Report");
    expect(cred).toMatchObject({ sectionCount: 1, locationCount: 2 });
  });

  it("forwards categories + daysAbandonedWorkflow", async () => {
    const runAudit = vi.fn().mockResolvedValue({});
    const client = makeFakeClient({ runAudit });
    const tool = buildTool(client);

    await run(tool, {
      categories: ["credentials", "nodes"],
      daysAbandonedWorkflow: 30,
    });

    expect(runAudit).toHaveBeenCalledWith({
      categories: ["credentials", "nodes"],
      daysAbandonedWorkflow: 30,
    });
  });

  it("treats empty categories array as 'omit' (per tool description)", async () => {
    const runAudit = vi.fn().mockResolvedValue({});
    const client = makeFakeClient({ runAudit });
    const tool = buildTool(client);

    await run(tool, { categories: [] });

    expect(runAudit).toHaveBeenCalledWith({
      categories: undefined,
      daysAbandonedWorkflow: undefined,
    });
  });

  it("handles audit responses with no recognizable reports gracefully", async () => {
    const runAudit = vi.fn().mockResolvedValue({ unexpected: "shape" });
    const client = makeFakeClient({ runAudit });
    const tool = buildTool(client);

    const details = await run(tool, {});

    expect(details.reportCount).toBe(0);
    expect(details.totalSections).toBe(0);
    expect(details.totalLocations).toBe(0);
  });

  it("strips `location` arrays from the audit body by default (PII guard)", async () => {
    const audit = {
      "Credentials Risk Report": {
        risk: "credentials",
        sections: [
          {
            title: "Unused credentials",
            description: "These credentials are not used.",
            recommendation: "Delete them.",
            location: [
              { kind: "credential", id: "1", name: "Customer XYZ API" },
              { kind: "credential", id: "2", name: "Prod DB" },
            ],
          },
        ],
      },
    };
    const runAudit = vi.fn().mockResolvedValue(audit);
    const client = makeFakeClient({ runAudit });
    const tool = buildTool(client);

    const details = await run(tool, {});

    expect(details.detailsIncluded).toBe(false);
    // Counts still surfaced.
    expect(details.totalLocations).toBe(2);
    // Body stripped: no `location` field on the section.
    const body = details.audit as Record<string, unknown>;
    const section = (
      (body["Credentials Risk Report"] as Record<string, unknown>)
        .sections as Array<Record<string, unknown>>
    )[0];
    expect(section.location).toBeUndefined();
    expect(section.locationCount).toBe(2);
    // But title/description/recommendation preserved so the agent still
    // knows WHAT the finding is.
    expect(section.title).toBe("Unused credentials");
    expect(section.recommendation).toBe("Delete them.");
  });

  it("returns the raw audit body when includeDetails:true", async () => {
    const audit = {
      "Credentials Risk Report": {
        risk: "credentials",
        sections: [
          {
            title: "Unused credentials",
            location: [{ kind: "credential", id: "1", name: "Customer XYZ" }],
          },
        ],
      },
    };
    const runAudit = vi.fn().mockResolvedValue(audit);
    const client = makeFakeClient({ runAudit });
    const tool = buildTool(client);

    const details = await run(tool, { includeDetails: true });

    expect(details.detailsIncluded).toBe(true);
    const body = details.audit as Record<string, unknown>;
    const section = (
      (body["Credentials Risk Report"] as Record<string, unknown>)
        .sections as Array<Record<string, unknown>>
    )[0];
    expect(section.location).toBeDefined();
  });
});
