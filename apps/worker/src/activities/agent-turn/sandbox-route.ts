import {
  readActiveSandbox,
  setActiveSandbox,
  type ActiveSandboxPointer,
  type SandboxRecord,
} from "@opengeni/db";
import {
  ensureModalRegistryImage,
  swapTargetEstablishability,
  type BackendUnresolvableCode,
} from "@opengeni/runtime";
import { type Settings } from "@opengeni/config";
import type { TurnActivityServices as ActivityServices } from "../types";
import {
  sandboxLeaseHolderIdForAttempt,
  type TurnSandboxLeaseHolderId,
} from "../../sandbox-resume";
import { type TurnSandboxEstablishReason } from "../../observability-metrics";
import { type SessionEventType } from "@opengeni/contracts";
import { safeErrorDiagnostic } from "./errors";

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
  try {
    const pointer = await loadPointer();
    // A null pointer (no swap) means "use the session's own cloud group box" — the
    // home backend already governs that path, so leave the override unset.
    if (!pointer?.activeSandboxId) {
      return undefined;
    }
    const kind = await loadSandboxKind(pointer.activeSandboxId);
    return kind === "selfhosted" ? "selfhosted" : undefined;
  } catch (error) {
    console.error(
      "active sandbox backend resolution failed (turn proceeds on home backend)",
      safeErrorDiagnostic(error),
    );
    return undefined;
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
 * Repo-backed workspace skills bind into the first-request prompt-cache prefix
 * (`WorkspaceSkillsCapability.instructions()` listDirs the live box). Starting
 * the managed-box establish as soon as its inputs exist lets Modal create overlap
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
}): boolean {
  if (input.establishPolicy !== "on-demand") return false;
  if (input.machinePrimary) return false;
  if (input.groupBoxBackend === "none" || input.groupBoxBackend === "selfhosted") {
    return false;
  }
  return input.hasRepositoryResources;
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
 * FAIL-OPEN on a lookup failure (issue #341 review): the sandbox row is fetched HERE via the
 * caller's NON-swallowing `loadRecord`, so a null decision means the row is genuinely absent,
 * never a suppressed transient DB error. If `loadRecord` THROWS, reconciliation is skipped
 * entirely this turn — the pointer is left UNTOUCHED (record null → the turn runs
 * machinePrimary:false on the group box exactly as before reconcile existed), no CAS, no
 * event — and the next turn retries. A TRANSIENT LOOKUP FAILURE MUST NEVER MUTATE THE POINTER.
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
  // "row absent": fail open — skip reconciliation, leave the pointer untouched.
  let record: SandboxRecord | null;
  try {
    record = await loadRecord(pointer.activeSandboxId);
  } catch {
    return { pointer, record: null };
  }
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
  }).catch(
    () => ({ swapped: false, pointer: null }) as Awaited<ReturnType<typeof setActiveSandbox>>,
  );
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
  // The fence was lost: a concurrent higher-epoch swap won. Honor the newer pointer; its
  // record is re-fetched fail-open too (a transient failure leaves record null, never a
  // mutation — we already did not win the CAS).
  const reread = await readActiveSandbox(db, ids.workspaceId, ids.sessionId).catch(() => null);
  if (!reread) {
    return { pointer, record: null };
  }
  let rereadRecord: SandboxRecord | null = null;
  if (reread.activeSandboxId) {
    try {
      rereadRecord = await loadRecord(reread.activeSandboxId);
    } catch {
      rereadRecord = null;
    }
  }
  return { pointer: reread, record: rereadRecord };
}

/**
 * Warm the Modal private-registry image for the image ref this turn actually
 * resolved, not only the deployment-global OPENGENI_MODAL_IMAGE_REF warmed at
 * worker boot. A provider-native modalImageId bypasses registry import and is
 * resolved by ModalImageSelector.fromId during create. Otherwise packs can
 * override `modalImageRef` per workspace/turn, so a private pack image must be
 * resolved before sandbox creation or Modal falls back to the unauthenticated
 * `fromTag` path.
 */
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

/**
 * Admit the optional native standalone-file runtime only for the deployment's
 * exact base sandbox image contract. A pack/rig image override is an
 * independent filesystem and therefore fails closed even when the deployment
 * base image is capable. Collaborative artifact skills are admitted separately
 * from the frozen canonical tool catalog.
 *
 * This keeps lazy provisioning intact: CI/release proves the image closure,
 * while a before-agent-start doctor verifies the actual box before any model
 * call. No speculative sandbox is created merely to populate the skill index.
 */
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

/**
 * Decide whether the first actual computer action may start a proof recording.
 *
 * On-turn recording runs ffmpeg/x11grab INSIDE the box and reads the .mp4 back
 * out of the box's /tmp — plumbing that exists only for OpenGeni-operated cloud
 * boxes (the Modal desktop backend). A turn whose EFFECTIVE backend is a connected
 * machine ("selfhosted") runs on the user's REAL computer, which has none of that
 * capture plumbing (and the platform must never shell ffmpeg onto a user's machine
 * — the same reason the runtime skips its setup hooks for selfhosted). Left ungated
 * it films nothing, finds no /tmp file, and emits recording.started followed by
 * recording.failed{box-death} on EVERY machine-primary turn — misleading timeline
 * noise + wasted work. So gate it off, exactly like a recording-disabled deployment:
 * skip silently, emit nothing (no new event shape).
 *
 * `effectiveBackend` is the resolved ACTIVE backend for the turn
 * (resolveActiveSandboxBackend) — NOT the session's home backend. A modal-home
 * session actively swapped onto a machine resolves to "selfhosted" here and
 * correctly skips; a machine-home turn that degraded back to its cloud group box
 * (swap-away / flag-off) resolves to undefined and records as before.
 *
 * EDGE — mid-turn swap: this is evaluated once when computer-use first runs. A swap
 * after recording starts is deliberately ignored; the partial recording already has
 * defined failure semantics, so there is no stop/restart machinery.
 */
