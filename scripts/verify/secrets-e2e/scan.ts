/**
 * Known-value scanning shared by the gate's per-turn leak checks and the canary
 * sweep (SEC-1..SEC-3, OB-3). It reports labels, locations and counts only: a hit
 * never echoes the matched value, so reports and evidence stay safe to keep.
 *
 * Each known value is searched in the encodings a leak usually takes on the way
 * to storage: raw, JSON-escaped, URL-encoded, base64 and hex.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export type KnownValue = { label: string; value: string };

export type Needle = { label: string; encoding: string; bytes: Buffer };

export type Hit = { location: string; label: string; encoding: string; count: number };

/** Values shorter than this are too ambiguous to scan for (false positives). */
export const MIN_VALUE_LENGTH = 8;

export function needlesFor(values: KnownValue[]): Needle[] {
  const needles: Needle[] = [];
  const seen = new Set<string>();
  for (const { label, value } of values) {
    if (value.length < MIN_VALUE_LENGTH) {
      throw new Error(`known value ${label} is shorter than ${MIN_VALUE_LENGTH} characters`);
    }
    const encodings: [string, string][] = [
      ["raw", value],
      ["json", JSON.stringify(value).slice(1, -1)],
      ["url", encodeURIComponent(value)],
      ["base64", Buffer.from(value).toString("base64").replace(/=+$/u, "")],
      ["base64url", Buffer.from(value).toString("base64url")],
      ["hex", Buffer.from(value).toString("hex")],
    ];
    for (const [encoding, text] of encodings) {
      const key = `${label}\u0000${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      needles.push({ label, encoding, bytes: Buffer.from(text) });
    }
  }
  return needles;
}

export function countOccurrences(haystack: Buffer, needle: Buffer): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Scan one buffer (or string) and return per-label/encoding hit counts. */
export function scanBuffer(location: string, data: Buffer | string, needles: Needle[]): Hit[] {
  const haystack = typeof data === "string" ? Buffer.from(data) : data;
  const hits: Hit[] = [];
  for (const needle of needles) {
    const count = countOccurrences(haystack, needle.bytes);
    if (count > 0) hits.push({ location, label: needle.label, encoding: needle.encoding, count });
  }
  return hits;
}

/** Decompress gzip/zstd payloads (snapshots, log archives) before scanning. */
export function maybeDecompress(data: Buffer): Buffer {
  try {
    if (data.length > 4 && data[0] === 0x1f && data[1] === 0x8b) {
      return Buffer.from(Bun.gunzipSync(new Uint8Array(data)));
    }
    if (
      data.length > 4 &&
      data[0] === 0x28 &&
      data[1] === 0xb5 &&
      data[2] === 0x2f &&
      data[3] === 0xfd
    ) {
      return Buffer.from(Bun.zstdDecompressSync(new Uint8Array(data)));
    }
  } catch {}
  return data;
}

/** Replace every known value (all encodings) with a marker; returns the hit count. */
export function scrubKnownValues(text: string, needles: Needle[]): { text: string; hits: number } {
  let hits = 0;
  let output = text;
  for (const needle of needles) {
    const value = needle.bytes.toString();
    if (!output.includes(value)) continue;
    const parts = output.split(value);
    hits += parts.length - 1;
    output = parts.join(`[[known-value:${needle.label}:${needle.encoding}]]`);
  }
  return { text: output, hits };
}

export type AllowRule = { label: string; location: RegExp; reason: string };

/** Parse `--allow <label>=<location regex>` (for the declared secret_save.value scenario). */
export function parseAllowRule(spec: string): AllowRule {
  const index = spec.indexOf("=");
  if (index <= 0) throw new Error(`--allow expects <label>=<location regex>, got ${spec}`);
  return {
    label: spec.slice(0, index),
    location: new RegExp(spec.slice(index + 1), "u"),
    reason: "declared model-authored secret_save.value",
  };
}

export function isAllowed(hit: Hit, rules: AllowRule[]): AllowRule | undefined {
  return rules.find((rule) => rule.label === hit.label && rule.location.test(hit.location));
}

// --- canary files (.agent/evidence/canaries.json, 0600, deleted after the sweep) ---

export type CanaryFile = {
  createdAt: string;
  stack?: string;
  values: (KnownValue & { item?: string; field?: string; reference?: string })[];
};

export function newCanaryValue(prefix = "OGCANARY"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function writeCanaryFile(path: string, file: CanaryFile): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Known values from a canary file, inline JSON, or both. */
export function loadKnownValues(options: {
  file?: string | undefined;
  json?: string | undefined;
}): KnownValue[] {
  const values: KnownValue[] = [];
  const add = (parsed: unknown) => {
    const rows = Array.isArray(parsed) ? parsed : ((parsed as CanaryFile).values ?? []);
    for (const row of rows as KnownValue[]) {
      if (typeof row?.label !== "string" || typeof row?.value !== "string") {
        throw new Error("known values must be [{label, value}] or {values: [{label, value}]}");
      }
      values.push({ label: row.label, value: row.value });
    }
  };
  if (options.file) {
    if (!existsSync(options.file)) throw new Error(`${options.file} does not exist`);
    add(JSON.parse(readFileSync(options.file, "utf8")));
  }
  if (options.json) add(JSON.parse(options.json));
  return values;
}
