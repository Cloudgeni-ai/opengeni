import { createHash } from "node:crypto";
import { lstat, open, opendir, readFile, writeFile } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";

export const GRAPH_SCHEMA_VERSION = 1 as const;
export const GRAPH_DOMAIN = "opengeni.workflow-execution-graph.v1" as const;
export const GRAPH_CANONICALIZATION = "restricted-yaml-1.2-sorted-json-v1" as const;
export const GRAPH_MANIFEST_PATH = "scripts/workflow-execution-graph-manifest.json" as const;
export const MAX_JOB_TIMEOUT_MINUTES = 120;
export const MAX_STEP_TIMEOUT_MINUTES = 360;

// The current graph is 23 sources / ~293 KiB total; its largest source is
// ~82 KiB, largest AST is 3,165 nodes, widest collection is 37 entries, and
// deepest AST path is 14 nodes. These limits leave substantial authored-growth
// margin while bounding every attacker-controlled dimension before recursive
// conversion or canonicalization.
export const WORKFLOW_GRAPH_LIMITS = {
  maxSources: 64,
  maxSourceBytes: 256 * 1024,
  maxTotalSourceBytes: 1024 * 1024,
  maxAstNodesPerSource: 20_000,
  maxTotalAstNodes: 100_000,
  maxCollectionWidth: 1024,
  maxNestingDepth: 64,
  maxActionDiscoveryEntries: 1024,
  maxActionDiscoveryDepth: 16,
  maxWorkflowDiscoveryEntries: 128,
  maxGitProtocolBytes: 2 * 1024 * 1024,
  maxGitDiagnosticBytes: 16 * 1024,
  maxGitRevisionBytes: 256,
  maxGitPathBytes: 4096,
} as const;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type YamlObject = Record<string, unknown>;

type WorkflowSourceLoaderHooks = Readonly<{
  afterPreflight?: (
    sources: readonly Readonly<{ path: string; bytes: number }>[],
  ) => void | Promise<void>;
  beforeRead?: (path: string) => void | Promise<void>;
  onDiscoveryEntry?: (kind: "workflow" | "action", path: string) => void;
  onDirectoryHandleClosed?: (kind: "workflow" | "action", path: string) => void;
  onFileHandleClosed?: (path: string) => void;
}>;

type OpenGraphSource = Readonly<{
  path: string;
  absolutePath: string;
  bytes: number;
  device: number | bigint;
  inode: number | bigint;
  handle: Awaited<ReturnType<typeof open>>;
}>;

export type WorkflowGitTreeLoaderHooks = Readonly<{
  afterTreeCapture?: (treeOid: string) => void | Promise<void>;
  afterBlobPreflight?: (
    sources: readonly Readonly<{ path: string; bytes: number }>[],
  ) => void | Promise<void>;
  beforeBlobRead?: (path: string) => void | Promise<void>;
}>;

type GitTreeEntry = Readonly<{
  path: string;
  mode: string;
  type: string;
  oid: string;
}>;

type GitBlobSource = Readonly<{
  path: string;
  mode: "100644" | "100755";
  oid: string;
  bytes: number;
}>;

export type GraphDigestRecord = Readonly<{ path: string; sha256: string }>;
export type UncappedRunRecord = Readonly<{
  workflow: string;
  job: string;
  step: string;
  sha256: string;
}>;
export type GeneratedLocalTargetRecord = Readonly<{
  workflow: string;
  job: string;
  step: string;
  target: string;
  authority: "retained-release-controller";
}>;

export type WorkflowExecutionGraphManifest = Readonly<{
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  domain: typeof GRAPH_DOMAIN;
  canonicalization: typeof GRAPH_CANONICALIZATION;
  hashAlgorithm: "sha256";
  workflows: readonly GraphDigestRecord[];
  actions: readonly GraphDigestRecord[];
  generatedLocalTargets: readonly GeneratedLocalTargetRecord[];
  uncappedRuns: readonly UncappedRunRecord[];
}>;

export type WorkflowExecutionGraphInspection = Readonly<{
  manifest: WorkflowExecutionGraphManifest;
  violations: readonly string[];
}>;

export type WorkflowGitTreeInspection = Readonly<{
  treeOid: string;
  inspection: WorkflowExecutionGraphInspection;
  manifestViolations: readonly string[];
}>;

type LocalTargetEdge = Readonly<{
  identity: string;
  target: string;
  resolvedPath?: string;
  generatedAuthority?: GeneratedLocalTargetRecord["authority"];
}>;

type ParsedGraphSource = Readonly<{
  path: string;
  kind: "workflow" | "action";
  document: YamlObject;
  edges: readonly LocalTargetEdge[];
}>;

const EXPECTED_GENERATED_LOCAL_TARGETS: readonly GeneratedLocalTargetRecord[] = [
  {
    workflow: ".github/workflows/release-candidate.yml",
    job: "candidate",
    step: "Log in to the public OCI registry",
    target: "./.release/controller/.github/actions/public-oci-login",
    authority: "retained-release-controller",
  },
  {
    workflow: ".github/workflows/release-embedded.yml",
    job: "release",
    step: "Log in to the public OCI registry",
    target: "./.release/controller/.github/actions/public-oci-login",
    authority: "retained-release-controller",
  },
  {
    workflow: ".github/workflows/release.yml",
    job: "images",
    step: "Log in to the public OCI registry",
    target: "./.release/controller/.github/actions/public-oci-login",
    authority: "retained-release-controller",
  },
] as const;

function isObject(value: unknown): value is YamlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown, location = "root"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(`${location} contains a number outside the safe-integer domain`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalValue(entry, `${location}[${index}]`));
  }
  if (!isObject(value)) throw new Error(`${location} contains an unsupported YAML value`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} contains a non-plain YAML mapping`);
  }
  // A normal object treats `__proto__` assignment as prototype mutation. A
  // null-prototype mapping preserves every own YAML key without changing the
  // canonical JSON emitted for the ordinary corpus.
  const canonical = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalValue(value[key], `${location}.${key}`);
  }
  return canonical;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(kind: string, identity: string, value: unknown): string {
  const hash = createHash("sha256");
  hash.update(`${GRAPH_DOMAIN}\0${GRAPH_SCHEMA_VERSION}\0${kind}\0${identity}\0`, "utf8");
  hash.update(typeof value === "string" ? value : canonicalJson(value), "utf8");
  return hash.digest("hex");
}

function utf8Bytes(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

function assertSourceByteBound(source: string, sourcePath: string): number {
  const bytes = utf8Bytes(source);
  if (bytes > WORKFLOW_GRAPH_LIMITS.maxSourceBytes) {
    throw new Error(`${sourcePath} exceeds the per-source UTF-8 byte limit`);
  }
  return bytes;
}

function assertRestrictedStructure(
  value: unknown,
  sourcePath: string,
  nodeLimit = WORKFLOW_GRAPH_LIMITS.maxAstNodesPerSource,
  nodeLimitCategory = "AST node",
): number {
  let nodeCount = 0;
  const stack: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || entry.value === null || entry.value === undefined) continue;
    nodeCount += 1;
    if (nodeCount > nodeLimit) {
      throw new Error(`${sourcePath} exceeds the ${nodeLimitCategory} limit`);
    }
    if (entry.depth > WORKFLOW_GRAPH_LIMITS.maxNestingDepth) {
      throw new Error(`${sourcePath} exceeds the AST nesting-depth limit`);
    }
    if (isAlias(entry.value)) throw new Error(`${sourcePath} uses a YAML alias`);

    const node = entry.value as { anchor?: unknown; tag?: unknown };
    if (typeof node.anchor === "string" && node.anchor.length > 0) {
      throw new Error(`${sourcePath} uses a YAML anchor`);
    }
    if (typeof node.tag === "string" && node.tag.length > 0) {
      throw new Error(`${sourcePath} uses an explicit YAML tag`);
    }

    if (isScalar(entry.value)) {
      if (
        typeof entry.value.value === "number" &&
        (!Number.isSafeInteger(entry.value.value) || Object.is(entry.value.value, -0))
      ) {
        throw new Error(`${sourcePath} uses a numeric scalar outside the safe-integer domain`);
      }
      continue;
    }
    if (isPair(entry.value)) {
      if (!isScalar(entry.value.key) || typeof entry.value.key.value !== "string") {
        throw new Error(`${sourcePath} uses a non-string YAML mapping key`);
      }
      if (entry.value.key.value === "<<") {
        throw new Error(`${sourcePath} uses a YAML merge key`);
      }
      stack.push(
        { value: entry.value.value, depth: entry.depth + 1 },
        { value: entry.value.key, depth: entry.depth + 1 },
      );
      continue;
    }
    if (isMap(entry.value) || isSeq(entry.value)) {
      if (entry.value.items.length > WORKFLOW_GRAPH_LIMITS.maxCollectionWidth) {
        throw new Error(`${sourcePath} exceeds the YAML collection-width limit`);
      }
      for (let index = entry.value.items.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entry.value.items[index], depth: entry.depth + 1 });
      }
    }
  }
  return nodeCount;
}

function parseRestrictedYamlWithStats(
  source: string,
  sourcePath: string,
  nodeLimit = WORKFLOW_GRAPH_LIMITS.maxAstNodesPerSource,
  nodeLimitCategory = "AST node",
): Readonly<{ parsed: YamlObject; nodeCount: number }> {
  assertSourceByteBound(source, sourcePath);
  let document;
  try {
    document = parseDocument(source, {
      merge: false,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch {
    throw new Error(`${sourcePath} is malformed YAML`);
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`${sourcePath} is malformed or unsupported YAML`);
  }
  if (!document.contents || !isMap(document.contents)) {
    throw new Error(`${sourcePath} must contain one YAML mapping document`);
  }
  const nodeCount = assertRestrictedStructure(
    document.contents,
    sourcePath,
    nodeLimit,
    nodeLimitCategory,
  );
  const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isObject(parsed)) throw new Error(`${sourcePath} must contain one YAML mapping document`);
  canonicalValue(parsed, sourcePath);
  return { parsed, nodeCount };
}

export function parseRestrictedYaml(source: string, sourcePath: string): YamlObject {
  return parseRestrictedYamlWithStats(source, sourcePath).parsed;
}

function normalizedLocalPath(target: string): string | null {
  if (!target.startsWith("./")) return null;
  const normalized = posix.normalize(target.slice(2));
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isPotentialLocalTarget(target: string): boolean {
  return target.startsWith(".") || target.startsWith("/");
}

function generatedIdentity(record: GeneratedLocalTargetRecord): string {
  return `${record.workflow}\0${record.job}\0${record.step}\0${record.target}`;
}

function runIdentity(record: Pick<UncappedRunRecord, "workflow" | "job" | "step">): string {
  return `${record.workflow}\0${record.job}\0${record.step}`;
}

function resolveLocalTarget(
  sourcePath: string,
  job: string,
  step: string,
  target: string,
  sourcePaths: ReadonlySet<string>,
  violations: string[],
  generatedTargets: GeneratedLocalTargetRecord[],
): LocalTargetEdge | null {
  const normalized = normalizedLocalPath(target);
  const identity = `${job}:${step}`;
  if (normalized === null) {
    violations.push(`${sourcePath}:${identity} has a path-escaping local target`);
    return null;
  }

  const expectedGenerated = EXPECTED_GENERATED_LOCAL_TARGETS.find(
    (candidate) =>
      candidate.workflow === sourcePath &&
      candidate.job === job &&
      candidate.step === step &&
      candidate.target === target,
  );
  if (expectedGenerated) {
    generatedTargets.push(expectedGenerated);
    return {
      identity,
      target,
      generatedAuthority: expectedGenerated.authority,
    };
  }

  if (/\.ya?ml$/u.test(normalized)) {
    if (!sourcePaths.has(normalized)) {
      violations.push(`${sourcePath}:${identity} has a missing local workflow target`);
      return null;
    }
    return { identity, target, resolvedPath: normalized };
  }

  const candidates = [`${normalized}/action.yml`, `${normalized}/action.yaml`].filter((candidate) =>
    sourcePaths.has(candidate),
  );
  if (candidates.length !== 1) {
    violations.push(
      `${sourcePath}:${identity} has a ${candidates.length === 0 ? "missing" : "ambiguous"} local action target`,
    );
    return null;
  }
  return { identity, target, resolvedPath: candidates[0] };
}

function positiveIntegerTimeout(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function scanWorkflow(
  path: string,
  workflow: YamlObject,
  sourcePaths: ReadonlySet<string>,
  violations: string[],
  uncappedRuns: UncappedRunRecord[],
  generatedTargets: GeneratedLocalTargetRecord[],
): readonly LocalTargetEdge[] {
  const jobs = workflow.jobs;
  if (!isObject(jobs)) {
    violations.push(`${path} must define a jobs mapping`);
    return [];
  }

  const edges: LocalTargetEdge[] = [];
  for (const [jobKey, rawJob] of Object.entries(jobs)) {
    if (!isObject(rawJob)) {
      violations.push(`${path}:${jobKey} must be a job mapping`);
      continue;
    }

    if (rawJob.uses !== undefined) {
      if (typeof rawJob.uses !== "string") {
        violations.push(`${path}:${jobKey} has a non-string reusable workflow target`);
      } else if (isPotentialLocalTarget(rawJob.uses)) {
        const edge = resolveLocalTarget(
          path,
          jobKey,
          "reusable-workflow",
          rawJob.uses,
          sourcePaths,
          violations,
          generatedTargets,
        );
        if (edge) edges.push(edge);
      }
      continue;
    }

    if (!positiveIntegerTimeout(rawJob["timeout-minutes"], MAX_JOB_TIMEOUT_MINUTES)) {
      violations.push(`${path}:${jobKey} job timeout-minutes must be a static integer in 1..120`);
    }

    if (!Array.isArray(rawJob.steps)) {
      violations.push(`${path}:${jobKey} must define a steps sequence`);
      continue;
    }

    const runNames = new Set<string>();
    for (const [stepIndex, rawStep] of rawJob.steps.entries()) {
      if (!isObject(rawStep)) {
        violations.push(`${path}:${jobKey}:step-${stepIndex + 1} must be a step mapping`);
        continue;
      }
      const diagnosticName =
        typeof rawStep.name === "string" && rawStep.name.length > 0
          ? rawStep.name
          : `step-${stepIndex + 1}`;

      const hasCap = Object.hasOwn(rawStep, "timeout-minutes");
      if (hasCap && !positiveIntegerTimeout(rawStep["timeout-minutes"], MAX_STEP_TIMEOUT_MINUTES)) {
        violations.push(
          `${path}:${jobKey}:${diagnosticName} timeout-minutes must be a static integer in 1..360`,
        );
      }

      if (rawStep.uses !== undefined) {
        if (typeof rawStep.uses !== "string") {
          violations.push(`${path}:${jobKey}:${diagnosticName} has a non-string action target`);
        } else if (isPotentialLocalTarget(rawStep.uses)) {
          const edge = resolveLocalTarget(
            path,
            jobKey,
            diagnosticName,
            rawStep.uses,
            sourcePaths,
            violations,
            generatedTargets,
          );
          if (edge) edges.push(edge);
        }
      }

      if (rawStep.run === undefined) continue;
      if (typeof rawStep.run !== "string") {
        violations.push(`${path}:${jobKey}:${diagnosticName} has a non-string run value`);
        continue;
      }
      if (
        typeof rawStep.name !== "string" ||
        rawStep.name.trim().length === 0 ||
        rawStep.name.includes("${{")
      ) {
        violations.push(`${path}:${jobKey}:${diagnosticName} run step needs a static name`);
        continue;
      }
      if (runNames.has(rawStep.name)) {
        violations.push(`${path}:${jobKey}:${rawStep.name} duplicates a run step identity`);
        continue;
      }
      runNames.add(rawStep.name);

      if (!hasCap) {
        const execution = { ...rawStep };
        delete execution.name;
        delete execution["timeout-minutes"];
        uncappedRuns.push({
          workflow: path,
          job: jobKey,
          step: rawStep.name,
          sha256: sha256("uncapped-run", `${path}\0${jobKey}\0${rawStep.name}`, execution),
        });
      }
    }
  }
  return edges;
}

function scanAction(
  path: string,
  action: YamlObject,
  sourcePaths: ReadonlySet<string>,
  violations: string[],
  generatedTargets: GeneratedLocalTargetRecord[],
): readonly LocalTargetEdge[] {
  if (!isObject(action.runs)) {
    violations.push(`${path} must define a runs mapping`);
    return [];
  }
  if (action.runs.using !== "composite" || !Array.isArray(action.runs.steps)) {
    violations.push(`${path} must be a composite action with a steps sequence`);
    return [];
  }
  const edges: LocalTargetEdge[] = [];
  for (const [stepIndex, rawStep] of action.runs.steps.entries()) {
    if (!isObject(rawStep)) {
      violations.push(`${path}:composite:step-${stepIndex + 1} must be a step mapping`);
      continue;
    }
    if (rawStep.uses === undefined) continue;
    const diagnosticName =
      typeof rawStep.name === "string" && rawStep.name.length > 0
        ? rawStep.name
        : `step-${stepIndex + 1}`;
    if (typeof rawStep.uses !== "string") {
      violations.push(`${path}:composite:${diagnosticName} has a non-string action target`);
    } else if (isPotentialLocalTarget(rawStep.uses)) {
      const edge = resolveLocalTarget(
        path,
        "composite",
        diagnosticName,
        rawStep.uses,
        sourcePaths,
        violations,
        generatedTargets,
      );
      if (edge) edges.push(edge);
    }
  }
  return edges;
}

function graphDigest(
  path: string,
  parsedSources: ReadonlyMap<string, ParsedGraphSource>,
  memo: Map<string, string>,
  visiting: Set<string>,
  violations: string[],
): string | null {
  const existing = memo.get(path);
  if (existing) return existing;
  if (visiting.has(path)) {
    violations.push(`${path} participates in a local workflow/action target cycle`);
    return null;
  }
  const source = parsedSources.get(path);
  if (!source) return null;
  visiting.add(path);
  const localTargets: Array<Record<string, string>> = [];
  for (const edge of [...source.edges].sort((left, right) =>
    `${left.identity}\0${left.target}`.localeCompare(`${right.identity}\0${right.target}`),
  )) {
    if (edge.generatedAuthority) {
      localTargets.push({
        identity: edge.identity,
        target: edge.target,
        generatedAuthority: edge.generatedAuthority,
      });
      continue;
    }
    if (!edge.resolvedPath) continue;
    const targetDigest = graphDigest(edge.resolvedPath, parsedSources, memo, visiting, violations);
    if (targetDigest) {
      localTargets.push({
        identity: edge.identity,
        target: edge.target,
        resolvedPath: edge.resolvedPath,
        sha256: targetDigest,
      });
    }
  }
  visiting.delete(path);
  const digest = sha256(`graph-${source.kind}`, path, {
    document: source.document,
    localTargets,
  });
  memo.set(path, digest);
  return digest;
}

export function inspectWorkflowExecutionSources(
  sources: Readonly<Record<string, string>>,
): WorkflowExecutionGraphInspection {
  const violations: string[] = [];
  const uncappedRuns: UncappedRunRecord[] = [];
  const generatedTargets: GeneratedLocalTargetRecord[] = [];
  const sourceEntries = Object.entries(sources).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const sourcePaths = new Set(sourceEntries.map(([path]) => path));
  const parsedSources = new Map<string, ParsedGraphSource>();

  if (sourceEntries.length > WORKFLOW_GRAPH_LIMITS.maxSources) {
    violations.push("workflow execution graph exceeds the source-count limit");
  } else {
    let totalBytes = 0;
    for (const [path, source] of sourceEntries) {
      const bytes = utf8Bytes(source);
      totalBytes += bytes;
      if (bytes > WORKFLOW_GRAPH_LIMITS.maxSourceBytes) {
        violations.push(`${path} exceeds the per-source UTF-8 byte limit`);
      }
    }
    if (totalBytes > WORKFLOW_GRAPH_LIMITS.maxTotalSourceBytes) {
      violations.push("workflow execution graph exceeds the total UTF-8 byte limit");
    }
  }

  if (violations.length > 0) {
    return {
      manifest: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        domain: GRAPH_DOMAIN,
        canonicalization: GRAPH_CANONICALIZATION,
        hashAlgorithm: "sha256",
        workflows: [],
        actions: [],
        generatedLocalTargets: [],
        uncappedRuns: [],
      },
      violations,
    };
  }

  let totalAstNodes = 0;
  for (const [path, source] of sourceEntries) {
    const kind = path.startsWith(".github/workflows/")
      ? "workflow"
      : /^\.github\/actions\/.+\/action\.ya?ml$/u.test(path)
        ? "action"
        : null;
    if (!kind) {
      violations.push(`${path} is outside the workflow execution graph`);
      continue;
    }
    let document: YamlObject;
    try {
      const remainingNodes = WORKFLOW_GRAPH_LIMITS.maxTotalAstNodes - totalAstNodes;
      const sourceNodeLimit = Math.min(WORKFLOW_GRAPH_LIMITS.maxAstNodesPerSource, remainingNodes);
      const parsed = parseRestrictedYamlWithStats(
        source,
        path,
        sourceNodeLimit,
        sourceNodeLimit < WORKFLOW_GRAPH_LIMITS.maxAstNodesPerSource
          ? "total AST node"
          : "AST node",
      );
      document = parsed.parsed;
      totalAstNodes += parsed.nodeCount;
    } catch (error) {
      violations.push(error instanceof Error ? error.message : `${path} is invalid YAML`);
      continue;
    }
    const edges =
      kind === "workflow"
        ? scanWorkflow(path, document, sourcePaths, violations, uncappedRuns, generatedTargets)
        : scanAction(path, document, sourcePaths, violations, generatedTargets);
    parsedSources.set(path, { path, kind, document, edges });
  }

  const observedGenerated = new Set(generatedTargets.map(generatedIdentity));
  for (const expected of EXPECTED_GENERATED_LOCAL_TARGETS) {
    if (sourcePaths.has(expected.workflow) && !observedGenerated.has(generatedIdentity(expected))) {
      violations.push(
        `${expected.workflow}:${expected.job}:${expected.step} is missing its retained-controller target classification`,
      );
    }
  }
  if (observedGenerated.size !== generatedTargets.length) {
    violations.push("generated local target classifications must be unique");
  }

  const memo = new Map<string, string>();
  const workflowDigests: GraphDigestRecord[] = [];
  const actionDigests: GraphDigestRecord[] = [];
  for (const [path, source] of [...parsedSources].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const digest = graphDigest(path, parsedSources, memo, new Set(), violations);
    if (!digest) continue;
    (source.kind === "workflow" ? workflowDigests : actionDigests).push({
      path,
      sha256: digest,
    });
  }

  uncappedRuns.sort((left, right) => runIdentity(left).localeCompare(runIdentity(right)));
  generatedTargets.sort((left, right) =>
    generatedIdentity(left).localeCompare(generatedIdentity(right)),
  );

  return {
    manifest: {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      domain: GRAPH_DOMAIN,
      canonicalization: GRAPH_CANONICALIZATION,
      hashAlgorithm: "sha256",
      workflows: workflowDigests,
      actions: actionDigests,
      generatedLocalTargets: generatedTargets,
      uncappedRuns,
    },
    violations,
  };
}

function repositoryIdentity(root: string, absolute: string): string {
  const identity = relative(root, absolute).split(sep).join("/");
  if (identity === ".." || identity.startsWith("../") || posix.isAbsolute(identity)) {
    throw new Error("workflow execution graph discovery escaped the repository root");
  }
  return identity;
}

async function closeDirectory(
  directory: Awaited<ReturnType<typeof opendir>>,
  hooks: WorkflowSourceLoaderHooks,
  kind: "workflow" | "action",
  path: string,
): Promise<void> {
  try {
    await directory.close();
  } catch (error) {
    if (
      !isObject(error) ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "ERR_DIR_CLOSED"
    ) {
      throw error;
    }
  }
  hooks.onDirectoryHandleClosed?.(kind, path);
}

async function actionDefinitionPaths(
  root: string,
  hooks: WorkflowSourceLoaderHooks,
): Promise<readonly string[]> {
  const actionRoot = resolve(root, ".github/actions");
  const actionRootMetadata = await lstat(actionRoot);
  if (actionRootMetadata.isSymbolicLink() || !actionRootMetadata.isDirectory()) {
    throw new Error("action discovery root must be a regular directory");
  }
  const found: string[] = [];
  let discoveredEntries = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryDepth) {
      throw new Error("action discovery exceeds the directory-depth limit");
    }
    const handle = await opendir(directory);
    try {
      while (true) {
        const entry = await handle.read();
        if (!entry) break;
        const absolute = resolve(directory, entry.name);
        const identity = repositoryIdentity(root, absolute);
        discoveredEntries += 1;
        hooks.onDiscoveryEntry?.("action", identity);
        if (discoveredEntries > WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryEntries) {
          throw new Error("action discovery exceeds the directory-entry limit");
        }
        if (entry.isSymbolicLink()) {
          throw new Error(`${identity} is a forbidden symlink in action discovery`);
        }
        if (entry.isDirectory()) await walk(absolute, depth + 1);
        else if (/^action\.ya?ml$/u.test(entry.name)) {
          if (!entry.isFile()) {
            throw new Error(`${identity} must be a regular action definition file`);
          }
          found.push(identity);
        }
      }
    } finally {
      await closeDirectory(handle, hooks, "action", repositoryIdentity(root, directory));
    }
  }
  await walk(actionRoot, 0);
  return found.sort();
}

async function workflowDefinitionPaths(
  root: string,
  hooks: WorkflowSourceLoaderHooks,
): Promise<readonly string[]> {
  const workflowRoot = resolve(root, ".github/workflows");
  const workflowRootMetadata = await lstat(workflowRoot);
  if (workflowRootMetadata.isSymbolicLink() || !workflowRootMetadata.isDirectory()) {
    throw new Error("workflow discovery root must be a regular directory");
  }
  const found: string[] = [];
  let discoveredEntries = 0;
  const handle = await opendir(workflowRoot);
  try {
    while (true) {
      const entry = await handle.read();
      if (!entry) break;
      const absolute = resolve(workflowRoot, entry.name);
      const identity = repositoryIdentity(root, absolute);
      discoveredEntries += 1;
      hooks.onDiscoveryEntry?.("workflow", identity);
      if (discoveredEntries > WORKFLOW_GRAPH_LIMITS.maxWorkflowDiscoveryEntries) {
        throw new Error("workflow discovery exceeds the directory-entry limit");
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`${identity} is a forbidden symlink in workflow discovery`);
      }
      if (/\.ya?ml$/u.test(entry.name)) {
        if (!entry.isFile()) {
          throw new Error(`${identity} must be a regular workflow definition file`);
        }
        found.push(identity);
      }
    }
  } finally {
    await closeDirectory(handle, hooks, "workflow", repositoryIdentity(root, workflowRoot));
  }
  return found.sort();
}

async function closeGraphSourceHandles(
  sources: readonly OpenGraphSource[],
  hooks: WorkflowSourceLoaderHooks,
): Promise<unknown> {
  let firstError: unknown;
  for (const source of sources) {
    try {
      await source.handle.close();
      hooks.onFileHandleClosed?.(source.path);
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

async function openGraphSources(
  root: string,
  paths: readonly string[],
  hooks: WorkflowSourceLoaderHooks,
): Promise<readonly OpenGraphSource[]> {
  const sources: OpenGraphSource[] = [];
  let totalBytes = 0;
  try {
    for (const path of paths) {
      const absolutePath = resolve(root, path);
      repositoryIdentity(root, absolutePath);
      const pathMetadata = await lstat(absolutePath);
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
        throw new Error(`${path} must be a regular non-symlink graph source`);
      }
      if (pathMetadata.size > WORKFLOW_GRAPH_LIMITS.maxSourceBytes) {
        throw new Error(`${path} exceeds the per-source UTF-8 byte limit`);
      }

      const handle = await open(absolutePath, "r");
      let handleMetadata: Awaited<ReturnType<typeof handle.stat>>;
      try {
        handleMetadata = await handle.stat();
        if (
          !handleMetadata.isFile() ||
          handleMetadata.dev !== pathMetadata.dev ||
          handleMetadata.ino !== pathMetadata.ino ||
          handleMetadata.size !== pathMetadata.size
        ) {
          throw new Error(`${path} changed during graph source preflight`);
        }
        if (handleMetadata.size > WORKFLOW_GRAPH_LIMITS.maxSourceBytes) {
          throw new Error(`${path} exceeds the per-source UTF-8 byte limit`);
        }
        totalBytes += handleMetadata.size;
        if (totalBytes > WORKFLOW_GRAPH_LIMITS.maxTotalSourceBytes) {
          throw new Error("workflow execution graph exceeds the total UTF-8 byte limit");
        }
      } catch (error) {
        await handle.close();
        hooks.onFileHandleClosed?.(path);
        throw error;
      }
      sources.push({
        path,
        absolutePath,
        bytes: handleMetadata.size,
        device: handleMetadata.dev,
        inode: handleMetadata.ino,
        handle,
      });
    }
    return sources;
  } catch (error) {
    await closeGraphSourceHandles(sources, hooks);
    throw error;
  }
}

async function readGraphSource(
  root: string,
  source: OpenGraphSource,
  hooks: WorkflowSourceLoaderHooks,
): Promise<string> {
  await hooks.beforeRead?.(source.path);
  const bytes = new Uint8Array(source.bytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await source.handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== source.bytes) {
    throw new Error(`${source.path} changed size while reading graph source`);
  }
  const finalHandleMetadata = await source.handle.stat();
  const finalPathMetadata = await lstat(source.absolutePath);
  if (
    !finalHandleMetadata.isFile() ||
    finalHandleMetadata.size !== source.bytes ||
    finalHandleMetadata.dev !== source.device ||
    finalHandleMetadata.ino !== source.inode ||
    finalPathMetadata.isSymbolicLink() ||
    !finalPathMetadata.isFile() ||
    finalPathMetadata.size !== source.bytes ||
    finalPathMetadata.dev !== source.device ||
    finalPathMetadata.ino !== source.inode ||
    repositoryIdentity(root, source.absolutePath) !== source.path
  ) {
    throw new Error(`${source.path} changed while reading graph source`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, source.bytes));
  } catch {
    throw new Error(`${source.path} contains invalid UTF-8`);
  }
}

export async function loadWorkflowExecutionSources(
  root: string,
  hooks: WorkflowSourceLoaderHooks = {},
): Promise<Record<string, string>> {
  // Local authoring mode intentionally observes the checkout. It supports
  // dirty additions, removals, renames, and edits, and therefore requires a
  // stable/quiescent worktree while discovery and reads are in progress. CI's
  // hostile-mutation boundary is the immutable Git-tree mode below.
  const paths = [
    ...(await workflowDefinitionPaths(root, hooks)),
    ...(await actionDefinitionPaths(root, hooks)),
  ].sort();
  if (paths.length > WORKFLOW_GRAPH_LIMITS.maxSources) {
    throw new Error("workflow execution graph exceeds the source-count limit during discovery");
  }
  const openSources = await openGraphSources(root, paths, hooks);
  let result: Record<string, string> | undefined;
  let operationError: unknown;
  try {
    await hooks.afterPreflight?.(openSources.map(({ path, bytes }) => ({ path, bytes })));
    const entries: Array<readonly [string, string]> = [];
    for (const source of openSources) {
      entries.push([source.path, await readGraphSource(root, source, hooks)]);
    }
    result = Object.fromEntries(entries);
  } catch (error) {
    operationError = error;
  }
  const closeError = await closeGraphSourceHandles(openSources, hooks);
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  return result ?? {};
}

async function collectBoundedGitOutput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onOverflow: () => void,
): Promise<Readonly<{ bytes: Uint8Array; overflow: boolean }>> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let overflow = false;
  const reader = stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      if (!overflow) onOverflow();
      overflow = true;
      continue;
    }
    if (!overflow) chunks.push(result.value);
  }
  if (overflow) return { bytes: new Uint8Array(), overflow: true };
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow: false };
}

async function runBoundedGit(
  root: string,
  args: readonly string[],
  category: string,
  maximumOutputBytes = WORKFLOW_GRAPH_LIMITS.maxGitProtocolBytes,
  input?: string,
): Promise<Uint8Array> {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(Bun.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_"),
    ),
  );
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    env: {
      ...inheritedEnvironment,
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => {
    try {
      child.kill();
    } catch {
      // The process may have exited between the bounded read and cancellation.
    }
  };
  const [stdout, stderr, exitCode] = await Promise.all([
    collectBoundedGitOutput(child.stdout as ReadableStream<Uint8Array>, maximumOutputBytes, stop),
    collectBoundedGitOutput(
      child.stderr as ReadableStream<Uint8Array>,
      WORKFLOW_GRAPH_LIMITS.maxGitDiagnosticBytes,
      stop,
    ),
    child.exited,
  ]);
  if (stdout.overflow || stderr.overflow) {
    throw new Error(`${category} exceeded the bounded Git protocol limit`);
  }
  if (exitCode !== 0) throw new Error(`${category} failed`);
  return stdout.bytes;
}

function decodeGitUtf8(bytes: Uint8Array, category: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${category} contains invalid UTF-8`);
  }
}

function assertGitPath(path: string, pathBytes: number): void {
  if (pathBytes === 0 || pathBytes > WORKFLOW_GRAPH_LIMITS.maxGitPathBytes) {
    throw new Error("Git tree inventory contains an invalid path length");
  }
  if (/^[/]|[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error("Git tree inventory contains an invalid path");
  }
  const components = path.split("/");
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw new Error("Git tree inventory contains a path escape");
  }
}

function parseGitTreeEntries(bytes: Uint8Array): readonly GitTreeEntry[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0) {
    throw new Error("Git tree inventory has a truncated protocol record");
  }
  const entries: GitTreeEntry[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    const record = bytes.subarray(start, index);
    start = index + 1;
    let tab = -1;
    for (let cursor = 0; cursor < record.byteLength; cursor += 1) {
      if (record[cursor] === 9) {
        tab = cursor;
        break;
      }
    }
    if (tab <= 0 || tab === record.byteLength - 1) {
      throw new Error("Git tree inventory has a malformed protocol record");
    }
    const header = decodeGitUtf8(record.subarray(0, tab), "Git tree metadata");
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(header);
    if (!match) throw new Error("Git tree inventory has invalid object metadata");
    const pathBytes = record.subarray(tab + 1);
    const path = decodeGitUtf8(pathBytes, "Git tree path");
    assertGitPath(path, pathBytes.byteLength);
    entries.push({ mode: match[1] ?? "", type: match[2] ?? "", oid: match[3] ?? "", path });
  }
  return entries;
}

function assertRegularGitBlob(entry: GitTreeEntry): asserts entry is GitTreeEntry & {
  mode: "100644" | "100755";
  type: "blob";
} {
  if (entry.mode === "120000") {
    throw new Error(`${entry.path} is a forbidden symlink in the Git tree`);
  }
  if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    throw new Error(`${entry.path} is not a regular Git blob`);
  }
}

async function resolveGitTree(root: string, revision: string): Promise<string> {
  const revisionBytes = new TextEncoder().encode(revision).byteLength;
  if (
    revisionBytes === 0 ||
    revisionBytes > WORKFLOW_GRAPH_LIMITS.maxGitRevisionBytes ||
    /[\u0000\r\n]/u.test(revision)
  ) {
    throw new Error("Git tree revision is invalid");
  }
  const output = await runBoundedGit(
    root,
    ["rev-parse", "--verify", "--end-of-options", revision],
    "Git tree resolution",
    128,
  );
  const oid = decodeGitUtf8(output, "Git tree resolution").trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) {
    throw new Error("Git tree resolution returned an invalid object identity");
  }
  const type = decodeGitUtf8(
    await runBoundedGit(root, ["cat-file", "-t", oid], "Git tree type check", 32),
    "Git tree type check",
  ).trim();
  if (type !== "tree") throw new Error("Git tree revision did not resolve to a tree");
  return oid;
}

async function listGitTreeDirectory(
  root: string,
  treeOid: string,
  path: ".github/workflows" | ".github/actions",
  recursive: boolean,
): Promise<readonly GitTreeEntry[]> {
  const args = recursive
    ? ["ls-tree", "-rtz", "--full-tree", `${treeOid}:${path}`]
    : ["ls-tree", "-z", `${treeOid}:${path}`];
  return parseGitTreeEntries(await runBoundedGit(root, args, `${path} Git tree inventory`));
}

async function gitTreeGraphEntries(
  root: string,
  treeOid: string,
): Promise<readonly GitTreeEntry[]> {
  const workflowEntries = await listGitTreeDirectory(root, treeOid, ".github/workflows", false);
  if (workflowEntries.length > WORKFLOW_GRAPH_LIMITS.maxWorkflowDiscoveryEntries) {
    throw new Error("workflow Git tree discovery exceeds the directory-entry limit");
  }
  const selected: GitTreeEntry[] = [];
  for (const entry of workflowEntries) {
    const path = `.github/workflows/${entry.path}`;
    const identified = { ...entry, path };
    assertGitPath(path, new TextEncoder().encode(path).byteLength);
    assertRegularGitBlob(identified);
    if (/\.ya?ml$/u.test(entry.path)) selected.push(identified);
  }

  const actionEntries = await listGitTreeDirectory(root, treeOid, ".github/actions", true);
  if (actionEntries.length > WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryEntries) {
    throw new Error("action Git tree discovery exceeds the directory-entry limit");
  }
  const actionDefinitions = new Map<string, GitTreeEntry[]>();
  for (const entry of actionEntries) {
    const components = entry.path.split("/");
    const depth = entry.type === "tree" ? components.length : components.length - 1;
    if (depth > WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryDepth) {
      throw new Error("action Git tree discovery exceeds the directory-depth limit");
    }
    const path = `.github/actions/${entry.path}`;
    const identified = { ...entry, path };
    assertGitPath(path, new TextEncoder().encode(path).byteLength);
    if (entry.type === "tree" && entry.mode === "040000") continue;
    assertRegularGitBlob(identified);
    if (!/^action\.ya?ml$/u.test(components.at(-1) ?? "")) continue;
    const parent = posix.dirname(path);
    const definitions = actionDefinitions.get(parent) ?? [];
    definitions.push(identified);
    actionDefinitions.set(parent, definitions);
  }
  for (const definitions of actionDefinitions.values()) {
    if (definitions.length !== 1) {
      throw new Error("Git tree action discovery found ambiguous action definitions");
    }
    selected.push(definitions[0] as GitTreeEntry);
  }
  if (selected.length > WORKFLOW_GRAPH_LIMITS.maxSources) {
    throw new Error("workflow execution graph exceeds the source-count limit in the Git tree");
  }
  const paths = new Set<string>();
  for (const entry of selected) {
    if (paths.has(entry.path))
      throw new Error("Git tree inventory contains a duplicate source path");
    paths.add(entry.path);
  }
  return selected.sort((left, right) => left.path.localeCompare(right.path));
}

async function gitTreeManifestEntry(root: string, treeOid: string): Promise<GitTreeEntry> {
  const entries = parseGitTreeEntries(
    await runBoundedGit(
      root,
      ["ls-tree", "-z", "--full-tree", treeOid, "--", GRAPH_MANIFEST_PATH],
      "workflow graph manifest Git tree lookup",
    ),
  );
  if (entries.length !== 1 || entries[0]?.path !== GRAPH_MANIFEST_PATH) {
    throw new Error("workflow graph manifest is missing or ambiguous in the Git tree");
  }
  const entry = entries[0];
  assertRegularGitBlob(entry);
  return entry;
}

async function preflightGitBlobs(
  root: string,
  entries: readonly GitTreeEntry[],
): Promise<readonly GitBlobSource[]> {
  const input = `${entries.map((entry) => entry.oid).join("\n")}\n`;
  const output = decodeGitUtf8(
    await runBoundedGit(
      root,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      "Git blob preflight",
      Math.min(WORKFLOW_GRAPH_LIMITS.maxGitProtocolBytes, entries.length * 160),
      input,
    ),
    "Git blob preflight",
  );
  const rows = output.endsWith("\n") ? output.slice(0, -1).split("\n") : [];
  if (rows.length !== entries.length)
    throw new Error("Git blob preflight returned an invalid count");
  let totalBytes = 0;
  const sources: GitBlobSource[] = [];
  for (const [index, entry] of entries.entries()) {
    assertRegularGitBlob(entry);
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u.exec(rows[index] ?? "");
    if (!match || match[1] !== entry.oid) {
      throw new Error(`${entry.path} failed Git blob identity preflight`);
    }
    const bytes = Number(match[2]);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`${entry.path} has an invalid Git blob size`);
    }
    if (bytes > WORKFLOW_GRAPH_LIMITS.maxSourceBytes) {
      throw new Error(`${entry.path} exceeds the per-source UTF-8 byte limit`);
    }
    totalBytes += bytes;
    if (totalBytes > WORKFLOW_GRAPH_LIMITS.maxTotalSourceBytes) {
      throw new Error("workflow execution Git tree exceeds the total UTF-8 byte limit");
    }
    sources.push({ path: entry.path, mode: entry.mode, oid: entry.oid, bytes });
  }
  return sources;
}

function gitBlobIdentity(bytes: Uint8Array, oidLength: number): string {
  const algorithm = oidLength === 64 ? "sha256" : "sha1";
  const hash = createHash(algorithm);
  hash.update(`blob ${bytes.byteLength}\0`, "utf8");
  hash.update(bytes);
  return hash.digest("hex");
}

async function readGitBlob(root: string, source: GitBlobSource): Promise<string> {
  const bytes = await runBoundedGit(
    root,
    ["cat-file", "blob", source.oid],
    `${source.path} Git blob read`,
    source.bytes + 1,
  );
  if (
    bytes.byteLength !== source.bytes ||
    gitBlobIdentity(bytes, source.oid.length) !== source.oid
  ) {
    throw new Error(`${source.path} failed Git blob length or identity verification`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${source.path} contains invalid UTF-8`);
  }
}

async function loadWorkflowExecutionGitTree(
  root: string,
  treeOid: string,
  hooks: WorkflowGitTreeLoaderHooks,
): Promise<Readonly<{ sources: Record<string, string>; committedManifest: unknown }>> {
  const graphEntries = await gitTreeGraphEntries(root, treeOid);
  const manifestEntry = await gitTreeManifestEntry(root, treeOid);
  const blobs = await preflightGitBlobs(root, [...graphEntries, manifestEntry]);
  await hooks.afterBlobPreflight?.(blobs.map(({ path, bytes }) => ({ path, bytes })));
  const sources: Array<readonly [string, string]> = [];
  let manifestSource: string | undefined;
  for (const blob of blobs) {
    await hooks.beforeBlobRead?.(blob.path);
    const source = await readGitBlob(root, blob);
    if (blob.path === GRAPH_MANIFEST_PATH) manifestSource = source;
    else sources.push([blob.path, source]);
  }
  let committedManifest: unknown;
  try {
    committedManifest = JSON.parse(manifestSource ?? "");
  } catch {
    throw new Error("workflow graph manifest is malformed in the Git tree");
  }
  return { sources: Object.fromEntries(sources), committedManifest };
}

function compareRows(
  kind: string,
  committed: readonly GraphDigestRecord[],
  current: readonly GraphDigestRecord[],
): string[] {
  const violations: string[] = [];
  const committedMap = new Map<string, string>();
  for (const row of committed) {
    if (committedMap.has(row.path)) violations.push(`manifest duplicates ${kind} ${row.path}`);
    committedMap.set(row.path, row.sha256);
  }
  const currentMap = new Map(current.map((row) => [row.path, row.sha256]));
  for (const [path, digest] of currentMap) {
    if (!committedMap.has(path)) violations.push(`manifest is missing ${kind} ${path}`);
    else if (committedMap.get(path) !== digest)
      violations.push(`${kind} digest changed for ${path}`);
  }
  for (const path of committedMap.keys()) {
    if (!currentMap.has(path)) violations.push(`manifest has stale ${kind} ${path}`);
  }
  return violations;
}

function compareRuns(
  committed: readonly UncappedRunRecord[],
  current: readonly UncappedRunRecord[],
): string[] {
  const violations: string[] = [];
  const committedMap = new Map<string, string>();
  for (const row of committed) {
    const identity = runIdentity(row);
    if (committedMap.has(identity)) {
      violations.push(`manifest duplicates uncapped run ${row.workflow}:${row.job}:${row.step}`);
    }
    committedMap.set(identity, row.sha256);
  }
  const currentMap = new Map(current.map((row) => [runIdentity(row), row]));
  for (const [identity, row] of currentMap) {
    const digest = committedMap.get(identity);
    if (digest === undefined) {
      violations.push(`manifest is missing uncapped run ${row.workflow}:${row.job}:${row.step}`);
    } else if (digest !== row.sha256) {
      violations.push(`uncapped run digest changed for ${row.workflow}:${row.job}:${row.step}`);
    }
  }
  for (const row of committed) {
    if (!currentMap.has(runIdentity(row))) {
      violations.push(`manifest has stale uncapped run ${row.workflow}:${row.job}:${row.step}`);
    }
  }
  return violations;
}

function manifestShape(value: unknown): value is WorkflowExecutionGraphManifest {
  if (!isObject(value)) return false;
  const hasOnlyKeys = (candidate: YamlObject, expected: readonly string[]) =>
    Object.keys(candidate).sort().join("\0") === [...expected].sort().join("\0");
  const isDigest = (candidate: unknown): candidate is GraphDigestRecord =>
    isObject(candidate) &&
    hasOnlyKeys(candidate, ["path", "sha256"]) &&
    typeof candidate.path === "string" &&
    /^[0-9a-f]{64}$/u.test(String(candidate.sha256));
  const isRun = (candidate: unknown): candidate is UncappedRunRecord =>
    isObject(candidate) &&
    hasOnlyKeys(candidate, ["workflow", "job", "step", "sha256"]) &&
    typeof candidate.workflow === "string" &&
    typeof candidate.job === "string" &&
    typeof candidate.step === "string" &&
    /^[0-9a-f]{64}$/u.test(String(candidate.sha256));
  const isGenerated = (candidate: unknown): candidate is GeneratedLocalTargetRecord =>
    isObject(candidate) &&
    hasOnlyKeys(candidate, ["workflow", "job", "step", "target", "authority"]) &&
    typeof candidate.workflow === "string" &&
    typeof candidate.job === "string" &&
    typeof candidate.step === "string" &&
    typeof candidate.target === "string" &&
    candidate.authority === "retained-release-controller";
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "domain",
      "canonicalization",
      "hashAlgorithm",
      "workflows",
      "actions",
      "generatedLocalTargets",
      "uncappedRuns",
    ]) &&
    value.schemaVersion === GRAPH_SCHEMA_VERSION &&
    value.domain === GRAPH_DOMAIN &&
    value.canonicalization === GRAPH_CANONICALIZATION &&
    value.hashAlgorithm === "sha256" &&
    Array.isArray(value.workflows) &&
    value.workflows.every(isDigest) &&
    Array.isArray(value.actions) &&
    value.actions.every(isDigest) &&
    Array.isArray(value.generatedLocalTargets) &&
    value.generatedLocalTargets.every(isGenerated) &&
    Array.isArray(value.uncappedRuns) &&
    value.uncappedRuns.every(isRun)
  );
}

export function compareWorkflowExecutionManifest(
  committedValue: unknown,
  current: WorkflowExecutionGraphManifest,
): readonly string[] {
  if (!manifestShape(committedValue)) return ["workflow execution manifest has an invalid shape"];
  const committed = committedValue;
  const violations = [
    ...compareRows("workflow", committed.workflows, current.workflows),
    ...compareRows("action", committed.actions, current.actions),
    ...compareRuns(committed.uncappedRuns, current.uncappedRuns),
  ];
  const committedGenerated = committed.generatedLocalTargets.map(generatedIdentity).sort();
  const currentGenerated = current.generatedLocalTargets.map(generatedIdentity).sort();
  if (new Set(committedGenerated).size !== committedGenerated.length) {
    violations.push("manifest duplicates a generated local target classification");
  }
  if (canonicalJson(committedGenerated) !== canonicalJson(currentGenerated)) {
    violations.push("generated local target classifications changed");
  }
  return violations;
}

export async function inspectWorkflowExecutionGitTreeRepository(
  root: string,
  revision: string,
  hooks: WorkflowGitTreeLoaderHooks = {},
): Promise<WorkflowGitTreeInspection> {
  const treeOid = await resolveGitTree(root, revision);
  await hooks.afterTreeCapture?.(treeOid);
  const loaded = await loadWorkflowExecutionGitTree(root, treeOid, hooks);
  const inspection = inspectWorkflowExecutionSources(loaded.sources);
  return {
    treeOid,
    inspection,
    manifestViolations: compareWorkflowExecutionManifest(
      loaded.committedManifest,
      inspection.manifest,
    ),
  };
}

export async function inspectWorkflowExecutionRepository(
  root: string,
): Promise<WorkflowExecutionGraphInspection> {
  return inspectWorkflowExecutionSources(await loadWorkflowExecutionSources(root));
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const arguments_ = process.argv.slice(2);
  const gitTreeIndex = arguments_.indexOf("--git-tree");
  if (gitTreeIndex !== -1) {
    if (
      arguments_.includes("--write") ||
      gitTreeIndex !== 0 ||
      arguments_.length !== 2 ||
      !arguments_[1]
    ) {
      console.error(
        "workflow graph: --git-tree requires one revision and is incompatible with --write",
      );
      process.exitCode = 1;
      return;
    }
    let checked: WorkflowGitTreeInspection;
    try {
      checked = await inspectWorkflowExecutionGitTreeRepository(root, arguments_[1]);
    } catch (error) {
      console.error(
        `workflow graph: ${error instanceof Error ? error.message : "Git-tree inspection failed"}`,
      );
      process.exitCode = 1;
      return;
    }
    const violations = [...checked.inspection.violations, ...checked.manifestViolations];
    if (violations.length > 0) {
      for (const violation of violations) console.error(`workflow graph: ${violation}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `verified ${checked.inspection.manifest.workflows.length} workflows, ${checked.inspection.manifest.actions.length} actions, and ${checked.inspection.manifest.uncappedRuns.length} uncapped runs from Git tree ${checked.treeOid}`,
    );
    return;
  }
  const inspection = await inspectWorkflowExecutionRepository(root);
  if (inspection.violations.length > 0) {
    for (const violation of inspection.violations) console.error(`workflow graph: ${violation}`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--write")) {
    await writeFile(
      resolve(root, GRAPH_MANIFEST_PATH),
      `${JSON.stringify(inspection.manifest, null, 2)}\n`,
    );
    console.log(
      `wrote ${inspection.manifest.workflows.length} workflows, ${inspection.manifest.actions.length} actions, and ${inspection.manifest.uncappedRuns.length} uncapped runs`,
    );
    return;
  }
  let committed: unknown;
  try {
    committed = JSON.parse(await readFile(resolve(root, GRAPH_MANIFEST_PATH), "utf8"));
  } catch {
    console.error("workflow graph: manifest is missing or malformed");
    process.exitCode = 1;
    return;
  }
  const violations = compareWorkflowExecutionManifest(committed, inspection.manifest);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`workflow graph: ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `verified ${inspection.manifest.workflows.length} workflows, ${inspection.manifest.actions.length} actions, and ${inspection.manifest.uncappedRuns.length} uncapped runs`,
  );
}

if (import.meta.main) await main();
