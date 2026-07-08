/* ----------------------------------------------------------------------------
   M3 (Workbench v2) — the capture data layer.

   The cold-paint hooks: useWorkspaceCapture (mount fetch + announce refresh),
   source selection in use-sandbox-files / use-sandbox-git (capture cold, live
   warm), the FLAGSHIP cold→warm reconcile WITHOUT remounting the tree/diff roots
   (no-flicker, §12-D1), the wake-on-edit state machine (happy + conflict + offline
   + warming, §12-C), and the machine-chip derivation.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, test } from "bun:test";
import type {
  FsTreeNode,
  GetWorkspaceCaptureResponse,
  GitFileDiff,
  SessionEvent,
  WorkspaceCaptureManifest,
  WorkspaceCaptureRepo,
} from "@opengeni/sdk";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { fakeEvent } from "./sandbox-fixtures";
import { useWorkspaceCapture } from "../src/hooks/use-workspace-capture";
import { useSandboxFiles, type FileTreeNode } from "../src/hooks/use-sandbox-files";
import { useSandboxGit } from "../src/hooks/use-sandbox-git";
import { useWorkspaceEdit } from "../src/hooks/use-workspace-edit";
import { deriveMachineChip } from "../src/hooks/use-machine-chip";

registerDom();

const ctx = { workspaceId: WORKSPACE_ID };

// ── Fixtures ────────────────────────────────────────────────────────────────

function treeDir(name: string, path: string, children?: FsTreeNode[]): FsTreeNode {
  return { name, path, type: "dir", sizeBytes: null, mtimeMs: null, mode: null, truncated: false, ...(children ? { children } : {}) };
}
function treeFile(name: string, path: string, sizeBytes = 10): FsTreeNode {
  return { name, path, type: "file", sizeBytes, mtimeMs: null, mode: null, truncated: false };
}

function fakeDiff(overrides: Partial<GitFileDiff> = {}): GitFileDiff {
  return {
    path: "app.py",
    oldPath: null,
    status: "modified",
    isBinary: false,
    isImage: false,
    additions: 2,
    deletions: 1,
    truncated: false,
    hunks: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, header: "@@ -1 +1,2 @@", lines: [{ type: "add", oldNo: null, newNo: 2, text: "x" }] },
    ],
    ...overrides,
  };
}

function fakeRepo(overrides: Partial<WorkspaceCaptureRepo> = {}): WorkspaceCaptureRepo {
  return {
    root: "",
    head: "main",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    status: [],
    diff: [fakeDiff()],
    ...overrides,
  };
}

function fakeManifest(overrides: Partial<WorkspaceCaptureManifest> = {}): WorkspaceCaptureManifest {
  return {
    version: 1,
    revision: 3,
    capturedAt: "2026-07-08T12:00:00.000Z",
    turnId: "turn-1",
    leaseEpoch: 1,
    treeIndex: treeDir("", "", [treeDir("src", "src"), treeFile("README.md", "README.md", 10)]),
    treeTruncated: false,
    repos: [fakeRepo()],
    files: [{ path: "src/app.py", status: "modified", hash: "h1", baseHash: null, contentRef: "blob/h1", sizeBytes: 20, isBinary: false, tooLarge: false, deleted: false }],
    stats: {
      repoCount: 1, fileCount: 1, additions: 2, deletions: 1, totalBytes: 20,
      tooLargeCount: 0, binaryCount: 0, treeEntryCount: 2, treeTruncated: false, durationMs: 12,
    },
    ...overrides,
  };
}

function captureAvailable(manifest: WorkspaceCaptureManifest): GetWorkspaceCaptureResponse {
  return {
    available: true,
    revision: manifest.revision,
    capturedAt: manifest.capturedAt,
    turnId: manifest.turnId,
    leaseEpoch: manifest.leaseEpoch,
    sizeBytes: 1024,
    stats: manifest.stats,
    manifest,
    manifestUrl: null,
  };
}

// ── useWorkspaceCapture ───────────────────────────────────────────────────────

describe("useWorkspaceCapture", () => {
  test("fetches the latest capture on mount and exposes the manifest", async () => {
    const manifest = fakeManifest();
    const client = fakeClient({ getWorkspaceCapture: async () => captureAvailable(manifest) });
    const hook = await renderHook(() => useWorkspaceCapture(SESSION_ID, { ...ctx, client }), undefined);
    await flush();
    expect(hook.result.current.available).toBe(true);
    expect(hook.result.current.revision).toBe(3);
    expect(hook.result.current.capturedAt).toBe("2026-07-08T12:00:00.000Z");
    expect(hook.result.current.capture?.files[0]?.path).toBe("src/app.py");
    expect(hook.result.current.isStale).toBe(false);
    await hook.unmount();
  });

  test("{available:false} degrades cleanly (consumers fall back to live/wake)", async () => {
    const client = fakeClient({ getWorkspaceCapture: async () => ({ available: false }) });
    const hook = await renderHook(() => useWorkspaceCapture(SESSION_ID, { ...ctx, client }), undefined);
    await flush();
    expect(hook.result.current.available).toBe(false);
    expect(hook.result.current.capture).toBeNull();
    expect(hook.result.current.revision).toBeNull();
    await hook.unmount();
  });

  test("follows manifestUrl for the rare >2MB manifest", async () => {
    const manifest = fakeManifest({ revision: 5 });
    const originalFetch = globalThis.fetch;
    let fetched: string | null = null;
    globalThis.fetch = (async (url: string) => {
      fetched = String(url);
      return { ok: true, status: 200, json: async () => manifest } as unknown as Response;
    }) as typeof fetch;
    try {
      const client = fakeClient({
        getWorkspaceCapture: async (): Promise<GetWorkspaceCaptureResponse> => ({
          available: true, revision: 5, capturedAt: manifest.capturedAt, turnId: manifest.turnId,
          leaseEpoch: 1, sizeBytes: 3_000_000, stats: manifest.stats,
          manifest: null, manifestUrl: { url: "https://blob.example/manifest.json", expiresAt: "2026-07-08T12:05:00.000Z" },
        }),
      });
      const hook = await renderHook(() => useWorkspaceCapture(SESSION_ID, { ...ctx, client }), undefined);
      await flush();
      expect(fetched as string | null).toBe("https://blob.example/manifest.json");
      expect(hook.result.current.revision).toBe(5);
      expect(hook.result.current.capture?.files[0]?.path).toBe("src/app.py");
      await hook.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a newer workspace.revision.captured announce marks stale and refreshes", async () => {
    let served = fakeManifest({ revision: 3 });
    let calls = 0;
    const client = fakeClient({
      getWorkspaceCapture: async () => {
        calls += 1;
        return captureAvailable(served);
      },
    });
    const hook = await renderHook(
      (props: { events: SessionEvent[] }) => useWorkspaceCapture(SESSION_ID, { ...ctx, client, events: props.events }),
      { events: [] as SessionEvent[] },
    );
    await flush();
    expect(hook.result.current.revision).toBe(3);
    expect(calls).toBe(1);
    // A newer revision is announced → refresh pulls it (server now serves rev 4).
    served = fakeManifest({ revision: 4 });
    await hook.rerender({
      events: [fakeEvent(1, "workspace.revision.captured", { revision: 4, turnId: "turn-2", capturedAt: served.capturedAt, leaseEpoch: 1, stats: served.stats })],
    });
    await flush();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(hook.result.current.revision).toBe(4);
    expect(hook.result.current.isStale).toBe(false);
    await hook.unmount();
  });
});

// ── use-sandbox-files: source selection + no-flicker reconcile ─────────────────

describe("useSandboxFiles — capture source", () => {
  test("cold + capture paints the tree from the index with ZERO Channel-A calls", async () => {
    let fsListCalls = 0;
    let gitStatusCalls = 0;
    const client = fakeClient({
      fsList: async () => { fsListCalls += 1; return { root: treeDir("", ""), revision: 0, truncated: false }; },
      gitStatus: async () => { gitStatusCalls += 1; return { isRepo: false, head: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 0 }; },
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: "cold" }),
      undefined,
    );
    await flush();
    expect(hook.result.current.source).toBe("capture");
    expect(hook.result.current.capturedAt).toBe("2026-07-08T12:00:00.000Z");
    expect(hook.result.current.tree.map((n) => n.name)).toEqual(["src", "README.md"]);
    // The cold first paint made NO machine round-trips.
    expect(fsListCalls).toBe(0);
    expect(gitStatusCalls).toBe(0);
    await hook.unmount();
  });

  test("warm uses the LIVE path (capture ignored, existing behavior)", async () => {
    let fsListCalls = 0;
    const client = fakeClient({
      gitStatus: async () => ({ isRepo: false, head: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 0 }),
      fsList: async () => {
        fsListCalls += 1;
        return { root: treeDir("", "", [treeFile("live.ts", "live.ts", 5)]), revision: 0, truncated: false };
      },
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: "warm" }),
      undefined,
    );
    await flush();
    expect(fsListCalls).toBeGreaterThan(0);
    expect(hook.result.current.source).toBe("live");
    expect(hook.result.current.tree.map((n) => n.name)).toEqual(["live.ts"]);
    await hook.unmount();
  });

  test("FLAGSHIP: cold→warm reconcile keeps node identity — no remount, deltas patched", async () => {
    const client = fakeClient({
      gitStatus: async () => ({ isRepo: false, head: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 0 }),
      // The live list returns the SAME two entries the capture had (unchanged),
      // plus a new file — the delta that must be patched in.
      fsList: async () => ({
        root: treeDir("", "", [treeDir("src", "src"), treeFile("README.md", "README.md", 10), treeFile("new.ts", "new.ts", 3)]),
        revision: 1, truncated: false,
      }),
    });
    const hook = await renderHook(
      (props: { liveness: string }) => useSandboxFiles(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: props.liveness }),
      { liveness: "cold" },
    );
    await flush();
    // Cold snapshot painted from capture.
    expect(hook.result.current.source).toBe("capture");
    const coldTree = hook.result.current.tree;
    const coldSrc = coldTree.find((n) => n.path === "src")!;
    const coldReadme = coldTree.find((n) => n.path === "README.md")!;
    expect(coldSrc).toBeDefined();
    expect(coldReadme).toBeDefined();

    // Box warms → live reconcile.
    await hook.rerender({ liveness: "warm" });
    await flush();

    const warmTree = hook.result.current.tree;
    // The tree was NEVER emptied and NOW serves live.
    expect(hook.result.current.source).toBe("live");
    expect(warmTree.length).toBe(3);
    const warmSrc = warmTree.find((n) => n.path === "src")!;
    const warmReadme = warmTree.find((n) => n.path === "README.md")!;
    // No-flicker: the UNCHANGED nodes are the SAME object references (React will
    // not remount their rows) — this is the flagship assertion.
    expect(Object.is(warmSrc, coldSrc)).toBe(true);
    expect(Object.is(warmReadme, coldReadme)).toBe(true);
    // The delta (new.ts) was patched in.
    expect(warmTree.some((n) => n.path === "new.ts")).toBe(true);
    // NOT a full-list replacement: at least the two unchanged nodes kept identity.
    const preserved = warmTree.filter((n) => Object.is(n, coldSrc) || Object.is(n, coldReadme));
    expect(preserved.length).toBe(2);
    await hook.unmount();
  });

  test("no capture + cold falls back to the live list (status quo, never worse)", async () => {
    let fsListCalls = 0;
    const client = fakeClient({
      gitStatus: async () => ({ isRepo: false, head: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 0 }),
      fsList: async () => { fsListCalls += 1; return { root: treeDir("", "", [treeFile("a.ts", "a.ts", 1)]), revision: 0, truncated: false }; },
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { ...ctx, client, liveness: "cold" }),
      undefined,
    );
    await flush();
    expect(fsListCalls).toBeGreaterThan(0);
    expect(hook.result.current.source).toBe("live");
    await hook.unmount();
  });
});

// ── use-sandbox-git: source selection + no-flicker ─────────────────────────────

describe("useSandboxGit — capture source", () => {
  test("cold + capture serves the diff from the capture repo (no gitDiff RPC)", async () => {
    let gitDiffCalls = 0;
    const client = fakeClient({
      gitStatus: async () => ({ isRepo: true, head: "main", detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 1 }),
      gitDiff: async () => { gitDiffCalls += 1; return { files: [], revision: 1 }; },
    });
    const hook = await renderHook(
      () => useSandboxGit(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: "cold" }),
      undefined,
    );
    await flush();
    expect(hook.result.current.source).toBe("capture");
    expect(hook.result.current.capturedAt).toBe("2026-07-08T12:00:00.000Z");
    expect(hook.result.current.isRepo).toBe(true);
    expect(hook.result.current.branch).toBe("main");
    expect(hook.result.current.diff.map((d) => d.path)).toEqual(["app.py"]);
    expect(gitDiffCalls).toBe(0);
    await hook.unmount();
  });

  test("cold→warm swaps to the live diff, preserving unchanged file-section identity", async () => {
    const client = fakeClient({
      gitStatus: async () => ({ isRepo: true, head: "main", detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 1 }),
      // Live diff repeats the same app.py (unchanged) + a new file.
      gitDiff: async () => ({ files: [fakeDiff(), fakeDiff({ path: "extra.py", additions: 1, deletions: 0 })], revision: 1 }),
    });
    const hook = await renderHook(
      (props: { liveness: string }) => useSandboxGit(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: props.liveness }),
      { liveness: "cold" },
    );
    await flush();
    const coldAppPy = hook.result.current.diff.find((d) => d.path === "app.py")!;
    expect(coldAppPy).toBeDefined();
    await hook.rerender({ liveness: "warm" });
    await flush();
    expect(hook.result.current.source).toBe("live");
    const warmAppPy = hook.result.current.diff.find((d) => d.path === "app.py")!;
    // The unchanged app.py section kept identity (no remount); extra.py is new.
    expect(Object.is(warmAppPy, coldAppPy)).toBe(true);
    expect(hook.result.current.diff.some((d) => d.path === "extra.py")).toBe(true);
    await hook.unmount();
  });

  test("warm uses the live diff directly (capture ignored)", async () => {
    let gitDiffCalls = 0;
    const client = fakeClient({
      gitStatus: async () => ({ isRepo: true, head: "feature", detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 1 }),
      gitDiff: async () => { gitDiffCalls += 1; return { files: [fakeDiff({ path: "live-only.py" })], revision: 1 }; },
    });
    const hook = await renderHook(
      () => useSandboxGit(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: "warm" }),
      undefined,
    );
    await flush();
    expect(gitDiffCalls).toBeGreaterThan(0);
    expect(hook.result.current.source).toBe("live");
    expect(hook.result.current.diff.map((d) => d.path)).toEqual(["live-only.py"]);
    await hook.unmount();
  });
});

// ── use-workspace-edit: the wake-on-edit state machine ─────────────────────────

describe("useWorkspaceEdit", () => {
  test("happy path: cold edit → warm → guarded flush (hash matches)", async () => {
    const writes: { path: string; content: string }[] = [];
    let warmRequests = 0;
    const client = fakeClient({
      fsRead: async (_ws, _s, req) => ({ path: req.path, encoding: "utf8" as const, content: "hello\n", sizeBytes: 6, truncated: false, isBinary: false, revision: 0 }),
      fsWrite: async (_ws, _s, req) => { writes.push({ path: req.path, content: req.content }); return { path: req.path, sizeBytes: req.content.length, revision: 9 }; },
    });
    const hook = await renderHook(
      (props: { liveness: string }) =>
        useWorkspaceEdit(SESSION_ID, { ...ctx, client, path: "a.txt", baseContent: "hello\n", liveness: props.liveness, onWarmRequested: () => { warmRequests += 1; } }),
      { liveness: "cold" },
    );
    await flush();
    expect(hook.result.current.state).toBe("viewing-cold");

    hook.result.current.edit("hello world\n");
    await flush();
    // Cold edit buffers and signals the host to warm ONCE.
    expect(hook.result.current.state).toBe("buffering");
    expect(hook.result.current.buffer).toBe("hello world\n");
    expect(hook.result.current.wantsWarm).toBe(true);
    expect(warmRequests).toBe(1);
    expect(writes).toEqual([]);

    // Box warms → the buffer flushes (live "hello\n" === base "hello\n").
    await hook.rerender({ liveness: "warm" });
    await flush();
    expect(hook.result.current.state).toBe("flushed");
    expect(hook.result.current.wantsWarm).toBe(false);
    expect(writes).toEqual([{ path: "a.txt", content: "hello world\n" }]);
    await hook.unmount();
  });

  test("conflict path: live diverged from base → conflict, NO write (C2)", async () => {
    const writes: unknown[] = [];
    const client = fakeClient({
      // The live file changed on the box since capture.
      fsRead: async (_ws, _s, req) => ({ path: req.path, encoding: "utf8" as const, content: "AGENT CHANGED THIS\n", sizeBytes: 19, truncated: false, isBinary: false, revision: 0 }),
      fsWrite: async () => { writes.push(true); return { path: "a.txt", sizeBytes: 0, revision: 0 }; },
    });
    const hook = await renderHook(
      (props: { liveness: string }) =>
        useWorkspaceEdit(SESSION_ID, { ...ctx, client, path: "a.txt", baseContent: "hello\n", liveness: props.liveness }),
      { liveness: "cold" },
    );
    await flush();
    hook.result.current.edit("my local edit\n");
    await flush();
    await hook.rerender({ liveness: "warm" });
    await flush();
    // Conflict surfaced, NOTHING overwritten.
    expect(hook.result.current.state).toBe("conflict");
    expect(writes).toEqual([]);
    expect(hook.result.current.conflict?.base).toBe("hello\n");
    expect(hook.result.current.conflict?.live).toBe("AGENT CHANGED THIS\n");
    // The user chooses "overwrite" → force flush (last-writer-wins).
    await hook.result.current.overwrite();
    await flush();
    expect(hook.result.current.state).toBe("flushed");
    expect(writes.length).toBe(1);
    await hook.unmount();
  });

  test("self-hosted offline is read-only: no buffering, no wake", async () => {
    let warmRequests = 0;
    const client = fakeClient({});
    const hook = await renderHook(
      () => useWorkspaceEdit(SESSION_ID, { ...ctx, client, path: "a.txt", baseContent: "x", offline: true, onWarmRequested: () => { warmRequests += 1; } }),
      undefined,
    );
    await flush();
    expect(hook.result.current.state).toBe("readonly-offline");
    expect(hook.result.current.readOnly).toBe(true);
    hook.result.current.edit("nope");
    await flush();
    expect(hook.result.current.buffer).toBeNull();
    expect(hook.result.current.wantsWarm).toBe(false);
    expect(warmRequests).toBe(0);
    await hook.unmount();
  });

  test("warming state: host signals the box is coming up", async () => {
    const client = fakeClient({});
    const hook = await renderHook(
      (props: { warming: boolean }) =>
        useWorkspaceEdit(SESSION_ID, { ...ctx, client, path: "a.txt", baseContent: "x", liveness: "cold", warming: props.warming }),
      { warming: false },
    );
    await flush();
    hook.result.current.edit("edit");
    await flush();
    expect(hook.result.current.state).toBe("buffering");
    await hook.rerender({ warming: true });
    await flush();
    expect(hook.result.current.state).toBe("warming");
    await hook.unmount();
  });
});

// ── machine chip derivation (pure) ─────────────────────────────────────────────

describe("deriveMachineChip", () => {
  const NOW = Date.parse("2026-07-08T12:05:00.000Z");

  test("warm lease → live", () => {
    expect(deriveMachineChip({ liveness: "warm" })).toEqual({ state: "live", label: "Live", asOf: null });
    expect(deriveMachineChip({ liveness: "draining" }).state).toBe("live");
  });

  test("negotiating or wanting-warm → waking", () => {
    expect(deriveMachineChip({ liveness: "cold", capabilitiesState: "negotiating" }).state).toBe("waking");
    expect(deriveMachineChip({ liveness: "cold", wantsWarm: true }).state).toBe("waking");
    expect(deriveMachineChip({ activeMachineState: "reconnecting" }).state).toBe("waking");
  });

  test("cold/idle → offline, labelled 'as of <time>'", () => {
    const chip = deriveMachineChip({ liveness: "cold", capturedAt: "2026-07-08T12:00:00.000Z", now: NOW });
    expect(chip.state).toBe("offline");
    expect(chip.asOf).toBe("2026-07-08T12:00:00.000Z");
    expect(chip.label).toBe("Offline — as of 5m ago");
  });

  test("self-hosted offline is honest offline even if warm was requested", () => {
    const chip = deriveMachineChip({
      liveness: "cold", activeIsSelfhosted: true, activeMachineState: "offline",
      wantsWarm: true, capturedAt: "2026-07-08T11:00:00.000Z", now: NOW,
    });
    expect(chip.state).toBe("offline");
    expect(chip.label).toBe("Offline — as of 1h ago");
  });

  test("offline with no capture time reads a bare 'Offline'", () => {
    expect(deriveMachineChip({ liveness: "cold" }).label).toBe("Offline");
  });
});
