import test from "node:test";
import assert from "node:assert/strict";
import { checkTemplate, roomNameKey } from "./check.mjs";

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("room names compare case-insensitively after trimming", () => {
  assert.equal(roomNameKey("VESPER-04"), roomNameKey("vesper-04"));
  assert.equal(roomNameKey("VESPER-04"), roomNameKey(" VESPER-04"));
  assert.equal(roomNameKey("VESPER-04"), roomNameKey("VESPER-04 "));
  assert.equal(roomNameKey("VESPER-04"), roomNameKey("VESPER-04  "));
});

test("distinct room names stay distinct", () => {
  assert.notEqual(roomNameKey("VESPER-04"), roomNameKey("MOTH-07"));
  assert.notEqual(roomNameKey("VESPER-04"), roomNameKey("VESPER-05"));
});

// The catalogue is the room store's list: two entries under one seed_id or
// name leave one room unreachable by that key. These tests run the checker
// CLI against a throwaway copy of this directory, so they exercise main(),
// not just the per-template validator.
const here = dirname(fileURLToPath(import.meta.url));

function runChecker(mutatedCatalogue) {
  const dir = mkdtempSync(join(tmpdir(), "backrooms-check-"));
  try {
    cpSync(here, dir, { recursive: true });
    if (mutatedCatalogue) {
      const path = join(dir, "catalogue", "platform-rooms.v1.json");
      const catalogue = JSON.parse(readFileSync(path, "utf8"));
      mutatedCatalogue(catalogue);
      writeFileSync(path, JSON.stringify(catalogue, null, 2));
    }
    return spawnSync(process.execPath, ["check.mjs"], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("clean catalogue still passes", () => {
  const result = runChecker();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 rooms/);
});

test("catalogue with a duplicate seed_id fails", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], name: "VESPER-99" };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /"vesper-04" is already used/);
});

test("catalogue with a duplicate name fails", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], seed_id: "vesper-99" };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the name "VESPER-04" is already used/);
});

test("catalogue with a same name in different case fails", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], seed_id: "vesper-99", name: "vesper-04" };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the name "vesper-04" is already used/);
});

test("catalogue with a duplicate name padded with whitespace fails", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], seed_id: "vesper-99", name: "  vesper-04  " };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the name "  vesper-04  " is already used/);
});

test("catalogue with a distinct new room passes", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], seed_id: "vesper-99", name: "VESPER-99" };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /7 rooms/);
});

function researchTemplate(questions) {
  return {
    seed_id: "test-room",
    template_version: 1,
    name: "TEST-01",
    description: "A test room.",
    mapping_status: "proposed",
    kind: "research",
    purpose: "Answer questions.",
    input_brief: "Ask [question].",
    config: { kind: "research", questions, citation_policy: "provided_sources_only" },
    roles: [{ role: "researcher", instructions: "Research." }],
    contact_role: "researcher",
    output_sections: ["Findings"],
    deliverable_brief: "Findings.",
    required_work_capabilities: ["text.generate", "research.cited_findings"],
    optional_work_capabilities: [],
  };
}

function videoTemplate(shots) {
  return {
    seed_id: "test-room",
    template_version: 1,
    name: "TEST-01",
    description: "A test room.",
    mapping_status: "proposed",
    kind: "video",
    purpose: "Cut a clip.",
    input_brief: "Cut [recording].",
    config: { kind: "video", storyboard: "Board.", shots },
    roles: [{ role: "director", instructions: "Direct." }],
    contact_role: "director",
    output_sections: ["Cut plan"],
    deliverable_brief: "A cut plan.",
    required_work_capabilities: ["video.render"],
    optional_work_capabilities: [],
  };
}

test("research rooms need at least one question", () => {
  const errors = checkTemplate(researchTemplate([]), "test", "proposed");
  assert.ok(errors.some((error) => error.includes(".config.questions") && error.includes("1-16")));
  assert.deepEqual(checkTemplate(researchTemplate(["Only one question?"]), "test", "proposed"), []);
});

test("video rooms need at least one shot", () => {
  const errors = checkTemplate(
    videoTemplate([]),
    "test",
    "proposed",
  );
  assert.ok(errors.some((error) => error.includes(".config.shots") && error.includes("1-32")));
  assert.deepEqual(
    checkTemplate(
      videoTemplate([{ shot_id: "only", description: "Only shot.", duration_seconds: null }]),
      "test",
      "proposed",
    ),
    [],
  );
});


// A proposal whose JSON value is not an object must produce a validation
// error, not an uncaught TypeError from the CLI's file-name checks.
test("a non-object proposal is reported as a validation error", () => {
  const dir = mkdtempSync(join(tmpdir(), "backrooms-check-null-"));
  try {
    mkdirSync(join(dir, "proposals"));
    const file = join(dir, "proposals", "null.json");
    writeFileSync(file, "null");
    const result = spawnSync(process.execPath, [join(here, "check.mjs"), file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /must be an object/);
    assert.doesNotMatch(result.stderr, /TypeError/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
