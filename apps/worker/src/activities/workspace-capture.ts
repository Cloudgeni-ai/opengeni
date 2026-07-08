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
//   • The whole capture is time-capped (60s) and best-effort: ANY failure logs
//     "workspace capture failed — turn outcome unaffected" and returns; nothing
//     throws past captureWorkspaceRevision.
//   • The DB write is fenced on the lease epoch — a superseded lease writes zero
//     rows (insertWorkspaceCapture).
//   • F9 storage ordering: blobs + manifest are PUT and the row is committed
//     BEFORE any GC delete runs.
//
// It is deliberately an EXTERNAL module with a SINGLE call-site line in
// agent-turn.ts's finally (dossier "Accepted warts" #2 — do not grow the turn
// activity). The emitted `workspace.revision.captured` event is ANNOUNCE-ONLY
// (metadata, never content) and must never gain a rendered timeline item.

import { createHash, randomUUID } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import {
  deleteWorkspaceCaptureRows,
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
import { SandboxChannelAService, type ChannelASession } from "@opengeni/runtime/sandbox";
import type {
  FsTreeNode,
  GitFileStatus,
  GitFileStatusCode,
  SessionEventType,
  WorkspaceCaptureFile,
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
  "node_modules", ".git", "dist", "build", "target", ".venv", "__pycache__", ".next",
  // desktop/system residue (never workspace content; churned by the desktop stack)
  ".config", ".cache", ".local", ".dbus", ".gnupg", ".ssh", ".mozilla", ".xfce4",
  ".pki", ".gvfs", ".dbus-keyrings", ".Xauthority", ".ICEauthority",
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
    msg.includes("container exiting")
    || msg.includes("container is exiting")
    || msg.includes("container exited")
    || msg.includes("sandbox has been terminated")
    || msg.includes("sandbox is not running")
    || msg.includes("sandbox has terminated")
    || msg.includes("task has exited")
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
const TREE_MAX_DIRS = 600; // BFS round-trip cap (bounds turn-end latency)

// The publish closure from agent-turn (Omit<AppendEventInput, producer/turn ids>)
// is assignable to this. Announce-only — payload is metadata, never file content.
export type CaptureEventPublisher = (
  events: Array<{ type: SessionEventType; payload: Record<string, unknown> }>,
) => Promise<void>;

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
  turnId: string | null;
  observability: Observability;
  /** Test-only: override keep-latest-N GC threshold (default 10). */
  keepLatest?: number;
};

let loggedStorageNullOnce = false;

/**
 * Turn-end entrypoint. Gates on the flag + configured object storage, races the
 * whole capture against a 60s cap, and swallows every failure ("turn outcome
 * unaffected"). Returns void — the caller awaits it (it self-caps) and moves on
 * to release() regardless.
 */
export async function captureWorkspaceRevision(input: CaptureWorkspaceRevisionInput): Promise<void> {
  const { observability } = input;
  if (!input.settings.workspaceCaptureEnabled) {
    return; // flag off → capture skipped; reads fall back to live/wake (status quo)
  }
  if (!input.objectStorage) {
    if (!loggedStorageNullOnce) {
      loggedStorageNullOnce = true;
      observability.info("workspace capture skipped — object storage not configured");
    }
    observability.incrementCounter({ name: "opengeni_workspace_capture_total", labels: { result: "skipped_no_storage" } });
    return;
  }

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runCapture(input, { ...input, objectStorage: input.objectStorage }, startedAt),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`workspace capture exceeded ${CAPTURE_TIMEOUT_MS}ms`)), CAPTURE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // The one and only place a capture failure surfaces — as a log line, never
    // an exception past this boundary (the turn already completed).
    observability.warn("workspace capture failed — turn outcome unaffected", {
      "opengeni.session_id": input.sessionId,
      "opengeni.turn_id": input.turnId ?? "",
      "error.message": error instanceof Error ? error.message : String(error),
      "workspace_capture.duration_ms": Date.now() - startedAt,
    });
    observability.incrementCounter({ name: "opengeni_workspace_capture_total", labels: { result: "failed" } });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The strongly-typed inner run (objectStorage proven non-null by the caller).
async function runCapture(
  input: CaptureWorkspaceRevisionInput,
  ctx: CaptureWorkspaceRevisionInput & { objectStorage: ObjectStorage },
  startedAt: number,
): Promise<void> {
  const { observability } = input;
  const storage = ctx.objectStorage;
  const keepN = input.keepLatest ?? KEEP_LATEST_REVISIONS;
  // Reads only — no emitter (we publish the announce ourselves after commit).
  const svc = new SandboxChannelAService({ session: input.session, leaseEpoch: input.leaseEpoch });

  // ── 1. per-repo status + diff, union the touched set ──────────────────────
  const repoRoots = await svc.detectRepos();
  const repos: WorkspaceCaptureRepo[] = [];
  // workspace-relative path → touched-file descriptor
  const touched = new Map<string, { status: GitFileStatusCode; deleted: boolean }>();
  let additions = 0;
  let deletions = 0;

  for (const root of repoRoots) {
    // Per-repo resilience: a box death aborts the whole capture (BoxExitingError
    // propagates); any other single-repo failure (a repo that vanished, a
    // transient git error) SKIPS that repo and the capture continues with the
    // rest. One flaky repo must never kill the capture.
    let status: Awaited<ReturnType<typeof svc.gitStatus>>;
    try {
      status = await svc.gitStatus({ path: root });
    } catch (error) {
      const boxExiting = classifyCaptureEntryError(error);
      if (boxExiting) throw boxExiting;
      continue;
    }
    if (!status.isRepo) continue;
    // `git diff HEAD`: combined staged+unstaged tracked changes vs HEAD (the
    // review diff). Untracked files are absent here but present in status.files
    // and captured as after-images. A repo with no commits yields an empty diff
    // (git diff HEAD errors → empty numstat) and everything reads as untracked.
    let diff: Awaited<ReturnType<typeof svc.gitDiff>>;
    try {
      diff = await svc.gitDiff({
        path: root,
        staged: false,
        fromRef: "HEAD",
        pathspec: [],
        contextLines: 3,
        maxBytesPerFile: PER_FILE_DIFF_GUARD_BYTES,
      });
    } catch (error) {
      const boxExiting = classifyCaptureEntryError(error);
      if (boxExiting) throw boxExiting;
      diff = { files: [], revision: 0 };
    }
    repos.push({
      root,
      head: status.head,
      detached: status.detached,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      status: status.files,
      diff: diff.files,
    });
    for (const f of diff.files) {
      additions += f.additions;
      deletions += f.deletions;
    }
    for (const f of status.files) {
      const wsPath = joinRepoPath(root, f.path);
      // Skip desktop/system residue churn (~/.config/xfce4/…): on a desktop box
      // the workspace root is $HOME, so git reports the continuously-rewritten
      // XFCE/cache dotfiles as untracked. They are never review content — dropping
      // them here keeps the after-image loop off churn AND matches the tree BFS's
      // residue collapse (Changes tab and tree agree on what is workspace content).
      if (isUnderResidueDir(wsPath)) continue;
      touched.set(wsPath, {
        status: statusCodeOf(f),
        deleted: f.worktree === "deleted" || f.index === "deleted",
      });
    }
  }

  // Previous revision (for the empty-turn gate + revision assignment). The gate
  // itself fires AFTER the after-image loop, once the change fingerprint is known
  // (§10.1 / B3): uncommitted changes persist in the box across turns, so a
  // literal "skip when git status is clean" gate would re-capture an identical
  // dirty tree on every read-only turn. Instead we skip when the change surface
  // is byte-identical to the previous revision — "no new revision when nothing
  // changed" holds even with a persistently dirty tree, and content-addressed
  // blobs already dedupe storage. (Deviation from the dossier's literal "clean"
  // wording — same intent, strictly better; recorded in PROGRESS.)
  const prev = await latestWorkspaceCapture(input.db, input.workspaceId, input.sessionId);
  const revision = (prev?.revision ?? -1) + 1;

  // ── 3. after-images of touched files (size-gated), content-addressed ───────
  const files: WorkspaceCaptureFile[] = [];
  const blobKeys = new Set<string>();
  // { key → bytes } to PUT (deduped by content-addressed key).
  const blobsToPut = new Map<string, Uint8Array>();
  let totalBytes = 0;
  let tooLargeCount = 0;
  let binaryCount = 0;

  for (const [wsPath, info] of touched) {
    if (info.deleted) {
      files.push({
        path: wsPath, status: "deleted", hash: null, baseHash: null,
        contentRef: null, sizeBytes: 0, isBinary: false, tooLarge: false, deleted: true,
      });
      continue;
    }
    // Always request base64 so we get raw bytes uniformly (text or binary) for
    // content-addressing. maxBytes caps the read at the 5MB guard; `truncated`
    // means the file is ≥5MB → we record a tooLarge marker (no content blob).
    //
    // Per-file resilience: a file the box reported as changed can VANISH or turn
    // unreadable between git-status and this read (fs churn, a follow-up mutation,
    // a race). That must NEVER abort the whole capture — skip the one entry and
    // keep the rest. A box-death error is different: it aborts (BoxExitingError),
    // because every remaining read would fail too and we must not commit a partial
    // revision for a dead box.
    let read: Awaited<ReturnType<typeof svc.fsRead>>;
    try {
      read = await svc.fsRead({ path: wsPath, encoding: "base64", maxBytes: PER_FILE_CONTENT_GUARD_BYTES });
    } catch (error) {
      const boxExiting = classifyCaptureEntryError(error);
      if (boxExiting) throw boxExiting;
      continue; // vanished/unreadable single file — omit it, capture continues
    }
    if (read.truncated) {
      tooLargeCount += 1;
      files.push({
        path: wsPath, status: info.status, hash: null, baseHash: null,
        contentRef: null, sizeBytes: read.sizeBytes, isBinary: read.isBinary,
        tooLarge: true, deleted: false,
      });
      continue;
    }
    const bytes = Buffer.from(read.content, "base64");
    const hash = sha256(bytes);
    const contentRef = blobKey(input.workspaceId, input.sessionId, hash);
    if (read.isBinary) binaryCount += 1;
    if (!blobsToPut.has(contentRef)) {
      blobsToPut.set(contentRef, bytes);
      totalBytes += bytes.byteLength;
      // Whole-capture guard: bail before writing anything (fall back to live).
      if (totalBytes > WHOLE_CAPTURE_GUARD_BYTES) {
        observability.warn("workspace capture skipped — whole-capture guard tripped", {
          "opengeni.session_id": input.sessionId,
          "workspace_capture.total_bytes": totalBytes,
        });
        observability.incrementCounter({ name: "opengeni_workspace_capture_total", labels: { result: "guard_tripped" } });
        return;
      }
    }
    blobKeys.add(contentRef);
    files.push({
      // baseHash (git HEAD blob sha) is intentionally null in M1: the wake-on-edit
      // flush guard (M3/C2) compares live content against the after-image `hash`,
      // not the HEAD blob, so baseHash is not load-bearing yet. Populating it would
      // cost an extra per-file round-trip at turn end (latency risk #1). Deferred.
      path: wsPath, status: info.status, hash, baseHash: null,
      contentRef, sizeBytes: bytes.byteLength, isBinary: read.isBinary,
      tooLarge: false, deleted: false,
    });
  }

  // ── 4. empty-turn gate (dossier §10.1 / B3) ───────────────────────────────
  // Skip when the change surface is byte-identical to the previous revision.
  // Fires BEFORE the tree BFS + storage PUTs (the expensive parts) so a no-op
  // read-only turn on a persistently dirty tree costs only the (small) status/
  // diff/after-image probes.
  const fingerprint = changeFingerprint(repos, files);
  if (prev && prev.stats.fingerprint === fingerprint) {
    observability.incrementCounter({ name: "opengeni_workspace_capture_total", labels: { result: "skipped_empty" } });
    return;
  }

  // ── 5. tree index (bounded BFS; residue dirs collapsed, not descended) ─────
  const tree = await buildTreeIndex(svc, startedAt);

  // ── 6. serialize manifest ─────────────────────────────────────────────────
  const capturedAt = new Date().toISOString();
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
    durationMs: 0, // filled just before publish
    fingerprint,
  };
  const manifest: WorkspaceCaptureManifest = {
    version: 1,
    revision,
    capturedAt,
    turnId: input.turnId,
    leaseEpoch: input.leaseEpoch,
    treeIndex: tree.root,
    treeTruncated: tree.truncated,
    repos,
    files,
    stats,
  };

  // ── 7. PUT blobs + tree + manifest (F9: all writes BEFORE any delete) ──────
  // Key manifest/tree by the turn (one capture per turn) so the key is known
  // before the revision is committed; content blobs are content-addressed.
  const turnKey = input.turnId ?? randomUUID();
  const treeKey = `workspace-captures/${input.workspaceId}/${input.sessionId}/trees/${turnKey}.json`;
  const manifestKey = `workspace-captures/${input.workspaceId}/${input.sessionId}/manifests/${turnKey}.json`;

  for (const [key, bytes] of blobsToPut) {
    await storage.putObject({ key, contentType: "application/octet-stream", body: bytes });
  }
  const treeBytes = utf8(JSON.stringify({ version: 1, root: tree.root, truncated: tree.truncated, entryCount: tree.entryCount }));
  await storage.putObject({ key: treeKey, contentType: "application/json", body: treeBytes });
  const manifestBytes = utf8(JSON.stringify(manifest));
  await storage.putObject({ key: manifestKey, contentType: "application/json", body: manifestBytes });
  const sizeBytes = totalBytes + treeBytes.byteLength + manifestBytes.byteLength;

  // ── 8. epoch-fenced insert (superseded lease → zero rows) ──────────────────
  const inserted = await insertWorkspaceCapture(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    sandboxGroupId: input.sandboxGroupId,
    expectedEpoch: input.leaseEpoch,
    revision,
    manifestKey,
    treeIndexKey: treeKey,
    blobKeys: [...blobKeys],
    sizeBytes,
    stats,
  });
  if (!inserted) {
    // Lease superseded/released between capture and commit. Best-effort clean up
    // the turn-keyed blobs we just PUT (content blobs may be shared with a
    // surviving revision — leave them for the next GC); never throw.
    observability.incrementCounter({ name: "opengeni_workspace_capture_total", labels: { result: "superseded" } });
    await safeDelete(storage, [manifestKey, treeKey], observability);
    return;
  }

  // ── 9. inline keep-latest-N GC (best-effort; F9 — after the commit) ────────
  let gcDeleted = 0;
  try {
    const plan = await planWorkspaceCaptureGc(input.db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      keepN,
    });
    if (plan.evictedRowIds.length > 0) {
      await safeDelete(storage, [...plan.deleteBlobKeys, ...plan.deletePerRevisionKeys], observability);
      gcDeleted = await deleteWorkspaceCaptureRows(input.db, {
        workspaceId: input.workspaceId,
        rowIds: plan.evictedRowIds,
      });
      observability.incrementCounter({ name: "opengeni_workspace_capture_gc_deletions_total", amount: gcDeleted });
    }
  } catch (gcError) {
    // GC is storage hygiene — a failure never affects the just-committed capture.
    observability.warn("workspace capture GC failed — capture unaffected", {
      "opengeni.session_id": input.sessionId,
      "error.message": gcError instanceof Error ? gcError.message : String(gcError),
    });
  }

  // ── 10. announce (announce-only; hits the timeline projection default case) ─
  const durationMs = Date.now() - startedAt;
  stats.durationMs = durationMs;
  observability.incrementCounter({ name: "opengeni_workspace_capture_total", labels: { result: "ok" } });
  observability.observeHistogram({ name: "opengeni_workspace_capture_duration_seconds", value: durationMs / 1000 });
  if (input.publish) {
    await input.publish([{
      type: "workspace.revision.captured",
      payload: {
        revision: inserted.revision,
        turnId: input.turnId,
        capturedAt,
        leaseEpoch: input.leaseEpoch,
        stats,
      },
    }]).catch(() => undefined);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function statusCodeOf(f: GitFileStatus): GitFileStatusCode {
  return f.worktree ?? f.index ?? "modified";
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
    .map((r) => `${r.root}#${r.head ?? ""}#` + r.diff
      .map((d) => `${d.path}:${d.status}:${d.additions}:${d.deletions}:${d.truncated ? 1 : 0}`)
      .sort()
      .join(","))
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

async function safeDelete(storage: ObjectStorage, keys: string[], observability: Observability): Promise<void> {
  for (const key of keys) {
    await storage.deleteObject(key).catch((error) => {
      observability.warn("workspace capture blob delete failed (orphan left; capture unaffected)", {
        "storage.key": key,
        "error.message": error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/**
 * Build the workspace tree index via bounded BFS over the PUBLIC fsList (depth 1
 * per directory). Residue dirs are emitted as collapsed nodes but never queued
 * for descent — a single deep fsList would let node_modules exhaust the entry
 * budget and truncate real files, so we prune at the source. Bounded by
 * TREE_MAX_ENTRIES, TREE_MAX_DIRS round-trips, and the outer capture deadline.
 */
async function buildTreeIndex(
  svc: SandboxChannelAService,
  startedAt: number,
): Promise<{ root: FsTreeNode; entryCount: number; truncated: boolean }> {
  const root: FsTreeNode = {
    name: "", path: "", type: "dir", sizeBytes: null, mtimeMs: null, mode: null, children: [], truncated: false,
  };
  const byPath = new Map<string, FsTreeNode>([["", root]]);
  const queue: string[] = [""];
  let entryCount = 0;
  let dirCalls = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (dirCalls >= TREE_MAX_DIRS || entryCount >= TREE_MAX_ENTRIES) { truncated = true; break; }
    if (Date.now() - startedAt > CAPTURE_TIMEOUT_MS - 5_000) { truncated = true; break; } // leave headroom for PUTs
    const dir = queue.shift()!;
    dirCalls += 1;
    // Per-dir resilience: a directory can vanish or fail to list mid-walk (fs
    // churn on a desktop box, a permission edge). Skip the one directory and keep
    // walking the rest — a single unreadable dir must never abort the tree index.
    // A box death still aborts the whole capture (BoxExitingError).
    let listing: Awaited<ReturnType<typeof svc.fsList>>;
    try {
      listing = await svc.fsList({ path: dir, depth: 1, maxEntries: 2_000, includeHidden: true });
    } catch (error) {
      if (isBoxExitingError(error)) {
        throw new BoxExitingError(error instanceof Error ? error.message : String(error));
      }
      truncated = true; // this subtree is incomplete; continue with the rest
      continue;
    }
    if (listing.truncated) truncated = true;
    const parent = byPath.get(dir) ?? root;
    const children = collectImmediateChildren(listing.root);
    for (const child of children) {
      if (entryCount >= TREE_MAX_ENTRIES) { truncated = true; break; }
      const node: FsTreeNode = {
        name: child.name,
        path: child.path,
        type: child.type,
        sizeBytes: child.sizeBytes,
        mtimeMs: child.mtimeMs,
        mode: child.mode,
        truncated: false,
        ...(child.type === "dir" ? { children: [] as FsTreeNode[] } : {}),
      };
      (parent.children ??= []).push(node);
      byPath.set(node.path, node);
      entryCount += 1;
      if (node.type === "dir") {
        if (RESIDUE_DIR_SET.has(node.name)) {
          node.truncated = true; // collapsed residue dir — contents on the machine
        } else {
          queue.push(node.path);
        }
      }
    }
  }
  return { root, entryCount, truncated };
}

/** fsList returns a subtree; at depth 1 the immediate children hang off root. */
function collectImmediateChildren(node: FsTreeNode): FsTreeNode[] {
  return node.children ?? [];
}
