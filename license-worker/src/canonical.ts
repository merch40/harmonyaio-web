// Canonical JSON serialization that matches internal/license/canonical.go
// byte-for-byte. Rules (verbatim from the brief §4):
//
//   - The "signature" field is omitted entirely (recursively).
//   - All object keys are sorted lexicographically at every level.
//   - No whitespace.
//   - UTF-8.
//   - Numbers serialized as JSON numbers (Go float64 default representation).
//   - Arrays preserve order (never sorted).
//
// Strings are escaped using JSON.stringify, which matches Go's json.Marshal
// for strings on the BMP. (License blobs only carry ASCII control-free
// strings — emails, hostnames, tier names — so no surrogate-pair edge
// cases arise in practice.)

export function canonicalJSON(input: unknown): string {
  const stripped = stripSignature(input);
  return emit(stripped);
}

function stripSignature(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stripSignature);
  const out: Record<string, unknown> = {};
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    if (k === "signature") continue;
    out[k] = stripSignature(child);
  }
  return out;
}

function emit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonical: non-finite number");
    // JSON.stringify on a finite number emits Go-compatible shortest form
    // (1, 1.5, -1, 0). Integer floats like 1.0 become "1" in both languages.
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return "[" + v.map(emit).join(",") + "]";
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ":" + emit(obj[k]));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`canonical: unsupported type ${typeof v}`);
}
