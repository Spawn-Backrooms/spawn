import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RESEARCH_EXPERIMENT_LIMITS,
  researchExperimentRecord,
  type ResearchExperimentRecord,
} from "../../../src/api/researchExperimentSchemas";
import {
  hashResearchAssignmentManifest,
  hashResearchPreregistration,
  summarizeResearchExperiment,
  validateResearchExperimentRecord,
  validateResearchPreregistration,
} from "../../src/core/research-experiment-record";

function fixture(name = "negative"): ResearchExperimentRecord {
  return researchExperimentRecord.parse(JSON.parse(readFileSync(
    new URL(`../fixtures/research-experiment.${name}.synthetic.v1.json`, import.meta.url), "utf8",
  )));
}

function register(record: ResearchExperimentRecord): ResearchExperimentRecord {
  record.preregistration.assignment_manifest_sha256 = hashResearchAssignmentManifest(record);
  record.preregistration_sha256 = hashResearchPreregistration(record.preregistration);
  return record;
}

describe("scientific experiment records", () => {
  it.each(["negative", "missing", "zero-cohorts"])("accepts the released %s synthetic fixture", (name) => {
    const record = fixture(name);
    expect(validateResearchExperimentRecord(record)).toEqual(record);
  });

  it("keeps a negative result and failed/abandoned attempts", () => {
    const summary = summarizeResearchExperiment(fixture());
    expect(summary.findings).toEqual([{ endpoint_id: "transfer-success", finding: "negative" }]);
    expect(summary.attempt_statuses).toMatchObject({ completed: 2, failed: 1, abandoned: 1, unknown: 0 });
    expect(summary.evidence_mode).toBe("synthetic");
    expect(summary.authority).toBe("descriptive_only");
  });

  it("preserves zero eligible cohorts without a score or amortized cost", () => {
    const summary = summarizeResearchExperiment(fixture("zero-cohorts"));
    expect(summary.eligible_assignment_units).toBe(0);
    expect(summary.findings[0].finding).toBe("not_evaluated");
    expect(summary.amortized_actual_per_eligible_scheduled_attempt).toBeNull();
  });

  it("retains unknown and unstarted attempts without assuming zero cost", () => {
    const summary = summarizeResearchExperiment(fixture("missing"));
    expect(summary.attempt_statuses).toMatchObject({ unknown: 1, not_started: 1, failed: 1, abandoned: 1 });
    expect(summary.unknown_money_entries).toBe(1);
    expect(summary.full_actual_external_micro_usd).toBeNull();
    expect(summary.amortized_actual_per_eligible_scheduled_attempt).toBeNull();
  });

  it("rejects a changed preregistration instead of trusting its old digest", () => {
    const record = fixture();
    record.preregistration.endpoints[0].metric = "A different outcome selected after observation";
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_PREREGISTRATION_CHANGED");
  });

  it("checks an external frozen digest even when an editor recomputes a replacement digest", () => {
    const record = fixture();
    const expectedPreregistrationHash = record.preregistration_sha256;
    expect(summarizeResearchExperiment(record, { expectedPreregistrationHash }).preregistration_binding).toBe("matched_expected");
    record.preregistration.question = "A replacement hypothesis";
    register(record);
    expect(() => validateResearchExperimentRecord(record, { expectedPreregistrationHash }))
      .toThrow("RESEARCH_PREREGISTRATION_NOT_EXPECTED");
  });

  it("labels self-consistency when no external preregistration is supplied", () => {
    expect(summarizeResearchExperiment(fixture()).preregistration_binding).toBe("self_consistent_only");
  });

  it("detects removal of a failed attempt from both roster and record", () => {
    const record = fixture();
    record.attempts.splice(1, 1);
    record.assignments[0].attempt_ids.splice(1, 1);
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_ASSIGNMENT_MANIFEST_CHANGED");
  });

  it("detects task replacement under a frozen assignment", () => {
    const record = fixture();
    record.attempts[0].task_id = "task-b";
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_ASSIGNMENT_MANIFEST_CHANGED");
  });

  it("does not bind the assignment manifest to outcome status or array order", () => {
    const record = fixture();
    const digest = hashResearchAssignmentManifest(record);
    record.assignments.reverse();
    record.attempts.reverse();
    record.attempts[0].status = "unknown";
    expect(hashResearchAssignmentManifest(record)).toBe(digest);
  });

  it("rejects an incomplete ledger even if its replacement manifest was registered", () => {
    const record = fixture();
    record.attempts.pop();
    register(record);
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_ATTEMPT_LEDGER_INCOMPLETE");
  });

  it("requires the analysis to disclose every excluded attempt", () => {
    const record = fixture();
    record.analyses[0].included_attempt_ids.pop();
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_ANALYSIS_DROPPED_ATTEMPT");
  });

  it("rejects an unknown outcome represented as an observed success", () => {
    const record = fixture("missing");
    record.attempts[4].measurements[0].observation = {
      status: "observed", value: 1, evidence: record.attempts[0].evidence[0],
    };
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_UNKNOWN_IS_NOT_OBSERVED");
  });

  it("rejects contaminated or practice tasks in a confirmatory analysis", () => {
    const contaminated = fixture();
    contaminated.attempts[0].holdout_exposure = "contaminated";
    expect(() => validateResearchExperimentRecord(contaminated)).toThrow("RESEARCH_CONFIRMATORY_HOLDOUT_INVALID");
    const practice = fixture();
    practice.preregistration.tasks[0].split = "practice";
    register(practice);
    expect(() => validateResearchExperimentRecord(practice)).toThrow("RESEARCH_CONFIRMATORY_HOLDOUT_INVALID");
  });

  it("rejects the same artifact in practice and held-out splits", () => {
    const plan = fixture().preregistration;
    plan.tasks[0].split = "practice";
    plan.tasks[1].artifact.sha256 = plan.tasks[0].artifact.sha256;
    expect(() => validateResearchPreregistration(plan)).toThrow("RESEARCH_HOLDOUT_OVERLAP");
  });

  it("requires clustered assignment when sharing causes interference", () => {
    const plan = fixture().preregistration;
    plan.assignment.unit = "room";
    plan.assignment.analysis_unit = "room";
    expect(() => validateResearchPreregistration(plan)).toThrow("RESEARCH_SHARING_REQUIRES_CLUSTER");
  });

  it("does not let repeated attempts stand in for independent lineages", () => {
    const record = fixture();
    record.assignments[1].lineage_id = record.assignments[0].lineage_id;
    register(record);
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_DUPLICATE_LINEAGE_UNIT");
  });

  it("requires sample-size freezing before confirmatory registration", () => {
    const plan = fixture().preregistration;
    if (plan.sampling.kind !== "confirmatory") throw new Error("fixture phase");
    plan.sampling.locked_at = "2026-11-23T01:00:00.000Z";
    expect(() => validateResearchPreregistration(plan)).toThrow("RESEARCH_SAMPLE_SIZE_NOT_FROZEN");
  });

  it("rejects a decisive confirmatory finding below the registered independent-unit target", () => {
    const record = fixture();
    if (record.preregistration.sampling.kind !== "confirmatory") throw new Error("fixture phase");
    record.preregistration.sampling.target_assignment_units = 4;
    register(record);
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_CONFIRMATORY_SAMPLE_INCOMPLETE");
  });

  it("requires every control and matching dimension to have one disposition", () => {
    const plan = fixture().preregistration;
    plan.controls[0] = plan.controls[1];
    expect(() => validateResearchPreregistration(plan)).toThrow("RESEARCH_CONTROL_COVERAGE");
    const other = fixture().preregistration;
    other.matching[0] = other.matching[1];
    expect(() => validateResearchPreregistration(other)).toThrow("RESEARCH_MATCHING_COVERAGE");
  });

  it("rejects matched model claims when conditions select different pins", () => {
    const plan = fixture().preregistration;
    plan.models.push({ ...plan.models[0], id: "different-model" });
    plan.conditions[1].model_ids = ["different-model"];
    expect(() => validateResearchPreregistration(plan)).toThrow("RESEARCH_MATCHED_COMPONENTS_DIFFER");
  });

  it("reports undisclosed component versions rather than inventing a pin", () => {
    const record = fixture();
    record.preregistration.models[0].revision = { status: "undisclosed", reason: "The fixture provider does not expose a weight revision." };
    register(record);
    expect(summarizeResearchExperiment(record).undisclosed_component_revisions).toEqual(["fixture-model"]);
  });

  it("keeps synthetic evidence separate from observed provider or production evidence", () => {
    const record = fixture();
    record.attempts[0].evidence_classes.push("real_provider");
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_EVIDENCE_MODE_MISMATCH");
  });

  it("rejects an interval that does not contain its reported estimate", () => {
    const record = fixture();
    record.analyses[0].uncertainty = { kind: "interval", lower: 0, upper: 1, level: 0.95 };
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_UNCERTAINTY_INTERVAL");
  });

  it("cannot label zero cohorts as a positive result", () => {
    const record = fixture("zero-cohorts");
    record.analyses[0].finding = "positive";
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_RESULT_WITHOUT_OBSERVATIONS");
  });

  it("bounds input size and rejects authority fields", () => {
    const record = fixture();
    expect(() => validateResearchExperimentRecord({ ...record, grant_execution: true })).toThrow();
    record.limitations = ["x".repeat(RESEARCH_EXPERIMENT_LIMITS.recordBytes)];
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_RECORD_TOO_LARGE");
  });
});

describe("descriptive research resource accounting", () => {
  it("includes inherited production, failures, review, retrieval, storage and human effort", () => {
    const summary = summarizeResearchExperiment(fixture());
    expect(summary.full_actual_external_micro_usd).toBe("1002000");
    expect(summary.usage.human_ms).toBe("60000");
    expect(summary.amortized_actual_per_eligible_scheduled_attempt)
      .toEqual({ numerator_micro_usd: "1002000", denominator_attempts: 4 });
  });

  it("rejects counting the same economic fact twice under different entry IDs", () => {
    const record = fixture();
    record.resources.entries.push({ ...record.resources.entries[0], entry_id: "duplicate-charge" });
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_DUPLICATE_ECONOMIC_FACT");
  });

  it("does not add transfers or subsidies to external cost", () => {
    const record = fixture();
    const entry = record.resources.entries[0];
    for (const kind of ["internal_transfer", "subsidy"] as const) record.resources.entries.push({
      ...entry, entry_id: kind, economic_fact_id: kind, category: "other", scope: "experiment",
      knowledge_artifact: null, usage: [], money: { kind, micro_usd: "5000000", evidence: entry.source },
    });
    record.resources.coverage.find((item) => item.category === "other")!.status = "not_applicable";
    const summary = summarizeResearchExperiment(record);
    expect(summary.full_actual_external_micro_usd).toBe("1002000");
    expect(summary.internal_transfer_micro_usd).toBe("5000000");
    expect(summary.subsidy_micro_usd).toBe("5000000");
  });

  it("uses integer arithmetic above JavaScript's safe integer range", () => {
    const record = fixture();
    const entry = record.resources.entries[0];
    if (entry.money.kind !== "external_cost") throw new Error("fixture cost");
    entry.money.micro_usd = "9007199254740993";
    expect(summarizeResearchExperiment(record).full_actual_external_micro_usd).toBe("9007199254742993");
  });

  it("keeps human-category transfers and subsidies separate from measured human effort", () => {
    const record = fixture();
    const human = record.resources.entries.find((entry) => entry.category === "human")!;
    for (const kind of ["internal_transfer", "subsidy"] as const) record.resources.entries.push({
      ...human, entry_id: kind, economic_fact_id: kind, usage: [],
      money: { kind, micro_usd: "5000000", evidence: human.source },
    });
    const summary = summarizeResearchExperiment(record);
    expect(summary.usage.human_ms).toBe("60000");
    expect(summary.full_actual_external_micro_usd).toBe("1002000");
    expect(summary.internal_transfer_micro_usd).toBe("5000000");
    expect(summary.subsidy_micro_usd).toBe("5000000");
    record.resources.entries.at(-1)!.usage = [...human.usage];
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_TRANSFER_DUPLICATES_USAGE");
  });

  it("still requires human effort on actual human resource entries", () => {
    const record = fixture();
    record.resources.entries.find((entry) => entry.category === "human")!.usage = [];
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_HUMAN_EFFORT_MISSING");
  });

  it.each(["internal_transfer", "subsidy"] as const)(
    "does not let a %s replace recorded human resource coverage", (kind) => {
      const record = fixture();
      const human = record.resources.entries.find((entry) => entry.category === "human")!;
      human.usage = [];
      human.money = { kind, micro_usd: "5000000", evidence: human.source };
      const coverage = record.resources.coverage.find((item) => item.category === "human")!;
      expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_RECORDED_RESOURCE_MISSING");

      coverage.status = "unknown";
      const unknown = summarizeResearchExperiment(record);
      expect(unknown.unknown_resource_categories).toEqual(["human"]);
      expect(unknown.usage.human_ms).toBeUndefined();
      expect(unknown.full_actual_external_micro_usd).toBeNull();
      expect(unknown.amortized_actual_per_eligible_scheduled_attempt).toBeNull();

      coverage.status = "not_applicable";
      const unused = summarizeResearchExperiment(record);
      expect(unused.usage.human_ms).toBeUndefined();
      expect(unused.full_actual_external_micro_usd).toBe("1002000");
      expect(unused.internal_transfer_micro_usd).toBe(kind === "internal_transfer" ? "5000000" : "0");
      expect(unused.subsidy_micro_usd).toBe(kind === "subsidy" ? "5000000" : "0");
    },
  );

  it("does not call a zero-valued estimate an observed complete cost", () => {
    const record = fixture();
    const money = record.resources.entries[0].money;
    if (money.kind !== "external_cost") throw new Error("fixture cost");
    money.micro_usd = "0";
    money.basis = "estimated";
    const summary = summarizeResearchExperiment(record);
    expect(summary.estimated_money_entries).toBe(1);
    expect(summary.full_actual_external_micro_usd).toBeNull();
  });

  it("does not equate unmeasured proof costs with zero", () => {
    const record = fixture();
    record.resources.coverage.find((item) => item.category === "proof")!.status = "unknown";
    const summary = summarizeResearchExperiment(record);
    expect(summary.unknown_resource_categories).toEqual(["proof"]);
    expect(summary.full_actual_external_micro_usd).toBeNull();
  });

  it("requires an inherited knowledge cost to name its source artifact", () => {
    const record = fixture();
    record.resources.entries[0].knowledge_artifact = null;
    expect(() => validateResearchExperimentRecord(record)).toThrow("RESEARCH_INHERITED_COST_BINDING");
  });

  it("does not amortize against a partly unknown eligibility denominator", () => {
    const record = fixture();
    record.assignments[1].eligibility = "unknown";
    const analysis = record.analyses[0];
    analysis.finding = "inconclusive";
    analysis.included_attempt_ids = ["attempt-1", "attempt-2"];
    analysis.excluded_attempts = ["attempt-3", "attempt-4"].map((attempt_id) => ({ attempt_id, reason: "Eligibility remains unknown." }));
    const summary = summarizeResearchExperiment(record);
    expect(summary.unknown_eligibility_units).toBe(1);
    expect(summary.full_actual_external_micro_usd).toBe("1002000");
    expect(summary.amortized_actual_per_eligible_scheduled_attempt).toBeNull();
  });
});
