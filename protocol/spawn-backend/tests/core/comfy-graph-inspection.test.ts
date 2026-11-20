import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_WORKFLOW_LIMITS,
  comfyGraphInspection,
} from "../../../src/api/contentWorkflowSchemas";
import { inspectComfyGraph } from "../../src/core/comfy-graph-inspection";

// Shape from ComfyUI's API-format documentation, with synthetic inputs.
const graph = () => ({
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 1,
      steps: 20,
      cfg: 8,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "fixture.safetensors" },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 512, height: 512, batch_size: 1 },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "Synthetic scene", clip: ["4", 1] },
    _meta: { title: "Prompt" },
  },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: ["3", 0], vae: ["4", 2] },
  },
  "9": {
    class_type: "SaveImage",
    inputs: { images: ["8", 0], filename_prefix: "fixture" },
  },
});
const inspect = (value: unknown) => inspectComfyGraph(JSON.stringify(value));
const codes = (text: string) =>
  inspectComfyGraph(text).issues.map((issue) => issue.code);
const expectError = (text: string, code: string) => {
  const result = inspectComfyGraph(text);
  expect(result.structurally_valid).toBe(false);
  expect(result.execution_status).toBe("not_admitted");
  expect(result.issues).toContainEqual(
    expect.objectContaining({ severity: "error", code }),
  );
  expect(comfyGraphInspection.safeParse(result).success).toBe(true);
};
afterEach(() => vi.unstubAllGlobals());

describe("Comfy API graph inspection", () => {
  it("checks an ordinary exported graph without granting runtime or dependency qualification", () => {
    const result = inspect(graph());
    expect(result).toMatchObject({
      structurally_valid: true,
      execution_status: "not_admitted",
      node_count: 7,
      link_count: 9,
    });
    expect(result.issues).toEqual([]);
    expect(
      result.classes.every((entry) => entry.dependency_status === "unverified"),
    ).toBe(true);
    expect(result.signature_snapshot).toContain(
      "4d64a8bc072b81c9b47321789b4d83fb7348ae2a",
    );
    expect(comfyGraphInspection.safeParse(result).success).toBe(true);
  });

  it("accepts prefixed IDs and the zero-output SaveImage signature", () => {
    const result = inspect({
      "group.0.image": {
        class_type: "LoadImage",
        inputs: { image: "fixture.png" },
      },
      "group.1.save": {
        class_type: "SaveImage",
        inputs: { images: ["group.0.image", 0], filename_prefix: "fixture" },
      },
      preview: {
        class_type: "PreviewImage",
        inputs: { images: ["group.0.image", 0] },
      },
    });
    expect(result.structurally_valid).toBe(true);
    expect(result.link_count).toBe(2);
    expect(
      result.classes.find((entry) => entry.class_type === "SaveImage")
        ?.output_count,
    ).toBe(0);
  });

  it("keeps unknown classes and their output arity visibly unverified", () => {
    const result = inspect({
      extension: { class_type: "constructor", inputs: {} },
      output: {
        class_type: "CustomOutput",
        inputs: { value: ["extension", 100] },
      },
    });
    expect(result.structurally_valid).toBe(true);
    expect(result.execution_status).toBe("not_admitted");
    expect(result.classes).toEqual([
      {
        class_type: "CustomOutput",
        node_count: 1,
        dependency_status: "unverified",
        output_count: null,
      },
      {
        class_type: "constructor",
        node_count: 1,
        dependency_status: "unverified",
        output_count: null,
      },
    ]);
    expect(
      result.issues.filter((issue) => issue.code === "UNKNOWN_NODE_CLASS"),
    ).toHaveLength(2);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "OUTPUT_NODE_UNVERIFIED",
        severity: "warning",
      }),
    );
  });

  it("rejects dangling references and known output indices outside the cited signature", () => {
    const candidate = graph();
    candidate["9"].inputs.images = ["missing", 0];
    expectError(JSON.stringify(candidate), "DANGLING_LINK");
    candidate["9"].inputs.images = ["8", 1];
    expectError(JSON.stringify(candidate), "OUTPUT_INDEX_OUT_OF_RANGE");
  });

  it("reports no data outputs for SaveImage and PreviewImage", () => {
    const result = inspect({
      image: { class_type: "LoadImage", inputs: { image: "fixture.png" } },
      save: {
        class_type: "SaveImage",
        inputs: { images: ["image", 0], filename_prefix: "fixture" },
      },
      preview: {
        class_type: "PreviewImage",
        inputs: { images: ["image", 0] },
      },
    });
    expect(result.structurally_valid).toBe(true);
    expect(
      result.classes.find((entry) => entry.class_type === "SaveImage")
        ?.output_count,
    ).toBe(0);
    expect(
      result.classes.find((entry) => entry.class_type === "PreviewImage")
        ?.output_count,
    ).toBe(0);
  });

  it("rejects links from a SaveImage or PreviewImage output", () => {
    expectError(
      JSON.stringify({
        image: { class_type: "LoadImage", inputs: { image: "fixture.png" } },
        save: {
          class_type: "SaveImage",
          inputs: { images: ["image", 0], filename_prefix: "fixture" },
        },
        preview: {
          class_type: "PreviewImage",
          inputs: { images: ["save", 0] },
        },
      }),
      "OUTPUT_INDEX_OUT_OF_RANGE",
    );
    expectError(
      JSON.stringify({
        image: { class_type: "LoadImage", inputs: { image: "fixture.png" } },
        preview: {
          class_type: "PreviewImage",
          inputs: { images: ["image", 0] },
        },
        save: {
          class_type: "SaveImage",
          inputs: { images: ["preview", 0], filename_prefix: "fixture" },
        },
      }),
      "OUTPUT_INDEX_OUT_OF_RANGE",
    );
  });

  it.each([-1, 0.5, "0", true, 9_007_199_254_740_992])(
    "rejects malformed output index %s",
    (index) => {
      expectError(
        JSON.stringify({
          output: {
            class_type: "SaveImage",
            inputs: { images: ["image", index] },
          },
        }),
        "INVALID_LINK",
      );
    },
  );

  it.each([
    { a: { class_type: "CustomNode", inputs: { value: ["a", 0] } } },
    {
      a: { class_type: "CustomNode", inputs: { value: ["b", 0] } },
      b: { class_type: "CustomNode", inputs: { value: ["a", 0] } },
    },
  ])("rejects cycles even in an otherwise unused graph component", (cycle) => {
    expectError(JSON.stringify({ ...graph(), ...cycle }), "GRAPH_CYCLE");
  });

  it("rejects known graphs without an output node", () => {
    expectError(
      JSON.stringify({
        image: { class_type: "LoadImage", inputs: { image: "fixture.png" } },
      }),
      "OUTPUT_NODE_MISSING",
    );
  });

  it.each([
    [[], "API_GRAPH_REQUIRED"],
    [null, "API_GRAPH_REQUIRED"],
    [{}, "EMPTY_GRAPH"],
    [{ nodes: [], links: [] }, "INVALID_NODE"],
    [{ prompt: graph() }, "INVALID_NODE"],
    [{ a: { class_type: "", inputs: {} } }, "INVALID_NODE"],
    [{ a: { class_type: "SaveImage", inputs: [] } }, "INVALID_NODE"],
    [
      { a: { class_type: "SaveImage", inputs: {}, _meta: [] } },
      "INVALID_NODE_METADATA",
    ],
    [
      { a: { class_type: "SaveImage", inputs: {}, execute: "command" } },
      "UNSUPPORTED_NODE_FIELD",
    ],
    [
      {
        a: {
          class_type: "SaveImage",
          inputs: { value: { nested: "literal" } },
        },
      },
      "STRUCTURED_INPUT_UNSUPPORTED",
    ],
    [
      { a: { class_type: "SaveImage", inputs: { value: [1, 2, 3] } } },
      "INVALID_LINK",
    ],
  ])("rejects unsupported API graph shape %#", (candidate, code) => {
    expectError(JSON.stringify(candidate), code as string);
  });

  it("keeps input URLs, paths and commands inert and out of the report", () => {
    const fetch = vi.fn(() => {
      throw new Error("Network must not be used");
    });
    vi.stubGlobal("fetch", fetch);
    const result = inspect({
      image: {
        class_type: "LoadImage",
        inputs: { image: "https://private.example/secret?token=private" },
      },
      save: {
        class_type: "SaveImage",
        inputs: {
          images: ["image", 0],
          filename_prefix: "../../secret-file; execute private-command",
        },
      },
    });
    expect(result.structurally_valid).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private.example");
    expect(JSON.stringify(result)).not.toContain("secret-file");
    expect(JSON.stringify(result)).not.toContain("private-command");
  });
});

describe("bounded strict JSON parsing", () => {
  it.each([
    '{"a":{},"a":{}}',
    '{"a":{},"\\u0061":{}}',
    '{"1":{"class_type":"SaveImage","inputs":{"x":1,"x":2}}}',
  ])("rejects duplicate decoded keys before graph interpretation", (text) =>
    expectError(text, "DUPLICATE_KEY"),
  );

  it.each(["__proto__", "constructor", "prototype", "\\u005f_proto__"])(
    "rejects prototype-related key %s at any depth",
    (key) => {
      expectError(
        `{"1":{"class_type":"SaveImage","inputs":{},"_meta":{"${key}":{}}}}`,
        "UNSAFE_KEY",
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each([
    "",
    "{",
    "{} trailing",
    '{"a":1,}',
    "[1,]",
    '{"a":01}',
    '{"a":undefined}',
    '{"a":"\\q"}',
    '{"a":"\n"}',
    "true false",
    '{"a":1e}',
  ])("rejects invalid JSON %#", (text) => expectError(text, "INVALID_JSON"));

  it("rejects nonfinite numbers without treating them as null or a valid index", () =>
    expectError('{"a":1e400}', "NONFINITE_NUMBER"));

  it("measures the text limit in UTF-8 bytes, including multibyte characters", () => {
    expectError(
      " ".repeat(CONTENT_WORKFLOW_LIMITS.graphBytes + 1),
      "GRAPH_BYTES_LIMIT",
    );
    const tooManyBytes = JSON.stringify(
      "é".repeat(CONTENT_WORKFLOW_LIMITS.graphBytes / 2),
    );
    expect(tooManyBytes.length).toBeLessThan(
      CONTENT_WORKFLOW_LIMITS.graphBytes,
    );
    expectError(tooManyBytes, "GRAPH_BYTES_LIMIT");
  });

  it("bounds nested and broad structures before examining nodes", () => {
    expectError("[".repeat(24) + "[]" + "]".repeat(24), "DEPTH_LIMIT");
    expectError("[".repeat(26) + "0" + "]".repeat(26), "DEPTH_LIMIT");
    expectError(JSON.stringify(Array(20_001).fill(0)), "VALUE_LIMIT");
    expectError(JSON.stringify("x".repeat(16_385)), "STRING_LIMIT");
    expectError(JSON.stringify({ ["x".repeat(161)]: 0 }), "KEY_LIMIT");
  });

  it("bounds node and link counts", () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        String(index),
        { class_type: "CustomNode", inputs: {} },
      ]),
    );
    expectError(JSON.stringify(nodes), "NODE_LIMIT");
    const linked = {
      source: { class_type: "CustomNode", inputs: {} },
      sink: {
        class_type: "CustomOutput",
        inputs: Object.fromEntries(
          Array.from({ length: 2_001 }, (_, index) => [
            `input${index}`,
            ["source", 0],
          ]),
        ),
      },
    };
    expectError(JSON.stringify(linked), "LINK_LIMIT");
  });

  it("caps diagnostics while retaining errors that occur after many warnings", () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 110 }, (_, index) => [
        String(index),
        { class_type: `Custom${index}`, inputs: { value: ["missing", 0] } },
      ]),
    );
    const result = inspect(nodes);
    expect(result.structurally_valid).toBe(false);
    expect(result.issues).toHaveLength(100);
    expect(result.issues.at(-1)).toMatchObject({
      code: "ISSUES_TRUNCATED",
      severity: "error",
    });
    expect(result.classes).toHaveLength(110);
    expect(comfyGraphInspection.safeParse(result).success).toBe(true);
  });

  it("does not confuse escaped quotes and braces inside a scalar with JSON structure", () => {
    const candidate = graph();
    candidate["6"].inputs.text =
      'A "quote", \\ backslash, {brace} and __proto__ as harmless text';
    expect(codes(JSON.stringify(candidate))).toEqual([]);
  });
});
