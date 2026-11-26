import { describe, expect, it } from "vitest";
import { room, workflow, workflowResponse } from "../../src/api/roomSchemas";

const snapshotRole = (role_id: string) => ({
  role_id,
  role: "researcher" as const,
  agent_id: "agent-1",
  agent_version: 1,
  assigned_at: "2026-11-20T00:00:00Z",
});

const step = (step_id: string, role_id: string) => ({
  step_id,
  role_id,
  stage: "research" as const,
  state: "pending" as const,
  task_id: null,
  run_id: null,
  artifact_ids: [],
  budget_cap_micro_usd: "100",
  error_code: null,
});

const makeWorkflow = (over: Record<string, unknown> = {}) => ({
  workflow_id: "wf-1",
  room_id: "room-1",
  revision: 1,
  kind: "research_findings" as const,
  state: "draft" as const,
  brief: "A brief.",
  context_snapshot: [],
  role_snapshot: [snapshotRole("role-1")],
  steps: [step("step-1", "role-1")],
  artifact_ids: [],
  execution: null,
  reason: null,
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-20T00:00:00Z",
  ...over,
});

const makeRoom = (over: Record<string, unknown> = {}) => ({
  room_id: "room-1",
  project_id: "project-1",
  revision: 1,
  kind: "research" as const,
  name: "Room",
  description: "A room.",
  visibility: "private" as const,
  brief: "A brief.",
  config: {
    kind: "research" as const,
    questions: ["q1"],
    citation_policy: "provided_sources_only" as const,
  },
  roles: [snapshotRole("role-1")],
  context: [],
  linked_tasks: [],
  artifacts: [],
  capabilities: [],
  session: null,
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-20T00:00:00Z",
  ...over,
});

describe("workflow step roles resolve to role_snapshot", () => {
  it("rejects a step naming a role outside the snapshot", () => {
    const parsed = workflow.safeParse(
      makeWorkflow({ steps: [step("step-1", "role-gone")] }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a step when the snapshot is empty", () => {
    const parsed = workflow.safeParse(
      makeWorkflow({ role_snapshot: [], steps: [step("step-1", "role-1")] }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects the dangling step inside a room+workflow response", () => {
    const parsed = workflowResponse.safeParse({
      room: makeRoom(),
      workflow: makeWorkflow({ steps: [step("step-1", "role-gone")] }),
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a step naming a snapshotted role", () => {
    expect(workflow.safeParse(makeWorkflow()).success).toBe(true);
    expect(
      workflowResponse.safeParse({
        room: makeRoom(),
        workflow: makeWorkflow(),
      }).success,
    ).toBe(true);
  });

  it("accepts a workflow with no steps", () => {
    expect(
      workflow.safeParse(makeWorkflow({ steps: [] })).success,
    ).toBe(true);
  });
});
