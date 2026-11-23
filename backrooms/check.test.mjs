import test from "node:test";
import assert from "node:assert/strict";
import { roomNameKey } from "./check.mjs";

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("room names compare case-insensitively after trimming", () => {
  assert.equal(roomNameKey("VESPER-04"), roomNameKey("vesper-04"));
  assert.equal(roomNameKey("VESPER-04"), roomNameKey(" VESPER-04"));
  assert.equal(roomNameKey("VESPER-04"), roomNameKey("VESPER-04 "));
  assert.equal(roomNameKey("VESPER-04"), roomNameKey("VESPER-04  "));
});

test("distinct room names stay distinct", () => {
  assert.notEqual(roomNameKey("VESPER-04"), roomNameKey("MOTH-07"));
  assert.notEqual(roomNameKey("VESPER-04"), roomNameKey("VESPER-05"));
});

// The catalogue is the room store's list: two entries under one seed_id or
// name leave one room unreachable by that key. These tests run the checker
// CLI against a throwaway copy of this directory, so they exercise main(),
// not just the per-template validator.
const here = dirname(fileURLToPath(import.meta.url));

function runChecker(mutatedCatalogue) {
  const dir = mkdtempSync(join(tmpdir(), "backrooms-check-"));
  try {
    cpSync(here, dir, { recursive: true });
    if (mutatedCatalogue) {
      const path = join(dir, "catalogue", "platform-rooms.v1.json");
      const catalogue = JSON.parse(readFileSync(path, "utf8"));
      mutatedCatalogue(catalogue);
      writeFileSync(path, JSON.stringify(catalogue, null, 2));
    }
    return spawnSync(process.execPath, ["check.mjs"], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("clean catalogue still passes", () => {
  const result = runChecker();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 rooms/);
});

test("catalogue with a duplicate seed_id fails", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], name: "VESPER-99" };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /"vesper-04" is already used/);
});

test("catalogue with a duplicate name fails", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], seed_id: "vesper-99" };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the name "VESPER-04" is already used/);
});

test("catalogue with a same name in different case fails", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], seed_id: "vesper-99", name: "vesper-04" };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the name "vesper-04" is already used/);
});

test("catalogue with a duplicate name padded with whitespace fails", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], seed_id: "vesper-99", name: "  vesper-04  " };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the name "  vesper-04  " is already used/);
});

test("catalogue with a distinct new room passes", () => {
  const result = runChecker((catalogue) => {
    const copy = { ...catalogue.templates[0], seed_id: "vesper-99", name: "VESPER-99" };
    catalogue.templates.push(copy);
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /7 rooms/);
});
