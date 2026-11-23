import { z } from "zod";

export const RESEARCH_EXPERIMENT_LIMITS = {
  recordBytes: 1_048_576,
  conditions: 32,
  tasks: 2_000,
  assignments: 2_000,
  attempts: 4_000,
  resources: 8_000,
  endpoints: 24,
} as const;

export const RESEARCH_CLAIMS = [
  "transfer", "revision", "durability", "autonomy", "sustainability", "participation",
] as const;
export const RESEARCH_CONTROLS = [
  "returning_room", "shared_repository", "parallel_nonsharing", "no_memory",
  "raw_transcript", "ordinary_retrieval", "v0_learner",
] as const;
export const RESEARCH_MATCHING_DIMENSIONS = [
  "model_versions", "tool_versions", "information", "schedule", "total_compute",
  "review_and_selection", "human_help",
] as const;
export const RESEARCH_RESOURCE_CATEGORIES = [
  "generation", "coordination", "review", "retrieval", "proof", "storage", "human", "other",
] as const;
export const RESEARCH_EVIDENCE_CLASSES = [
  "synthetic", "local_chain", "native_execution", "real_provider", "production_serving",
] as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const text = z.string().trim().min(1).max(2_000);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,59})$/);
const timestamp = z.iso.datetime();
export const researchArtifactReference = z.object({
  ref: id,
  sha256: digest,
  version: z.string().trim().min(1).max(200),
}).strict();

const revision = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pinned"), value: text }).strict(),
  z.object({ status: z.literal("undisclosed"), reason: text }).strict(),
]);
const component = z.object({
  id,
  provider: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  revision,
  configuration_sha256: digest,
}).strict();
const condition = z.object({
  condition_id: id,
  description: text,
  intervention: researchArtifactReference,
  model_ids: z.array(id).min(1).max(32),
  tool_ids: z.array(id).max(64),
}).strict();
const endpoint = z.object({
  endpoint_id: id,
  claim: z.enum(RESEARCH_CLAIMS),
  role: z.enum(["primary", "secondary"]),
  metric: text,
  unit: z.string().trim().min(1).max(100),
  direction: z.enum(["higher_is_better", "lower_is_better"]),
  control_condition_id: id,
  treatment_condition_id: id,
  evaluator: researchArtifactReference,
  decision_rule: researchArtifactReference,
  uncertainty_method: researchArtifactReference,
}).strict();

export const researchPreregistration = z.object({
  schema_version: z.literal("spawn.research-preregistration.v1"),
  experiment_id: id,
  question: text,
  registered_at: timestamp,
  phase: z.enum(["pilot", "confirmatory"]),
  assignment_manifest_sha256: digest,
  models: z.array(component).min(1).max(32),
  tools: z.array(component).max(64),
  conditions: z.array(condition).min(2).max(RESEARCH_EXPERIMENT_LIMITS.conditions),
  controls: z.array(z.object({
    control: z.enum(RESEARCH_CONTROLS),
    disposition: z.enum(["included", "not_applicable"]),
    condition_ids: z.array(id).max(RESEARCH_EXPERIMENT_LIMITS.conditions),
    rationale: text,
  }).strict()).length(RESEARCH_CONTROLS.length),
  matching: z.array(z.object({
    dimension: z.enum(RESEARCH_MATCHING_DIMENSIONS),
    status: z.enum(["matched", "unmatched", "not_applicable"]),
    basis: researchArtifactReference,
    explanation: text,
  }).strict()).length(RESEARCH_MATCHING_DIMENSIONS.length),
  assignment: z.object({
    unit: z.enum(["room", "lineage", "cohort"]),
    analysis_unit: z.enum(["room", "lineage", "cohort"]),
    sharing_interference: z.boolean(),
    method: z.enum(["randomized", "blocked_randomized", "nonrandom"]),
    procedure: researchArtifactReference,
  }).strict(),
  tasks: z.array(z.object({
    task_id: id,
    split: z.enum(["practice", "heldout"]),
    artifact: researchArtifactReference,
    rights: researchArtifactReference,
  }).strict()).min(1).max(RESEARCH_EXPERIMENT_LIMITS.tasks),
  endpoints: z.array(endpoint).min(1).max(RESEARCH_EXPERIMENT_LIMITS.endpoints),
  sampling: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pilot"),
      feasibility_rule: researchArtifactReference,
    }).strict(),
    z.object({
      kind: z.literal("confirmatory"),
      pilot_record: researchArtifactReference,
      sample_size_rule: researchArtifactReference,
      target_assignment_units: integer.positive(),
      locked_at: timestamp,
    }).strict(),
  ]),
  analysis_plan: researchArtifactReference,
  missing_outcomes_rule: researchArtifactReference,
}).strict();
export type ResearchPreregistration = z.infer<typeof researchPreregistration>;

const assignment = z.object({
  assignment_id: id,
  unit_id: id,
  lineage_id: id,
  condition_id: id,
  eligibility: z.enum(["eligible", "ineligible", "unknown"]),
  eligibility_reason: text,
  attempt_ids: z.array(id).max(RESEARCH_EXPERIMENT_LIMITS.attempts),
}).strict();
const attempt = z.object({
  attempt_id: id,
  assignment_id: id,
  task_id: id,
  status: z.enum(["planned", "not_started", "completed", "failed", "abandoned", "unknown"]),
  status_reason: text,
  started_at: timestamp.nullable(),
  ended_at: timestamp.nullable(),
  holdout_exposure: z.enum(["unexposed", "contaminated", "unknown"]),
  evidence_classes: z.array(z.enum(RESEARCH_EVIDENCE_CLASSES)).max(RESEARCH_EVIDENCE_CLASSES.length),
  evidence: z.array(researchArtifactReference).max(32),
  native_references: z.array(z.object({
    kind: z.enum(["original_effect", "reservation", "settlement", "receipt"]),
    artifact: researchArtifactReference,
  }).strict()).max(16),
  measurements: z.array(z.object({
    endpoint_id: id,
    observation: z.discriminatedUnion("status", [
      z.object({ status: z.literal("observed"), value: z.number().finite(), evidence: researchArtifactReference }).strict(),
      z.object({ status: z.literal("missing"), reason: text }).strict(),
    ]),
  }).strict()).max(RESEARCH_EXPERIMENT_LIMITS.endpoints),
}).strict();

const money = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("external_cost"), micro_usd: amount, basis: z.enum(["observed", "estimated"]), evidence: researchArtifactReference }).strict(),
  z.object({ kind: z.literal("internal_transfer"), micro_usd: amount, evidence: researchArtifactReference }).strict(),
  z.object({ kind: z.literal("subsidy"), micro_usd: amount, evidence: researchArtifactReference }).strict(),
  z.object({ kind: z.literal("unknown"), reason: text }).strict(),
  z.object({ kind: z.literal("not_applicable"), reason: text }).strict(),
]);
const resourceEntry = z.object({
  entry_id: id,
  economic_fact_id: id,
  attempt_id: id.nullable(),
  category: z.enum(RESEARCH_RESOURCE_CATEGORIES),
  scope: z.enum(["experiment", "inherited_knowledge_production"]),
  knowledge_artifact: researchArtifactReference.nullable(),
  usage: z.array(z.object({
    unit: z.enum(["input_tokens", "output_tokens", "cpu_ms", "gpu_ms", "wall_ms", "storage_byte_seconds", "human_ms", "requests"]),
    amount,
  }).strict()).max(8),
  money,
  source: researchArtifactReference,
}).strict();
const analysis = z.object({
  endpoint_id: id,
  finding: z.enum(["positive", "negative", "inconclusive", "not_evaluated"]),
  estimate: z.number().finite().nullable(),
  uncertainty: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("interval"), lower: z.number().finite(), upper: z.number().finite(), level: z.number().gt(0).lt(1) }).strict(),
    z.object({ kind: z.literal("not_estimated"), reason: text }).strict(),
  ]),
  included_attempt_ids: z.array(id).max(RESEARCH_EXPERIMENT_LIMITS.attempts),
  excluded_attempts: z.array(z.object({ attempt_id: id, reason: text }).strict()).max(RESEARCH_EXPERIMENT_LIMITS.attempts),
  evidence: researchArtifactReference.nullable(),
  interpretation: text,
}).strict();

export const researchExperimentRecord = z.object({
  schema_version: z.literal("spawn.research-experiment.v1"),
  preregistration: researchPreregistration,
  preregistration_sha256: digest,
  recorded_at: timestamp,
  record_status: z.enum(["collecting", "closed"]),
  evidence_mode: z.enum(["synthetic", "observed"]),
  assignments: z.array(assignment).max(RESEARCH_EXPERIMENT_LIMITS.assignments),
  attempts: z.array(attempt).max(RESEARCH_EXPERIMENT_LIMITS.attempts),
  resources: z.object({
    coverage: z.array(z.object({
      category: z.enum(RESEARCH_RESOURCE_CATEGORIES),
      status: z.enum(["recorded", "unknown", "not_applicable"]),
      explanation: text,
    }).strict()).length(RESEARCH_RESOURCE_CATEGORIES.length),
    entries: z.array(resourceEntry).max(RESEARCH_EXPERIMENT_LIMITS.resources),
  }).strict(),
  analyses: z.array(analysis).max(RESEARCH_EXPERIMENT_LIMITS.endpoints),
  limitations: z.array(text).min(1).max(64),
}).strict();
export type ResearchExperimentRecord = z.infer<typeof researchExperimentRecord>;
