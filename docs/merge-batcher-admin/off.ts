/** Operator-only STOP + exact reverse stages. Importing this file does nothing. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { validatePlan, verify, type Phase, type Plan, type RuleSet, type Snapshot } from "./bundle";
import { checkpoint } from "./watchdog-journal";

const controlFiles = [
  "control.ts",
  "cloud-auth.ts",
  "service-config.ts",
  "service-limits.ts",
  "stopped-reconciliation.ts",
] as const;
type DrainWitness = {
  uid: string;
  generation: string | number;
  mode: string;
  instance: string;
  controlGeneration: string;
};
type Reconciliation = {
  outcome: string;
  stateSha: string;
  mainSha: string;
  candidateRefs: { ref: string; sha: string }[];
  effects: number;
};
type Deployment = {
  uid: string;
  image: string;
  uri: string;
  stopProof?: { uid: string; stateSha: string; outcome: string };
  drainWitness?: DrainWitness;
  stoppedReconciliation?: {
    uid: string;
    generation: string | number;
    mode: string;
    proof: Reconciliation;
  };
};
type Contract = {
  schemaVersion: 1;
  directory: string;
  sources: Record<string, string>;
  deployment: Deployment;
};
type Stop = {
  command: string;
  disabled: boolean;
  manualZero: boolean;
  taggedRevisionsMayRemain: boolean;
  stopPersisted: boolean;
  drainProven: boolean;
  forced: boolean;
  priorDrainProof: boolean;
  outcome: string;
  stateBefore: string | null;
  stateAfter: string | null;
  idempotent?: boolean;
  drainWitness?: DrainWitness | null;
  stoppedReconciliation?: Reconciliation | null;
  writer?: {
    instance?: string;
    control?: { generation?: string };
    state: string;
    writerActive: boolean;
    writerPid: unknown;
    unprovenWriterPid?: unknown;
    uncertainOutcome: boolean;
    reconciliationRequired: boolean;
  } | null;
};
const code = import.meta.dir;
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function hashes(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      controlFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(directory, file)))
          .digest("hex"),
      ]),
    ),
  );
}
function identity(value: Deployment): Deployment {
  if (
    !value ||
    typeof value.uid !== "string" ||
    !value.uid ||
    typeof value.uri !== "string" ||
    !value.uri.startsWith("https://") ||
    typeof value.image !== "string" ||
    !/@sha256:[a-f0-9]{64}$/.test(value.image)
  )
    throw new Error("Exact deployed runtime receipt required");
  return { uid: value.uid, image: value.image, uri: value.uri };
}
export async function bindStop(admin: string, directory: string): Promise<void> {
  validatePlan(await json<Plan>(join(admin, "plan", "plan.json")));
  if (!isAbsolute(directory)) throw new Error("Absolute reviewed control directory required");
  const deployment = identity(await json<Deployment>(join(directory, "deployment-receipt.json")));
  const contract: Contract = {
    schemaVersion: 1,
    directory,
    sources: await hashes(directory),
    deployment,
  };
  await writeFile(join(admin, "stop-contract.json"), JSON.stringify(contract, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
export function verifyStop(result: Stop, receipt: Deployment, expected: Deployment): void {
  if (JSON.stringify(identity(receipt)) !== JSON.stringify(identity(expected)))
    throw new Error("Runtime receipt identity changed");
  const stableState =
    typeof result.stateBefore === "string" &&
    /^[a-f0-9]{40}$/.test(result.stateBefore) &&
    result.stateAfter === result.stateBefore;
  const drained =
    result.outcome === "drained-state-observed" &&
    result.drainProven === true &&
    result.writer?.state === "stopped" &&
    result.writer.writerActive === false &&
    result.writer.writerPid === null &&
    !result.writer.unprovenWriterPid &&
    result.writer.uncertainOutcome === false &&
    result.writer.reconciliationRequired === false;
  const prior = result.outcome === "verified-disabled" && result.priorDrainProof === true;
  const reconciled = verifyReconciliation(result, receipt, expected);
  const oldProof =
    (drained || prior) &&
    receipt.stopProof?.uid === expected.uid &&
    receipt.stopProof.stateSha === result.stateBefore &&
    receipt.stopProof.outcome === "drained-state-observed";
  if (
    result.command !== "stop" ||
    result.disabled !== true ||
    result.manualZero !== true ||
    result.taggedRevisionsMayRemain !== false ||
    result.stopPersisted !== true ||
    result.forced !== false ||
    !stableState ||
    (!oldProof && !reconciled)
  ) {
    throw new Error(
      "STOP is not proven drained/reconciled; keep protections and hold manual merges",
    );
  }
}
function verifyReconciliation(result: Stop, receipt: Deployment, expected: Deployment): boolean {
  if (result.outcome !== "reconciled-disabled") return false;
  const witness = result.drainWitness,
    saved = receipt.drainWitness;
  const proof = result.stoppedReconciliation,
    retained = receipt.stoppedReconciliation;
  const sha = (s: unknown) => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
  if (
    !witness ||
    !saved ||
    !proof ||
    !retained ||
    witness.uid !== expected.uid ||
    !["active", "ci-shadow", "read-only"].includes(witness.mode) ||
    !(typeof witness.generation === "string"
      ? /^[1-9][0-9]*$/.test(witness.generation)
      : Number.isSafeInteger(witness.generation) && witness.generation > 0) ||
    typeof witness.instance !== "string" ||
    !witness.instance ||
    typeof witness.controlGeneration !== "string" ||
    !/^stop-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      witness.controlGeneration,
    ) ||
    JSON.stringify(witness) !== JSON.stringify(saved) ||
    retained.uid !== expected.uid ||
    retained.generation !== witness.generation ||
    retained.mode !== witness.mode ||
    JSON.stringify(proof) !== JSON.stringify(retained.proof) ||
    proof.outcome !== "stable-state-observed" ||
    !sha(proof.stateSha) ||
    !sha(proof.mainSha) ||
    proof.stateSha !== result.stateBefore ||
    proof.stateSha !== result.stateAfter ||
    !Number.isSafeInteger(proof.effects) ||
    proof.effects < 0 ||
    proof.effects > 10000 ||
    !Array.isArray(proof.candidateRefs) ||
    proof.candidateRefs.length > 10000 ||
    result.priorDrainProof !== false ||
    (result.drainProven !== true && result.idempotent !== true)
  )
    return false;
  const prefix =
    witness.mode === "active" ? "refs/heads/queue/live/" : "refs/heads/queue/shadow-traffic/";
  const refs = new Set<string>();
  for (const candidate of proof.candidateRefs) {
    if (
      !candidate ||
      typeof candidate.ref !== "string" ||
      !candidate.ref.startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(candidate.ref.slice(prefix.length)) ||
      !sha(candidate.sha) ||
      refs.has(candidate.ref)
    )
      return false;
    refs.add(candidate.ref);
  }
  // A fresh witness still requires an observed exited writer. Effect flags may
  // remain true: the separate pinned read-only reconciliation proves settlement.
  if (result.writer)
    return (
      result.drainProven === true &&
      result.writer.state === "stopped" &&
      result.writer.instance === witness.instance &&
      result.writer.control?.generation === witness.controlGeneration &&
      result.writer.writerActive === false &&
      result.writer.writerPid === null &&
      !result.writer.unprovenWriterPid
    );
  return result.drainProven === false && result.idempotent === true;
}
async function command(args: string[], directory: string, name: string): Promise<string> {
  const journal = process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
  if (journal) await checkpoint(journal);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [status, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await writeFile(join(directory, `${name}.stdout`), out, { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, `${name}.stderr`), err, { flag: "wx", mode: 0o600 });
  if (journal) await checkpoint(journal);
  if (status !== 0)
    throw new Error(
      `${name} failed; retained receipts, STOP/hold remains, no automatic forward retry`,
    );
  return out;
}
export type DrainedReceipt = {
  runtime: Contract["deployment"];
  stop: Stop;
  operator: Deployment;
};
export type RestoreGate = (receipt: DrainedReceipt, action: string) => Promise<void>;
export async function off(
  adminPath: string,
  optIn: string,
  beforeRestore?: RestoreGate,
): Promise<string> {
  if (optIn !== "--apply-after-go")
    throw new Error("OFF requires separate operator go and --apply-after-go");
  const admin = resolve(adminPath),
    planDir = join(admin, "plan");
  const contract = await json<Contract>(join(admin, "stop-contract.json"));
  if (contract.schemaVersion !== 1 || !isAbsolute(contract.directory))
    throw new Error("Invalid STOP contract");
  if (JSON.stringify(await hashes(contract.directory)) !== JSON.stringify(contract.sources))
    throw new Error("Reviewed STOP source changed");
  if (
    JSON.stringify(
      identity(await json<Deployment>(join(contract.directory, "deployment-receipt.json"))),
    ) !== JSON.stringify(contract.deployment)
  )
    throw new Error("STOP target changed");
  // A local lock prevents two invocations using this plan; not a remote admin fence.
  const lock = join(planDir, "off-lock");
  await mkdir(lock);
  try {
    const attempt = await mkdtemp(join(admin, "off."));
    // STOP precedes GitHub reads and plan validation: a GitHub outage must not
    // prevent the already-bound runtime's durable stop operation.
    const result = JSON.parse(
      await command(
        [process.execPath, join(contract.directory, "control.ts"), "stop"],
        attempt,
        "stop",
      ),
    ) as Stop;
    const operatorReceipt = await json<Deployment>(
      join(contract.directory, "deployment-receipt.json"),
    );
    await writeFile(join(attempt, "operator-receipt.json"), JSON.stringify(operatorReceipt), {
      flag: "wx",
      mode: 0o600,
    });
    verifyStop(result, operatorReceipt, contract.deployment);
    const drained = { runtime: contract.deployment, stop: result, operator: operatorReceipt };
    const plan = await json<Plan>(join(planDir, "plan.json"));
    validatePlan(plan);
    let serial = 0;
    async function stage(action: string, arg?: string): Promise<string> {
      return command(
        ["bash", join(code, "stage.sh"), admin, action, ...(arg ? [arg] : [])],
        attempt,
        `${++serial}-${action}`,
      );
    }
    async function phase(): Promise<Phase> {
      const path = (await stage("snapshot")).trim();
      const snapshot = await json<Snapshot>(path);
      const receipts: { guard?: RuleSet; namespace?: RuleSet } = {};
      for (const kind of ["guard", "namespace"] as const) {
        if (await exists(join(planDir, `${kind}-receipt.json`)))
          receipts[kind] = await json(join(planDir, `${kind}-receipt.json`));
      }
      for (const candidate of ["restored", "guard", "namespace", "applied"] as const) {
        try {
          verify(plan, snapshot, candidate, receipts);
          return candidate;
        } catch {
          /* try next exact inventory */
        }
      }
      throw new Error("Unknown/drifted inventory; STOP retained, no restoration writes");
    }
    let current = await phase();
    if (current === "applied" && !(await exists(join(planDir, "admit-attempt", "verified"))))
      await stage("reconcile-admit");
    for (const [before, action] of [
      ["applied", "restore-admission"],
      ["namespace", "delete-namespace"],
      ["guard", "delete-guard"],
    ] as const) {
      if (current !== before) continue;
      const prior = await exists(join(planDir, `${action}-attempt`, "intent"));
      const reverse = prior ? `reissue-${action}` : action;
      // Watchdog callers must freshly reconcile their durable fence/effects
      // after drain, including every recovery/reissue. Never cache acceptance.
      if (beforeRestore) await beforeRestore(drained, reverse);
      await stage(reverse, "--apply-after-go");
      current = await phase();
    }
    if (current !== "restored") throw new Error("Restoration incomplete; hold manual merges");
    await stage("check-stable", "restored");
    // Also gate already-restored/reentrant completion: it is not permission to
    // turn an unresolved durable hold into a successful watchdog receipt.
    if (beforeRestore) await beforeRestore(drained, "verify-restored");
    await writeFile(
      join(attempt, "off-verified.json"),
      JSON.stringify(
        {
          mergeMode: "manual",
          runtime: contract.deployment,
          stop: result,
          restoredAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      `OFF verified; normal reviewed squash path restored. Receipt: ${attempt}/off-verified.json`,
    );
    if (process.env.BATCHER_ADMIN_JOURNAL_CONFIG)
      await checkpoint(process.env.BATCHER_ADMIN_JOURNAL_CONFIG);
    return join(attempt, "off-verified.json");
  } finally {
    await rmdir(lock);
  }
}
if (import.meta.main) {
  const [action, admin, argument] = process.argv.slice(2);
  if (action === "bind-stop" && admin && argument) await bindStop(admin, argument);
  else if (action === "run" && admin && argument) await off(admin, argument);
  else
    throw new Error(
      "Usage: off.ts bind-stop ADMIN_DIR REVIEWED_CONTROL_DIRECTORY | run ADMIN_DIR --apply-after-go",
    );
}
