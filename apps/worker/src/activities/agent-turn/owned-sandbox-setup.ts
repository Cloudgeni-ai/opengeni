import {
  runOwnedSandboxSetup,
  withRunCredentialsSession,
  type GitCredentialTokenWriterSession,
  type PreparedAgentInput,
  type RunCredentialCommandSession,
} from "@opengeni/runtime";
import {
  recordSandboxSharedPreparation,
  recordTurnStartupPhase,
} from "../../observability-metrics";
import { createSharedRigSetupCoordinator } from "./sandbox-shared-preparation";
import type { TurnStreamAttemptDeps } from "./stream-attempt";
import { ownedTurnSandboxForAgent } from "./turn-sandbox-access";
import { sandboxStartupPhaseObserver } from "./sandbox-startup-phase";

export type EagerOwnedSandboxSetupDeps = Pick<
  TurnStreamAttemptDeps,
  | "input"
  | "db"
  | "observability"
  | "runtimeCancellationSignal"
  | "sandboxState"
  | "eventing"
  | "leases"
  | "runWorkspaceMutationForSandbox"
  | "attachGitCredentialRenewal"
  | "attachRunCredentialRenewal"
  | "activeSandboxBackend"
  | "groupBoxBackend"
  | "turnExecutionPolicy"
  | "agent"
  | "runSettings"
  | "initialRunCredentialMaterial"
  | "initialGitCredentials"
  | "sandboxEnvironment"
  | "fileResourceDownloads"
>;

export type EagerOwnedSandboxSetupOptions = {
  /** The worker delivers this turn's file resources itself. */
  fileDownloadsMaterialized: boolean;
  /** Receives the runtime's file-failure note when the runtime delivers files. */
  preparedInput?: PreparedAgentInput;
};

/**
 * Whether this turn's platform setup runs eagerly against an owned box the
 * worker already holds. Lazy boxes run the same setup in their first-operation
 * provisioner, and connected machines receive no platform setup.
 */
export function hasEagerOwnedSandboxSetup(
  sandboxState: EagerOwnedSandboxSetupDeps["sandboxState"],
): boolean {
  return Boolean(
    sandboxState.resolvedSandbox &&
    !sandboxState.lazyOwnedSandbox &&
    ownedTurnSandboxForAgent(sandboxState),
  );
}

/**
 * Run the turn's platform setup (rig setup, credential hooks, repository
 * clones) against the eager owned box. The setup settles its workspace
 * admission before returning, so no admission stays open into the model stream.
 */
export async function runEagerOwnedSandboxSetup(
  deps: EagerOwnedSandboxSetupDeps,
  options: EagerOwnedSandboxSetupOptions,
): Promise<void> {
  const { input, sandboxState, eventing, leases, observability } = deps;
  const eagerResolvedSandbox = sandboxState.resolvedSandbox;
  const ownedEstablished = ownedTurnSandboxForAgent(sandboxState);
  if (!eagerResolvedSandbox || sandboxState.lazyOwnedSandbox || !ownedEstablished) return;
  const measure = sandboxStartupPhaseObserver({
    observability,
    provider: deps.turnExecutionPolicy.providerId,
    backend: deps.activeSandboxBackend ?? deps.groupBoxBackend,
    publish: eventing.publish,
  });
  const ownedSandboxSetupStartedAt = performance.now();
  let ownedSandboxSetupOutcome: "completed" | "failed" = "completed";
  try {
    const eagerSetupSession = sandboxState.setupBoxSession ?? ownedEstablished.session;
    // The worker owns platform setup for owned boxes, so the runtime skips its
    // credential session callback. Materialize host-managed run credentials
    // before any setup command (including provider login hooks), then decorate
    // setup commands so they source the active generation.
    await measure("credential_materialization", () =>
      deps.attachRunCredentialRenewal(
        eagerSetupSession as RunCredentialCommandSession,
        deps.initialRunCredentialMaterial,
        eagerResolvedSandbox,
      ),
    );
    const eagerCredentialSetupSession = deps.initialRunCredentialMaterial
      ? withRunCredentialsSession(eagerSetupSession as object, input.sessionId)
      : eagerSetupSession;
    await deps.runWorkspaceMutationForSandbox(
      eagerResolvedSandbox,
      "eagerOwnedSandboxSetup",
      async () =>
        await runOwnedSandboxSetup(
          deps.agent,
          ownedEstablished.session as never,
          eagerCredentialSetupSession as never,
          {
            settings: deps.runSettings,
            environment: deps.sandboxEnvironment,
            measureSetup: measure,
            ...(options.preparedInput ? { preparedInput: options.preparedInput } : {}),
            ...(options.fileDownloadsMaterialized ? { fileDownloadsMaterialized: true } : {}),
            onRuntimeEvent: async (event) => {
              await leases.renewServing("runtime_event");
              if (leases.servingLost()) {
                throw new Error("Provider credential lease expired during sandbox setup");
              }
              await eventing.publish([{ type: event.type, payload: event.payload }], true);
            },
            ...(eventing.toolCancellationFenceRef.current
              ? {
                  commandRunner: eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                    eventing.toolCancellationFenceRef.current,
                  ),
                }
              : {}),
            ...(sandboxState.sandboxGroupId && sandboxState.sandboxHolderId
              ? {
                  coordinateSharedRigSetup: createSharedRigSetupCoordinator({
                    db: deps.db,
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sandboxGroupId: sandboxState.sandboxGroupId,
                    attemptId: input.attemptId,
                    holderId: sandboxState.sandboxHolderId,
                    sandbox: eagerResolvedSandbox,
                    ...(deps.runtimeCancellationSignal
                      ? { signal: deps.runtimeCancellationSignal }
                      : {}),
                    observe: (measurement) =>
                      recordSandboxSharedPreparation(observability, measurement),
                  }),
                }
              : {}),
          },
        ),
    );
    await deps.attachGitCredentialRenewal(
      eagerSetupSession as GitCredentialTokenWriterSession,
      deps.initialGitCredentials,
    );
  } catch (error) {
    ownedSandboxSetupOutcome = "failed";
    throw error;
  } finally {
    await measure.flush();
    recordTurnStartupPhase(observability, {
      phase: "owned_sandbox_setup",
      provider: deps.turnExecutionPolicy.providerId,
      backend: deps.activeSandboxBackend ?? deps.groupBoxBackend,
      outcome: ownedSandboxSetupOutcome,
      durationSeconds: (performance.now() - ownedSandboxSetupStartedAt) / 1_000,
      count: deps.fileResourceDownloads.length,
    });
  }
}

/**
 * The eager platform setup for each model stream of one turn attempt.
 *
 * The first stream's setup may already be running: it needs nothing from the
 * model input, so the worker starts it with file delivery and input
 * preparation instead of after them. Each later stream of the attempt runs the
 * idempotent setup again, as before.
 */
export type EagerOwnedSandboxSetup = {
  /** Run, or join the already started, setup for the next model stream. */
  beforeModelStream(options: EagerOwnedSandboxSetupOptions): Promise<void>;
  /** Resolves once a started setup has finished, whatever its outcome. */
  settled(): Promise<void>;
};

export function createEagerOwnedSandboxSetup(
  deps: EagerOwnedSandboxSetupDeps,
  start?: { fileDownloadsMaterialized: boolean },
  runSetup: typeof runEagerOwnedSandboxSetup = runEagerOwnedSandboxSetup,
): EagerOwnedSandboxSetup {
  const startedFor = start ? sandboxIdentity(deps.sandboxState) : null;
  let started: Promise<void> | null = start
    ? runSetup(deps, {
        fileDownloadsMaterialized: start.fileDownloadsMaterialized,
      })
    : null;
  // Observing the outcome here keeps an early failure from being unhandled;
  // the first model stream still awaits the original promise and rethrows it.
  const settled = started ? started.then(noop, noop) : Promise.resolve();
  return {
    beforeModelStream: async (options) => {
      if (started) {
        const prestarted = started;
        started = null;
        await prestarted;
        // A box rebound while the setup ran (rotation, recovery) gets its
        // own setup; the prestarted one only covered the earlier box.
        if (sandboxIdentity(deps.sandboxState) === startedFor) return;
      }
      await runSetup(deps, options);
    },
    settled: () => settled,
  };
}

function sandboxIdentity(sandboxState: EagerOwnedSandboxSetupDeps["sandboxState"]): string | null {
  const resolved = sandboxState.resolvedSandbox;
  return resolved ? `${resolved.leaseEpoch}:${resolved.established.instanceId}` : null;
}

function noop(): void {}
