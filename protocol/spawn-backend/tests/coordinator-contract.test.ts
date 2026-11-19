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

describe("one-step research budget", () => {
  // A parent cap of 300 with a per-call cap of 100 admits the request with
  // max_steps 1, but the research prompts used to demand two specialists and
  // two execution steps. No plan could satisfy both: the two-step plan the
  // instruction describes is rejected by coordinatorPlanOutput.
  const oneStep = () => coordinatorPlanningContract("research", "300", "100");
  const oneStepPlan = {
    summary: "Research S1 and synthesize the findings in one step.",
    specialists: [
      { key: "r", name: "Researcher", instructions: "Extract cited facts from S1 and synthesize them.", role: "researcher" },
    ],
    steps: [
      { step_id: "find", brief: "Cite S1 facts and synthesize.", specialist_key: "r", depends_on: [] },
    ],
  };
  it("admits a 3x budget with one execution step, and 5x with two", () => {
    expect(oneStep().max_steps).toBe(1);
    expect(coordinatorPlanningContract("research", "499", "100").max_steps).toBe(1);
    expect(coordinatorPlanningContract("research", "500", "100").max_steps).toBe(2);
  });
  it("gives the one-step research room a satisfiable planning instruction", () => {
    const prompt = coordinatorPlanningPrompt("Summarize S1.", "research", "300", "100", oneStep());
    expect(prompt).toContain("at most 1 execution step");
    expect(prompt).not.toContain("one researcher and one synthesizer");
    expect(prompt).not.toContain("one research step plus exactly one final synthesis");
    expect(prompt).toContain("one researcher only");
    const twoStep = coordinatorPlanningPrompt("Summarize S1.", "research", "500", "100");
    expect(twoStep).toContain("at most 2 execution step");
    expect(twoStep).toContain("one research step plus exactly one final synthesis");
  });
  it("accepts the one-step plan the instruction describes", () => {
    expect(coordinatorPlanOutput(JSON.stringify(oneStepPlan), oneStep())).toEqual(oneStepPlan);
  });
  it("gives the one-step research room a satisfiable work-decision instruction", () => {
    const decision = coordinatorWorkDecisionPrompt("Summarize S1.", "research", "300", "100");
    expect(decision).toContain("at most 1 execution step");
    expect(decision).not.toContain("one researcher plus one synthesizer");
    expect(decision).toContain("one researcher only");
  });
});
