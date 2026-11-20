import {
  CONTENT_WORKFLOW_LIMITS,
  type ComfyGraphInspection,
} from "../../../src/api/contentWorkflowSchemas";

/** Offline reference only. No runtime discovery, dependency loading or execution.
 * https://github.com/Comfy-Org/ComfyUI/blob/4d64a8bc072b81c9b47321789b4d83fb7348ae2a/nodes.py
 * https://github.com/Comfy-Org/ComfyUI/blob/4d64a8bc072b81c9b47321789b4d83fb7348ae2a/comfy_execution/graph_utils.py
 */
const SIGNATURE_SNAPSHOT =
  "ComfyUI@4d64a8bc072b81c9b47321789b4d83fb7348ae2a/nodes.py; output signatures only";
const signatures = new Map<string, { outputs: number; outputNode?: true }>([
  ["CheckpointLoaderSimple", { outputs: 3 }],
  ["CLIPTextEncode", { outputs: 1 }],
  ["EmptyLatentImage", { outputs: 1 }],
  ["KSampler", { outputs: 1 }],
  ["KSamplerAdvanced", { outputs: 1 }],
  ["VAEDecode", { outputs: 1 }],
  ["VAEEncode", { outputs: 1 }],
  ["LoadImage", { outputs: 2 }],
  ["LoraLoader", { outputs: 2 }],
  ["SaveImage", { outputs: 0, outputNode: true }],
  // PreviewImage inherits SaveImage's return signature and OUTPUT_NODE.
  // Both are terminal nodes with RETURN_TYPES = (): their UI result is not
  // a data output, so no link may reference output 0 of either class.
  ["PreviewImage", { outputs: 0, outputNode: true }],
]);
const limitations = [
  "Inspection never admits or runs a SPAWN workflow. It performs no network, file, subprocess, model or installation effects.",
  "Every node dependency remains unverified. The reference snapshot is not the selected runtime's /object_info schema or evidence of installed nodes or models.",
  "Input types, required inputs, model compatibility, resources, custom-node effects, output quality and execution authority are not qualified.",
  "Only API graph objects with scalar inputs and direct [node_id, output_index] links are supported. UI-save graphs, request envelopes and structured literal inputs require separate runtime-schema review.",
  "Output arity and known output-node checks apply only to the named reference snapshot; another runtime version may differ.",
] as const;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Issue = ComfyGraphInspection["issues"][number];
type Node = { classType: string; inputs: Record<string, Json> };
const record = (value: Json): value is Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

class InspectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** JSON.parse alone loses duplicate keys. Parse the bounded grammar before
 * interpreting graph records; decoded keys are checked before assignment.
 * Recursion is limited before descending, including metadata and unused inputs.
 */
function parseGraphJson(text: string): Json {
  let offset = 0;
  let values = 0;
  const invalid = (): never => {
    throw new InspectionError(
      "INVALID_JSON",
      "Provide one complete JSON value without comments or trailing content.",
    );
  };
  const whitespace = () => {
    while (offset < text.length && /[\t\n\r ]/.test(text[offset]!)) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++]!;
      if (character === "\\") {
        offset++;
      } else if (character === '"') {
        let value: string;
        try {
          value = JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return invalid();
        }
        if (value.length > 16_384)
          throw new InspectionError(
            "STRING_LIMIT",
            "A JSON string exceeds the 16,384-character inspection limit.",
          );
        return value;
      }
    }
    return invalid();
  };
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (depth: number): Json => {
    if (depth > CONTENT_WORKFLOW_LIMITS.graphDepth)
      throw new InspectionError(
        "DEPTH_LIMIT",
        "The JSON exceeds the 24-level inspection depth limit.",
      );
    if (++values > CONTENT_WORKFLOW_LIMITS.graphValues)
      throw new InspectionError(
        "VALUE_LIMIT",
        "The JSON exceeds the 20,000-value inspection limit.",
      );
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === "{") {
      offset++;
      const object: Record<string, Json> = Object.create(null) as Record<
        string,
        Json
      >;
      const keys = new Set<string>();
      whitespace();
      if (text[offset] === "}") {
        offset++;
        return object;
      }
      for (;;) {
        whitespace();
        if (text[offset] !== '"') return invalid();
        const key = string();
        if (key.length > 160)
          throw new InspectionError(
            "KEY_LIMIT",
            "A JSON key exceeds the 160-character inspection limit.",
          );
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new InspectionError(
            "UNSAFE_KEY",
            "Prototype-related JSON keys are not supported by this inspector.",
          );
        if (keys.has(key))
          throw new InspectionError(
            "DUPLICATE_KEY",
            "JSON contains a duplicate decoded object key.",
          );
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") return invalid();
        object[key] = value(depth + 1);
        whitespace();
        if (text[offset] === "}") {
          offset++;
          return object;
        }
        if (text[offset++] !== ",") return invalid();
      }
    }
    if (character === "[") {
      offset++;
      const array: Json[] = [];
      whitespace();
      if (text[offset] === "]") {
        offset++;
        return array;
      }
      for (;;) {
        array.push(value(depth + 1));
        whitespace();
        if (text[offset] === "]") {
          offset++;
          return array;
        }
        if (text[offset++] !== ",") return invalid();
      }
    }
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return result;
      }
    }
    number.lastIndex = offset;
    const match = number.exec(text);
    if (!match) return invalid();
    offset = number.lastIndex;
    const result = Number(match[0]);
    if (!Number.isFinite(result))
      throw new InspectionError(
        "NONFINITE_NUMBER",
        "A JSON number is outside the finite numeric range supported by this inspector.",
      );
    return result;
  };
  // Count the root as level one, including empty containers at the boundary.
  const result = value(1);
  whitespace();
  if (offset !== text.length) return invalid();
  return result;
}

/** Bounded inspection of untrusted text. The returned report contains class/edge
 * findings, never the original graph, prompts, filenames or URL input values.
 */
export function inspectComfyGraph(text: string): ComfyGraphInspection {
  const report: ComfyGraphInspection = {
    inspection_version: "comfy-inspection-v1",
    format: "comfy-api",
    structurally_valid: false,
    execution_status: "not_admitted",
    node_count: 0,
    link_count: 0,
    signature_snapshot: SIGNATURE_SNAPSHOT,
    classes: [],
    issues: [],
    limitations: [...limitations],
  };
  let errors = 0;
  let omitted = 0;
  const issue = (entry: Issue) => {
    if (entry.severity === "error") errors++;
    if (report.issues.length < CONTENT_WORKFLOW_LIMITS.graphIssues - 1)
      report.issues.push(entry);
    else omitted++;
  };
  const finish = () => {
    if (omitted)
      report.issues.push({
        severity: errors ? "error" : "warning",
        code: "ISSUES_TRUNCATED",
        message: `${omitted} additional findings were omitted. Resolve the reported findings and inspect again.`,
      });
    report.structurally_valid = errors === 0;
    return report;
  };
  try {
    if (
      typeof text !== "string" ||
      text.length > CONTENT_WORKFLOW_LIMITS.graphBytes ||
      new TextEncoder().encode(text).byteLength >
        CONTENT_WORKFLOW_LIMITS.graphBytes
    )
      throw new InspectionError(
        "GRAPH_BYTES_LIMIT",
        "Provide graph JSON no larger than 256 KiB in UTF-8.",
      );
    const graph = parseGraphJson(text);
    if (!record(graph))
      throw new InspectionError(
        "API_GRAPH_REQUIRED",
        "Export Workflow (API) from ComfyUI and provide its node object, without a request envelope.",
      );
    const entries = Object.entries(graph);
    if (!entries.length)
      throw new InspectionError(
        "EMPTY_GRAPH",
        "The API graph must contain at least one node.",
      );
    if (entries.length > CONTENT_WORKFLOW_LIMITS.graphNodes)
      throw new InspectionError(
        "NODE_LIMIT",
        "The graph exceeds the 500-node inspection limit.",
      );
    report.node_count = entries.length;
    const nodes = new Map<string, Node>();
    const classes = new Map<string, number>();
    for (const [nodeId, item] of entries) {
      if (
        !nodeId.trim() ||
        !record(item) ||
        typeof item.class_type !== "string" ||
        !item.class_type.trim() ||
        item.class_type.length > 160 ||
        !record(item.inputs)
      ) {
        issue({
          severity: "error",
          code: "INVALID_NODE",
          node_id: nodeId,
          message:
            "Each API node needs a nonempty class_type and an inputs object. UI-save graphs and request envelopes are not accepted.",
        });
        continue;
      }
      if (
        (item._meta !== undefined && !record(item._meta)) ||
        (item.override_display_id !== undefined &&
          typeof item.override_display_id !== "string")
      )
        issue({
          severity: "error",
          code: "INVALID_NODE_METADATA",
          node_id: nodeId,
          message:
            "Node _meta must be an object and override_display_id must be a string when present.",
        });
      if (
        Object.keys(item).some(
          (key) =>
            !["class_type", "inputs", "_meta", "override_display_id"].includes(
              key,
            ),
        )
      )
        issue({
          severity: "error",
          code: "UNSUPPORTED_NODE_FIELD",
          node_id: nodeId,
          message:
            "A node has fields outside this inspector's API graph subset. Review them against the target runtime schema.",
        });
      nodes.set(nodeId, { classType: item.class_type, inputs: item.inputs });
      classes.set(item.class_type, (classes.get(item.class_type) ?? 0) + 1);
    }
    report.classes = [...classes.keys()].sort().map((classType) => ({
      class_type: classType,
      node_count: classes.get(classType)!,
      dependency_status: "unverified",
      output_count: signatures.get(classType)?.outputs ?? null,
    }));
    for (const entry of report.classes) {
      if (entry.output_count === null)
        issue({
          severity: "warning",
          code: "UNKNOWN_NODE_CLASS",
          message: `Class ${entry.class_type} has no reference signature. Its outputs, dependencies and effects remain unverified.`,
        });
    }
    const downstream = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const nodeId of nodes.keys()) {
      downstream.set(nodeId, []);
      indegree.set(nodeId, 0);
    }
    for (const [nodeId, node] of nodes) {
      for (const [input, inputValue] of Object.entries(node.inputs)) {
        if (!input.trim()) {
          issue({
            severity: "error",
            code: "INVALID_INPUT_NAME",
            node_id: nodeId,
            message: "Input names must not be empty.",
          });
          continue;
        }
        if (record(inputValue)) {
          issue({
            severity: "error",
            code: "STRUCTURED_INPUT_UNSUPPORTED",
            node_id: nodeId,
            input,
            message:
              "Structured literal inputs need target-runtime schema review and are outside this inspector's supported subset.",
          });
          continue;
        }
        if (!Array.isArray(inputValue)) continue;
        if (
          inputValue.length !== 2 ||
          typeof inputValue[0] !== "string" ||
          !inputValue[0].trim() ||
          inputValue[0].length > 160 ||
          typeof inputValue[1] !== "number" ||
          !Number.isSafeInteger(inputValue[1]) ||
          inputValue[1] < 0
        ) {
          issue({
            severity: "error",
            code: "INVALID_LINK",
            node_id: nodeId,
            input,
            message:
              "A direct link needs [node_id, nonnegative integer output_index]. Literal arrays require target-runtime schema review.",
          });
          continue;
        }
        if (++report.link_count > CONTENT_WORKFLOW_LIMITS.graphLinks)
          throw new InspectionError(
            "LINK_LIMIT",
            "The graph exceeds the 2,000-link inspection limit.",
          );
        const [sourceId, outputIndex] = inputValue as [string, number];
        const source = nodes.get(sourceId);
        if (!source) {
          issue({
            severity: "error",
            code: "DANGLING_LINK",
            node_id: nodeId,
            input,
            message: "This link references a missing or invalid node.",
          });
          continue;
        }
        const outputCount = signatures.get(source.classType)?.outputs;
        if (outputCount !== undefined && outputIndex >= outputCount)
          issue({
            severity: "error",
            code: "OUTPUT_INDEX_OUT_OF_RANGE",
            node_id: nodeId,
            input,
            message: `The referenced output index is outside the ${outputCount}-output reference signature. Check the selected runtime version.`,
          });
        downstream.get(sourceId)!.push(nodeId);
        indegree.set(nodeId, indegree.get(nodeId)! + 1);
      }
    }
    const ready = [...nodes.keys()].filter((id) => indegree.get(id) === 0);
    for (let cursor = 0; cursor < ready.length; cursor++) {
      for (const id of downstream.get(ready[cursor]!)!) {
        const remaining = indegree.get(id)! - 1;
        indegree.set(id, remaining);
        if (remaining === 0) ready.push(id);
      }
    }
    if (ready.length !== nodes.size)
      issue({
        severity: "error",
        code: "GRAPH_CYCLE",
        message:
          "The graph contains a dependency cycle, including any disconnected component.",
      });
    if (
      ![...nodes.values()].some(
        (node) => signatures.get(node.classType)?.outputNode,
      )
    ) {
      const unknown = report.classes.some(
        (entry) => entry.output_count === null,
      );
      issue({
        severity: unknown ? "warning" : "error",
        code: unknown ? "OUTPUT_NODE_UNVERIFIED" : "OUTPUT_NODE_MISSING",
        message: unknown
          ? "No output node is identified by the reference snapshot. Unknown node output behavior requires the target runtime schema."
          : "The graph has no output node in the reference snapshot.",
      });
    }
  } catch (error) {
    if (!(error instanceof InspectionError)) throw error;
    issue({ severity: "error", code: error.code, message: error.message });
  }
  return finish();
}
