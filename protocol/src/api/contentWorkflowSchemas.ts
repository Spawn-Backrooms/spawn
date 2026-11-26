import { z } from "zod";
import { creatorDefinition } from "./creatorPipelineSchemas";

export const CONTENT_WORKFLOW_LIMITS = {
  workflowsPerRoom: 100,
  evaluationsPerRoom: 500,
  evaluationsPerWorkflow: 20,
  recordBytes: 65_536,
  graphBytes: 262_144,
  graphDepth: 24,
  graphValues: 20_000,
  graphNodes: 500,
  graphLinks: 2_000,
  graphIssues: 100,
} as const;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const score = z.number().int().min(0).max(4);
export const contentWorkflowScores = z
  .object({
    brief_adherence: score,
    visual_quality: score,
    continuity: score,
    technical_delivery: score,
    reusability: score,
  })
  .strict();
export const CONTENT_WORKFLOW_RUBRIC = {
  version: "content-quality-v1",
  dimensions: [
    {
      key: "brief_adherence",
      label: "Brief adherence",
      description:
        "Does the result meet the actual brief and required changes?",
    },
    {
      key: "visual_quality",
      label: "Visual quality",
      description:
        "Check artifacts, composition, lighting and intentional style.",
    },
    {
      key: "continuity",
      label: "Continuity",
      description:
        "Check subject, scene, timing and audio continuity where applicable.",
    },
    {
      key: "technical_delivery",
      label: "Technical delivery",
      description:
        "Check playback, dimensions, duration, crop, captions and audio.",
    },
    {
      key: "reusability",
      label: "Reusability",
      description:
        "Can another run reproduce the intended result with these instructions?",
    },
  ],
  anchors: [
    "Unusable",
    "Major revision",
    "Some revision",
    "Meets brief",
    "Exceeds brief",
  ],
  pass_rule:
    "Every dimension must score at least 3. This is an owner's manual assessment, not provider qualification or mastery.",
} as const;

export const contentWorkflowOutput = z.discriminatedUnion("kind", [
  z
    .object({
      node_id: id,
      kind: z.literal("generated_artifacts"),
      artifact_ids: z.array(id).min(1).max(32),
    })
    .strict(),
  z
    .object({
      node_id: id,
      kind: z.literal("browser_reported_local"),
      sha256: digest,
    })
    .strict(),
]);
export const contentWorkflowSource = z
  .object({
    run_id: id,
    pipeline_id: id,
    run_revision: revision,
    review_id: id,
    review_hash: digest,
    run_updated_at: z.string(),
    outputs: z.array(contentWorkflowOutput).min(1).max(8),
  })
  .strict();
export type ContentWorkflowSource = z.infer<typeof contentWorkflowSource>;

export const contentWorkflowEntry = z
  .object({
    record_version: z.literal(1),
    workflow_id: id,
    room_id: id,
    name: z.string().trim().min(1).max(100),
    summary: z.string().trim().max(2_000),
    tags: z.array(z.string().trim().min(1).max(32)).max(8),
    definition: creatorDefinition,
    definition_hash: digest,
    source: contentWorkflowSource,
    created_at: z.string(),
  })
  .strict();
export type ContentWorkflowEntry = z.infer<typeof contentWorkflowEntry>;
export const contentWorkflowSaveCommand = z
  .object({
    source_run_id: id,
    expected_run_revision: revision,
    expected_room_revision: revision,
    name: z.string().trim().min(1).max(100),
    summary: z.string().trim().max(2_000),
    tags: z.array(z.string().trim().min(1).max(32)).max(8),
  })
  .strict();
export const contentWorkflowEvaluateCommand = z
  .object({
    workflow_id: id,
    creator_run_id: id,
    expected_run_revision: revision,
    expected_room_revision: revision,
    rubric_version: z.literal("content-quality-v1"),
    scores: contentWorkflowScores,
    notes: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const contentWorkflowEvaluation = z
  .object({
    evaluation_id: id,
    workflow_id: id,
    room_id: id,
    run_id: id,
    run_revision: revision,
    definition_hash: digest,
    rubric_version: z.literal("content-quality-v1"),
    scores: contentWorkflowScores,
    notes: z.string().trim().min(1).max(2_000),
    result: z.enum(["manual_pass", "needs_revision"]),
    reviewer: z
      .object({
        kind: z.literal("owner"),
        owner_id: z.string().min(1).max(200),
      })
      .strict(),
    evidence_class: z.literal("server_recorded_run_with_manual_review"),
    source: contentWorkflowSource,
    created_at: z.string(),
  })
  .strict()
  .superRefine((evaluation, issue) => {
    if (
      evaluation.result === "manual_pass" &&
      Object.values(evaluation.scores).some((score) => score < 3)
    )
      issue.addIssue({
        code: "custom",
        message: "manual_pass requires every dimension to score at least 3",
      });
  });
export type ContentWorkflowEvaluation = z.infer<
  typeof contentWorkflowEvaluation
>;

export const contentWorkflowInspectCommand = z
  .object({
    format: z.literal("api"),
    graph_json: z.string().min(1).max(CONTENT_WORKFLOW_LIMITS.graphBytes),
  })
  .strict();
export const comfyGraphInspection = z
  .object({
    inspection_version: z.literal("comfy-inspection-v1"),
    format: z.literal("comfy-api"),
    structurally_valid: z.boolean(),
    execution_status: z.literal("not_admitted"),
    node_count: z.number().int().nonnegative(),
    link_count: z.number().int().nonnegative(),
    signature_snapshot: z.string().max(200),
    classes: z
      .array(
        z
          .object({
            class_type: z.string().max(160),
            node_count: z.number().int().positive(),
            dependency_status: z.literal("unverified"),
            output_count: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(CONTENT_WORKFLOW_LIMITS.graphNodes),
    issues: z
      .array(
        z
          .object({
            severity: z.enum(["error", "warning"]),
            code: z.string().max(80),
            node_id: z.string().max(160).optional(),
            input: z.string().max(160).optional(),
            message: z.string().max(500),
          })
          .strict(),
      )
      .max(CONTENT_WORKFLOW_LIMITS.graphIssues),
    limitations: z.array(z.string().max(500)).min(1).max(10),
  })
  .strict();
export type ComfyGraphInspection = z.infer<typeof comfyGraphInspection>;

export const contentWorkflowCatalog = z
  .object({
    catalog_version: z.literal("content-workflows-v1"),
    checked_at: z.string(),
    native_presets: z.array(z.string().min(1).max(80)).max(6),
    providers: z
      .array(
        z
          .object({
            id: z.string().max(80),
            name: z.string().max(100),
            delivery: z.enum(["open_source", "hosted", "hybrid", "utility"]),
            status: z.enum([
              "learning_only",
              "inspect_only",
              "creator_capability_required",
            ]),
            summary: z.string().max(1_000),
            sources: z
              .array(
                z
                  .object({ label: z.string().max(100), url: z.url().max(500) })
                  .strict(),
              )
              .min(1)
              .max(5),
          })
          .strict(),
      )
      .max(25),
    modules: z
      .array(
        z
          .object({
            id: z.string().max(40),
            title: z.string().max(100),
            deliverable: z.string().max(1_000),
            acceptance: z.string().max(1_000),
            status: z.literal("not_evaluated"),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type ContentWorkflowCatalog = z.infer<typeof contentWorkflowCatalog>;
