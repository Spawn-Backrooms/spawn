import { describe, expect, it } from "vitest";
import { config, room } from "../../src/api/roomSchemas";

const researchConfig = (questions: string[]) => ({
  kind: "research" as const,
  questions,
  citation_policy: "provided_sources_only" as const,
});

const shot = (id: string) => ({
  shot_id: id,
  description: "A shot.",
  duration_seconds: null,
});

const videoConfig = (shots: ReturnType<typeof shot>[]) => ({
  kind: "video" as const,
  storyboard: "A storyboard.",
  shots,
});

const makeRoom = (kind: "research" | "video", cfg: unknown) => ({
  room_id: "room-1",
  project_id: "project-1",
  revision: 1,
  kind,
  name: "Room",
  description: "A room.",
  visibility: "private" as const,
  brief: "A brief.",
  config: cfg,
  roles: [],
  context: [],
  linked_tasks: [],
  artifacts: [],
  capabilities: [],
  session: null,
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-20T00:00:00Z",
});

describe("room config work-lists", () => {
  it("rejects a research config with no questions", () => {
    expect(config.safeParse(researchConfig([])).success).toBe(false);
  });

  it("rejects a video config with no shots", () => {
    expect(config.safeParse(videoConfig([])).success).toBe(false);
  });

  it("accepts one question and one shot", () => {
    expect(config.safeParse(researchConfig(["What happened?"])).success).toBe(true);
    expect(config.safeParse(videoConfig([shot("s1")])).success).toBe(true);
  });

  it("accepts the documented caps: 16 questions and 32 shots", () => {
    expect(
      config.safeParse(researchConfig(Array.from({ length: 16 }, (_, i) => `Q${i}`))).success,
    ).toBe(true);
    expect(
      config.safeParse(
        videoConfig(Array.from({ length: 32 }, (_, i) => shot(`s${i}`))),
      ).success,
    ).toBe(true);
  });

  it("rejects more than the documented caps: 17 questions and 33 shots", () => {
    expect(
      config.safeParse(researchConfig(Array.from({ length: 17 }, (_, i) => `Q${i}`))).success,
    ).toBe(false);
    expect(
      config.safeParse(
        videoConfig(Array.from({ length: 33 }, (_, i) => shot(`s${i}`))),
      ).success,
    ).toBe(false);
  });

  it("rejects a whole research room with no questions", () => {
    expect(room.safeParse(makeRoom("research", researchConfig([]))).success).toBe(false);
  });

  it("rejects a whole video room with no shots", () => {
    expect(room.safeParse(makeRoom("video", videoConfig([]))).success).toBe(false);
  });

  it("accepts whole rooms with one question and one shot", () => {
    expect(
      room.safeParse(makeRoom("research", researchConfig(["What happened?"]))).success,
    ).toBe(true);
    expect(room.safeParse(makeRoom("video", videoConfig([shot("s1")]))).success).toBe(true);
  });
});
