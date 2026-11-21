import { describe, expect, it } from "vitest";
import {
  coordinatorPlanJsonSchema,
  coordinatorPlanOutput,
  coordinatorPlanningContract,
  coordinatorPlanningPrompt,
  coordinatorStructuredOutput,
  coordinatorWorkDecisionContract,
  coordinatorWorkDecisionOutput,
  coordinatorWorkDecisionPrompt,
} from "../src/core/coordinator-contract";

// Self-contained: how SPAWN's room coordinator plans work. No storage, routing
// or spending. Published with SPAWN's open agent code.
const research = () => coordinatorPlanningContract("research", "1000", "100");
const plan = {
  summary: "Find cited facts, then synthesize.",
  specialists: [
    { key: "r", name: "Researcher", instructions: "Extract cited facts from S1.", role: "researcher" },
    { key: "s", name: "Synthesizer", instructions: "Write the brief from reviewed findings.", role: "synthesizer" },
  ],
  steps: [
    { step_id: "find", brief: "Cite S1 facts.", specialist_key: "r", depends_on: [] },
    { step_id: "write", brief: "Synthesize.", specialist_key: "s", depends_on: ["find"] },
  ],
};

describe("plan budget", () => {
  it("allows one planning call plus one execution and one review per step", () => {
    // (1000 - 100) / (2 * 100) = 4 affordable steps, capped at the platform maximum.
    expect(research().max_steps).toBeLessThanOrEqual(4);
    expect(research().max_steps).toBeGreaterThanOrEqual(1);
    expect(coordinatorPlanningContract("research", "500", "100").max_steps).toBe(2);
  });
  it("refuses a budget too small for one step, and trading rooms", () => {
    expect(() => coordinatorPlanningContract("research", "299", "100")).toThrow();
    expect(() => coordinatorPlanningContract("trading", "1000", "100")).toThrow();
  });
});

describe("plan output", () => {
  it("accepts a valid plan and limits roles to the room kind", () => {
    expect(coordinatorPlanOutput(JSON.stringify(plan), research())).toEqual(plan);
    const schema = coordinatorPlanJsonSchema(research()) as unknown as { properties: { specialists: { items: { properties: { role: { enum: string[] } } } } } };
    expect(schema.properties.specialists.items.properties.role.enum).toEqual(["researcher", "synthesizer"]);
  });
  it.each([
    ["a role from another room kind", { ...plan, specialists: [{ ...plan.specialists[0], role: "builder" }, plan.specialists[1]] }],
    ["more steps than the budget allows", { ...plan, steps: Array.from({ length: 9 }, (_, i) => ({ step_id: "s" + i, brief: "b", specialist_key: "r", depends_on: [] })) }],
    ["an extra field", { ...plan, note: "x" }],
  ])("rejects %s", (_name, value) => {
    expect(() => coordinatorPlanOutput(JSON.stringify(value), research())).toThrow();
  });
  it("rejects text that is not one JSON object", () => {
    expect(() => coordinatorPlanOutput("Here is the plan: {}", research())).toThrow();
  });
});

describe("work decision", () => {
  const contract = () => coordinatorWorkDecisionContract("research", "1000", "100");
  it("accepts a local plan, or an honest stop with plan null", () => {
    const assessment = { required_capabilities: ["research.cited_findings"], unmet_requirements: [], requires_additional_authority: false, rationale: "Supplied sources suffice." };
    expect(coordinatorWorkDecisionOutput(JSON.stringify({ assessment, plan }), contract()).plan).toEqual(plan);
    const stop = { ...assessment, unmet_requirements: ["Needs web browsing"], requires_additional_authority: true };
    expect(coordinatorWorkDecisionOutput(JSON.stringify({ assessment: stop, plan: null }), contract()).plan).toBeNull();
  });
});

describe("review output", () => {
  const candidate = "sha256:" + "a".repeat(64);
  it("binds the review to the exact candidate", () => {
    const review = { decision: "approve", candidate_hash: candidate, evidence: "Every claim cites S1." };
    expect(coordinatorStructuredOutput(JSON.stringify(review), { kind: "coordinator_review_json_v1", candidate_hash: candidate })).toEqual(review);
    expect(() => coordinatorStructuredOutput(JSON.stringify({ ...review, candidate_hash: "sha256:" + "b".repeat(64) }),
      { kind: "coordinator_review_json_v1", candidate_hash: candidate })).toThrow();
  });
});

describe("prompts", () => {
  it("state the budget, the room's roles and the source rules, and embed the goal as data", () => {
    const prompt = coordinatorPlanningPrompt("Summarize S1.", "research", "1000", "100", research());
    expect(prompt).toContain("execution step");
    expect(prompt).toContain("researcher and one synthesizer");
    expect(prompt).toContain("never claim browsing");
    expect(prompt.trim().split("\n").at(-1)).toContain('"goal":"Summarize S1."');
    const decision = coordinatorWorkDecisionPrompt("Fix the bug in S1.", "coding", "1000", "100");
    expect(decision).toContain("coding.diff_review");
    expect(decision).toContain("Do not claim tests ran.");
  });
  it("refuse an empty goal", () => {
    expect(() => coordinatorPlanningPrompt(" ", "research", "1000", "100")).toThrow();
  });
});

describe("plan structural references", () => {
  // Both prompts state the same hard structural rules ("Use unique specialist
  // keys and step IDs. Every specialist must be used. Dependencies must
  // reference step IDs and form an acyclic graph."), and coordinatorPlanOutput
  // claims to "validate the entire original plan before a lossless internal
  // action projection". But the approval gate never resolves a reference: a
  // plan whose synthesis depends on a step that does not exist, whose steps
  // form a cycle, whose step names a specialist that does not exist, or whose
  // IDs are duplicated is accepted, and no later step can project it.
  // Budget 700/100 affords 3 steps, so none of these is a budget rejection.
  const threeStep = () => coordinatorPlanningContract("research", "700", "100");
  const validThreeStep = {
    summary: "Find cited facts, then synthesize.",
    specialists: [
      { key: "r", name: "Researcher", instructions: "Extract cited facts from S1 and S2.", role: "researcher" },
      { key: "s", name: "Synthesizer", instructions: "Write the brief from reviewed findings.", role: "synthesizer" },
    ],
    steps: [
      { step_id: "find", brief: "Cite S1 facts.", specialist_key: "r", depends_on: [] },
      { step_id: "find2", brief: "Cite S2 facts.", specialist_key: "r", depends_on: ["find"] },
      { step_id: "write", brief: "Synthesize.", specialist_key: "s", depends_on: ["find", "find2"] },
    ],
  };
  it("admits a 3-step budget and accepts the well-formed three-step plan", () => {
    expect(threeStep().max_steps).toBe(3);
    expect(coordinatorPlanOutput(JSON.stringify(validThreeStep), threeStep())).toEqual(validThreeStep);
  });
  it("rejects a dependency on a step ID that does not exist", () => {
    const dangling = { ...validThreeStep, steps: validThreeStep.steps.map((step) => step.step_id === "write" ? { ...step, depends_on: ["find", "ghost"] } : step) };
    expect(() => coordinatorPlanOutput(JSON.stringify(dangling), threeStep())).toThrow();
  });
  it("rejects a dependency cycle", () => {
    const cyclic = {
      ...validThreeStep,
      steps: [
        { step_id: "find", brief: "Cite S1 facts.", specialist_key: "r", depends_on: ["write"] },
        { step_id: "write", brief: "Synthesize.", specialist_key: "s", depends_on: ["find"] },
      ],
    };
    expect(() => coordinatorPlanOutput(JSON.stringify(cyclic), threeStep())).toThrow();
  });
  it("rejects a step routed to a specialist key that does not exist", () => {
    const ghost = { ...validThreeStep, steps: validThreeStep.steps.map((step) => step.step_id === "find2" ? { ...step, specialist_key: "ghost" } : step) };
    expect(() => coordinatorPlanOutput(JSON.stringify(ghost), threeStep())).toThrow();
  });
  it("rejects duplicate step IDs", () => {
    const dupSteps = { ...validThreeStep, steps: validThreeStep.steps.map((step) => step.step_id === "find2" ? { ...step, step_id: "find" } : step) };
    expect(() => coordinatorPlanOutput(JSON.stringify(dupSteps), threeStep())).toThrow();
  });
  it("rejects duplicate specialist keys", () => {
    const dupKeys = { ...validThreeStep, specialists: validThreeStep.specialists.map((entry) => entry.key === "s" ? { ...entry, key: "r" } : entry) };
    expect(() => coordinatorPlanOutput(JSON.stringify(dupKeys), threeStep())).toThrow();
  });
  it("rejects the same malformed plan through the work-decision path", () => {
    const contract = coordinatorWorkDecisionContract("research", "700", "100");
    const assessment = { required_capabilities: ["research.cited_findings"], unmet_requirements: [], requires_additional_authority: false, rationale: "Supplied sources suffice." };
    const dangling = { ...validThreeStep, steps: validThreeStep.steps.map((step) => step.step_id === "write" ? { ...step, depends_on: ["find", "ghost"] } : step) };
    expect(() => coordinatorWorkDecisionOutput(JSON.stringify({ assessment, plan: dangling }), contract)).toThrow();
    expect(coordinatorWorkDecisionOutput(JSON.stringify({ assessment, plan: validThreeStep }), contract).plan).toEqual(validThreeStep);
  });
});
