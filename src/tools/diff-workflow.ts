import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { N8nClient, N8nWorkflow } from "../client.ts";
import { jsonToolResult } from "./result.ts";

const Schema = Type.Object(
  {
    id: Type.String({
      description: "Workflow id to fetch as the 'after' side of the diff.",
    }),
    snapshotPath: Type.Optional(
      Type.String({
        description:
          "Path to a JSON snapshot file written by n8n_save_workflow or n8n_delete_workflow. MUST resolve to a file inside the configured backupDir (default ~/.n8n-backups); paths outside it (or containing `..` traversal) are rejected. May be given relative to backupDir or as an absolute path within it. Use this OR `snapshot`, not both.",
      }),
    ),
    snapshot: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Inline snapshot object — accepts either the flat n8n_save_workflow backup shape or the nested n8n_get_workflow(includeDefinition=true) shape. Use this OR `snapshotPath`, not both.",
      }),
    ),
    ignoreCosmetic: Type.Optional(
      Type.Boolean({
        description:
          "Suppress position-only and webhookId-only node changes (default true). Drag-and-drop and webhook-id regeneration produce a lot of noise that almost never matters for an audit.",
      }),
    ),
    maxModifiedDetails: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 500,
        description:
          "Cap on per-node modification entries returned in `diff.nodesModified` (default 50). Counters in `summary` are NOT capped.",
      }),
    ),
  },
  { additionalProperties: false },
);

const DEFAULT_MAX_MODIFIED = 50;

interface NormalizedSnapshot {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface WorkflowDiffResult {
  identical: boolean;
  summary: {
    nodesAdded: number;
    nodesRemoved: number;
    nodesModified: number;
    nameChanged: boolean;
    connectionsChanged: boolean;
    settingsChanged: boolean;
  };
  diff: {
    name: { before: string; after: string } | null;
    nodesAdded: Array<{ id: string | null; name: string; type: string }>;
    nodesRemoved: Array<{ id: string | null; name: string; type: string }>;
    nodesModified: Array<{
      id: string | null;
      name: string;
      type: string;
      fieldsChanged: string[];
    }>;
    nodesModifiedTruncated: boolean;
    connectionsChanged: boolean;
    settingsChanged: boolean;
    settingsChangedKeys: string[];
  };
}

interface NodeFingerprint {
  id: string | null;
  name: string;
  type: string;
  raw: Record<string, unknown>;
}

export function buildWorkflowDiff(
  beforeRaw: Record<string, unknown>,
  afterRaw: Record<string, unknown>,
  opts: { ignoreCosmetic?: boolean; maxModifiedDetails?: number } = {},
): WorkflowDiffResult {
  const ignoreCosmetic = opts.ignoreCosmetic !== false;
  const maxModified = opts.maxModifiedDetails ?? DEFAULT_MAX_MODIFIED;

  const before = normalizeSnapshot(beforeRaw);
  const after = normalizeSnapshot(afterRaw);

  const beforeNodes = collectFingerprints(before.nodes);
  const afterNodes = collectFingerprints(after.nodes);
  const { pairs, addedNodes, removedNodes } = matchNodes(
    beforeNodes,
    afterNodes,
  );

  const added = addedNodes.map((fp) => ({
    id: fp.id,
    name: fp.name,
    type: fp.type,
  }));
  const removed = removedNodes.map((fp) => ({
    id: fp.id,
    name: fp.name,
    type: fp.type,
  }));

  let modifiedCount = 0;
  const modifiedDetails: WorkflowDiffResult["diff"]["nodesModified"] = [];
  for (const [fpBefore, fpAfter] of pairs) {
    const fields = compareNodeFields(
      fpBefore.raw,
      fpAfter.raw,
      ignoreCosmetic,
    );
    if (fields.length === 0) continue;
    modifiedCount++;
    if (modifiedDetails.length < maxModified) {
      modifiedDetails.push({
        id: fpAfter.id,
        name: fpAfter.name,
        type: fpAfter.type,
        fieldsChanged: fields,
      });
    }
  }

  const nameChanged = before.name !== after.name;
  const connectionsChanged = !deepEqual(
    before.connections,
    after.connections,
  );
  const settingsDiff = diffSettings(before.settings, after.settings);

  const identical =
    added.length === 0 &&
    removed.length === 0 &&
    modifiedCount === 0 &&
    !nameChanged &&
    !connectionsChanged &&
    settingsDiff.changedKeys.length === 0;

  return {
    identical,
    summary: {
      nodesAdded: added.length,
      nodesRemoved: removed.length,
      nodesModified: modifiedCount,
      nameChanged,
      connectionsChanged,
      settingsChanged: settingsDiff.changedKeys.length > 0,
    },
    diff: {
      name: nameChanged
        ? { before: before.name, after: after.name }
        : null,
      nodesAdded: added,
      nodesRemoved: removed,
      nodesModified: modifiedDetails,
      nodesModifiedTruncated: modifiedCount > modifiedDetails.length,
      connectionsChanged,
      settingsChanged: settingsDiff.changedKeys.length > 0,
      settingsChangedKeys: settingsDiff.changedKeys,
    },
  };
}

export interface DiffWorkflowDeps {
  getClient: () => N8nClient;
  backupDir?: string;
}

export function createDiffWorkflowTool(
  arg: (() => N8nClient) | DiffWorkflowDeps,
) {
  // Backward-compatible: accept either a bare getClient (legacy call sites and
  // tests) or a deps object carrying the configured backupDir.
  const deps: DiffWorkflowDeps =
    typeof arg === "function" ? { getClient: arg } : arg;
  const getClient = deps.getClient;
  const backupRoot = resolveBackupDir(deps.backupDir);
  return {
    name: "n8n_diff_workflow",
    label: "n8n: diff workflow",
    description:
      "Compare a workflow's current state against a snapshot (file path or inline object). Returns a structured semantic diff: nodes added/removed/modified (with per-node field paths), plus name/connections/settings change flags. Snapshot accepts both n8n_save_workflow backup shape (flat) and n8n_get_workflow(includeDefinition=true) shape (nested). Read-only.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const params = rawParams as {
        id: string;
        snapshotPath?: string;
        snapshot?: Record<string, unknown>;
        ignoreCosmetic?: boolean;
        maxModifiedDetails?: number;
      };

      if (!!params.snapshotPath === !!params.snapshot) {
        return jsonToolResult({
          ok: false,
          error: "exactly one of snapshotPath or snapshot is required",
        });
      }

      let snapshotRaw: Record<string, unknown>;
      let snapshotSource: string;
      if (params.snapshotPath) {
        const confined = resolveConfinedPath(params.snapshotPath, backupRoot);
        if (!confined.ok) {
          return jsonToolResult({
            ok: false,
            error: confined.error,
            snapshotPath: params.snapshotPath,
            backupDir: backupRoot,
          });
        }
        const resolved = confined.path;
        try {
          const text = await fs.readFile(resolved, "utf8");
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("snapshot file must contain a JSON object");
          }
          snapshotRaw = parsed as Record<string, unknown>;
          snapshotSource = resolved;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonToolResult({
            ok: false,
            error: `failed to read snapshot file: ${msg}`,
            snapshotPath: resolved,
          });
        }
      } else {
        snapshotRaw = params.snapshot!;
        snapshotSource = "inline";
      }

      const client = getClient();
      let current: N8nWorkflow;
      try {
        current = await client.getWorkflow(params.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonToolResult({
          ok: false,
          error: `failed to fetch current workflow: ${client.redact(msg)}`,
        });
      }

      const diffResult = buildWorkflowDiff(
        snapshotRaw,
        {
          name: current.name,
          nodes: current.nodes,
          connections: current.connections,
          settings: current.settings ?? {},
        },
        {
          ignoreCosmetic: params.ignoreCosmetic,
          maxModifiedDetails: params.maxModifiedDetails,
        },
      );
      const snapshotName = normalizeSnapshot(snapshotRaw).name;

      return jsonToolResult({
        ok: true,
        workflowId: current.id,
        workflowName: current.name,
        snapshotName,
        snapshotSource,
        ...diffResult,
      });
    },
  };
}

function resolveBackupDir(configured?: string): string {
  // Mirror save-workflow/delete-workflow's resolver so the diff tool reads
  // from the same directory those tools write snapshots to.
  const raw = configured?.trim() || "~/.n8n-backups";
  const expanded = raw.startsWith("~")
    ? path.join(homedir(), raw.slice(1).replace(/^\/+/, ""))
    : raw;
  return path.resolve(expanded);
}

type ConfinedPath =
  | { ok: true; path: string }
  | { ok: false; error: string };

function resolveConfinedPath(p: string, backupRoot: string): ConfinedPath {
  const trimmed = p.trim();
  if (!trimmed) {
    return { ok: false, error: "snapshotPath must be non-empty" };
  }
  // Expand `~` against the home dir, otherwise resolve relative inputs against
  // the backup root. Absolute paths are kept as-is and validated below.
  let expanded: string;
  if (trimmed.startsWith("~")) {
    expanded = path.join(homedir(), trimmed.slice(1).replace(/^\/+/, ""));
  } else if (path.isAbsolute(trimmed)) {
    expanded = trimmed;
  } else {
    expanded = path.join(backupRoot, trimmed);
  }
  const resolved = path.resolve(expanded);
  // Confinement: resolved path must be the backup root itself or a descendant.
  // Comparing against `backupRoot + sep` blocks sibling-prefix escapes such as
  // `/home/u/.n8n-backups-evil` when the root is `/home/u/.n8n-backups`.
  const rootWithSep = backupRoot.endsWith(path.sep)
    ? backupRoot
    : backupRoot + path.sep;
  if (resolved !== backupRoot && !resolved.startsWith(rootWithSep)) {
    return {
      ok: false,
      error: `snapshotPath must resolve to a file inside the configured backupDir (${backupRoot}); '${p}' resolved outside it and was rejected`,
    };
  }
  return { ok: true, path: resolved };
}

function normalizeSnapshot(raw: Record<string, unknown>): NormalizedSnapshot {
  // Mirror create-workflow's normalizer: flat shape OR nested-under-`definition`.
  const flat: Record<string, unknown> = { ...raw };
  const def = flat.definition;
  if (def && typeof def === "object" && !Array.isArray(def)) {
    for (const [k, v] of Object.entries(def as Record<string, unknown>)) {
      // Top-level fields win when both exist (rare, but defensive).
      if (!(k in flat)) flat[k] = v;
    }
  }

  const name = typeof flat.name === "string" ? flat.name : "";
  const nodes = Array.isArray(flat.nodes) ? (flat.nodes as unknown[]) : [];
  const connections =
    flat.connections && typeof flat.connections === "object"
      ? (flat.connections as Record<string, unknown>)
      : {};
  const settings =
    flat.settings && typeof flat.settings === "object"
      ? (flat.settings as Record<string, unknown>)
      : {};

  return { name, nodes, connections, settings };
}

function collectFingerprints(nodes: unknown[]): NodeFingerprint[] {
  const out: NodeFingerprint[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : null;
    const name = typeof n.name === "string" ? n.name : "";
    const type = typeof n.type === "string" ? n.type : "";
    if (!id && !name) continue; // unidentifiable node, can't diff meaningfully
    out.push({ id, name, type, raw: n });
  }
  return out;
}

function matchNodes(
  before: NodeFingerprint[],
  after: NodeFingerprint[],
): {
  pairs: Array<[NodeFingerprint, NodeFingerprint]>;
  addedNodes: NodeFingerprint[];
  removedNodes: NodeFingerprint[];
} {
  // Two-pass matcher. n8n assigns stable UUIDs to nodes, but legacy or
  // hand-edited snapshots may be missing them on one side. Pass 1 matches
  // by id where both sides have ids; pass 2 falls back to name for any
  // remaining unmatched nodes. This keeps "renamed only" cases recognizable
  // while still handling the no-id-on-one-side case.
  const beforeRemaining = new Set(before);
  const afterRemaining = new Set(after);
  const pairs: Array<[NodeFingerprint, NodeFingerprint]> = [];

  const afterById = new Map<string, NodeFingerprint>();
  for (const fp of after) {
    if (fp.id) afterById.set(fp.id, fp);
  }
  for (const fp of before) {
    if (!fp.id) continue;
    const match = afterById.get(fp.id);
    if (!match) continue;
    pairs.push([fp, match]);
    beforeRemaining.delete(fp);
    afterRemaining.delete(match);
  }

  const afterByName = new Map<string, NodeFingerprint>();
  for (const fp of afterRemaining) {
    if (fp.name && !afterByName.has(fp.name)) afterByName.set(fp.name, fp);
  }
  for (const fp of [...beforeRemaining]) {
    if (!fp.name) continue;
    const match = afterByName.get(fp.name);
    if (!match || !afterRemaining.has(match)) continue;
    pairs.push([fp, match]);
    beforeRemaining.delete(fp);
    afterRemaining.delete(match);
  }

  return {
    pairs,
    addedNodes: [...afterRemaining],
    removedNodes: [...beforeRemaining],
  };
}

const COSMETIC_FIELDS = new Set(["position", "webhookId"]);

function compareNodeFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignoreCosmetic: boolean,
): string[] {
  const changed: string[] = [];
  const allKeys = new Set<string>([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  for (const key of allKeys) {
    if (key === "id") continue; // matched on id, can't differ within a pair
    if (ignoreCosmetic && COSMETIC_FIELDS.has(key)) continue;
    const a = before[key];
    const b = after[key];
    if (deepEqual(a, b)) continue;
    if (key === "parameters") {
      // Walk one level into parameters so the agent sees useful field names
      // ("parameters.command") rather than just "parameters".
      const subKeys = collectChangedSubKeys(a, b);
      if (subKeys.length === 0) {
        changed.push(key);
      } else {
        for (const sub of subKeys) changed.push(`parameters.${sub}`);
      }
      continue;
    }
    changed.push(key);
  }
  changed.sort();
  return changed;
}

function collectChangedSubKeys(a: unknown, b: unknown): string[] {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return [];
  if (Array.isArray(a) || Array.isArray(b)) return [];
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (!deepEqual(aObj[k], bObj[k])) changed.push(k);
  }
  changed.sort();
  return changed;
}

function diffSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { changedKeys: string[] } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changedKeys: string[] = [];
  for (const k of keys) {
    if (!deepEqual(before[k], after[k])) changedKeys.push(k);
  }
  changedKeys.sort();
  return { changedKeys };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}
