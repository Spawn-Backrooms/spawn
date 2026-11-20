#!/usr/bin/env node
// Check the MCP contract's room-config shape. No dependencies.
//
//   node agents/mcp-contract/check.mjs
//
// spawn_configure_room accepts the same kind-specific config as
// spawn_create_room: an unconstrained `config: {}` would let an agent send
// any value (a string, null, a wrong kind, a wrong shape) that no other
// room gate accepts. The room schema (protocol/src/api/roomSchemas.ts) and
// the create-room tool both validate config per kind, so configure must
// mirror create exactly. Kind-match against the room's existing kind stays
// a server-side check; this script only pins the shape.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(join(here, "spawn-mcp-tools.v1.json"), "utf8"),
);
const failures = [];

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

const tools = new Map(contract.tools.map((tool) => [tool.name, tool]));
const create = tools.get("spawn_create_room");
const configure = tools.get("spawn_configure_room");
const createConfig = create?.inputSchema?.properties?.config;
const configureConfig = configure?.inputSchema?.properties?.config;
if (!create || !configure) {
  failures.push("spawn_create_room or spawn_configure_room is missing");
} else if (canonical(configureConfig) !== canonical(createConfig)) {
  failures.push(
    "spawn_configure_room.properties.config must mirror " +
      "spawn_create_room.properties.config exactly (kind-specific oneOf); " +
      `found ${JSON.stringify(configureConfig)?.slice(0, 120)}`,
  );
}

// Same hole class, anywhere a JSON Schema is expected: an empty schema {}
// accepts every value. (Empty `annotations: {}` objects are not schemas
// and are intentionally left alone.)
function checkSchema(node, where) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((entry, i) => checkSchema(entry, `${where}[${i}]`));
    return;
  }
  if (node.properties && typeof node.properties === "object") {
    for (const [name, schema] of Object.entries(node.properties)) {
      if (schema && typeof schema === "object" && Object.keys(schema).length === 0)
        failures.push(`${where}.properties.${name}: empty schema {} accepts any value`);
      checkSchema(schema, `${where}.properties.${name}`);
    }
  }
  for (const key of ["items", "additionalProperties"]) {
    const child = node[key];
    if (child && typeof child === "object" && Object.keys(child).length === 0)
      failures.push(`${where}.${key}: empty schema {} accepts any value`);
    checkSchema(child, `${where}.${key}`);
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const branches = node[key];
    if (Array.isArray(branches))
      branches.forEach((branch, i) => checkSchema(branch, `${where}.${key}[${i}]`));
  }
}
for (const tool of contract.tools)
  checkSchema(tool.inputSchema, `${tool.name}.inputSchema`);

if (failures.length) {
  console.error(failures.map((failure) => `✗ ${failure}`).join("\n"));
  console.error(`\n${failures.length} problem(s).`);
  process.exitCode = 1;
} else {
  console.log(
    `mcp-contract check: pass (${contract.tools.length} tools, ` +
      `configure config mirrors create config, no empty schemas)`,
  );
}
