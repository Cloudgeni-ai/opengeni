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
export const RESIDUE_DIRS: readonly string[] = [
  "node_modules", ".git", "dist", "build", "target", ".venv", "__pycache__", ".next",
];
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
  let anyChange = false;
  let additions = 0;
  let deletions = 0;

  for (const root of repoRoots) {
    const status = await svc.gitStatus({ path: root });
    if (!status.isRepo) continue;
    // `git diff HEAD`: combined staged+unstaged tracked changes vs HEAD (the
    // review diff). Untracked files are absent here but present in status.files
    // and captured as after-images. A repo with no commits yields an empty diff
    // (git diff HEAD errors → empty numstat) and everything reads as untracked.
    const diff = await svc.gitDiff({
      path: root,
      staged: false,
      fromRef: "HEAD",
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: PER_FILE_DIFF_GUARD_BYTES,
    });
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
      anyChange = true;
      const wsPath = joinRepoPath(root, f.path);
      touched.set(wsPath, {
        status: statusCodeOf(f),
        deleted: f.worktree === "deleted" || f.index === "deleted",
      });
    }
  }

  // ── 2. empty-turn gate (dossier §10.1 / B3) ───────────────────────────────
  // A clean tree AND a prior revision → no new revision (revision N unchanged).
  // A clean tree with NO prior revision writes an empty baseline rev 0 so the
  // cold workbench paints from a real (empty) capture.
  const prev = await latestWorkspaceCapture(input.db, input.workspaceId, input.sessionId);
  if (!anyChange && prev) {
    observability.incrementCounter({ name: "opengeni_workspace_capture_total", labels: { result: "skipped_empty" } });
    return;
  }
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
    const read = await svc.fsRead({ path: wsPath, encoding: "base64", maxBytes: PER_FILE_CONTENT_GUARD_BYTES });
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

  // ── 4. tree index (bounded BFS; residue dirs collapsed, not descended) ─────
  const tree = await buildTreeIndex(svc, startedAt);

  // ── 5. serialize manifest ─────────────────────────────────────────────────
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

  // ── 6. PUT blobs + tree + manifest (F9: all writes BEFORE any delete) ──────
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

  // ── 7. epoch-fenced insert (superseded lease → zero rows) ──────────────────
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

  // ── 8. inline keep-latest-N GC (best-effort; F9 — after the commit) ────────
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

  // ── 9. announce (announce-only; hits the timeline projection default case) ──
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
    const listing = await svc.fsList({ path: dir, depth: 1, maxEntries: 2_000, includeHidden: true });
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
        if (RESIDUE_DIRS.includes(node.name)) {
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
