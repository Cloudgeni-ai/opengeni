import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function immutableRevisionId(protocol: string, contentSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    throw new Error("contentSha256 must be a lowercase SHA-256 digest");
  }
  return `${protocol}:${contentSha256.slice(0, 24)}`;
}

export function stableToolId(value: string, seen?: Map<string, number>): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 54);
  const base = normalized || "tool";
  if (!seen) return base;
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}_${count}`;
}