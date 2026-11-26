import { describe, expect, it } from "vitest";
import {
  contentWorkflowEvaluation,
  type ContentWorkflowEvaluation,
} from "../../../src/api/contentWorkflowSchemas";

const digest = `sha256:${"a".repeat(64)}`;

function evaluation(
  overrides: Partial<ContentWorkflowEvaluation> = {},
): ContentWorkflowEvaluation {
  return {
    evaluation_id: "eval-1",
    workflow_id: "workflow-1",
    room_id: "room-1",
    run_id: "run-1",
    run_revision: 1,
    definition_hash: digest,
    rubric_version: "content-quality-v1",
    scores: {
      brief_adherence: 4,
      visual_quality: 4,
      continuity: 4,
      technical_delivery: 4,
      reusability: 4,
    },
    notes: "Meets the brief.",
    result: "manual_pass",
    reviewer: { kind: "owner", owner_id: "owner-1" },
    evidence_class: "server_recorded_run_with_manual_review",
    source: {
      run_id: "run-1",
      pipeline_id: "pipeline-1",
      run_revision: 1,
      review_id: "review-1",
      review_hash: digest,
      run_updated_at: "2026-11-20T00:00:00.000Z",
      outputs: [
        {
          node_id: "node-1",
          kind: "generated_artifacts",
          artifact_ids: ["artifact-1"],
        },
      ],
    },
    created_at: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("content workflow evaluation pass rule", () => {
  it("rejects manual_pass when any dimension scores below 3", () => {
    const failing = evaluation({
      scores: {
        brief_adherence: 0,
        visual_quality: 4,
        continuity: 4,
        technical_delivery: 4,
        reusability: 4,
      },
      result: "manual_pass",
    });
    expect(contentWorkflowEvaluation.safeParse(failing).success).toBe(false);
  });

  it("rejects manual_pass when every dimension scores 0", () => {
    const failing = evaluation({
      scores: {
        brief_adherence: 0,
        visual_quality: 0,
        continuity: 0,
        technical_delivery: 0,
        reusability: 0,
      },
      result: "manual_pass",
    });
    expect(contentWorkflowEvaluation.safeParse(failing).success).toBe(false);
  });

  it("rejects manual_pass at the boundary score of 2", () => {
    const failing = evaluation({
      scores: {
        brief_adherence: 4,
        visual_quality: 4,
        continuity: 4,
        technical_delivery: 2,
        reusability: 4,
      },
      result: "manual_pass",
    });
    expect(contentWorkflowEvaluation.safeParse(failing).success).toBe(false);
  });

  it("accepts manual_pass when every dimension scores at least 3", () => {
    const passing = evaluation({
      scores: {
        brief_adherence: 3,
        visual_quality: 3,
        continuity: 3,
        technical_delivery: 3,
        reusability: 3,
      },
      result: "manual_pass",
    });
    expect(contentWorkflowEvaluation.safeParse(passing).success).toBe(true);
  });

  it("accepts needs_revision with failing scores", () => {
    const revision = evaluation({
      scores: {
        brief_adherence: 0,
        visual_quality: 0,
        continuity: 0,
        technical_delivery: 0,
        reusability: 0,
      },
      result: "needs_revision",
    });
    expect(contentWorkflowEvaluation.safeParse(revision).success).toBe(true);
  });

  it("accepts needs_revision with passing scores", () => {
    const revision = evaluation({
      scores: {
        brief_adherence: 4,
        visual_quality: 4,
        continuity: 4,
        technical_delivery: 4,
        reusability: 4,
      },
      result: "needs_revision",
    });
    expect(contentWorkflowEvaluation.safeParse(revision).success).toBe(true);
  });
});
