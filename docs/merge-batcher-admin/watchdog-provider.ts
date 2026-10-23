/** Executable adapters. The core bridge is separately implemented/reviewed by the
 * runtime owner; no stub bridge or guessed health proof is provided here. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { off, verifyStop } from "./off";
import { type Archive, hydrate } from "./watchdog-journal";
import { ObjectStore, WatchdogCloud } from "./watchdog-cloud";
import { WatchdogGitHub, type AppBinding } from "./watchdog-github";
import type { Binding, Observation, Ports, Record as WatchRecord } from "./watchdog";

export type CoreBridge = {
  /** Validates complete runtime-health/v1 and stable double-read Git envelope,
   * plus configured deployment/config/activation and complete effect safety. */
  observe(): Promise<Observation>;
  /** SAME state.json CAS fence shared with operator OFF/START and child writes.
   * A conflicting/unknown result must not be converted to a successful fence. */
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
  /** Fresh current Git/effect reconciliation must bind the saved STOP proof to
   * this incident; an old same-image drain receipt is not sufficient. */
  verifyOffReceipt(incidentId: string, receipt: unknown): Promise<void>;
};
export type RuntimeConfig = {
  schema: 1;
  binding: Binding;
  jobResource: string;
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
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function appPath(path: string): boolean {
  return typeof path === "string" && path.startsWith("/app/") && resolve(path).startsWith("/app/");
}
async function loadBridge(
  config: RuntimeConfig,
  token: () => Promise<string>,
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
    ) => Promise<CoreBridge>;
  };
  if (!module.createWatchdogBridge)
    throw Error("Reviewed core bridge export missing; integration unqualified");
  return module.createWatchdogBridge(config, token);
}
export type ProviderDependencies = {
  loadBridge: typeof loadBridge;
  off: typeof off;
  transport?: typeof fetch;
};
async function run(args: string[], env: { [name: string]: string | undefined }): Promise<void> {
  const child = Bun.spawn(args, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw Error("Reviewed OFF readback failed; output suppressed");
}
export async function createProvider(
  config: RuntimeConfig,
  cloud = new WatchdogCloud(),
  dependencies: ProviderDependencies = { loadBridge, off },
): Promise<{ ports: Ports; close(): Promise<void> }> {
  if (
    config.schema !== 1 ||
    !/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/.test(config.jobResource) ||
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
  const core = await dependencies.loadBridge(config, () => stateWriter.token());
  let directory: string | null = null;
  const journalObject = `${key}/off-journal.json`;
  async function materialize(create: boolean): Promise<string> {
    if (directory) return directory;
    const latest = await store.read<Archive>(journalObject);
    let snapshot = latest;
    if (!snapshot) {
      if (!create)
        throw Error("Unfinished OFF has no durable journal; no reconstruction from seed");
      const seed = await store.read<Archive>(config.seedObject, config.seedGeneration);
      if (!seed) throw Error("Pinned original OFF archive unavailable");
      const generation = await store.cas(journalObject, null, seed.value);
      if (!generation) throw Error("OFF journal creation CAS lost; no provider write");
      snapshot = { generation, value: seed.value };
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
    directory = path;
    return path;
  }
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
      const fence = await core.claimStop(expected.revision, incidentId);
      if (
        !["claimed", "owned"].includes(fence.outcome) ||
        fence.incidentId !== incidentId ||
        fence.activation !== config.binding.activation ||
        !/^[a-f0-9]{40}$/.test(fence.stateSha)
      )
        throw Error("Core stop fence conflict/unknown; no OFF restore");
      await core.verifyClaim(incidentId, config.binding.activation);
      const admin = await materialize(true);
      const oldToken = process.env.GH_TOKEN,
        oldJournal = process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
      let bytes: Buffer;
      try {
        process.env.GH_TOKEN = await github.token();
        process.env.BATCHER_ADMIN_JOURNAL_CONFIG = join(admin, "journal-config.json");
        const receipt = await dependencies.off(admin, "--apply-after-go");
        bytes = await readFile(receipt);
      } finally {
        if (oldToken === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = oldToken;
        if (oldJournal === undefined) delete process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
        else process.env.BATCHER_ADMIN_JOURNAL_CONFIG = oldJournal;
      }
      await core.verifyOffReceipt(incidentId, JSON.parse(bytes.toString("utf8")));
      return digest(bytes);
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
