// M1 unit tests (dossier §12 B-suite unit portion + §15). The pure logic:
// GC key-math, manifest serialization, guard constants, path/key helpers, the
// pre-service skip gates (flag off / storage null), and the B7 static safety
// grep (no close/terminate/kill; sandbox access only via the un-agent-loop
// leaf). The full B1–B7 capture scenarios run against a REAL docker box + DB in
// test/integration/workspace-capture.integration.ts (doctrine: verify real
// behavior, not a mock proxy).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { computeWorkspaceCaptureGcPlan, type Database } from "@opengeni/db";
import {
  type FsReadResponse,
  type GitFileStatus,
  WorkspaceCaptureManifest,
  type WorkspaceCaptureRepo,
  WorkspaceRevisionCapturedPayload,
  WorkspaceRevisionDegradedPayload,
} from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";
import type { ChannelASession } from "@opengeni/runtime/sandbox";
import {
  blobKey,
  BoxExitingError,
  captureWorkspaceRevision,
  isBoxExitingError,
  isDeletedAfterImage,
  isUnderResidueDir,
  joinRepoPath,
  KEEP_LATEST_REVISIONS,
  PER_FILE_CONTENT_GUARD_BYTES,
  PER_FILE_DIFF_GUARD_BYTES,
  RESIDUE_DIRS,
  stabilizeWorkspaceCaptureFiles,
  type WorkspaceCaptureObservation,
  WHOLE_CAPTURE_GUARD_BYTES,
} from "../src/activities/workspace-capture";

const here = dirname(fileURLToPath(import.meta.url));
const observability = createObservability(testSettings(), { component: "worker-test" });

// A storage that FAILS LOUDLY if touched — proves the skip gates never write.
function forbiddenStorage(): ObjectStorage {
  const boom = (): never => {
    throw new Error("storage must not be touched on a skip");
  };
  return {
    bucket: "test",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 1,
    createPutUrl: boom as never,
    createGetUrl: boom as never,
    headFile: boom as never,
    headObject: boom as never,
    getFileBytes: boom as never,
    getObjectBytes: boom as never,
    putObject: boom as never,
    deleteObject: boom as never,
  };
}
// A DB that FAILS LOUDLY if touched.
const forbiddenDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be touched on a skip");
    },
  },
) as unknown as Database;
const dummySession = {} as ChannelASession;

function baseInput() {
  return {
    db: forbiddenDb,
    settings: testSettings(),
    publish: null,
    session: dummySession,
    leaseEpoch: 1,
    sandboxGroupId: "grp-1",
    accountId: "00000000-0000-0000-0000-0000000000a1",
    workspaceId: "00000000-0000-0000-0000-0000000000b1",
    sessionId: "00000000-0000-0000-0000-0000000000c1",
    turnId: "00000000-0000-0000-0000-0000000000d1",
    attemptId: "00000000-0000-4000-8000-0000000000e1",
    observability,
  };
}

describe("workspace-capture — guard constants", () => {
  test("thresholds are ordered and the keep-N default is 10", () => {
    expect(PER_FILE_CONTENT_GUARD_BYTES).toBe(5 * 1024 * 1024);
    expect(PER_FILE_DIFF_GUARD_BYTES).toBe(10 * 1024 * 1024);
    expect(WHOLE_CAPTURE_GUARD_BYTES).toBe(200 * 1024 * 1024);
    expect(PER_FILE_CONTENT_GUARD_BYTES).toBeLessThan(PER_FILE_DIFF_GUARD_BYTES);
    expect(PER_FILE_DIFF_GUARD_BYTES).toBeLessThan(WHOLE_CAPTURE_GUARD_BYTES);
    expect(KEEP_LATEST_REVISIONS).toBe(10);
    expect(RESIDUE_DIRS).toContain("node_modules");
    expect(RESIDUE_DIRS).toContain(".git");
    expect(RESIDUE_DIRS).toContain(".opengeni");
  });

  test("RESIDUE_DIRS excludes the desktop/system dotfile dirs the Modal desktop box churns", () => {
    // The Modal desktop box's workspace root IS $HOME, and XFCE/dbus/etc.
    // continuously rewrite these — capturing them raced files that vanished
    // mid-walk and aborted the whole capture (0/3 on staging). They are never
    // review content, so the tree walk collapses them and the after-image loop
    // skips them. (Regression guard for the S2 fix.)
    for (const dir of [
      ".config",
      ".cache",
      ".local",
      ".dbus",
      ".gnupg",
      ".ssh",
      ".mozilla",
      ".xfce4",
    ]) {
      expect(RESIDUE_DIRS).toContain(dir);
    }
    // But legit hidden entries a user authors stay VISIBLE (never residue).
    for (const keep of [".github", ".gitignore", ".env", ".vscode", ".devcontainer"]) {
      expect(RESIDUE_DIRS).not.toContain(keep);
    }
  });
});

describe("workspace-capture — residue-path classification (S2 desktop-box fix)", () => {
  test("paths inside a residue dir are excluded; authored hidden files are kept", () => {
    // The exact staging churn path that aborted capture.
    expect(isUnderResidueDir(".config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml")).toBe(
      true,
    );
    expect(isUnderResidueDir(".config/mimeapps.list")).toBe(true); // a file directly inside a residue dir
    expect(isUnderResidueDir(".config")).toBe(false); // a root FILE named .config is legit user content
    expect(isUnderResidueDir(".cache/pip/http/abc")).toBe(true);
    expect(isUnderResidueDir("web/node_modules/react/index.js")).toBe(true); // residue at any depth
    expect(isUnderResidueDir(".ssh/id_ed25519")).toBe(true);
    expect(isUnderResidueDir(".opengeni/git-token")).toBe(true);
    expect(isUnderResidueDir("repo/.opengeni/git-credentials/github-token")).toBe(true);
    // Kept — real workspace content with leading dots.
    expect(isUnderResidueDir(".github/workflows/ci.yml")).toBe(false);
    expect(isUnderResidueDir(".gitignore")).toBe(false);
    expect(isUnderResidueDir("src/.env.local")).toBe(false);
    expect(isUnderResidueDir("data.txt")).toBe(false);
  });
});

describe("workspace-capture — box-exit vs vanished-file classification (S2)", () => {
  test("box-death errors abort; a plain vanished-file error does not", () => {
    // The exact production error: a fsRead whose inner cause is the box tearing
    // down. MUST classify as box-exiting so the capture aborts (no bogus row)
    // rather than skip-and-continue.
    expect(
      isBoxExitingError(
        new Error("file not found: .config (request cancelled due to container exiting)"),
      ),
    ).toBe(true);
    expect(isBoxExitingError(new Error("request cancelled due to container exiting"))).toBe(true);
    expect(isBoxExitingError(new Error("sandbox is not running"))).toBe(true);
    expect(isBoxExitingError("the sandbox has been terminated")).toBe(true);
    // A genuine single-file vanish (no box death) → NOT box-exiting → skip + continue.
    expect(isBoxExitingError(new Error("file not found: notes.txt"))).toBe(false);
    expect(isBoxExitingError(new Error("ENOENT: no such file or directory"))).toBe(false);
    expect(isBoxExitingError(new Error("failed to write foo: exit 1"))).toBe(false);
  });

  test("BoxExitingError is a distinct, named error type", () => {
    const e = new BoxExitingError("container exiting");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BoxExitingError");
  });
});

describe("workspace-capture — path & key helpers", () => {
  test("joinRepoPath prefixes only non-root repos", () => {
    expect(joinRepoPath("", "src/main.js")).toBe("src/main.js");
    expect(joinRepoPath(".", "src/main.js")).toBe("src/main.js");
    expect(joinRepoPath("web", "src/main.js")).toBe("web/src/main.js");
    expect(joinRepoPath("web/", "src/main.js")).toBe("web/src/main.js");
  });
  test("blobKey is content-addressed under the session prefix", () => {
    expect(blobKey("ws", "sess", "abc123")).toBe("workspace-captures/ws/sess/blobs/abc123");
  });
});

function captureObservation(status: GitFileStatus[]): WorkspaceCaptureObservation {
  const repo: WorkspaceCaptureRepo = {
    root: "",
    head: "main",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    status,
    diff: [],
  };
  return {
    repos: [repo],
    touched: new Map(
      status.map((file) => [
        file.path,
        {
          status: file.worktree ?? file.index ?? "modified",
          deleted: isDeletedAfterImage(file),
        },
      ]),
    ),
    additions: 0,
    deletions: 0,
  };
}

function gitFile(path: string, worktree: GitFileStatus["worktree"]): GitFileStatus {
  return { path, oldPath: null, index: null, worktree, isConflicted: false };
}

function fileRead(path: string, content: string): FsReadResponse {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    encoding: "base64",
    content: Buffer.from(bytes).toString("base64"),
    sizeBytes: bytes.byteLength,
    truncated: false,
    isBinary: false,
    revision: 1,
  };
}

describe("workspace-capture — stabilized final Files/Changes projection", () => {
  const signal = new AbortController().signal;

  test("a first-pass too-large file that shrinks is captured as a normal after-image", async () => {
    const final = captureObservation([gitFile("big.txt", "modified")]);
    const uploads: string[] = [];
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => final,
      readFile: async (path) => fileRead(path, "now small\n"),
      putBlob: async (key) => {
        uploads.push(key);
      },
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("capture guard unexpectedly tripped");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: "big.txt",
      tooLarge: false,
      deleted: false,
      sizeBytes: 10,
    });
    expect(result.files[0]!.contentRef).toBeTruthy();
    expect(uploads).toEqual([result.files[0]!.contentRef]);
  });

  test("a deleted file recreated identically to HEAD disappears from both projections", async () => {
    const clean = captureObservation([]);
    let reads = 0;
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => clean,
      readFile: async (path) => {
        reads += 1;
        return fileRead(path, "unchanged\n");
      },
      putBlob: async () => undefined,
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("capture guard unexpectedly tripped");
    expect(result.observation.repos[0]!.status).toEqual([]);
    expect(result.files).toEqual([]);
    expect(reads).toBe(0);
  });

  test("a deleted file recreated with changes becomes a modified after-image", async () => {
    const modified = captureObservation([gitFile("tracked.txt", "modified")]);
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => modified,
      readFile: async (path) => fileRead(path, "changed\n"),
      putBlob: async () => undefined,
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("capture guard unexpectedly tripped");
    expect(result.files[0]).toMatchObject({
      path: "tracked.txt",
      status: "modified",
      deleted: false,
      tooLarge: false,
    });
  });

  test("a staged deletion with a recreated worktree file keeps its after-image", async () => {
    const recreated = captureObservation([
      {
        path: "tracked.txt",
        oldPath: null,
        index: "deleted",
        worktree: "modified",
        isConflicted: false,
      },
    ]);
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => recreated,
      readFile: async (path) => fileRead(path, "recreated\n"),
      putBlob: async () => undefined,
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("capture guard unexpectedly tripped");
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "tracked.txt",
        status: "modified",
        deleted: false,
        tooLarge: false,
      }),
    ]);
  });

  test("a normal file that vanishes during the read is retried as deleted", async () => {
    const modified = captureObservation([gitFile("tracked.txt", "modified")]);
    const deleted = captureObservation([gitFile("tracked.txt", "deleted")]);
    const observations = [modified, deleted, deleted, deleted];
    let reads = 0;
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => observations.shift()!,
      readFile: async () => {
        reads += 1;
        throw new Error("ENOENT: tracked.txt vanished");
      },
      putBlob: async () => undefined,
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("capture guard unexpectedly tripped");
    expect(reads).toBe(1);
    expect(result.observation.repos[0]!.status[0]!.worktree).toBe("deleted");
    expect(result.files).toEqual([
      {
        path: "tracked.txt",
        status: "deleted",
        hash: null,
        baseHash: null,
        contentRef: null,
        sizeBytes: 0,
        isBinary: false,
        tooLarge: false,
        deleted: true,
      },
    ]);
  });

  test("unchanged Git status cannot hide untracked byte churn", async () => {
    const untracked = captureObservation([gitFile("status-only.txt", "untracked")]);
    const contents = ["stale\n", "changed\n", "changed\n", "changed\n"];
    const uploads: string[] = [];
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => untracked,
      readFile: async (path) => fileRead(path, contents.shift()!),
      putBlob: async (_key, bytes) => {
        uploads.push(new TextDecoder().decode(bytes));
      },
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("capture guard unexpectedly tripped");
    expect(contents).toEqual([]);
    expect(uploads).toEqual(["changed\n"]);
    expect(result.files[0]).toMatchObject({
      path: "status-only.txt",
      sizeBytes: 8,
      deleted: false,
      tooLarge: false,
    });
  });

  test("persistent byte churn returns an unstable result instead of stale files", async () => {
    const untracked = captureObservation([gitFile("status-only.txt", "untracked")]);
    const contents = ["one", "two", "three", "four"];
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => untracked,
      readFile: async (path) => fileRead(path, contents.shift()!),
      putBlob: async () => {
        throw new Error("mismatched bytes must not upload");
      },
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });
    expect(result).toEqual({
      kind: "unstable",
      attempts: 2,
      reason: "workspace_changed_during_capture",
    });
    expect(contents).toEqual([]);
  });

  test("persistent read failures report an unreadable file instead of inventing churn", async () => {
    const untracked = captureObservation([gitFile("unreadable.txt", "untracked")]);
    let reads = 0;
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => untracked,
      readFile: async () => {
        reads += 1;
        throw new Error("permission denied");
      },
      putBlob: async () => {
        throw new Error("unreadable bytes must not upload");
      },
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });
    expect(result).toEqual({
      kind: "unstable",
      attempts: 2,
      reason: "workspace_file_unreadable",
    });
    expect(reads).toBe(2);
  });

  test("persistent repository observation failures never commit an incomplete projection", async () => {
    let observations = 0;
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => {
        observations += 1;
        throw new Error("git diff failed");
      },
      readFile: async () => {
        throw new Error("repository failure must prevent file reads");
      },
      putBlob: async () => {
        throw new Error("repository failure must prevent uploads");
      },
      workspaceId: "ws",
      sessionId: "sess",
      signal,
    });
    expect(result).toEqual({
      kind: "unstable",
      attempts: 2,
      reason: "workspace_repository_unreadable",
    });
    expect(observations).toBe(2);
  });

  test("the whole-capture byte guard remains fail-closed before blob upload", async () => {
    const modified = captureObservation([gitFile("large.txt", "modified")]);
    let uploads = 0;
    const result = await stabilizeWorkspaceCaptureFiles({
      observe: async () => modified,
      readFile: async (path) => fileRead(path, "four"),
      putBlob: async () => {
        uploads += 1;
      },
      workspaceId: "ws",
      sessionId: "sess",
      signal,
      maxTotalBytes: 3,
    });
    expect(result).toEqual({ kind: "guard_tripped", totalBytes: 4 });
    expect(uploads).toBe(0);
  });
});

describe("workspace-capture — GC key-math (dossier B5)", () => {
  const row = (id: string, blobKeys: string[]) => ({
    id,
    manifestKey: `m/${id}`,
    treeIndexKey: `t/${id}`,
    blobKeys,
  });

  test("evicts revisions beyond keep-N and deletes their per-revision keys", () => {
    // newest-first: 12 rows, keep 10 → 2 evicted (the two oldest = last two).
    const rows = Array.from({ length: 12 }, (_, i) => row(`r${11 - i}`, [`blob-${11 - i}`]));
    const plan = computeWorkspaceCaptureGcPlan(rows, 10);
    expect(plan.evictedRowIds.sort()).toEqual(["r0", "r1"]);
    expect(plan.deletePerRevisionKeys.sort()).toEqual(["m/r0", "m/r1", "t/r0", "t/r1"]);
    // each evicted revision owns a unique blob → both deleted.
    expect(plan.deleteBlobKeys.sort()).toEqual(["blob-0", "blob-1"]);
  });

  test("a content-addressed blob shared with a SURVIVING revision is NOT deleted", () => {
    // r2,r1 survive (keep 2); r0 evicted. r0 shares "shared" with r2, owns "only0".
    const rows = [row("r2", ["shared", "s2"]), row("r1", ["s1"]), row("r0", ["shared", "only0"])];
    const plan = computeWorkspaceCaptureGcPlan(rows, 2);
    expect(plan.evictedRowIds).toEqual(["r0"]);
    expect(plan.deleteBlobKeys).toEqual(["only0"]); // "shared" preserved
    expect(plan.deleteBlobKeys).not.toContain("shared");
  });

  test("nothing evicted when rows <= keep-N", () => {
    const rows = [row("r1", ["a"]), row("r0", ["b"])];
    expect(computeWorkspaceCaptureGcPlan(rows, 10)).toEqual({
      evictedRowIds: [],
      deleteBlobKeys: [],
      deletePerRevisionKeys: [],
    });
  });

  test("de-dupes a blob owned by two evicted revisions into one delete", () => {
    const rows = [row("r2", ["keep"]), row("r1", ["dup"]), row("r0", ["dup"])];
    const plan = computeWorkspaceCaptureGcPlan(rows, 1);
    expect(plan.evictedRowIds.sort()).toEqual(["r0", "r1"]);
    expect(plan.deleteBlobKeys).toEqual(["dup"]);
  });
});

describe("workspace-capture — manifest & event serialization", () => {
  test("a manifest round-trips through JSON and parses under the contract", () => {
    const manifest = {
      version: 1 as const,
      revision: 3,
      capturedAt: new Date().toISOString(),
      turnId: "turn-1",
      leaseEpoch: 7,
      treeIndex: {
        name: "",
        path: "",
        type: "dir",
        sizeBytes: null,
        mtimeMs: null,
        mode: null,
        children: [
          {
            name: "src",
            path: "src",
            type: "dir",
            sizeBytes: null,
            mtimeMs: 1,
            mode: 493,
            truncated: false,
            children: [],
          },
          {
            name: "node_modules",
            path: "node_modules",
            type: "dir",
            sizeBytes: null,
            mtimeMs: 1,
            mode: 493,
            truncated: true,
            children: [],
          },
        ],
        truncated: false,
      },
      treeTruncated: false,
      repos: [
        {
          root: "",
          head: "main",
          detached: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          status: [
            {
              path: "a.txt",
              oldPath: null,
              index: null,
              worktree: "modified" as const,
              isConflicted: false,
            },
          ],
          diff: [
            {
              path: "a.txt",
              oldPath: null,
              status: "modified" as const,
              isBinary: false,
              isImage: false,
              additions: 1,
              deletions: 0,
              hunks: [],
              truncated: false,
            },
          ],
        },
      ],
      files: [
        {
          path: "a.txt",
          status: "modified" as const,
          hash: "h1",
          baseHash: null,
          contentRef: "workspace-captures/ws/s/blobs/h1",
          sizeBytes: 4,
          isBinary: false,
          tooLarge: false,
          deleted: false,
        },
        {
          path: "big.bin",
          status: "modified" as const,
          hash: null,
          baseHash: null,
          contentRef: null,
          sizeBytes: 5 * 1024 * 1024,
          isBinary: false,
          tooLarge: true,
          deleted: false,
        },
        {
          path: "gone.txt",
          status: "deleted" as const,
          hash: null,
          baseHash: null,
          contentRef: null,
          sizeBytes: 0,
          isBinary: false,
          tooLarge: false,
          deleted: true,
        },
      ],
      stats: {
        repoCount: 1,
        fileCount: 3,
        additions: 1,
        deletions: 0,
        totalBytes: 4,
        tooLargeCount: 1,
        binaryCount: 0,
        treeEntryCount: 2,
        treeTruncated: false,
        durationMs: 12,
      },
    };
    const parsed = WorkspaceCaptureManifest.parse(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.revision).toBe(3);
    expect(parsed.files.find((f) => f.tooLarge)?.contentRef).toBeNull();
    expect(parsed.files.find((f) => f.deleted)?.status).toBe("deleted");
  });

  test("the announce payload parses under the contract (metadata only)", () => {
    const payload = {
      revision: 3,
      turnId: "t1",
      capturedAt: new Date().toISOString(),
      leaseEpoch: 7,
      stats: {
        repoCount: 1,
        fileCount: 1,
        additions: 1,
        deletions: 0,
        totalBytes: 4,
        tooLargeCount: 0,
        binaryCount: 0,
        treeEntryCount: 1,
        treeTruncated: false,
        durationMs: 5,
      },
    };
    expect(() => WorkspaceRevisionCapturedPayload.parse(payload)).not.toThrow();
  });

  test("the degraded announce payload parses under the contract (metadata only)", () => {
    expect(() =>
      WorkspaceRevisionDegradedPayload.parse({
        revision: 4,
        turnId: "t2",
        capturedAt: new Date().toISOString(),
        leaseEpoch: 8,
        reason: "repository_discovery_result_limit_exceeded",
      }),
    ).not.toThrow();
    expect(() =>
      WorkspaceRevisionDegradedPayload.parse({
        revision: 5,
        turnId: "t3",
        capturedAt: new Date().toISOString(),
        leaseEpoch: 9,
        reason: "workspace_changed_during_capture",
      }),
    ).not.toThrow();
    expect(() =>
      WorkspaceRevisionDegradedPayload.parse({
        revision: 6,
        turnId: "t4",
        capturedAt: new Date().toISOString(),
        leaseEpoch: 10,
        reason: "workspace_file_unreadable",
      }),
    ).not.toThrow();
    expect(() =>
      WorkspaceRevisionDegradedPayload.parse({
        revision: 7,
        turnId: "t5",
        capturedAt: new Date().toISOString(),
        leaseEpoch: 11,
        reason: "workspace_repository_unreadable",
      }),
    ).not.toThrow();
    expect(() =>
      WorkspaceRevisionDegradedPayload.parse({
        revision: 8,
        turnId: "t6",
        capturedAt: new Date().toISOString(),
        leaseEpoch: 12,
        reason: "workspace_capture_size_limit_exceeded",
      }),
    ).not.toThrow();
    expect(() =>
      WorkspaceRevisionDegradedPayload.parse({
        revision: 9,
        turnId: "t7",
        capturedAt: new Date().toISOString(),
        leaseEpoch: 13,
        reason: "workspace_capture_storage_unavailable",
      }),
    ).not.toThrow();
    expect(() =>
      WorkspaceRevisionDegradedPayload.parse({
        revision: 10,
        turnId: "t8",
        capturedAt: new Date().toISOString(),
        leaseEpoch: 14,
        reason: "workspace_tree_unreadable",
      }),
    ).not.toThrow();
  });
});

describe("workspace-capture — pre-service skip gates", () => {
  test("an already-cancelled Steer/Pause owner returns before touching storage or db", async () => {
    const controller = new AbortController();
    controller.abort(new Error("STEER"));
    await expect(
      captureWorkspaceRevision({
        ...baseInput(),
        objectStorage: forbiddenStorage(),
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
  });

  test("flag off → returns without touching storage or db", async () => {
    await expect(
      captureWorkspaceRevision({
        ...baseInput(),
        settings: testSettings({ workspaceCaptureEnabled: false }),
        objectStorage: forbiddenStorage(),
      }),
    ).resolves.toBeUndefined();
  });

  test("storage null → returns without touching db", async () => {
    await expect(
      captureWorkspaceRevision({
        ...baseInput(),
        objectStorage: null,
      }),
    ).resolves.toBeUndefined();
  });

  test("B6: a box-exec failure is swallowed — never throws past the boundary", async () => {
    // A session whose exec rejects makes detectRepos() throw at the very first
    // step. captureWorkspaceRevision must resolve (the turn already completed) and
    // touch neither the db nor storage — proving "turn outcome unaffected".
    const throwingSession = {
      exec: async () => {
        throw new Error("box exec failed");
      },
    } as unknown as ChannelASession;
    await expect(
      captureWorkspaceRevision({
        ...baseInput(),
        objectStorage: forbiddenStorage(),
        session: throwingSession,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("workspace-capture — B7 static safety guard", () => {
  const source = readFileSync(
    join(here, "..", "src", "activities", "workspace-capture.ts"),
    "utf8",
  );
  // Strip line comments + block comments so the doctrine words in the header
  // (which explain WHY we never close) don't trip the code grep.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  test("never calls close()/terminate()/kill() on any session handle", () => {
    expect(code).not.toMatch(/\.close\s*\(/);
    expect(code).not.toMatch(/\bterminate\b/);
    expect(code).not.toMatch(/\bkill\b/);
  });

  test("constructs the Channel-A service only via the un-agent-loop leaf", () => {
    expect(source).toMatch(/from ["']@opengeni\/runtime\/sandbox["']/);
    // never the bare barrel (would pull the agent loop into the capture path).
    expect(source).not.toMatch(/from ["']@opengeni\/runtime["']/);
  });

  test("the empty-turn fingerprint is computed only from byte-stabilized files", () => {
    const proof = source.indexOf("finalized = await stabilizeWorkspaceCaptureFiles");
    const fingerprint = source.indexOf("const fingerprint = changeFingerprint");
    expect(proof).toBeGreaterThan(-1);
    expect(fingerprint).toBeGreaterThan(proof);
    expect(source).not.toContain("const initialObservation =");
  });
});
