import { createHash } from "node:crypto";
import { test } from "vitest";
import * as api from "../src/core/research-exchange.mjs";
import { conformanceCases } from "./fixtures/research-exchange-conformance.mjs";
for (const c of conformanceCases(api, text => `sha256:${createHash("sha256").update(text,"utf8").digest("hex")}`)) {
  test(c.name, c.run);
}
