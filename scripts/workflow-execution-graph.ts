import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";

export const GRAPH_SCHEMA_VERSION = 1 as const;
export const GRAPH_DOMAIN = "opengeni.workflow-execution-graph.v1" as const;
export const GRAPH_CANONICALIZATION = "restricted-yaml-1.2-sorted-json-v1" as const;
export const GRAPH_MANIFEST_PATH = "scripts/workflow-execution-graph-manifest.json" as const;
export const MAX_JOB_TIMEOUT_MINUTES = 120;
export const MAX_STEP_TIMEOUT_MINUTES = 360;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type YamlObject = Record<string, unknown>;

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
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
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
  const canonical: Record<string, JsonValue> = {};
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

function assertRestrictedNode(value: unknown, sourcePath: string): void {
  if (value === null || value === undefined) return;
  if (isAlias(value)) throw new Error(`${sourcePath} uses a YAML alias`);

  const node = value as { anchor?: unknown; tag?: unknown };
  if (typeof node.anchor === "string" && node.anchor.length > 0) {
    throw new Error(`${sourcePath} uses a YAML anchor`);
  }
  if (typeof node.tag === "string" && node.tag.length > 0) {
    throw new Error(`${sourcePath} uses an explicit YAML tag`);
  }

  if (isPair(value)) {
    if (!isScalar(value.key) || typeof value.key.value !== "string") {
      throw new Error(`${sourcePath} uses a non-string YAML mapping key`);
    }
    if (value.key.value === "<<") throw new Error(`${sourcePath} uses a YAML merge key`);
    assertRestrictedNode(value.key, sourcePath);
    assertRestrictedNode(value.value, sourcePath);
    return;
  }
  if (isMap(value) || isSeq(value)) {
    for (const item of value.items) assertRestrictedNode(item, sourcePath);
  }
}

export function parseRestrictedYaml(source: string, sourcePath: string): YamlObject {
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
  assertRestrictedNode(document.contents, sourcePath);
  const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isObject(parsed)) throw new Error(`${sourcePath} must contain one YAML mapping document`);
  canonicalValue(parsed, sourcePath);
  return parsed;
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
  const sourcePaths = new Set(Object.keys(sources));
  const parsedSources = new Map<string, ParsedGraphSource>();

  for (const path of [...sourcePaths].sort()) {
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
      document = parseRestrictedYaml(sources[path] ?? "", path);
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

async function actionDefinitionPaths(root: string): Promise<readonly string[]> {
  const actionRoot = resolve(root, ".github/actions");
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && /^action\.ya?ml$/u.test(entry.name)) {
        found.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  }
  await walk(actionRoot);
  return found.sort();
}

export async function loadWorkflowExecutionSources(root: string): Promise<Record<string, string>> {
  const workflowRoot = resolve(root, ".github/workflows");
  const workflowPaths = (await readdir(workflowRoot))
    .filter((entry) => /\.ya?ml$/u.test(entry))
    .map((entry) => `.github/workflows/${entry}`)
    .sort();
  const paths = [...workflowPaths, ...(await actionDefinitionPaths(root))];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await readFile(resolve(root, path), "utf8")]),
    ),
  );
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

export async function inspectWorkflowExecutionRepository(
  root: string,
): Promise<WorkflowExecutionGraphInspection> {
  return inspectWorkflowExecutionSources(await loadWorkflowExecutionSources(root));
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
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
