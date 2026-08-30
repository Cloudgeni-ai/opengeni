import { createHash } from "node:crypto";
import type {
  CanonicalToolDescriptor,
  CanonicalToolIdentity,
  CanonicalToolSurface,
} from "@opengeni/contracts";

export type CanonicalToolProjectionInput = Readonly<{
  identity: CanonicalToolIdentity;
  modelName?: string;
  programmaticPath?: readonly string[];
}>;

export type CanonicalToolProjection = Readonly<{
  modelName: string;
  programmaticPath: readonly string[];
}>;

export type AllocateProgrammaticPathsOptions = Readonly<{
  /**
   * Preserve a legacy caller that expects a later duplicate-catalog guard to
   * reject a second-order suffix collision instead of allocating around it.
   */
  resolveSecondaryCollisions?: boolean;
}>;

export type CanonicalToolCatalogBounds = Readonly<{
  maxEntries: number;
  maxBytes: number;
  maxPathSegments: number;
}>;

export type CanonicalSafeReadToolIneligibility =
  | "surface_ineligible"
  | "effect_ineligible"
  | "replay_ineligible"
  | "approval_required"
  | "open_world_ineligible";

export type CanonicalToolEligibilityDescriptor = Readonly<{
  supportedSurfaces: readonly CanonicalToolSurface[];
  effect: CanonicalToolDescriptor["effect"];
  replaySafety: CanonicalToolDescriptor["replaySafety"];
  approval: CanonicalToolDescriptor["approval"];
  openWorld: boolean;
}>;

export class CanonicalToolCatalogCollisionError extends Error {
  readonly code = "tool_catalog_collision";

  constructor(
    readonly projection: "identity" | "modelName" | "programmaticPath",
    readonly value: string,
  ) {
    super(`Duplicate canonical tool ${projection}: ${value}`);
    this.name = "CanonicalToolCatalogCollisionError";
  }
}

export class CanonicalToolCatalogBoundsError extends Error {
  readonly code = "tool_catalog_bounds_exceeded";

  constructor(
    readonly bound: "entries" | "bytes" | "pathSegments",
    readonly actual: number,
    readonly maximum: number,
  ) {
    super(`Canonical tool catalog ${bound} bound exceeded: ${actual} > ${maximum}`);
    this.name = "CanonicalToolCatalogBoundsError";
  }
}

export function canonicalToolIdentityKey(identity: CanonicalToolIdentity): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}

export function canonicalToolIdentitiesEqual(
  left: CanonicalToolIdentity,
  right: CanonicalToolIdentity,
): boolean {
  return left.serverId === right.serverId && left.toolName === right.toolName;
}

/**
 * Fail-closed eligibility for caller surfaces that admit only authoritative,
 * closed-world, replay-safe reads. Descriptive MCP hints are intentionally
 * ignored; only server-owned canonical metadata is consulted.
 */
export function canonicalSafeReadToolIneligibility(
  descriptor: CanonicalToolEligibilityDescriptor,
  surface: CanonicalToolSurface,
): CanonicalSafeReadToolIneligibility | null {
  if (!descriptor.supportedSurfaces.includes(surface)) return "surface_ineligible";
  if (descriptor.effect !== "read") return "effect_ineligible";
  if (descriptor.replaySafety !== "safe") return "replay_ineligible";
  if (descriptor.approval !== "none") return "approval_required";
  if (descriptor.openWorld) return "open_world_ineligible";
  return null;
}

export function isCanonicalSafeReadToolEligible(
  descriptor: CanonicalToolEligibilityDescriptor,
  surface: CanonicalToolSurface,
): boolean {
  return canonicalSafeReadToolIneligibility(descriptor, surface) === null;
}

export function safeProgrammaticPathSegment(value: string): string {
  let normalized = value.replace(/[^A-Za-z0-9_$]/gu, "_");
  if (!/^[A-Za-z_$]/u.test(normalized)) normalized = `_${normalized}`;
  if (["__proto__", "prototype", "constructor"].includes(normalized)) {
    normalized = `_${normalized}`;
  }
  return normalized.slice(0, 128) || "_";
}

export function allocateProgrammaticPaths(
  inputs: readonly Pick<CanonicalToolProjectionInput, "identity" | "programmaticPath">[],
  options: AllocateProgrammaticPathsOptions = {},
): string[][] {
  const bases = inputs.map((input) =>
    (input.programmaticPath?.length
      ? input.programmaticPath
      : [input.identity.serverId, input.identity.toolName]
    ).map(safeProgrammaticPathSegment),
  );
  const counts = countStrings(bases.map((path) => path.join("\u0000")));
  const candidates = bases.map((base, index) => {
    const key = base.join("\u0000");
    if (counts.get(key) === 1) return base;
    return appendPathSuffix(base, `_${shortIdentityDigest(inputs[index]!.identity)}`);
  });
  return options.resolveSecondaryCollisions === false
    ? candidates
    : makePathsUnique(candidates, inputs);
}

export function allocateCanonicalToolProjections(
  inputs: readonly CanonicalToolProjectionInput[],
): CanonicalToolProjection[] {
  const paths = allocateProgrammaticPaths(inputs);
  const modelBases = inputs.map((input) =>
    safeModelName(input.modelName ?? `${input.identity.serverId}__${input.identity.toolName}`),
  );
  const counts = countStrings(modelBases);
  const candidates = modelBases.map((base, index) =>
    counts.get(base) === 1
      ? base
      : appendModelSuffix(base, `_${shortIdentityDigest(inputs[index]!.identity)}`),
  );
  const modelNames = makeModelNamesUnique(candidates, inputs);
  return inputs.map((_input, index) => ({
    modelName: modelNames[index]!,
    programmaticPath: paths[index]!,
  }));
}

export function sortCanonicalToolDescriptors<Descriptor extends CanonicalToolDescriptor>(
  descriptors: readonly Descriptor[],
): Descriptor[] {
  return [...descriptors].sort((left, right) => {
    const identity = canonicalToolIdentityKey(left.identity).localeCompare(
      canonicalToolIdentityKey(right.identity),
    );
    if (identity !== 0) return identity;
    const modelName = left.modelName.localeCompare(right.modelName);
    if (modelName !== 0) return modelName;
    return left.programmaticPath.join(".").localeCompare(right.programmaticPath.join("."));
  });
}

export function assertCanonicalToolDescriptorUniqueness(
  descriptors: readonly Pick<
    CanonicalToolDescriptor,
    "identity" | "modelName" | "programmaticPath"
  >[],
): void {
  const identities = new Set<string>();
  const modelNames = new Set<string>();
  const paths = new Set<string>();
  for (const descriptor of descriptors) {
    const identity = canonicalToolIdentityKey(descriptor.identity);
    if (identities.has(identity)) {
      throw new CanonicalToolCatalogCollisionError("identity", identity);
    }
    if (modelNames.has(descriptor.modelName)) {
      throw new CanonicalToolCatalogCollisionError("modelName", descriptor.modelName);
    }
    const path = descriptor.programmaticPath.join(".");
    if (paths.has(path)) {
      throw new CanonicalToolCatalogCollisionError("programmaticPath", path);
    }
    identities.add(identity);
    modelNames.add(descriptor.modelName);
    paths.add(path);
  }
}

export function assertCanonicalToolCatalogBounds(
  entries: readonly Pick<CanonicalToolDescriptor, "programmaticPath">[],
  serializedCatalog: unknown,
  bounds: CanonicalToolCatalogBounds,
): void {
  if (entries.length > bounds.maxEntries) {
    throw new CanonicalToolCatalogBoundsError("entries", entries.length, bounds.maxEntries);
  }
  for (const entry of entries) {
    if (entry.programmaticPath.length > bounds.maxPathSegments) {
      throw new CanonicalToolCatalogBoundsError(
        "pathSegments",
        entry.programmaticPath.length,
        bounds.maxPathSegments,
      );
    }
  }
  const bytes = serializedJsonBytes(serializedCatalog);
  if (bytes > bounds.maxBytes) {
    throw new CanonicalToolCatalogBoundsError("bytes", bytes, bounds.maxBytes);
  }
}

export function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

export function encodeCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function digestCanonicalJson(value: unknown): string {
  return createHash("sha256").update(encodeCanonicalJson(value), "utf8").digest("hex");
}

export function serializedJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function safeModelName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 512);
  return normalized || "_";
}

function shortIdentityDigest(identity: CanonicalToolIdentity): string {
  return createHash("sha256")
    .update(canonicalToolIdentityKey(identity), "utf8")
    .digest("hex")
    .slice(0, 10);
}

function appendPathSuffix(path: readonly string[], suffix: string): string[] {
  const last = path.at(-1) ?? "_";
  return [...path.slice(0, -1), `${last.slice(0, 128 - suffix.length)}${suffix}`];
}

function appendModelSuffix(modelName: string, suffix: string): string {
  return `${modelName.slice(0, 512 - suffix.length)}${suffix}`;
}

function countStrings(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function makePathsUnique(
  candidates: readonly string[][],
  inputs: readonly Pick<CanonicalToolProjectionInput, "identity">[],
): string[][] {
  const used = new Set<string>();
  return candidates.map((candidate, index) => {
    let allocated = candidate;
    let attempt = 1;
    while (used.has(allocated.join("\u0000"))) {
      const suffix = `_${shortIdentityDigest(inputs[index]!.identity)}_${attempt}`;
      allocated = appendPathSuffix(candidate, suffix);
      attempt += 1;
    }
    used.add(allocated.join("\u0000"));
    return allocated;
  });
}

function makeModelNamesUnique(
  candidates: readonly string[],
  inputs: readonly Pick<CanonicalToolProjectionInput, "identity">[],
): string[] {
  const used = new Set<string>();
  return candidates.map((candidate, index) => {
    let allocated = candidate;
    let attempt = 1;
    while (used.has(allocated)) {
      const suffix = `_${shortIdentityDigest(inputs[index]!.identity)}_${attempt}`;
      allocated = appendModelSuffix(candidate, suffix);
      attempt += 1;
    }
    used.add(allocated);
    return allocated;
  });
}
