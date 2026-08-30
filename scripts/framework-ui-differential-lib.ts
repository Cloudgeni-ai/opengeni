export const FRAMEWORK_UI_DIFFERENTIAL_NORMALIZATION_VERSION = 1 as const;

export type FrameworkUiDifferentialHints = Readonly<{
  generatedIds?: readonly string[];
  timestamps?: readonly string[];
  objectUrls?: readonly string[];
  origins?: Readonly<Record<string, string>>;
}>;

export type FrameworkUiRawTrace = Readonly<{
  normalizationHints?: FrameworkUiDifferentialHints;
  [key: string]: unknown;
}>;

export type FrameworkUiNormalizedTrace = Readonly<Record<string, unknown>>;

export type FrameworkUiTraceDifference = Readonly<{
  path: string;
  baseline: unknown;
  candidate: unknown;
}>;

export type FrameworkUiTraceComparison = Readonly<{
  equal: boolean;
  differences: readonly FrameworkUiTraceDifference[];
  baseline: FrameworkUiNormalizedTrace;
  candidate: FrameworkUiNormalizedTrace;
}>;

export type FrameworkUiSensitivityProbe = Readonly<{
  id:
    | "call-order"
    | "generation-fencing"
    | "final-owner-refcount"
    | "cursor-monotonicity"
    | "idempotency-reuse"
    | "optional-answer-preservation"
    | "focus-restoration"
    | "resource-cleanup"
    | "semantic-value";
  detected: boolean;
  differenceCount: number;
}>;

/**
 * Normalize only facts the executable-oracle contract explicitly permits.
 *
 * Hints are emitted by the common scenario driver from observed allocations,
 * so stable IDs, authority facts, cursors, text, errors, call order, and keys
 * that were not actually generated remain byte-for-byte significant.
 */
export function normalizeFrameworkUiTrace(raw: FrameworkUiRawTrace): FrameworkUiNormalizedTrace {
  const hints = raw.normalizationHints ?? {};
  const generatedIds = ordinalMap(hints.generatedIds, "generated-id");
  const timestamps = ordinalMap(hints.timestamps, "tick");
  const objectUrls = ordinalMap(hints.objectUrls, "object-url");
  const origins = new Map(
    Object.entries(hints.origins ?? {}).map(([role, origin]) => [origin, `<origin:${role}>`]),
  );

  const normalized = normalizeValue(raw, {
    generatedIds,
    timestamps,
    objectUrls,
    origins,
  });
  if (!isRecord(normalized)) {
    throw new TypeError("framework UI differential trace must normalize to an object");
  }
  delete normalized.normalizationHints;
  delete normalized.runtime;
  return normalized;
}

export function compareFrameworkUiTraces(
  baselineRaw: FrameworkUiRawTrace,
  candidateRaw: FrameworkUiRawTrace,
): FrameworkUiTraceComparison {
  const baseline = normalizeFrameworkUiTrace(baselineRaw);
  const candidate = normalizeFrameworkUiTrace(candidateRaw);
  const differences: FrameworkUiTraceDifference[] = [];
  collectDifferences(baseline, candidate, "$", differences);
  return Object.freeze({
    equal: differences.length === 0,
    differences: Object.freeze(differences),
    baseline,
    candidate,
  });
}

/** Prove that representative contract corruption cannot produce a false PASS. */
export function runFrameworkUiSensitivityProbes(
  normalized: FrameworkUiNormalizedTrace,
): readonly FrameworkUiSensitivityProbe[] {
  const probes: FrameworkUiSensitivityProbe[] = [];

  probes.push(
    runProbe("call-order", normalized, (mutated) => {
      const calls = firstArrayAtKey(mutated, "calls", (items) => items.length >= 2);
      [calls[0], calls[1]] = [calls[1], calls[0]];
    }),
  );

  probes.push(
    runProbe("generation-fencing", normalized, (mutated) => {
      const generations = firstArrayAtKey(
        mutated,
        "generations",
        (items) => items.length >= 2 && items.every((item) => typeof item === "number"),
      );
      generations[generations.length - 1] = -1;
    }),
  );

  probes.push(
    runProbe("final-owner-refcount", normalized, (mutated) => {
      const resources = firstRecordAtKey(mutated, "finalResources");
      resources.owners = 1;
    }),
  );

  probes.push(
    runProbe("cursor-monotonicity", normalized, (mutated) => {
      const cursors = firstArrayAtKey(
        mutated,
        "cursorSeries",
        (items) => items.length >= 2 && items.every((item) => typeof item === "number"),
      );
      cursors[1] = Number(cursors[0]) - 1;
    }),
  );

  probes.push(
    runProbe("idempotency-reuse", normalized, (mutated) => {
      const calls = firstArrayAtKey(mutated, "replayedKeys", (items) => items.length >= 2);
      calls[1] = "<generated-id:999>";
    }),
  );

  probes.push(
    runProbe("optional-answer-preservation", normalized, (mutated) => {
      const answer = firstRecordAtKey(mutated, "optionalAnswerPreserved");
      answer.outcome = "skipped";
    }),
  );

  probes.push(
    runProbe("focus-restoration", normalized, (mutated) => {
      const focus = firstRecordAtKey(mutated, "focus");
      focus.tag = "body";
    }),
  );

  probes.push(
    runProbe("resource-cleanup", normalized, (mutated) => {
      const resources = firstRecordAtKey(mutated, "finalResources");
      resources.listeners = 1;
    }),
  );

  probes.push(
    runProbe("semantic-value", normalized, (mutated) => {
      const calls = firstArrayAtKey(
        mutated,
        "calls",
        (items) => items.length > 0 && isRecord(items[0]),
      );
      const first = calls[0];
      if (!isRecord(first)) throw new Error("sensitivity trace has no structured call");
      first.action = `${String(first.action ?? "call")}:mutated`;
    }),
  );

  return Object.freeze(probes);
}

function ordinalMap(
  values: readonly string[] | undefined,
  label: string,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const value of values ?? []) {
    if (!result.has(value)) result.set(value, `<${label}:${result.size + 1}>`);
  }
  return result;
}

function normalizeValue(
  value: unknown,
  replacements: Readonly<{
    generatedIds: ReadonlyMap<string, string>;
    timestamps: ReadonlyMap<string, string>;
    objectUrls: ReadonlyMap<string, string>;
    origins: ReadonlyMap<string, string>;
  }>,
): unknown {
  if (typeof value === "string") {
    const exact =
      replacements.generatedIds.get(value) ??
      replacements.timestamps.get(value) ??
      replacements.objectUrls.get(value) ??
      replacements.origins.get(value);
    if (exact) return exact;
    for (const [origin, replacement] of replacements.origins) {
      if (value.startsWith(`${origin}/`)) return `${replacement}${value.slice(origin.length)}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, replacements));
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = normalizeValue(value[key], replacements);
  }
  return result;
}

function collectDifferences(
  baseline: unknown,
  candidate: unknown,
  path: string,
  differences: FrameworkUiTraceDifference[],
): void {
  if (Object.is(baseline, candidate)) return;
  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    const length = Math.max(baseline.length, candidate.length);
    for (let index = 0; index < length; index += 1) {
      collectDifferences(baseline[index], candidate[index], `${path}[${index}]`, differences);
    }
    return;
  }
  if (isRecord(baseline) && isRecord(candidate)) {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)]);
    for (const key of [...keys].sort()) {
      collectDifferences(baseline[key], candidate[key], `${path}.${key}`, differences);
    }
    return;
  }
  differences.push(Object.freeze({ path, baseline, candidate }));
}

function runProbe(
  id: FrameworkUiSensitivityProbe["id"],
  normalized: FrameworkUiNormalizedTrace,
  mutate: (value: Record<string, unknown>) => void,
): FrameworkUiSensitivityProbe {
  const mutated = structuredClone(normalized) as Record<string, unknown>;
  mutate(mutated);
  const differences: FrameworkUiTraceDifference[] = [];
  collectDifferences(normalized, mutated, "$", differences);
  return Object.freeze({
    id,
    detected: differences.length > 0,
    differenceCount: differences.length,
  });
}

function firstArrayAtKey(
  root: unknown,
  key: string,
  accept: (items: unknown[]) => boolean = () => true,
): unknown[] {
  const found = findAtKey(
    root,
    key,
    (value): value is unknown[] => Array.isArray(value) && accept(value),
  );
  if (!found) throw new Error(`sensitivity trace does not contain array key ${key}`);
  return found;
}

function firstRecordAtKey(root: unknown, key: string): Record<string, unknown> {
  const found = findAtKey(root, key, isRecord);
  if (!found) throw new Error(`sensitivity trace does not contain object key ${key}`);
  return found;
}

function findAtKey<T>(
  root: unknown,
  key: string,
  predicate: (value: unknown) => value is T,
): T | null {
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findAtKey(item, key, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(root)) return null;
  if (predicate(root[key])) return root[key];
  for (const value of Object.values(root)) {
    const found = findAtKey(value, key, predicate);
    if (found) return found;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
