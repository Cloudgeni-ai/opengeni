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
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from "@openai/agents/sandbox/local";
import type {
  SandboxClient,
  SandboxSessionLike,
  SandboxSessionState,
} from "@openai/agents/sandbox";
import { ModalImageSelector, ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";

// Re-export the config-owned environment/port helpers from the leaf so the
// API-direct control plane can pull its full sandbox-construction surface from
// a single agent-loop-free entrypoint. They physically live in @opengeni/config
// (moving them into runtime would create a config→runtime cycle — ledger CR8).
export { collectSandboxEnvironment, parseExposedPorts } from "@opengeni/config";

export function createSandboxClient(settings: Settings, environment = collectSandboxEnvironment(settings)): unknown {
  if (settings.sandboxBackend === "docker") {
    return withDockerNetwork(new DockerSandboxClient({
      image: settings.dockerImage,
      exposedPorts: parseExposedPorts(settings.dockerExposedPorts),
    }), settings.dockerNetwork);
  }
  if (settings.sandboxBackend === "modal") {
    const options: ConstructorParameters<typeof ModalSandboxClient>[0] = {
      appName: settings.modalAppName,
      timeoutMs: settings.modalTimeoutSeconds * 1000,
      exposedPorts: parseExposedPorts(settings.dockerExposedPorts),
      env: environment,
    };
    if (settings.modalImageRef) {
      options.image = ModalImageSelector.fromTag(settings.modalImageRef);
    }
    if (settings.modalTokenId) {
      options.tokenId = settings.modalTokenId;
    }
    if (settings.modalTokenSecret) {
      options.tokenSecret = settings.modalTokenSecret;
    }
    if (settings.modalEnvironment) {
      options.environment = settings.modalEnvironment;
    }
    return new ModalSandboxClient(options);
  }
  if (settings.sandboxBackend === "local") {
    return new UnixLocalSandboxClient();
  }
  return undefined;
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
