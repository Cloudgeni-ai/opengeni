// The uniform per-provider registration shape (module 03 §3.1).
//
// One file per provider implements ProviderRegistration; PROVIDER_REGISTRY maps
// each SandboxBackend to its registration. This replaces the flat if/else chain
// that createSandboxClient used to be.

import type { Settings } from "@opengeni/config";
import type { CapabilityDescriptor, SandboxBackend } from "@opengeni/contracts";

export interface ProviderConstructionContext {
  settings: Settings;
  /** The env map for the box (collectSandboxEnvironment / per-run environment). */
  environment: Record<string, string>;
  /**
   * Parsed exposed ports (config string -> number[]); already includes the
   * desktop stream port (6080) when this is a desktop tier with desktop enabled
   * and the provider cannot expose ports on demand (the merge happens in
   * createSandboxClient before build()).
   */
  exposedPorts: number[];
}

export type ProviderImmutableImageBuildResult = {
  provider: string;
  backend: SandboxBackend;
  imageId: string | null;
  imageDigest: string | null;
  /** Exact provider account/workspace binding. Persist only a hash publicly. */
  providerBindingKey: string | null;
};

export type ProviderImmutableImageBuildInput = {
  settings: Settings;
  session: unknown;
  requestId: string;
  timeoutMs: number;
};

/**
 * Crash-recovery contract for one provider's /workspace capture path.
 *
 * - `same_request`: retrying with the durable request id resumes/returns the
 *   same provider operation.
 * - `parallel_read`: the adapter deliberately uses an independently repeatable,
 *   read-only capture (normally a uniquely-named tar); overlapping a predecessor
 *   after worker loss cannot replace or mutate the live sandbox.
 * - `exclusive`: neither property is proven, so an ambiguous predecessor may
 *   never be overlapped while the provider instance is still live.
 */
export type ProviderWorkspaceCaptureTakeover = "same_request" | "parallel_read" | "exclusive";

export type ProviderWorkspaceCapturePolicy = {
  takeover: ProviderWorkspaceCaptureTakeover;
  /** `portable_tar` bypasses a provider-native persistence mode whose capture
   * replaces the live instance or creates an unledgered native artifact. */
  strategy: "configured" | "portable_tar";
  /** Warm checkpoints are legal only when capture preserves the addressed
   * physical instance. A replacing capture must never run behind a lease whose
   * provider identity cannot be atomically republished with it. */
  liveInstance: "preserved" | "replaced";
};

/**
 * How OpenGeni obtains a non-replacing attachment to the exact persisted
 * provider instance.
 *
 * - `ordinary`: SDK `resume()` is already a pure re-address operation; the
 *   factory exposes it through the explicit `resumeExact()` contract.
 * - `custom`: ordinary resume may restore/recreate, so the adapter itself must
 *   implement `resumeExact()` and fail when the addressed instance is absent.
 * - `none`: the backend has no provider session.
 */
export type ProviderExactResumeMode = "ordinary" | "custom" | "none";

export const REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE = Object.freeze({
  takeover: "parallel_read",
  strategy: "configured",
  liveInstance: "preserved",
} satisfies ProviderWorkspaceCapturePolicy);

export const REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE = Object.freeze({
  takeover: "parallel_read",
  strategy: "portable_tar",
  liveInstance: "preserved",
} satisfies ProviderWorkspaceCapturePolicy);

/** Read SDK workspace persistence without coupling callers to the three shapes
 * used across live sessions, serialized provider state, and lease envelopes. */
export function providerWorkspacePersistence(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  const outer = state as Record<string, unknown>;
  const liveState =
    outer.state && typeof outer.state === "object" && !Array.isArray(outer.state)
      ? (outer.state as Record<string, unknown>)
      : outer;
  const sessionState =
    liveState.sessionState &&
    typeof liveState.sessionState === "object" &&
    !Array.isArray(liveState.sessionState)
      ? (liveState.sessionState as Record<string, unknown>)
      : liveState;
  const providerState =
    sessionState.providerState &&
    typeof sessionState.providerState === "object" &&
    !Array.isArray(sessionState.providerState)
      ? (sessionState.providerState as Record<string, unknown>)
      : null;
  return providerState?.workspacePersistence ?? sessionState.workspacePersistence;
}

export interface ProviderRegistration {
  backend: SandboxBackend;
  exactResumeMode: ProviderExactResumeMode;
  /** Exact live-session state fields that address this provider. New providers
   * must declare this explicitly; generic `id` guessing is forbidden. */
  instanceIdFields: readonly string[];
  /** Optional identity below the disposable provider execution wrapper. A
   * matching key licenses a replacement only when the caller supplies a
   * durable continuity receipt; ordinary attached resumes remain exact. */
  continuity?: {
    kind: "docker_workspace";
    keyFromState(state: unknown): string | null;
    /** Make discarding an unpublished replacement preserve the shared durable
     * workspace named by the continuity key. */
    preserveWorkspaceForDiscard(session: unknown, sessionState: unknown): void;
  };
  /** Resolve capture semantics from either a live session, a serialized SDK
   * session state, or OpenGeni's outer session envelope. Required for every
   * provider so new backends cannot silently inherit unsafe teardown behavior.
   * `null` means the backend has no provider workspace to capture. */
  workspaceCapturePolicy(state: unknown): ProviderWorkspaceCapturePolicy | null;
  /** Optional provider preparation after a verified archive is durable and
   * immediately before generic SDK teardown. This may only suppress redundant
   * provider persistence; it must not alter durable identity or workspace data. */
  prepareForTeardownAfterCapture?(session: unknown): void;
  /**
   * Build one provider-native immutable image from an already verified clean
   * sandbox. Omission is the truthful unsupported-provider signal; callers
   * must retain runtime setup as the fallback.
   */
  buildImmutableImage?(
    input: ProviderImmutableImageBuildInput,
  ): Promise<ProviderImmutableImageBuildResult>;
  descriptor: CapabilityDescriptor;
  /**
   * Validate that the settings carry the credentials/config this provider
   * REQUIRES. Throw SandboxConfigError on any missing/contradictory field.
   * Pure — no network. Called by both the factory and a deploy-time preflight.
   * The factory calls this before build(), so build() may assume valid settings.
   */
  validateCredentials(settings: Settings): void;
  /**
   * Build the raw SDK SandboxClient. Returns undefined ONLY for "none".
   * The factory calls validateCredentials() first, so build() can assume valid.
   */
  build(ctx: ProviderConstructionContext): unknown;
}
