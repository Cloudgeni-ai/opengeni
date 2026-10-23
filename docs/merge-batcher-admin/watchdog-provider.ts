/** Executable adapters. The core bridge is separately implemented/reviewed by the
 * runtime owner; no stub bridge or guessed health proof is provided here. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { off, verifyStop, type DrainedReceipt } from "./off";
import { verify, type Plan, type RuleSet, type Snapshot } from "./bundle";
import { type Archive, hydrate } from "./watchdog-journal";
import { ObjectStore, WatchdogCloud } from "./watchdog-cloud";
import { WatchdogGitHub, type AppBinding } from "./watchdog-github";
import {
  PreEffectConflict,
  type Binding,
  type Observation,
  type Ports,
  type Record as WatchRecord,
} from "./watchdog";

export type CoreBridge = {
  /** Validates complete runtime-health/v1 and stable double-read Git envelope,
   * plus configured deployment/config/activation and complete effect safety. */
  observe(): Promise<Observation>;
  /** SAME state.json CAS fence shared with operator OFF/START and child writes.
   * conflict means definitive rejection with NO submitted fence/effect by this
   * invocation. Ambiguous submission is unknown; existing ownership is owned.
   * Neither conflict nor unknown may be converted to a successful fence. */
  claimStop(
    expectedStateSha: string,
    incidentId: string,
  ): Promise<{
    outcome: "claimed" | "owned" | "conflict" | "unknown";
    incidentId: string;
    activation: string;
    stateSha: string;
  }>;
  /** Authenticated live identity/control/claim check immediately before OFF. */
  verifyClaim(incidentId: string, activation: string): Promise<void>;
  /** Required BEFORE each reverse mutation (including reissue) and completion.
   * Verify fresh provider drain evidence and exact Git incident/activation,
   * current state and durable effects. Unknown/inflight holds must reject. */
  verifyBeforeRestore(incidentId: string, receipt: DrainedReceipt, action: string): Promise<void>;
  /** Fresh current Git/effect reconciliation must bind the saved STOP proof to
   * this incident; an old same-image drain receipt is not sufficient. */
  verifyOffReceipt(incidentId: string, receipt: unknown): Promise<void>;
};
export type RuntimeConfig = {
  schema: 1;
  binding: Binding;
  jobResource: string;
  serviceResource: string;
  watchdogImage: string;
  bucket: string;
  prefix: string;
  seedObject: string;
  seedGeneration: string;
  coreModule: string;
  coreModuleDigest: string;
  operatorDirectory: string;
  app: AppBinding;
  stateApp: AppBinding;
  incidentThread: number;
};
export type ProviderEvidence = {
  observedAt: number;
  serviceResource: string;
  /** Authenticated raw Cloud Run resource. Core must validate full identity/config. */
  service: unknown;
  policy: "applied" | "manual" | "drift";
  /** Exact saved-plan phase. Intermediate restoration is not arbitrary drift. */
  phase: "applied" | "namespace" | "guard" | "restored" | "drift";
  inventoryDigest: string;
};
export type ProviderEvidencePort = {
  read(): Promise<ProviderEvidence>;
  /** Real STOP proof and authenticated service read, without circular Manual
   * prerequisite. Core must validate returned service identity/config/scaling
   * and durable Git safety; this alone never authorizes restoration. */
  verifyDrained(receipt: unknown): Promise<ProviderEvidence>;
  /** Real reviewed STOP verifier plus fresh Manual inventory; core additionally
   * binds its Git incident/activation/effect reconciliation. */
  verifyStopped(receipt: unknown): Promise<ProviderEvidence>;
};
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function appPath(path: string): boolean {
  return typeof path === "string" && path.startsWith("/app/") && resolve(path).startsWith("/app/");
}
async function loadBridge(
  config: RuntimeConfig,
  token: () => Promise<string>,
  evidence: ProviderEvidencePort,
): Promise<CoreBridge> {
  if (
    !appPath(await realpath(config.coreModule)) ||
    !appPath(await realpath(config.operatorDirectory))
  )
    throw Error("Provider source escapes image application directory");
  if (digest(await readFile(config.coreModule)) !== config.coreModuleDigest)
    throw Error("Core bridge source digest changed");
  const module = (await import(config.coreModule)) as {
    createWatchdogBridge?: (
      config: RuntimeConfig,
      token: () => Promise<string>,
      evidence: ProviderEvidencePort,
    ) => Promise<CoreBridge>;
  };
  if (!module.createWatchdogBridge)
    throw Error("Reviewed core bridge export missing; integration unqualified");
  return module.createWatchdogBridge(config, token, evidence);
}
export type ProviderDependencies = {
  loadBridge: typeof loadBridge;
  off: typeof off;
  transport?: typeof fetch;
  run?: typeof run;
};
async function run(args: string[], env: { [name: string]: string | undefined }): Promise<string> {
  const child = Bun.spawn(args, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw Error("Reviewed OFF readback failed; output suppressed");
  return output;
}
export async function createProvider(
  config: RuntimeConfig,
  cloud = new WatchdogCloud(),
  dependencies: ProviderDependencies = { loadBridge, off },
): Promise<{ ports: Ports; close(): Promise<void> }> {
  if (
    config.schema !== 1 ||
    !/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/.test(config.jobResource) ||
    !/^projects\/[^/]+\/locations\/[^/]+\/services\/[^/]+$/.test(config.serviceResource) ||
    !appPath(config.coreModule) ||
    !appPath(config.operatorDirectory) ||
    config.watchdogImage !== config.binding.image ||
    !/^[a-f0-9]{64}$/.test(config.coreModuleDigest) ||
    !Number.isSafeInteger(config.incidentThread) ||
    config.incidentThread <= 0
  )
    throw Error("Complete reviewed provider binding and incident destination required");
  const github = new WatchdogGitHub(cloud, config.app, dependencies.transport ?? fetch);
  const stateWriter = new WatchdogGitHub(
    cloud,
    config.stateApp,
    dependencies.transport ?? fetch,
    "state-fence",
  );
  const store = new ObjectStore(cloud, config.bucket);
  const key = `${config.prefix}/${digest(JSON.stringify(config.binding))}`;
  // The module receives only a token callback for its reviewed state-only CAS.
  let directory: string | null = null;
  const journalObject = `${key}/off-journal.json`;
  async function materialize(create: boolean, readOnly = false): Promise<string> {
    if (directory && !readOnly) return directory;
    const latest = await store.read<Archive>(journalObject);
    let snapshot = latest;
    if (!snapshot) {
      if (!create && !readOnly)
        throw Error("Unfinished OFF has no durable journal; no reconstruction from seed");
      const seed = await store.read<Archive>(config.seedObject, config.seedGeneration);
      if (!seed) throw Error("Pinned original OFF archive unavailable");
      if (readOnly) snapshot = seed;
      else {
        const generation = await store.cas(journalObject, null, seed.value);
        if (!generation) throw Error("OFF journal creation CAS lost; no provider write");
        snapshot = { generation, value: seed.value };
      }
    }
    const path = await mkdtemp(join(tmpdir(), "batcher-watchdog-"));
    await hydrate(path, snapshot.value);
    const planBytes = await readFile(join(path, "plan/plan.json"));
    if (digest(planBytes) !== config.binding.planDigest) throw Error("Saved plan digest changed");
    const contract = JSON.parse(await readFile(join(path, "stop-contract.json"), "utf8"));
    if (
      contract.directory !== config.operatorDirectory ||
      contract.deployment.uid !== config.binding.deploymentUid ||
      contract.deployment.image !== config.binding.image
    )
      throw Error("OFF target/binding mismatch");
    await writeFile(
      join(path, "journal-config.json"),
      JSON.stringify({
        bucket: config.bucket,
        object: journalObject,
        generation: snapshot.generation,
        directory: path,
      }),
      { mode: 0o600, flag: "wx" },
    );
    if (!readOnly) directory = path;
    return path;
  }
  async function readEvidence(): Promise<ProviderEvidence> {
    const service = await cloud.json<unknown>(
      `https://run.googleapis.com/v2/${config.serviceResource}`,
    );
    const admin = await materialize(false, true);
    const snapshotPath = (
      await (dependencies.run ?? run)(
        ["bash", join(import.meta.dir, "stage.sh"), admin, "snapshot"],
        { GH_TOKEN: await github.token() },
      )
    ).trim();
    if (!resolve(snapshotPath).startsWith(`${admin}/`)) throw Error("Rules snapshot path mismatch");
    const bytes = await readFile(snapshotPath);
    const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
    const plan = JSON.parse(await readFile(join(admin, "plan/plan.json"), "utf8")) as Plan;
    let policy: ProviderEvidence["policy"] = "drift";
    let phase: ProviderEvidence["phase"] = "drift";
    try {
      verify(plan, snapshot, "restored");
      policy = "manual";
      phase = "restored";
    } catch {
      try {
        const guard = JSON.parse(
          await readFile(join(admin, "plan/guard-receipt.json"), "utf8"),
        ) as RuleSet;
        const namespace = await readFile(join(admin, "plan/namespace-receipt.json"), "utf8")
          .then((receiptBytes) => JSON.parse(receiptBytes) as RuleSet)
          .catch(() => undefined);
        for (const candidate of ["applied", "namespace", "guard"] as const) {
          try {
            verify(plan, snapshot, candidate, { guard, ...(namespace ? { namespace } : {}) });
            phase = candidate;
            if (candidate === "applied") policy = "applied";
            break;
          } catch {
            /* Only exact verified phases qualify. */
          }
        }
      } catch {
        /* Complete authenticated mismatch is drift, never Manual. */
      }
    }
    return {
      observedAt: Date.now(),
      serviceResource: config.serviceResource,
      service,
      policy,
      phase,
      inventoryDigest: digest(bytes),
    };
  }
  const evidence: ProviderEvidencePort = {
    read: readEvidence,
    verifyDrained: async (receipt) => {
      const admin = await materialize(false);
      const contract = JSON.parse(await readFile(join(admin, "stop-contract.json"), "utf8"));
      const operator = JSON.parse(
        await readFile(join(config.operatorDirectory, "deployment-receipt.json"), "utf8"),
      );
      const result = receipt as { stop?: Parameters<typeof verifyStop>[0] };
      if (!result?.stop) throw Error("Real STOP receipt required");
      verifyStop(result.stop, operator, contract.deployment);
      return readEvidence();
    },
    verifyStopped: async (receipt) => {
      const current = await evidence.verifyDrained(receipt);
      if (current.policy !== "manual") throw Error("Original Manual inventory not proven");
      return current;
    },
  };
  const core = await dependencies.loadBridge(config, () => stateWriter.token(), evidence);
  for (const method of [
    "observe",
    "claimStop",
    "verifyClaim",
    "verifyBeforeRestore",
    "verifyOffReceipt",
  ] as const)
    if (typeof core?.[method] !== "function")
      throw Error("Core verifier missing; integration unqualified");
  async function execution(runId: string): Promise<"running" | "terminal" | "unknown"> {
    if (
      !runId.startsWith(`${config.jobResource}/executions/`) ||
      runId.slice(`${config.jobResource}/executions/`.length).includes("/")
    )
      return "unknown";
    try {
      const value = await cloud.json<{
        name?: string;
        job?: string;
        completionTime?: string;
        reconciling?: boolean;
        template?: { containers?: { image?: string }[] };
      }>(`https://run.googleapis.com/v2/${runId}`);
      if (
        value.name !== runId ||
        value.job !== config.jobResource ||
        value.template?.containers?.[0]?.image !== config.watchdogImage
      )
        return "unknown";
      return value.completionTime && !value.reconciling ? "terminal" : "running";
    } catch {
      return "unknown";
    }
  }
  const ports: Ports = {
    now: Date.now,
    read: () => core.observe(),
    load: async () => {
      const value = await store.read<WatchRecord>(`${key}/record.json`);
      return value ? { version: value.generation, value: value.value } : null;
    },
    cas: (version, value) => store.cas(`${key}/record.json`, version, value),
    heartbeat: async (event) => {
      console.log(JSON.stringify({ event: "batcher_watchdog_progress", ...event }));
    },
    execution,
    off: async (expected, incidentId) => {
      const fence = await core.claimStop(expected.revision, incidentId).catch(() => {
        throw Error("Core claim outcome unknown; reconciliation required");
      });
      if (
        fence.outcome === "conflict" &&
        fence.incidentId === incidentId &&
        fence.activation === config.binding.activation &&
        /^[a-f0-9]{40}$/.test(fence.stateSha)
      )
        throw new PreEffectConflict("Definitive rejected state CAS; no OFF effects");
      if (
        !["claimed", "owned"].includes(fence.outcome) ||
        fence.incidentId !== incidentId ||
        fence.activation !== config.binding.activation ||
        !/^[a-f0-9]{40}$/.test(fence.stateSha)
      )
        throw Error("Core stop fence conflict/unknown; no OFF restore");
      try {
        await core.verifyClaim(incidentId, config.binding.activation);
        const admin = await materialize(true);
        const oldToken = process.env.GH_TOKEN,
          oldJournal = process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
        let bytes: Buffer;
        try {
          process.env.GH_TOKEN = await github.token();
          process.env.BATCHER_ADMIN_JOURNAL_CONFIG = join(admin, "journal-config.json");
          const receipt = await dependencies.off(
            admin,
            "--apply-after-go",
            async (drained, action) => {
              // The core callback uses only its state credential, never the ambient
              // rules-administration token used by the real OFF subprocesses.
              const adminToken = process.env.GH_TOKEN;
              const adminJournal = process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
              if (oldToken === undefined) delete process.env.GH_TOKEN;
              else process.env.GH_TOKEN = oldToken;
              if (oldJournal === undefined) delete process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
              else process.env.BATCHER_ADMIN_JOURNAL_CONFIG = oldJournal;
              try {
                await core.verifyBeforeRestore(incidentId, drained, action);
              } finally {
                process.env.GH_TOKEN = adminToken;
                process.env.BATCHER_ADMIN_JOURNAL_CONFIG = adminJournal;
              }
            },
          );
          bytes = await readFile(receipt);
        } finally {
          if (oldToken === undefined) delete process.env.GH_TOKEN;
          else process.env.GH_TOKEN = oldToken;
          if (oldJournal === undefined) delete process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
          else process.env.BATCHER_ADMIN_JOURNAL_CONFIG = oldJournal;
        }
        await core.verifyOffReceipt(incidentId, JSON.parse(bytes.toString("utf8")));
        return digest(bytes);
      } catch (error) {
        // No callback after a successful/owned fence may masquerade as a
        // rejected pre-effect CAS and cause the durable intent to be released.
        if (error instanceof PreEffectConflict)
          throw Error("Post-claim outcome requires reconciliation", { cause: error });
        throw error;
      }
    },
    reconcile: async (_binding, incidentId) => {
      try {
        await core.verifyClaim(incidentId, config.binding.activation);
        const admin = await materialize(false);
        const contract = JSON.parse(await readFile(join(admin, "stop-contract.json"), "utf8"));
        for (const item of await readdir(admin, { withFileTypes: true })) {
          if (!item.isDirectory() || !item.name.startsWith("off.")) continue;
          try {
            const bytes = await readFile(join(admin, item.name, "off-verified.json"));
            const receipt = JSON.parse(bytes.toString("utf8"));
            const operator = JSON.parse(
              await readFile(join(admin, item.name, "operator-receipt.json"), "utf8"),
            );
            verifyStop(receipt.stop, operator, contract.deployment);
            await core.verifyOffReceipt(incidentId, receipt);
            await run(
              ["bash", join(import.meta.dir, "stage.sh"), admin, "check-stable", "restored"],
              { GH_TOKEN: await github.token() },
            );
            return digest(bytes);
          } catch {
            /* No complete receipt is not permission to repeat OFF. */
          }
        }
        return null;
      } catch {
        // Missing journals and unproven claims are sticky holds, not replay or
        // reconstruction from a seed. Let tick persist held and notify once.
        return null;
      }
    },
    notify: (id, reason, receipt, mode) =>
      github.notify(config.incidentThread, id, reason, receipt, mode),
    alert: async (reason, incidentKey) => {
      console.error(
        JSON.stringify({
          event: "batcher_watchdog_alert",
          reason,
          incidentKey: incidentKey ?? null,
        }),
      );
    },
  };
  // Cloud Run owns ephemeral directory cleanup; durable objects are never deleted.
  return { ports, close: async () => {} };
}
