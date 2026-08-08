import {
  ModalImageSelector,
  ModalSandboxClient,
  type ModalSandboxSession,
  type ModalSandboxSessionState,
} from "@openai/agents-extensions/sandbox/modal";
import type { SandboxDirectoryEntry } from "@openai/agents/sandbox";
import { effectiveModalIdleTimeoutSeconds } from "@opengeni/config";
import type { Settings } from "@opengeni/config";
import {
  canonicalModalCheckpointProviderBinding,
  type ModalCheckpointProviderBinding,
} from "@opengeni/contracts";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxChannelAService, type ChannelASession } from "../channel-a";
import { SandboxConfigError } from "../errors";
import {
  REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE,
  providerWorkspacePersistence,
  type ProviderRegistration,
} from "./types";

export type { ModalCheckpointProviderBinding } from "@opengeni/contracts";

const MODAL_ORPHAN_SWEEP_LIMIT = 50;
const OPENGENI_MODAL_SDK_VERSION = "0.9.0";
const MODAL_LIST_DIR_MAX_ENTRIES = 20_000;
// A provider box is invisible to the lease until Modal create + manifest
// materialization returns and the creation callback records its instance id.
// Production baseline (2026-07-15, all 8 turn workers): 155/155 completed creates
// finished under 10s (154 under 2.5s). Two minutes is a 12x observed-max buffer,
// while avoiding the former 30-minute retention of boxes abandoned by a rolling
// worker restart. The live-instance guard below remains authoritative: once a box
// is recorded by any lease, age and missing/stale tags can never terminate it.
const MODAL_UNATTRIBUTED_ORPHAN_GRACE_MS = 2 * 60_000;

export type ModalSandboxAttribution = {
  leaseId: string;
  workspaceId: string;
  sandboxGroupId: string;
};

export type LiveModalSandboxLeaseAttribution = ModalSandboxAttribution & {
  instanceId: string | null;
  liveness?: string;
};

export type ModalOrphanSweepTermination = {
  sandboxId: string;
  reason: "stale_attribution" | "unattributed";
  tags: Record<string, string>;
};

export type ModalOrphanSweepResult = {
  examined: number;
  terminated: ModalOrphanSweepTermination[];
  skipped: number;
};

export type RevalidateModalOrphanTermination = (
  candidate: ModalOrphanSweepTermination,
) => Promise<boolean>;

export function modalSandboxAttributionEnvironment(
  input: ModalSandboxAttribution,
): Record<string, string> {
  return {
    OPENGENI_SANDBOX_LEASE_ID: input.leaseId,
    OPENGENI_SANDBOX_GROUP_ID: input.sandboxGroupId,
    OPENGENI_WORKSPACE_ID: input.workspaceId,
  };
}

export function modalSandboxAttributionTags(
  input: ModalSandboxAttribution,
): Record<string, string> {
  return {
    opengeni: "true",
    opengeni_lease_id: input.leaseId,
    opengeni_workspace_id: input.workspaceId,
    opengeni_sandbox_group_id: input.sandboxGroupId,
  };
}

type MutableModalSnapshotSandbox = {
  detach?: () => void;
  snapshotFilesystem?: (...args: unknown[]) => Promise<unknown>;
  snapshotDirectory?: (...args: unknown[]) => Promise<unknown>;
};

type ModalWorkspaceCaptureOptions = {
  requestId: string;
};

type MutableModalSandboxSession = {
  modal?: {
    version?: () => string;
    sandboxes?: {
      fromId?: (sandboxId: string) => Promise<MutableModalSnapshotSandbox>;
    };
  };
  sandbox?: MutableModalSnapshotSandbox;
  state?: {
    sandboxId?: string;
    manifest?: { root?: string };
    workspacePersistence?: string;
    snapshotFilesystemTimeoutMs?: number;
  };
  execCommand?: ChannelASession["execCommand"];
  cancelPendingExecCommand?: () => Promise<void>;
  readFile?: ChannelASession["readFile"];
  listDir?: (args: { path: string; runAs?: string }) => Promise<SandboxDirectoryEntry[]>;
  persistWorkspace?: (options?: ModalWorkspaceCaptureOptions) => Promise<Uint8Array>;
  writeStdin?: (args: {
    sessionId: number;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<string>;
};

const modalRetentionWrappedSessions = new WeakSet<object>();
const modalFilesystemRetentionWrappedSandboxes = new WeakSet<object>();
const modalDirectoryRetentionWrappedSandboxes = new WeakSet<object>();
const modalSnapshotRequestIds = new WeakMap<object, string>();
const modalDirectorySnapshotTimeouts = new WeakMap<object, number | undefined>();
const MODAL_TURN_SHELL_MARKER = "/tmp/opengeni-turn-shell/";

type ModalPendingExecStart = {
  sandbox: MutableModalSnapshotSandbox | null;
  cancellationRequested: boolean;
};

type ModalExecCancellationState = {
  pending: Set<ModalPendingExecStart>;
  cancellation: Promise<void> | null;
};

function modalWorkspaceRelativePath(path: string, workspaceRoot: string): string {
  if (!path.startsWith("/")) return path;
  const root = workspaceRoot.replace(/\/+$/, "") || "/";
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === root) return "";
  if (root === "/") return normalized.slice(1);
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  throw new Error(`Modal listDir path is outside the workspace root: ${path}`);
}

function modalWorkspaceAbsolutePath(path: string, workspaceRoot: string): string {
  const root = workspaceRoot.replace(/\/+$/, "") || "/";
  if (!path) return root;
  return root === "/" ? `/${path}` : `${root}/${path}`;
}

function installModalListDirCompatibility(session: MutableModalSandboxSession): void {
  if (typeof session.listDir === "function") return;
  if (typeof session.execCommand !== "function" || typeof session.readFile !== "function") return;
  const workspaceRoot = session.state?.manifest?.root;
  if (!workspaceRoot) {
    throw new Error("Modal listDir compatibility requires a manifest workspace root");
  }
  session.listDir = async (args) => {
    const absoluteResultPaths = args.path.startsWith("/");
    const relativePath = modalWorkspaceRelativePath(args.path, workspaceRoot);
    const service = new SandboxChannelAService({
      session: session as ChannelASession,
      workspaceRoot,
      ...(args.runAs ? { runAs: args.runAs } : {}),
    });
    const listed = await service.fsList({
      path: relativePath,
      depth: 1,
      maxEntries: MODAL_LIST_DIR_MAX_ENTRIES,
      includeHidden: true,
    });
    if (listed.truncated || listed.root.truncated) {
      throw new Error(
        `Modal listDir exceeded the ${MODAL_LIST_DIR_MAX_ENTRIES}-entry safety bound`,
      );
    }
    return (listed.root.children ?? []).map((entry) => ({
      name: entry.name,
      path: absoluteResultPaths
        ? modalWorkspaceAbsolutePath(entry.path, workspaceRoot)
        : entry.path,
      type: entry.type === "file" || entry.type === "dir" ? entry.type : "other",
    }));
  };
}

const MODAL_EXEC_STDIN_WRITE_PATH =
  "/modal.task_command_router.TaskCommandRouter/TaskExecStdinWrite";
const MODAL_EXEC_ALREADY_COMPLETED_DETAILS =
  /^Exec has already completed; stdin is no longer accepting writes(?: \(Error code: [A-Z0-9]+\))?$/;

/**
 * Modal proves that the exact exec has already terminated with a typed
 * FAILED_PRECONDITION from its stdin-write RPC. Keep this deliberately
 * structural and exact: other FAILED_PRECONDITION errors are not process
 * lifetime authority.
 */
export function isModalExecAlreadyCompletedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    name?: unknown;
    path?: unknown;
    code?: unknown;
    details?: unknown;
  };
  return (
    record.name === "ClientError" &&
    record.path === MODAL_EXEC_STDIN_WRITE_PATH &&
    record.code === 9 &&
    typeof record.details === "string" &&
    MODAL_EXEC_ALREADY_COMPLETED_DETAILS.test(record.details)
  );
}

function assertPinnedModalSdk(session: MutableModalSandboxSession): void {
  const actualVersion = session.modal?.version?.();
  if (actualVersion !== OPENGENI_MODAL_SDK_VERSION) {
    throw new Error(
      `OpenGeni Modal snapshot compatibility requires modal@${OPENGENI_MODAL_SDK_VERSION}; ` +
        `the active session reported ${actualVersion ?? "no version"}`,
    );
  }
}

function installModalNativeSnapshotRetention(session: MutableModalSandboxSession): void {
  const persistence = session.state?.workspacePersistence;
  if (persistence !== "snapshot_filesystem" && persistence !== "snapshot_directory") {
    return;
  }
  const sandbox = session.sandbox;
  if (!sandbox || typeof sandbox !== "object") {
    throw new Error(`Modal ${persistence} persistence has no active provider sandbox`);
  }

  if (persistence === "snapshot_filesystem") {
    if (modalFilesystemRetentionWrappedSandboxes.has(sandbox)) return;
    const snapshotFilesystem = sandbox.snapshotFilesystem;
    if (typeof snapshotFilesystem !== "function") {
      throw new Error("Modal snapshot_filesystem persistence is unavailable");
    }
    // Agents Extensions 0.13.x still invokes the Modal 0.7 positional timeout
    // signature. Modal 0.9 moved timeout into an options object and changed the
    // default Image retention from indefinite to 30 days. Translate at the
    // provider boundary and retain the Image until OpenGeni's artifact ledger
    // proves it unreferenced and garbage-collects its exact provider id.
    sandbox.snapshotFilesystem = async (legacyParams?: unknown) => {
      if (legacyParams !== undefined && typeof legacyParams !== "number") {
        throw new Error("Unexpected Modal snapshot_filesystem adapter call shape");
      }
      const requestId = modalSnapshotRequestIds.get(session);
      if (!requestId) {
        throw new Error("Modal native workspace capture requires a durable request id");
      }
      return await snapshotFilesystem.call(sandbox, {
        ...(legacyParams === undefined ? {} : { timeoutMs: legacyParams }),
        ttlMs: null,
        snapshotId: requestId,
      });
    };
    modalFilesystemRetentionWrappedSandboxes.add(sandbox);
    return;
  }

  if (modalDirectoryRetentionWrappedSandboxes.has(sandbox)) return;
  const snapshotDirectory = sandbox.snapshotDirectory;
  if (typeof snapshotDirectory !== "function") {
    throw new Error("Modal snapshot_directory persistence is unavailable");
  }
  sandbox.snapshotDirectory = async (path?: unknown, legacyParams?: unknown) => {
    if (typeof path !== "string" || legacyParams !== undefined) {
      throw new Error("Unexpected Modal snapshot_directory adapter call shape");
    }
    const requestId = modalSnapshotRequestIds.get(session);
    if (!requestId) {
      throw new Error("Modal native workspace capture requires a durable request id");
    }
    // Own both timeout and caller id at the provider boundary. The wrapper
    // around persistWorkspace temporarily disables Agents SDK 0.13.3's second,
    // outer timeout; otherwise an old timed-out caller can later delete the same
    // idempotent Image after a recovered caller has already published it.
    const timeoutMs = modalDirectorySnapshotTimeouts.get(session);
    return await snapshotDirectory.call(sandbox, path, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ttlMs: null,
      snapshotId: requestId,
    });
  };
  modalDirectoryRetentionWrappedSandboxes.add(sandbox);
}

function installModalExecCompletionRecovery(session: MutableModalSandboxSession): void {
  const writeStdin = session.writeStdin;
  if (typeof writeStdin !== "function") return;
  session.writeStdin = async (args) => {
    try {
      return await writeStdin.call(session, args);
    } catch (error) {
      if (
        !isModalExecAlreadyCompletedError(error) ||
        !Number.isSafeInteger(args.sessionId) ||
        args.sessionId <= 0
      ) {
        throw error;
      }
      // Agents Extensions checks its local active-process map before writing,
      // but the process can finish before Modal receives TaskExecStdinWrite.
      // An empty retry performs no side effect: it lets the adapter observe the
      // already-terminal process, delete its stale map entry, and return the
      // ordinary exact exit banner consumed by OpenGeni's durable settlement.
      // If that cleanup poll itself loses transport, the original typed
      // completion is still authoritative and the canonical lost-session
      // result lets OpenGeni close the exact retained process without failing
      // the turn or replaying stdin.
      try {
        return await writeStdin.call(session, { ...args, chars: "" });
      } catch {
        return `write_stdin failed: session not found: ${args.sessionId}`;
      }
    }
  };
}

function installModalPendingExecCancellation(session: MutableModalSandboxSession): void {
  if (session.cancelPendingExecCommand) return;
  if (
    typeof session.execCommand !== "function" ||
    typeof session.sandbox?.detach !== "function" ||
    typeof session.modal?.sandboxes?.fromId !== "function" ||
    !session.state?.sandboxId
  ) {
    return;
  }
  const state: ModalExecCancellationState = {
    pending: new Set(),
    cancellation: null,
  };
  const execCommand = session.execCommand.bind(session);
  session.execCommand = async (args) => {
    const command =
      args && typeof args === "object" && typeof (args as { cmd?: unknown }).cmd === "string"
        ? (args as { cmd: string }).cmd
        : null;
    if (!command?.includes(MODAL_TURN_SHELL_MARKER)) {
      return await execCommand(args);
    }

    // A yielded ContainerProcess owns its command-router connection. Give each
    // turn-owned start a separate handle so aborting a stuck TaskExecStart can
    // never break stdin/control for an older, already-yielded command.
    const pending: ModalPendingExecStart = {
      sandbox: null,
      cancellationRequested: false,
    };
    state.pending.add(pending);
    try {
      const sandbox = await session.modal!.sandboxes!.fromId!(session.state!.sandboxId!);
      pending.sandbox = sandbox;
      if (pending.cancellationRequested) {
        sandbox.detach?.();
        throw new Error("Modal exec start was cancelled before provider yield");
      }
      session.sandbox = sandbox;
      return await execCommand(args);
    } finally {
      state.pending.delete(pending);
    }
  };

  session.cancelPendingExecCommand = async () => {
    if (!state.cancellation) {
      state.cancellation = (async () => {
        const pendingStarts = [...state.pending];
        const detached = new Set<MutableModalSnapshotSandbox>();
        for (const start of pendingStarts) {
          start.cancellationRequested = true;
          if (start.sandbox) {
            start.sandbox.detach?.();
            detached.add(start.sandbox);
          }
        }
        // Keep the session usable for the token/PGID proof helper. Handles for
        // already-yielded commands were removed from `pending` and stay open.
        if (session.sandbox && detached.has(session.sandbox)) {
          const replacement = await session.modal!.sandboxes!.fromId!(session.state!.sandboxId!);
          if (session.sandbox && detached.has(session.sandbox)) {
            session.sandbox = replacement;
            installModalNativeSnapshotRetention(session);
          } else {
            replacement.detach?.();
          }
        }
      })().finally(() => {
        state.cancellation = null;
      });
    }
    await state.cancellation;
  };
}

/**
 * Bridge the pinned Agents Extensions Modal adapter to Modal 0.9's provider
 * contracts. The wrapper re-checks the private provider sandbox on every
 * capture because snapshot_filesystem hydration replaces that object.
 */
export function installOpenGeniModalSnapshotPolicy<T extends object>(session: T): T {
  const mutable = session as MutableModalSandboxSession;
  if (modalRetentionWrappedSessions.has(session)) return session;
  if (typeof mutable.persistWorkspace !== "function") {
    throw new Error("Modal session does not expose workspace persistence");
  }
  assertPinnedModalSdk(mutable);
  installModalListDirCompatibility(mutable);
  installModalNativeSnapshotRetention(mutable);
  installModalExecCompletionRecovery(mutable);
  installModalPendingExecCancellation(mutable);

  const persistWorkspace = mutable.persistWorkspace.bind(session);
  mutable.persistWorkspace = async (options?: ModalWorkspaceCaptureOptions) => {
    assertPinnedModalSdk(mutable);
    installModalNativeSnapshotRetention(mutable);
    if (
      (mutable.state?.workspacePersistence === "snapshot_filesystem" ||
        mutable.state?.workspacePersistence === "snapshot_directory") &&
      (!options ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          options.requestId,
        ))
    ) {
      throw new Error("Modal native workspace capture requires a valid UUID request id");
    }
    const nativePersistence =
      mutable.state?.workspacePersistence === "snapshot_filesystem" ||
      mutable.state?.workspacePersistence === "snapshot_directory";
    if (options && nativePersistence) {
      modalSnapshotRequestIds.set(session, options.requestId);
    }
    const directoryTimeout =
      mutable.state?.workspacePersistence === "snapshot_directory"
        ? mutable.state.snapshotFilesystemTimeoutMs
        : undefined;
    const directoryTimeoutWasPresent =
      mutable.state?.workspacePersistence === "snapshot_directory" &&
      Object.hasOwn(mutable.state, "snapshotFilesystemTimeoutMs");
    if (mutable.state?.workspacePersistence === "snapshot_directory") {
      modalDirectorySnapshotTimeouts.set(session, directoryTimeout);
      // The wrapped provider call above owns this exact timeout. Disable the
      // SDK's lossy late-result deletion race for the duration of this exclusive
      // capture, then restore the serialized session field byte-for-byte.
      delete mutable.state.snapshotFilesystemTimeoutMs;
    }
    try {
      return await persistWorkspace();
    } finally {
      modalSnapshotRequestIds.delete(session);
      if (mutable.state?.workspacePersistence === "snapshot_directory") {
        if (directoryTimeoutWasPresent) {
          Reflect.set(mutable.state, "snapshotFilesystemTimeoutMs", directoryTimeout);
        } else {
          delete mutable.state.snapshotFilesystemTimeoutMs;
        }
        modalDirectorySnapshotTimeouts.delete(session);
      }
    }
  };
  modalRetentionWrappedSessions.add(session);
  return session;
}

export class OpenGeniModalSandboxClient extends ModalSandboxClient {
  readonly #snapshotFilesystemTimeoutMs: number | undefined;

  constructor(...args: ConstructorParameters<typeof ModalSandboxClient>) {
    super(...args);
    this.#snapshotFilesystemTimeoutMs = args[0]?.snapshotFilesystemTimeoutMs;
  }

  override async create(
    args?: Parameters<ModalSandboxClient["create"]>[0],
    manifestOptions?: Parameters<ModalSandboxClient["create"]>[1],
  ): Promise<ModalSandboxSession> {
    const session = await super.create(args, manifestOptions);
    return installOpenGeniModalSnapshotPolicy(session);
  }

  override async resume(state: ModalSandboxSessionState): Promise<ModalSandboxSession> {
    // Snapshot timeout is an operator-controlled execution budget, not durable
    // provider identity. Older resume envelopes legitimately retain the value
    // that was current when the box was created; letting that stale value win
    // makes a later production increase ineffective exactly when a large
    // workspace needs it. Rebind only this operational field while preserving
    // every provider-identity and filesystem field byte-for-byte.
    const effectiveState =
      this.#snapshotFilesystemTimeoutMs === undefined ||
      state.snapshotFilesystemTimeoutMs === this.#snapshotFilesystemTimeoutMs
        ? state
        : {
            ...state,
            snapshotFilesystemTimeoutMs: this.#snapshotFilesystemTimeoutMs,
          };
    const session = await super.resume(effectiveState);
    return installOpenGeniModalSnapshotPolicy(session);
  }
}

export const modalProvider: ProviderRegistration = {
  backend: "modal",
  exactResumeMode: "ordinary",
  instanceIdFields: ["sandboxId"],
  workspaceCapturePolicy(state) {
    const persistence = providerWorkspacePersistence(state);
    if (persistence === "snapshot_filesystem" || persistence === "snapshot_directory") {
      return {
        takeover: "same_request",
        strategy: "configured",
        liveInstance: "preserved",
      };
    }
    return REPEATABLE_CONFIGURED_WORKSPACE_CAPTURE;
  },
  descriptor: CAPABILITY_DESCRIPTORS.modal,
  validateCredentials(settings) {
    // both-or-neither (preserves existing validation at config validateSettings).
    if (Boolean(settings.modalTokenId) !== Boolean(settings.modalTokenSecret)) {
      throw new SandboxConfigError(
        "modal",
        "OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted",
      );
    }
    if (!settings.modalAppName) {
      throw new SandboxConfigError("modal", "OPENGENI_MODAL_APP_NAME is required");
    }
    if (settings.modalImageId && !settings.modalImageRef) {
      throw new SandboxConfigError(
        "modal",
        "OPENGENI_MODAL_IMAGE_ID requires OPENGENI_MODAL_IMAGE_REF for logical image provenance",
      );
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof ModalSandboxClient>[0]> = {
      appName: settings.modalAppName,
      timeoutMs: settings.modalTimeoutSeconds * 1000,
      sandboxCreateTimeoutS: Math.ceil(settings.sandboxWarmingTimeoutMs / 1000),
      // The Agents Extensions session persists this value in its provider
      // state and passes it to persistWorkspace(). Keep it aligned with the
      // same current setting that bounds OpenGeni's outer capture operation.
      snapshotFilesystemTimeoutMs: settings.sandboxSnapshotTimeoutMs,
      exposedPorts,
      env: environment,
      // A registry image's own CMD is not a sandbox keepalive contract (for
      // example, python:3.12-slim can exit immediately). Keep the provider's
      // control process alive so exec/resume remains available; Modal's hard
      // timeout and explicit OpenGeni teardown still own the box lifetime.
      useSleepCmd: true,
    };
    // gap-fill (module 03 §4.1): these SDK options were previously unmapped.
    // ALWAYS pin idleTimeoutMs (sandbox-file-persistence): an UNSET idle timeout
    // lets the SDK send idleTimeoutSecs=undefined, so Modal applies its short
    // server-default idle-reap and kills an idle (between-turns) box LONG before
    // OpenGeni's reaper can resume+snapshot it. effectiveModalIdleTimeoutSeconds
    // defaults this to the hard lifetime so the box survives its full warm window
    // and the reaper — not Modal's idle-reap — governs teardown (and snapshots
    // /workspace first).
    options.idleTimeoutMs = effectiveModalIdleTimeoutSeconds(settings) * 1000;
    if (settings.modalWorkspacePersistence) {
      options.workspacePersistence = settings.modalWorkspacePersistence;
    }
    const imageSelector = resolveModalImageSelector(settings);
    if (imageSelector) {
      options.image = imageSelector;
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
    return new OpenGeniModalSandboxClient(options);
  },
};

type ModalModule = typeof import("modal");
type ModalClientLike = InstanceType<ModalModule["ModalClient"]>;

// --- Modal provider-native / private-registry image resolution --------------------
//
// OPENGENI_MODAL_IMAGE_ID is the preferred immutable provider-native path. The
// Agents extension resolves it with ModalImageSelector.fromId and serializes the
// actual imageId into the session state, while modalImageRef remains the logical
// digest persisted on the OpenGeni lease.
//
// The Agents-extension Modal backend resolves `modalImageRef` via
// `Image.fromRegistry(tag)` with NO secret, so it can only pull PUBLIC images. To run
// a PRIVATE image we resolve the named Modal Secret and pre-build the authenticated
// `fromRegistry(tag, secret)` image ONCE per process, then hand the provider `build`
// a `ModalImageSelector.fromImage(...)`. `build` is synchronous and modal is imported
// lazily (never loaded for non-modal backends), so resolution can't happen inside
// `build`; the worker awaits `ensureModalRegistryImage` at boot for global refs and
// at turn time for pack-scoped refs, then `build` reads the settled result. Modal
// images are lazy, workspace-scoped definitions, so an image built by this module's
// client is usable by the ModalSandboxClient's own client.

/** Loader seam so unit tests can inject a fake modal module. */
export type ModalModuleLoader = () => Promise<Pick<ModalModule, "ModalClient">>;

const defaultModalLoader: ModalModuleLoader = () => import("modal");

/** Settled, synchronously-readable resolved images, keyed per config. */
const resolvedRegistryImages = new Map<string, unknown>();
/** In-flight resolutions, for cross-call de-duplication. */
const inFlightRegistryImages = new Map<string, Promise<void>>();

function registryImageCacheKey(settings: Settings): string {
  return [
    settings.modalImageRef ?? "",
    settings.modalImageRegistrySecret ?? "",
    settings.modalEnvironment ?? "",
  ].join("|");
}

/**
 * Resolve + cache the private-registry Modal image. No-op unless BOTH
 * `modalImageRef` and `modalImageRegistrySecret` are set. Memoized per
 * (imageRef, secret, environment) so it runs once per worker process. Awaited at
 * worker boot for the deployment-global image and at turn time for pack-scoped
 * images BEFORE the first sandbox using that ref is created; `build` then reads the
 * resolved image and otherwise falls back to the public `fromTag` path.
 */
export async function ensureModalRegistryImage(
  settings: Settings,
  loadModal: ModalModuleLoader = defaultModalLoader,
): Promise<void> {
  // A provider-native immutable image ID bypasses registry import entirely.
  // ModalImageSelector.fromId resolves it during sandbox creation and the
  // provider session state records that exact ID.
  if (settings.modalImageId) {
    return;
  }
  if (!settings.modalImageRegistrySecret || !settings.modalImageRef) {
    return;
  }
  const key = registryImageCacheKey(settings);
  if (resolvedRegistryImages.has(key)) {
    return;
  }
  let pending = inFlightRegistryImages.get(key);
  if (!pending) {
    pending = (async () => {
      const modal = await loadModal();
      const client = new modal.ModalClient(modalClientOptions(settings));
      // Resolve the Secret via the AUTHENTICATED client (client.secrets.fromName),
      // NOT the static `modal.Secret.fromName`, which resolves against
      // `getDefaultClient()` — i.e. the standard MODAL_TOKEN_ID/MODAL_TOKEN_SECRET env
      // or ~/.modal.toml — and so would throw "Profile is missing token_id" in any host
      // that supplies the token only through OpenGeni settings (OPENGENI_MODAL_TOKEN_ID).
      const secret = await client.secrets.fromName(
        settings.modalImageRegistrySecret!,
        settings.modalEnvironment ? { environment: settings.modalEnvironment } : undefined,
      );
      // fromRegistry is synchronous and returns a lazy image definition (built
      // server-side at sandbox create); the resolved secretId travels with it.
      const image = client.images.fromRegistry(settings.modalImageRef!, secret);
      resolvedRegistryImages.set(key, image);
    })().finally(() => {
      inFlightRegistryImages.delete(key);
    });
    inFlightRegistryImages.set(key, pending);
  }
  await pending;
}

/** The resolved private-registry image for these settings, or undefined if none. */
function cachedModalRegistryImage(settings: Settings): unknown | undefined {
  if (!settings.modalImageRegistrySecret || !settings.modalImageRef) {
    return undefined;
  }
  return resolvedRegistryImages.get(registryImageCacheKey(settings));
}

/**
 * Choose the image selector for a Modal sandbox client from settings. Returns:
 *  - `fromId(modalImageId)` when a provider-native immutable ID is configured;
 *  - `fromImage(resolved)` when a private-registry secret is configured AND the
 *    image has been resolved (ensureModalRegistryImage ran before create);
 *  - `fromTag(modalImageRef)` for the public path (no secret, or cold cache — the
 *    resume/attach paths never pull an image so the tag branch is harmless there);
 *  - `undefined` when no image ref is set (Modal uses its default image).
 * Exported for unit tests.
 */
export function resolveModalImageSelector(settings: Settings): ModalImageSelector | undefined {
  if (settings.modalImageId) {
    return ModalImageSelector.fromId(settings.modalImageId);
  }
  if (!settings.modalImageRef) {
    return undefined;
  }
  const registryImage = cachedModalRegistryImage(settings);
  return registryImage
    ? ModalImageSelector.fromImage(
        registryImage as Parameters<typeof ModalImageSelector.fromImage>[0],
      )
    : ModalImageSelector.fromTag(settings.modalImageRef);
}

/** Test-only: clear the resolved/in-flight image caches. */
export function __resetModalRegistryImageCacheForTest(): void {
  resolvedRegistryImages.clear();
  inFlightRegistryImages.clear();
}

function modalClientOptions(
  settings: Settings,
): ConstructorParameters<ModalModule["ModalClient"]>[0] {
  return {
    ...(settings.modalTokenId ? { tokenId: settings.modalTokenId } : {}),
    ...(settings.modalTokenSecret ? { tokenSecret: settings.modalTokenSecret } : {}),
    ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
  };
}

async function createModalClient(settings: Settings): Promise<ModalClientLike> {
  const modal = await import("modal");
  return new modal.ModalClient(modalClientOptions(settings));
}

function isModalNotFoundError(error: unknown): boolean {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
  };
  // The pinned Modal SDK normalizes image/sandbox NOT_FOUND and its documented
  // FAILED_PRECONDITION alias to NotFoundError. Numeric gRPC code 5 is retained
  // for narrow adapter/fake compatibility. Never classify message text: an auth,
  // workspace, DNS, or proxy error containing "not found" is not deletion proof.
  return candidate?.name === "NotFoundError" || candidate?.code === 5;
}

async function modalCheckpointProviderBindingForClient(
  settings: Settings,
  modal: ModalClientLike,
): Promise<ModalCheckpointProviderBinding> {
  const identity = await modal.cpClient.workspaceNameLookup({});
  const workspaceName = identity.workspaceName || identity.username;
  if (!workspaceName) {
    throw new Error("Modal credential resolved no workspace identity");
  }
  const resolved = canonicalModalCheckpointProviderBinding({
    version: 1,
    serverUrl: modal.profile.serverUrl,
    workspaceName,
    // Resolve through the authenticated client, not the optional OpenGeni
    // override alone. When the override is absent Modal may select a profile
    // environment; persisting "" would fail to fence a later profile change.
    environment: modal.environmentName(settings.modalEnvironment),
  });
  if (!resolved) {
    throw new Error("Modal credential resolved an invalid checkpoint provider identity");
  }
  return resolved.binding;
}

const modalSessionCheckpointBindings = new WeakMap<
  object,
  Promise<{ key: string; binding: ModalCheckpointProviderBinding }>
>();

/**
 * Resolve checkpoint ownership through the exact authenticated Modal client
 * embedded in the session that creates the snapshot. The field is private in
 * the pinned Agents extension, so this adapter is intentionally fail-closed:
 * an upstream shape change disables native publication instead of guessing
 * ownership from a newly-resolved ambient profile.
 */
export async function resolveModalCheckpointProviderBindingForSession(
  settings: Settings,
  session: unknown,
): Promise<{ key: string; binding: ModalCheckpointProviderBinding }> {
  if (!session || typeof session !== "object") {
    throw new Error("Modal checkpoint session identity is unavailable");
  }
  const cached = modalSessionCheckpointBindings.get(session);
  if (cached) return await cached;
  const modal = (session as { modal?: unknown }).modal as ModalClientLike | undefined;
  if (
    !modal ||
    typeof modal.cpClient?.workspaceNameLookup !== "function" ||
    typeof modal.profile?.serverUrl !== "string" ||
    typeof modal.environmentName !== "function"
  ) {
    throw new Error("Pinned Modal session no longer exposes its authenticated checkpoint identity");
  }
  const pending = modalCheckpointProviderBindingForClient(settings, modal).then(
    (binding) => canonicalModalCheckpointProviderBinding(binding)!,
  );
  modalSessionCheckpointBindings.set(session, pending);
  try {
    return await pending;
  } catch (error) {
    modalSessionCheckpointBindings.delete(session);
    throw error;
  }
}

/** Compare a restore receipt against the exact authenticated Modal client
 * embedded in the created session. This deliberately does not resolve a second
 * ambient client: the session that will consume the snapshot is the authority. */
export async function modalSessionMatchesCheckpointProviderBinding(
  settings: Settings,
  session: unknown,
  expectedBindingKey: string,
): Promise<boolean> {
  const identity = await resolveModalCheckpointProviderBindingForSession(settings, session);
  return identity.key === expectedBindingKey;
}

/** Resolve the authoritative Modal workspace behind the configured credential.
 * Snapshot ids are workspace-scoped; persisting this non-secret binding lets GC
 * reject a credential rotation that points at a different workspace instead of
 * issuing a destructive call under ambient credentials. */
export async function resolveModalCheckpointProviderBinding(
  settings: Settings,
  createClient: (settings: Settings) => Promise<ModalClientLike> = createModalClient,
): Promise<{ key: string; binding: ModalCheckpointProviderBinding }> {
  const modal = await createClient(settings);
  try {
    const binding = await modalCheckpointProviderBindingForClient(settings, modal);
    return canonicalModalCheckpointProviderBinding(binding)!;
  } finally {
    modal.close();
  }
}

/** Prove a legacy lease's live sandbox is visible in the same Modal namespace
 * whose identity will own the adopted checkpoint row. */
export async function resolveModalCheckpointProviderBindingForLiveSandbox(
  settings: Settings,
  sandboxId: string,
  createClient: (settings: Settings) => Promise<ModalClientLike> = createModalClient,
): Promise<{ key: string; binding: ModalCheckpointProviderBinding }> {
  if (!sandboxId) throw new Error("Modal live-sandbox identity requires a sandbox id");
  const modal = await createClient(settings);
  try {
    const binding = await modalCheckpointProviderBindingForClient(settings, modal);
    const sandbox = await modal.sandboxes.fromId(sandboxId);
    const exitCode = await sandbox.poll();
    if (exitCode !== null) {
      throw new Error(`Modal sandbox ${sandboxId} is no longer running`);
    }
    return canonicalModalCheckpointProviderBinding(binding)!;
  } finally {
    modal.close();
  }
}

/**
 * Observe one exact historical Modal sandbox without consulting the current
 * lease or its (possibly successor-owned) resume envelope. This is deliberately
 * lifecycle-only: a running sandbox does not prove whether an individual
 * retained process is still running, while a terminal/missing sandbox proves
 * that none of its processes can still execute.
 */
export async function inspectModalSandboxLifecycle(
  settings: Settings,
  sandboxId: string,
  expectedBindingKey?: string | null,
  createClient: (settings: Settings) => Promise<ModalClientLike> = createModalClient,
): Promise<
  | {
      status: "running";
      providerBindingKey: string;
      providerBinding: ModalCheckpointProviderBinding;
    }
  | {
      status: "terminated";
      exitCode: number;
      providerBindingKey: string;
      providerBinding: ModalCheckpointProviderBinding;
    }
  | {
      status: "not_found";
      providerBindingKey: string;
      providerBinding: ModalCheckpointProviderBinding;
    }
> {
  if (!sandboxId) throw new Error("Modal lifecycle inspection requires a sandbox id");
  const modal = await createClient(settings);
  try {
    const binding = canonicalModalCheckpointProviderBinding(
      await modalCheckpointProviderBindingForClient(settings, modal),
    )!;
    if (expectedBindingKey && binding.key !== expectedBindingKey) {
      throw new Error(
        "Modal lifecycle inspection refused because the configured credential workspace changed",
      );
    }
    try {
      const sandbox = await modal.sandboxes.fromId(sandboxId);
      const exitCode = await sandbox.poll();
      return exitCode === null
        ? {
            status: "running",
            providerBindingKey: binding.key,
            providerBinding: binding.binding,
          }
        : {
            status: "terminated",
            exitCode,
            providerBindingKey: binding.key,
            providerBinding: binding.binding,
          };
    } catch (error) {
      if (isModalNotFoundError(error)) {
        return {
          status: "not_found",
          providerBindingKey: binding.key,
          providerBinding: binding.binding,
        };
      }
      throw error;
    }
  } finally {
    modal.close();
  }
}

export async function deleteModalCheckpointSnapshot(
  settings: Settings,
  expectedBindingKey: string,
  snapshotId: string,
  createClient: (settings: Settings) => Promise<ModalClientLike> = createModalClient,
): Promise<"deleted" | "not_found"> {
  if (!snapshotId) throw new Error("Modal checkpoint deletion requires a snapshot id");
  // Resolve identity and delete through the same authenticated client. A cached
  // or separately-created identity probe could approve workspace A and then
  // issue the destructive call through a rotated ambient profile for workspace B.
  const modal = await createClient(settings);
  try {
    const binding = await modalCheckpointProviderBindingForClient(settings, modal);
    const identity = canonicalModalCheckpointProviderBinding(binding)!;
    if (expectedBindingKey !== identity.key) {
      throw new Error(
        "Modal checkpoint deletion refused because the configured credential workspace changed",
      );
    }
    try {
      await modal.images.delete(snapshotId);
      return "deleted";
    } catch (error) {
      if (isModalNotFoundError(error)) return "not_found";
      throw error;
    }
  } finally {
    modal.close();
  }
}

export async function tagModalSandbox(
  settings: Settings,
  sandboxId: string,
  attribution: ModalSandboxAttribution,
): Promise<boolean> {
  if (!sandboxId) {
    return false;
  }
  const modal = await createModalClient(settings);
  try {
    const sandbox = await modal.sandboxes.fromId(sandboxId);
    await sandbox.setTags(modalSandboxAttributionTags(attribution));
    return true;
  } finally {
    modal.close();
  }
}

export async function terminateModalSandboxById(
  settings: Settings,
  sandboxId: string,
): Promise<boolean> {
  if (!sandboxId) {
    return true;
  }
  const modal = await createModalClient(settings);
  try {
    const sandbox = await modal.sandboxes.fromId(sandboxId);
    await sandbox.terminate();
    return true;
  } finally {
    modal.close();
  }
}

type ModalSandboxInfo = {
  id: string;
  createdAt?: number;
  tags?: Array<{ tagName?: string; tagValue?: string }>;
};

type ModalCpListClient = ModalClientLike & {
  cpClient: {
    sandboxList(input: {
      appId?: string;
      beforeTimestamp?: number;
      environmentName?: string;
      includeFinished?: boolean;
      tags?: Array<{ tagName: string; tagValue: string }>;
    }): Promise<{ sandboxes?: ModalSandboxInfo[] }>;
  };
};

function tagsFromInfo(info: ModalSandboxInfo): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of info.tags ?? []) {
    if (typeof tag.tagName === "string" && typeof tag.tagValue === "string") {
      tags[tag.tagName] = tag.tagValue;
    }
  }
  return tags;
}

function sandboxCreatedAtMs(info: ModalSandboxInfo): number | null {
  if (
    typeof info.createdAt !== "number" ||
    !Number.isFinite(info.createdAt) ||
    info.createdAt <= 0
  ) {
    return null;
  }
  // Modal protobuf timestamps in this SDK are seconds as doubles.
  return info.createdAt < 10_000_000_000
    ? Math.floor(info.createdAt * 1000)
    : Math.floor(info.createdAt);
}

function attributionKey(
  input: Pick<ModalSandboxAttribution, "leaseId" | "workspaceId" | "sandboxGroupId">,
): string {
  return `${input.workspaceId}:${input.sandboxGroupId}:${input.leaseId}`;
}

export async function sweepModalOrphanSandboxes(
  settings: Settings,
  liveLeases: LiveModalSandboxLeaseAttribution[],
  options: {
    now?: Date;
    maxTerminations?: number;
    unattributedGraceMs?: number;
    client?: ModalClientLike;
    /** Re-read durable ownership immediately before provider termination. A
     * false result or callback failure skips the destructive action. */
    revalidateTermination?: RevalidateModalOrphanTermination;
  } = {},
): Promise<ModalOrphanSweepResult> {
  const nowMs = options.now?.getTime() ?? Date.now();
  const maxTerminations = options.maxTerminations ?? MODAL_ORPHAN_SWEEP_LIMIT;
  const unattributedGraceMs = options.unattributedGraceMs ?? MODAL_UNATTRIBUTED_ORPHAN_GRACE_MS;
  const liveByAttribution = new Map(liveLeases.map((lease) => [attributionKey(lease), lease]));
  // LIVE-INSTANCE GUARD: a box that any live lease's envelope points at is NEVER
  // an orphan, whatever its tags say. Tags are best-effort attribution (setTags
  // is a separate call after create and can fail or lag); the lease envelope is
  // the source of truth the turn path actually resumes by. Judging by tags alone
  // terminated a LIVE box mid-turn at exactly creation+30min (staging session
  // e644e8a8, 2026-07-06) — the box's unpushed work was unrecoverable because
  // nothing outside the reaper drain persists /workspace.
  const liveByInstanceId = new Map(
    liveLeases
      .filter((lease) => lease.instanceId)
      .map((lease) => [lease.instanceId as string, lease]),
  );
  const ownedClient = options.client ? null : await createModalClient(settings);
  const modal = (options.client ?? ownedClient)! as ModalCpListClient;
  try {
    const app = await modal.apps.fromName(settings.modalAppName, {
      createIfMissing: false,
      ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
    });
    const appId = app.appId;
    if (!appId) {
      return { examined: 0, terminated: [], skipped: 0 };
    }

    let examined = 0;
    let skipped = 0;
    const terminated: ModalOrphanSweepTermination[] = [];
    let beforeTimestamp: number | undefined;
    while (terminated.length < maxTerminations) {
      const response = await modal.cpClient.sandboxList({
        appId,
        ...(beforeTimestamp !== undefined ? { beforeTimestamp } : {}),
        includeFinished: false,
        ...(settings.modalEnvironment ? { environmentName: settings.modalEnvironment } : {}),
        tags: [],
      });
      const sandboxes = response.sandboxes ?? [];
      if (sandboxes.length === 0) {
        break;
      }
      for (const info of sandboxes) {
        examined += 1;
        const tags = tagsFromInfo(info);
        const leaseId = tags.opengeni_lease_id;
        const workspaceId = tags.opengeni_workspace_id;
        const sandboxGroupId = tags.opengeni_sandbox_group_id;
        const liveByInstance = info.id ? liveByInstanceId.get(info.id) : undefined;
        if (liveByInstance) {
          // Live-instance guard (see above): a live lease resumes this exact box
          // by id — hard-skip it, and HEAL its attribution tags when they are
          // missing/stale so it stops looking sweep-eligible. Best-effort: a
          // failed re-tag must never fail the sweep (the guard, not the tags,
          // is what protects the box now).
          if (
            leaseId !== liveByInstance.leaseId ||
            workspaceId !== liveByInstance.workspaceId ||
            sandboxGroupId !== liveByInstance.sandboxGroupId
          ) {
            try {
              const sandbox = await modal.sandboxes.fromId(info.id);
              await sandbox.setTags(
                modalSandboxAttributionTags({
                  leaseId: liveByInstance.leaseId,
                  workspaceId: liveByInstance.workspaceId,
                  sandboxGroupId: liveByInstance.sandboxGroupId,
                }),
              );
            } catch {
              // Tag healing is opportunistic; the instance guard already
              // protects this box on every future sweep pass.
            }
          }
          skipped += 1;
          continue;
        }
        let reason: ModalOrphanSweepTermination["reason"] | null = null;
        if (leaseId && workspaceId && sandboxGroupId) {
          const live = liveByAttribution.get(
            attributionKey({ leaseId, workspaceId, sandboxGroupId }),
          );
          if (!live || (live.instanceId && live.instanceId !== info.id)) {
            reason = "stale_attribution";
          }
        } else {
          const createdAtMs = sandboxCreatedAtMs(info);
          if (createdAtMs !== null && nowMs - createdAtMs >= unattributedGraceMs) {
            reason = "unattributed";
          }
        }

        if (!reason) {
          skipped += 1;
          continue;
        }
        const candidate = { sandboxId: info.id, reason, tags };
        let sandbox: Awaited<ReturnType<typeof modal.sandboxes.fromId>>;
        try {
          sandbox = await modal.sandboxes.fromId(info.id);
        } catch {
          skipped += 1;
          continue;
        }
        if (options.revalidateTermination) {
          try {
            if (!(await options.revalidateTermination(candidate))) {
              skipped += 1;
              continue;
            }
          } catch {
            // Destructive provider cleanup fails closed when the fresh durable
            // ownership read is unavailable or otherwise inconclusive.
            skipped += 1;
            continue;
          }
        }
        try {
          await sandbox.terminate();
          terminated.push(candidate);
        } catch {
          skipped += 1;
        }
        if (terminated.length >= maxTerminations) {
          break;
        }
      }
      beforeTimestamp = sandboxes[sandboxes.length - 1]?.createdAt;
      if (beforeTimestamp === undefined) {
        break;
      }
    }
    return { examined, terminated, skipped };
  } finally {
    ownedClient?.close();
  }
}
