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

// A clip recipe becomes one Creator clip node per clip, and the Creator
// pipeline caps clip nodes at 4 (CREATOR_LIMITS.clips). A recipe with 5 or 6
// clips passes the checker but its definition is rejected at load.
const recipeClip = (length_ms = 10000) => ({ length_ms, aspect: "9:16", framing: "cover" });
const validRecipe = {
  schema_version: "spawn.mod.v1",
  id: "clip-count-fixture",
  version: 1,
  kind: "clip-recipe",
  name: "Clip Count Fixture",
  description: "A fixture for validating clip recipe clip counts.",
  author: "bfs2021",
  license: "MIT",
  content: {
    base: "three-clips",
    clips: [recipeClip(), recipeClip(), recipeClip()],
  },
};
const recipeWithClips = (count) => {
  const m = structuredClone(validRecipe);
  m.content.clips = Array.from({ length: count }, () => recipeClip());
  return m;
};

test("accepts a clip recipe with 1 clip", () => {
  assert.deepEqual(checkManifest(recipeWithClips(1)), []);
});

test("accepts a clip recipe with 4 clips", () => {
  assert.deepEqual(checkManifest(recipeWithClips(4)), []);
});

test("rejects a clip recipe with 5 clips", () => {
  const errors = checkManifest(recipeWithClips(5));
  assert.ok(
    errors.some((e) => e.includes(".content.clips:")),
    `expected a clips error, got: ${JSON.stringify(errors)}`,
  );
});

test("rejects a clip recipe with 6 clips", () => {
  const errors = checkManifest(recipeWithClips(6));
  assert.ok(
    errors.some((e) => e.includes(".content.clips:")),
    `expected a clips error, got: ${JSON.stringify(errors)}`,
  );
});
