import { describe, it, expect } from "vitest";
import { canonicalJSON } from "../src/canonical";
import { EXPECTED_CANONICAL, FIXED_LICENSE } from "./fixtures";

describe("canonicalJSON", () => {
  it("produces byte-identical output to Go canonical.go for the fixed License fixture", () => {
    expect(canonicalJSON(FIXED_LICENSE)).toBe(EXPECTED_CANONICAL);
  });

  it("strips the signature field at the top level", () => {
    const a = canonicalJSON({ ...FIXED_LICENSE, signature: "different" });
    const b = canonicalJSON({ ...FIXED_LICENSE, signature: "anything" });
    expect(a).toBe(b);
    expect(a).not.toContain("signature");
  });

  it("sorts object keys lexicographically at every level", () => {
    const out = canonicalJSON({ z: 1, a: 2, m: { y: 1, x: 2 } });
    expect(out).toBe('{"a":2,"m":{"x":2,"y":1},"z":1}');
  });

  it("preserves array order and does not sort arrays", () => {
    expect(canonicalJSON({ a: ["c", "a", "b"] })).toBe('{"a":["c","a","b"]}');
  });

  it("emits negative integers and -1 unlimited markers correctly", () => {
    expect(canonicalJSON({ x: -1 })).toBe('{"x":-1}');
  });

  it("emits booleans and null as JSON literals", () => {
    expect(canonicalJSON({ t: true, f: false, n: null })).toBe('{"f":false,"n":null,"t":true}');
  });
});
