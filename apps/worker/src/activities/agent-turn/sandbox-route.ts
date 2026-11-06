import {
  readActiveSandbox,
  setActiveSandbox,
  type ActiveSandboxPointer,
  type SandboxRecord,
} from "@opengeni/db";
import {
  assertHostSandboxBackendServed,
  ensureModalRegistryImage,
  swapTargetEstablishability,
  type BackendUnresolvableCode,
} from "@opengeni/runtime";
import { deploymentSandboxBackend, type Settings } from "@opengeni/config";
import { managedSessionGroupBackend } from "@opengeni/core";
import type { TurnActivityServices as ActivityServices } from "../types";
import {
  sandboxLeaseHolderIdForAttempt,
  type TurnSandboxLeaseHolderId,
} from "../../sandbox-resume";
import { type TurnSandboxEstablishReason } from "../../observability-metrics";
import { type SessionEventType } from "@opengeni/contracts";
import { safeErrorDiagnostic } from "./errors";

/**
 * Refuse a turn whose session would build its box on a host backend (`local`,
 * `docker`) this deployment does not serve, before anything else touches a
 * sandbox: no box, repository clone, setup, Rig or hydration hook, credential
 * or Codemode materialization. Session creation already rejects such backends
 * (`sandboxBackendServed`), but rows stored before that gate, and shared-box
 * children that inherit a parent's backend, still name one. `deploymentSettings`
 * should be the worker's own settings; the deployment default is read from
 * `deploymentSandboxBackend`, so a session-rebound copy cannot serve itself.
 *
 * The backend checked is the one the turn would build (`selfhosted` falls back
 * to the deployment default; `none` builds nothing). Throws
 * SandboxBackendNotServedError, a non-retryable configuration failure.
 */
export function assertTurnSandboxBackendServed(
  deploymentSettings: Settings,
  sessionBackend: Settings["sandboxBackend"],
): void {
  const built = managedSessionGroupBackend(
    deploymentSandboxBackend(deploymentSettings),
    sessionBackend,
  );
  if (built) assertHostSandboxBackendServed(deploymentSettings, built);
}

export async function resolveActiveSandboxBackend(
  routingOn: boolean,
  loadPointer: () => Promise<{ activeSandboxId: string | null } | null>,
  loadSandboxKind: (sandboxId: string) => Promise<string | null>,
): Promise<Settings["sandboxBackend"] | undefined> {
  // The active pointer + swap tools only exist when selfhosted routing is on; with
  // the flag off there is nothing to resolve and we keep the home-backend default.
  if (!routingOn) {
    return undefined;
  }
  // A load failure propagates. It is not "no machine": answering undefined would
  // start this turn on the managed home while the chat's route names a machine.
  const pointer = await loadPointer();
  // A null pointer (no swap) means "use the session's own cloud group box" — the
  // home backend already governs that path, so leave the override unset.
  if (!pointer?.activeSandboxId) {
    return undefined;
  }
  const kind = await loadSandboxKind(pointer.activeSandboxId);
  return kind === "selfhosted" ? "selfhosted" : undefined;
}

/** Short pauses before re-reading a turn-start route fact after a failed read. */
export const TURN_ROUTE_READ_RETRY_DELAYS_MS: readonly number[] = [100, 400];

/**
 * Read one fact that decides WHICH sandbox this turn starts on (the session's
 * active pointer, or the row it names). A failed read is never treated as an
 * absent route: it is retried briefly (a connection dropped by a restart or a
 * redeploy usually recovers within this window) and then rethrown unchanged, so
 * the attempt stops before any box is touched and the database recovery lane
 * retries it. Starting on the managed home instead would run setup, credential
 * seeding and file downloads on a box the chat did not choose.
 */
export async function readTurnRouteFact<T>(
  read: () => Promise<T>,
  delaysMs: readonly number[] = TURN_ROUTE_READ_RETRY_DELAYS_MS,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await read();
    } catch (error) {
      const delayMs = delaysMs[retry];
      if (delayMs === undefined) throw error;
      console.warn("turn route read failed; retrying", safeErrorDiagnostic(error));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Managed-sandbox ownership exists only when this turn actually uses the
 * managed home. A Connected Machine is fenced by its active-route epoch and
 * must remain independent from cloud recovery state for the same session.
 */
export function managedSandboxOwnershipForTurn(
  machinePrimary: boolean,
  attemptId: string,
  sandboxGroupId: string,
): { holderId: TurnSandboxLeaseHolderId; sandboxGroupId: string } | null {
  if (machinePrimary) return null;
  return {
    holderId: sandboxLeaseHolderIdForAttempt(attemptId),
    sandboxGroupId,
  };
}

/**
 * Bind backend-aware runtime settings to the route that will actually execute.
 *
 * A machine-home turn keeps `selfhosted` as its durable policy. After an
 * explicit clear-to-default, however, both the ownership-inverted path and the
 * legacy SDK-owned path must construct manifests and clients for the resolved
 * managed group backend. Machine-primary and ordinary session routes preserve
 * their existing settings object.
 */
export function sandboxSettingsForRoute(input: {
  runSettings: Settings;
  machinePrimary: boolean;
  groupBoxBackend: Settings["sandboxBackend"];
}): Settings {
  return input.runSettings.sandboxBackend === "selfhosted" &&
    !input.machinePrimary &&
    input.groupBoxBackend !== "selfhosted"
    ? { ...input.runSettings, sandboxBackend: input.groupBoxBackend }
    : input.runSettings;
}

/** A sandboxless home still establishes an explicitly attached Connected Machine. */
export function shouldEstablishSandboxForTurn(
  sandboxOwnershipEnabled: boolean,
  homeBackend: Settings["sandboxBackend"],
  machinePrimary: boolean,
): boolean {
  return sandboxOwnershipEnabled && (homeBackend !== "none" || machinePrimary);
}

export function sandboxEstablishPolicyDecision(input: {
  lazyEnabled: boolean;
  machinePrimary: boolean;
  sandboxBackend: Settings["sandboxBackend"];
  hasRunCredentialResolver: boolean;
  generatedVideoFileCount: number;
  hasSignedFileResources: boolean;
}): { policy: "eager" | "on-demand"; reason: TurnSandboxEstablishReason } {
  if (!input.lazyEnabled) return { policy: "eager", reason: "lazy_disabled" };
  if (input.machinePrimary) return { policy: "eager", reason: "machine_primary" };
  if (input.sandboxBackend === "none") return { policy: "eager", reason: "backend_none" };
  if (input.generatedVideoFileCount > 0) {
    return { policy: "eager", reason: "generated_video_files" };
  }
  // Signed file downloads must finish before the first model boundary so any
  // integrity/download failure is present in the prepared input. Deferring the
  // box until the first tool call would make that first request advertise a
  // path whose materialization outcome is not known yet.
  if (input.hasSignedFileResources) {
    return { policy: "eager", reason: "signed_file_resources" };
  }
  // Merely having a host run-credential resolver is not proof that this turn
  // will use the sandbox. Resolve its attempt-bound material before model input
  // so auth-needed context remains deterministic, but defer every sandbox
  // write, lease, renewal, and cleanup action to the first-operation
  // provisioner. The eager file paths above remain unchanged.
  if (input.hasRunCredentialResolver) {
    return { policy: "on-demand", reason: "initial_run_credentials_deferred" };
  }
  return { policy: "on-demand", reason: "eligible" };
}

/**
 * A repository turn prepares its managed box in the background (see
 * `shouldPrepareManagedSandboxInBackground`). Starting the managed-box
 * establish as soon as its inputs exist lets the provider create overlap
 * tools/history/agent; `get()` still owns clone/setup after `buildAgent`.
 *
 * Do not flip those turns to eager: that serializes create BEFORE tools and
 * increases first-token latency. Chat-only turns without a repository still
 * never create a box. Portable `/compact` returns before this path. Connected
 * Machines and `backend: none` have no managed Modal/docker create to overlap.
 */
export function shouldPrefetchManagedSandbox(input: {
  establishPolicy: "eager" | "on-demand";
  machinePrimary: boolean;
  groupBoxBackend: Settings["sandboxBackend"];
  hasRepositoryResources: boolean;
  /** A committed automatic post-loss recovery decision still awaits its box.
   * Rematerialize now instead of leaving the group pinned until a tool call. */
  automaticRecoveryPending?: boolean;
}): boolean {
  if (input.establishPolicy !== "on-demand") return false;
  if (input.machinePrimary) return false;
  if (input.groupBoxBackend === "none" || input.groupBoxBackend === "selfhosted") {
    return false;
  }
  return input.hasRepositoryResources || input.automaticRecoveryPending === true;
}

/**
 * A repository turn on a lazily provisioned managed box prepares that box
 * (create, environment setup, repository clone) in the background instead of
 * in front of the first model request. Only repository skill indexing used to
 * reach the box before the model ran; that index now waits only for a box that
 * was already warm. The first sandbox tool call joins the same preparation.
 */
export function shouldPrepareManagedSandboxInBackground(input: {
  establishPolicy: "eager" | "on-demand";
  machinePrimary: boolean;
  groupBoxBackend: Settings["sandboxBackend"];
  hasRepositoryResources: boolean;
}): boolean {
  return (
    input.hasRepositoryResources &&
    shouldPrefetchManagedSandbox({
      establishPolicy: input.establishPolicy,
      machinePrimary: input.machinePrimary,
      groupBoxBackend: input.groupBoxBackend,
      hasRepositoryResources: true,
    })
  );
}

/**
 * Classify a persisted active-sandbox pointer for TURN-START RECONCILE (issue #341
 * invariant B). Returns the typed reason to RESET the pointer to the session HOME,
 * or null to leave it in place. STRUCTURAL unestablishability only:
 *   - no record → the pointed-at sandbox row is gone (`stale_pointer`);
 *   - an unestablishable kind (a non-group Modal sibling, or an unknown backend) per
 *     the SHARED `swapTargetEstablishability` predicate (`unsupported_backend_context`);
 *   - a selfhosted sandbox with no enrollment id to address (`offline_enrollment`).
 * A selfhosted sandbox WITH an enrollment is deliberately left in place even when it
 * is momentarily offline: the machine may recover mid-turn and its ops surface
 * agent_offline lazily, so the user's explicit machine target is never abandoned for
 * a transient control-plane blip (that is #339's concern, not this one).
 */
export function pointerReconcileReason(
  record: { kind: string; enrollmentId: string | null } | null,
): BackendUnresolvableCode | null {
  if (!record) {
    return "stale_pointer";
  }
  const establishable = swapTargetEstablishability({
    kind: record.kind,
    isSessionGroup: false,
  });
  if (!establishable.ok) {
    return establishable.code;
  }
  if (record.kind === "selfhosted" && !record.enrollmentId) {
    return "offline_enrollment";
  }
  return null;
}

/** The active pointer + its sandbox row, loaded once at turn start and threaded
 *  through the reconcile so the establish branch reads the SAME (possibly reset)
 *  values with no second query. */
export type LoadedActivePointer = {
  pointer: ActiveSandboxPointer | null;
  record: SandboxRecord | null;
};

/**
 * TURN-START RECONCILE (issue #341 invariant B / Shapes 1+2). If the persisted pointer's
 * target is STRUCTURALLY unestablishable ({@link pointerReconcileReason}) reset the pointer
 * to the session HOME (null) under the epoch fence, emit a VISIBLE `session.route.reconciled`
 * event, and return the reconciled pointer/record so the rest of the turn runs on home. NEVER
 * a silent downgrade. Bounded to ONE attempt: a lost CAS means a concurrent user swap won a
 * higher epoch, so re-read + honor it rather than clobber a newer, user-directed pointer. The
 * event publish is best-effort — a publish failure never fails the turn.
 *
 * FAIL-CLOSED on a lookup failure: the sandbox row is fetched HERE via the caller's
 * NON-swallowing `loadRecord`, so a null decision means the row is genuinely absent, never a
 * suppressed transient DB error. If `loadRecord`, the reset CAS or the re-read THROWS, the
 * error propagates: the pointer is left UNTOUCHED (no CAS, no event) AND the turn does not
 * start on the group box while its pointer still names another sandbox. The attempt stops
 * before any box is touched and is retried. A TRANSIENT LOOKUP FAILURE MUST NEVER MUTATE THE
 * POINTER, AND MUST NEVER PICK THE ROUTE.
 */
export async function reconcileActiveSandboxPointer(
  db: ActivityServices["db"],
  ids: { accountId: string; workspaceId: string; sessionId: string },
  pointer: ActiveSandboxPointer | null,
  loadRecord: (sandboxId: string) => Promise<SandboxRecord | null>,
  publish?: (events: Array<{ type: SessionEventType; payload: unknown }>) => Promise<void> | void,
): Promise<LoadedActivePointer> {
  if (!pointer?.activeSandboxId) {
    return { pointer, record: null };
  }
  // Re-fetch the row WITHOUT error swallowing. A throw here (a transient DB blip) is NOT
  // "row absent": it propagates, leaving the pointer untouched and the route undecided.
  const record = await loadRecord(pointer.activeSandboxId);
  const reason = pointerReconcileReason(record);
  if (!reason) {
    return { pointer, record };
  }
  const fromEpoch = pointer.activeEpoch;
  const reset = await setActiveSandbox(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: ids.sessionId,
    targetSandboxId: null,
    expectedEpoch: fromEpoch,
  });
  if (reset.swapped && reset.pointer) {
    await Promise.resolve(
      publish?.([
        {
          type: "session.route.reconciled",
          payload: { reason, fromEpoch, toEpoch: reset.pointer.activeEpoch },
        },
      ]),
    ).catch(() => undefined);
    return { pointer: reset.pointer, record: null };
  }
  // The fence was lost: a concurrent higher-epoch swap won. Honor the newer pointer and its
  // record (a failed read propagates like the first one; we did not win the CAS, so nothing
  // was mutated).
  const reread = await readTurnRouteFact(() =>
    readActiveSandbox(db, ids.workspaceId, ids.sessionId),
  );
  if (!reread) {
    return { pointer: null, record: null };
  }
  const rereadRecord = reread.activeSandboxId ? await loadRecord(reread.activeSandboxId) : null;
  return { pointer: reread, record: rereadRecord };
}

export async function ensureTurnModalRegistryImage(
  runSettings: Settings,
  sandboxCreationBackend: Settings["sandboxBackend"] | undefined,
  ensureRegistryImage: (settings: Settings) => Promise<void> = ensureModalRegistryImage,
): Promise<void> {
  if (sandboxCreationBackend !== "modal") {
    return;
  }
  if (runSettings.modalImageId) {
    return;
  }
  if (!runSettings.modalImageRegistrySecret || !runSettings.modalImageRef) {
    return;
  }
  await ensureRegistryImage(runSettings);
}

export const SANDBOX_ARTIFACT_RUNTIME_MANIFEST = "/opt/opengeni/artifact-runtime/installation.json";
export const SANDBOX_ARTIFACT_TOOL_ENTRY = "/opt/opengeni/artifact-runtime/skill-facade-entry.mjs";

export type SandboxArtifactRuntimeAdmission = Readonly<{
  available: boolean;
  environment: Readonly<Record<string, string>>;
}>;

export function sandboxArtifactRuntimeAdmission(
  deploymentSettings: Settings,
  runSettings: Settings,
  backend: Settings["sandboxBackend"] | undefined,
  options: Readonly<{ production?: boolean }> = {},
): SandboxArtifactRuntimeAdmission {
  if (!deploymentSettings.sandboxArtifactRuntimeEnabled) {
    return { available: false, environment: {} };
  }
  const production = options.production ?? process.env.NODE_ENV === "production";
  if (backend === "docker") {
    const image = deploymentSettings.dockerImage;
    const localDevelopmentImage = /^opengeni-sandbox:local-[0-9a-f]{12}$/u.test(image);
    if (
      runSettings.dockerImage !== image ||
      (!/@sha256:[0-9a-f]{64}$/u.test(image) && (production || !localDevelopmentImage))
    ) {
      return { available: false, environment: {} };
    }
  } else if (backend === "modal") {
    if (
      !deploymentSettings.modalImageRef ||
      !/@sha256:[0-9a-f]{64}$/u.test(deploymentSettings.modalImageRef) ||
      runSettings.modalImageRef !== deploymentSettings.modalImageRef ||
      runSettings.modalImageId !== deploymentSettings.modalImageId
    ) {
      return { available: false, environment: {} };
    }
  } else {
    return { available: false, environment: {} };
  }
  return {
    available: true,
    environment: {
      OPENGENI_ARTIFACT_RUNTIME_MANIFEST: SANDBOX_ARTIFACT_RUNTIME_MANIFEST,
      OPENGENI_ARTIFACT_TOOL_ENTRY: SANDBOX_ARTIFACT_TOOL_ENTRY,
    },
  };
}
