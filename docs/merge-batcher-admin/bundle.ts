/** Offline only. This module never invokes Git, a shell, or a network API. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export type RuleSet = ObjectValue & { id: number };
export type Snapshot = {
  repository: { full_name: string; default_branch: string; allow_squash_merge: boolean };
  rulesets: RuleSet[];
  classic: { nodes: Json[]; pageInfo: { hasNextPage: boolean } };
};
export type Plan = {
  schemaVersion: 3;
  appId: number;
  installationId: number;
  before: Snapshot;
  admissionId: number;
  admission: ObjectValue;
  restore: ObjectValue;
  guard: ObjectValue;
  namespace: ObjectValue;
};
export type Phase = "original" | "guard" | "namespace" | "applied" | "restored";
const writableKeys = ["name", "target", "enforcement", "bypass_actors", "conditions", "rules"];
const guardName = "Opengeni batcher immutable refs";
const namespaceName = "Merges go through the batcher: add the queue-ready label";
const refs = ["refs/heads/queue/live/**", "refs/heads/batcher-state"];

function object(value: Json | undefined): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value;
}
function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Expected assigned positive ID");
  return value;
}
export function writable(value: ObjectValue): ObjectValue {
  const result: ObjectValue = {};
  for (const key of writableKeys) {
    if (!(key in value)) throw new Error(`Missing ruleset field: ${key}`);
    result[key] = value[key]!;
  }
  return result;
}
// Ruleset lists are sets, including rules/bypass actors/ref patterns. Preserve
// multiplicity so an unexpected duplicate still fails the readback comparison.
function canonical(value: Json, rule = false): string {
  if (Array.isArray(value))
    return `[${value
      .map((item) => canonical(item, rule))
      .sort()
      .join(",")}]`;
  if (value && typeof value === "object") {
    // GitHub stores the default update rule without parameters. Normalize only
    // that exact rule shape, in rules arrays, on both comparison sides. Explicit
    // false already has this form; empty/null/extra fields must remain different.
    const normalized: ObjectValue =
      rule && value.type === "update" && Object.keys(value).length === 1
        ? { type: "update", parameters: { update_allows_fetch_and_merge: false } }
        : value;
    return `{${Object.keys(normalized)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(normalized[key]!, key === "rules" && writableKeys.every((field) => field in normalized))}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function equal(actual: Json, expected: Json, label: string): void {
  if (canonical(actual) !== canonical(expected)) throw new Error(`${label}: readback drift`);
}
function index(rules: RuleSet[]): Map<number, ObjectValue> {
  const result = new Map<number, ObjectValue>();
  for (const rule of rules) {
    const id = positiveId(rule.id);
    if (result.has(id)) throw new Error("Duplicate ruleset ID");
    result.set(id, writable(rule));
  }
  return result;
}

export function prepare(before: Snapshot, appId: number, installationId: number): Plan {
  positiveId(appId);
  positiveId(installationId);
  if (
    before.repository.full_name !== "Cloudgeni-ai/opengeni" ||
    before.repository.default_branch !== "main" ||
    !before.repository.allow_squash_merge
  ) {
    throw new Error("Repository/default branch/manual squash prerequisite differs");
  }
  if (before.classic.pageInfo.hasNextPage || before.classic.nodes.length) {
    throw new Error("Classic protection needs separate review; do not replace it");
  }
  index(before.rulesets);
  if (
    before.rulesets.some(
      (r) =>
        r.name === guardName ||
        r.name === namespaceName ||
        r.name === "Opengeni batcher dedicated writer",
    )
  )
    throw new Error("Prepared ruleset name already exists; reconcile prior execution first");
  const matches = before.rulesets.filter(
    (r) =>
      r.name === "Protection" &&
      r.source_type === "Repository" &&
      r.source === "Cloudgeni-ai/opengeni",
  );
  if (matches.length !== 1) throw new Error("Expected one repository-owned Protection ruleset");
  const original = matches[0]!;
  if (original.target !== "branch" || original.enforcement !== "active")
    throw new Error("Protection is not active branch admission");
  equal(
    original.conditions!,
    { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    "Admission scope",
  );
  if (!Array.isArray(original.rules)) throw new Error("Missing rules");
  const kinds = original.rules.map((rule) => object(rule).type!);
  equal(kinds, ["deletion", "non_fast_forward", "pull_request"], "Original rule types");
  const pr = original.rules.find((rule) => object(rule).type === "pull_request")!;
  equal(object(object(pr).parameters).allowed_merge_methods!, ["squash"], "Manual merge methods");
  const restore = writable(original);
  const bypass = [
    { actor_id: appId, actor_type: "Integration", bypass_mode: "always" },
    // GitHub ignores actor_id for OrganizationAdmin; this is not an assigned ID.
    { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
  ];
  const admission = { ...restore, rules: [pr], bypass_actors: bypass };
  const guard = {
    name: guardName,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main", ...refs], exclude: [] } },
    rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
  };
  const namespace = {
    name: namespaceName,
    target: "branch",
    enforcement: "active",
    bypass_actors: bypass,
    conditions: { ref_name: { include: ["refs/heads/main", ...refs], exclude: [] } },
    rules: [
      { type: "creation" },
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
    ],
  };
  return {
    schemaVersion: 3,
    appId,
    installationId,
    before,
    admissionId: original.id,
    admission,
    restore,
    guard,
    namespace,
  };
}

/** Check the complete inventory, not just the new rules. No API mutations. */
export function verify(
  plan: Plan,
  current: Snapshot,
  phase: Phase,
  receipts: { guard?: RuleSet; namespace?: RuleSet } = {},
): void {
  validatePlan(plan);
  equal(current.repository, plan.before.repository, "Repository configuration");
  equal(current.classic, plan.before.classic, "Classic protection");
  const expected = index(plan.before.rulesets);
  const includeGuard = phase === "guard" || phase === "namespace" || phase === "applied";
  const includeNamespace = phase === "namespace" || phase === "applied";
  function add(receipt: RuleSet | undefined, payload: ObjectValue, name: string) {
    if (!receipt) throw new Error(`Missing ${name} creation receipt`);
    const id = positiveId(receipt.id);
    if (expected.has(id)) throw new Error("Creation receipt collides with an existing ID");
    equal(writable(receipt), payload, `${name} creation receipt`);
    expected.set(id, payload);
  }
  if (includeGuard) add(receipts.guard, plan.guard, "guard");
  if (includeNamespace) add(receipts.namespace, plan.namespace, "namespace");
  if (phase === "applied") expected.set(plan.admissionId, plan.admission);
  const actual = index(current.rulesets);
  equal([...actual.keys()], [...expected.keys()], "Full ruleset inventory");
  for (const [id, payload] of expected) equal(actual.get(id)!, payload, `Ruleset ${id}`);
}

/** Older plans have different bypass policy; never silently upgrade them. */
export function validatePlan(plan: Plan): void {
  if (plan.schemaVersion !== 3)
    throw new Error("Emergency-admin rollout requires a newly reviewed version 3 plan");
  const expected = prepare(plan.before, plan.appId, plan.installationId);
  equal(plan as unknown as Json, expected as unknown as Json, "Prepared exclusive-main plan");
}

export function mergeMode(phase: Phase): "manual" | "queue-only" | "hold" {
  return phase === "original" || phase === "restored"
    ? "manual"
    : phase === "applied"
      ? "queue-only"
      : "hold";
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
export async function cli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "receipt" && rest.length === 4) {
    const [directory, snapshot, kind, candidatePath] = rest as [string, string, string, string];
    if (kind !== "guard" && kind !== "namespace") throw new Error("Unknown receipt kind");
    const plan = await json<Plan>(join(directory, "plan.json"));
    const candidate = await json<RuleSet>(candidatePath);
    if (candidate.source_type !== "Repository" || candidate.source !== "Cloudgeni-ai/opengeni") {
      throw new Error("Creation receipt must belong to this repository");
    }
    const receipts: { guard?: RuleSet; namespace?: RuleSet } = { [kind]: candidate };
    if (kind === "namespace") receipts.guard = await json(join(directory, "guard-receipt.json"));
    verify(plan, await json<Snapshot>(snapshot), kind, receipts);
    const destination = join(directory, `${kind}-receipt.json`);
    try {
      const existing = await json<RuleSet>(destination);
      equal(
        { id: existing.id, ...writable(existing) },
        { id: candidate.id, ...writable(candidate) },
        "Retained receipt",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(destination, `${JSON.stringify(candidate, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    console.log(`Verified and retained ${kind} receipt; no API writes.`);
    return;
  }
  if (command === "prepare" && rest.length === 4) {
    const [snapshot, app, installation, output] = rest as [string, string, string, string];
    const plan = prepare(await json<Snapshot>(snapshot), Number(app), Number(installation));
    await mkdir(output, { recursive: false, mode: 0o700 });
    for (const [name, value] of Object.entries({
      plan,
      admission: plan.admission,
      restore: plan.restore,
      guard: plan.guard,
      namespace: plan.namespace,
    })) {
      await writeFile(join(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    console.log("Offline payloads prepared; no configuration applied.");
    return;
  }
  if (command === "verify" && rest.length === 3) {
    const [directory, snapshot, phase] = rest as [string, string, string];
    if (!["original", "guard", "namespace", "applied", "restored"].includes(phase))
      throw new Error("Unknown phase");
    const receipts: { guard?: RuleSet; namespace?: RuleSet } = {};
    if (["guard", "namespace", "applied"].includes(phase))
      receipts.guard = await json(join(directory, "guard-receipt.json"));
    if (["namespace", "applied"].includes(phase))
      receipts.namespace = await json(join(directory, "namespace-receipt.json"));
    verify(
      await json<Plan>(join(directory, "plan.json")),
      await json<Snapshot>(snapshot),
      phase as Phase,
      receipts,
    );
    console.log(
      `Verified complete ${phase} inventory. Agent merge mode: ${mergeMode(phase as Phase)}.`,
    );
    return;
  }
  throw new Error(
    "Usage: bundle.ts prepare SNAPSHOT APP_ID INSTALLATION_ID NEW_OUTPUT_DIRECTORY | verify OUTPUT_DIRECTORY CURRENT_SNAPSHOT original|guard|namespace|applied|restored | receipt OUTPUT_DIRECTORY CURRENT_SNAPSHOT guard|namespace CANDIDATE_JSON",
  );
}
if (import.meta.main) await cli(process.argv.slice(2));
