import { z } from "zod";
import { roomMods } from "./modRefSchemas";
import { task } from "./schemas";
import { memeLookCatalogue } from "./memeLookSchemas";
const s = z.string(),
  id = s.min(1),
  n = z.number().int().nonnegative(),
  pos = z.number().int().positive();
export const kind = z.enum([
  "coding",
  "art",
  "video",
  "research",
  "live_avatar",
  "trading",
]);
export const role = z.object({
  role_id: id,
  role: z.enum([
    "builder",
    "reviewer",
    "researcher",
    "synthesizer",
    "artist",
    "director",
    "editor",
    "presenter",
  ]),
  agent_id: id,
  agent_version: pos,
  assigned_at: s,
});
export const config = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("trading"),
      mode: z.literal("paper"),
      preset: z.literal("index_allocation_v1"),
    })
    .strict(),
  z.object({
    kind: z.literal("coding"),
    language: s.nullable(),
    repository_label: s.nullable(),
  }),
  z.object({ kind: z.literal("art"), style_notes: s }),
  z.object({
    kind: z.literal("video"),
    workspace_mode: z.literal("clips").optional(),
    mods: roomMods.optional(),
    tool: z.enum(["clips", "memes", "affiliate"]).optional(),
    meme_looks: memeLookCatalogue.optional(),
    storyboard: s,
    shots: z.array(
      z.object({
        shot_id: id,
        description: s,
        duration_seconds: z.number().nullable(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("research"),
    questions: z.array(s),
    citation_policy: z.literal("provided_sources_only"),
  }),
  z.object({
    kind: z.literal("live_avatar"),
    persona: s,
    scene: s,
    feed_mode: z.literal("text"),
  }),
]);
export const context = z.object({
  context_id: id,
  kind: z.enum(["note", "source_file", "reference"]),
  title: s,
  text: s,
  path: s.nullable(),
  url: s.nullable(),
  content_hash: s,
  provenance: z.literal("owner_provided_unverified"),
  created_at: s,
});
const verdict = z.enum(["approve", "request_changes"]);
export const artifactKind = z.enum([
  "text",
  "code_diff",
  "code_review",
  "code_diff_review",
  "research_findings",
  "image",
  "video",
  "storyboard",
]);
export const content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: s }),
  z.object({ type: z.literal("code_diff"), summary: s, diff: s }),
  z.object({
    type: z.literal("code_review"),
    summary: s,
    verdict,
    findings: z.array(
      z.object({
        severity: z.enum(["info", "warning", "error"]),
        file: s.nullable(),
        line: z.number().nullable(),
        message: s,
      }),
    ),
  }),
  z.object({
    type: z.literal("code_diff_review"),
    diff_artifact_id: id,
    review_artifact_id: id,
    verdict,
  }),
  z.object({
    type: z.literal("research_findings"),
    summary: s,
    findings: z.array(
      z.object({ claim: s, citation_context_ids: z.array(id) }),
    ),
  }),
  z.object({
    type: z.literal("media"),
    url: s,
    mime_type: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "video/mp4",
      "video/webm",
    ]),
    caption: s,
  }),
  z.object({ type: z.literal("storyboard"), text: s }),
]);
export const artifact = z.object({
  artifact_id: id,
  room_id: id,
  kind: artifactKind,
  title: s,
  content,
  status: z.enum(["proposed", "reviewed", "accepted", "rejected"]),
  revision: pos,
  content_hash: s,
  provenance: z.object({
    source: z.enum([
      "owner_provided_unverified",
      "model_generated",
      "workflow_derived",
    ]),
    task_id: s.nullable(),
    run_id: s.nullable(),
    workflow_id: s.nullable(),
    agent_id: s.nullable(),
    agent_version: pos.nullable(),
    context_ids: z.array(id),
    input_artifact_ids: z.array(id),
    execution_mode: z.enum(["none", "injected_test", "live"]),
  }),
  created_at: s,
  updated_at: s,
});
const attempt = z.enum([
  "queued",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
]);
export const taskLink = z.object({
  task_id: id,
  run_id: id,
  role_id: id,
  agent_id: id,
  agent_version: pos,
  workflow_id: s.nullable(),
  state: attempt,
  artifact_ids: z.array(id),
  created_at: s,
});
export const capability = z.object({
  name: z.enum([
    "room.context",
    "room.artifacts",
    "text.generate",
    "coding.diff_review",
    "coding.repository_write",
    "research.cited_findings",
    "research.web_search",
    "art.image_generate",
    "video.render",
    "avatar.live_session",
    "trading.paper",
    "trading.live",
    "media.upload",
  ]),
  available: z.boolean(),
  reason: s.nullable(),
  execution_mode: z.enum(["none", "disabled", "injected_test", "live"]),
  requires_confirmation: z.boolean(),
});
export const room = z
  .object({
    room_id: id,
    project_id: id,
    revision: pos,
    token_binding: z
      .object({
        launch_profile: z.enum(["dbc-spl-metaplex-owner-v1", "dbc-spl-metaplex-dfs-v2"]).optional(),
        mint_address: s,
        intent_id: id,
        parameters_hash: s,
        transaction_signature: s,
      })
      .strict()
      .optional(),
    token_identity: z
      .object({ name: s.min(1).max(32), symbol: s.min(1).max(10) })
      .strict()
      .optional(),
    kind,
    name: s,
    description: s,
    visibility: z.enum(["private", "public"]),
    brief: s,
    config,
    roles: z.array(role),
    context: z.array(context),
    linked_tasks: z.array(taskLink),
    artifacts: z.array(artifact),
    capabilities: z.array(capability),
    session: z
      .object({
        session_id: id,
        state: z.enum(["idle", "blocked", "ended"]),
        reason: s.nullable(),
        adapter_id: z.null(),
        created_at: s,
        updated_at: s,
      })
      .nullable(),
    created_at: s,
    updated_at: s,
  })
  .refine(
    (value) =>
      value.config.kind === value.kind &&
      value.artifacts.every((a) => a.room_id === value.room_id),
  );
const execution = z.object({
  mode: z.enum(["injected_test", "live"]),
  max_budget_micro_usd: s.regex(/^[1-9]\d*$/),
  allow_model_calls: z.literal(true),
});
export const workflow = z.object({
  workflow_id: id,
  room_id: id,
  revision: pos,
  kind: z.enum([
    "coding_review",
    "research_findings",
    "art_generation",
    "video_production",
    "avatar_session",
  ]),
  state: z.enum([
    "draft",
    "blocked",
    "running",
    "awaiting_input",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  brief: s,
  context_snapshot: z.array(context),
  role_snapshot: z.array(role),
  steps: z.array(
    z.object({
      step_id: id,
      role_id: id,
      stage: z.enum(["build", "review", "research", "synthesize", "media"]),
      state: z.enum([
        "pending",
        "blocked",
        "queued",
        "running",
        "awaiting_input",
        "succeeded",
        "failed",
        "cancelled",
      ]),
      task_id: s.nullable(),
      run_id: s.nullable(),
      artifact_ids: z.array(id),
      budget_cap_micro_usd: s,
      error_code: s.nullable(),
    }),
  ),
  artifact_ids: z.array(id),
  execution: execution.nullable(),
  reason: s.nullable(),
  created_at: s,
  updated_at: s,
}).refine(
  // A step runs by its role: role_snapshot is the roster the workflow
  // dispatches to, so a step naming a role outside the snapshot (never
  // assigned, or gone after the role left) has no agent to run it.
  (value) => {
    const snapshotIds = new Set(
      value.role_snapshot.map((entry) => entry.role_id),
    );
    return value.steps.every((step) => snapshotIds.has(step.role_id));
  },
  { message: "workflow steps must reference a role in role_snapshot" },
);
export const association = z
  .object({ room, task, association: taskLink })
  .refine(
    (v) =>
      v.association.task_id === v.task.task_id &&
      v.association.run_id === v.task.run.run_id &&
      v.association.agent_id === v.task.agent_id,
  );
export const workflowResponse = z
  .object({ room, workflow })
  .refine((v) => v.room.room_id === v.workflow.room_id);
export const event = z.object({
  event_id: id,
  sequence: n,
  room_id: id,
  type: s,
  data: z.record(s, z.unknown()),
  created_at: s,
});
export const projection = z.object({
  room_id: id,
  kind,
  name: s,
  description: s,
  artifact_summaries: z.array(
    z.object({ artifact_id: id, kind: artifactKind, title: s }),
  ),
  published_at: s,
});

/** Immutable, public META-00 export; no room or owner data. */
const metaVersion = z.union([z.literal(1), z.literal(2)]);
const metaProfile = z.enum(["dbc-spl-metaplex-owner-v1", "dbc-spl-metaplex-dfs-v2"]);
const matchingMetaProfile = (value: {template_version: number; launch_profile: string}) =>
  value.template_version === 1 ? value.launch_profile === "dbc-spl-metaplex-owner-v1" :
    value.template_version === 2 && value.launch_profile === "dbc-spl-metaplex-dfs-v2";
export const publishedMetaTemplate = z.object({
  template_id: z.literal("meta-00"), template_version: metaVersion, name: z.string(),
  launch_profile: metaProfile, required_capabilities: z.array(z.string()),
  source_identity: z.object({ name: z.string(), symbol: z.string() }).strict(),
  configuration: z.object({ kind: z.literal("coding"), description: z.string(), brief: z.string(), config: z.object({ kind: z.literal("coding"), language: z.null(), repository_label: z.null() }).strict() }).strict(),
  roles: z.array(z.object({ role: z.enum(["researcher", "artist", "builder", "reviewer"]), instruction: z.string() }).strict()),
  examples: z.array(z.string()), export_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().refine(matchingMetaProfile);
export const metaTemplateProvenance = z.object({ room_id: z.string(), owner_id: z.string(), project_id: z.string(), template_id: z.literal("meta-00"), template_version: metaVersion, export_hash: z.string(), source_identity: z.object({name: z.string(), symbol: z.string()}).strict(), launch_profile: metaProfile, provisioning: z.enum(["ready", "pending", "failed"]), export_snapshot: publishedMetaTemplate }).strict().refine(matchingMetaProfile).refine(value =>
  value.export_snapshot.template_version === value.template_version &&
  value.export_snapshot.launch_profile === value.launch_profile &&
  value.export_snapshot.export_hash === value.export_hash);
/** Public offer for a visitor fork. Never carries the brief or configuration. */
export const publicForkSource = z
  .object({
    room_id: id,
    revision: n,
    kind: kind.exclude(["trading"]),
    name: s,
    description: s,
  })
  .strict();
export const publicForkSetting = z
  .object({
    room_id: id,
    setting_revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    eligible: z.boolean(),
  })
  .strict();
