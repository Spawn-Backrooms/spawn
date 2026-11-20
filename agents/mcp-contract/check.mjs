// MCP contract transport check.
//
// The MCP endpoint caps a whole request at 64 KiB including protocol fields
// (agents/mcp-contract/README.md), while the contract's own schemas state
// per-field maxima. A single field whose advertised maximum cannot fit in
// one request is a promise the transport cannot keep: a schema-valid call
// is rejected before the server ever sees it.
//
// Invariant: every declared string maxLength must fit in a single request
// on its own, and a maxLength-sized quote-dense graph sent to
// spawn_inspect_comfy_graph must measure under the 64 KiB budget. The cap
// is 48 KiB (49,152 chars): the densest realistic graph measured here
// escapes at ~20% (quotes -> \"), so 49,152 chars cost ~59,140 bytes
// including JSON-RPC framing, leaving ~6 KiB of margin. 262,144 chars
// (the old value, mirroring the inspector's 256 KiB GRAPH_BYTES_LIMIT)
// cost 262,318 bytes: 4x the budget, undeliverable by construction.
//
// Run: node agents/mcp-contract/check.mjs (exit 0 = pass)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TRANSPORT_LIMIT_BYTES = 65_536;
const MAX_SINGLE_FIELD_CHARS = 49_152;

const dir = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(join(dir, "spawn-mcp-tools.v1.json"), "utf8"),
);

const failures = [];

// 1. No declared string maximum may by itself exceed the deliverable cap.
function walk(node, path) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === "object") {
    if (
      node.type === "string" &&
      typeof node.maxLength === "number" &&
      node.maxLength > MAX_SINGLE_FIELD_CHARS
    ) {
      failures.push(
        `${path}: maxLength ${node.maxLength} exceeds the ${MAX_SINGLE_FIELD_CHARS}-char single-field cap ` +
          `(a maxLength-sized value cannot fit in one ${TRANSPORT_LIMIT_BYTES}-byte request)`,
      );
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  }
}
for (const tool of contract.tools) walk(tool.inputSchema, tool.name);

function requestBytes(graphJson) {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "spawn_inspect_comfy_graph",
      arguments: { format: "api", graph_json: graphJson },
    },
  };
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

// 2. A maxLength-sized graph must actually fit in one request. Build the
// densest realistic shape (many minimal nodes, ~20% quote escaping), sized
// to exactly the contract's graph_json maxLength, and measure the request.
const tool = contract.tools.find((t) => t.name === "spawn_inspect_comfy_graph");
const graphMax = tool.inputSchema.properties.graph_json.maxLength;
const nodes = {};
let id = 0;
let graph = "{}";
while (graph.length < graphMax) {
  id++;
  nodes[String(id)] = {
    class_type: "LoadImage",
    inputs: { image: "a.png" },
    _meta: { title: "LoadImage" },
  };
  graph = JSON.stringify(nodes);
}
while (graph.length > graphMax) {
  delete nodes[String(id)];
  id--;
  graph = JSON.stringify(nodes);
}
if (graph.length < graphMax) {
  // Top up inside a real string field (a filename), adding no quotes.
  const deficit = graphMax - graph.length;
  nodes[String(id)].inputs.image += "x".repeat(deficit);
  graph = JSON.stringify(nodes);
}
JSON.parse(graph); // the measured graph must be valid JSON
if (graph.length !== graphMax) {
  failures.push(`check setup: sized graph is ${graph.length} chars, expected ${graphMax}`);
}
const bytes = requestBytes(graph);
if (bytes > TRANSPORT_LIMIT_BYTES) {
  failures.push(
    `spawn_inspect_comfy_graph: a ${graphMax}-char graph_json costs ${bytes} bytes ` +
      `in one tools/call request, over the ${TRANSPORT_LIMIT_BYTES}-byte limit`,
  );
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  console.error(
    `mcp-contract check: ${failures.length} failure(s) ` +
      `(${contract.tools.length} tools, graph_json maxLength ${graphMax})`,
  );
  process.exit(1);
}
console.log(
  `mcp-contract check: pass (${contract.tools.length} tools, all string maxima <= ${MAX_SINGLE_FIELD_CHARS} chars, ` +
    `maxLength-sized graph request ${bytes}/${TRANSPORT_LIMIT_BYTES} bytes)`,
);
