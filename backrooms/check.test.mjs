import test from "node:test";
import assert from "node:assert/strict";
import { checkTemplate } from "./check.mjs";

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
