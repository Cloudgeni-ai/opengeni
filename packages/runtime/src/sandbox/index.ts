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
import { DESKTOP_STREAM_PORT, type SandboxBackend } from "@opengeni/contracts";
import type {
  SandboxClient,
  SandboxSessionLike,
  SandboxSessionState,
} from "@openai/agents/sandbox";
import { PROVIDER_REGISTRY } from "./providers";
import { SandboxConfigError } from "./errors";

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
  negotiateCapabilities,
  type NegotiationContext,
} from "./select";

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

  // The serialized provider state the box was last persisted as. The envelope
  // shape is the per-turn `_sandbox` entry; its `sessionState` is the provider
  // payload deserializeSandboxSessionStateEnvelope re-hydrates.
  const envelopeSessionState = envelope && typeof envelope === "object" ? (envelope as { sessionState?: unknown }).sessionState : undefined;

  // (a) WARM REATTACH BY ID — only when we have an envelope to resume from.
  if (envelopeSessionState && client.resume && client.deserializeSessionState) {
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
        // COLD-RESTORE: the box is genuinely gone. Recreate it, restoring the
        // workspace from the snapshot the resumed state carries when present (the
        // create() arg shape is { snapshot } — NOT a sessionState bag). When the
        // state has no snapshot (no provider workspace-persistence configured),
        // fall back to a fresh box from the manifest the client was built with.
        const snapshot = (resumedState as { snapshot?: unknown } | undefined)?.snapshot;
        const restored = snapshot !== undefined
          ? await client.create({ snapshot })
          : await client.create();
        const restoredState = (restored as { state?: unknown }).state;
        return { client, session: restored, sessionState: restoredState ?? resumedState, instanceId: readInstanceId(restored), backendId: client.backendId };
      }
    }
  }

  // (b) COLD SESSION (no envelope / no resumable state) — create a fresh box.
  const created = await client.create();
  const createdState = (created as { state?: unknown }).state;
  return { client, session: created, sessionState: createdState, instanceId: readInstanceId(created), backendId: client.backendId };
}
