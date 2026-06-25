// @opengeni/runtime/sandbox — the agent-loop-free sandbox leaf.
//
// This module is the load-bearing pre-req for the API-direct control plane
// (docs/design/sandbox-surfacing). It exposes the sandbox client factory plus
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
import { DESKTOP_STREAM_PORT, TERMINAL_STREAM_PORT, type SandboxBackend } from "@opengeni/contracts";
import type {
  SandboxClient,
  SandboxSessionLike,
  SandboxSessionState,
} from "@openai/agents/sandbox";
import { PROVIDER_REGISTRY } from "./providers";
import { SandboxConfigError } from "./errors";
import { isSelfhostedProviderNotFoundError } from "./selfhosted/session";

// Re-export the config-owned environment/port helpers from the leaf so the
// API-direct control plane can pull its full sandbox-construction surface from
// a single agent-loop-free entrypoint. They physically live in @opengeni/config
// (moving them into runtime would create a config→runtime cycle — ledger CR8).
export { collectSandboxEnvironment, parseExposedPorts } from "@opengeni/config";

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
export { SandboxConfigError, SandboxProviderUnavailableError } from "./errors";
export {
  PROVIDER_REGISTRY,
  assertProviderRegistryInvariants,
  type ProviderRegistration,
  type ProviderConstructionContext,
} from "./providers";
export {
  selectBackend,
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
// loop); finalize reads bytes + PUTs to storage in the holding process (F10).
export {
  startRecording,
  stopRecording,
  readRecordingBytes,
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
  type FinalizeRecordingResult,
} from "./recording";

// P4.4 Channel-A structured services — the provider-agnostic SandboxChannelAService
// (FileSystem + Git + Terminal) over a live, resumed-by-id session handle. The
// API constructs one per request around the box it just resumed; no ownership.
// Agent-loop-free, so the API-direct control plane imports it from this leaf.
export {
  SandboxChannelAService,
  ChannelAValidationError,
  ChannelAConflictError,
  ChannelANotFoundError,
  ChannelAUnsupportedError,
  stripExecBanner,
  parseExecBannerSessionId,
  isWorkspaceEscapeError,
  isExecSessionLostBanner,
  assertSafeRelPath,
  parsePorcelainV2,
  parseNumstatZ,
  parseUnifiedPatch,
  type ChannelASession,
  type ChannelAExecArgs,
  type ChannelAExecResult,
  type ChannelAEmitter,
  type SandboxChannelAServiceOptions,
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
  type NatsRequestConnection,
  type SelfhostedUnavailableReason,
} from "./selfhosted/control-rpc";
export {
  SelfhostedSession,
  SelfhostedSandboxClient,
  isSelfhostedProviderNotFoundError,
  SELFHOSTED_DEFAULT_TIMEOUT_MS,
  type SelfhostedSessionState,
  type SelfhostedSessionDeps,
  type SelfhostedRelayConfig,
  type SelfhostedExecArgs,
  type SelfhostedExecResult,
} from "./selfhosted/session";
export {
  negotiateSelfhostedCapabilities,
  selfhostedLiveness,
  SELFHOSTED_RECONNECT_WINDOW_MS,
  type SelfhostedNegotiationInput,
  type SelfhostedLivenessState,
  type SelfhostedEnrollment,
} from "./selfhosted/capabilities";
export { MockAgentResponder, type MockAgentResponderOptions, type MockExecHandler } from "./selfhosted/testing";

// The hot-swap routing proxy (M7): ONE stable session-shaped object the SDK binds
// to, which re-reads the per-session active pointer per op and dispatches to the
// currently-active backend (Modal or selfhosted) — flippable mid-turn, single
// active at a time, fence-retrying on a swap race.
export {
  RoutingSandboxSession,
  RoutingUnsupportedError,
  type ActivePointer,
  type RoutableBackendSession,
  type ResolvedActiveBackend,
  type RoutingSandboxSessionDeps,
  type RoutingTransitionEvent,
} from "./routing/routing-session";
export {
  makeActiveBackendResolver,
  ActiveBackendUnresolvableError,
  type ActiveBackendResolverDeps,
  type RoutableSandbox,
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
export function createSandboxClient(settings: Settings, environment = collectSandboxEnvironment(settings)): unknown {
  return createSandboxClientForBackend(settings.sandboxBackend as SandboxBackend, settings, environment);
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
    desktop.available
    && settings.sandboxDesktopEnabled
    && !registration.descriptor.portExposure.supportsOnDemandPorts
    && !exposedPorts.includes(DESKTOP_STREAM_PORT)
  ) {
    exposedPorts.push(DESKTOP_STREAM_PORT);
  }
  // 7681 port-merge: the REAL PTY terminal (ttyd) rides the SAME tunnel as the
  // desktop, so a desktop-capable pre-declared-port backend must ALSO carry 7681
  // at construction for resolveExposedPort(7681) to succeed later on a fresh box.
  // Same condition as the 6080 merge (a desktop-capable image bakes ttyd too).
  if (
    desktop.available
    && settings.sandboxDesktopEnabled
    && !registration.descriptor.portExposure.supportsOnDemandPorts
    && !exposedPorts.includes(TERMINAL_STREAM_PORT)
  ) {
    exposedPorts.push(TERMINAL_STREAM_PORT);
  }

  const raw = registration.build({ settings, environment, exposedPorts });
  // Docker network decoration stays backend-specific (only docker).
  return registration.backend === "docker"
    ? withDockerNetwork(raw as SandboxClient, settings.dockerNetwork)
    : raw;
}

function withDockerNetwork(client: SandboxClient, network: string | undefined): SandboxClient {
  const trimmed = network?.trim();
  if (!trimmed) {
    return client;
  }
  const wrapSession = async <T extends SandboxSessionLike>(session: T): Promise<T> => {
    const containerId = (session as { state?: { containerId?: unknown } }).state?.containerId;
    if (typeof containerId === "string" && containerId.length > 0) {
      await connectDockerNetwork(trimmed, containerId);
    }
    return session;
  };
  return {
    backendId: client.backendId,
    ...(client.supportsDefaultOptions !== undefined ? { supportsDefaultOptions: client.supportsDefaultOptions } : {}),
    ...(client.create ? { create: async (...args: any[]) => await wrapSession(await (client.create as any)(...args)) } : {}),
    ...(client.resume ? { resume: async (state: SandboxSessionState) => await wrapSession(await client.resume!(state)) } : {}),
    ...(client.delete ? { delete: async (state: SandboxSessionState) => await client.delete!(state) } : {}),
    ...(client.serializeSessionState ? { serializeSessionState: async (state: SandboxSessionState, options) => await client.serializeSessionState!(state, options) } : {}),
    ...(client.canPersistOwnedSessionState ? { canPersistOwnedSessionState: async (state: SandboxSessionState) => await client.canPersistOwnedSessionState!(state) } : {}),
    ...(client.canReusePreservedOwnedSession ? { canReusePreservedOwnedSession: async (state: SandboxSessionState) => await client.canReusePreservedOwnedSession!(state) } : {}),
    ...(client.deserializeSessionState ? { deserializeSessionState: async (state: Record<string, unknown>) => await client.deserializeSessionState!(state) } : {}),
  };
}

async function connectDockerNetwork(network: string, containerId: string): Promise<void> {
  const result = Bun.spawnSync(["docker", "network", "connect", network, containerId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    return;
  }
  const stderr = new TextDecoder().decode(result.stderr);
  if (stderr.includes("already exists")) {
    return;
  }
  throw new Error(`Failed to connect Docker sandbox container to network ${network}: ${stderr.trim()}`);
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
  const entry = sandboxState.sessionsByAgent?.[sandboxState.currentAgentKey]
    ?? (sandboxState.currentAgentKey && sandboxState.sessionState
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
  return entry as Record<string, unknown>;
}

/**
 * Items-mode counterpart of restoredSandboxSessionState: rebuild the live
 * sandbox session state from a stored entry (as produced by
 * sandboxStateEntryFromRunState) instead of from a RunState blob.
 */
export async function restoredSandboxSessionStateFromEntry(entry: Record<string, unknown>, client: unknown): Promise<SandboxSessionState | undefined> {
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
export function readWorkspaceArchiveFromEnvelopeSessionState(sessionState: unknown): Uint8Array | undefined {
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

// The native snapshot-ref prefixes the @openai/agents-extensions modal client
// encodes (snapshots.mjs `NATIVE_SNAPSHOT_PREFIXES`). The ref is
// `<PREFIX>\n{"snapshot_id":"...",...}`. We re-implement the decode here because
// `@openai/agents-extensions/sandbox/shared` is NOT an exported subpath (the
// package `exports` map only exposes `./sandbox/<provider>`), so decodeNativeSnapshotRef
// is unreachable — same reasoning as isProviderSandboxNotFoundError below.
const MODAL_SNAPSHOT_REF_PREFIXES = [
  "MODAL_SANDBOX_FS_SNAPSHOT_V1\n",
  "MODAL_SANDBOX_DIR_SNAPSHOT_V1\n",
];

/** Decode the Modal snapshot id out of a persisted base64 archive ref, or
 *  undefined when the archive is a tar payload (no provider snapshot to GC) or
 *  is unparseable. Used only for keep-latest-per-lease snapshot GC. */
export function decodeModalSnapshotId(archive: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder().decode(archive);
  } catch {
    return undefined;
  }
  for (const prefix of MODAL_SNAPSHOT_REF_PREFIXES) {
    if (!text.startsWith(prefix)) {
      continue;
    }
    try {
      const payload = JSON.parse(text.slice(prefix.length)) as { snapshot_id?: unknown };
      return typeof payload.snapshot_id === "string" && payload.snapshot_id.length > 0
        ? payload.snapshot_id
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Best-effort GC of a SUPERSEDED Modal filesystem/directory snapshot
 * (sandbox-file-persistence). restoreSnapshotFilesystem terminates the previous
 * SANDBOX but never deletes the prior SNAPSHOT image, so snapshots accumulate
 * unbounded across warm/cold cycles. The reaper keeps only the latest per lease:
 * when it writes a NEW archive it passes the PRIOR archive here to delete its
 * image via the live session's Modal client (`session.modal.images.delete(id)` —
 * the same API the SDK uses for directory images). Never throws (GC is a
 * best-effort backstop; a leaked snapshot is a cost issue, not a correctness one).
 * A tar archive (no snapshot id) is a no-op. Returns the deleted snapshot id (or
 * undefined when nothing was deleted) for observability.
 */
export async function deletePriorPersistedSnapshot(session: unknown, priorArchiveBase64: string | null | undefined): Promise<string | undefined> {
  if (!priorArchiveBase64) {
    return undefined;
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(priorArchiveBase64, "base64"));
  } catch {
    return undefined;
  }
  const snapshotId = decodeModalSnapshotId(bytes);
  if (!snapshotId) {
    return undefined;
  }
  const modal = (session as { modal?: { images?: { delete?: (id: string) => Promise<unknown> } } }).modal;
  const del = modal?.images?.delete;
  if (typeof del !== "function") {
    return undefined;
  }
  try {
    await del.call(modal!.images, snapshotId);
    return snapshotId;
  } catch {
    return undefined;
  }
}

export async function deserializeSandboxSessionStateEnvelope(client: SandboxClient, envelope: unknown): Promise<SandboxSessionState | undefined> {
  if (!envelope || typeof envelope !== "object") {
    return undefined;
  }
  if (!client.deserializeSessionState) {
    throw new Error("Sandbox client must implement deserializeSessionState() to resume RunState sandbox state");
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
  return await client.deserializeSessionState({
    ...(state.providerState ?? {}),
    manifest: state.manifest,
    ...(state.snapshot !== undefined ? { snapshot: state.snapshot } : {}),
    ...(state.snapshotFingerprint !== undefined ? { snapshotFingerprint: state.snapshotFingerprint } : {}),
    ...(state.snapshotFingerprintVersion !== undefined ? { snapshotFingerprintVersion: state.snapshotFingerprintVersion } : {}),
    workspaceReady: state.workspaceReady,
    ...(state.exposedPorts ? { exposedPorts: structuredClone(state.exposedPorts) } : {}),
  });
}

// ============================================================================
// The ONE resume / recovery primitive (P1.2).
//
// establishSandboxSessionFromEnvelope is the single re-establish-from-envelope
// path the stateless model leans on: a turn (or any API-direct op) resolves the
// group lease, hands us the recovery envelope, and gets back a LIVE non-owned
// session. On a warm box this is a no-lock warm reattach by id (Modal fromId,
// e2b reconnect — R4-safe, a stray second handle never spawns a second box).
// When the provider reports the box genuinely gone (NotFound) we cold-restore
// from the snapshot via create(). NEVER create() on any OTHER resume error
// (only on NotFound) — a resume-conflict means the box is alive and the caller
// must back off, not spawn a rival.
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
};

// The structural slice we need from a provider SandboxClient to resume by id and
// cold-restore. Narrowed (not the full agent-loop SandboxClient) so the leaf
// stays agent-loop-free.
type ResumeCapableClient = {
  backendId: string;
  deserializeSessionState?: (state: Record<string, unknown>) => Promise<unknown>;
  resume?: (state: unknown, options?: unknown) => Promise<unknown>;
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
export function isProviderSandboxNotFoundError(backendId: string, error: unknown): boolean {
  // selfhosted: agent-offline is NEVER a provider NotFound (the user's machine is
  // not recreatable — a false NotFound would cold-create a RIVAL box). The
  // selfhosted discriminator ALWAYS returns false; short-circuit so no goneMarker
  // string match below can ever flip a selfhosted agent-offline error to true.
  if (backendId === "selfhosted") {
    return isSelfhostedProviderNotFoundError(error);
  }
  if (!error) {
    return false;
  }
  const status = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  if (status === 404) {
    return true;
  }
  const name = typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "";
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown })?.message ?? "");
  const haystack = `${name} ${code} ${message}`.toLowerCase();
  // Provider-agnostic "gone" markers (Modal: "sandbox … not found" / terminated;
  // e2b/daytona/runloop: "not found" / "no longer running" / "terminated" /
  // "does not exist"). Kept broad-but-conservative: it matches box-gone phrasing
  // and never matches generic 5xx/transport errors.
  const goneMarkers = [
    "not found",
    "no longer running",
    "no longer exists",
    "does not exist",
    "doesn't exist",
    "has been terminated",
    "was terminated",
    "is terminated",
    "sandbox terminated",
    "notfound",
    "sandbox_not_found",
    "box no longer running",
  ];
  // A "running"/"already exists" resume-conflict is explicitly NOT NotFound — the
  // box is alive; recreating would double-spawn.
  if (haystack.includes("already running") || haystack.includes("still running") || haystack.includes("already exists")) {
    return false;
  }
  return goneMarkers.some((marker) => haystack.includes(marker));
}

function readInstanceId(session: unknown): string {
  const state = (session as { state?: Record<string, unknown> }).state ?? {};
  const candidate = state.sandboxId ?? state.instanceId ?? state.id ?? state.hostId ?? state.containerId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : "";
}

/**
 * Resume the one box by id from its recovery envelope, or cold-restore from the
 * snapshot when the provider reports it gone. The envelope is the lease's
 * box-identity descriptor (the same per-turn `_sandbox` envelope upserted by the
 * turn activity). A null envelope means a cold session that was never warmed →
 * create() directly.
 *
 *  - `opts.backendOverride ?? envelope.backendId ?? settings.sandboxBackend`
 *    selects the backend; the client is built for THAT backend (resume-by-id is
 *    fenced to the original provider).
 *  - warm reattach: deserialize the envelope sessionState → client.resume(state)
 *    (no lock; R4-safe). On a provider NotFound, cold-restore via create().
 *  - cold restore / cold session: client.create() — the ONLY create() site.
 */
export async function establishSandboxSessionFromEnvelope(
  settings: Settings,
  envelope: Record<string, unknown> | null,
  opts: { sessionId: string; backendOverride?: SandboxBackend; environment?: Record<string, string> },
): Promise<EstablishedSandboxSession> {
  const envelopeBackend = typeof envelope?.backendId === "string" ? (envelope.backendId as SandboxBackend) : undefined;
  const backend = (opts.backendOverride ?? envelopeBackend ?? (settings.sandboxBackend as SandboxBackend));
  const environment = opts.environment ?? collectSandboxEnvironment(settings);
  const client = createSandboxClientForBackend(backend, settings, environment) as ResumeCapableClient | undefined;
  if (!client) {
    throw new SandboxConfigError(backend, `Cannot establish a sandbox session for backend "${backend}" (no client; sandboxBackend=none?)`);
  }
  if (!client.create) {
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
  const envelopeSessionState = envelope && typeof envelope === "object" ? (envelope as { sessionState?: unknown }).sessionState : undefined;

  // The persisted /workspace snapshot the reaper folded onto the lease envelope
  // (sandbox-file-persistence). Present on a re-warm whose box was drain-persisted:
  //   - WARM reattach NotFound path (box gone, full envelope still has sandboxId);
  //   - COLD lease re-warm (confirmDrainCold preserved a MINIMAL archive-only
  //     envelope `{ sessionState: { workspaceArchive } }` — NO sandboxId, so the
  //     warm-reattach branch must NOT try resume()-by-id; it cold-creates+hydrates).
  const workspaceArchive = readWorkspaceArchiveFromEnvelopeSessionState(envelopeSessionState);

  // create() a FRESH box, THEN replay the persisted /workspace snapshot via
  // session.hydrateWorkspace(archive) when one rode the envelope. hydrateWorkspace
  // decodes the snapshot-ref and swaps the box for one booted from the snapshot
  // image (restoreSnapshotFilesystem); no archive -> a clean empty box. This is the
  // SOLE archive-replay seam, shared by the NotFound warm-reattach path AND the
  // cold-restore branch (b) below.
  const coldRestore = async (resumeFallbackState?: unknown): Promise<EstablishedSandboxSession> => {
    const restored = await client.create!({ manifest: createManifest });
    if (workspaceArchive) {
      const hydrate = (restored as { hydrateWorkspace?: (data: Uint8Array) => Promise<void> }).hydrateWorkspace;
      if (typeof hydrate === "function") {
        try {
          // hydrateWorkspace may internally REPLACE the underlying box
          // (restoreSnapshotFilesystem creates a replacement sandbox and terminates
          // the placeholder), so the instanceId must be re-read AFTER.
          await hydrate.call(restored, workspaceArchive);
        } catch (hydrateError) {
          // sandbox-file-persistence: if hydrateWorkspace throws (snapshot GC'd,
          // provider timeout, corrupt archive), the placeholder box created above is
          // live but unhydrated — it would leak up to the full idle/hard lifetime
          // (3600s) if we just re-throw. Best-effort delete/terminate it BEFORE
          // re-throwing so no box leaks. The original error semantics are preserved
          // (the re-throw propagates to the caller). This mirrors the reaper's
          // discipline: NEVER leave an orphaned box running.
          const restoredState = (restored as { state?: unknown }).state;
          const clientWithDelete = client as { delete?: (state: unknown) => Promise<unknown> };
          if (typeof clientWithDelete.delete === "function" && restoredState !== undefined) {
            try { await clientWithDelete.delete(restoredState); } catch { /* best-effort; re-throw the hydrate error below */ }
          } else {
            // No delete() — try a session-level close/terminate as a fallback.
            const sess = restored as { close?: () => Promise<unknown>; terminate?: () => Promise<unknown> };
            try { await (sess.terminate ?? sess.close)?.(); } catch { /* best-effort */ }
          }
          throw hydrateError;
        }
      }
    }
    const restoredState = (restored as { state?: unknown }).state;
    return { client, session: restored, sessionState: restoredState ?? resumeFallbackState, instanceId: readInstanceId(restored), backendId: client.backendId };
  };

  // Does the envelope carry a RESUMABLE box id (warm reattach), or only a
  // restorable archive (cold lease)? A Modal envelope with no providerState.sandboxId
  // (the minimal archive-only envelope confirmDrainCold preserves) is NOT resumable —
  // client.resume() would throw "requires a persisted sandboxId", which is NOT a
  // NotFound, so it would propagate instead of cold-restoring. Gate the resume
  // branch on a present sandbox identity so an archive-only envelope falls straight
  // through to the cold-restore+hydrate path (b).
  const envelopeProviderState = envelopeSessionState && typeof envelopeSessionState === "object"
    ? (envelopeSessionState as { providerState?: Record<string, unknown> }).providerState
    : undefined;
  const hasResumableInstance = Boolean(
    envelopeProviderState
    && typeof envelopeProviderState === "object"
    && (envelopeProviderState.sandboxId
      || envelopeProviderState.instanceId
      || envelopeProviderState.id
      || envelopeProviderState.containerId),
  );

  // (a) WARM REATTACH BY ID — only when the envelope carries a resumable box id.
  if (hasResumableInstance && envelopeSessionState && client.resume && client.deserializeSessionState) {
    let resumedState: unknown;
    try {
      resumedState = await deserializeSandboxSessionStateEnvelope(client as unknown as SandboxClient, envelopeSessionState);
    } catch (error) {
      throw new SandboxConfigError(backend, `Failed to deserialize sandbox resume envelope for backend "${backend}": ${error instanceof Error ? error.message : String(error)}`);
    }
    if (resumedState !== undefined) {
      try {
        const session = await client.resume(resumedState);
        return { client, session, sessionState: resumedState, instanceId: readInstanceId(session), backendId: client.backendId };
      } catch (error) {
        // ONLY a provider NotFound (box gone) licenses a cold-restore. Anything
        // else (transient/auth/network/resume-conflict) propagates: the caller
        // backs off and re-fences — NEVER spawns a rival box.
        if (!isProviderSandboxNotFoundError(client.backendId, error)) {
          throw error;
        }
        // COLD-RESTORE: the box is genuinely gone. Modal does NOT restore via
        // create({ snapshot }) — passing `snapshot` to ModalSandboxClient.create()
        // THROWS (assertCoreSnapshotUnsupported). Modal's real persistence is an
        // OPAQUE ARCHIVE captured by session.persistWorkspace() at reaper-drain
        // time and folded onto the lease envelope (sandbox-file-persistence). The
        // shared coldRestore() seam creates a fresh box and replays that archive.
        return await coldRestore(resumedState);
      }
    }
  }

  // (b) COLD SESSION / COLD LEASE — no resumable box id. create() a fresh box, and
  // if the envelope carries a persisted /workspace snapshot (the archive-only
  // envelope confirmDrainCold preserves across draining->cold), replay it so
  // /workspace survives the box churn (sandbox-file-persistence). No archive -> a
  // clean empty box (a never-warmed session).
  return await coldRestore();
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
    // round-trip and resume() throws "requires a persisted sandboxId". We pull
    // manifest/exposedPorts up but leave them in providerState too (harmless; the
    // deserialize spreads providerState first, then overlays manifest/ports).
    const flat = serialized as Record<string, unknown>;
    const manifest = flat.manifest;
    const exposedPorts = flat.configuredExposedPorts ?? flat.exposedPorts;
    const sessionState: Record<string, unknown> = {
      providerState: flat,
      ...(manifest !== undefined ? { manifest } : {}),
      ...(exposedPorts !== undefined ? { exposedPorts } : {}),
      workspaceReady: true,
    };
    return { backendId: established.backendId, sessionState };
  } catch {
    // A serialize failure must NOT fail the attach/op; we just lose warm-reattach
    // for this box (it stays resumable-by-instance only via the next cold path).
    return null;
  }
}
