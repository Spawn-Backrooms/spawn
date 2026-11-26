import {
  RESEARCH_CONTROLS,
  RESEARCH_EXPERIMENT_LIMITS,
  RESEARCH_MATCHING_DIMENSIONS,
  RESEARCH_RESOURCE_CATEGORIES,
  researchExperimentRecord,
  researchPreregistration,
  type ResearchExperimentRecord,
  type ResearchPreregistration,
} from "../../../src/api/researchExperimentSchemas";
import { assert, DomainError, hash } from "../common";

function unique(values: readonly string[], code: string): void {
  assert(new Set(values).size === values.length, code, 422);
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  const expectedSet = new Set(expected);
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    actual.every((value) => expectedSet.has(value));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bounded(value: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new DomainError("RESEARCH_RECORD_NOT_JSON", 422);
  }
  assert(encoded !== undefined, "RESEARCH_RECORD_NOT_JSON", 422);
  assert(new TextEncoder().encode(encoded).length <= RESEARCH_EXPERIMENT_LIMITS.recordBytes,
    "RESEARCH_RECORD_TOO_LARGE", 413);
}

export function validateResearchPreregistration(value: unknown): ResearchPreregistration {
  bounded(value);
  const plan = researchPreregistration.parse(value);
  for (const [kind, values] of [
    ["MODEL", plan.models.map((item) => item.id)],
    ["TOOL", plan.tools.map((item) => item.id)],
    ["CONDITION", plan.conditions.map((item) => item.condition_id)],
    ["TASK", plan.tasks.map((item) => item.task_id)],
    ["ENDPOINT", plan.endpoints.map((item) => item.endpoint_id)],
  ] as const) unique(values, `RESEARCH_DUPLICATE_${kind}`);
  assert(sameMembers(plan.controls.map((item) => item.control), RESEARCH_CONTROLS),
    "RESEARCH_CONTROL_COVERAGE", 422);
  assert(sameMembers(plan.matching.map((item) => item.dimension), RESEARCH_MATCHING_DIMENSIONS),
    "RESEARCH_MATCHING_COVERAGE", 422);
  const conditions = new Set(plan.conditions.map((item) => item.condition_id));
  const models = new Set(plan.models.map((item) => item.id));
  const tools = new Set(plan.tools.map((item) => item.id));
  for (const condition of plan.conditions) {
    unique(condition.model_ids, "RESEARCH_DUPLICATE_MODEL_REFERENCE");
    unique(condition.tool_ids, "RESEARCH_DUPLICATE_TOOL_REFERENCE");
    assert(condition.model_ids.every((item) => models.has(item)) &&
      condition.tool_ids.every((item) => tools.has(item)), "RESEARCH_COMPONENT_REFERENCE", 422);
  }
  for (const control of plan.controls) {
    unique(control.condition_ids, "RESEARCH_DUPLICATE_CONTROL_REFERENCE");
    assert(control.condition_ids.every((item) => conditions.has(item)), "RESEARCH_CONTROL_REFERENCE", 422);
    assert(control.disposition === "included" ? control.condition_ids.length > 0 : control.condition_ids.length === 0,
      "RESEARCH_CONTROL_DISPOSITION", 422);
  }
  for (const [dimension, field] of [["model_versions", "model_ids"], ["tool_versions", "tool_ids"]] as const) {
    if (plan.matching.find((item) => item.dimension === dimension)?.status === "matched")
      assert(plan.conditions.every((item) => sameMembers(item[field], plan.conditions[0][field])),
        "RESEARCH_MATCHED_COMPONENTS_DIFFER", 422);
  }
  assert(plan.assignment.unit === plan.assignment.analysis_unit, "RESEARCH_ANALYSIS_UNIT_MISMATCH", 422);
  assert(!plan.assignment.sharing_interference || plan.assignment.unit !== "room",
    "RESEARCH_SHARING_REQUIRES_CLUSTER", 422);
  const practice = new Set(plan.tasks.filter((item) => item.split === "practice").map((item) => item.artifact.sha256));
  assert(plan.tasks.every((item) => item.split !== "heldout" || !practice.has(item.artifact.sha256)),
    "RESEARCH_HOLDOUT_OVERLAP", 422);
  assert(plan.phase === plan.sampling.kind, "RESEARCH_PHASE_SAMPLING_MISMATCH", 422);
  if (plan.sampling.kind === "confirmatory") {
    assert(Date.parse(plan.sampling.locked_at) <= Date.parse(plan.registered_at),
      "RESEARCH_SAMPLE_SIZE_NOT_FROZEN", 422);
    assert(plan.tasks.some((item) => item.split === "heldout"), "RESEARCH_HOLDOUT_REQUIRED", 422);
  }
  for (const endpoint of plan.endpoints)
    assert(conditions.has(endpoint.control_condition_id) && conditions.has(endpoint.treatment_condition_id) &&
      endpoint.control_condition_id !== endpoint.treatment_condition_id,
    "RESEARCH_ENDPOINT_COMPARISON", 422);
  return plan;
}

export function hashResearchPreregistration(value: unknown): string {
  return hash(validateResearchPreregistration(value));
}

export function hashResearchAssignmentManifest(record: Pick<ResearchExperimentRecord, "assignments" | "attempts">): string {
  return hash({
    assignments: record.assignments.map(({ assignment_id, unit_id, lineage_id, condition_id, attempt_ids }) => ({
      assignment_id, unit_id, lineage_id, condition_id, attempt_ids: [...attempt_ids].sort(),
    })).sort((a, b) => compareIds(a.assignment_id, b.assignment_id)),
    attempts: record.attempts.map(({ attempt_id, assignment_id, task_id }) => ({ attempt_id, assignment_id, task_id }))
      .sort((a, b) => compareIds(a.attempt_id, b.attempt_id)),
  });
}

export interface ResearchRecordValidationOptions {
  expectedPreregistrationHash?: string;
}

export function validateResearchExperimentRecord(
  value: unknown,
  options: ResearchRecordValidationOptions = {},
): ResearchExperimentRecord {
  bounded(value);
  const record = researchExperimentRecord.parse(value);
  const plan = validateResearchPreregistration(record.preregistration);
  assert(record.preregistration_sha256 === hash(plan), "RESEARCH_PREREGISTRATION_CHANGED", 422);
  if (options.expectedPreregistrationHash !== undefined)
    assert(record.preregistration_sha256 === options.expectedPreregistrationHash,
      "RESEARCH_PREREGISTRATION_NOT_EXPECTED", 422);
  assert(plan.assignment_manifest_sha256 === hashResearchAssignmentManifest(record),
    "RESEARCH_ASSIGNMENT_MANIFEST_CHANGED", 422);
  const registeredAt = Date.parse(plan.registered_at);
  const recordedAt = Date.parse(record.recorded_at);
  assert(recordedAt >= registeredAt, "RESEARCH_RECORD_BEFORE_REGISTRATION", 422);
  unique(record.assignments.map((item) => item.assignment_id), "RESEARCH_DUPLICATE_ASSIGNMENT");
  unique(record.assignments.map((item) => item.unit_id), "RESEARCH_DUPLICATE_ASSIGNMENT_UNIT");
  if (plan.assignment.unit === "lineage")
    unique(record.assignments.map((item) => item.lineage_id), "RESEARCH_DUPLICATE_LINEAGE_UNIT");
  unique(record.attempts.map((item) => item.attempt_id), "RESEARCH_DUPLICATE_ATTEMPT");
  const expectedAttempts = record.assignments.flatMap((item) => item.attempt_ids);
  unique(expectedAttempts, "RESEARCH_ATTEMPT_ASSIGNED_TWICE");
  const attempts = new Map(record.attempts.map((item) => [item.attempt_id, item]));
  assert(sameMembers([...attempts.keys()], expectedAttempts), "RESEARCH_ATTEMPT_LEDGER_INCOMPLETE", 422);
  const assignments = new Map(record.assignments.map((item) => [item.assignment_id, item]));
  const conditions = new Set(plan.conditions.map((item) => item.condition_id));
  const tasks = new Map(plan.tasks.map((item) => [item.task_id, item]));
  const endpoints = new Map(plan.endpoints.map((item) => [item.endpoint_id, item]));
  for (const assignment of record.assignments)
    assert(conditions.has(assignment.condition_id), "RESEARCH_ASSIGNMENT_CONDITION", 422);
  for (const attempt of record.attempts) {
    const assignment = assignments.get(attempt.assignment_id);
    assert(assignment?.attempt_ids.includes(attempt.attempt_id), "RESEARCH_ATTEMPT_ASSIGNMENT", 422);
    assert(tasks.has(attempt.task_id), "RESEARCH_ATTEMPT_TASK", 422);
    assert(sameMembers(attempt.measurements.map((item) => item.endpoint_id), [...endpoints.keys()]),
      "RESEARCH_MEASUREMENT_COVERAGE", 422);
    unique(attempt.evidence_classes, "RESEARCH_DUPLICATE_EVIDENCE_CLASS");
    assert(record.evidence_mode === "synthetic"
      ? attempt.evidence_classes.every((item) => item === "synthetic")
      : !attempt.evidence_classes.includes("synthetic"), "RESEARCH_EVIDENCE_MODE_MISMATCH", 422);
    const notStarted = attempt.status === "planned" || attempt.status === "not_started";
    if (notStarted) assert(attempt.started_at === null && attempt.ended_at === null,
      "RESEARCH_UNSTARTED_TIMESTAMPS", 422);
    if (notStarted || attempt.status === "unknown")
      assert(attempt.measurements.every((item) => item.observation.status === "missing"),
        "RESEARCH_UNKNOWN_IS_NOT_OBSERVED", 422);
    if (["completed", "failed", "abandoned"].includes(attempt.status)) {
      assert(attempt.started_at !== null && attempt.ended_at !== null, "RESEARCH_TERMINAL_TIMESTAMPS", 422);
      assert(attempt.evidence_classes.length > 0 && attempt.evidence.length > 0,
        "RESEARCH_TERMINAL_EVIDENCE_MISSING", 422);
    }
    if (record.record_status === "closed")
      assert(attempt.status !== "planned", "RESEARCH_CLOSED_WITH_PLANNED_ATTEMPTS", 422);
    const started = attempt.started_at === null ? null : Date.parse(attempt.started_at);
    const ended = attempt.ended_at === null ? null : Date.parse(attempt.ended_at);
    if (started !== null) assert(started >= registeredAt && started <= recordedAt,
      "RESEARCH_ATTEMPT_OUTSIDE_REGISTRATION", 422);
    if (ended !== null) assert(started !== null && ended >= started && ended <= recordedAt,
      "RESEARCH_ATTEMPT_TIME_ORDER", 422);
  }
  assert(sameMembers(record.resources.coverage.map((item) => item.category), RESEARCH_RESOURCE_CATEGORIES),
    "RESEARCH_RESOURCE_COVERAGE", 422);
  unique(record.resources.entries.map((item) => item.entry_id), "RESEARCH_DUPLICATE_RESOURCE_ENTRY");
  unique(record.resources.entries.map((item) => item.economic_fact_id), "RESEARCH_DUPLICATE_ECONOMIC_FACT");
  for (const entry of record.resources.entries) {
    assert(entry.attempt_id === null || attempts.has(entry.attempt_id), "RESEARCH_RESOURCE_ATTEMPT", 422);
    assert(entry.scope !== "inherited_knowledge_production" ||
      (entry.knowledge_artifact !== null && entry.attempt_id === null), "RESEARCH_INHERITED_COST_BINDING", 422);
    unique(entry.usage.map((item) => item.unit), "RESEARCH_DUPLICATE_USAGE_UNIT");
    const financialAnnotation = entry.money.kind === "internal_transfer" || entry.money.kind === "subsidy";
    if (financialAnnotation)
      assert(entry.usage.length === 0, "RESEARCH_TRANSFER_DUPLICATES_USAGE", 422);
    if (entry.category === "human" && !financialAnnotation) assert(entry.usage.some((item) => item.unit === "human_ms"),
      "RESEARCH_HUMAN_EFFORT_MISSING", 422);
  }
  for (const coverage of record.resources.coverage) {
    const entries = record.resources.entries.filter((item) => item.category === coverage.category &&
      item.money.kind !== "internal_transfer" && item.money.kind !== "subsidy");
    assert(coverage.status !== "recorded" || entries.length > 0, "RESEARCH_RECORDED_RESOURCE_MISSING", 422);
    assert(coverage.status !== "not_applicable" || entries.length === 0, "RESEARCH_RESOURCE_NOT_APPLICABLE", 422);
  }
  if (record.attempts.some((item) => item.evidence_classes.includes("real_provider")))
    assert(record.resources.coverage.find((item) => item.category === "generation")?.status !== "not_applicable",
      "RESEARCH_PROVIDER_COST_UNACCOUNTED", 422);
  unique(record.analyses.map((item) => item.endpoint_id), "RESEARCH_DUPLICATE_ANALYSIS");
  if (record.record_status === "closed")
    assert(sameMembers(record.analyses.map((item) => item.endpoint_id), [...endpoints.keys()]),
      "RESEARCH_ANALYSIS_COVERAGE", 422);
  for (const analysis of record.analyses) {
    const endpoint = endpoints.get(analysis.endpoint_id);
    assert(endpoint, "RESEARCH_ANALYSIS_ENDPOINT", 422);
    const represented = [...analysis.included_attempt_ids, ...analysis.excluded_attempts.map((item) => item.attempt_id)];
    assert(sameMembers(represented, [...attempts.keys()]), "RESEARCH_ANALYSIS_DROPPED_ATTEMPT", 422);
    const includedConditions = new Set<string>();
    const includedUnits = new Set<string>();
    for (const attemptId of analysis.included_attempt_ids) {
      const attempt = attempts.get(attemptId)!;
      const assignment = assignments.get(attempt.assignment_id)!;
      assert(assignment.eligibility === "eligible", "RESEARCH_INELIGIBLE_ANALYSIS", 422);
      assert(assignment.condition_id === endpoint.control_condition_id || assignment.condition_id === endpoint.treatment_condition_id,
        "RESEARCH_ANALYSIS_WRONG_COMPARISON", 422);
      assert(attempt.measurements.find((item) => item.endpoint_id === analysis.endpoint_id)?.observation.status === "observed",
        "RESEARCH_MISSING_MEASUREMENT_INCLUDED", 422);
      if (plan.phase === "confirmatory") assert(tasks.get(attempt.task_id)?.split === "heldout" &&
        attempt.holdout_exposure === "unexposed", "RESEARCH_CONFIRMATORY_HOLDOUT_INVALID", 422);
      includedConditions.add(assignment.condition_id);
      includedUnits.add(assignment.unit_id);
    }
    if (analysis.finding === "not_evaluated") {
      assert(analysis.included_attempt_ids.length === 0 && analysis.estimate === null &&
        analysis.uncertainty.kind === "not_estimated", "RESEARCH_UNEVALUATED_HAS_RESULT", 422);
    } else {
      assert(analysis.included_attempt_ids.length > 0 && analysis.estimate !== null && analysis.evidence !== null,
        "RESEARCH_RESULT_WITHOUT_OBSERVATIONS", 422);
    }
    if (analysis.finding === "positive" || analysis.finding === "negative") {
      assert(record.record_status === "closed" && includedConditions.has(endpoint.control_condition_id) &&
        includedConditions.has(endpoint.treatment_condition_id), "RESEARCH_COMPARISON_INCOMPLETE", 422);
      assert(analysis.uncertainty.kind === "interval", "RESEARCH_DECISIVE_UNCERTAINTY_MISSING", 422);
      if (plan.sampling.kind === "confirmatory")
        assert(includedUnits.size >= plan.sampling.target_assignment_units,
          "RESEARCH_CONFIRMATORY_SAMPLE_INCOMPLETE", 422);
    }
    if (analysis.uncertainty.kind === "interval")
      assert(analysis.uncertainty.lower <= analysis.uncertainty.upper && analysis.estimate !== null &&
        analysis.uncertainty.lower <= analysis.estimate && analysis.estimate <= analysis.uncertainty.upper,
      "RESEARCH_UNCERTAINTY_INTERVAL", 422);
  }
  return record;
}

export function summarizeResearchExperiment(value: unknown, options: ResearchRecordValidationOptions = {}) {
  const record = validateResearchExperimentRecord(value, options);
  let observed = 0n, estimated = 0n, transfers = 0n, subsidies = 0n;
  let unknownMoney = 0, estimatedEntries = 0;
  const usage: Record<string, bigint> = {};
  for (const entry of record.resources.entries) {
    for (const item of entry.usage) usage[item.unit] = (usage[item.unit] ?? 0n) + BigInt(item.amount);
    const money = entry.money;
    if (money.kind === "external_cost") {
      if (money.basis === "observed") observed += BigInt(money.micro_usd);
      else { estimated += BigInt(money.micro_usd); estimatedEntries += 1; }
    } else if (money.kind === "internal_transfer") transfers += BigInt(money.micro_usd);
    else if (money.kind === "subsidy") subsidies += BigInt(money.micro_usd);
    else if (money.kind === "unknown") unknownMoney += 1;
  }
  const eligible = record.assignments.filter((item) => item.eligibility === "eligible");
  const eligibleAttempts = eligible.reduce((sum, item) => sum + item.attempt_ids.length, 0);
  const unknownEligibility = record.assignments.filter((item) => item.eligibility === "unknown").length;
  const unknownCategories = record.resources.coverage.filter((item) => item.status === "unknown").map((item) => item.category);
  const completeActual = record.record_status === "closed" && estimatedEntries === 0 && unknownMoney === 0 && unknownCategories.length === 0;
  const statuses = Object.fromEntries(["planned", "not_started", "completed", "failed", "abandoned", "unknown"]
    .map((status) => [status, record.attempts.filter((item) => item.status === status).length]));
  return {
    experiment_id: record.preregistration.experiment_id,
    evidence_mode: record.evidence_mode,
    preregistration_binding: options.expectedPreregistrationHash === undefined
      ? "self_consistent_only" as const : "matched_expected" as const,
    assignment_unit: record.preregistration.assignment.unit,
    eligible_assignment_units: eligible.length,
    unknown_eligibility_units: unknownEligibility,
    attempt_statuses: statuses,
    observed_external_micro_usd_subtotal: observed.toString(),
    estimated_external_micro_usd_subtotal: estimated.toString(),
    estimated_money_entries: estimatedEntries,
    internal_transfer_micro_usd: transfers.toString(),
    subsidy_micro_usd: subsidies.toString(),
    unknown_money_entries: unknownMoney,
    unknown_resource_categories: unknownCategories,
    full_actual_external_micro_usd: completeActual ? observed.toString() : null,
    amortized_actual_per_eligible_scheduled_attempt: completeActual && eligibleAttempts > 0 && unknownEligibility === 0
      ? { numerator_micro_usd: observed.toString(), denominator_attempts: eligibleAttempts }
      : null,
    usage: Object.fromEntries(Object.entries(usage).map(([unit, total]) => [unit, total.toString()])),
    undisclosed_component_revisions: [...record.preregistration.models, ...record.preregistration.tools]
      .filter((item) => item.revision.status === "undisclosed").map((item) => item.id),
    findings: record.analyses.map((item) => ({ endpoint_id: item.endpoint_id, finding: item.finding })),
    authority: "descriptive_only" as const,
  };
}
