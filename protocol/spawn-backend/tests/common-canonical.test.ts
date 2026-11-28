import { describe, expect, it } from "vitest";
import { canonical, hash } from "../src/common";

// Canonical JSON is used for commission operation and acceptance digests.
// An optional field explicitly set to undefined must not change the digest.
describe("canonical digests ignore undefined optional fields", () => {
  it("omits undefined object members like JSON.stringify", () => {
    expect(canonical({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("hashes an explicit undefined member the same as an omitted one", () => {
    expect(hash({ a: undefined, b: 1 })).toBe(hash({ b: 1 }));
  });

  it("serializes undefined array holes as null like JSON.stringify", () => {
    expect(canonical([1, undefined, 3])).toBe("[1,null,3]");
  });
});
