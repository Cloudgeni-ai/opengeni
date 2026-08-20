import {
  getSandbox,
  readActiveSandbox,
  getLiveEnrollmentConnection,
  assertPersonalMachineForAttempt,
  type SandboxRecord,
} from "@opengeni/db";
import { sandboxOperationMetricObserver } from "@opengeni/observability";
import {
  withRunCredentialsSession,
  runOwnedSandboxSetup,
  markModelPreparationFirstSandboxOperation,
  recordModelPreparationMeasurement,
  sdkBackendIdForSandboxBackend,
  type EstablishedSandboxSession,
  type GitCredentialTokenWriterSession,
  type NormalizedRunCredentialMaterial,
  type RunCredentialCommandSession,
  type CodemodeTokenWriterSession,
  type SelfhostedSession,
} from "@opengeni/runtime";
import { type Settings } from "@opengeni/config";
import { mergeResourceRefs } from "../common";
import {
  mintSandboxCodemodeToken,
  type MintedRunGitCredentials,
  type SandboxCodemodeAuthority,
} from "../environment";
import { rigProviderImageSourceImage } from "../packs";
import type { TurnActivityServices as ActivityServices, RunAgentTurnInput } from "../types";
import type { currentActivityContext } from "../streaming";
import { resumeBoxForTurn, type ResumedTurnSandbox } from "../../sandbox-resume";
import {
  wrapTurnBoxWithRouting,
  wrapLazyTurnBoxWithRouting,
  establishSelfhostedTurnSession,
  routingEnabled,
} from "../../sandbox-routing";
import {
  makeMachineOpObserver,
  recordSandboxLogicalProvision,
  recordSandboxProvisionAttempt,
  recordTurnStartupPhase,
  runtimeMetricsHooksForObservability,
} from "../../observability-metrics";
import { ToolResultSpill } from "./tool-result-spill";
import type { createTurnMediaArtifacts } from "./media-artifacts";

import {
  throwIfTurnOperationCancelled,
  waitForTurnOperation,
  classifySandboxLogicalProvisionFailure,
  isLazySandboxProvisionRetryable,
  createTurnSandboxProvisioner,
} from "./sandbox-provision";
import {
  resolveActiveSandboxBackend,
  managedSandboxOwnershipForTurn,
  shouldEstablishSandboxForTurn,
  sandboxEstablishPolicyDecision,
  shouldPrefetchManagedSandbox,
  reconcileActiveSandboxPointer,
} from "./sandbox-route";
import type { ClaimTurnOk } from "./claim";
import type { GovernanceModelOk } from "./governance-model";
import type { SandboxTurnRuntime } from "./sandbox-runtime";
import type { AttemptIdentityState, EventingState, SandboxRuntimeState } from "./turn-context";

export type SandboxRouteDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  eventing: EventingState;
  sandboxState: SandboxRuntimeState;
  media: ReturnType<typeof createTurnMediaArtifacts>;
  fileAuthoritySubjectId: ClaimTurnOk["fileAuthoritySubjectId"];
  runSettings: GovernanceModelOk["runSettings"];
};

export type SandboxRouteOk = {
  routingOn: boolean;
  activeSandboxPointer: Awaited<ReturnType<typeof readActiveSandbox>>;
  activeSandboxRecord: SandboxRecord | null;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
  machinePrimary: boolean;
  groupBoxBackend: Settings["sandboxBackend"];
  groupBoxImage: ReturnType<typeof rigProviderImageSourceImage>;
  sandboxCreationBackend: Settings["sandboxBackend"];
  effectiveRunCredentialBackend: Settings["sandboxBackend"];
};

export type EstablishTurnSandboxDeps = SandboxRouteOk & {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  objectStorage: ActivityServices["objectStorage"];
  observability: ActivityServices["observability"];
  cancellationSignal: AbortSignal | undefined;
  runtimeCancellationSignal: AbortSignal | undefined;
  sandboxResumeSignal: AbortSignal;
  activityContext: ReturnType<typeof currentActivityContext>;
  opJournal: ClaimTurnOk["opJournal"];
  sandboxState: SandboxRuntimeState;
  eventing: EventingState;
  attempt: AttemptIdentityState;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  fileAuthoritySubjectId: ClaimTurnOk["fileAuthoritySubjectId"];
  capabilitySettings: ClaimTurnOk["capabilitySettings"];
  turnExecutionPolicy: ClaimTurnOk["turnExecutionPolicy"];
  runSettings: GovernanceModelOk["runSettings"];
  logicalSandboxSettings: GovernanceModelOk["logicalSandboxSettings"];
  verifiedRigProviderImageId: GovernanceModelOk["verifiedRigProviderImageId"];
  runtimePreparationStartedAt: number;
  establishPolicy: ReturnType<typeof sandboxEstablishPolicyDecision>["policy"];
  sandboxEnvironment: Record<string, string>;
  startRunGitCredentialsMint: () => Promise<MintedRunGitCredentials | undefined>;
  machineOpObserver: ReturnType<typeof makeMachineOpObserver>;
  sandboxOperationObserver: ReturnType<typeof sandboxOperationMetricObserver>;
  sandboxRuntime: SandboxTurnRuntime;
  transientCodemodeEnvironment: (() => Readonly<Record<string, string>>) | undefined;
  rigVersion: GovernanceModelOk["rigVersion"];
  turnResources: ReturnType<typeof mergeResourceRefs>;
};

export type BindLazySandboxProvisionerDeps = EstablishTurnSandboxDeps & {
  agent: ReturnType<ActivityServices["runtime"]["buildAgent"]>;
  attachRunCredentialRenewal: (
    credentialSession: RunCredentialCommandSession,
    initialMaterial: NormalizedRunCredentialMaterial | null,
    initialSandbox?: ResumedTurnSandbox,
  ) => Promise<void>;
  attachGitCredentialRenewal: (
    tokenSession: GitCredentialTokenWriterSession,
    initial: MintedRunGitCredentials | undefined,
    initialSandbox?: ResumedTurnSandbox,
  ) => Promise<void>;
  attachCodemodeTokenRenewal: (
    tokenSession?: CodemodeTokenWriterSession,
    initialExpiresAt?: Date,
    initialSandbox?: ResumedTurnSandbox,
  ) => Promise<void>;
  throwIfWorkerShuttingDown: () => void;
  throwIfTurnCancelled: () => void;
  initialRunCredentialMaterial: NormalizedRunCredentialMaterial | null;
  sandboxCodemodeToken: string | undefined;
  media: ReturnType<typeof createTurnMediaArtifacts>;
  toolResultSpill: ToolResultSpill;
  connectionScope: { accountId: string; workspaceId: string };
  codemodeAuthority: SandboxCodemodeAuthority;
};

export async function resolveSandboxRoute(deps: SandboxRouteDeps): Promise<SandboxRouteOk> {
  const {
    input,
    settings,
    db,
    eventing,
    media,
    sandboxState,
    fileAuthoritySubjectId,
    runSettings,
  } = deps;

  // EFFECTIVE compute backend, resolved ONCE at turn start (Case B + Stage D
  // D1-lite) and reused for EVERY downstream decision: the env mint (skip
  // inert platform git tokens for a machine turn), the establish path (no phantom Modal
  // home box for a machine-primary turn), buildAgent (skip the repository clone
  // hook so a private repo is never `git clone`d onto the user's real disk), and
  // the warm-rate (a machine accrues ZERO cloud warm-seconds). The active pointer
  // + its sandbox row are loaded ONCE here (best-effort, never throwing) and the
  // SAME values feed resolveActiveSandboxBackend (the tested gate) AND the
  // machine-primary establish branch (enrollmentId/epoch/workingDir) below — no
  // double read, no read-skew between the gate decision and the establish. With
  // routing OFF this is byte-for-byte the legacy path: no reads, undefined backend.
  const routingOn = routingEnabled(settings);
  let activeSandboxPointer = routingOn
    ? await readActiveSandbox(db, input.workspaceId, input.sessionId).catch(() => null)
    : null;
  // TURN-START RECONCILE (issue #341 invariant B / Shapes 1+2): a persisted
  // pointer whose target is STRUCTURALLY unestablishable at turn start would strand
  // EVERY op of this turn — reset it to the session HOME under the epoch fence +
  // emit a visible event, honoring a concurrent higher-epoch swap. The sandbox row
  // is loaded HERE, inside reconcile, via a NON-swallowing lookup: a null decision
  // then means the row is genuinely absent, never a suppressed transient DB error
  // (which would wrongly clear a healthy user-chosen pointer). On a lookup throw the
  // reconcile fails open — pointer untouched, record null (machinePrimary:false),
  // no event — and the establish branch below reads the returned values.
  let activeSandboxRecord: SandboxRecord | null = null;
  if (routingOn) {
    const reconciled = await reconcileActiveSandboxPointer(
      db,
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      },
      activeSandboxPointer,
      (sandboxId) =>
        getSandbox(
          db,
          fileAuthoritySubjectId
            ? {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                subjectId: fileAuthoritySubjectId,
              }
            : input.workspaceId,
          sandboxId,
        ),
      eventing.publish
        ? async (events) => {
            await eventing.publish!(events);
          }
        : undefined,
    );
    activeSandboxPointer = reconciled.pointer;
    activeSandboxRecord = reconciled.record;
  }
  const activeSandboxBackend = await resolveActiveSandboxBackend(
    routingOn,
    async () => activeSandboxPointer,
    async () => activeSandboxRecord?.kind ?? null,
  );
  // A machine-primary turn = the effective backend is selfhosted AND we have the
  // machine's enrollment (agent id) + a non-null pointer to bind it. Anything
  // missing (should not happen — the DB enforces selfhosted⇒enrollmentId) falls
  // back to the cloud establish path (a correct, if phantom, box) rather than
  // crashing the turn.
  const machinePrimary =
    activeSandboxBackend === "selfhosted" &&
    Boolean(activeSandboxPointer?.activeSandboxId) &&
    Boolean(activeSandboxRecord?.enrollmentId);
  // `none` describes the durable home, not an explicit per-turn route. Give
  // the runtime the effective backend so it builds a SandboxAgent for the
  // attached Connected Machine without mutating the session or turn record.
  if (machinePrimary && eventing.modelRunSettings.sandboxBackend === "none") {
    eventing.modelRunSettings = {
      ...eventing.modelRunSettings,
      sandboxBackend: "selfhosted",
    };
  }
  // The backend that can actually create a sandbox for this turn. In the
  // common path this is runSettings.sandboxBackend. A selfhosted home turn
  // that is NOT machine-primary falls back to the deployment cloud backend
  // so swap-away / flag-off degrade to a real group box.
  const groupBoxBackend: Settings["sandboxBackend"] =
    runSettings.sandboxBackend === "selfhosted" && !machinePrimary
      ? settings.sandboxBackend
      : runSettings.sandboxBackend;
  sandboxState.startupMilestoneBackend = activeSandboxBackend ?? groupBoxBackend;
  media.sandboxFileDownloadBackend = sandboxState.startupMilestoneBackend;
  const groupBoxImage = rigProviderImageSourceImage(runSettings, groupBoxBackend);
  const sandboxCreationBackend: Settings["sandboxBackend"] =
    settings.sandboxOwnershipEnabled && runSettings.sandboxBackend !== "none"
      ? groupBoxBackend
      : runSettings.sandboxBackend;
  const effectiveRunCredentialBackend = activeSandboxBackend ?? groupBoxBackend;

  return {
    routingOn,
    activeSandboxPointer,
    activeSandboxRecord,
    activeSandboxBackend,
    machinePrimary,
    groupBoxBackend,
    groupBoxImage,
    sandboxCreationBackend,
    effectiveRunCredentialBackend,
  };
}

export async function establishTurnSandbox(deps: EstablishTurnSandboxDeps): Promise<void> {
  const {
    input,
    settings,
    db,
    bus,
    observability,
    runtimeCancellationSignal,
    sandboxResumeSignal,
    opJournal,
    sandboxState,
    eventing,
    attempt,
    turn,
    session,
    fileAuthoritySubjectId,
    turnExecutionPolicy,
    runSettings,
    logicalSandboxSettings,
    runtimePreparationStartedAt,
    establishPolicy,
    sandboxEnvironment,
    startRunGitCredentialsMint,
    machineOpObserver,
    sandboxOperationObserver,
    sandboxRuntime,
    transientCodemodeEnvironment,
    activeSandboxPointer,
    activeSandboxRecord,
    activeSandboxBackend,
    machinePrimary,
    groupBoxBackend,
    groupBoxImage,
    rigVersion,
    turnResources,
  } = deps;
  const {
    releaseLateSandbox,
    onHomeSandboxRebound,
    publishSandboxLifecycleEvents,
    publishSandboxLost,
    startLeaseHeartbeat,
  } = sandboxRuntime;

  // P1.2 ownership inversion (gated, default OFF). With the flag off this
  // block is skipped entirely: resolvedSandbox stays null and runStream
  // takes the legacy per-run build-and-discard path — byte-for-byte today.
  // With it on, acquire the group lease (holder = the durable attempt id),
  // resume the one box by id, and inject it NON-OWNED into the run. The box
  // backend is "none" -> never resolve (no box to touch).
  //
  // Established AFTER sandboxEnvironment is computed (not before) so the box's
  // manifest is created with the SAME variableSet the agent declares — the SDK
  // applies the agent's manifest to this provided session and throws on ANY
  // variableSet delta (validateNoEnvironmentDelta). Passing sandboxEnvironment
  // here makes current==target so the delta is empty.
  recordTurnStartupPhase(observability, {
    phase: "runtime_preparation",
    provider: turnExecutionPolicy.providerId,
    backend: activeSandboxBackend ?? groupBoxBackend,
    outcome: "completed",
    durationSeconds: (performance.now() - runtimePreparationStartedAt) / 1_000,
  });
  if (
    shouldEstablishSandboxForTurn(
      settings.sandboxOwnershipEnabled,
      turn.sandboxBackend,
      machinePrimary,
    )
  ) {
    const sandboxEstablishStartedAt = performance.now();
    let sandboxEstablishOutcome: "completed" | "failed" = "completed";
    try {
      const managedOwnership = managedSandboxOwnershipForTurn(
        machinePrimary,
        input.attemptId,
        session.sandboxGroupId,
      );
      sandboxState.sandboxHolderId = managedOwnership?.holderId ?? null;
      sandboxState.sandboxGroupId = managedOwnership?.sandboxGroupId ?? null;
      // STAGE D honest-label guard: a machine-home session carries
      // turn.sandboxBackend "selfhosted", but a turn is only machine-PRIMARY
      // when a live machine pointer resolves (activeSandboxBackend==='selfhosted'
      // + enrollmentId). When it is NOT primary — the agent swapped back to the
      // group box (sandbox_swap 'session'/'default'/groupId clears the pointer) or
      // selfhosted routing is flag-OFF (the pointer is ignored) — the else-branch
      // must resume a REAL cloud group box, not a "selfhosted" one: the registry
      // SelfhostedSandboxClient has no bound agentId and throws. Fall the group-box
      // backend back to the deployment default cloud backend so swap-away / flag-off
      // degrade to a genuine cloud box exactly like today (home=modal did).
      if (machinePrimary) {
        if (activeSandboxRecord!.scope === "user") {
          if (!fileAuthoritySubjectId) {
            throw new Error("personal machine use requires an initiating human subject");
          }
          const authorized = await assertPersonalMachineForAttempt(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: fileAuthoritySubjectId,
            sessionId: input.sessionId,
            turnId: turn.id,
            attemptId: input.attemptId,
            executionGeneration: turn.executionGeneration,
            enrollmentId: activeSandboxRecord!.enrollmentId!,
          });
          if (!authorized) {
            throw new Error("personal Connected Machine use was not admitted for this turn");
          }
        }
        // STAGE D D1-lite: the active sandbox is a connected machine, so DO NOT
        // establish OR lease the managed home box. The active-sandbox pointer is
        // the machine route's own epoch fence; the managed-home lease separately
        // owns cloud recovery, snapshots, billing, and reaping. Mixing those two
        // ownership domains lets an unrelated degraded cloud archive block a
        // healthy explicitly selected machine.
        // Whether the machine's latest Hello advertised the op-stream engine
        // (refreshed on every connect). Read only when the server flag is on —
        // one indexed lookup, and the flag off keeps this path byte-identical.
        const machineEnrollment = await getLiveEnrollmentConnection(
          db,
          activeSandboxRecord!.workspaceId,
          activeSandboxRecord!.enrollmentId!,
        );
        const machineOpStream =
          settings.agentOpStreamEnabled === true && machineEnrollment?.opStream === true;
        const established = await establishSelfhostedTurnSession(
          {
            db,
            settings,
            bus,
            onOp: machineOpObserver.observer,
            onSandboxOperation: sandboxOperationObserver,
            opJournal,
          },
          {
            workspaceId: input.workspaceId,
            controlWorkspaceId: activeSandboxRecord!.workspaceId,
            agentId: activeSandboxRecord!.enrollmentId!,
            // An offline machine must not fail turn admission. Bind an
            // intentionally unserved token so the model receives the normal
            // typed agent_offline tool result; a later turn resolves a fresh
            // claimed process instance.
            connectionInstanceId: machineEnrollment?.connectionInstanceId ?? "unavailable",
            opStream: machineOpStream,
            operationResourcePolicy: machineEnrollment?.operationPolicy ?? {
              memoryMaxBytes: null,
              memoryHighBytes: null,
              cpuMaxMillicores: null,
              revision: 0,
              updatedAt: null,
            },
            operationResourcePolicySupported:
              machineEnrollment?.agentCapabilities.operationResourcePolicy === true,
            operationCpuQuotaSupported:
              machineEnrollment?.agentCapabilities.operationCpuQuota === true,
            ...(activeSandboxRecord!.scope === "user" && fileAuthoritySubjectId
              ? {
                  personalMachineAttempt: {
                    accountId: input.accountId,
                    subjectId: fileAuthoritySubjectId,
                    sessionId: input.sessionId,
                    turnId: turn.id,
                    attemptId: input.attemptId,
                    executionGeneration: attempt.executionGeneration,
                  },
                }
              : {}),
            epoch: activeSandboxPointer!.activeEpoch,
            environment: sandboxEnvironment,
            ...(transientCodemodeEnvironment
              ? { transientExecEnvironment: transientCodemodeEnvironment }
              : {}),
            workingDir: activeSandboxPointer!.workingDir,
          },
        );
        // The machine-primary establish narrows `session` to SelfhostedSession
        // (buildSelfhostedBackendSession); EstablishedSandboxSession widens it.
        sandboxState.machinePrimarySession = established.session as SelfhostedSession;
        sandboxState.setupBoxSession = established.session;
        sandboxState.resolvedSandbox = {
          // Wrap in the SAME routing proxy so a mid-turn swap (to another machine
          // or back to the group box) still re-routes per op. PIN this established
          // SelfhostedSession for the machine pointer so the turn-start manifest
          // write (via the proxy's `state` getter) and the per-op reads hit ONE
          // instance — no two-instance manifest divergence.
          established: wrapTurnBoxWithRouting(
            {
              db,
              settings,
              bus,
              opJournal,
              onOp: machineOpObserver.observer,
              onSandboxOperation: sandboxOperationObserver,
              onHomeSandboxRebound,
              ...(runtimeCancellationSignal ? { waitSignal: runtimeCancellationSignal } : {}),
            },
            {
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              resourceAccountId: input.accountId,
              ...(fileAuthoritySubjectId ? { resourceSubjectId: fileAuthoritySubjectId } : {}),
              ...(fileAuthoritySubjectId
                ? {
                    personalMachineAttempt: {
                      accountId: input.accountId,
                      subjectId: fileAuthoritySubjectId,
                      turnId: turn.id,
                      attemptId: input.attemptId,
                      executionGeneration: attempt.executionGeneration,
                    },
                  }
                : {}),
              environment: sandboxEnvironment,
              ...(transientCodemodeEnvironment
                ? { transientExecEnvironment: transientCodemodeEnvironment }
                : {}),
              workspaceMutationFence: {
                accountId: input.accountId,
                turnId: turn.id,
                executionGeneration: attempt.executionGeneration,
                attemptId: input.attemptId,
              },
              pinnedSelfhosted: {
                sandboxId: activeSandboxPointer!.activeSandboxId!,
                epoch: activeSandboxPointer!.activeEpoch,
              },
              // HOME semantics for a mid-turn clear-to-null: only a genuine
              // machine-HOME session (its home IS this machine, session.sandboxBackend
              // === "selfhosted") resolves null back to the pinned machine. A Modal-HOME
              // session merely PINNED to a machine this turn never established its group
              // box, so defaultIsHome:false makes a clear-to-null fail typed
              // (`home_unavailable_this_turn`) rather than silently serving the machine;
              // the detach takes effect next turn. (Lazy home-box establishment on such a
              // clear is a deferred follow-up; issue #341.)
              defaultIsHome: session.sandboxBackend === "selfhosted",
            },
            established,
          ),
          // For a machine route this is the active-pointer epoch, not a cloud
          // lease epoch. Cloud-only heartbeat/snapshot/capture paths require
          // sandboxGroupId and remain disabled for this branch.
          leaseEpoch: activeSandboxPointer!.activeEpoch,
          release: async () => undefined,
        };
      } else if (establishPolicy === "on-demand") {
        // Lazy sandbox provisioning: holder/group ids are fixed at turn start,
        // but the lease acquire + box establish + setup move behind the routing
        // proxy's first default-pointer op. A chat-only turn never calls it, so
        // no lease row, no provider box, no warm-meter interval.
        //
        // A repository still forces that first default-pointer op before HTTP
        // (workspace-skill catalog in Agent.instructions). Start create now and
        // join it at get(); do not await here or we serialize Modal before tools.
        if (sandboxState.sandboxHolderId && sandboxState.sandboxGroupId) {
          const lazyHolderId = sandboxState.sandboxHolderId;
          const lazyGroupId = sandboxState.sandboxGroupId;
          sandboxState.resumeManagedGroupBox = () =>
            resumeBoxForTurn(
              {
                db,
                settings: runSettings,
                logicalFallbackSettings: logicalSandboxSettings,
                cancellationSignal: sandboxResumeSignal,
                sandboxMetrics: runtimeMetricsHooksForObservability(observability),
                onSandboxLost: publishSandboxLost,
              },
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sandboxGroupId: lazyGroupId,
                sessionId: input.sessionId,
                backend: groupBoxBackend,
                os: session.sandboxOs,
                environment: sandboxEnvironment,
                ...(groupBoxImage
                  ? {
                      image: groupBoxImage,
                    }
                  : {}),
                // The lazy acquire must enforce the same frozen rig authority
                // as the eager acquire; otherwise a warm box for another rig
                // can bypass the shared-state conflict/rotation fence.
                ...(rigVersion ? { rigVersionId: rigVersion.id } : {}),
              },
              "turn",
              lazyHolderId,
            );
          if (
            shouldPrefetchManagedSandbox({
              establishPolicy,
              machinePrimary,
              groupBoxBackend,
              hasRepositoryResources: turnResources.some(
                (resource) => resource.kind === "repository",
              ),
            })
          ) {
            startRunGitCredentialsMint();
            const started = waitForTurnOperation(
              sandboxState.resumeManagedGroupBox(),
              sandboxResumeSignal,
              releaseLateSandbox,
            );
            const joined = started.catch((error) => {
              if (isLazySandboxProvisionRetryable(error)) {
                sandboxState.prefetchedManagedBox = null;
              }
              throw error;
            });
            sandboxState.prefetchedManagedBox = joined;
            void joined.then(
              (box) => {
                if (sandboxResumeSignal.aborted) return;
                startLeaseHeartbeat(box, activeSandboxBackend ?? groupBoxBackend);
              },
              () => undefined,
            );
          }
        }
      } else {
        await eventing.publish!(
          [
            {
              type: "sandbox.operation.started",
              payload: { name: "sandbox.provision" },
            },
          ],
          true,
        );
        try {
          sandboxState.resolvedSandbox = await waitForTurnOperation(
            resumeBoxForTurn(
              {
                db,
                settings: runSettings,
                logicalFallbackSettings: logicalSandboxSettings,
                cancellationSignal: sandboxResumeSignal,
                sandboxMetrics: runtimeMetricsHooksForObservability(observability),
                onSandboxLost: publishSandboxLost,
              },
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sandboxGroupId: session.sandboxGroupId,
                sessionId: input.sessionId,
                // groupBoxBackend, not turn.sandboxBackend: a machine-home turn that
                // is not machine-primary resumes a real cloud group box (the
                // deployment default), never a "selfhosted" box (which would throw
                // for lack of a bound agentId).
                backend: groupBoxBackend,
                os: session.sandboxOs,
                environment: sandboxEnvironment,
                // IMAGE IS SHARED STATE (B3): the container image
                // this run resolves. The lease stamps it + conflicts on a live shared box
                // running a DIFFERENT image (solo → durable rotation; N-holders →
                // SandboxImageConflictError surfaced as an actionable turn error). Select
                // the image for the actual group-box backend; a configured Modal image must
                // never override a Docker run. The selfhosted branch
                // (establishSelfhostedTurnSession) NEVER passes
                // an image — B3 lives only on this managed-box branch.
                ...(groupBoxImage
                  ? {
                      image: groupBoxImage,
                    }
                  : {}),
                // RIG IS SHARED STATE (M3): stamp the frozen rig version so the lease
                // conflicts on a live shared box set up under a different rig (solo
                // durable rotation / N-holders SandboxRigConflictError). Omitted for a
                // rig-less turn -> never stamped or enforced (shares exactly as today).
                ...(rigVersion ? { rigVersionId: rigVersion.id } : {}),
              },
              "turn",
              managedOwnership!.holderId,
            ),
            sandboxResumeSignal,
            releaseLateSandbox,
          );
        } catch (error) {
          await eventing.publish!(
            [
              {
                type: "sandbox.operation.failed",
                payload: {
                  name: "sandbox.provision",
                  error: error instanceof Error ? error.message : String(error),
                },
              },
            ],
            true,
          );
          throw error;
        }
        sandboxState.setupBoxSession = sandboxState.resolvedSandbox.established.session;
        // Durable box-lifecycle events (sandbox-file-persistence observability):
        // record every box transition in session_events so the NEXT box loss is
        // attributable from the DB alone — worker logs rotate within hours, which
        // left both 2026-07-06 incidents without a durable trace. Best-effort.
        await publishSandboxLifecycleEvents(sandboxState.resolvedSandbox);
        await eventing.publish!(
          [
            {
              type: "sandbox.operation.completed",
              payload: {
                name: "sandbox.provision",
                ...(sandboxState.resolvedSandbox.established.origin
                  ? { origin: sandboxState.resolvedSandbox.established.origin }
                  : {}),
              },
            },
          ],
          true,
        );
        // M7 hot-swap: when the selfhosted feature is on, wrap the established
        // group box in the STABLE routing proxy before it is injected NON-OWNED
        // into the run. The SDK binds to this ONE object once and calls its
        // methods per tool call; the proxy re-reads (active_sandbox_id,
        // active_epoch) per op and dispatches to the currently-active backend, so
        // a sandbox_swap mid-turn lands the NEXT tool call on the new box. With
        // the flag off the established group box is injected unchanged (today's
        // path). The lease still owns the group box lifecycle — the proxy is a
        // routing veneer, not an owner.
        sandboxState.resolvedSandbox = {
          ...sandboxState.resolvedSandbox,
          established: wrapTurnBoxWithRouting(
            {
              db,
              settings,
              bus,
              opJournal,
              onSandboxOperation: sandboxOperationObserver,
              onHomeSandboxLost: publishSandboxLost,
              onHomeSandboxRebound,
              ...(runtimeCancellationSignal ? { waitSignal: runtimeCancellationSignal } : {}),
            },
            // Thread the SAME declared environment the group box was created with
            // (resumeBoxForTurn, above) so a selfhosted swap target's manifest
            // carries it too — the SDK's per-turn manifest-env delta stays empty
            // (no "cannot change manifest environment variables" throw).
            {
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              resourceAccountId: input.accountId,
              ...(fileAuthoritySubjectId ? { resourceSubjectId: fileAuthoritySubjectId } : {}),
              ...(fileAuthoritySubjectId
                ? {
                    personalMachineAttempt: {
                      accountId: input.accountId,
                      subjectId: fileAuthoritySubjectId,
                      turnId: turn.id,
                      attemptId: input.attemptId,
                      executionGeneration: attempt.executionGeneration,
                    },
                  }
                : {}),
              environment: sandboxEnvironment,
              ...(transientCodemodeEnvironment
                ? { transientExecEnvironment: transientCodemodeEnvironment }
                : {}),
              workspaceMutationFence: {
                accountId: input.accountId,
                turnId: turn.id,
                executionGeneration: attempt.executionGeneration,
                attemptId: input.attemptId,
              },
              homeLease: {
                accountId: input.accountId,
                sandboxGroupId: session.sandboxGroupId,
                leaseEpoch: sandboxState.resolvedSandbox.leaseEpoch,
                instanceId: sandboxState.resolvedSandbox.established.instanceId,
                backend: groupBoxBackend,
              },
            },
            sandboxState.resolvedSandbox.established,
          ),
        };
      }
      if (sandboxState.resolvedSandbox) {
        startLeaseHeartbeat(sandboxState.resolvedSandbox, activeSandboxBackend ?? groupBoxBackend);
      }
    } catch (error) {
      sandboxEstablishOutcome = "failed";
      throw error;
    } finally {
      recordTurnStartupPhase(observability, {
        phase: "sandbox_establish",
        provider: turnExecutionPolicy.providerId,
        backend: machinePrimary ? "selfhosted" : groupBoxBackend,
        outcome: sandboxEstablishOutcome,
        durationSeconds: (performance.now() - sandboxEstablishStartedAt) / 1_000,
      });
    }
  }
}

export async function bindLazySandboxProvisioner(
  deps: BindLazySandboxProvisionerDeps,
): Promise<void> {
  const {
    input,
    settings,
    db,
    bus,
    observability,
    runtimeCancellationSignal,
    sandboxResumeSignal,
    opJournal,
    sandboxState,
    eventing,
    attempt,
    turn,
    session,
    fileAuthoritySubjectId,
    runSettings,
    sandboxEnvironment,
    groupBoxBackend,
    activeSandboxBackend,
    establishPolicy,
    startRunGitCredentialsMint,
    machineOpObserver,
    sandboxOperationObserver,
    sandboxRuntime,
    transientCodemodeEnvironment,
    agent,
    attachRunCredentialRenewal,
    attachGitCredentialRenewal,
    attachCodemodeTokenRenewal,
    throwIfWorkerShuttingDown,
    throwIfTurnCancelled,
    initialRunCredentialMaterial,
    sandboxCodemodeToken,
    media,
    toolResultSpill,
    connectionScope,
    codemodeAuthority,
  } = deps;
  const {
    releaseLateSandbox,
    onHomeSandboxRebound,
    publishSandboxLifecycleEvents,
    publishSandboxLost,
    startLeaseHeartbeat,
    runWorkspaceMutationForSandbox,
  } = sandboxRuntime;

  if (
    establishPolicy === "on-demand" &&
    sandboxState.sandboxHolderId &&
    sandboxState.sandboxGroupId
  ) {
    const agentDefaultManifest = (agent as { defaultManifest?: unknown }).defaultManifest;
    if (!agentDefaultManifest) {
      throw new Error("Lazy sandbox provisioning requires a SandboxAgent defaultManifest");
    }
    const lazyClient = {
      backendId: sdkBackendIdForSandboxBackend(groupBoxBackend),
    } as EstablishedSandboxSession["client"];
    let lazySandboxEstablishmentSettled = false;
    sandboxState.turnSandboxProvisioner = createTurnSandboxProvisioner<ResumedTurnSandbox>(
      async () => {
        throwIfWorkerShuttingDown();
        throwIfTurnCancelled();
        if (!sandboxState.resumeManagedGroupBox) {
          throw new Error("Lazy sandbox provisioning requires a managed group-box resume");
        }
        startRunGitCredentialsMint();
        const provisioned = await (sandboxState.prefetchedManagedBox ??
          sandboxState.resumeManagedGroupBox());
        await publishSandboxLifecycleEvents(provisioned);
        // Return the REAL established box (NOT a copy whose session is the routing
        // proxy). resolveActiveBackend dispatches ops to `provisioned.established.session`;
        // if that were the proxy itself, proxy.exec -> dispatch -> resolve ->
        // provisioner.get() -> proxy.exec -> ... loops forever (an async infinite
        // recursion that HANGS the turn — caught live on staging 2026-07-08). The SDK
        // already holds the proxy directly (injected as lazyOwnedSandbox.session), so it
        // gets per-op routing; the worker-side handle (resolvedSandbox: release,
        // heartbeat, computer-use recording) wants the real box, unproxied.
        return provisioned;
      },
      {
        signal: sandboxResumeSignal,
        onStarted: async ({ provisionId }) => {
          await eventing.publish?.(
            [
              {
                type: "sandbox.operation.started",
                payload: { name: "sandbox.provision", provisionId },
              },
            ],
            true,
          );
        },
        onAttemptSettled: ({ result, error, outcome, durationMs }) => {
          const successStage =
            result?.established.origin === "created"
              ? "create"
              : result?.established.origin === "resumed"
                ? "resume"
                : result?.established.origin === "restored"
                  ? "archive_recovery"
                  : "unknown";
          const failure = error
            ? classifySandboxLogicalProvisionFailure(groupBoxBackend, error)
            : null;
          recordSandboxProvisionAttempt(observability, {
            backend: groupBoxBackend,
            stage: failure?.stage ?? successStage,
            category: failure?.category ?? successStage,
            outcome,
            durationSeconds: durationMs / 1_000,
          });
        },
        beforeCompleted: async (provisioned, settlement) => {
          throwIfTurnOperationCancelled(sandboxResumeSignal);
          startLeaseHeartbeat(provisioned, activeSandboxBackend ?? groupBoxBackend);
          sandboxState.setupBoxSession = provisioned.established.session;
          sandboxState.resolvedSandbox = provisioned;
          // This durable completion and its logical metric close at actual box
          // establishment. Credential, rig, repository, and file preparation below
          // must never be attributed to "Starting sandbox" or provision latency.
          await eventing.publish?.(
            [
              {
                type: "sandbox.operation.completed",
                payload: {
                  name: "sandbox.provision",
                  ...(provisioned.established.origin
                    ? { origin: provisioned.established.origin }
                    : {}),
                  provisionId: settlement.provisionId,
                  internalAttempts: settlement.internalAttempts,
                },
              },
            ],
            true,
          );
          const successStage =
            provisioned.established.origin === "created"
              ? "create"
              : provisioned.established.origin === "resumed"
                ? "resume"
                : provisioned.established.origin === "restored"
                  ? "archive_recovery"
                  : "unknown";
          recordSandboxLogicalProvision(observability, {
            backend: groupBoxBackend,
            stage: successStage,
            category: "none",
            outcome: "completed",
            expected: false,
            internalAttempts: settlement.internalAttempts,
            durationSeconds: settlement.durationMs / 1_000,
          });
          lazySandboxEstablishmentSettled = true;

          const lazyGitCredentials =
            activeSandboxBackend === "selfhosted" ? undefined : await startRunGitCredentialsMint();
          const lazyGitTokens = lazyGitCredentials?.gitTokens;
          const lazyCodemodeToken = sandboxCodemodeToken
            ? await mintSandboxCodemodeToken(runSettings, connectionScope, codemodeAuthority)
            : undefined;
          await attachRunCredentialRenewal(
            provisioned.established.session as RunCredentialCommandSession,
            initialRunCredentialMaterial,
            provisioned,
          );
          const provisionedSetupSession = initialRunCredentialMaterial
            ? withRunCredentialsSession(provisioned.established.session as object, input.sessionId)
            : provisioned.established.session;
          await runWorkspaceMutationForSandbox(
            provisioned,
            "lazyOwnedSandboxSetup",
            async () =>
              await runOwnedSandboxSetup(
                agent,
                provisioned.established.session as never,
                provisionedSetupSession as never,
                {
                  settings: runSettings,
                  environment: sandboxEnvironment,
                  onRuntimeEvent: async (event) => {
                    await eventing.publish?.([{ type: event.type, payload: event.payload }], true);
                  },
                  ...(lazyGitTokens ? { gitTokenSeedsOverride: lazyGitTokens } : {}),
                  ...(lazyGitCredentials?.bindings
                    ? {
                        gitCredentialBindingsOverride: lazyGitCredentials.bindings,
                      }
                    : {}),
                  ...(lazyCodemodeToken
                    ? {
                        codemodeTokenSeedOverride: lazyCodemodeToken.token,
                      }
                    : {}),
                  ...(eventing.toolCancellationFenceRef.current
                    ? {
                        commandRunner:
                          eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                            eventing.toolCancellationFenceRef.current,
                          ),
                      }
                    : {}),
                },
              ),
            (measurement) => {
              if (eventing.firstModelRequestPreparationRecorded) return;
              sandboxState.firstModelPreparationNestedSandboxMs +=
                measurement.durationSeconds * 1_000;
              sandboxState.firstModelPreparationNestedSandboxPhases.push(measurement);
            },
          );
          await attachCodemodeTokenRenewal(
            provisioned.established.session as CodemodeTokenWriterSession,
            lazyCodemodeToken?.expiresAt,
            provisioned,
          );
          await attachGitCredentialRenewal(
            provisioned.established.session as GitCredentialTokenWriterSession,
            lazyGitCredentials,
            provisioned,
          );
          // `get()` does not release the first routed sandbox operation
          // until this hook returns. Only images created during this exact
          // turn can require deferred delivery here; historical images stay
          // as durable receipts and are restored explicitly when requested.
          for (const receipt of media.generatedImageReceiptsCreatedThisTurn.values()) {
            await media.materializeGeneratedImageInSandbox(
              receipt,
              provisioned,
              provisioned.established.session,
            );
          }
          await toolResultSpill.materializeDeferred();
          throwIfTurnOperationCancelled(sandboxResumeSignal);
        },
        onFailed: async (error, settlement) => {
          if (lazySandboxEstablishmentSettled) return;
          const failure = classifySandboxLogicalProvisionFailure(groupBoxBackend, error);
          await eventing.publish?.(
            [
              {
                type: "sandbox.operation.failed",
                payload: {
                  name: "sandbox.provision",
                  error: error instanceof Error ? error.message : String(error),
                  provisionId: settlement.provisionId,
                  internalAttempts: settlement.internalAttempts,
                  failureCategory: failure.category,
                  failureStage: failure.stage,
                  failureCode: failure.code,
                  expectedTransition: failure.expected,
                  retryable: failure.retryable,
                },
              },
            ],
            true,
          );
          recordSandboxLogicalProvision(observability, {
            backend: groupBoxBackend,
            stage: failure.stage,
            category: failure.category,
            outcome: failure.expected ? "expected_transition" : "failed",
            expected: failure.expected,
            internalAttempts: settlement.internalAttempts,
            durationSeconds: settlement.durationMs / 1_000,
          });
        },
        disposeResult: async (provisioned) => {
          await releaseLateSandbox(provisioned);
        },
      },
    );
    sandboxState.lazyOwnedSandbox = wrapLazyTurnBoxWithRouting(
      {
        db,
        settings,
        bus,
        opJournal,
        onOp: machineOpObserver.observer,
        onSandboxOperation: sandboxOperationObserver,
        onHomeSandboxLost: publishSandboxLost,
        onHomeSandboxRebound,
        ...(runtimeCancellationSignal ? { waitSignal: runtimeCancellationSignal } : {}),
      },
      {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        resourceAccountId: input.accountId,
        ...(fileAuthoritySubjectId ? { resourceSubjectId: fileAuthoritySubjectId } : {}),
        ...(fileAuthoritySubjectId
          ? {
              personalMachineAttempt: {
                accountId: input.accountId,
                subjectId: fileAuthoritySubjectId,
                turnId: turn.id,
                attemptId: input.attemptId,
                executionGeneration: attempt.executionGeneration,
              },
            }
          : {}),
        environment: sandboxEnvironment,
        ...(transientCodemodeEnvironment
          ? { transientExecEnvironment: transientCodemodeEnvironment }
          : {}),
        workspaceMutationFence: {
          accountId: input.accountId,
          turnId: turn.id,
          executionGeneration: attempt.executionGeneration,
          attemptId: input.attemptId,
        },
      },
      {
        client: lazyClient,
        backendId: sdkBackendIdForSandboxBackend(groupBoxBackend),
        agentDefaultManifest,
        provisioner: sandboxState.turnSandboxProvisioner,
        homeLeaseIdentity: {
          accountId: input.accountId,
          sandboxGroupId: session.sandboxGroupId,
          backend: groupBoxBackend,
        },
        onFirstOperation: (measurement) => {
          if (eventing.firstModelRequestPreparationRecorded) return;
          markModelPreparationFirstSandboxOperation(measurement.durationMs / 1_000);

          for (const nested of sandboxState.firstModelPreparationNestedSandboxPhases) {
            if (nested.phase === "snapshot_wait") continue;
            recordModelPreparationMeasurement({
              phase:
                nested.phase === "admission"
                  ? "sandbox_workspace_mutation_admission"
                  : nested.phase === "provider"
                    ? "sandbox_workspace_mutation_provider"
                    : "sandbox_workspace_mutation_settlement",
              outcome: nested.outcome,
              durationSeconds: nested.durationSeconds,
            });
          }

          const resolution = measurement.phases.resolution;
          if (resolution) {
            recordModelPreparationMeasurement({
              phase: "sandbox_first_routed_resolution_other",
              outcome: resolution.outcome,
              durationSeconds:
                Math.max(
                  0,
                  resolution.durationMs - sandboxState.firstModelPreparationNestedSandboxMs,
                ) / 1_000,
            });
          }

          const routedPhaseNames = [
            ["mutationAdmission", "sandbox_first_routed_mutation_admission"],
            ["providerOperation", "sandbox_first_routed_provider_operation"],
            ["mutationSettlement", "sandbox_first_routed_mutation_settlement"],
          ] as const;
          for (const [phaseName, metricPhase] of routedPhaseNames) {
            const phase = measurement.phases[phaseName];
            if (!phase) continue;
            recordModelPreparationMeasurement({
              phase: metricPhase,
              outcome: phase.outcome,
              durationSeconds: phase.durationMs / 1_000,
            });
          }

          const nestedSnapshotPhases = sandboxState.firstModelPreparationNestedSandboxPhases.filter(
            (phase) => phase.phase === "snapshot_wait",
          );
          const routedSnapshot = measurement.phases.snapshotWait;
          const snapshotWaitMs =
            nestedSnapshotPhases.reduce(
              (total, phase) => total + phase.durationSeconds * 1_000,
              0,
            ) + (routedSnapshot?.durationMs ?? 0);
          if (snapshotWaitMs > 0) {
            recordModelPreparationMeasurement({
              phase: "sandbox_snapshot_wait",
              outcome:
                routedSnapshot?.outcome === "failed" ||
                nestedSnapshotPhases.some((phase) => phase.outcome === "failed")
                  ? "failed"
                  : "completed",
              durationSeconds: snapshotWaitMs / 1_000,
            });
          }

          const routedMeasuredMs = Object.values(measurement.phases).reduce(
            (total, phase) => total + (phase?.durationMs ?? 0),
            0,
          );
          const routedOtherMs = Math.max(0, measurement.durationMs - routedMeasuredMs);
          if (routedOtherMs > 0) {
            recordModelPreparationMeasurement({
              phase: "sandbox_first_routed_other",
              outcome: measurement.outcome,
              durationSeconds: routedOtherMs / 1_000,
            });
          }
        },
      },
    );
  }
}
