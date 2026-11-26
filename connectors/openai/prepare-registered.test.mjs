// Repro for: prepare-registered rejects the plugin_-prefixed app ID that
// OpenAI's own packaging docs tell the user to copy from the browser URL
// ("copy its technical ID from the browser URL. It starts with
// `plugin_asdk_app`", developers.openai.com/plugins/build/plugins).
// The stored .app.json keeps the canonical bare asdk_app_ form used by the
// reference plugins (openai/plugins canva/hubspot/notion/linear).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareRegistered,
  registeredAppMapping,
} from "./prepare-registered.mjs";

const HEX32 = "a".repeat(32);
const BARE = `asdk_app_${HEX32}`;
const DISPLAYED = `plugin_asdk_app_${HEX32}`;

test("accepts the plugin_-prefixed ID OpenAI displays and stores the bare form", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spawn-prepare-"));
  try {
    const out = join(dir, "pkg");
    await prepareRegistered(DISPLAYED, out);
    const mapping = JSON.parse(await readFile(join(out, ".app.json"), "utf8"));
    assert.deepEqual(mapping, { apps: { spawn: { id: BARE } } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registeredAppMapping normalizes the displayed form to the bare form", () => {
  assert.deepEqual(registeredAppMapping(DISPLAYED), {
    apps: { spawn: { id: BARE } },
  });
});

test("still accepts the bare canonical ID unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spawn-prepare-"));
  try {
    const out = join(dir, "pkg");
    await prepareRegistered(BARE, out);
    const mapping = JSON.parse(await readFile(join(out, ".app.json"), "utf8"));
    assert.deepEqual(mapping, { apps: { spawn: { id: BARE } } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("still rejects a non-ID string", () => {
  assert.throws(() => registeredAppMapping("not-an-app-id"), /canonical asdk_app ID/);
  assert.throws(
    () => registeredAppMapping("plugin_asdk_app_short"),
    /canonical asdk_app ID/,
  );
});
