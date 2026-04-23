import { N8nClient } from "./client.ts";

export interface N8nPluginConfig {
  baseUrl: string;
  apiKey: string;
  enableEdit: boolean;
  maxExecutionLogBytes: number;
  requestTimeoutMs: number;
  backupDir?: string;
}

export function resolveConfig(raw: unknown): N8nPluginConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("openclaw-n8n: plugin config missing");
  }
  const c = raw as Record<string, unknown>;
  const baseUrl = typeof c.baseUrl === "string" ? c.baseUrl.trim() : "";
  const apiKeyEnv =
    typeof c.apiKeyEnv === "string" && c.apiKeyEnv.trim() ? c.apiKeyEnv.trim() : "N8N_API_KEY";
  const inline = typeof c.apiKey === "string" ? c.apiKey.trim() : "";
  const apiKey = inline || (process.env[apiKeyEnv] ?? "").trim();
  if (!baseUrl) throw new Error("openclaw-n8n: baseUrl is required");
  if (!apiKey) {
    throw new Error(
      `openclaw-n8n: apiKey is empty and env var ${apiKeyEnv} is not set`,
    );
  }
  return {
    baseUrl,
    apiKey,
    enableEdit: c.enableEdit === true,
    maxExecutionLogBytes: typeof c.maxExecutionLogBytes === "number" ? c.maxExecutionLogBytes : 65_536,
    requestTimeoutMs: typeof c.requestTimeoutMs === "number" ? c.requestTimeoutMs : 15_000,
    backupDir: typeof c.backupDir === "string" && c.backupDir ? c.backupDir : undefined,
  };
}

export function makeClient(config: N8nPluginConfig): N8nClient {
  return new N8nClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.requestTimeoutMs,
  });
}
