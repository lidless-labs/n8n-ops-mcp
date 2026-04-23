import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { makeClient, resolveConfig } from "./src/config.ts";
import { createListWorkflowsTool } from "./src/tools/list-workflows.ts";
import { createGetWorkflowTool } from "./src/tools/get-workflow.ts";

export default definePluginEntry({
  id: "n8n",
  name: "n8n Ops",
  description:
    "List, inspect, and trigger n8n workflows from OpenClaw agents. Optional edit tools behind a flag with auto-backup and rollback on failure.",
  register(api) {
    if (api.registrationMode !== "full") return;

    const config = resolveConfig(api.pluginConfig);
    const client = makeClient(config);

    api.registerTool(createListWorkflowsTool(client) as AnyAgentTool);
    api.registerTool(createGetWorkflowTool(client) as AnyAgentTool);
  },
});
