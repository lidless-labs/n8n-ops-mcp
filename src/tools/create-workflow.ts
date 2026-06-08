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
    projectId: Type.Optional(
      Type.String({
        description:
          "Optional project id from n8n_list_projects. Sent as projectId on the create request.",
      }),
    ),
    folderId: Type.Optional(
      Type.String({
        description:
          "Optional folder id from n8n_list_folders. Sent as folderId on the create request.",
      }),
    ),
    dryRun: Type.Optional(
      Type.Boolean({
        description:
          "When true, validate and return the cleaned POST body without creating the workflow. Default false for backward compatibility.",
      }),
    ),
    skipValidation: Type.Optional(
      Type.Boolean({
        description:
          "Skip the n8n_validate_workflow pre-check. Default false. Validation errors (not warnings) block the create by default.",
      }),
    ),
    confirm: Type.Optional(
      Type.Boolean({
        description:
          "Must be true when dryRun is not set to true. Accepts an arbitrary nodes graph (Code/Execute Command/HTTP, etc.) that will exist on the server. Ignored for dry runs. Run with dryRun:true first to inspect the cleaned body, then repeat with confirm:true to write.",
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
      "Builder write helper: create a new inactive n8n workflow via POST /workflows from structured JSON (name, nodes, connections, optional settings/staticData). Also accepts n8n_get_workflow(includeDefinition=true) output and backup snapshots directly: read-only fields (id, active, createdAt, etc.) are stripped before POST. Optional projectId/folderId target project or folder. dryRun:true validates and returns the cleaned POST body without writing. Runs n8n_validate_workflow as a pre-check by default (errors block, warnings pass through); pass skipValidation:true to bypass. Primary restore path for n8n_delete_workflow snapshots. Requires enableEdit and explicit confirm=true when actually writing (dryRun:true previews without confirm).",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const params = rawParams as {
        definition: Record<string, unknown>;
        projectId?: string;
        folderId?: string;
        dryRun?: boolean;
        skipValidation?: boolean;
        confirm?: boolean;
      };
      const client = deps.getClient();

      if (params.dryRun !== true && params.confirm !== true) {
        return jsonToolResult({
          ok: false,
          action: "create",
          error: "confirm must be true to create (or pass dryRun:true to preview)",
          hint: "Run with dryRun:true first to inspect the cleaned POST body, then repeat with confirm:true to write.",
        });
      }

      const body = buildCreateBody(params.definition);

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
      if (params.dryRun === true) {
        return jsonToolResult({
          ok: errors.length === 0 || params.skipValidation === true,
          action: "create",
          dryRun: true,
          wouldWrite: false,
          target: createTarget(params.projectId, params.folderId),
          issues,
          body,
          hint:
            errors.length > 0 && params.skipValidation !== true
              ? "Validation errors would block creation. Fix the issues or repeat with skipValidation:true."
              : "Dry run only. Repeat with dryRun:false and confirm:true to create this workflow.",
        });
      }

      if (!params.skipValidation && errors.length > 0) {
        return jsonToolResult({
          ok: false,
          error: "validation failed; create aborted",
          target: createTarget(params.projectId, params.folderId),
          issues,
        });
      }

      try {
        const created = await client.createWorkflow(body, {
          projectId: params.projectId,
          folderId: params.folderId,
        });
        return jsonToolResult({
          ok: true,
          action: "create",
          workflowId: created.id,
          workflowName: created.name,
          active: created.active ?? false,
          target: createTarget(params.projectId, params.folderId),
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

function createTarget(
  projectId?: string,
  folderId?: string,
): { projectId: string | null; folderId: string | null } {
  return {
    projectId: projectId ?? null,
    folderId: folderId ?? null,
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
