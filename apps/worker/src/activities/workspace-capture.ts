// Workbench v2 — turn-end workspace capture (dossier §10.1).
//
// The universal spine that makes the session workspace paint instantly on cold /
// offline reads: at TURN END, while the box is still guaranteed live and the
// turn's lease pins the refcount (the reaper cannot drain), we probe the box's
// CHANGED files directly off the un-proxied Channel-A session — per-repo git
// status + diff, after-images of the touched files, and a pruned tree index —
// serialize a manifest, PUT it + the after-image blobs to object storage, and
// insert an epoch-fenced `workspace_captures` row. The read path (M2/M3) serves
// this when the machine is cold/offline; a warm box always wins (capture is a
// labelled cache, never a replacement).
//
// SAFETY INVARIANTS (non-negotiable — see dossier §7.3 / §19):
//   • This module NEVER calls close()/terminate()/kill() on the session handle.
//     session.close() == terminate() on Modal and would kill the user's box.
//     Only the reaper terminates. We drop references, nothing more.
//   • The whole capture is time-capped (60s) and best-effort: an authority-proof
//     failure commits a degraded marker while the exact attempt, accepted control
//     revision, and live lease epoch still own the box; other failures only log
//     "workspace capture failed — turn outcome unaffected". Nothing escapes.
//   • Every DB write is fenced on that exact attempt, accepted control requests,
//     and lease epoch — cancelled/replaced work or a superseded lease writes zero
//     rows (insertWorkspaceCapture / insertFailedWorkspaceCapture).
//   • F9 storage ordering: blobs + manifest are PUT and the row is committed
//     BEFORE any GC delete runs.
//
// It is deliberately an EXTERNAL module with a SINGLE call-site line in
// agent-turn.ts's finally (dossier "Accepted warts" #2 — do not grow the turn
// activity). The emitted `workspace.revision.captured` event is ANNOUNCE-ONLY
// (metadata, never content) and must never gain a rendered timeline item.

import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import {
  deleteWorkspaceCaptureRows,
  insertFailedWorkspaceCapture,
  insertWorkspaceCapture,
  latestWorkspaceCapture,
  planWorkspaceCaptureGc,
} from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import type { Observability } from "@opengeni/observability";
// The un-agent-loop leaf. Constructing the Channel-A service over the un-proxied
// setupBoxSession here (NOT the routing veneer) guarantees a mid-turn
// sandbox_swap can never re-route capture execs onto a user's machine — the same
// reason the snapshot uses setupBoxSession (dossier §7.3).
import {
  SandboxChannelAService,
  type ChannelASession,
  type RepositoryDiscoveryDegradedReason,
} from "@opengeni/runtime/sandbox";
import type {
  FsReadResponse,
  FsTreeNode,
  GitFileStatus,
  GitFileStatusCode,
  SessionEvent,
  WorkspaceCaptureFile,
  WorkspaceCaptureDegradedReason,
  WorkspaceCaptureManifest,
  WorkspaceCaptureRepo,
  WorkspaceCaptureStats,
} from "@opengeni/contracts";

// ─── Guards & constants (dossier §10.1 — pathological-only; configurable) ─────
export const CAPTURE_TIMEOUT_MS = 60_000;
export const PER_FILE_CONTENT_GUARD_BYTES = 5 * 1024 * 1024; // after-image; over → tooLarge marker
export const PER_FILE_DIFF_GUARD_BYTES = 10 * 1024 * 1024; // per-file diff; over → truncated marker
export const WHOLE_CAPTURE_GUARD_BYTES = 200 * 1024 * 1024; // total → skip, fall back to live
export const KEEP_LATEST_REVISIONS = 10;
// Directories listed as collapsed nodes in the tree index but NEVER descended
// (their contents live on the machine — the Files tab wakes to expand them).
//
// Two classes:
//  • BUILD/DEP residue — huge, machine-resident, never review content.
//  • DESKTOP/SYSTEM residue (the Modal desktop-box fix): on a desktop image the
//    workspace root IS $HOME, and XFCE/dbus/etc. CONTINUOUSLY rewrite dotfiles
//    under ~/.config/xfce4, ~/.cache, ~/.dbus, … A tree walk that descends into
//    them (a) wastes the round-trip budget on churn no user is reviewing and
//    (b) races files that VANISH mid-walk. These are never workspace content, so
//    collapse them at the source. Legit hidden entries a user DOES author
//    (.gitignore, .env, .github, .vscode, .devcontainer) are deliberately NOT
//    here — they stay fully visible.
export const RESIDUE_DIRS: readonly string[] = [
  // build/dep residue
  "node_modules",
  ".git",
  // Platform credential/helper state. The workspace root can be $HOME, so this
  // directory may sit inside a root repository; it must never enter a revision.
  ".opengeni",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
  ".next",
  // desktop/system residue (never workspace content; churned by the desktop stack)
  ".config",
  ".cache",
  ".local",
  ".dbus",
  ".gnupg",
  ".ssh",
  ".mozilla",
  ".xfce4",
  ".pki",
  ".gvfs",
  ".dbus-keyrings",
  ".Xauthority",
  ".ICEauthority",
];
const RESIDUE_DIR_SET: ReadonlySet<string> = new Set(RESIDUE_DIRS);

/**
 * True when a workspace-relative FILE path lives INSIDE a residue dir — i.e. a
 * residue dir is one of its ANCESTOR segments (not the leaf), so the file is
 * churn/machine content never worth an after-image. `.config/xfce4/xfconf/…` and
 * `.config/mimeapps.list` → true; a root FILE literally named `.config` (a user
 * config the seed edits) → false (single segment, no residue ancestor); and
 * `.github/x.yml`, `.gitignore` → false (`.github`/`.gitignore` are not residue).
 * Matches the tree-BFS collapse (which collapses residue DIR nodes) so the
 * Changes tab and the tree agree on what is workspace content.
 */
export function isUnderResidueDir(wsPath: string): boolean {
  const segments = wsPath.split("/");
  // Check ancestors only (every segment except the leaf): the leaf is the file
  // itself; a residue-named file at the root is still legitimate content.
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg && RESIDUE_DIR_SET.has(seg)) return true;
  }
  return false;
}

/**
 * The box is being torn down under us (Modal reclaim / reaper drain / terminate)
 * — NOT a single file vanishing. Every subsequent op will fail too, so the
 * capture must ABORT (throw) rather than skip-and-continue, so it never commits a
 * bogus empty/partial revision for a dead box. Matched loosely so a provider
 * wording tweak still classifies. (The real fix for this is keeping the box
 * pinned through the capture window — sandbox-resume / agent-turn lease
 * heartbeat; this classifier only guarantees we fail HONESTLY if it still races.)
 */
export function isBoxExitingError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    msg.includes("container exiting") ||
    msg.includes("container is exiting") ||
    msg.includes("container exited") ||
    msg.includes("sandbox has been terminated") ||
    msg.includes("sandbox is not running") ||
    msg.includes("sandbox has terminated") ||
    msg.includes("task has exited")
  );
}

/** Marker thrown when the box died mid-capture — aborts cleanly (no partial row). */
export class BoxExitingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxExitingError";
  }
}

/** Re-throw as a BoxExitingError when the box is gone; otherwise return null so
 *  the caller SKIPS this single entry (a vanished/unreadable file) and continues.
 *  One churning file must never kill the capture; a dead box must never yield a
 *  bogus revision. */
function classifyCaptureEntryError(error: unknown): BoxExitingError | null {
  if (isBoxExitingError(error)) {
    return new BoxExitingError(error instanceof Error ? error.message : String(error));
  }
  return null;
}
const TREE_MAX_ENTRIES = 20_000; // whole-tree node cap (truncate beyond)
const TREE_MAX_DEPTH = 600; // pathological nesting cap; still one remote round-trip

// The capture row and announcement are committed together by @opengeni/db. This
// callback performs only best-effort live fanout of those already-durable events.
export type CaptureEventPublisher = (events: SessionEvent[]) => Promise<void>;

export type CaptureWorkspaceRevisionInput = {
  db: Database;
  objectStorage: ObjectStorage | null;
  settings: Settings;
  publish: CaptureEventPublisher | null;
  /** The un-proxied setupBoxSession (NOT the routing veneer). */
  session: ChannelASession;
  leaseEpoch: number;
  sandboxGroupId: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  observability: Observability;
  /**
   * The owning turn activity's cancellation signal. Pause/Steer must preempt
   * review-cache housekeeping immediately; correctness still comes from the
   * activity plus the capture's transaction-level attempt/control/lease fences.
   */
  signal?: AbortSignal;
  /** Test-only: override keep-latest-N GC threshold (default 10). */
  keepLatest?: number;
  /** Test-only: override the whole-capture byte guard (default 200 MiB). */
  maxCaptureBytes?: number;
};

let loggedStorageNullOnce = false;

/**
 * Turn-end entrypoint. Gates on the flag + configured object storage, races the
 * whole capture against a 60s cap, and swallows every failure ("turn outcome
 * unaffected"). Returns void — the caller awaits it (it self-caps) and moves on
 * to release() regardless.
 */
export async function captureWorkspaceRevision(
  input: CaptureWorkspaceRevisionInput,
): Promise<void> {
  const { observability } = input;
  if (input.signal?.aborted) {
    observability.incrementCounter({
      name: "opengeni_workspace_capture_total",
      labels: { result: "cancelled" },
    });
    return;
  }
  if (!input.settings.workspaceCaptureEnabled) {
    return; // flag off → capture skipped; reads fall back to live/wake (status quo)
  }
  if (!input.objectStorage) {
    if (!loggedStorageNullOnce) {
      loggedStorageNullOnce = true;
      observability.info("workspace capture skipped — object storage not configured");
    }
    observability.incrementCounter({
      name: "opengeni_workspace_capture_total",
      labels: { result: "skipped_no_storage" },
    });
    return;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  let rejectOwnerCancellation: ((reason?: unknown) => void) | undefined;
  const ownerCancelled = input.signal
    ? new Promise<never>((_resolve, reject) => {
        rejectOwnerCancellation = reject;
      })
    : new Promise<never>(() => undefined);
  const cancelFromOwner = (): void => {
    controller.abort(input.signal?.reason);
    rejectOwnerCancellation?.(
      input.signal?.reason ?? new Error("workspace capture cancelled by its owning activity"),
    );
  };
  input.signal?.addEventListener("abort", cancelFromOwner, { once: true });
  if (input.signal?.aborted) cancelFromOwner();
  observability.incrementGauge({
    name: "opengeni_workspace_captures_inflight",
    help: "Current workspace-capture operations still resident in this worker process.",
  });
  const capture = runCapture(
    input,
    { ...input, objectStorage: input.objectStorage },
    startedAt,
    controller.signal,
  ).finally(() => {
    observability.incrementGauge({
      name: "opengeni_workspace_captures_inflight",
      help: "Current workspace-capture operations still resident in this worker process.",
      amount: -1,
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      capture,
      ownerCancelled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`workspace capture exceeded ${CAPTURE_TIMEOUT_MS}ms`));
        }, CAPTURE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (input.signal?.aborted) {
      observability.incrementCounter({
        name: "opengeni_workspace_capture_total",
        labels: { result: "cancelled" },
      });
      return;
    }
    // The one and only place a capture failure surfaces — as a log line, never
    // an exception past this boundary (the turn already completed).
    observability.warn("workspace capture failed — turn outcome unaffected", {
      "opengeni.session_id": input.sessionId,
      "opengeni.turn_id": input.turnId ?? "",
      "error.message": error instanceof Error ? error.message : String(error),
      "workspace_capture.duration_ms": Date.now() - startedAt,
    });
    observability.incrementCounter({
      name: "opengeni_workspace_capture_total",
      labels: { result: "failed" },
    });
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancelFromOwner);
    controller.abort();
  }
}

// The strongly-typed inner run (objectStorage proven non-null by the caller).
async function runCapture(
  input: CaptureWorkspaceRevisionInput,
  ctx: CaptureWorkspaceRevisionInput & { objectStorage: ObjectStorage },
  startedAt: number,
  signal: AbortSignal,
): Promise<void> {
  const { observability } = input;
  const storage = ctx.objectStorage;
  const keepN = input.keepLatest ?? KEEP_LATEST_REVISIONS;
  // Reads only — no emitter (we publish the announce ourselves after commit).
  const svc = new SandboxChannelAService({ session: input.session, leaseEpoch: input.leaseEpoch });

  // Resolve the previous revision before discovery so even a failed discovery
  // can commit a monotonic, explicit degraded marker. That marker becomes the
  // newest read result and prevents an older successful capture from being
  // mistaken for the current turn's authoritative workspace state.
  const prev = await latestWorkspaceCapture(input.db, input.workspaceId, input.sessionId);
  throwIfCaptureAborted(signal);
  const revision = (prev?.revision ?? -1) + 1;

  // ── 1. per-repo status + diff, union the touched set ──────────────────────
  const discovery = await svc.detectReposDetailed();
  throwIfCaptureAborted(signal);
  if (process.env.OPENGENI_TEST_SCENARIO === "sandbox") {
    console.log(
      `[sandbox-e2e] capture discovery complete=${discovery.complete} repos=${JSON.stringify(discovery.repos)} degraded=${discovery.degradedReason ?? "none"}`,
    );
  }
  if (!discovery.complete) {
    const capturedAt = new Date();
    const reason = captureDegradedReason(discovery.degradedReason);
    const stats = {
      degradedReason: reason,
      discoveredRepoCount: discovery.repos.length,
      durationMs: Date.now() - startedAt,
    };
    const inserted = await insertFailedWorkspaceCapture(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      sandboxGroupId: input.sandboxGroupId,
      expectedEpoch: input.leaseEpoch,
      revision,
      stats,
      capturedAt,
    });
    throwIfCaptureAborted(signal);
    if (!inserted) {
      observability.incrementCounter({
        name: "opengeni_workspace_capture_total",
        labels: { result: "superseded" },
      });
      return;
    }
    observability.warn("workspace capture degraded — repository discovery incomplete", {
      "opengeni.session_id": input.sessionId,
      "opengeni.turn_id": input.turnId ?? "",
      "workspace_capture.degraded_reason": reason,
      "workspace_capture.discovered_repo_count": discovery.repos.length,
    });
    observability.incrementCounter({
      name: "opengeni_workspace_capture_total",
      labels: { result: "degraded_repository_discovery" },
    });
    if (input.publish) {
      await input.publish(inserted.events).catch(() => undefined);
    }
    return;
  }
  const repoRoots = discovery.repos;
  // ── 2. prove status/diff and after-image bytes as one stable surface ───────
  // This is also the only empty-turn proof. A status-only pre-gate is unsafe for
  // untracked files because their contents can change while porcelain and diff
  // remain identical. Content-addressed blob PUTs are idempotent, so correctness
  // takes precedence over avoiding that bounded proof on a persistently dirty
  // but unchanged workspace.
  const finalized = await stabilizeWorkspaceCaptureFiles({
    observe: async () => await observeCaptureRepositories(svc, repoRoots, signal),
    readFile: async (path) =>
      await svc.fsRead({
        path,
        encoding: "base64",
        maxBytes: PER_FILE_CONTENT_GUARD_BYTES,
      }),
    putBlob: async (key, bytes) => {
      await storage.putObject({
        key,
        contentType: "application/octet-stream",
        body: bytes,
      });
    },
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    signal,
    ...(input.maxCaptureBytes === undefined ? {} : { maxTotalBytes: input.maxCaptureBytes }),
  });
  if (finalized.kind === "unstable") {
    const capturedAt = new Date();
    const reason = finalized.reason;
    const stats = {
      degradedReason: reason,
      stabilizationAttempts: finalized.attempts,
      durationMs: Date.now() - startedAt,
    };
    const inserted = await insertFailedWorkspaceCapture(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      sandboxGroupId: input.sandboxGroupId,
      expectedEpoch: input.leaseEpoch,
      revision,
      stats,
      capturedAt,
    });
    throwIfCaptureAborted(signal);
    if (!inserted) {
      observability.incrementCounter({
        name: "opengeni_workspace_capture_total",
        labels: { result: "superseded" },
      });
      return;
    }
    observability.warn("workspace capture degraded — workspace remained unstable", {
      "opengeni.session_id": input.sessionId,
      "opengeni.turn_id": input.turnId ?? "",
      "workspace_capture.degraded_reason": reason,
      "workspace_capture.stabilization_attempts": finalized.attempts,
    });
    observability.incrementCounter({
      name: "opengeni_workspace_capture_total",
      labels: { result: "degraded_workspace_unstable" },
    });
    if (input.publish) {
      await input.publish(inserted.events).catch(() => undefined);
    }
    return;
  }
  if (finalized.kind === "guard_tripped") {
    const capturedAt = new Date();
    const reason = "workspace_capture_size_limit_exceeded" as const;
    const stats = {
      degradedReason: reason,
      totalBytes: finalized.totalBytes,
      sizeLimitBytes: input.maxCaptureBytes ?? WHOLE_CAPTURE_GUARD_BYTES,
      durationMs: Date.now() - startedAt,
    };
    const inserted = await insertFailedWorkspaceCapture(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      sandboxGroupId: input.sandboxGroupId,
      expectedEpoch: input.leaseEpoch,
      revision,
      stats,
      capturedAt,
    });
    throwIfCaptureAborted(signal);
    if (!inserted) {
      observability.incrementCounter({
        name: "opengeni_workspace_capture_total",
        labels: { result: "superseded" },
      });
      return;
    }
    observability.warn("workspace capture degraded — whole-capture guard tripped", {
      "opengeni.session_id": input.sessionId,
      "workspace_capture.total_bytes": finalized.totalBytes,
      "workspace_capture.size_limit_bytes": stats.sizeLimitBytes,
    });
    observability.incrementCounter({
      name: "opengeni_workspace_capture_total",
      labels: { result: "degraded_size_limit" },
    });
    if (input.publish) {
      await input.publish(inserted.events).catch(() => undefined);
    }
    return;
  }
  const { repos, additions, deletions } = finalized.observation;
  const { files, blobKeys, totalBytes } = finalized;
  const tooLargeCount = files.filter((file) => file.tooLarge).length;
  const binaryCount = files.filter((file) => !file.deleted && file.isBinary).length;
  const fingerprint = changeFingerprint(repos, files);
  if (prev && prev.stats.fingerprint === fingerprint) {
    observability.incrementCounter({
      name: "opengeni_workspace_capture_total",
      labels: { result: "skipped_empty" },
    });
    return;
  }

  // ── 3. tree index (one bounded listing; residue dirs pruned at source) ─────
  const tree = await buildTreeIndex(svc, startedAt, signal);
  throwIfCaptureAborted(signal);

  // ── 4. serialize the exact uploaded after-images ──────────────────────────
  // Key manifest/tree by the turn (one capture per turn) so the key is known
  // before the revision is committed; content blobs are content-addressed.
  const turnKey = input.turnId;
  const treeKey = `workspace-captures/${input.workspaceId}/${input.sessionId}/trees/${turnKey}.json`;
  const manifestKey = `workspace-captures/${input.workspaceId}/${input.sessionId}/manifests/${turnKey}.json`;
  const capturedAt = new Date();
  const stats: WorkspaceCaptureStats = {
    repoCount: repos.length,
    fileCount: files.length,
    additions,
    deletions,
    totalBytes,
    tooLargeCount,
    binaryCount,
    treeEntryCount: tree.entryCount,
    treeTruncated: tree.truncated,
    durationMs: 0, // filled after tree/content writes, before manifest serialization
    fingerprint,
  };
  const manifest: WorkspaceCaptureManifest = {
    version: 1,
    revision,
    capturedAt: capturedAt.toISOString(),
    turnId: input.turnId,
    leaseEpoch: input.leaseEpoch,
    treeIndex: tree.root,
    treeTruncated: tree.truncated,
    repos,
    files,
    stats,
  };
  const treeBytes = utf8(
    JSON.stringify({
      version: 1,
      root: tree.root,
      truncated: tree.truncated,
      entryCount: tree.entryCount,
    }),
  );
  await storage.putObject({ key: treeKey, contentType: "application/json", body: treeBytes });
  throwIfCaptureAborted(signal);
  stats.durationMs = Date.now() - startedAt;
  const manifestBytes = utf8(JSON.stringify(manifest));
  await storage.putObject({
    key: manifestKey,
    contentType: "application/json",
    body: manifestBytes,
  });
  throwIfCaptureAborted(signal);
  const sizeBytes = totalBytes + treeBytes.byteLength + manifestBytes.byteLength;

  // ── 5. epoch-fenced insert (superseded lease → zero rows) ─────────────────
  const inserted = await insertWorkspaceCapture(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    sandboxGroupId: input.sandboxGroupId,
    expectedEpoch: input.leaseEpoch,
    revision,
    manifestKey,
    treeIndexKey: treeKey,
    blobKeys: [...blobKeys],
    sizeBytes,
    stats,
    capturedAt,
  });
  if (process.env.OPENGENI_TEST_SCENARIO === "sandbox") {
    console.log(
      `[sandbox-e2e] capture commit inserted=${Boolean(inserted)} revision=${revision} epoch=${input.leaseEpoch} group=${input.sandboxGroupId}`,
    );
  }
  throwIfCaptureAborted(signal);
  if (!inserted) {
    // Lease superseded/released between capture and commit. Best-effort clean up
    // the turn-keyed blobs we just PUT (content blobs may be shared with a
    // surviving revision — leave them for the next GC); never throw.
    observability.incrementCounter({
      name: "opengeni_workspace_capture_total",
      labels: { result: "superseded" },
    });
    await safeDelete(storage, [manifestKey, treeKey], observability, signal);
    return;
  }

  if (input.publish) {
    await input.publish(inserted.events).catch(() => undefined);
  }

  // ── 6. inline keep-latest-N GC (best-effort; F9 — after the commit) ────────
  let gcDeleted = 0;
  try {
    throwIfCaptureAborted(signal);
    const plan = await planWorkspaceCaptureGc(input.db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      keepN,
    });
    throwIfCaptureAborted(signal);
    if (plan.evictedRowIds.length > 0) {
      await safeDelete(
        storage,
        [...plan.deleteBlobKeys, ...plan.deletePerRevisionKeys],
        observability,
        signal,
      );
      throwIfCaptureAborted(signal);
      gcDeleted = await deleteWorkspaceCaptureRows(input.db, {
        workspaceId: input.workspaceId,
        rowIds: plan.evictedRowIds,
      });
      throwIfCaptureAborted(signal);
      observability.incrementCounter({
        name: "opengeni_workspace_capture_gc_deletions_total",
        amount: gcDeleted,
      });
    }
  } catch (gcError) {
    if (signal.aborted) throw gcError;
    // GC is storage hygiene — a failure never affects the just-committed capture.
    observability.warn("workspace capture GC failed — capture unaffected", {
      "opengeni.session_id": input.sessionId,
      "error.message": gcError instanceof Error ? gcError.message : String(gcError),
    });
  }

  // ── 7. observe completion ─────────────────────────────────────────────────
  const durationMs = Date.now() - startedAt;
  observability.incrementCounter({
    name: "opengeni_workspace_capture_total",
    labels: { result: "ok" },
  });
  observability.observeHistogram({
    name: "opengeni_workspace_capture_duration_seconds",
    value: durationMs / 1000,
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function captureDegradedReason(
  reason: RepositoryDiscoveryDegradedReason | null,
): WorkspaceCaptureDegradedReason {
  switch (reason) {
    case "command_timed_out":
      return "repository_discovery_timed_out";
    case "result_limit_exceeded":
      return "repository_discovery_result_limit_exceeded";
    case "command_failed":
    default:
      return "repository_discovery_command_failed";
  }
}

function throwIfCaptureAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("workspace capture cancelled after its deadline");
  }
}

function statusCodeOf(f: GitFileStatus): GitFileStatusCode {
  return f.worktree ?? f.index ?? "modified";
}

export function isDeletedAfterImage(f: GitFileStatus): boolean {
  // A staged deletion can coexist with a recreated worktree file (`DM`). In
  // that case the path has an after-image and the worktree status wins. It is
  // absent only when the worktree itself reports deletion, or the index reports
  // deletion with no subsequent worktree state.
  return f.worktree === "deleted" || (f.index === "deleted" && f.worktree === null);
}

export type WorkspaceCaptureObservation = {
  repos: WorkspaceCaptureRepo[];
  touched: Map<string, { status: GitFileStatusCode; deleted: boolean }>;
  additions: number;
  deletions: number;
};

type CaptureRepositoryPort = Pick<SandboxChannelAService, "gitStatus" | "gitDiff">;

async function observeCaptureRepositories(
  svc: CaptureRepositoryPort,
  repoRoots: string[],
  signal: AbortSignal,
): Promise<WorkspaceCaptureObservation> {
  const repos: WorkspaceCaptureRepo[] = [];
  const touched: WorkspaceCaptureObservation["touched"] = new Map();
  let additions = 0;
  let deletions = 0;

  for (const root of repoRoots) {
    throwIfCaptureAborted(signal);
    // A repository that cannot be inspected completely cannot participate in
    // an authoritative projection. Surface the failure to the stabilizer so a
    // newer degraded marker replaces any older successful capture.
    let status: Awaited<ReturnType<CaptureRepositoryPort["gitStatus"]>>;
    try {
      status = await svc.gitStatus({ path: root });
      throwIfCaptureAborted(signal);
    } catch (error) {
      const boxExiting = classifyCaptureEntryError(error);
      if (boxExiting) throw boxExiting;
      throw new CaptureAuthorityError(
        "workspace_repository_unreadable",
        `workspace capture could not read git status for ${root || "."}`,
        error,
      );
    }
    if (!status.isRepo) {
      throw new CaptureAuthorityError(
        "workspace_repository_unreadable",
        `workspace capture repository vanished during inspection: ${root || "."}`,
      );
    }

    let diff: Awaited<ReturnType<CaptureRepositoryPort["gitDiff"]>>;
    try {
      diff = await svc.gitDiff({
        path: root,
        staged: false,
        includeUntracked: true,
        fromRef: "HEAD",
        pathspec: [],
        contextLines: 3,
        maxBytesPerFile: PER_FILE_DIFF_GUARD_BYTES,
      });
      throwIfCaptureAborted(signal);
    } catch (error) {
      const boxExiting = classifyCaptureEntryError(error);
      if (boxExiting) throw boxExiting;
      throw new CaptureAuthorityError(
        "workspace_repository_unreadable",
        `workspace capture could not read git diff for ${root || "."}`,
        error,
      );
    }

    // The status, diff, and after-image surfaces all apply the same residue
    // filter so desktop/system churn cannot leak into only one projection.
    const diffFiles = diff.files.filter(
      (file) => !isUnderResidueDir(joinRepoPath(root, file.path)),
    );
    const statusFiles = status.files.filter(
      (file) => !isUnderResidueDir(joinRepoPath(root, file.path)),
    );
    repos.push({
      root,
      head: status.head,
      detached: status.detached,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      status: statusFiles,
      diff: diffFiles,
    });
    for (const file of diffFiles) {
      additions += file.additions;
      deletions += file.deletions;
    }
    for (const file of statusFiles) {
      touched.set(joinRepoPath(root, file.path), {
        status: statusCodeOf(file),
        deleted: isDeletedAfterImage(file),
      });
    }
  }

  return { repos, touched, additions, deletions };
}

type StableWorkspaceCaptureFilesInput = {
  observe: () => Promise<WorkspaceCaptureObservation>;
  readFile: (path: string) => Promise<FsReadResponse>;
  putBlob: (key: string, bytes: Uint8Array) => Promise<void>;
  workspaceId: string;
  sessionId: string;
  signal: AbortSignal;
  /** Test-only override for the production whole-capture guard. */
  maxTotalBytes?: number;
};

export type StableWorkspaceCaptureFilesResult =
  | {
      kind: "captured";
      observation: WorkspaceCaptureObservation;
      files: WorkspaceCaptureFile[];
      blobKeys: Set<string>;
      totalBytes: number;
    }
  | { kind: "guard_tripped"; totalBytes: number }
  | {
      kind: "unstable";
      attempts: number;
      reason: Extract<
        WorkspaceCaptureDegradedReason,
        | "workspace_changed_during_capture"
        | "workspace_file_unreadable"
        | "workspace_repository_unreadable"
      >;
    };

class CaptureAuthorityError extends Error {
  constructor(
    readonly reason: Extract<WorkspaceCaptureDegradedReason, "workspace_repository_unreadable">,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "CaptureAuthorityError";
  }
}

/**
 * Build the persisted after-images from a fresh repo observation, then prove
 * both the repository surface and every non-deleted after-image stayed stable
 * across two serial read passes. The two passes have a common interval (the
 * last first-pass read precedes the first verification read), so matching byte
 * evidence plus the surrounding status/diff observations is stronger than Git
 * metadata alone: untracked content can change without changing porcelain or
 * diff output. One retry covers an ordinary status/read race; persistent churn
 * returns an explicit unstable result so the activity can commit a newer,
 * epoch-fenced degraded revision rather than leaving an older capture looking
 * authoritative.
 */
export async function stabilizeWorkspaceCaptureFiles(
  input: StableWorkspaceCaptureFilesInput,
): Promise<StableWorkspaceCaptureFilesResult> {
  const uploadedKeys = new Set<string>();
  let unstableReason: Extract<
    WorkspaceCaptureDegradedReason,
    | "workspace_changed_during_capture"
    | "workspace_file_unreadable"
    | "workspace_repository_unreadable"
  > = "workspace_changed_during_capture";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfCaptureAborted(input.signal);
    let before: WorkspaceCaptureObservation;
    try {
      before = await input.observe();
    } catch (error) {
      if (input.signal.aborted) throw error;
      const boxExiting = classifyCaptureEntryError(error);
      if (boxExiting) throw boxExiting;
      unstableReason =
        error instanceof CaptureAuthorityError ? error.reason : "workspace_repository_unreadable";
      continue;
    }
    throwIfCaptureAborted(input.signal);
    const files: WorkspaceCaptureFile[] = [];
    const blobKeys = new Set<string>();
    const readEvidence = new Map<string, string>();
    let totalBytes = 0;
    let readFailed = false;

    for (const [path, info] of before.touched) {
      throwIfCaptureAborted(input.signal);
      if (info.deleted) {
        files.push({
          path,
          status: "deleted",
          hash: null,
          baseHash: null,
          contentRef: null,
          sizeBytes: 0,
          isBinary: false,
          tooLarge: false,
          deleted: true,
        });
        continue;
      }

      let read: FsReadResponse;
      try {
        read = await input.readFile(path);
        throwIfCaptureAborted(input.signal);
      } catch (error) {
        if (input.signal.aborted) throw error;
        const boxExiting = classifyCaptureEntryError(error);
        if (boxExiting) throw boxExiting;
        // Re-observe below. If the file truly vanished, the next attempt will
        // project its new deleted/absent status; if it remains unreadable, no
        // internally incomplete capture is committed.
        unstableReason = "workspace_file_unreadable";
        readFailed = true;
        break;
      }

      const bytes = Buffer.from(read.content, "base64");
      const hash = sha256(bytes);
      readEvidence.set(path, captureReadEvidence(read, hash));
      if (read.truncated) {
        files.push({
          path,
          status: info.status,
          hash: null,
          baseHash: null,
          contentRef: null,
          sizeBytes: read.sizeBytes,
          isBinary: read.isBinary,
          tooLarge: true,
          deleted: false,
        });
        continue;
      }

      const contentRef = blobKey(input.workspaceId, input.sessionId, hash);
      if (!blobKeys.has(contentRef)) {
        totalBytes += bytes.byteLength;
        if (totalBytes > (input.maxTotalBytes ?? WHOLE_CAPTURE_GUARD_BYTES)) {
          return { kind: "guard_tripped", totalBytes };
        }
        blobKeys.add(contentRef);
      }
      files.push({
        path,
        status: info.status,
        hash,
        baseHash: null,
        contentRef,
        sizeBytes: bytes.byteLength,
        isBinary: read.isBinary,
        tooLarge: false,
        deleted: false,
      });
    }

    // Re-read every non-deleted entry before the final repository observation.
    // Upload the verified second-read bytes, not the earlier candidates, while
    // retaining at most one file's contents in memory at a time.
    if (!readFailed) {
      for (const [path, info] of before.touched) {
        throwIfCaptureAborted(input.signal);
        if (info.deleted) continue;
        let verified: FsReadResponse;
        try {
          verified = await input.readFile(path);
          throwIfCaptureAborted(input.signal);
        } catch (error) {
          if (input.signal.aborted) throw error;
          const boxExiting = classifyCaptureEntryError(error);
          if (boxExiting) throw boxExiting;
          unstableReason = "workspace_file_unreadable";
          readFailed = true;
          break;
        }
        const verifiedBytes = Buffer.from(verified.content, "base64");
        const verifiedHash = sha256(verifiedBytes);
        if (readEvidence.get(path) !== captureReadEvidence(verified, verifiedHash)) {
          unstableReason = "workspace_changed_during_capture";
          readFailed = true;
          break;
        }
        if (!verified.truncated) {
          const contentRef = blobKey(input.workspaceId, input.sessionId, verifiedHash);
          if (!uploadedKeys.has(contentRef)) {
            await input.putBlob(contentRef, verifiedBytes);
            throwIfCaptureAborted(input.signal);
            uploadedKeys.add(contentRef);
          }
        }
      }
    }

    let after: WorkspaceCaptureObservation;
    try {
      after = await input.observe();
    } catch (error) {
      if (input.signal.aborted) throw error;
      const boxExiting = classifyCaptureEntryError(error);
      if (boxExiting) throw boxExiting;
      unstableReason =
        error instanceof CaptureAuthorityError ? error.reason : "workspace_repository_unreadable";
      continue;
    }
    throwIfCaptureAborted(input.signal);
    const repoSurfaceStable = captureRepoSurface(before.repos) === captureRepoSurface(after.repos);
    if (!repoSurfaceStable) {
      unstableReason = "workspace_changed_during_capture";
    }
    if (!readFailed && repoSurfaceStable) {
      return {
        kind: "captured",
        observation: after,
        files,
        blobKeys,
        totalBytes,
      };
    }
  }

  return { kind: "unstable", attempts: 2, reason: unstableReason };
}

function captureReadEvidence(read: FsReadResponse, hash: string): string {
  return JSON.stringify({
    hash,
    sizeBytes: read.sizeBytes,
    isBinary: read.isBinary,
    truncated: read.truncated,
  });
}

function captureRepoSurface(repos: WorkspaceCaptureRepo[]): string {
  const normalized = repos
    .map((repo) => ({
      ...repo,
      status: [...repo.status].sort((left, right) =>
        `${left.path}\u0000${left.oldPath ?? ""}`.localeCompare(
          `${right.path}\u0000${right.oldPath ?? ""}`,
        ),
      ),
      diff: [...repo.diff].sort((left, right) =>
        `${left.path}\u0000${left.oldPath ?? ""}`.localeCompare(
          `${right.path}\u0000${right.oldPath ?? ""}`,
        ),
      ),
    }))
    .sort((left, right) => left.root.localeCompare(right.root));
  return sha256(utf8(JSON.stringify(normalized)));
}

/**
 * sha256 over the CHANGE SURFACE only — per-file (path, status, hash, deleted,
 * tooLarge) and per-repo diff summary (path, status, additions, deletions).
 * Deliberately excludes the tree index and file mtimes (which drift without a
 * real change) so two turns that leave the workspace in the same state produce
 * the same fingerprint (the empty-turn gate). Order-independent (sorted).
 */
function changeFingerprint(repos: WorkspaceCaptureRepo[], files: WorkspaceCaptureFile[]): string {
  const fileParts = files
    .map((f) => `${f.path}|${f.status}|${f.hash ?? ""}|${f.deleted ? 1 : 0}|${f.tooLarge ? 1 : 0}`)
    .sort();
  const repoParts = repos
    .map(
      (r) =>
        `${r.root}#${r.head ?? ""}#` +
        r.status
          .map(
            (s) =>
              `${s.path}:${s.oldPath ?? ""}:${s.index ?? ""}:${s.worktree ?? ""}:${s.isConflicted ? 1 : 0}`,
          )
          .sort()
          .join(",") +
        "#" +
        r.diff
          .map((d) => `${d.path}:${d.status}:${d.additions}:${d.deletions}:${d.truncated ? 1 : 0}`)
          .sort()
          .join(","),
    )
    .sort();
  return sha256(utf8(JSON.stringify({ files: fileParts, repos: repoParts })));
}

/** Join a repo-root-relative path onto its workspace-relative repo root. */
export function joinRepoPath(repoRoot: string, repoRelPath: string): string {
  if (!repoRoot || repoRoot === "" || repoRoot === ".") return repoRelPath;
  return `${repoRoot.replace(/\/+$/, "")}/${repoRelPath}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Content-addressed after-image blob key (shared across revisions → GC input). */
export function blobKey(workspaceId: string, sessionId: string, sha256Hex: string): string {
  return `workspace-captures/${workspaceId}/${sessionId}/blobs/${sha256Hex}`;
}

async function safeDelete(
  storage: ObjectStorage,
  keys: string[],
  observability: Observability,
  signal: AbortSignal,
): Promise<void> {
  for (const key of keys) {
    throwIfCaptureAborted(signal);
    await storage.deleteObject(key).catch((error) => {
      observability.warn("workspace capture blob delete failed (orphan left; capture unaffected)", {
        "storage.key": key,
        "error.message": error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/**
 * Build the workspace tree index in ONE remote filesystem round-trip. Channel-A
 * prunes residue directories inside `find` while still emitting their collapsed
 * node, so node_modules cannot consume the authored-file budget. The former
 * serial per-directory BFS took 55.8 seconds for a 4,522-entry production tree
 * and blocked Steer cancellation. This path is bounded by entry count, nesting
 * depth, the outer capture deadline, and the owning activity's cancellation.
 */
async function buildTreeIndex(
  svc: SandboxChannelAService,
  startedAt: number,
  signal: AbortSignal,
): Promise<{ root: FsTreeNode; entryCount: number; truncated: boolean }> {
  throwIfCaptureAborted(signal);
  if (Date.now() - startedAt > CAPTURE_TIMEOUT_MS - 5_000) {
    throw new Error("workspace capture tree index reached its deadline before listing");
  }
  let listing: Awaited<ReturnType<typeof svc.fsListPruned>>;
  try {
    listing = await svc.fsListPruned(
      {
        path: "",
        depth: TREE_MAX_DEPTH,
        maxEntries: TREE_MAX_ENTRIES,
        includeHidden: true,
      },
      RESIDUE_DIRS,
    );
    throwIfCaptureAborted(signal);
  } catch (error) {
    if (isBoxExitingError(error)) {
      throw new BoxExitingError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }

  let entryCount = 0;
  let depthTruncated = false;
  const stack = [...(listing.root.children ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    entryCount += 1;
    if (node.type !== "dir") continue;
    if (RESIDUE_DIR_SET.has(node.name)) {
      node.truncated = true;
      node.children = [];
      continue;
    }
    if (node.path.split("/").length >= TREE_MAX_DEPTH) {
      node.truncated = true;
      depthTruncated = true;
      continue;
    }
    stack.push(...(node.children ?? []));
  }
  return {
    root: listing.root,
    entryCount,
    truncated: listing.truncated || depthTruncated,
  };
}
