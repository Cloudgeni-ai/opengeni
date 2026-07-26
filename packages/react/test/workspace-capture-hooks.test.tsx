/* ----------------------------------------------------------------------------
   M3 (Workbench v2) — the capture data layer.

   The cold-paint hooks: useWorkspaceCapture (mount fetch + announce refresh),
   source selection in use-sandbox-files / use-sandbox-git (capture cold, live
   warm), the FLAGSHIP cold→warm reconcile WITHOUT remounting the tree/diff roots
   (no-flicker, §12-D1), the wake-on-edit state machine (happy + conflict + offline
   + warming, §12-C), and the machine-chip derivation.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  FsTreeNode,
  GetWorkspaceCaptureResponse,
  GitFileDiff,
  SessionEvent,
  WorkspaceCaptureManifest,
  WorkspaceCaptureRepo,
} from "@opengeni/sdk";
import { actRun, registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { fakeEvent } from "./sandbox-fixtures";
import { useWorkspaceCapture } from "../src/hooks/use-workspace-capture";
import {
  CapturedFileUnavailableError,
  FileWriteConflictError,
  useSandboxFiles,
} from "../src/hooks/use-sandbox-files";
import { useSandboxGit } from "../src/hooks/use-sandbox-git";
import { useWorkspaceEdit } from "../src/hooks/use-workspace-edit";
import { deriveMachineChip } from "../src/hooks/use-machine-chip";

registerDom();

const ctx = { workspaceId: WORKSPACE_ID };
const SECOND_SESSION_ID = "33333333-3333-4333-8333-333333333333";

// ── Fixtures ────────────────────────────────────────────────────────────────

function treeDir(name: string, path: string, children?: FsTreeNode[]): FsTreeNode {
  return {
    name,
    path,
    type: "dir",
    sizeBytes: null,
    mtimeMs: null,
    mode: null,
    truncated: false,
    ...(children ? { children } : {}),
  };
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
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        header: "@@ -1 +1,2 @@",
        lines: [{ type: "add", oldNo: null, newNo: 2, text: "x" }],
      },
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
    files: [
      {
        path: "src/app.py",
        status: "modified",
        hash: "h1",
        baseHash: null,
        contentRef: "blob/h1",
        sizeBytes: 20,
        isBinary: false,
        tooLarge: false,
        deleted: false,
      },
    ],
    stats: {
      repoCount: 1,
      fileCount: 1,
      additions: 2,
      deletions: 1,
      totalBytes: 20,
      tooLargeCount: 0,
      binaryCount: 0,
      treeEntryCount: 2,
      treeTruncated: false,
      durationMs: 12,
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
    const hook = await renderHook(
      () => useWorkspaceCapture(SESSION_ID, { ...ctx, client }),
      undefined,
    );
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
    const hook = await renderHook(
      () => useWorkspaceCapture(SESSION_ID, { ...ctx, client }),
      undefined,
    );
    await flush();
    expect(hook.result.current.available).toBe(false);
    expect(hook.result.current.capture).toBeNull();
    expect(hook.result.current.revision).toBeNull();
    await hook.unmount();
  });

  test("an explicit degraded capture keeps live data authoritative", async () => {
    const client = fakeClient({
      getWorkspaceCapture: async () => ({
        available: false,
        degradedReason: "repository_discovery_timed_out",
        revision: 4,
        capturedAt: "2026-07-08T12:00:00.000Z",
        turnId: "turn-2",
        leaseEpoch: 2,
      }),
    });
    const hook = await renderHook(
      () => useWorkspaceCapture(SESSION_ID, { ...ctx, client }),
      undefined,
    );
    await flush();
    expect(hook.result.current.available).toBe(false);
    expect(hook.result.current.capture).toBeNull();
    expect(hook.result.current.degradedReason).toBe("repository_discovery_timed_out");
    await hook.unmount();
  });

  test("follows manifestUrl for the rare >2MB manifest", async () => {
    const manifest = fakeManifest({ revision: 5 });
    const originalFetch = globalThis.fetch;
    let fetched: string | null = null;
    let fetchSignal: AbortSignal | null = null;
    let fetchInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetched = String(url);
      fetchSignal = init?.signal ?? null;
      fetchInit = init;
      return { ok: true, status: 200, json: async () => manifest } as unknown as Response;
    }) as typeof fetch;
    try {
      const client = fakeClient({
        getWorkspaceCapture: async (): Promise<GetWorkspaceCaptureResponse> => ({
          available: true,
          revision: 5,
          capturedAt: manifest.capturedAt,
          turnId: manifest.turnId,
          leaseEpoch: 1,
          sizeBytes: 3_000_000,
          stats: manifest.stats,
          manifest: null,
          manifestUrl: {
            url: "https://blob.example/manifest.json",
            expiresAt: "2026-07-08T12:05:00.000Z",
          },
        }),
      });
      const hook = await renderHook(
        () => useWorkspaceCapture(SESSION_ID, { ...ctx, client }),
        undefined,
      );
      await flush();
      expect(fetched as string | null).toBe("https://blob.example/manifest.json");
      expect(fetchSignal).not.toBeNull();
      expect(fetchInit?.credentials).toBe("omit");
      expect(fetchInit?.cache).toBe("no-store");
      expect(fetchInit?.referrerPolicy).toBe("no-referrer");
      expect(hook.result.current.revision).toBe(5);
      expect(hook.result.current.capture?.files[0]?.path).toBe("src/app.py");
      await hook.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshes an expired signed manifest URL once without leaking credentials", async () => {
    const manifest = fakeManifest({ revision: 5 });
    const originalFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      if (fetched.length === 1) {
        return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => manifest } as unknown as Response;
    }) as typeof fetch;
    let captureCalls = 0;
    try {
      const client = fakeClient({
        getWorkspaceCapture: async (): Promise<GetWorkspaceCaptureResponse> => {
          captureCalls += 1;
          return {
            available: true,
            revision: 5,
            capturedAt: manifest.capturedAt,
            turnId: manifest.turnId,
            leaseEpoch: manifest.leaseEpoch,
            sizeBytes: 3_000_000,
            stats: manifest.stats,
            manifest: null,
            manifestUrl: {
              url: `https://blob.example/manifest-${captureCalls}.json?signature=secret`,
              expiresAt: "2026-07-08T12:05:00.000Z",
            },
          };
        },
      });
      const hook = await renderHook(
        () => useWorkspaceCapture(SESSION_ID, { ...ctx, client }),
        undefined,
      );
      await flush();
      expect(captureCalls).toBe(2);
      expect(fetched).toEqual([
        "https://blob.example/manifest-1.json?signature=secret",
        "https://blob.example/manifest-2.json?signature=secret",
      ]);
      expect(hook.result.current.available).toBe(true);
      expect(hook.result.current.revision).toBe(5);
      expect(hook.result.current.error).toBeNull();
      await hook.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a signed manifest with mismatched revision identity fails closed", async () => {
    const expected = fakeManifest({ revision: 5 });
    const wrong = fakeManifest({ revision: 6 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => wrong,
      }) as unknown as Response) as unknown as typeof fetch;
    try {
      const client = fakeClient({
        getWorkspaceCapture: async (): Promise<GetWorkspaceCaptureResponse> => ({
          available: true,
          revision: 5,
          capturedAt: expected.capturedAt,
          turnId: expected.turnId,
          leaseEpoch: expected.leaseEpoch,
          sizeBytes: 3_000_000,
          stats: expected.stats,
          manifest: null,
          manifestUrl: {
            url: "https://blob.example/mis-keyed.json",
            expiresAt: "2026-07-08T12:05:00.000Z",
          },
        }),
      });
      const hook = await renderHook(
        () => useWorkspaceCapture(SESSION_ID, { ...ctx, client }),
        undefined,
      );
      await flush();
      expect(hook.result.current.available).toBe(false);
      expect(hook.result.current.capture).toBeNull();
      expect(hook.result.current.error?.message).toBe(
        "Workspace capture manifest identity did not match its response.",
      );
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
      (props: { events: SessionEvent[] }) =>
        useWorkspaceCapture(SESSION_ID, { ...ctx, client, events: props.events }),
      { events: [] as SessionEvent[] },
    );
    await flush();
    expect(hook.result.current.revision).toBe(3);
    expect(calls).toBe(1);
    // A newer revision is announced → refresh pulls it (server now serves rev 4).
    served = fakeManifest({ revision: 4 });
    await hook.rerender({
      events: [
        fakeEvent(1, "workspace.revision.captured", {
          revision: 4,
          turnId: "turn-2",
          capturedAt: served.capturedAt,
          leaseEpoch: 1,
          stats: served.stats,
        }),
      ],
    });
    await flush();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(hook.result.current.revision).toBe(4);
    expect(hook.result.current.isStale).toBe(false);
    await hook.unmount();
  });

  test("a newer workspace.revision.degraded announce refreshes to the degraded state", async () => {
    let response: GetWorkspaceCaptureResponse = captureAvailable(fakeManifest({ revision: 3 }));
    let calls = 0;
    const client = fakeClient({
      getWorkspaceCapture: async () => {
        calls += 1;
        return response;
      },
    });
    const hook = await renderHook(
      (props: { events: SessionEvent[] }) =>
        useWorkspaceCapture(SESSION_ID, { ...ctx, client, events: props.events }),
      { events: [] as SessionEvent[] },
    );
    await flush();
    expect(hook.result.current.revision).toBe(3);

    response = {
      available: false,
      degradedReason: "repository_discovery_command_failed",
      revision: 4,
      capturedAt: "2026-07-08T12:01:00.000Z",
      turnId: "turn-2",
      leaseEpoch: 2,
    };
    await hook.rerender({
      events: [
        fakeEvent(1, "workspace.revision.degraded", {
          revision: 4,
          turnId: "turn-2",
          capturedAt: "2026-07-08T12:01:00.000Z",
          leaseEpoch: 2,
          reason: "repository_discovery_command_failed",
        }),
      ],
    });
    await flush();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(hook.result.current.available).toBe(false);
    expect(hook.result.current.capture).toBeNull();
    expect(hook.result.current.degradedReason).toBe("repository_discovery_command_failed");
    await hook.unmount();
  });

  test("disabling the hook fences an older in-flight capture response", async () => {
    let resolveRequest!: (response: GetWorkspaceCaptureResponse) => void;
    const request = new Promise<GetWorkspaceCaptureResponse>((resolve) => {
      resolveRequest = resolve;
    });
    const client = fakeClient({ getWorkspaceCapture: async () => await request });
    const hook = await renderHook(
      (props: { sessionId: string | null }) =>
        useWorkspaceCapture(props.sessionId, { ...ctx, client }),
      { sessionId: SESSION_ID as string | null },
    );

    await hook.rerender({ sessionId: null });
    resolveRequest(captureAvailable(fakeManifest({ revision: 99 })));
    await flush();

    expect(hook.result.current.available).toBe(false);
    expect(hook.result.current.capture).toBeNull();
    expect(hook.result.current.revision).toBeNull();
    await hook.unmount();
  });

  test("a session change resets the capture announcement sequence cursor", async () => {
    const responses = new Map<string, WorkspaceCaptureManifest>([
      [SESSION_ID, fakeManifest({ revision: 50 })],
      [SECOND_SESSION_ID, fakeManifest({ revision: 1 })],
    ]);
    const client = fakeClient({
      getWorkspaceCapture: async (_workspaceId, sessionId) =>
        captureAvailable(responses.get(sessionId)!),
    });
    const hook = await renderHook(
      (props: { sessionId: string; events: SessionEvent[] }) =>
        useWorkspaceCapture(props.sessionId, { ...ctx, client, events: props.events }),
      {
        sessionId: SESSION_ID,
        events: [
          fakeEvent(50, "workspace.revision.captured", {
            revision: 50,
            turnId: "turn-50",
            capturedAt: "2026-07-08T12:00:00.000Z",
            leaseEpoch: 1,
            stats: fakeManifest().stats,
          }),
        ],
      },
    );
    await flush();
    expect(hook.result.current.revision).toBe(50);

    await hook.rerender({ sessionId: SECOND_SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.revision).toBe(1);

    responses.set(SECOND_SESSION_ID, fakeManifest({ revision: 2 }));
    await hook.rerender({
      sessionId: SECOND_SESSION_ID,
      events: [
        fakeEvent(1, "workspace.revision.captured", {
          revision: 2,
          turnId: "turn-2",
          capturedAt: "2026-07-08T12:01:00.000Z",
          leaseEpoch: 1,
          stats: fakeManifest().stats,
        }),
      ],
    });
    await flush();

    expect(hook.result.current.revision).toBe(2);
    expect(hook.result.current.isStale).toBe(false);
    await hook.unmount();
  });

  test("a session switch never exposes the previous session's capture during render", async () => {
    let resolveSecond!: (response: GetWorkspaceCaptureResponse) => void;
    const secondRequest = new Promise<GetWorkspaceCaptureResponse>((resolve) => {
      resolveSecond = resolve;
    });
    const client = fakeClient({
      getWorkspaceCapture: async (_workspaceId, sessionId) =>
        sessionId === SESSION_ID
          ? captureAvailable(fakeManifest({ revision: 10 }))
          : await secondRequest,
    });
    const observed: Array<{ sessionId: string; revision: number | null }> = [];
    const hook = await renderHook(
      (props: { sessionId: string }) => {
        const state = useWorkspaceCapture(props.sessionId, { ...ctx, client });
        observed.push({ sessionId: props.sessionId, revision: state.revision });
        return state;
      },
      { sessionId: SESSION_ID },
    );
    await flush();
    expect(hook.result.current.revision).toBe(10);

    observed.length = 0;
    await hook.rerender({ sessionId: SECOND_SESSION_ID });
    expect(
      observed
        .filter(({ sessionId }) => sessionId === SECOND_SESSION_ID)
        .map(({ revision }) => revision),
    ).not.toContain(10);
    expect(hook.result.current.capture).toBeNull();

    resolveSecond(captureAvailable(fakeManifest({ revision: 1 })));
    await flush();
    expect(hook.result.current.revision).toBe(1);
    await hook.unmount();
  });

  test("a session switch aborts the obsolete capture request", async () => {
    let firstSignal: AbortSignal | undefined;
    const firstRequest = new Promise<GetWorkspaceCaptureResponse>(() => {});
    const client = fakeClient({
      getWorkspaceCapture: async (_workspaceId, sessionId, options) => {
        if (sessionId === SESSION_ID) {
          firstSignal = options?.signal;
          return await firstRequest;
        }
        return captureAvailable(fakeManifest({ revision: 2 }));
      },
    });
    const hook = await renderHook(
      (props: { sessionId: string }) => useWorkspaceCapture(props.sessionId, { ...ctx, client }),
      { sessionId: SESSION_ID },
    );
    await flush();
    expect(firstSignal?.aborted).toBe(false);

    await hook.rerender({ sessionId: SECOND_SESSION_ID });
    await flush();

    expect(firstSignal?.aborted).toBe(true);
    expect(hook.result.current.revision).toBe(2);
    await hook.unmount();
  });
});

// ── use-sandbox-files: source selection + no-flicker reconcile ─────────────────

describe("useSandboxFiles — capture source", () => {
  test("cold + capture paints the tree from the index with ZERO Channel-A calls", async () => {
    let fsListCalls = 0;
    let gitStatusCalls = 0;
    const client = fakeClient({
      fsList: async () => {
        fsListCalls += 1;
        return { root: treeDir("", ""), revision: 0, truncated: false };
      },
      gitStatus: async () => {
        gitStatusCalls += 1;
        return {
          isRepo: false,
          head: null,
          detached: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
          revision: 0,
        };
      },
    });
    const hook = await renderHook(
      () =>
        useSandboxFiles(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: "cold" }),
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

  test("cold preview reads and verifies a turn-touched file from capture without waking the box", async () => {
    const content = "captured hello\n";
    const hash = createHash("sha256").update(content).digest("hex");
    let fsReadCalls = 0;
    let captureFileCalls = 0;
    const capture = fakeManifest({
      files: [
        {
          ...fakeManifest().files[0]!,
          path: "src/app.py",
          hash,
          sizeBytes: Buffer.byteLength(content),
        },
      ],
    });
    const client = fakeClient({
      fsRead: async () => {
        fsReadCalls += 1;
        throw new Error("cold captured preview must not call live fs.read");
      },
      getWorkspaceCaptureFile: async (_workspaceId, _sessionId, path, revision) => {
        captureFileCalls += 1;
        return {
          path,
          revision: revision!,
          status: "modified",
          hash,
          baseHash: null,
          sizeBytes: Buffer.byteLength(content),
          isBinary: false,
          tooLarge: false,
          encoding: "utf8",
          content,
          contentUrl: null,
        };
      },
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { ...ctx, client, capture, liveness: "cold" }),
      undefined,
    );
    await flush();

    const read = await hook.result.current.readFile("src/app.py");
    expect(read.content).toBe(content);
    expect(read.revision).toBe(capture.revision);
    expect(captureFileCalls).toBe(1);
    expect(fsReadCalls).toBe(0);
    await hook.unmount();
  });

  test("an untouched cold file requires explicit live intent and never calls fs.read", async () => {
    let fsReadCalls = 0;
    const capture = fakeManifest();
    const client = fakeClient({
      fsRead: async () => {
        fsReadCalls += 1;
        throw new Error("passive capture browsing must not read the live box");
      },
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { ...ctx, client, capture, liveness: "cold" }),
      undefined,
    );
    await flush();

    try {
      await hook.result.current.readFile("README.md");
      throw new Error("expected untouched capture file to require the live workspace");
    } catch (error) {
      expect(error).toBeInstanceOf(CapturedFileUnavailableError);
      expect((error as CapturedFileUnavailableError).reason).toBe("not-captured");
    }
    expect(fsReadCalls).toBe(0);
    await hook.unmount();
  });

  test("expanding a cold capture directory never issues fs.list", async () => {
    let fsListCalls = 0;
    const client = fakeClient({
      fsList: async () => {
        fsListCalls += 1;
        throw new Error("capture residue must not list the live box");
      },
    });
    const hook = await renderHook(
      () =>
        useSandboxFiles(SESSION_ID, {
          ...ctx,
          client,
          capture: fakeManifest(),
          liveness: "cold",
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.tree.find((node) => node.path === "src")?.children).toEqual([]);
    await hook.result.current.expand("src");
    expect(fsListCalls).toBe(0);
    await hook.unmount();
  });

  test("an expired captured-file URL is refreshed once and the downloaded bytes are verified", async () => {
    const originalFetch = globalThis.fetch;
    const content = "signed capture\n";
    const hash = createHash("sha256").update(content).digest("hex");
    let apiCalls = 0;
    let downloadCalls = 0;
    const capture = fakeManifest({
      files: [
        {
          ...fakeManifest().files[0]!,
          path: "src/app.py",
          hash,
          sizeBytes: Buffer.byteLength(content),
        },
      ],
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => {
        downloadCalls += 1;
        return downloadCalls === 1
          ? new Response("expired", { status: 403 })
          : new Response(content, { status: 200 });
      },
    });
    try {
      const client = fakeClient({
        getWorkspaceCaptureFile: async (_workspaceId, _sessionId, path, revision) => {
          apiCalls += 1;
          return {
            path,
            revision: revision!,
            status: "modified",
            hash,
            baseHash: null,
            sizeBytes: Buffer.byteLength(content),
            isBinary: false,
            tooLarge: false,
            encoding: null,
            content: null,
            contentUrl: {
              url: `https://capture.invalid/file-${apiCalls}`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      });
      const hook = await renderHook(
        () => useSandboxFiles(SESSION_ID, { ...ctx, client, capture, liveness: "cold" }),
        undefined,
      );
      await flush();

      expect((await hook.result.current.readFile("src/app.py")).content).toBe(content);
      expect(apiCalls).toBe(2);
      expect(downloadCalls).toBe(2);
      await hook.unmount();
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });

  test("corrupt captured bytes fail closed instead of rendering storage drift", async () => {
    const expected = "captured hello\n";
    const corrupt = "captured jello\n";
    const hash = createHash("sha256").update(expected).digest("hex");
    const capture = fakeManifest({
      files: [
        {
          ...fakeManifest().files[0]!,
          path: "src/app.py",
          hash,
          sizeBytes: Buffer.byteLength(corrupt),
        },
      ],
    });
    const client = fakeClient({
      getWorkspaceCaptureFile: async (_workspaceId, _sessionId, path, revision) => ({
        path,
        revision: revision!,
        status: "modified",
        hash,
        baseHash: null,
        sizeBytes: Buffer.byteLength(corrupt),
        isBinary: false,
        tooLarge: false,
        encoding: "utf8",
        content: corrupt,
        contentUrl: null,
      }),
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { ...ctx, client, capture, liveness: "cold" }),
      undefined,
    );
    await flush();

    await expect(hook.result.current.readFile("src/app.py")).rejects.toThrow(
      "failed its integrity check",
    );
    await hook.unmount();
  });

  test("warm reconciles the capture to the live path when the provider succeeds", async () => {
    let fsListCalls = 0;
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      fsList: async () => {
        fsListCalls += 1;
        return {
          root: treeDir("", "", [treeFile("live.ts", "live.ts", 5)]),
          revision: 0,
          truncated: false,
        };
      },
    });
    const hook = await renderHook(
      () =>
        useSandboxFiles(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: "warm" }),
      undefined,
    );
    await flush();
    expect(fsListCalls).toBe(1);
    expect(hook.result.current.source).toBe("live");
    expect(hook.result.current.tree.map((n) => n.name)).toEqual(["live.ts"]);
    await hook.unmount();
  });

  test("warm live-list failure preserves the capture and reads captured content server-side", async () => {
    const content = "captured during provider failure\n";
    const hash = createHash("sha256").update(content).digest("hex");
    const capture = fakeManifest({
      files: [
        {
          ...fakeManifest().files[0]!,
          hash,
          sizeBytes: Buffer.byteLength(content),
        },
      ],
    });
    let fsReadCalls = 0;
    let captureFileCalls = 0;
    let failLiveList = true;
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      fsList: async () => {
        if (failLiveList) {
          throw new Error("OpenGeni API 503: Workspace files are temporarily unavailable");
        }
        return {
          root: treeDir("", "", [treeFile("app.py", "src/app.py", 13)]),
          revision: 4,
          truncated: false,
        };
      },
      fsRead: async (_workspaceId, _sessionId, request) => {
        fsReadCalls += 1;
        return {
          path: request.path,
          encoding: "utf8",
          content: "live content\n",
          sizeBytes: 13,
          truncated: false,
          isBinary: false,
          revision: 4,
        };
      },
      getWorkspaceCaptureFile: async (_workspaceId, _sessionId, path, revision) => {
        captureFileCalls += 1;
        return {
          path,
          revision: revision!,
          status: "modified",
          hash,
          baseHash: null,
          sizeBytes: Buffer.byteLength(content),
          isBinary: false,
          tooLarge: false,
          encoding: "utf8",
          content,
          contentUrl: null,
        };
      },
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { ...ctx, client, capture, liveness: "warm" }),
      undefined,
    );
    await flush();

    expect(hook.result.current.source).toBe("capture");
    expect(hook.result.current.tree.map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(hook.result.current.error?.message).toContain("503");
    const read = await hook.result.current.readFile("src/app.py");
    expect(read.content).toBe(content);
    expect(captureFileCalls).toBe(1);
    expect(fsReadCalls).toBe(0);

    failLiveList = false;
    await actRun(() => hook.result.current.refresh());
    await flush();
    expect(hook.result.current.source).toBe("live");
    expect(hook.result.current.error).toBeNull();
    const liveRead = await hook.result.current.readFile("src/app.py");
    expect(liveRead.content).toBe("live content\n");
    expect(fsReadCalls).toBe(1);
    await hook.unmount();
  });

  test("editor save detects live divergence and requires an explicit overwrite", async () => {
    let writes = 0;
    let mutationErrors = 0;
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      fsList: async () => ({
        root: treeDir("", "", [treeFile("app.py", "app.py", 16)]),
        revision: 0,
        truncated: false,
      }),
      fsRead: async () => ({
        path: "app.py",
        encoding: "utf8",
        content: "changed by agent\n",
        sizeBytes: 17,
        truncated: false,
        isBinary: false,
        revision: 1,
      }),
      fsWrite: async (_workspaceId, _sessionId, request) => {
        writes += 1;
        return { path: request.path, sizeBytes: request.content.length, revision: 2 };
      },
    });
    const hook = await renderHook(
      () =>
        useSandboxFiles(SESSION_ID, {
          ...ctx,
          client,
          liveness: "warm",
          onMutationError: () => {
            mutationErrors += 1;
          },
        }),
      undefined,
    );
    await flush();

    let conflict: unknown;
    await actRun(async () => {
      try {
        await hook.result.current.writeFile("app.py", "my edit\n", {
          expectedContent: "original\n",
        });
      } catch (error) {
        conflict = error;
      }
    });
    expect(conflict).toBeInstanceOf(FileWriteConflictError);
    expect((conflict as FileWriteConflictError).liveContent).toBe("changed by agent\n");
    expect(writes).toBe(0);
    expect(mutationErrors).toBe(0);
    expect(hook.result.current.error).toBeNull();

    await actRun(() => hook.result.current.writeFile("app.py", "my edit\n", { force: true }));
    expect(writes).toBe(1);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("FLAGSHIP: cold→warm reconcile keeps node identity — no remount, deltas patched", async () => {
    let fsListCalls = 0;
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      // The live list returns the SAME two entries the capture had (unchanged),
      // plus a new file — the delta that must be patched in.
      fsList: async () => {
        fsListCalls += 1;
        return {
          root: treeDir("", "", [
            treeDir("src", "src"),
            treeFile("README.md", "README.md", 10),
            treeFile("new.ts", "new.ts", 3),
          ]),
          revision: 1,
          truncated: false,
        };
      },
    });
    const hook = await renderHook(
      (props: { liveness: string }) =>
        useSandboxFiles(SESSION_ID, {
          ...ctx,
          client,
          capture: fakeManifest(),
          liveness: props.liveness,
        }),
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
    expect(fsListCalls).toBe(1);

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
      gitStatus: async () => ({
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      fsList: async () => {
        fsListCalls += 1;
        return {
          root: treeDir("", "", [treeFile("a.ts", "a.ts", 1)]),
          revision: 0,
          truncated: false,
        };
      },
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

  test("a session change resets the filesystem event sequence cursor", async () => {
    const fileBySession = new Map([
      [SESSION_ID, "first.ts"],
      [SECOND_SESSION_ID, "second-old.ts"],
    ]);
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      fsList: async (_workspaceId, sessionId) => {
        const file = fileBySession.get(sessionId)!;
        return {
          root: treeDir("", "", [treeFile(file, file, 1)]),
          revision: 0,
          truncated: false,
        };
      },
    });
    const hook = await renderHook(
      (props: { sessionId: string; events: SessionEvent[] }) =>
        useSandboxFiles(props.sessionId, {
          ...ctx,
          client,
          events: props.events,
          liveness: "warm",
        }),
      { sessionId: SESSION_ID, events: [fakeEvent(50, "session.title_set")] },
    );
    await flush();

    await hook.rerender({ sessionId: SECOND_SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.tree.map((node) => node.path)).toEqual(["second-old.ts"]);

    fileBySession.set(SECOND_SESSION_ID, "second-new.ts");
    await hook.rerender({
      sessionId: SECOND_SESSION_ID,
      events: [
        fakeEvent(1, "fs.changed", {
          revision: 1,
          source: "agent",
          changes: [{ path: "second-new.ts" }],
        }),
      ],
    });
    await flush(200);

    expect(hook.result.current.tree.map((node) => node.path)).toEqual(["second-new.ts"]);
    await hook.unmount();
  });

  test("a late filesystem response from the previous session cannot replace the new tree", async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveFirst!: (value: { root: FsTreeNode; revision: number; truncated: boolean }) => void;
    const firstList = new Promise<{
      root: FsTreeNode;
      revision: number;
      truncated: boolean;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      fsList: async (_workspaceId, sessionId, _request, options) => {
        if (sessionId === SESSION_ID) {
          firstSignal = options?.signal;
          return await firstList;
        }
        return {
          root: treeDir("", "", [treeFile("second.ts", "second.ts", 1)]),
          revision: 0,
          truncated: false,
        };
      },
    });
    const hook = await renderHook(
      (props: { sessionId: string }) =>
        useSandboxFiles(props.sessionId, { ...ctx, client, liveness: "warm" }),
      { sessionId: SESSION_ID },
    );
    await flush();

    await hook.rerender({ sessionId: SECOND_SESSION_ID });
    await flush();
    expect(firstSignal?.aborted).toBe(true);
    expect(hook.result.current.tree.map((node) => node.path)).toEqual(["second.ts"]);

    resolveFirst({
      root: treeDir("", "", [treeFile("first-late.ts", "first-late.ts", 1)]),
      revision: 0,
      truncated: false,
    });
    await flush();

    expect(hook.result.current.tree.map((node) => node.path)).toEqual(["second.ts"]);
    expect(hook.result.current.source).toBe("live");
    await hook.unmount();
  });

  test("a session switch renders zero frames of the previous filesystem tree", async () => {
    const pendingSecond = new Promise<{
      root: FsTreeNode;
      revision: number;
      truncated: boolean;
    }>(() => {});
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false,
        head: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      fsList: async (_workspaceId, sessionId) =>
        sessionId === SESSION_ID
          ? {
              root: treeDir("", "", [treeFile("first.ts", "first.ts", 1)]),
              revision: 0,
              truncated: false,
            }
          : await pendingSecond,
    });
    const observed: Array<{ sessionId: string; paths: string[] }> = [];
    const hook = await renderHook(
      (props: { sessionId: string }) => {
        const state = useSandboxFiles(props.sessionId, { ...ctx, client, liveness: "warm" });
        observed.push({ sessionId: props.sessionId, paths: state.tree.map((node) => node.path) });
        return state;
      },
      { sessionId: SESSION_ID },
    );
    await flush();
    expect(hook.result.current.tree.map((node) => node.path)).toEqual(["first.ts"]);

    observed.length = 0;
    await hook.rerender({ sessionId: SECOND_SESSION_ID });

    expect(
      observed
        .filter(({ sessionId }) => sessionId === SECOND_SESSION_ID)
        .flatMap(({ paths }) => paths),
    ).not.toContain("first.ts");
    await hook.unmount();
  });

  test("a newer capture updates truncated-directory metadata without remounting siblings", async () => {
    const client = fakeClient({});
    const first = fakeManifest({
      revision: 1,
      treeIndex: treeDir("", "", [
        { ...treeDir("vendor", "vendor"), truncated: true },
        treeFile("stable.ts", "stable.ts", 1),
      ]),
    });
    const hook = await renderHook(
      (props: { capture: WorkspaceCaptureManifest }) =>
        useSandboxFiles(SESSION_ID, {
          ...ctx,
          client,
          liveness: "cold",
          capture: props.capture,
        }),
      { capture: first },
    );
    await flush();
    const stableBefore = hook.result.current.tree.find((node) => node.path === "stable.ts");
    expect(hook.result.current.tree.find((node) => node.path === "vendor")?.truncated).toBe(true);

    await hook.rerender({
      capture: fakeManifest({
        revision: 2,
        treeIndex: treeDir("", "", [
          treeDir("vendor", "vendor"),
          treeFile("stable.ts", "stable.ts", 1),
        ]),
      }),
    });
    await flush();

    expect(hook.result.current.tree.find((node) => node.path === "vendor")?.truncated).toBeFalsy();
    expect(hook.result.current.tree.find((node) => node.path === "stable.ts")).toBe(stableBefore);
    await hook.unmount();
  });

  test("a clean git status removes stale file-tree modification tints", async () => {
    let dirty = true;
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: dirty
          ? [
              {
                path: "app.ts",
                index: null,
                worktree: "modified" as const,
                oldPath: null,
                isConflicted: false,
              },
            ]
          : [],
        revision: 0,
      }),
      fsList: async () => ({
        root: treeDir("", "", [treeFile("app.ts", "app.ts", 1)]),
        revision: 0,
        truncated: false,
      }),
    });
    const hook = await renderHook(
      (props: { events: SessionEvent[] }) =>
        useSandboxFiles(SESSION_ID, {
          ...ctx,
          client,
          events: props.events,
          liveness: "warm",
        }),
      { events: [] as SessionEvent[] },
    );
    await flush();
    expect(hook.result.current.tree[0]?.status).toBe("modified");

    dirty = false;
    await hook.rerender({ events: [fakeEvent(1, "git.changed")] });
    await flush(200);

    expect(hook.result.current.tree[0]?.status).toBeUndefined();
    await hook.unmount();
  });
});

// ── use-sandbox-git: source selection + no-flicker ─────────────────────────────

describe("useSandboxGit — capture source", () => {
  test("cold + capture serves the diff from the capture repo (no gitDiff RPC)", async () => {
    let gitDiffCalls = 0;
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 1,
      }),
      gitDiff: async () => {
        gitDiffCalls += 1;
        return { files: [], revision: 1 };
      },
    });
    const hook = await renderHook(
      () =>
        useSandboxGit(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: "cold" }),
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

  test("cold multi-repo capture aggregates every repo with workspace-qualified paths", async () => {
    let gitStatusCalls = 0;
    let gitDiffCalls = 0;
    const client = fakeClient({
      gitStatus: async () => {
        gitStatusCalls += 1;
        throw new Error("cold capture must not call live Git status");
      },
      gitDiff: async () => {
        gitDiffCalls += 1;
        throw new Error("cold capture must not call live Git diff");
      },
    });
    const capture = fakeManifest({
      repos: [
        fakeRepo({
          root: "api",
          head: "api-main",
          ahead: 1,
          diff: [fakeDiff({ path: "src/server.ts" })],
        }),
        fakeRepo({
          root: "web",
          head: "web-main",
          behind: 2,
          diff: [fakeDiff({ path: "src/app.tsx", oldPath: "src/old-app.tsx" })],
        }),
      ],
      stats: { ...fakeManifest().stats, repoCount: 2, fileCount: 2 },
    });
    const hook = await renderHook(
      () =>
        useSandboxGit(SESSION_ID, {
          ...ctx,
          client,
          capture,
          liveness: "cold",
          repoPaths: ["api", "web"],
        }),
      undefined,
    );
    await flush();

    expect(hook.result.current.source).toBe("capture");
    expect(hook.result.current.repoCount).toBe(2);
    expect(hook.result.current.repoRoots).toEqual(["api", "web"]);
    expect(hook.result.current.branch).toBeNull();
    expect(hook.result.current.ahead).toBe(1);
    expect(hook.result.current.behind).toBe(2);
    expect(hook.result.current.diff.map((file) => [file.path, file.repoRoot])).toEqual([
      ["api/src/server.ts", "api"],
      ["web/src/app.tsx", "web"],
    ]);
    expect(hook.result.current.diff[1]?.oldPath).toBe("web/src/old-app.tsx");
    expect(gitStatusCalls).toBe(0);
    expect(gitDiffCalls).toBe(0);
    await hook.unmount();
  });

  test("multi-repo cold→warm reconciliation preserves unchanged qualified file identity", async () => {
    const capture = fakeManifest({
      repos: [
        fakeRepo({ root: "api", diff: [fakeDiff({ path: "src/server.ts" })] }),
        fakeRepo({ root: "web", diff: [fakeDiff({ path: "src/app.tsx" })] }),
      ],
      stats: { ...fakeManifest().stats, repoCount: 2, fileCount: 2 },
    });
    const client = fakeClient({
      gitStatus: async (_workspaceId, _sessionId, request) => ({
        isRepo: true,
        head: `${request?.path ?? "root"}-main`,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 1,
      }),
      gitDiff: async (_workspaceId, _sessionId, request) => ({
        files: [fakeDiff({ path: request?.path === "api" ? "src/server.ts" : "src/app.tsx" })],
        revision: 1,
      }),
    });
    const hook = await renderHook(
      (props: { liveness: string }) =>
        useSandboxGit(SESSION_ID, {
          ...ctx,
          client,
          capture,
          liveness: props.liveness,
          // Reversed input proves root ordering is canonical, not caller-identity driven.
          repoPaths: ["web", "api"],
        }),
      { liveness: "cold" },
    );
    await flush();
    const coldApi = hook.result.current.diff.find((file) => file.path === "api/src/server.ts");
    const coldWeb = hook.result.current.diff.find((file) => file.path === "web/src/app.tsx");
    expect(coldApi).toBeDefined();
    expect(coldWeb).toBeDefined();

    await hook.rerender({ liveness: "warm" });
    await flush();
    expect(hook.result.current.source).toBe("live");
    expect(
      Object.is(
        hook.result.current.diff.find((file) => file.path === "api/src/server.ts"),
        coldApi,
      ),
    ).toBe(true);
    expect(
      Object.is(
        hook.result.current.diff.find((file) => file.path === "web/src/app.tsx"),
        coldWeb,
      ),
    ).toBe(true);
    await hook.unmount();
  });

  test("cold→warm swaps to the live diff, preserving unchanged file-section identity", async () => {
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 1,
      }),
      // Live diff repeats the same app.py (unchanged) + a new file.
      gitDiff: async () => ({
        files: [fakeDiff(), fakeDiff({ path: "extra.py", additions: 1, deletions: 0 })],
        revision: 1,
      }),
    });
    const hook = await renderHook(
      (props: { liveness: string }) =>
        useSandboxGit(SESSION_ID, {
          ...ctx,
          client,
          capture: fakeManifest(),
          liveness: props.liveness,
        }),
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

  test("warm reconciles the capture to the live diff", async () => {
    let gitDiffCalls = 0;
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true,
        head: "feature",
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 1,
      }),
      gitDiff: async () => {
        gitDiffCalls += 1;
        return { files: [fakeDiff({ path: "live-only.py" })], revision: 1 };
      },
    });
    const hook = await renderHook(
      () =>
        useSandboxGit(SESSION_ID, { ...ctx, client, capture: fakeManifest(), liveness: "warm" }),
      undefined,
    );
    await flush();
    expect(gitDiffCalls).toBeGreaterThan(0);
    expect(hook.result.current.source).toBe("live");
    expect(hook.result.current.diff.map((d) => d.path)).toEqual(["live-only.py"]);
    await hook.unmount();
  });

  test("warm live-Git failure preserves the captured review diff", async () => {
    const client = fakeClient({
      gitStatus: async () => {
        throw new Error("OpenGeni API 503: Workspace files are temporarily unavailable");
      },
    });
    const hook = await renderHook(
      () =>
        useSandboxGit(SESSION_ID, {
          ...ctx,
          client,
          capture: fakeManifest(),
          liveness: "warm",
        }),
      undefined,
    );
    await flush();

    expect(hook.result.current.source).toBe("capture");
    expect(hook.result.current.diff.map((file) => file.path)).toEqual(["app.py"]);
    expect(hook.result.current.error?.message).toContain("503");
    await hook.unmount();
  });

  test("a session change resets the git event sequence cursor", async () => {
    const pathBySession = new Map([
      [SESSION_ID, "first.ts"],
      [SECOND_SESSION_ID, "second-old.ts"],
    ]);
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      gitDiff: async (_workspaceId, sessionId) => ({
        files: [fakeDiff({ path: pathBySession.get(sessionId)! })],
        revision: 0,
      }),
    });
    const hook = await renderHook(
      (props: { sessionId: string; events: SessionEvent[] }) =>
        useSandboxGit(props.sessionId, {
          ...ctx,
          client,
          events: props.events,
          liveness: "warm",
        }),
      { sessionId: SESSION_ID, events: [fakeEvent(50, "git.changed")] },
    );
    await flush();

    await hook.rerender({ sessionId: SECOND_SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.diff.map((file) => file.path)).toEqual(["second-old.ts"]);

    pathBySession.set(SECOND_SESSION_ID, "second-new.ts");
    await hook.rerender({
      sessionId: SECOND_SESSION_ID,
      events: [fakeEvent(1, "git.changed")],
    });
    await flush();

    expect(hook.result.current.diff.map((file) => file.path)).toEqual(["second-new.ts"]);
    await hook.unmount();
  });

  test("a same-shape git refresh replaces changed hunk content", async () => {
    let lineText = "old line";
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      gitDiff: async () => ({
        files: [
          fakeDiff({
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 2,
                header: "@@ -1 +1,2 @@",
                lines: [{ type: "add", oldNo: null, newNo: 2, text: lineText }],
              },
            ],
          }),
        ],
        revision: 0,
      }),
    });
    const hook = await renderHook(
      (props: { events: SessionEvent[] }) =>
        useSandboxGit(SESSION_ID, { ...ctx, client, events: props.events, liveness: "warm" }),
      { events: [] as SessionEvent[] },
    );
    await flush();
    expect(hook.result.current.diff[0]?.hunks[0]?.lines[0]?.text).toBe("old line");

    lineText = "new line";
    await hook.rerender({ events: [fakeEvent(1, "git.changed")] });
    await flush();

    expect(hook.result.current.diff[0]?.hunks[0]?.lines[0]?.text).toBe("new line");
    await hook.unmount();
  });

  test("a late git response from the previous session cannot replace the new diff", async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveFirst!: (value: { files: GitFileDiff[]; revision: number }) => void;
    const firstDiff = new Promise<{ files: GitFileDiff[]; revision: number }>((resolve) => {
      resolveFirst = resolve;
    });
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      gitDiff: async (_workspaceId, sessionId, _request, options) => {
        if (sessionId === SESSION_ID) {
          firstSignal = options?.signal;
          return await firstDiff;
        }
        return { files: [fakeDiff({ path: "second.ts" })], revision: 0 };
      },
    });
    const hook = await renderHook(
      (props: { sessionId: string }) =>
        useSandboxGit(props.sessionId, { ...ctx, client, liveness: "warm" }),
      { sessionId: SESSION_ID },
    );
    await flush();

    await hook.rerender({ sessionId: SECOND_SESSION_ID });
    await flush();
    expect(firstSignal?.aborted).toBe(true);
    expect(hook.result.current.diff.map((file) => file.path)).toEqual(["second.ts"]);

    resolveFirst({ files: [fakeDiff({ path: "first-late.ts" })], revision: 0 });
    await flush();

    expect(hook.result.current.diff.map((file) => file.path)).toEqual(["second.ts"]);
    expect(hook.result.current.source).toBe("live");
    await hook.unmount();
  });

  test("a session switch renders zero frames of the previous git diff", async () => {
    const pendingSecond = new Promise<{ files: GitFileDiff[]; revision: number }>(() => {});
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        revision: 0,
      }),
      gitDiff: async (_workspaceId, sessionId) =>
        sessionId === SESSION_ID
          ? { files: [fakeDiff({ path: "first.ts" })], revision: 0 }
          : await pendingSecond,
    });
    const observed: Array<{ sessionId: string; paths: string[] }> = [];
    const hook = await renderHook(
      (props: { sessionId: string }) => {
        const state = useSandboxGit(props.sessionId, { ...ctx, client, liveness: "warm" });
        observed.push({ sessionId: props.sessionId, paths: state.diff.map((file) => file.path) });
        return state;
      },
      { sessionId: SESSION_ID },
    );
    await flush();
    expect(hook.result.current.diff.map((file) => file.path)).toEqual(["first.ts"]);

    observed.length = 0;
    await hook.rerender({ sessionId: SECOND_SESSION_ID });

    expect(
      observed
        .filter(({ sessionId }) => sessionId === SECOND_SESSION_ID)
        .flatMap(({ paths }) => paths),
    ).not.toContain("first.ts");
    await hook.unmount();
  });
});

// ── use-workspace-edit: the wake-on-edit state machine ─────────────────────────

describe("useWorkspaceEdit", () => {
  test("happy path: cold edit → warm → guarded flush (hash matches)", async () => {
    const writes: { path: string; content: string }[] = [];
    let warmRequests = 0;
    const client = fakeClient({
      fsRead: async (_ws, _s, req) => ({
        path: req.path,
        encoding: "utf8" as const,
        content: "hello\n",
        sizeBytes: 6,
        truncated: false,
        isBinary: false,
        revision: 0,
      }),
      fsWrite: async (_ws, _s, req) => {
        writes.push({ path: req.path, content: req.content });
        return { path: req.path, sizeBytes: req.content.length, revision: 9 };
      },
    });
    const hook = await renderHook(
      (props: { liveness: string }) =>
        useWorkspaceEdit(SESSION_ID, {
          ...ctx,
          client,
          path: "a.txt",
          baseContent: "hello\n",
          liveness: props.liveness,
          onWarmRequested: () => {
            warmRequests += 1;
          },
        }),
      { liveness: "cold" },
    );
    await flush();
    expect(hook.result.current.state).toBe("viewing-cold");

    await actRun(() => hook.result.current.edit("hello world\n"));
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
      fsRead: async (_ws, _s, req) => ({
        path: req.path,
        encoding: "utf8" as const,
        content: "AGENT CHANGED THIS\n",
        sizeBytes: 19,
        truncated: false,
        isBinary: false,
        revision: 0,
      }),
      fsWrite: async () => {
        writes.push(true);
        return { path: "a.txt", sizeBytes: 0, revision: 0 };
      },
    });
    const hook = await renderHook(
      (props: { liveness: string }) =>
        useWorkspaceEdit(SESSION_ID, {
          ...ctx,
          client,
          path: "a.txt",
          baseContent: "hello\n",
          liveness: props.liveness,
        }),
      { liveness: "cold" },
    );
    await flush();
    await actRun(() => hook.result.current.edit("my local edit\n"));
    await flush();
    await hook.rerender({ liveness: "warm" });
    await flush();
    // Conflict surfaced, NOTHING overwritten.
    expect(hook.result.current.state).toBe("conflict");
    expect(writes).toEqual([]);
    expect(hook.result.current.conflict?.base).toBe("hello\n");
    expect(hook.result.current.conflict?.live).toBe("AGENT CHANGED THIS\n");
    // The user chooses "overwrite" → force flush (last-writer-wins).
    await actRun(() => hook.result.current.overwrite());
    await flush();
    expect(hook.result.current.state).toBe("flushed");
    expect(writes.length).toBe(1);
    await hook.unmount();
  });

  test("self-hosted offline is read-only: no buffering, no wake", async () => {
    let warmRequests = 0;
    const client = fakeClient({});
    const hook = await renderHook(
      () =>
        useWorkspaceEdit(SESSION_ID, {
          ...ctx,
          client,
          path: "a.txt",
          baseContent: "x",
          offline: true,
          onWarmRequested: () => {
            warmRequests += 1;
          },
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.state).toBe("readonly-offline");
    expect(hook.result.current.readOnly).toBe(true);
    await actRun(() => hook.result.current.edit("nope"));
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
        useWorkspaceEdit(SESSION_ID, {
          ...ctx,
          client,
          path: "a.txt",
          baseContent: "x",
          liveness: "cold",
          warming: props.warming,
        }),
      { warming: false },
    );
    await flush();
    await actRun(() => hook.result.current.edit("edit"));
    await flush();
    expect(hook.result.current.state).toBe("buffering");
    await hook.rerender({ warming: true });
    await flush();
    expect(hook.result.current.state).toBe("warming");
    await hook.unmount();
  });

  test("a session switch aborts an obsolete conflict-check read", async () => {
    let firstSignal: AbortSignal | undefined;
    const client = fakeClient({
      fsRead: async (_workspaceId, sessionId, request, options) => {
        if (sessionId === SESSION_ID) {
          firstSignal = options?.signal;
          return await new Promise<never>(() => {});
        }
        return {
          path: request.path,
          encoding: "utf8" as const,
          content: "second\n",
          sizeBytes: 7,
          truncated: false,
          isBinary: false,
          revision: 0,
        };
      },
    });
    const hook = await renderHook(
      (props: { sessionId: string; liveness: string }) =>
        useWorkspaceEdit(props.sessionId, {
          ...ctx,
          client,
          path: "a.txt",
          baseContent: "first\n",
          liveness: props.liveness,
        }),
      { sessionId: SESSION_ID, liveness: "cold" },
    );
    await flush();
    await actRun(() => hook.result.current.edit("edited\n"));
    await hook.rerender({ sessionId: SESSION_ID, liveness: "warm" });
    await flush();
    expect(firstSignal?.aborted).toBe(false);

    await hook.rerender({ sessionId: SECOND_SESSION_ID, liveness: "cold" });
    await flush();

    expect(firstSignal?.aborted).toBe(true);
    expect(hook.result.current.state).toBe("viewing-cold");
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("a completed write from the previous session cannot settle the new editor", async () => {
    let resolveWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const client = fakeClient({
      fsRead: async (_workspaceId, _sessionId, request) => ({
        path: request.path,
        encoding: "utf8" as const,
        content: "base\n",
        sizeBytes: 5,
        truncated: false,
        isBinary: false,
        revision: 0,
      }),
      fsWrite: async (_workspaceId, sessionId, request) => {
        if (sessionId === SESSION_ID) await firstWrite;
        return { path: request.path, sizeBytes: request.content.length, revision: 1 };
      },
    });
    const hook = await renderHook(
      (props: { sessionId: string; liveness: string }) =>
        useWorkspaceEdit(props.sessionId, {
          ...ctx,
          client,
          path: "a.txt",
          baseContent: "base\n",
          liveness: props.liveness,
        }),
      { sessionId: SESSION_ID, liveness: "cold" },
    );
    await flush();
    await actRun(() => hook.result.current.edit("edited\n"));
    await hook.rerender({ sessionId: SESSION_ID, liveness: "warm" });
    await flush();
    expect(hook.result.current.state).toBe("flushing");

    await hook.rerender({ sessionId: SECOND_SESSION_ID, liveness: "cold" });
    await flush();
    resolveWrite();
    await flush();

    expect(hook.result.current.state).toBe("viewing-cold");
    expect(hook.result.current.buffer).toBeNull();
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("a session switch renders zero frames of the previous edit buffer", async () => {
    const client = fakeClient({});
    const observed: Array<{
      sessionId: string;
      state: string;
      buffer: string | null;
    }> = [];
    const hook = await renderHook(
      (props: { sessionId: string }) => {
        const state = useWorkspaceEdit(props.sessionId, {
          ...ctx,
          client,
          path: "a.txt",
          baseContent: "base\n",
          liveness: "cold",
        });
        observed.push({ sessionId: props.sessionId, state: state.state, buffer: state.buffer });
        return state;
      },
      { sessionId: SESSION_ID },
    );
    await flush();
    await actRun(() => hook.result.current.edit("first-session-edit\n"));
    await flush();

    observed.length = 0;
    await hook.rerender({ sessionId: SECOND_SESSION_ID });

    expect(observed.filter(({ sessionId }) => sessionId === SECOND_SESSION_ID)).not.toContainEqual(
      expect.objectContaining({ buffer: "first-session-edit\n" }),
    );
    expect(hook.result.current.state).toBe("viewing-cold");
    expect(hook.result.current.buffer).toBeNull();
    await hook.unmount();
  });
});

// ── machine chip derivation (pure) ─────────────────────────────────────────────

describe("deriveMachineChip", () => {
  const NOW = Date.parse("2026-07-08T12:05:00.000Z");

  test("warm lease → live", () => {
    expect(deriveMachineChip({ liveness: "warm" })).toEqual({
      state: "live",
      label: "Live",
      asOf: null,
    });
    expect(deriveMachineChip({ liveness: "draining" }).state).toBe("live");
  });

  test("negotiating or wanting-warm → waking", () => {
    expect(deriveMachineChip({ liveness: "cold", capabilitiesState: "negotiating" }).state).toBe(
      "waking",
    );
    expect(deriveMachineChip({ liveness: "cold", wantsWarm: true }).state).toBe("waking");
    expect(deriveMachineChip({ activeMachineState: "reconnecting" }).state).toBe("waking");
  });

  test("cold/idle → offline, labelled 'as of <time>'", () => {
    const chip = deriveMachineChip({
      liveness: "cold",
      capturedAt: "2026-07-08T12:00:00.000Z",
      now: NOW,
    });
    expect(chip.state).toBe("offline");
    expect(chip.asOf).toBe("2026-07-08T12:00:00.000Z");
    expect(chip.label).toBe("Offline — as of 5m ago");
  });

  test("self-hosted offline is honest offline even if warm was requested", () => {
    const chip = deriveMachineChip({
      liveness: "cold",
      activeIsSelfhosted: true,
      activeMachineState: "offline",
      wantsWarm: true,
      capturedAt: "2026-07-08T11:00:00.000Z",
      now: NOW,
    });
    expect(chip.state).toBe("offline");
    expect(chip.label).toBe("Offline — as of 1h ago");
  });

  test("offline with no capture time reads a bare 'Offline'", () => {
    expect(deriveMachineChip({ liveness: "cold" }).label).toBe("Offline");
  });
});
