import { Type } from "@sinclair/typebox";
import type { N8nClient, N8nWorkflow } from "../client.ts";
import { jsonToolResult } from "./result.ts";
import { validateWorkflow } from "./validate-workflow.ts";

const Schema = Type.Object(
  {
    definition: Type.Object(
      {
        name: Type.String({
          description: "Workflow name (required). Not enforced unique by n8n.",
        }),
        // nodes/connections may live at the top level (flat snapshot) OR nested
        // under `definition` (n8n_get_workflow shape) - optional at both levels.
        nodes: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
        connections: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        // n8n_get_workflow emits null for empty settings/staticData; accept
        // null here and coerce at runtime. Rejecting null would block the
        // documented direct-forward path before normalization runs.
        settings: Type.Optional(
          Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
        ),
        staticData: Type.Optional(Type.Unknown()),
        definition: Type.Optional(
          Type.Object(
            {
              nodes: Type.Optional(
                Type.Array(Type.Record(Type.String(), Type.Unknown())),
              ),
              connections: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
              settings: Type.Optional(
                Type.Union([
                  Type.Record(Type.String(), Type.Unknown()),
                  Type.Null(),
                ]),
              ),
              staticData: Type.Optional(Type.Unknown()),
            },
            { additionalProperties: true },
          ),
        ),
      },
      {
        additionalProperties: true,
        description:
          "Workflow body to create. Accepts two shapes: (1) a flat snapshot from n8n_delete_workflow or n8n_save_workflow (nodes/connections at the top level), or (2) the output of n8n_get_workflow with includeDefinition=true (graph data nested under `definition`, empty settings/staticData may arrive as null). Read-only fields (id, active, createdAt, updatedAt, isArchived, versionId, triggerCount, tags, shared, meta, pinData) are stripped before POST; null settings/staticData are normalized.",
      },
    ),
    skipValidation: Type.Optional(
      Type.Boolean({
        description:
          "Skip the n8n_validate_workflow pre-check. Default false. Validation errors (not warnings) block the create by default.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface CreateWorkflowDeps {
  getClient: () => N8nClient;
}

const READ_ONLY_FIELDS = [
  "id",
  "active",
  "createdAt",
  "updatedAt",
  "isArchived",
  "versionId",
  "triggerCount",
  "tags",
  "shared",
  "meta",
  "pinData",
] as const;

export function createCreateWorkflowTool(deps: CreateWorkflowDeps) {
  return {
    name: "n8n_create_workflow",
    label: "n8n: create workflow",
    description:
      "Create a new n8n workflow via POST /workflows. Accepts the output of n8n_get_workflow (includeDefinition=true) directly: read-only fields (id, active, createdAt, etc.) are stripped before POST. The new workflow is created INACTIVE; call n8n_activate afterwards if you want triggers running. Runs n8n_validate_workflow as a pre-check by default (errors block, warnings pass through); pass skipValidation:true to bypass. Primary restore path for n8n_delete_workflow snapshots. Requires enableEdit.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const params = rawParams as {
        definition: Record<string, unknown>;
        skipValidation?: boolean;
      };
      const client = deps.getClient();

      const body = buildCreateBody(params.definition);

      if (!params.skipValidation) {
        const proposed: N8nWorkflow = {
          id: "__pending__",
          name: String(body.name ?? ""),
          active: false,
          createdAt: "",
          updatedAt: "",
          nodes: (body.nodes as unknown[]) ?? [],
          connections: (body.connections as Record<string, unknown>) ?? {},
          settings: (body.settings as Record<string, unknown>) ?? {},
        };
        const issues = validateWorkflow(proposed);
        const errors = issues.filter((i) => i.severity === "error");
        if (errors.length > 0) {
          return jsonToolResult({
            ok: false,
            error: "validation failed; create aborted",
            issues,
          });
        }
      }

      try {
        const created = await client.createWorkflow(body);
        return jsonToolResult({
          ok: true,
          action: "create",
          workflowId: created.id,
          workflowName: created.name,
          active: created.active ?? false,
          createdAt: created.createdAt ?? null,
          updatedAt: created.updatedAt ?? null,
          hint: "Workflow is created inactive. Call n8n_activate to start its triggers.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonToolResult({
          ok: false,
          error: `create failed: ${msg}`,
        });
      }
    },
  };
}

function buildCreateBody(
  proposed: Record<string, unknown>,
): Record<string, unknown> {
  // Accept two input shapes:
  //   1. Flat N8nWorkflow (from n8n_delete_workflow / save_workflow backup files,
  //      or client.getWorkflow raw). Fields at top level.
  //   2. n8n_get_workflow(includeDefinition=true) output, where graph data is
  //      nested under `definition`. Flatten it by merging definition fields.
  const flat: Record<string, unknown> = { ...proposed };
  const def = flat.definition;
  if (def && typeof def === "object" && !Array.isArray(def)) {
    Object.assign(flat, def as Record<string, unknown>);
  }
  delete flat.definition;

  // n8n's Public API enforces additionalProperties:false on the workflow
  // schema; any read-only or unknown field triggers a 400.
  for (const field of READ_ONLY_FIELDS) {
    delete flat[field];
  }

  // settings is required server-side; n8n_get_workflow emits null for empty
  // settings, so normalize null → {}.
  const settings =
    flat.settings === null || flat.settings === undefined
      ? {}
      : (flat.settings as Record<string, unknown>);

  const body: Record<string, unknown> = {
    name: flat.name,
    nodes: flat.nodes ?? [],
    connections: flat.connections ?? {},
    settings,
  };
  if (flat.staticData !== undefined && flat.staticData !== null) {
    body.staticData = flat.staticData;
  }
  return body;
}
