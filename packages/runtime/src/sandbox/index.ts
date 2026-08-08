// @opengeni/runtime/sandbox — the agent-loop-free sandbox leaf.
//
// This module is the load-bearing pre-req for the API-direct control plane
// (docs/connected-machines.md). It exposes the sandbox client factory plus
// the resume / recovery-envelope helpers that the API needs to touch a box by
// id (resume-by-id, file/exec/port ops) WITHOUT importing the @openai/agents
// agent-loop graph.
//
// IMPORT DISCIPLINE (enforced by packages/runtime/test/sandbox-leaf-no-agent-loop.test.ts):
//   - ALLOWED: the per-provider sandbox SDK build imports
//       `@openai/agents/sandbox`, `@openai/agents/sandbox/local`,
//       `@openai/agents-extensions/sandbox/modal`
//     and the workspace `@opengeni/config` / `@opengeni/contracts` packages.
//   - FORBIDDEN: the agent-loop entrypoints — the bare `@openai/agents`,
//       `@openai/agents-extensions`, or `@openai/agents-core` roots, and the
//       loop symbols (`Agent`, `run`, `Runner`, `RunState`).
// The barrel `packages/runtime/src/index.ts` re-exports everything here via
// `export * from "./sandbox"`, so existing consumers (apps/worker) are
// unchanged.

import type { Settings } from "@opengeni/config";
import { collectSandboxEnvironment, parseExposedPorts } from "@opengeni/config";
import {
  DESKTOP_STREAM_PORT,
  OPENGENI_SANDBOX_PROVIDER_INSTANCE_ID_FIELD,
  TERMINAL_STREAM_PORT,
  type SandboxBackend,
  type SandboxProviderContinuityRecovery,
} from "@opengeni/contracts";
import type {
  Manifest,
  SandboxClient,
  SandboxSessionLike,
  SandboxSessionState,
} from "@openai/agents/sandbox";
import { serializeManifestRecord } from "@openai/agents-core/sandbox/internal";
import { PROVIDER_REGISTRY } from "./providers";
import type { ProviderRegistration } from "./providers/types";
import { sandboxBackendForSdkBackendId } from "./select";
import {
  SandboxConfigError,
  SandboxExactResumeReplacedError,
  SandboxProviderContinuityUnavailableError,
  SandboxResumeIdentityMismatchError,
  SandboxResumeIdentityUnavailableError,
  SandboxResumeStateUnavailableError,
} from "./errors";
import { isProviderSandboxNotFoundError } from "./provider-errors";
import {
  decodeNativeSnapshotRef,
  readVerifiedWorkspaceArchive,
  verifyRestoredWorkspace,
  WorkspaceArchiveIntegrityError,
  type VerifiedWorkspaceArchive,
  type WorkspaceArchiveDescriptor,
} from "./workspace-archive";
import type { RuntimeMetricsHooks } from "../metrics";
import { normalizeProtocolJsonValue } from "../protocol-json";
import { runStateCompatibilityProvider, runStateExposedPortsRecord } from "./run-state-compat";

// Re-export the config-owned environment/port helpers from the leaf so the
// API-direct control plane can pull its full sandbox-construction surface from
// a single agent-loop-free entrypoint. They physically live in @opengeni/config
// (moving them into runtime would create a config→runtime cycle — ledger CR8).
export { collectSandboxEnvironment, parseExposedPorts } from "@opengeni/config";
export {
  repairSerializedRunStateExposedPorts,
  runStateCompatibilityProvider,
  runStateExposedPortsRecord,
  type RunStateExposedPortsCompatibilityRepair,
  type RunStateExposedPortsCompatibilityResult,
} from "./run-state-compat";

// The provider registry surface — the descriptor table self-test, the per-
// provider registrations, selection + capability negotiation, and the typed
// construction errors. All agent-loop-free, so the API-direct control plane
// imports them from this one leaf.
export {
  CAPABILITY_DESCRIPTORS,
  DESKTOP_STREAM_PORT,
  assertDescriptorRegistryInvariants,
  type CapabilityDescriptor,
} from "./capabilities";
export {
  SandboxConfigError,
  SandboxExactResumeInstanceUnavailableError,
  SandboxExactResumeReplacedError,
  SandboxProviderContinuityUnavailableError,
  SandboxProviderUnavailableError,
  SandboxResumeIdentityMismatchError,
  SandboxResumeIdentityUnavailableError,
  SandboxResumeStateUnavailableError,
} from "./errors";
export {
  PROVIDER_REGISTRY,
  assertProviderRegistryInvariants,
  prepareProviderForTeardownAfterCapture,
  providerWorkspaceCapturePolicy,
  type ProviderRegistration,
  type ProviderConstructionContext,
  type ProviderExactResumeMode,
  type ProviderWorkspaceCapturePolicy,
  type ProviderWorkspaceCaptureTakeover,
} from "./providers";
export {
  classifyProviderSandboxFailure,
  isProviderSandboxGoneDuringRoutedOperation,
  isProviderSandboxNotFoundError,
  isProviderSandboxTransientError,
  type ProviderSandboxFailure,
  type ProviderSandboxFailureKind,
} from "./provider-errors";
export {
  WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION,
  WorkspaceArchiveIntegrityError,
  captureVerifiedWorkspaceArchive,
  decodeNativeSnapshotRef,
  describeLegacyNativeSnapshotArchive,
  describeNativeSnapshotArchive,
  fingerprintSandboxWorkspace,
  parseWorkspaceArchiveDescriptor,
  readVerifiedWorkspaceArchive,
  verifyRestoredWorkspace,
  type NativeSnapshotDescriptor,
  type NativeSnapshotProvider,
  type NativeSnapshotRef,
  type TarWorkspaceArchiveDescriptor,
  type VerifiedWorkspaceArchive,
  type WorkspaceArchiveDescriptor,
  type WorkspaceArchiveIntegrityCode,
  type WorkspaceTreeFingerprint,
} from "./workspace-archive";
export {
  ensureModalRegistryImage,
  deleteModalCheckpointSnapshot,
  inspectModalSandboxLifecycle,
  modalSessionMatchesCheckpointProviderBinding,
  modalSandboxAttributionEnvironment,
  modalSandboxAttributionTags,
  resolveModalCheckpointProviderBinding,
  resolveModalCheckpointProviderBindingForLiveSandbox,
  resolveModalCheckpointProviderBindingForSession,
  sweepModalOrphanSandboxes,
  tagModalSandbox,
  terminateModalSandboxById,
  type LiveModalSandboxLeaseAttribution,
  type ModalModuleLoader,
  type ModalCheckpointProviderBinding,
  type ModalOrphanSweepResult,
  type ModalOrphanSweepTermination,
  type ModalSandboxAttribution,
  type RevalidateModalOrphanTermination,
} from "./providers/modal";
export {
  selectBackend,
  sdkBackendIdForSandboxBackend,
  sandboxBackendForSdkBackendId,
  backendSupportsOs,
  desktopCapableBackend,
  negotiateCapabilities,
  type NegotiationContext,
} from "./select";

// Scoped data-plane stream-token mint/verify (P3.1). Agent-loop-free; the API
// pulls these from this leaf to authorize the desktop pixel plane.
export {
  STREAM_TOKEN_DEFAULT_TTL_SECONDS,
  mintStreamToken,
  verifyStreamToken,
  StreamTokenPayload,
  type MintStreamTokenInput,
  type StreamTokenPayloadType,
} from "./stream-token";

// The Channel-B desktop display-stack launcher (P4.1). Exec-launched,
// flock-idempotent; the worker (per-turn) and the API (per viewer op) both drive
// it from this leaf to bring up Xvfb -> XFCE -> x11vnc -viewonly -> websockify:6080.
export {
  STREAM_PORT,
  DISPLAY_STACK_TIMEOUT_MS,
  DEFAULT_DESKTOP_GEOMETRY,
  DisplayStackError,
  DisplayStackUnsupportedError,
  buildDisplayStackScript,
  ensureDisplayStack,
  tearDownDisplayStack,
  type DesktopGeometry,
  type DisplayStackCallerKind,
  type DisplayStackClassification,
  type DisplayStackTelemetryContext,
  type DisplayStackTelemetryEvent,
  type DisplayStackTelemetryStatus,
  type EnsureDisplayStackOptions,
  type EnsureDisplayStackResult,
} from "./display-stack";

// The Channel-B REAL PTY terminal-server launcher (P5.t). Exec-launched,
// flock-idempotent twin of ensureDisplayStack; brings up ttyd PTY-over-websocket
// (bash -l per ws client) on 7681 over the SAME tunnel the desktop noVNC uses.
export {
  TERMINAL_STREAM_PORT,
  TERMINAL_SERVER_TIMEOUT_MS,
  TerminalServerError,
  TerminalServerUnsupportedError,
  buildTerminalServerScript,
  ensureTerminalServer,
  tearDownTerminalServer,
  type EnsureTerminalServerOptions,
  type EnsureTerminalServerResult,
} from "./terminal-server";

// Host-owned rotating run credentials. Material lives outside the persisted
// workspace/manifest and is activated atomically per session generation.
export {
  RunCredentialValidationError,
  normalizeRunCredentialsResolution,
  runCredentialRoot,
  runCredentialPointerFile,
  materializeRunCredentials,
  clearRunCredentials,
  clearRunCredentialsForAttempt,
  withRunCredentialEnvironment,
  withRunCredentialsSession,
  withRunCredentialsClient,
  type RunCredentialExpectedScope,
  type NormalizedRunCredentialMaterial,
  type RunCredentialCommandSession,
  type RunCredentialCommandRunner,
  type RunCredentialSessionReady,
  type MaterializeRunCredentialsOptions,
} from "./run-credentials";

// Session-specific Toolspace token routing. The manifest retains one stable
// legacy pointer for warm-box env parity; every session command selects its own
// hashed token file off-manifest.
export {
  ToolspaceTokenPathError,
  toolspaceTokenFileForSession,
  toolspaceTokenFileFromEnvironment,
  withToolspaceTokenEnvironment,
  withToolspaceTokenSession,
  withToolspaceTokenClient,
} from "./toolspace-token";

// The Channel-B pixel DATA PLANE (P4.2). Resolves the provider's scoped tunnel
// for port 6080 (client → provider-tunnel direct), assembles the WS URL, and
// mints the scoped stream token. Called API-direct on the resumed handle.
export {
  exposeStreamPort,
  buildStreamUrl,
  StreamPortUnavailableError,
  type ExposedPortEndpoint,
  type ExposeStreamPortInput,
  type ExposeStreamPortResult,
} from "./stream-port";

// P4.3 recording loop — plain functions over a live session handle (no agent
// loop); finalize uploads box -> object storage without buffering in the worker.
export {
  startRecording,
  stopRecording,
  inspectRecordingArtifact,
  uploadRecordingArtifact,
  deleteRecordingArtifacts,
  recordingStorageKey,
  contentTypeForCodec,
  extForCodec,
  RecordingUnavailableError,
  RecordingError,
  type RecordingCodec,
  type RecordingContentType,
  type StartRecordingInput,
  type RecordingProcess,
  type RecordingArtifactMetadata,
} from "./recording";

// P4.4 Channel-A structured services — the provider-agnostic SandboxChannelAService
// (FileSystem + Git + Terminal) over a live, resumed-by-id session handle. The
// API constructs one per request around the box it just resumed; no ownership.
// Agent-loop-free, so the API-direct control plane imports it from this leaf.
export {
  SandboxChannelAService,
  ChannelAValidationError,
  ChannelAUnavailableError,
  ChannelAConflictError,
  ChannelANotFoundError,
  ChannelAUnsupportedError,
  stripExecBanner,
  parseExecBannerSessionId,
  parseExecBannerExitCode,
  isExecSessionLostBanner,
  assertSafeRelPath,
  parsePorcelainV2,
  parseNumstatZ,
  parseUnifiedPatch,
  REPOSITORY_DISCOVERY_LIMIT,
  type ChannelASession,
  type ChannelAExecArgs,
  type ChannelAExecResult,
  type ChannelAEmitter,
  type SandboxChannelAServiceOptions,
  type RepositoryDiscoveryDegradedReason,
  type RepositoryDiscoveryResult,
  type NumstatEntry,
} from "./channel-a";

// The selfhosted (bring-your-own-compute) control surface (M3). The NATS-backed
// `SelfhostedSession` presents the SAME structural exec/fs/git surface as Modal
// over a `ControlRpc` seam (request/reply on `agent.<ws>.<id>.rpc`, encoded via
// `@opengeni/agent-proto`). agent-offline is NEVER a NotFound — the lease never
// cold-creates a rival for a user's real machine. The real NATS transport +
// Accounts land in M4 behind the SAME `ControlRpc`.
export {
  type ControlRpc,
  NatsControlRpc,
  SelfhostedControlError,
  agentErrorToControlError,
  subjectFor,
  offlineControlResponse,
  timeoutControlResponse,
  offlineAgentError,
  timeoutAgentError,
  drainingExhaustedError,
  payloadTooLargeMessage,
  drainingMessage,
  execDeadlineHint,
  NEVER_SENT_DETAIL_KEY,
  type NatsRequestConnection,
  type SelfhostedUnavailableReason,
} from "./selfhosted/control-rpc";
// The transport-agnostic per-op observation seam (out-of-band telemetry — metrics
// + machine.* events; the op-engine's op-stream client emits through this too).
export type { SelfhostedOpObserver, SelfhostedOpObservation } from "./selfhosted/op-observer";
// The four-field in-band fault renderer (the failure-visibility doctrine).
export {
  selfhostedFaultClass,
  SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES,
  renderSelfhostedFault,
  FAULT_FIELD_WHAT_HAPPENED,
  FAULT_FIELD_WHICH_LAYER,
  FAULT_FIELD_WHAT_PRESERVED,
  FAULT_FIELD_WHAT_TO_TRY,
} from "./selfhosted/fault-rendering";
// The selfhosted control-op retry policy (the pure decision + the injected clock).
export {
  decideSelfhostedRetry,
  selfhostedRetryBackoffMs,
  defaultSelfhostedRetryClock,
  SELFHOSTED_IDEMPOTENT_READONLY_OPS,
  SELFHOSTED_DRAINING_MAX_RETRIES,
  SELFHOSTED_EXEC_DRAINING_MAX_RETRIES,
  SELFHOSTED_TIMEOUT_MAX_RETRIES,
  SELFHOSTED_NEVER_SENT_MAX_RETRIES,
  SELFHOSTED_RETRY_BACKOFF_BASE_MS,
  SELFHOSTED_RETRY_BACKOFF_FACTOR,
  SELFHOSTED_RETRY_BACKOFF_CAP_MS,
  type SelfhostedRetryClock,
  type SelfhostedRetryDecision,
} from "./selfhosted/retry-policy";
export {
  SelfhostedSession,
  SelfhostedSandboxClient,
  buildSelfhostedBackendSession,
  isSelfhostedProviderNotFoundError,
  setSelfhostedApplyDiff,
  SELFHOSTED_DEFAULT_TIMEOUT_MS,
  SELFHOSTED_RELAY_STREAM_PATH,
  type SelfhostedSessionState,
  type SelfhostedSessionDeps,
  type SelfhostedSessionBuild,
  type SelfhostedRelayConfig,
  type SelfhostedExecArgs,
  type SelfhostedExecResult,
  type SelfhostedApplyDiff,
  type SelfhostedEditor,
  type SelfhostedImageOutput,
  type SelfhostedOpStreamDeps,
} from "./selfhosted/session";
// The op-stream exec transport (op-stream protocol v1.1 — streaming exec to a
// Connected Machine runner). The worker injects `NatsOpStreamTransport` (over
// the same bus connection as the control rpc) plus an `OpStreamJournal`
// adapted onto Temporal; sessions without the injection keep the legacy exec.
export {
  NatsOpStreamTransport,
  OpStreamUnavailableError,
  opAckSubject,
  opFrameSubject,
  type NatsOpStreamConnection,
  type OpStreamSubscription,
  type OpStreamTransport,
} from "./selfhosted/op-transport";
export {
  OP_STREAM_ACK_INTERVAL_MS,
  OP_STREAM_DEFAULT_WINDOW_BYTES,
  OP_STREAM_RECONNECT_HOLD_MS,
  OP_STREAM_SILENCE_TIMEOUT_MS,
  type OpStreamExecOutcome,
  type OpStreamJournal,
} from "./selfhosted/op-stream";
// The durable op-id correlation seam (B1): the runtime barrel BINDS it around
// the SDK shell tool; the sandbox leaf READS it when minting op ids.
export { nextDurableOpId, runWithToolCallCorrelation, sanitizeOpIdToken } from "./op-correlation";
export {
  negotiateSelfhostedCapabilities,
  selfhostedLiveness,
  SELFHOSTED_RECONNECT_WINDOW_MS,
  type SelfhostedNegotiationInput,
  type SelfhostedLivenessState,
  type SelfhostedEnrollment,
} from "./selfhosted/capabilities";
export {
  MockAgentResponder,
  type MockAgentResponderOptions,
  type MockExecHandler,
} from "./selfhosted/testing";

// The hot-swap routing proxy (M7): ONE stable session-shaped object the SDK binds
// to, which re-reads the per-session active pointer per op and dispatches to the
// currently-active backend (Modal or selfhosted) — flippable mid-turn, single
// active at a time, fence-retrying on a swap race.
export {
  RoutingBackendRecoveryRequiredError,
  RoutingMutationOutcomeUnknownError,
  RoutingRetainedProcessNotFoundError,
  RoutingSandboxSession,
  RoutingUnsupportedError,
  type ActivePointer,
  type DefaultBackendLossResult,
  type RoutableBackendSession,
  type ResolvedActiveBackend,
  type RoutingMutationSettlementResult,
  type RoutingSandboxOperationObservation,
  type RoutingSandboxOperationObserver,
  type RoutingRetainedProcess,
  type RoutingRetainedProcessAdoption,
  type RoutingRetainedProcessTerminalProof,
  type RoutingSandboxSessionDeps,
  type RoutingTransitionEvent,
} from "./routing/routing-session";
export {
  makeActiveBackendResolver,
  ActiveBackendUnresolvableError,
  swapTargetEstablishability,
  type ActiveBackendResolverDeps,
  type RoutableSandbox,
  type BackendUnresolvableCode,
  type SwapTargetEstablishability,
} from "./routing/backend-resolver";

/**
 * Construct the raw provider SandboxClient for the configured backend. Registry-
 * driven (the old flat if/else is gone): the backend's ProviderRegistration owns
 * validateCredentials + build, with per-provider units/field-names. Returns
 * undefined for "none".
 *
 * The desktop stream port (6080) is merged into exposedPorts for every desktop-
 * capable (backend, os) when desktop is enabled AND the provider cannot expose
 * ports on demand (modal/runloop/e2b pre-declare; blaxel resolves on demand).
 * Existing modal/docker/local construction is behavior-preserved.
 */
export function createSandboxClient(
  settings: Settings,
  environment = collectSandboxEnvironment(settings),
): unknown {
  return createSandboxClientForBackend(
    settings.sandboxBackend as SandboxBackend,
    settings,
    environment,
  );
}

/**
 * Construct the raw provider SandboxClient for an EXPLICIT backend, independent
 * of settings.sandboxBackend. This is the resume-by-id builder the per-turn
 * resume path (and the API-direct control plane) call: a lease's box was created
 * on a specific backend (the envelope's backendId / the lease's
 * resume_backend_id), and the client that reattaches to it must be built for
 * THAT backend, not the process's currently-configured default. When the backend
 * equals settings.sandboxBackend this is identical to createSandboxClient
 * (behavior-preserved). Returns undefined for "none".
 */
export function createSandboxClientForBackend(
  backend: SandboxBackend,
  settings: Settings,
  environment = collectSandboxEnvironment(settings),
): unknown {
  const registration = PROVIDER_REGISTRY[backend];
  if (!registration) {
    throw new SandboxConfigError(backend, `Unknown sandbox backend "${backend}"`);
  }
  if (registration.backend === "none") {
    return undefined;
  }
  registration.validateCredentials(settings); // fail-fast, typed

  const exposedPorts = parseExposedPorts(settings.dockerExposedPorts);
  // 6080 port-merge: a desktop-capable backend that pre-declares ports (not
  // on-demand) must carry the desktop port at construction so resolveExposedPort
  // (6080) succeeds later. runloop is included (it is desktop-capable but NOT
  // on-demand → must pre-declare). blaxel is on-demand → skipped here.
  const desktop = registration.descriptor.capabilities.DesktopStream;
  if (
    desktop.available &&
    settings.sandboxDesktopEnabled &&
    !registration.descriptor.portExposure.supportsOnDemandPorts &&
    !exposedPorts.includes(DESKTOP_STREAM_PORT)
  ) {
    exposedPorts.push(DESKTOP_STREAM_PORT);
  }
  // 7681 port-merge: the REAL PTY terminal (ttyd) rides the SAME tunnel as the
  // desktop, so a desktop-capable pre-declared-port backend must ALSO carry 7681
  // at construction for resolveExposedPort(7681) to succeed later on a fresh box.
  // Same condition as the 6080 merge (a desktop-capable image bakes ttyd too).
  if (
    desktop.available &&
    settings.sandboxTerminalEnabled &&
    !registration.descriptor.portExposure.supportsOnDemandPorts &&
    !exposedPorts.includes(TERMINAL_STREAM_PORT)
  ) {
    exposedPorts.push(TERMINAL_STREAM_PORT);
  }

  const raw = withProviderExactResumeContract(
    registration,
    registration.build({ settings, environment, exposedPorts }),
  );
  // Docker network decoration stays backend-specific (only docker).
  return registration.backend === "docker"
    ? withDockerNetwork(raw as SandboxClient, settings.dockerNetwork)
    : raw;
}

function withProviderExactResumeContract(
  registration: ProviderRegistration,
  raw: unknown,
): unknown {
  if (!raw || typeof raw !== "object") {
    throw new SandboxConfigError(
      registration.backend,
      `Sandbox backend "${registration.backend}" returned no client`,
    );
  }
  const client = raw as {
    resume?: (state: unknown, options?: unknown) => Promise<unknown>;
    resumeExact?: (state: unknown) => Promise<unknown>;
  };
  if (typeof client.resume !== "function") {
    throw new SandboxConfigError(
      registration.backend,
      `Sandbox backend "${registration.backend}" does not support resume()`,
    );
  }
  if (registration.exactResumeMode === "custom") {
    if (typeof client.resumeExact !== "function") {
      throw new SandboxConfigError(
        registration.backend,
        `Sandbox backend "${registration.backend}" has no non-replacing resumeExact()`,
      );
    }
    return client;
  }
  if (registration.exactResumeMode !== "ordinary") {
    throw new SandboxConfigError(
      registration.backend,
      `Sandbox backend "${registration.backend}" has an invalid exact-resume contract`,
    );
  }
  const resume = client.resume;
  Object.defineProperty(client, "resumeExact", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: async (state: unknown) => await resume.call(client, state),
  });
  return client;
}

function withDockerNetwork(client: SandboxClient, network: string | undefined): SandboxClient {
  const trimmed = network?.trim();
  if (!trimmed) {
    return client;
  }
  const exactResume = (
    client as SandboxClient & {
      resumeExact?: (state: SandboxSessionState) => Promise<SandboxSessionLike>;
    }
  ).resumeExact;
  const wrapSession = async <T extends SandboxSessionLike>(session: T): Promise<T> => {
    const containerId = (session as { state?: { containerId?: unknown } }).state?.containerId;
    if (typeof containerId === "string" && containerId.length > 0) {
      await connectDockerNetwork(trimmed, containerId);
    }
    return session;
  };
  return {
    backendId: client.backendId,
    ...(client.supportsDefaultOptions !== undefined
      ? { supportsDefaultOptions: client.supportsDefaultOptions }
      : {}),
    ...(client.create
      ? {
          create: async (...args: any[]) =>
            await wrapSession(await (client.create as any)(...args)),
        }
      : {}),
    ...(client.resume
      ? {
          resume: async (state: SandboxSessionState) =>
            await wrapSession(await client.resume!(state)),
        }
      : {}),
    ...(exactResume
      ? {
          // Docker's ordinary SDK resume creates a replacement when the exact
          // container is absent. Preserve OpenGeni's non-replacing attach path
          // through the network decorator; dropping it would turn an exact
          // recovery probe into a provider mutation.
          resumeExact: async (state: SandboxSessionState) =>
            await wrapSession(await exactResume.call(client, state)),
        }
      : {}),
    ...(client.delete
      ? {
          delete: async (state: SandboxSessionState) => await client.delete!(state),
        }
      : {}),
    ...(client.serializeSessionState
      ? {
          serializeSessionState: async (state: SandboxSessionState, options) =>
            await client.serializeSessionState!(state, options),
        }
      : {}),
    ...(client.canPersistOwnedSessionState
      ? {
          canPersistOwnedSessionState: async (state: SandboxSessionState) =>
            await client.canPersistOwnedSessionState!(state),
        }
      : {}),
    ...(client.canReusePreservedOwnedSession
      ? {
          canReusePreservedOwnedSession: async (state: SandboxSessionState) =>
            await client.canReusePreservedOwnedSession!(state),
        }
      : {}),
    ...(client.deserializeSessionState
      ? {
          deserializeSessionState: async (state: Record<string, unknown>) =>
            await client.deserializeSessionState!(state),
        }
      : {}),
  };
}

async function connectDockerNetwork(network: string, containerId: string): Promise<void> {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("docker", ["network", "connect", network, containerId], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  const stderr = result.stderr ?? result.error?.message ?? "";
  if (stderr.includes("already exists")) {
    return;
  }
  throw new Error(
    `Failed to connect Docker sandbox container to network ${network}: ${stderr.trim()}`,
  );
}

/**
 * Extract the sandbox recovery entry from a run state as a plain JSON record,
 * for storage decoupled from the RunState blob (issue #35). Encapsulates the
 * underscore-internal `_sandbox` read in exactly one place.
 */
export function sandboxStateEntryFromRunState(state: unknown): Record<string, unknown> | null {
  const sandboxState = (state as any)?._sandbox;
  if (!sandboxState) {
    return null;
  }
  const entry =
    sandboxState.sessionsByAgent?.[sandboxState.currentAgentKey] ??
    (sandboxState.currentAgentKey && sandboxState.sessionState
      ? {
          backendId: sandboxState.backendId,
          currentAgentKey: sandboxState.currentAgentKey,
          currentAgentName: sandboxState.currentAgentName,
          sessionState: sandboxState.sessionState,
        }
      : null);
  if (!entry || !entry.sessionState) {
    return null;
  }
  return normalizeProtocolJsonValue(
    sandboxEntryForPersistence(entry as Record<string, unknown>),
    '$["sandboxSessionEnvelope"]',
  ) as Record<string, unknown>;
}

/**
 * The Agents SDK session envelope carries its canonical serialized manifest at
 * `sessionState.manifest`. Some provider serializers also repeat a hydrated
 * `Manifest` instance at `sessionState.providerState.manifest`; the SDK restore
 * path always overlays the canonical outer value, so the duplicate is neither
 * read nor JSON-protocol-safe. Remove only that known redundant field before the
 * envelope crosses OpenGeni's durable canonical-JSON boundary.
 */
function sandboxEntryForPersistence(entry: Record<string, unknown>): Record<string, unknown> {
  const sessionState = entry.sessionState;
  if (!isObjectRecord(sessionState) || !Object.hasOwn(sessionState, "manifest")) {
    return entry;
  }
  const providerState = sessionState.providerState;
  if (!isObjectRecord(providerState) || !Object.hasOwn(providerState, "manifest")) {
    return entry;
  }
  const { manifest: _redundantManifest, ...canonicalProviderState } = providerState;
  return {
    ...entry,
    sessionState: {
      ...sessionState,
      providerState: canonicalProviderState,
    },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerStateWithoutDuplicateManifest(value: object): Record<string, unknown> {
  const { manifest: _manifest, ...providerState } = value as Record<string, unknown>;
  return providerState;
}

function serializeSdkManifestForEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return value;
  return serializeManifestRecord(value as Manifest);
}

/**
 * Items-mode counterpart of restoredSandboxSessionState: rebuild the live
 * sandbox session state from a stored entry (as produced by
 * sandboxStateEntryFromRunState) instead of from a RunState blob.
 */
export async function restoredSandboxSessionStateFromEntry(
  entry: Record<string, unknown>,
  client: unknown,
): Promise<SandboxSessionState | undefined> {
  if (!client || !entry || typeof entry !== "object" || !("sessionState" in entry)) {
    return undefined;
  }
  if (entry.backendId && (client as SandboxClient).backendId !== entry.backendId) {
    throw new Error("Stored sandbox envelope backend does not match the configured sandbox client");
  }
  return await deserializeSandboxSessionStateEnvelope(client as SandboxClient, entry.sessionState);
}

/**
 * Read the persisted /workspace snapshot archive off a lease envelope's
 * `sessionState` (sandbox-file-persistence). The reaper (persistDrainSnapshot)
 * folds the base64 archive — a Modal native snapshot-ref or a tar archive, the
 * exact bytes `session.persistWorkspace()` returned — at
 * `sessionState.workspaceArchive`. Cold-restore decodes it and replays it via
 * `session.hydrateWorkspace(archive)` on the freshly-created box so /workspace is
 * restored. Returns undefined when the envelope carries no archive (a box that
 * was never drain-persisted, or a non-persistence config that stored none).
 *
 * It is deliberately read SEPARATELY from deserializeSandboxSessionStateEnvelope:
 * the archive does NOT ride serializeSessionState (it originates at reaper time),
 * and the SDK's deserializeSessionState must NOT receive it (it is an opaque
 * runtime-level field, not provider state).
 */
export function readWorkspaceArchiveFromEnvelopeSessionState(
  sessionState: unknown,
): Uint8Array | undefined {
  if (!sessionState || typeof sessionState !== "object") {
    return undefined;
  }
  const b64 = (sessionState as { workspaceArchive?: unknown }).workspaceArchive;
  if (typeof b64 !== "string" || b64.length === 0) {
    return undefined;
  }
  try {
    return Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return undefined;
  }
}

/** Decode the Modal snapshot id out of a persisted base64 archive ref, or
 *  undefined when the archive is a tar payload or is unparseable. */
export function decodeModalSnapshotId(archive: Uint8Array): string | undefined {
  const ref = decodeNativeSnapshotRef(archive);
  return ref?.provider === "modal_snapshot_filesystem" ||
    ref?.provider === "modal_snapshot_directory"
    ? ref.snapshotId
    : undefined;
}

export async function deserializeSandboxSessionStateEnvelope(
  client: SandboxClient,
  envelope: unknown,
  expectedInstanceId?: string,
): Promise<SandboxSessionState | undefined> {
  if (!envelope || typeof envelope !== "object") {
    return undefined;
  }
  if (!client.deserializeSessionState) {
    throw new Error(
      "Sandbox client must implement deserializeSessionState() to resume RunState sandbox state",
    );
  }
  const state = envelope as {
    providerState?: Record<string, unknown>;
    manifest?: unknown;
    snapshot?: unknown;
    snapshotFingerprint?: unknown;
    snapshotFingerprintVersion?: unknown;
    workspaceReady?: unknown;
    exposedPorts?: unknown;
  };
  const providerState = { ...(state.providerState ?? {}) };
  if (expectedInstanceId) {
    const backend = sandboxBackendForSdkBackendId(client.backendId) ?? client.backendId;
    const observedInstanceId = liveProviderInstanceIdFromState(backend, providerState);
    if (observedInstanceId && observedInstanceId !== expectedInstanceId) {
      throw new SandboxResumeIdentityMismatchError(backend, expectedInstanceId, observedInstanceId);
    }
    if (!observedInstanceId) {
      const instanceIdField = PROVIDER_REGISTRY[backend as SandboxBackend]?.instanceIdFields[0];
      if (instanceIdField) {
        // New envelopes persist one provider-neutral OpenGeni identity. SDK
        // deserializers still require their legacy provider-specific address,
        // so materialize it into a cloned payload at this adapter boundary.
        // The live resumed handle is independently identity-checked before use.
        providerState[instanceIdField] = expectedInstanceId;
      }
    }
  }
  const exposedPorts = runStateExposedPortsRecord(state.exposedPorts);
  if (state.exposedPorts !== undefined && exposedPorts === undefined) {
    console.warn("[sandbox] ignored incompatible RunState exposedPorts", {
      provider: runStateCompatibilityProvider(client.backendId),
      sessionClass: "root",
      path: "sessionState.exposedPorts",
    });
  }
  return await client.deserializeSessionState({
    ...providerState,
    manifest: state.manifest,
    ...(state.snapshot !== undefined ? { snapshot: state.snapshot } : {}),
    ...(state.snapshotFingerprint !== undefined
      ? { snapshotFingerprint: state.snapshotFingerprint }
      : {}),
    ...(state.snapshotFingerprintVersion !== undefined
      ? { snapshotFingerprintVersion: state.snapshotFingerprintVersion }
      : {}),
    workspaceReady: state.workspaceReady,
    ...(exposedPorts !== undefined ? { exposedPorts } : {}),
  });
}

// ============================================================================
// The ONE resume / recovery primitive (P1.2).
//
// establishSandboxSessionFromEnvelope is the single re-establish-from-envelope
// path the stateless model leans on. Creation authority is explicit:
//
//   - `create-or-restore` is reserved for the caller that won the durable
//     cold->warming lease transition. It may create a cold box, or replace a
//     resumable box that the provider proves is gone.
//   - `resume-only` is for attached turns and API-direct operations. It may
//     resume the leased box by id, but a provider NotFound propagates to the
//     caller so the lease can be atomically marked cold. It NEVER creates.
//
// This ownership boundary is the double-spawn guard. A provider NotFound alone
// is not creation authority: many attached callers can observe the same dead id
// concurrently, while only one caller may own cold->warming.
// ============================================================================

/** A live, externally-owned sandbox session re-established from the group lease
 *  envelope. The caller injects `{client, session, sessionState}` NON-OWNED into
 *  the run (or drives session.exec/readFile/resolveExposedPort directly) and
 *  drops the handle when done — the lease, not this handle, owns the box. */
export type EstablishedSandboxSession = {
  client: unknown;
  session: unknown;
  sessionState: unknown;
  instanceId: string;
  backendId: string;
  /** How this establish reached a live box: warm reattach by id ("resumed"),
   *  fresh create ("created"), or fresh create + archive hydration
   *  ("restored"). Callers use it to emit the durable sandbox.box.* lifecycle
   *  events — box transitions were previously unrecorded, which made both
   *  2026-07-06 incidents near-unattributable. Optional so external/legacy
   *  constructors of this shape stay valid. */
  origin?: "resumed" | "created" | "restored";
  /** Set when a create-authorized reattach found the envelope's box GONE
   *  (provider NotFound) and fell through to cold-restore. */
  lostInstanceId?: string;
  /** Durable authorization used when an elected recovery owner adopted a new
   * execution wrapper over the same provider-owned workspace. Unpublished
   * failure cleanup must preserve that workspace for the next recovery owner. */
  providerContinuity?: SandboxProviderContinuityRecovery;
  /** Exact durable archive revision verified byte-for-byte after hydration. */
  restoredArchive?: WorkspaceArchiveDescriptor;
};

/**
 * Terminate an SDK-managed provider session through the declared sandbox
 * lifecycle surface. The reaper must never guess non-standard `kill` or
 * `terminate` method names: every supported SDK provider exposes one of these
 * standard operations, while provider-specific by-id rescue stays in its
 * adapter.
 */
export async function terminateManagedSandboxSession(
  client: unknown,
  sessionState: unknown,
  session: unknown,
): Promise<void> {
  const lifecycleClient = client as {
    backendId?: unknown;
    delete?: (state: never) => Promise<void>;
  };
  const lifecycleSession = session as Partial<SandboxSessionLike>;
  const options = { reason: "cleanup" };
  let firstError: unknown;
  const attempt = async (operation: (() => Promise<void>) | undefined): Promise<void> => {
    if (!operation) return;
    try {
      await operation();
    } catch (error) {
      firstError ??= error;
    }
  };
  const runPreStopHooks =
    typeof lifecycleSession.runPreStopHooks === "function"
      ? lifecycleSession.runPreStopHooks.bind(lifecycleSession)
      : undefined;
  const preStop =
    typeof lifecycleSession.preStop === "function"
      ? lifecycleSession.preStop.bind(lifecycleSession)
      : undefined;
  const stop =
    typeof lifecycleSession.stop === "function"
      ? lifecycleSession.stop.bind(lifecycleSession)
      : undefined;
  const shutdown =
    typeof lifecycleSession.shutdown === "function"
      ? lifecycleSession.shutdown.bind(lifecycleSession)
      : undefined;
  const deleteSession =
    typeof lifecycleSession.delete === "function"
      ? lifecycleSession.delete.bind(lifecycleSession)
      : undefined;
  const close =
    typeof lifecycleSession.close === "function"
      ? lifecycleSession.close.bind(lifecycleSession)
      : undefined;

  // Mirror the Agents SDK's provider-neutral cleanupSandboxSession contract.
  // 0.13.3 does not publicly export that helper, so this agent-loop-free leaf
  // keeps the same small sequence locally. Prefer the live session lifecycle:
  // it owns registered pre-stop hooks and provider cleanup semantics. The
  // state-only client.delete contract is a fallback when no session teardown
  // operation exists.
  await attempt(runPreStopHooks);
  await attempt(preStop ? async () => await preStop(options) : undefined);
  await attempt(stop ? async () => await stop(options) : undefined);
  await attempt(shutdown ? async () => await shutdown(options) : undefined);
  await attempt(deleteSession ? async () => await deleteSession(options) : undefined);
  const hasProviderTeardown = Boolean(stop || shutdown || deleteSession);
  if (!hasProviderTeardown && close) {
    await attempt(close);
  } else if (
    !hasProviderTeardown &&
    !close &&
    typeof lifecycleClient.delete === "function" &&
    sessionState !== undefined &&
    sessionState !== null
  ) {
    await attempt(async () => await lifecycleClient.delete!(sessionState as never));
  }
  if (firstError) throw firstError;
  if (
    hasProviderTeardown ||
    close ||
    (typeof lifecycleClient.delete === "function" &&
      sessionState !== undefined &&
      sessionState !== null)
  ) {
    return;
  }

  const backendId =
    typeof lifecycleClient.backendId === "string" ? lifecycleClient.backendId : "unknown";
  throw new Error(`Sandbox backend ${backendId} exposes no teardown lifecycle operation`);
}

export class SandboxExecReadinessError extends Error {
  readonly name = "SandboxExecReadinessError";

  constructor(
    public readonly backend: string,
    public readonly code: "exec_probe_unavailable" | "exec_probe_timeout" | "exec_probe_failed",
    public readonly timeoutMs: number,
    public readonly exitCode: number | null = null,
  ) {
    super(
      code === "exec_probe_timeout"
        ? `sandbox creation timed out waiting for ${backend} command readiness after ${timeoutMs}ms`
        : code === "exec_probe_unavailable"
          ? `${backend} sandbox session does not expose an exec readiness probe`
          : exitCode === null
            ? `${backend} sandbox exec readiness probe did not return a command exit code`
            : `${backend} sandbox exec readiness probe failed with exit code ${exitCode}`,
    );
  }
}

function sandboxExecProbeExitCode(result: unknown): number | null {
  if (typeof result === "string") {
    const match = result.match(/Process exited with code (-?\d+)/);
    return match ? Number(match[1]) : null;
  }
  if (!result || typeof result !== "object") return null;
  const candidate = result as {
    exitCode?: unknown;
    exit_code?: unknown;
    code?: unknown;
    status?: unknown;
  };
  for (const value of [candidate.exitCode, candidate.exit_code, candidate.code, candidate.status]) {
    if (typeof value === "number") return value;
  }
  return null;
}

function sandboxExecProbeStillRunning(result: unknown): boolean {
  if (typeof result === "string") return /Process running with session ID \d+/u.test(result);
  if (!result || typeof result !== "object") return false;
  const candidate = result as { sessionId?: unknown; session_id?: unknown };
  return typeof candidate.sessionId === "number" || typeof candidate.session_id === "number";
}

/** A provider handle is not workspace readiness. Modal can return a handle
 * before its command router accepts exec, so every create path must pass this
 * bounded probe before atomically publishing the lease warm/ready. */
export async function verifySandboxExecReadiness(
  established: EstablishedSandboxSession,
  timeoutMs = 15_000,
): Promise<void> {
  if (established.backendId !== "modal") return;
  const session = established.session as {
    exec?: (args: {
      cmd: string;
      yieldTimeMs?: number;
      maxOutputTokens?: number;
    }) => Promise<unknown>;
    execCommand?: (args: {
      cmd: string;
      yieldTimeMs?: number;
      maxOutputTokens?: number;
    }) => Promise<unknown>;
  };
  const run = session.exec ?? session.execCommand;
  if (!run) {
    throw new SandboxExecReadinessError(established.backendId, "exec_probe_unavailable", timeoutMs);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run.call(session, {
        cmd: "true",
        yieldTimeMs: 1_000,
        maxOutputTokens: 1_000,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SandboxExecReadinessError(established.backendId, "exec_probe_timeout", timeoutMs),
            ),
          timeoutMs,
        );
        if (timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
      }),
    ]);
    const exitCode = sandboxExecProbeExitCode(result);
    if (sandboxExecProbeStillRunning(result) || exitCode !== 0) {
      throw new SandboxExecReadinessError(
        established.backendId,
        "exec_probe_failed",
        timeoutMs,
        exitCode,
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type SandboxCreatedCallback = (established: EstablishedSandboxSession) => Promise<void>;

// The structural slice we need from a provider SandboxClient to resume by id and
// cold-restore. Narrowed (not the full agent-loop SandboxClient) so the leaf
// stays agent-loop-free.
type ResumeCapableClient = {
  backendId: string;
  deserializeSessionState?: (state: Record<string, unknown>) => Promise<unknown>;
  resume?: (state: unknown, options?: unknown) => Promise<unknown>;
  /** OpenGeni extension implemented by providers whose ordinary SDK resume may
   * create a replacement. This method must either return the addressed wrapper
   * or prove it unavailable without creating anything. */
  resumeExact?: (state: unknown) => Promise<unknown>;
  create?: (manifest?: unknown, options?: unknown) => Promise<unknown>;
};

/**
 * Per-provider NotFound discriminator. The @openai/agents-extensions
 * `isProviderSandboxNotFoundError` / `assertResumeRecreateAllowed` helpers live
 * under `@openai/agents-extensions/sandbox/shared`, which is NOT an exported
 * subpath (the package `exports` map only exposes `./sandbox/<provider>`), so we
 * re-implement the discrimination here by inspecting the thrown error shape.
 *
 * "Box no longer running" (the box was reaped / idled out / 24h-ceiling) is the
 * ONLY error that licenses a cold-restore via create(). Every other resume
 * failure (transient provider error, auth, network) must propagate so the caller
 * backs off — never spawns a rival box. We err on the side of NOT recreating:
 * an unrecognized error is treated as "not NotFound" (propagate), because a
 * false-positive recreate is the dangerous direction (double-spawn).
 */
function liveProviderInstanceIdFromState(
  backend: SandboxBackend | string,
  state: unknown,
): string | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const registration = PROVIDER_REGISTRY[backend as SandboxBackend];
  if (!registration || registration.backend !== backend) return null;
  const record = state as Record<string, unknown>;
  for (const field of registration.instanceIdFields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function legacySandboxProviderInstanceIdFromEnvelope(
  envelope: Record<string, unknown> | null | undefined,
  backend?: SandboxBackend | string,
): string | null {
  const sessionState =
    envelope?.sessionState && typeof envelope.sessionState === "object"
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  const providerState =
    sessionState?.providerState && typeof sessionState.providerState === "object"
      ? sessionState.providerState
      : envelope?.providerState;
  const envelopeBackendId =
    typeof envelope?.backendId === "string" && envelope.backendId.length > 0
      ? envelope.backendId
      : null;
  const resolvedBackend =
    backend ??
    (envelopeBackendId
      ? (sandboxBackendForSdkBackendId(envelopeBackendId) ?? envelopeBackendId)
      : null);
  return resolvedBackend ? liveProviderInstanceIdFromState(resolvedBackend, providerState) : null;
}

/** Resolve the stable OpenGeni identity first, then legacy SDK provider keys.
 * The fallback is compatibility-only: new envelopes always persist the stable
 * top-level identity, so downstream lease/reaper code remains provider-neutral. */
export function sandboxProviderInstanceIdFromEnvelope(
  envelope: Record<string, unknown> | null | undefined,
  backend?: SandboxBackend | string,
): string | null {
  const declared = envelope?.[OPENGENI_SANDBOX_PROVIDER_INSTANCE_ID_FIELD];
  if (typeof declared === "string" && declared.length > 0) return declared;
  return legacySandboxProviderInstanceIdFromEnvelope(envelope, backend);
}

/** Validate rolling-format envelopes before addressing a provider. The stable
 * OpenGeni identity is authoritative, but a disagreeing legacy SDK address is
 * corruption/staleness—not evidence that the provider disappeared. */
export function assertConsistentSandboxProviderIdentity(
  backend: SandboxBackend | string,
  envelope: Record<string, unknown> | null | undefined,
): string | null {
  const declared = envelope?.[OPENGENI_SANDBOX_PROVIDER_INSTANCE_ID_FIELD];
  const stable = typeof declared === "string" && declared.length > 0 ? declared : null;
  const legacy = legacySandboxProviderInstanceIdFromEnvelope(envelope, backend);
  if (stable && legacy && stable !== legacy) {
    throw new SandboxResumeIdentityMismatchError(backend, stable, legacy);
  }
  return stable ?? legacy;
}

function exactResumeStateForBackend(backend: string, state: unknown): unknown {
  if (backend !== "vercel" || !state || typeof state !== "object" || Array.isArray(state)) {
    return state;
  }
  // Vercel's ordinary resume intentionally creates a replacement whenever the
  // serialized state carries a fresh snapshot. Exact attach/reaper recovery
  // must address sandboxId instead; clearing only this freshness marker makes
  // the SDK use Sandbox.get while retaining the snapshot as recovery data.
  const exactState = { ...(state as Record<string, unknown>) };
  delete exactState.snapshotSandboxId;
  return exactState;
}

function providerContinuityRegistration(backend: SandboxBackend | string) {
  const registration = PROVIDER_REGISTRY[backend as SandboxBackend];
  return registration?.backend === backend ? registration.continuity : undefined;
}

export function sandboxProviderContinuityForState(
  backend: SandboxBackend | string,
  state: unknown,
  sourceInstanceId: string,
): SandboxProviderContinuityRecovery | null {
  const continuity = providerContinuityRegistration(backend);
  const continuityKey = continuity?.keyFromState(state) ?? null;
  if (!continuity || !continuityKey || sourceInstanceId.length === 0) return null;
  return {
    version: 1,
    backend: backend as SandboxBackend,
    kind: continuity.kind,
    sourceInstanceId,
    continuityKey,
  };
}

function parsedEnvelopeContinuity(
  backend: SandboxBackend | string,
  envelope: Record<string, unknown> | null,
  state: unknown,
  expectedInstanceId: string,
): SandboxProviderContinuityRecovery | null {
  const recovery =
    envelope?.opengeniRecovery && typeof envelope.opengeniRecovery === "object"
      ? (envelope.opengeniRecovery as { continuity?: unknown })
      : null;
  const value = recovery?.continuity;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SandboxProviderContinuityRecovery>;
  const derived = sandboxProviderContinuityForState(backend, state, expectedInstanceId);
  return derived &&
    candidate.version === derived.version &&
    candidate.backend === derived.backend &&
    candidate.kind === derived.kind &&
    candidate.sourceInstanceId === derived.sourceInstanceId &&
    candidate.continuityKey === derived.continuityKey
    ? derived
    : null;
}

function continuityMatchesState(
  receipt: SandboxProviderContinuityRecovery,
  state: unknown,
): boolean {
  const continuity = providerContinuityRegistration(receipt.backend);
  return (
    continuity?.kind === receipt.kind && continuity.keyFromState(state) === receipt.continuityKey
  );
}

function preserveContinuityWorkspaceForDiscard(
  backend: SandboxBackend | string,
  requestedState: unknown,
  session: unknown,
  sessionState: unknown,
): boolean {
  const continuity = providerContinuityRegistration(backend);
  if (!continuity) return false;
  const requestedKey = continuity.keyFromState(requestedState);
  const replacementKey = continuity.keyFromState(sessionState);
  if (!requestedKey || requestedKey !== replacementKey) return false;
  continuity.preserveWorkspaceForDiscard(session, sessionState);
  return true;
}

export async function resumeExactSandboxSession(
  clientInput: unknown,
  backend: SandboxBackend | string,
  state: unknown,
  expectedInstanceId: string,
  options?: { continuity?: SandboxProviderContinuityRecovery },
): Promise<{
  session: unknown;
  sessionState: unknown;
  instanceId: string;
  providerContinuity?: SandboxProviderContinuityRecovery;
}> {
  const client = clientInput as ResumeCapableClient;
  if (!client.resume) {
    throw new SandboxConfigError(backend, `Sandbox backend "${backend}" does not support resume()`);
  }
  const exactState = exactResumeStateForBackend(client.backendId, state);
  const continuity = options?.continuity;
  if (
    continuity &&
    (continuity.backend !== backend ||
      continuity.sourceInstanceId !== expectedInstanceId ||
      !continuityMatchesState(continuity, exactState))
  ) {
    throw new SandboxResumeIdentityMismatchError(
      backend,
      expectedInstanceId,
      continuity.sourceInstanceId,
    );
  }
  if (!continuity && !client.resumeExact) {
    throw new SandboxConfigError(
      backend,
      `Sandbox backend "${backend}" has no non-replacing resumeExact()`,
    );
  }
  // A durable continuity receipt is creation authority owned by either the
  // unique cold->warming winner or a durable teardown claim. Ordinary attached
  // callers use resumeExact so an SDK cannot silently create a rival wrapper.
  const session = continuity
    ? await client.resume(exactState)
    : await client.resumeExact!(exactState);
  const actualInstanceId = readInstanceId(backend, session);
  if (!actualInstanceId) {
    // Do not tear down an unidentifiable handle: it may be the requested live
    // provider. The adapter must expose a stable identity before OpenGeni can
    // safely command, publish, snapshot, or delete it.
    throw new SandboxResumeIdentityUnavailableError(backend, expectedInstanceId);
  }
  if (actualInstanceId !== expectedInstanceId) {
    const replacementState = (session as { state?: unknown }).state ?? exactState;
    if (continuity && continuityMatchesState(continuity, replacementState)) {
      return {
        session,
        sessionState: replacementState,
        instanceId: actualInstanceId,
        providerContinuity: continuity,
      };
    }
    // A provider may race from running to absent between an exact preflight and
    // its SDK resume. If that produced a same-workspace wrapper, discard only
    // the wrapper; deleting the shared workspace would destroy recovery truth.
    preserveContinuityWorkspaceForDiscard(backend, exactState, session, replacementState);
    try {
      await terminateManagedSandboxSession(client, replacementState, session);
    } catch (cleanupError) {
      throw new SandboxResumeIdentityMismatchError(backend, expectedInstanceId, actualInstanceId, {
        cause: cleanupError,
      });
    }
    throw new SandboxExactResumeReplacedError(backend, expectedInstanceId, actualInstanceId);
  }
  return {
    session,
    sessionState: (session as { state?: unknown }).state ?? exactState,
    instanceId: actualInstanceId,
    ...(continuity ? { providerContinuity: continuity } : {}),
  };
}

/** Terminate a provider handle that never became durable warm ownership. A
 * continuity-adopted Docker wrapper is removed while its durable host
 * workspace remains available to the next elected recovery owner. */
export async function terminateUnpublishedSandboxSession(
  established: EstablishedSandboxSession,
): Promise<void> {
  if (established.providerContinuity) {
    const continuity = providerContinuityRegistration(established.providerContinuity.backend);
    if (
      continuity?.kind === established.providerContinuity.kind &&
      continuity.keyFromState(established.sessionState) ===
        established.providerContinuity.continuityKey
    ) {
      continuity.preserveWorkspaceForDiscard(established.session, established.sessionState);
    }
  }
  await terminateManagedSandboxSession(
    established.client,
    established.sessionState,
    established.session,
  );
}

/** Remove every live-provider address while retaining backend-independent
 * archive/config state for a safe cold rematerialization. */
export function withoutSandboxProviderIdentity(
  envelope: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!envelope) return null;
  const providerIndependentEnvelope = { ...envelope };
  delete providerIndependentEnvelope[OPENGENI_SANDBOX_PROVIDER_INSTANCE_ID_FIELD];
  // Some rolling/legacy envelopes contain both a top-level providerState and
  // the newer nested sessionState. Strip both representations; retaining the
  // top-level fallback would make the compatibility reader rediscover a dead
  // provider after we deliberately converted the envelope to archive-only.
  delete providerIndependentEnvelope.providerState;
  const sessionState =
    envelope.sessionState && typeof envelope.sessionState === "object"
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  if (!sessionState) {
    return providerIndependentEnvelope;
  }
  const { providerState: _providerState, ...providerIndependentState } = sessionState;
  return { ...providerIndependentEnvelope, sessionState: providerIndependentState };
}

function readInstanceId(backend: SandboxBackend | string, session: unknown): string {
  return liveProviderInstanceIdFromState(backend, (session as { state?: unknown }).state) ?? "";
}

async function terminateCreatedSandbox(
  client: ResumeCapableClient,
  session: unknown,
  sessionState: unknown,
): Promise<void> {
  try {
    await terminateManagedSandboxSession(client, sessionState, session);
  } catch {
    /* best-effort */
  }
}

/**
 * Establish from one recovery envelope under an explicit creation policy. The
 * envelope is the lease's box-identity descriptor (the same per-turn `_sandbox`
 * envelope upserted by the turn activity).
 *
 *  - `opts.backendOverride ?? envelope.backendId ?? settings.sandboxBackend`
 *    selects the backend; the client is built for THAT backend (resume-by-id is
 *    fenced to the original provider).
 *  - warm reattach: deserialize the envelope sessionState → client.resume(state)
 *    (no lock; R4-safe). `resume-only` propagates provider NotFound.
 *  - `create-or-restore`: the elected owner may replace a missing warm instance,
 *    or create directly from a cold/null envelope.
 */
export async function establishSandboxSessionFromEnvelope(
  settings: Settings,
  envelope: Record<string, unknown> | null,
  opts: {
    sessionId: string;
    recovery: "create-or-restore" | "resume-only";
    backendOverride?: SandboxBackend;
    environment?: Record<string, string>;
    onSandboxCreated?: SandboxCreatedCallback;
    /** Called after archive hydration but immediately before the exact workspace
     * fingerprint probe. Lease-aware callers persist `verifying` here so a box
     * is never observable as ready while verification is in flight. */
    onWorkspaceRestoreVerifying?: (descriptor: WorkspaceArchiveDescriptor) => Promise<void>;
    metrics?: RuntimeMetricsHooks;
    /** Isolated conformance-test/embedding seam. Ordinary runtime callers use
     * the validated provider registry. */
    clientFactory?: (
      backend: SandboxBackend,
      settings: Settings,
      environment: Record<string, string>,
    ) => unknown;
  },
): Promise<EstablishedSandboxSession> {
  const envelopeBackend =
    typeof envelope?.backendId === "string" ? (envelope.backendId as SandboxBackend) : undefined;
  const backend =
    opts.backendOverride ?? envelopeBackend ?? (settings.sandboxBackend as SandboxBackend);
  const environment = opts.environment ?? collectSandboxEnvironment(settings);
  const client = (opts.clientFactory ?? createSandboxClientForBackend)(
    backend,
    settings,
    environment,
  ) as ResumeCapableClient | undefined;
  if (!client) {
    throw new SandboxConfigError(
      backend,
      `Cannot establish a sandbox session for backend "${backend}" (no client; sandboxBackend=none?)`,
    );
  }
  if (opts.recovery === "create-or-restore" && !client.create) {
    throw new SandboxConfigError(backend, `Sandbox backend "${backend}" does not support create()`);
  }

  // The manifest the box is CREATED with. Its `environment` must equal the
  // environment the agent declares for this run (buildManifest's `environment`),
  // because the SDK injects this box NON-OWNED and then applies the agent's
  // manifest as a provided-session delta — `applyManifestToProvidedSession`
  // throws on ANY environment delta (validateNoEnvironmentDelta). The client's
  // constructor `env` materializes the RUNTIME env but does NOT populate
  // `manifest.environment` (a bare create() yields `new Manifest()` with an empty
  // environment), so the manifest env must be set here explicitly. `root` is left
  // to default to "/workspace" to match buildManifest's declared root (the
  // root-delta guard). The caller threads `opts.environment` = the SAME object
  // passed to runtime.buildAgent, so current==target and the delta is empty.
  const createManifest = { environment };

  // The serialized provider state the box was last persisted as. The envelope
  // shape is the per-turn `_sandbox` entry; its `sessionState` is the provider
  // payload deserializeSandboxSessionStateEnvelope re-hydrates.
  const envelopeSessionState =
    envelope && typeof envelope === "object"
      ? (envelope as { sessionState?: unknown }).sessionState
      : undefined;

  // The persisted /workspace snapshot the reaper folded onto the lease envelope
  // (sandbox-file-persistence). Present on a re-warm whose box was drain-persisted:
  //   - WARM reattach NotFound path (box gone, full envelope still has sandboxId);
  //   - COLD lease re-warm (confirmDrainCold preserved a MINIMAL archive-only
  //     envelope `{ sessionState: { workspaceArchive } }` — NO sandboxId, so the
  //     warm-reattach branch must NOT try resume()-by-id; it cold-creates+hydrates).
  const archiveState =
    envelopeSessionState && typeof envelopeSessionState === "object"
      ? (envelopeSessionState as {
          workspaceArchive?: unknown;
          workspaceArchiveMeta?: unknown;
        })
      : undefined;
  // Exactly one selected revision is restored. A present archive without its
  // revision/hash/tree descriptor is not recoverable truth and fails before any
  // provider create. `workspaceArchivePrev` is retained for explicit future
  // operator selection, never silently substituted in this attempt.
  const workspaceArchiveBase64 = archiveState?.workspaceArchive;
  const workspaceArchiveMetadata = archiveState?.workspaceArchiveMeta;

  // create() a FRESH box, THEN replay the persisted /workspace snapshot via
  // session.hydrateWorkspace(archive) when one rode the envelope. hydrateWorkspace
  // decodes the snapshot-ref and swaps the box for one booted from the snapshot
  // image (restoreSnapshotFilesystem). No archive is valid only for a genuinely
  // new workspace; recovery callers select and verify an exact archive before
  // entering this seam. This is the SOLE archive-replay path, shared by the
  // NotFound warm-reattach path and the cold-restore branch (b) below.
  const coldRestore = async (resumeFallbackState?: unknown): Promise<EstablishedSandboxSession> => {
    // Parse/verify lazily: a warm resume-by-id does not consume its retained
    // archive, so a legacy live box remains resumable. Creation/restoration is
    // the boundary that requires complete durable metadata.
    const workspaceArchive: VerifiedWorkspaceArchive | null = readVerifiedWorkspaceArchive(
      workspaceArchiveBase64,
      workspaceArchiveMetadata,
    );
    const createStarted = Date.now();
    let restored: Awaited<ReturnType<NonNullable<typeof client.create>>>;
    try {
      restored = await client.create!({ manifest: createManifest });
      recordSandboxCreateMetric(opts.metrics, client.backendId, "completed", createStarted);
    } catch (error) {
      recordSandboxCreateMetric(opts.metrics, client.backendId, "failed", createStarted);
      throw error;
    }
    let restoredState = (restored as { state?: unknown }).state;
    const restoredInstanceId = readInstanceId(backend, restored);
    if (!restoredInstanceId) {
      await terminateCreatedSandbox(client, restored, restoredState);
      throw new SandboxConfigError(
        backend,
        `Sandbox backend "${backend}" created a handle without its declared provider identity`,
      );
    }
    let established: EstablishedSandboxSession = {
      client,
      session: restored,
      sessionState: restoredState ?? resumeFallbackState,
      instanceId: restoredInstanceId,
      backendId: client.backendId,
    };
    if (opts.onSandboxCreated) {
      try {
        await opts.onSandboxCreated(established);
      } catch (createCallbackError) {
        await terminateCreatedSandbox(client, restored, restoredState);
        throw createCallbackError;
      }
    }
    let hydrationApplied = false;
    if (workspaceArchive) {
      const hydrate = (restored as { hydrateWorkspace?: (data: Uint8Array) => Promise<void> })
        .hydrateWorkspace;
      if (typeof hydrate !== "function") {
        await terminateCreatedSandbox(client, restored, restoredState);
        throw new WorkspaceArchiveIntegrityError(
          "archive_hydration_failed",
          `sandbox backend ${client.backendId} cannot hydrate selected archive revision ${workspaceArchive.descriptor.revision}`,
        );
      }
      try {
        // hydrateWorkspace may internally replace the underlying box.
        await hydrate.call(restored, workspaceArchive.bytes);
      } catch (error) {
        await terminateCreatedSandbox(client, restored, (restored as { state?: unknown }).state);
        if (error instanceof WorkspaceArchiveIntegrityError) throw error;
        throw new WorkspaceArchiveIntegrityError(
          "archive_hydration_failed",
          `failed to hydrate selected workspace archive revision ${workspaceArchive.descriptor.revision}`,
          { retryable: true },
        );
      }
      // hydrateWorkspace may replace the provider box (Modal's native snapshot
      // restore does this). Attribute the newly-active identity immediately,
      // before restore-state marking, fingerprint verification, or any caller
      // can publish the box warm. The callback is the durable lease/tagging
      // boundary; if it cannot persist the replacement, the caller fails closed
      // and this exact replacement is terminated below.
      const hydratedState = (restored as { state?: unknown }).state;
      const hydratedInstanceId = readInstanceId(backend, restored);
      if (!hydratedInstanceId) {
        await terminateCreatedSandbox(client, restored, hydratedState);
        throw new SandboxConfigError(
          backend,
          `Sandbox backend "${backend}" hydrated a handle without its declared provider identity`,
        );
      }
      if (hydratedInstanceId !== established.instanceId) {
        established = {
          client,
          session: restored,
          sessionState: hydratedState ?? resumeFallbackState,
          instanceId: hydratedInstanceId,
          backendId: client.backendId,
        };
        if (opts.onSandboxCreated) {
          try {
            await opts.onSandboxCreated(established);
          } catch (createCallbackError) {
            await terminateCreatedSandbox(client, restored, hydratedState);
            throw createCallbackError;
          }
        }
      }
      if (opts.onWorkspaceRestoreVerifying) {
        try {
          await opts.onWorkspaceRestoreVerifying(workspaceArchive.descriptor);
        } catch (error) {
          await terminateCreatedSandbox(client, restored, (restored as { state?: unknown }).state);
          throw error;
        }
      }
      // Native provider snapshots are restored by their exact opaque receipt.
      // OpenGeni verifies receipt identity/hash before hydration, but it must not
      // impose a tar/inode equivalence contract on the provider's filesystem
      // image. Tar archives remain content-verified after hydration.
      if (workspaceArchive.kind === "tar") {
        try {
          await verifyRestoredWorkspace(restored, workspaceArchive.descriptor);
        } catch (error) {
          await terminateCreatedSandbox(client, restored, (restored as { state?: unknown }).state);
          if (error instanceof WorkspaceArchiveIntegrityError) throw error;
          throw new WorkspaceArchiveIntegrityError(
            "workspace_fingerprint_unavailable",
            `failed to verify selected workspace archive revision ${workspaceArchive.descriptor.revision}`,
            { retryable: true },
          );
        }
      }
      hydrationApplied = true;
      console.info(
        `[sandbox] cold-restore applied ${workspaceArchive.kind === "provider_snapshot" ? "native snapshot receipt" : "verified tar archive"} revision ${workspaceArchive.descriptor.revision}`,
      );
    }
    restoredState = (restored as { state?: unknown }).state;
    const finalInstanceId = readInstanceId(backend, restored);
    if (!finalInstanceId) {
      await terminateCreatedSandbox(client, restored, restoredState);
      throw new SandboxConfigError(
        backend,
        `Sandbox backend "${backend}" returned a handle without its declared provider identity`,
      );
    }
    return {
      client,
      session: restored,
      sessionState: restoredState ?? resumeFallbackState,
      instanceId: finalInstanceId,
      backendId: client.backendId,
      origin: hydrationApplied ? ("restored" as const) : ("created" as const),
      ...(workspaceArchive ? { restoredArchive: workspaceArchive.descriptor } : {}),
    };
  };

  // Does the envelope carry a RESUMABLE box id (warm reattach), or only a
  // restorable archive (cold lease)? Archive-only state is not resumable: the
  // provider's deserialize/resume path would reject it before OpenGeni could
  // cold-restore. New envelopes use the stable OpenGeni identity; legacy SDK
  // provider keys remain readable during rollout.
  const persistedInstanceId = assertConsistentSandboxProviderIdentity(backend, envelope);
  const hasResumableInstance = persistedInstanceId !== null;

  // (a) WARM REATTACH BY ID — only when the envelope carries a resumable box id.
  if (
    hasResumableInstance &&
    envelopeSessionState &&
    client.resume &&
    client.deserializeSessionState
  ) {
    let resumedState: unknown;
    try {
      resumedState = await deserializeSandboxSessionStateEnvelope(
        client as unknown as SandboxClient,
        envelopeSessionState,
        persistedInstanceId,
      );
    } catch (error) {
      throw new SandboxConfigError(
        backend,
        `Failed to deserialize sandbox resume envelope for backend "${backend}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (resumedState !== undefined) {
      const providerContinuity =
        opts.recovery === "create-or-restore"
          ? parsedEnvelopeContinuity(backend, envelope, resumedState, persistedInstanceId)
          : null;
      try {
        const resumed = await resumeExactSandboxSession(
          client,
          backend,
          resumedState,
          persistedInstanceId,
          providerContinuity ? { continuity: providerContinuity } : undefined,
        );
        const established: EstablishedSandboxSession = {
          client,
          session: resumed.session,
          sessionState: resumed.sessionState,
          instanceId: resumed.instanceId,
          backendId: client.backendId,
          origin: "resumed",
          ...(resumed.providerContinuity ? { providerContinuity: resumed.providerContinuity } : {}),
          ...(resumed.instanceId !== persistedInstanceId
            ? { lostInstanceId: persistedInstanceId }
            : {}),
        };
        // A continuity resume occurs only on a lease's unique warming owner.
        // Attribute the restarted/adopted wrapper before returning exactly as
        // for a fresh create; failure discards the wrapper but preserves the
        // durable workspace for the next owner.
        if (resumed.providerContinuity && opts.onSandboxCreated) {
          try {
            await opts.onSandboxCreated(established);
          } catch (error) {
            await terminateUnpublishedSandboxSession(established).catch(() => undefined);
            throw error;
          }
        }
        return established;
      } catch (error) {
        // Attached callers never own replacement. Propagate the provider
        // NotFound so their lease-aware caller can atomically mark this exact
        // warm epoch/instance cold and re-enter normal admission. Only the
        // cold->warming winner may replace the missing box.
        if (
          !isProviderSandboxNotFoundError(client.backendId, error) ||
          opts.recovery === "resume-only"
        ) {
          throw error;
        }
        // COLD-RESTORE: the box is genuinely gone. Modal does NOT restore via
        // create({ snapshot }) — passing `snapshot` to ModalSandboxClient.create()
        // THROWS (assertCoreSnapshotUnsupported). Modal's real persistence is an
        // OPAQUE ARCHIVE captured by session.persistWorkspace() at drain/turn-
        // snapshot time and folded onto the lease envelope
        // (sandbox-file-persistence). The shared coldRestore() seam creates a
        // fresh box and replays that archive. `lostInstanceId` carries the gone
        // box's id so the caller can emit the durable sandbox.box.lost event.
        if (
          providerContinuity &&
          (typeof workspaceArchiveBase64 !== "string" || workspaceArchiveBase64.length === 0)
        ) {
          throw new SandboxProviderContinuityUnavailableError(backend, persistedInstanceId, false, {
            cause: error,
          });
        }
        let restoredSession: EstablishedSandboxSession;
        try {
          restoredSession = await coldRestore(resumedState);
        } catch (restoreError) {
          if (!providerContinuity) throw restoreError;
          throw new SandboxProviderContinuityUnavailableError(
            backend,
            persistedInstanceId,
            restoreError instanceof WorkspaceArchiveIntegrityError ? restoreError.retryable : true,
            { cause: restoreError },
          );
        }
        return persistedInstanceId
          ? { ...restoredSession, lostInstanceId: persistedInstanceId }
          : restoredSession;
      }
    }
  }

  // (b) COLD SESSION / COLD LEASE — no resumable box id. create() a fresh box, and
  // if the envelope carries a persisted /workspace snapshot (the archive-only
  // envelope confirmDrainCold preserves across draining->cold), replay it so
  // /workspace survives the box churn (sandbox-file-persistence). No archive -> a
  // clean empty box (a never-warmed session).
  if (opts.recovery === "resume-only") {
    throw new SandboxResumeStateUnavailableError(backend);
  }
  return await coldRestore();
}

function recordSandboxCreateMetric(
  metrics: RuntimeMetricsHooks | undefined,
  backend: string,
  outcome: "completed" | "failed",
  startedMs: number,
): void {
  try {
    metrics?.onSandboxCreate?.({
      backend,
      outcome,
      durationSeconds: Math.max(0, (Date.now() - startedMs) / 1000),
    });
  } catch {
    // Metrics emission must not affect sandbox lifecycle.
  }
}

// A client that can SERIALIZE a live session state back to the persistable
// envelope form (the inverse of deserializeSessionState). Narrowed so the leaf
// stays agent-loop-free.
type SerializeCapableClient = {
  backendId: string;
  serializeSessionState?: (state: unknown, options?: unknown) => Promise<Record<string, unknown>>;
};

/**
 * Fold a freshly-established (or resumed) sandbox session into the persistable
 * `resume_state` envelope the lease stores — the SAME `{ backendId, sessionState }`
 * shape `establishSandboxSessionFromEnvelope` consumes to RESUME BY ID. The
 * API-direct control plane (viewer attach / Channel-A) MUST persist this onto the
 * lease at warm-commit time, or a later op (which reads the lease's resume_state)
 * has nothing to resume from and COLD-CREATES A RIVAL BOX — the box-churn the
 * prove-it surfaced (fs.write then fs.read 404'd on a different box; N Channel-A
 * ops leaked N boxes). Returns null when the client cannot serialize (the caller
 * stores null and the box rides the provider idle-timeout — no rival spawn, just
 * no warm-reattach).
 */
export async function serializeEstablishedSandboxEnvelope(
  established: EstablishedSandboxSession,
): Promise<Record<string, unknown> | null> {
  const client = established.client as SerializeCapableClient | undefined;
  if (!client || typeof client.serializeSessionState !== "function") {
    return null;
  }
  if (established.sessionState === undefined || established.sessionState === null) {
    return null;
  }
  try {
    // serializeSessionState returns the PERSISTABLE FLAT provider state — for
    // Modal `{ sandboxId, appName, imageTag, manifest(serialized),
    // configuredExposedPorts, ... }` (sandboxId preserved via `...state`).
    const serialized = await client.serializeSessionState(established.sessionState);

    // deserializeSandboxSessionStateEnvelope expects the lease-envelope shape
    // `{ providerState, manifest, snapshot?, exposedPorts?, workspaceReady }` and
    // rehydrates `{ ...providerState, manifest, snapshot?, exposedPorts?,
    // workspaceReady }`. So the FLAT serialized state must be nested under
    // `providerState` (and manifest/ports lifted), or sandboxId is dropped on the
    // round-trip and resume() throws "requires a persisted sandboxId". SDK-owned
    // envelope fields are removed from providerState after lifting; providers can
    // return live Manifest instances there, and deserialization overlays the
    // authoritative manifest anyway. configuredExposedPorts is provider
    // configuration/state, not the SDK's port-keyed endpoint record, so it must
    // never be lifted.
    const flat = serialized as Record<string, unknown>;
    const backend = sandboxBackendForSdkBackendId(established.backendId) ?? established.backendId;
    const serializedInstanceId = liveProviderInstanceIdFromState(backend, flat);
    if (!serializedInstanceId || serializedInstanceId !== established.instanceId) {
      return null;
    }
    const manifest = serializeSdkManifestForEnvelope(flat.manifest);
    const exposedPorts = runStateExposedPortsRecord(flat.exposedPorts);
    const sessionState: Record<string, unknown> = {
      providerState: providerStateWithoutDuplicateManifest(flat),
      ...(manifest !== undefined ? { manifest } : {}),
      ...(exposedPorts !== undefined ? { exposedPorts } : {}),
      workspaceReady: true,
    };
    return {
      backendId: established.backendId,
      [OPENGENI_SANDBOX_PROVIDER_INSTANCE_ID_FIELD]: established.instanceId,
      sessionState,
    };
  } catch {
    // A serialize failure must NOT fail the attach/op; we just lose warm-reattach
    // for this box (it stays resumable-by-instance only via the next cold path).
    return null;
  }
}

/**
 * Whether a replacement envelope contains a provider-resumable identity. An
 * archive-only envelope is intentionally valid recovery metadata, but it is
 * never proof that the newly-created provider box can be resumed or attached.
 */
export function hasPersistableSandboxProviderIdentity(
  envelope: Record<string, unknown> | null | undefined,
  backend?: SandboxBackend | string,
): envelope is Record<string, unknown> {
  try {
    const resolvedBackend =
      backend ??
      (typeof envelope?.backendId === "string"
        ? (sandboxBackendForSdkBackendId(envelope.backendId) ?? envelope.backendId)
        : undefined);
    return resolvedBackend
      ? assertConsistentSandboxProviderIdentity(resolvedBackend, envelope) !== null
      : sandboxProviderInstanceIdFromEnvelope(envelope) !== null;
  } catch {
    return false;
  }
}

/** A replacement provider may not be published warm without a resumable
 * identity. Archive-only state is retained only when the caller rolls back to
 * cold and needs the verified workspace bytes for the next attempt. */
export class SandboxReplacementProviderStateError extends Error {
  readonly code = "replacement_provider_state_unpersistable" as const;

  constructor(public readonly backend: string) {
    super(
      `sandbox backend "${backend}" replacement provider state could not be serialized; refusing to publish an attachable lease`,
    );
    this.name = "SandboxReplacementProviderStateError";
  }
}

export function requirePersistableReplacementSandboxEnvelope(
  envelope: Record<string, unknown> | null,
  backend: string,
): Record<string, unknown> {
  const providerInstanceId = assertConsistentSandboxProviderIdentity(backend, envelope);
  if (!envelope || !providerInstanceId) {
    throw new SandboxReplacementProviderStateError(backend);
  }
  return envelope;
}

const DURABLE_WORKSPACE_ARCHIVE_FIELDS = [
  "workspaceArchive",
  "workspaceArchiveMeta",
  "workspaceArchivePrev",
  "workspaceArchivePrevMeta",
  "workspaceArchiveAt",
] as const;

function durableWorkspaceArchiveFields(
  envelope: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const sessionState =
    envelope?.sessionState && typeof envelope.sessionState === "object"
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  if (
    !sessionState ||
    typeof sessionState.workspaceArchive !== "string" ||
    sessionState.workspaceArchive.length === 0
  ) {
    return null;
  }
  const fields: Record<string, unknown> = {};
  for (const key of DURABLE_WORKSPACE_ARCHIVE_FIELDS) {
    if (sessionState[key] !== undefined && sessionState[key] !== null) {
      fields[key] = sessionState[key];
    }
  }
  return fields;
}

/**
 * Build the only resume envelope that may be published for a newly-created
 * replacement sandbox. Historical state contributes durable archive pointers
 * only; it can never substitute for serialization of the replacement's provider
 * identity. If replacement serialization is unavailable or fails, publication
 * keeps an archive-only envelope (when one exists) or null. The new instance id
 * remains separately fenced on the lease, while later attach/resume fails closed
 * rather than targeting the dead provider that initiated rematerialization.
 */
export async function serializeReplacementSandboxEnvelope(
  established: EstablishedSandboxSession,
  archiveSource: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const serialized = await serializeEstablishedSandboxEnvelope(established);
  const archiveFields = durableWorkspaceArchiveFields(archiveSource);
  if (!serialized && !archiveFields) {
    return null;
  }
  const serializedSessionState =
    serialized?.sessionState && typeof serialized.sessionState === "object"
      ? (serialized.sessionState as Record<string, unknown>)
      : {};
  return {
    ...(serialized ?? {}),
    // Never inherit a historical backend marker when the replacement could not
    // serialize. The separately-persisted resume_backend_id and this envelope
    // must both describe the replacement.
    backendId: established.backendId,
    sessionState: {
      ...serializedSessionState,
      ...(archiveFields ?? {}),
    },
  };
}
