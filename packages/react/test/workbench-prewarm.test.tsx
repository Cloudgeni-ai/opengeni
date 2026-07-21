/* ----------------------------------------------------------------------------
   Workbench dock refinements.

   Refinement 1 — the cold-session prewarm is gated to INTENT, not view: mounting
   the dock / browsing capture-served Changes/Files warms NO Modal box; only a
   genuine warm intent (terminal activate, desktop watch, first edit keystroke)
   attaches a viewer. This closes a live prod cost (box-hours burned to serve reads
   the capture already answers for free).

   Refinement 2 — the default tab is decided from the first authoritative source:
   capture stats when present, otherwise live Git. No embedder events-at-mount
   contract is required and the choice latches before real content paints.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { act, type ReactElement, type ReactNode } from "react";
import type { GetWorkspaceCaptureResponse, WorkspaceCaptureManifest } from "@opengeni/sdk";
import { registerDom, renderComponent, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import type { SessionClientLike } from "../src/client";
import {
  fakeAttachResponse,
  fakeCapabilities,
  fakeColdCapabilities,
  fakeFileDiff,
} from "./sandbox-fixtures";
import { OpenGeniProvider } from "../src/provider";
import type { MachinesResponse } from "../src/types/machines";
import {
  useSandboxWorkspaceTabs,
  type UseSandboxWorkspaceTabsOptions,
  type UseSandboxWorkspaceTabsResult,
  SandboxWorkspace,
  WORKBENCH_TAB_CHANGES,
  WORKBENCH_TAB_FILES,
} from "../src/components/sandbox-workspace";

registerDom();

const EMPTY_MACHINES = { activeSandboxId: null, activeEpoch: 0, machines: [] };
const SECOND_SESSION_ID = "33333333-3333-4333-8333-333333333333";

/** The composite dock hook's sub-hooks resolve the client from context, so it
 *  must run under a provider (unlike the leaf hooks). This renders it there and
 *  exposes the latest return value. */
async function renderTabsHook(
  client: SessionClientLike,
  options: Omit<UseSandboxWorkspaceTabsOptions, "client" | "workspaceId">,
): Promise<{ result: { current: UseSandboxWorkspaceTabsResult }; unmount: () => Promise<void> }> {
  const result = { current: undefined as unknown as UseSandboxWorkspaceTabsResult };
  function Harness() {
    result.current = useSandboxWorkspaceTabs(options);
    return null;
  }
  const rendered = await renderComponent(withProvider(client, <Harness />));
  return { result, unmount: rendered.unmount };
}

function withProvider(client: SessionClientLike, children: ReactNode): ReactElement {
  return (
    <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
      {children}
    </OpenGeniProvider>
  );
}

// ── Capture fixtures ──────────────────────────────────────────────────────────

function fakeManifest(fileCount: number): WorkspaceCaptureManifest {
  const diff =
    fileCount > 0
      ? [
          {
            path: "app.py",
            oldPath: null,
            status: "modified" as const,
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
                lines: [{ type: "add" as const, oldNo: null, newNo: 2, text: "x" }],
              },
            ],
          },
        ]
      : [];
  return {
    version: 1,
    revision: 3,
    capturedAt: "2026-07-08T12:00:00.000Z",
    turnId: "turn-1",
    leaseEpoch: 1,
    treeIndex: {
      name: "",
      path: "",
      type: "dir",
      sizeBytes: null,
      mtimeMs: null,
      mode: null,
      truncated: false,
      children: [
        {
          name: "app.py",
          path: "app.py",
          type: "file",
          sizeBytes: 10,
          mtimeMs: null,
          mode: null,
          truncated: false,
        },
      ],
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
        status: [],
        diff,
      },
    ],
    files: Array.from({ length: fileCount }, (_, index) => {
      const path = index === 0 ? "app.py" : `file-${index}.py`;
      return {
        path,
        status: "modified" as const,
        hash: `h${index + 1}`,
        baseHash: null,
        contentRef: `blob/h${index + 1}`,
        sizeBytes: 10,
        isBinary: false,
        tooLarge: false,
        deleted: false,
      };
    }),
    stats: {
      repoCount: 1,
      fileCount,
      additions: fileCount > 0 ? 2 : 0,
      deletions: fileCount > 0 ? 1 : 0,
      totalBytes: 10,
      tooLargeCount: 0,
      binaryCount: 0,
      treeEntryCount: 1,
      treeTruncated: false,
      durationMs: 5,
    },
  };
}

function captureAvailable(manifest: WorkspaceCaptureManifest): GetWorkspaceCaptureResponse {
  return {
    available: true,
    revision: manifest.revision,
    capturedAt: manifest.capturedAt,
    turnId: manifest.turnId,
    leaseEpoch: manifest.leaseEpoch,
    sizeBytes: 512,
    stats: manifest.stats,
    manifest,
    manifestUrl: null,
  };
}

/** A cold-lease client whose Files/Git surfaces seed from the given capture (no
 *  live calls) and whose viewer attach is spied. */
function coldClient(
  overrides: Partial<Parameters<typeof fakeClient>[0]> & {
    listMachines?: () => Promise<MachinesResponse>;
  } = {},
) {
  const spy = { attachCalls: 0 };
  const client = fakeClient({
    getStreamCapabilities: async () => fakeColdCapabilities(),
    getWorkspaceCapture: async () => captureAvailable(fakeManifest(1)),
    listMachines: async () => EMPTY_MACHINES,
    attachViewer: async () => {
      spy.attachCalls += 1;
      return fakeAttachResponse();
    },
    heartbeatViewer: async () => ({ alive: true }),
    detachViewer: async () => {},
    ...overrides,
    // `listMachines` is served by the machines poll at runtime (the proxy needs
    // it present) but isn't a member of the narrow SessionClientLike — assert past
    // the excess-property check on this test mock.
  } as Partial<SessionClientLike>);
  return { client, spy };
}

// ── Refinement 1: prewarm gated to intent ────────────────────────────────────

describe("workbench prewarm gating (Refinement 1)", () => {
  test("cold capability negotiation cannot race a pending capture into Channel-A reads", async () => {
    let resolveCapture: (value: GetWorkspaceCaptureResponse) => void = () => {};
    const capturePromise = new Promise<GetWorkspaceCaptureResponse>((resolve) => {
      resolveCapture = resolve;
    });
    const reads = { fsList: 0, gitStatus: 0, gitDiff: 0 };
    const { client } = coldClient({
      getWorkspaceCapture: () => capturePromise,
      fsList: async () => {
        reads.fsList += 1;
        throw new Error("cold pending capture must not list the live filesystem");
      },
      gitStatus: async () => {
        reads.gitStatus += 1;
        throw new Error("cold pending capture must not query live Git status");
      },
      gitDiff: async () => {
        reads.gitDiff += 1;
        throw new Error("cold pending capture must not query a live Git diff");
      },
    });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });

    // Capabilities have resolved cold, but the independent capture request is
    // deliberately still in flight. Neither working-tree nor staged hooks may
    // translate that transient null capture into a live read.
    await flush(60);
    expect(reads).toEqual({ fsList: 0, gitStatus: 0, gitDiff: 0 });
    expect(hook.result.current.defaultTab).toBeNull();

    await act(async () => {
      resolveCapture(captureAvailable(fakeManifest(1)));
    });
    await flush(60);
    expect(reads).toEqual({ fsList: 0, gitStatus: 0, gitDiff: 0 });
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_CHANGES);
    const changes = hook.result.current.tabs.find((tab) => tab.id === WORKBENCH_TAB_CHANGES);
    const files = hook.result.current.tabs.find((tab) => tab.id === WORKBENCH_TAB_FILES);
    expect(changes).toBeDefined();
    expect(files).toBeDefined();
    expect(
      (changes!.content as ReactElement<{ git: { source: string | null } }>).props.git.source,
    ).toBe("capture");
    expect(
      (files!.content as ReactElement<{ files: { source: string | null } }>).props.files.source,
    ).toBe("capture");
    await hook.unmount();
  });

  test("a cold dock mount browsing capture-served surfaces warms NO box", async () => {
    const { client, spy } = coldClient();
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    // Well past the negotiate + capture GET: nothing asked for a box.
    await flush(60);
    expect(spy.attachCalls).toBe(0);
    // Changes + Files are present (capture-backed), so review works with no box.
    const ids = hook.result.current.tabs.map((t) => t.id);
    expect(ids).toContain(WORKBENCH_TAB_CHANGES);
    expect(ids).toContain(WORKBENCH_TAB_FILES);
    await hook.unmount();
  });

  test("a cold workspace without a capture stays passive behind an explicit wake gate", async () => {
    const reads = { fsList: 0, gitStatus: 0, gitDiff: 0 };
    const { client, spy } = coldClient({
      getWorkspaceCapture: async () => ({ available: false }),
      fsList: async () => {
        reads.fsList += 1;
        throw new Error("resting workspace must not list files before explicit wake");
      },
      gitStatus: async () => {
        reads.gitStatus += 1;
        throw new Error("resting workspace must not query Git before explicit wake");
      },
      gitDiff: async () => {
        reads.gitDiff += 1;
        throw new Error("resting workspace must not diff before explicit wake");
      },
    });
    const rendered = await renderComponent(
      withProvider(
        client,
        <SandboxWorkspace
          sessionId={SESSION_ID}
          events={[]}
          primary={<div>chat</div>}
          autoSaveId="og.test.prewarm.no-capture"
        />,
      ),
    );
    await flush(60);
    expect(reads).toEqual({ fsList: 0, gitStatus: 0, gitDiff: 0 });
    expect(spy.attachCalls).toBe(0);
    expect(rendered.container.textContent).toContain("Workspace is resting");
    const wake = Array.from(rendered.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Open live workspace"),
    );
    expect(wake).toBeDefined();
    await act(async () => {
      wake!.click();
    });
    await flush(60);
    expect(spy.attachCalls).toBe(1);
    await rendered.unmount();
  });

  test("a reconnecting workspace shows one truthful waking state without a duplicate wake action", async () => {
    const { client, spy } = coldClient({
      getWorkspaceCapture: async () => ({ available: false }),
      listMachines: async () => ({
        activeSandboxId: "modal-box",
        activeEpoch: 1,
        machines: [
          {
            sandboxId: "modal-box",
            enrollmentId: null,
            name: "Cloud sandbox",
            kind: "modal",
            state: "reconnecting",
            active: true,
            isSessionGroup: true,
            os: "linux",
            arch: "x86_64",
            hasDisplay: true,
            allowScreenControl: false,
            sharedSessionCount: 1,
            lastSeenAt: null,
            metrics: null,
          },
        ],
      }),
    });
    const rendered = await renderComponent(
      withProvider(
        client,
        <SandboxWorkspace
          sessionId={SESSION_ID}
          events={[]}
          primary={<div>chat</div>}
          autoSaveId="og.test.prewarm.reconnecting"
        />,
      ),
    );
    await flush(60);

    expect(spy.attachCalls).toBe(0);
    expect(rendered.container.textContent).toContain("Waking workspace");
    expect(rendered.container.textContent).not.toContain("Workspace is resting");
    expect(rendered.container.textContent).not.toContain("Open live workspace");
    expect(
      rendered.container.querySelector('button[aria-label="Machine: Waking…"]'),
    ).not.toBeNull();
    await rendered.unmount();
  });

  test("an explicit Files live intent warms the box exactly once", async () => {
    const { client, spy } = coldClient();
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush(60);
    expect(spy.attachCalls).toBe(0);
    // Reach the Files tab's idempotent live-intent callback. The packaged UI
    // invokes the same intent from its explicit wake gates.
    const filesTab = hook.result.current.tabs.find((t) => t.id === WORKBENCH_TAB_FILES);
    expect(filesTab).toBeDefined();
    const onEditIntent = (filesTab!.content as ReactElement<{ onEditIntent: () => void }>).props
      .onEditIntent;
    expect(typeof onEditIntent).toBe("function");
    await act(async () => {
      onEditIntent();
    });
    await flush(60);
    // The intent flipped attachFiles → the box warmed via a viewer attach.
    expect(spy.attachCalls).toBe(1);
    await hook.unmount();
  });

  test("activating the terminal warms the box (interactive PTY intent)", async () => {
    const { client, spy } = coldClient();
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush(60);
    expect(spy.attachCalls).toBe(0);
    const terminalTab = hook.result.current.tabs.find((t) => t.id === "terminal");
    expect(terminalTab).toBeDefined();
    // content = <div><SandboxTerminal onActivate=… /></div>
    const inner = (
      terminalTab!.content as ReactElement<{ children: ReactElement<{ onActivate: () => void }> }>
    ).props.children;
    const onActivate = inner.props.onActivate;
    await act(async () => {
      onActivate();
    });
    await flush(60);
    expect(spy.attachCalls).toBe(1);
    await hook.unmount();
  });

  test("opening a guarded file is explicit live-file intent and warms a cold box", async () => {
    const opened: string[] = [];
    const { client, spy } = coldClient();
    const hook = await renderTabsHook(client, {
      sessionId: SESSION_ID,
      events: [],
      onOpenFile: (path) => opened.push(path),
    });
    await flush(60);
    expect(spy.attachCalls).toBe(0);
    const changes = hook.result.current.tabs.find((tab) => tab.id === WORKBENCH_TAB_CHANGES);
    expect(changes).toBeDefined();
    const onOpenFile = (changes!.content as ReactElement<{ onOpenFile: (path: string) => void }>)
      .props.onOpenFile;
    await act(async () => {
      onOpenFile("large/output.json");
    });
    await flush(60);
    expect(opened).toEqual(["large/output.json"]);
    expect(spy.attachCalls).toBe(1);
    await hook.unmount();
  });

  test("switching sessions clears prior warm intent instead of prewarming the new session", async () => {
    const { client, spy } = coldClient();
    const result = { current: undefined as unknown as UseSandboxWorkspaceTabsResult };
    function Harness({ sessionId }: { sessionId: string }) {
      result.current = useSandboxWorkspaceTabs({ sessionId, events: [] });
      return null;
    }
    const rendered = await renderComponent(
      withProvider(client, <Harness sessionId={SESSION_ID} />),
    );
    await flush(60);
    const firstFiles = result.current.tabs.find((tab) => tab.id === WORKBENCH_TAB_FILES);
    expect(firstFiles).toBeDefined();
    const firstEditIntent = (firstFiles!.content as ReactElement<{ onEditIntent: () => void }>)
      .props.onEditIntent;
    await act(async () => {
      firstEditIntent();
    });
    await flush(60);
    expect(spy.attachCalls).toBe(1);

    await rendered.rerender(withProvider(client, <Harness sessionId={SECOND_SESSION_ID} />));
    await flush(60);
    expect(spy.attachCalls).toBe(1);

    const secondFiles = result.current.tabs.find((tab) => tab.id === WORKBENCH_TAB_FILES);
    expect(secondFiles).toBeDefined();
    const secondEditIntent = (secondFiles!.content as ReactElement<{ onEditIntent: () => void }>)
      .props.onEditIntent;
    await act(async () => {
      secondEditIntent();
    });
    await flush(60);
    expect(spy.attachCalls).toBe(2);
    await rendered.unmount();
  });
});

// ── Refinement 2: capture-driven default tab ─────────────────────────────────

describe("capture-driven default tab (Refinement 2)", () => {
  test("changes present → default Changes; empty → default Files", async () => {
    const withChanges = coldClient({
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(2)),
    });
    const changesHook = await renderTabsHook(withChanges.client, {
      sessionId: SESSION_ID,
      events: [],
    });
    await flush();
    expect(changesHook.result.current.defaultTab).toBe(WORKBENCH_TAB_CHANGES);
    await changesHook.unmount();

    const empty = coldClient({
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(0)),
    });
    const emptyHook = await renderTabsHook(empty.client, { sessionId: SESSION_ID, events: [] });
    await flush();
    expect(emptyHook.result.current.defaultTab).toBe(WORKBENCH_TAB_FILES);
    await emptyHook.unmount();
  });

  test("no capture at all → default Files (fileCount resolves 0)", async () => {
    const { client } = coldClient({ getWorkspaceCapture: async () => ({ available: false }) });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_FILES);
    await hook.unmount();
  });

  test("warm live changes with no capture → default Changes from authoritative Git", async () => {
    const diff = [fakeFileDiff({ path: "src/live-change.ts" })];
    const { client } = coldClient({
      getStreamCapabilities: async () => fakeCapabilities(),
      getWorkspaceCapture: async () => ({ available: false }),
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        files: [],
        revision: 1,
      }),
      gitDiff: async () => ({ files: diff, revision: 1 }),
    });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_CHANGES);
    await hook.unmount();
  });

  test("warm clean workspace with no capture → default Files after live Git resolves", async () => {
    const { client } = coldClient({
      getStreamCapabilities: async () => fakeCapabilities(),
      getWorkspaceCapture: async () => ({ available: false }),
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        files: [],
        revision: 1,
      }),
      gitDiff: async () => ({ files: [], revision: 1 }),
    });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_FILES);
    await hook.unmount();
  });

  test("warm live Git outranks an empty prior capture", async () => {
    const { client } = coldClient({
      getStreamCapabilities: async () => fakeCapabilities(),
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(0)),
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        files: [],
        revision: 2,
      }),
      gitDiff: async () => ({ files: [fakeFileDiff()], revision: 2 }),
    });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_CHANGES);
    await hook.unmount();
  });

  test("a fast empty capture cannot latch Files before warm capability negotiation", async () => {
    let resolveCapabilities: (value: ReturnType<typeof fakeCapabilities>) => void = () => {};
    const capabilitiesPromise = new Promise<ReturnType<typeof fakeCapabilities>>((resolve) => {
      resolveCapabilities = resolve;
    });
    const { client } = coldClient({
      getStreamCapabilities: () => capabilitiesPromise,
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(0)),
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        files: [],
        revision: 2,
      }),
      gitDiff: async () => ({ files: [fakeFileDiff()], revision: 2 }),
    });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.defaultTab).toBeNull();
    await act(async () => resolveCapabilities(fakeCapabilities()));
    await flush();
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_CHANGES);
    await hook.unmount();
  });

  test("warm clean Git outranks a changed prior capture", async () => {
    const { client } = coldClient({
      getStreamCapabilities: async () => fakeCapabilities(),
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(2)),
      gitStatus: async () => ({
        isRepo: true,
        head: "main",
        detached: false,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        files: [],
        revision: 2,
      }),
      gitDiff: async () => ({ files: [], revision: 2 }),
    });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_FILES);
    await hook.unmount();
  });

  test("capability failure with no capture → default Changes for the truthful retry state", async () => {
    const { client } = coldClient({
      getStreamCapabilities: async () => {
        throw new Error("sandbox unreachable");
      },
      getWorkspaceCapture: async () => ({ available: false }),
    });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush();
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_CHANGES);
    await hook.unmount();
  });

  test("a host initialTab overrides the capture-driven default", async () => {
    const { client } = coldClient({
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(5)),
    });
    const hook = await renderTabsHook(client, {
      sessionId: SESSION_ID,
      events: [],
      initialTab: "run",
    });
    await flush();
    // Even though the capture has changes, the host landing tab wins.
    expect(hook.result.current.defaultTab).toBe("run");
    await hook.unmount();
  });

  test("defaultTab is null until the capture GET first resolves (no premature commit)", async () => {
    let resolveCapture: (value: GetWorkspaceCaptureResponse) => void = () => {};
    const capturePromise = new Promise<GetWorkspaceCaptureResponse>((resolve) => {
      resolveCapture = resolve;
    });
    const { client } = coldClient({ getWorkspaceCapture: () => capturePromise });
    const hook = await renderTabsHook(client, { sessionId: SESSION_ID, events: [] });
    await flush();
    // The capture GET is still in flight — no default committed yet.
    expect(hook.result.current.defaultTab).toBeNull();
    await act(async () => {
      resolveCapture(captureAvailable(fakeManifest(3)));
    });
    await flush();
    expect(hook.result.current.defaultTab).toBe(WORKBENCH_TAB_CHANGES);
    await hook.unmount();
  });

  test("the capture-driven default is latched independently for each session", async () => {
    const { client } = coldClient({
      getWorkspaceCapture: async (_workspaceId, sessionId) =>
        captureAvailable(fakeManifest(sessionId === SESSION_ID ? 2 : 0)),
    });
    const result = { current: undefined as unknown as UseSandboxWorkspaceTabsResult };
    function Harness({ sessionId }: { sessionId: string }) {
      result.current = useSandboxWorkspaceTabs({ sessionId, events: [] });
      return null;
    }
    const rendered = await renderComponent(
      withProvider(client, <Harness sessionId={SESSION_ID} />),
    );
    await flush();
    expect(result.current.defaultTab).toBe(WORKBENCH_TAB_CHANGES);

    await rendered.rerender(withProvider(client, <Harness sessionId={SECOND_SESSION_ID} />));
    await flush();
    expect(result.current.defaultTab).toBe(WORKBENCH_TAB_FILES);
    await rendered.unmount();
  });
});

// ── Refinement 2: no post-paint content switch (component level) ──────────────

describe("SandboxWorkspace capture-driven default renders with no content switch", () => {
  function selectedTabText(container: HTMLElement): string {
    return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "";
  }

  test("pure embedder, changes present: Changes is the selected tab before AND after resolve", async () => {
    let resolveCapture: (value: GetWorkspaceCaptureResponse) => void = () => {};
    const capturePromise = new Promise<GetWorkspaceCaptureResponse>((resolve) => {
      resolveCapture = resolve;
    });
    const { client } = coldClient({ getWorkspaceCapture: () => capturePromise });
    const rendered = await renderComponent(
      withProvider(
        client,
        <SandboxWorkspace
          sessionId={SESSION_ID}
          events={[]}
          primary={<div>chat</div>}
          autoSaveId="og.test.prewarm.changes"
        />,
      ),
    );
    await flush();
    // Pending (capture unresolved): the dock falls back to its first tab (Changes);
    // Files is NOT shown first. The body is a loader, not real content.
    expect(selectedTabText(rendered.container)).toContain("Changes");
    await act(async () => {
      resolveCapture(captureAvailable(fakeManifest(2)));
    });
    await flush();
    // Default resolved to Changes → the first REAL content paint is Changes: no switch.
    expect(selectedTabText(rendered.container)).toContain("Changes");
    await rendered.unmount();
  });

  test("pure embedder, empty capture: the default resolves to Files", async () => {
    const { client } = coldClient({
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(0)),
    });
    const rendered = await renderComponent(
      withProvider(
        client,
        <SandboxWorkspace
          sessionId={SESSION_ID}
          events={[]}
          primary={<div>chat</div>}
          autoSaveId="og.test.prewarm.empty"
        />,
      ),
    );
    await flush();
    expect(selectedTabText(rendered.container)).toContain("Files");
    await rendered.unmount();
  });

  test("warm provider failure keeps captured Changes visible with an accessible retry state", async () => {
    const { client } = coldClient({
      getStreamCapabilities: async () => fakeCapabilities(),
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(1)),
      gitStatus: async () => {
        throw new Error("OpenGeni API 503: Workspace files are temporarily unavailable");
      },
      fsList: async () => {
        throw new Error("OpenGeni API 503: Workspace files are temporarily unavailable");
      },
    });
    const rendered = await renderComponent(
      withProvider(
        client,
        <SandboxWorkspace
          sessionId={SESSION_ID}
          events={[]}
          primary={<div>chat</div>}
          autoSaveId="og.test.prewarm.degraded-capture"
        />,
      ),
    );
    await flush();

    expect(selectedTabText(rendered.container)).toContain("Changes");
    const degraded = rendered.container.querySelector("[data-opengeni-changes-degraded]");
    expect(degraded?.getAttribute("role")).toBe("status");
    expect(degraded?.textContent).toContain("Showing the latest captured revision");
    expect(rendered.container.textContent).toContain("app.py");
    await rendered.unmount();
  });

  test("a tab selection from the previous session does not override the new session default", async () => {
    const { client } = coldClient({
      getWorkspaceCapture: async () => captureAvailable(fakeManifest(2)),
    });
    const workspace = (sessionId: string) =>
      withProvider(
        client,
        <SandboxWorkspace
          sessionId={sessionId}
          events={[]}
          primary={<div>chat</div>}
          autoSaveId="og.test.prewarm.session-tab"
        />,
      );
    const rendered = await renderComponent(workspace(SESSION_ID));
    await flush();
    const filesTab = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (element) => element.textContent?.includes("Files"),
    );
    expect(filesTab).toBeDefined();
    await act(async () => {
      filesTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(selectedTabText(rendered.container)).toContain("Files");

    await rendered.rerender(workspace(SECOND_SESSION_ID));
    await flush();
    expect(selectedTabText(rendered.container)).toContain("Changes");
    await rendered.unmount();
  });
});
