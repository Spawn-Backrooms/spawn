import test from "node:test";
import assert from "node:assert/strict";
import { checkManifest } from "./check.mjs";

const validStyle = {
  schema_version: "spawn.mod.v1",
  id: "caption-color-fixture",
  version: 1,
  kind: "caption-style",
  name: "Caption Color Fixture",
  description: "A fixture for validating caption colors.",
  author: "bfs2021",
  license: "MIT",
  content: {
    enabled: true,
    font: "sans",
    font_size: 72,
    text_color: "#FFFFFF",
    highlight_color: "#FF3EA5",
    outline_color: "#000000",
    outline_width: 2,
    shadow: 1,
    x_pct: 50,
    y_pct: 50,
    words_per_group: 2,
    uppercase: true,
    animation: "pop",
    animation_ms: 120,
  },
};

test("accepts valid color strings in all three fields", () => {
  assert.deepEqual(checkManifest(structuredClone(validStyle)), []);
});

test("accepts a single-hyphen GitHub handle", () => {
  const m = structuredClone(validStyle);
  m.author = "octo-cat";
  assert.deepEqual(checkManifest(m), []);
});

for (const author of ["abc-", "a--b"]) {
  test(`rejects "${author}" as a GitHub handle`, () => {
    const m = structuredClone(validStyle);
    m.author = author;
    const errors = checkManifest(m);
    assert.ok(
      errors.some((e) => e.includes(".author:")),
      `expected an error for author "${author}", got: ${JSON.stringify(errors)}`,
    );
  });
}

for (const field of ["text_color", "highlight_color", "outline_color"]) {
  test(`rejects a one-element color array in ${field}`, () => {
    const m = structuredClone(validStyle);
    m.content[field] = ["#FFFFFF"];
    const errors = checkManifest(m);
    assert.ok(
      errors.some((e) => e.includes(`.${field}:`)),
      `expected an error for ${field}, got: ${JSON.stringify(errors)}`,
    );
  });

  test(`rejects a multi-element color array in ${field}`, () => {
    const m = structuredClone(validStyle);
    m.content[field] = ["#FFFFFF", "#000000"];
    assert.ok(checkManifest(m).some((e) => e.includes(`.${field}:`)));
  });
}
