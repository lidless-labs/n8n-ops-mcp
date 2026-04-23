import { N8nClient } from "../src/client.ts";

const baseUrl = process.env.N8N_BASE_URL;
const apiKey = process.env.N8N_API_KEY;

if (!baseUrl || !apiKey) {
  console.error("Set N8N_BASE_URL and N8N_API_KEY.");
  process.exit(2);
}

const client = new N8nClient({ baseUrl, apiKey, timeoutMs: 10_000 });

const list = await client.listWorkflows({ limit: 5 });
console.log(`Listed ${list.data.length} workflows:`);
for (const w of list.data) {
  console.log(`  - ${w.id}  ${w.active ? "[on] " : "[off]"}  ${w.name}`);
}

if (list.data.length > 0) {
  const first = list.data[0];
  const wf = await client.getWorkflow(first.id);
  const nodes = Array.isArray(wf.nodes) ? wf.nodes.length : 0;
  console.log(`\nFetched workflow ${wf.id} (${wf.name}): ${nodes} nodes`);
}
