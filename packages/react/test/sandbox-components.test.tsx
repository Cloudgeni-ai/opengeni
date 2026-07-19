/* ----------------------------------------------------------------------------
   Phase 5 component tests: the terminal/tree/diff/desktop components render
   against mocked SDK data; the desktop consent gate + unavailable + viewer-cap
   states render; SSR lazy-import (xterm/noVNC) does not crash on the server.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import type { DesktopRfbFactory, DesktopRfbLike } from "@opengeni/sdk";
import { actRun, registerDom, renderComponent, flush } from "./render-hook";
import { fakeCapabilities, fakeFileDiff, fakeHeadlessCapabilities } from "./sandbox-fixtures";
import { DesktopViewer } from "../src/components/desktop-viewer";
import { DiffView } from "../src/components/diff-view";
import { PierreDiff } from "../src/components/pierre-diff";
import { FileBrowser } from "../src/components/file-browser";
import { SandboxFiles } from "../src/components/sandbox-files";
import type { UseSandboxFilesResult } from "../src/hooks/use-sandbox-files";
import { CapturedFileUnavailableError } from "../src/hooks/use-sandbox-files";
import type { UseSandboxGitResult } from "../src/hooks/use-sandbox-git";

registerDom();

function filesResult(overrides: Partial<UseSandboxFilesResult> = {}): UseSandboxFilesResult {
  return {
    tree: [
      {
        path: "src",
        name: "src",
        kind: "dir",
        children: [{ path: "src/app.ts", name: "app.ts", kind: "file", status: "modified" }],
      },
      { path: "README.md", name: "README.md", kind: "file" },
    ],
    expand: async () => {},
    expandingPaths: new Set<string>(),
    readFile: async () => ({
      path: "",
      encoding: "utf8",
      content: "",
      sizeBytes: 0,
      truncated: false,
      isBinary: false,
      revision: 0,
    }),
    writeFile: async () => ({ path: "", sizeBytes: 0, revision: 0 }),
    createFile: async () => {},
    createDir: async () => {},
    deleteEntry: async () => {},
    moveEntry: async () => {},
    refresh: async () => {},
    source: "live",
    capturedAt: null,
    loading: false,
    error: null,
    ...overrides,
  };
}

function gitResult(overrides: Partial<UseSandboxGitResult> = {}): UseSandboxGitResult {
  return {
    diff: [],
    branch: "main",
    isRepo: true,
    ahead: 0,
    behind: 0,
    repoCount: 1,
    repoRoots: [""],
    refresh: async () => {},
    source: "capture",
    capturedAt: "2026-07-16T12:00:00.000Z",
    loading: false,
    error: null,
    ...overrides,
  };
}

function selectedFile(container: HTMLElement): string | null {
  return container.querySelector("[data-opengeni-selected-file]")?.textContent ?? null;
}

function fileButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>("[role=treeitem] button"),
  ).find((candidate) => candidate.textContent?.includes(name));
  if (!button) {
    throw new Error(`Missing file button: ${name}`);
  }
  return button;
}

describe("FileBrowser", () => {
  test("renders the tree from useSandboxFiles data", async () => {
    const r = await renderComponent(<FileBrowser result={filesResult()} />);
    await flush();
    const tree = r.container.querySelector("[data-opengeni-file-tree]");
    expect(tree).not.toBeNull();
    expect(r.container.textContent).toContain("src");
    expect(r.container.textContent).toContain("README.md");
    await r.unmount();
  });

  test("renders a fallback when the surface errored", async () => {
    const r = await renderComponent(
      <FileBrowser
        result={filesResult({ tree: [], error: new Error("boom") })}
        fallback="files off"
      />,
    );
    await flush();
    expect(r.container.textContent).toContain("files off");
    await r.unmount();
  });

  test("an empty tree shows the empty state (no crash)", async () => {
    const r = await renderComponent(
      <FileBrowser result={filesResult({ tree: [] })} emptyState="nothing here" />,
    );
    await flush();
    expect(r.container.textContent).toContain("nothing here");
    await r.unmount();
  });

  test("delete uses a non-blocking accessible confirmation and can be cancelled", async () => {
    const deleted: string[] = [];
    const r = await renderComponent(
      <FileBrowser
        result={filesResult({
          deleteEntry: async (path) => {
            deleted.push(path);
          },
        })}
      />,
    );
    await flush();

    const openDelete = async () => {
      const file = fileButton(r.container, "README.md");
      const more = file.querySelector<HTMLElement>('[aria-label="More actions"]');
      expect(more).not.toBeNull();
      await actRun(() => more!.click());
      const action = Array.from(r.container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Delete",
      );
      expect(action).toBeDefined();
      await actRun(() => action!.click());
      await flush();
    };

    await openDelete();
    expect(document.body.textContent).toContain("Delete file?");
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("README.md will be permanently removed.");
    const cancel = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    await actRun(() => cancel!.click());
    await flush();
    expect(deleted).toEqual([]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();

    await openDelete();
    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete permanently",
    );
    await actRun(() => confirm!.click());
    await flush();
    expect(deleted).toEqual(["README.md"]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    await r.unmount();
  });
});

describe("SandboxFiles guarded-file routing", () => {
  test("capture-only untouched files expose an explicit live-open action", async () => {
    let wakeCalls = 0;
    const files = filesResult({
      source: "capture",
      readFile: async (path) => {
        throw new CapturedFileUnavailableError(path, "not-captured");
      },
    });
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={gitResult()}
        liveWorkspaceReady={false}
        onWakeWorkspace={() => {
          wakeCalls += 1;
        }}
      />,
    );
    await flush();
    await actRun(() => fileButton(r.container, "README.md").click());
    await flush();
    expect(r.container.textContent).toContain("On machine");
    expect(r.container.textContent).toContain("Open live file");
    const openLive = Array.from(r.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Open live file"),
    );
    expect(openLive).toBeDefined();
    await actRun(() => openLive!.click());
    expect(wakeCalls).toBe(1);
    expect(r.container.textContent).toContain("Waking workspace");
    await r.unmount();
  });

  test("the header describes a multi-repo workspace without inventing one branch", async () => {
    const r = await renderComponent(
      <SandboxFiles
        files={filesResult()}
        git={gitResult({ branch: null, repoCount: 2, repoRoots: ["api", "web"] })}
      />,
    );
    await flush();
    expect(r.container.textContent).toContain("2 repositories");
    expect(r.container.textContent).not.toContain("(detached)");
    await r.unmount();
  });

  test("manual navigation consumes a pending cold request and wins after warm-up", async () => {
    const files = filesResult();
    const git = gitResult();
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={git}
        requestedPath="src/app.ts"
        requestedPathRequestId={1}
        requestedPathReady={false}
      />,
    );
    await flush();

    await actRun(() => fileButton(r.container, "README.md").click());
    expect(selectedFile(r.container)).toBe("README.md");

    await r.rerender(
      <SandboxFiles
        files={files}
        git={git}
        requestedPath="src/app.ts"
        requestedPathRequestId={1}
        requestedPathReady={true}
      />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md");
    await r.unmount();
  });

  test("a new request identity deliberately reopens the same guarded path", async () => {
    const files = filesResult();
    const git = gitResult();
    const r = await renderComponent(
      <SandboxFiles files={files} git={git} requestedPath="README.md" requestedPathRequestId={1} />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md");

    await actRun(() => fileButton(r.container, "src").click());
    await flush();
    await actRun(() => fileButton(r.container, "app.ts").click());
    expect(selectedFile(r.container)).toBe("src/app.ts");

    await r.rerender(
      <SandboxFiles files={files} git={git} requestedPath="README.md" requestedPathRequestId={2} />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md");
    await r.unmount();
  });
});

describe("DiffView (@deprecated alias)", () => {
  // DiffView is now a thin alias over the ONE renderer, PierreDiff — the
  // hand-rolled hunk renderer was removed (D3). It delegates to Pierre for a
  // non-empty diff and still shows the empty/no-repo states directly.
  test("delegates a non-empty diff to the Pierre renderer", async () => {
    const r = await renderComponent(<DiffView diff={[fakeFileDiff()]} />);
    await flush();
    expect(r.container.querySelector("[data-opengeni-pierre-diff]")).not.toBeNull();
    // The removed hand-rolled renderer's marker is gone.
    expect(r.container.querySelector("[data-opengeni-diff]")).toBeNull();
    await r.unmount();
  });

  test("delegates a split-layout diff to the Pierre renderer", async () => {
    const r = await renderComponent(<DiffView diff={[fakeFileDiff()]} layout="split" />);
    await flush();
    expect(r.container.querySelector("[data-opengeni-pierre-diff]")).not.toBeNull();
    await r.unmount();
  });

  test("distinguishes 'no changes' (repo) from 'no repository' (no repo)", async () => {
    const repo = await renderComponent(<DiffView diff={[]} isRepo={true} />);
    await flush();
    expect(repo.container.textContent).toContain("No changes");
    await repo.unmount();

    const noRepo = await renderComponent(<DiffView diff={[]} isRepo={false} />);
    await flush();
    expect(noRepo.container.textContent).toContain("No repository mounted");
    await noRepo.unmount();
  });
});

describe("PierreDiff (the one renderer)", () => {
  // The plain degrade is the deterministic surface for a host without
  // `@pierre/diffs` (or opting out) — a text patch, NOT a second hunk renderer.
  test("plain degrade renders the reconstructed patch text", async () => {
    const r = await renderComponent(<PierreDiff diff={[fakeFileDiff()]} plain />);
    await flush();
    expect(r.container.textContent).toContain("src/app.ts");
    expect(r.container.textContent).toContain("const b = 3;");
    expect(
      r.container.querySelector<HTMLElement>('[role="region"][aria-label="Diff for src/app.ts"]')
        ?.tabIndex,
    ).toBe(0);
    await r.unmount();
  });

  test("plain degrade with an empty diff says 'No changes' (never crashes)", async () => {
    const r = await renderComponent(<PierreDiff diff={[]} plain />);
    await flush();
    expect(r.container.textContent).toContain("No changes");
    await r.unmount();
  });
});

describe("DesktopViewer", () => {
  // A fake RFB that records construction + reports its viewOnly + scaling setting.
  function fakeRfb(): {
    factory: DesktopRfbFactory;
    calls: { url: string; viewOnly: boolean; scaleViewport: boolean; clipViewport: boolean }[];
  } {
    const calls: {
      url: string;
      viewOnly: boolean;
      scaleViewport: boolean;
      clipViewport: boolean;
    }[] = [];
    const factory: DesktopRfbFactory = (_target, url) => {
      const rfb: DesktopRfbLike = {
        viewOnly: false,
        scaleViewport: false,
        clipViewport: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        disconnect: () => {},
      };
      // Record after the hook sets viewOnly/scaling on the next tick.
      queueMicrotask(() =>
        calls.push({
          url,
          viewOnly: rfb.viewOnly,
          scaleViewport: rfb.scaleViewport,
          clipViewport: rfb.clipViewport,
        }),
      );
      return rfb;
    };
    return { factory, calls };
  }

  test("a headless desktop cell renders the reason-aware unavailable notice", async () => {
    const cap = fakeHeadlessCapabilities().DesktopStream; // reason: backend_unsupported
    const r = await renderComponent(<DesktopViewer capability={cap} />);
    await flush();
    expect(r.container.textContent).toContain("Desktop unavailable");
    expect(r.container.textContent).toContain("cannot stream a desktop");
    await r.unmount();
  });

  test("an un-acknowledged desktop renders the consent gate (and accept fires)", async () => {
    let accepted = false;
    const { factory } = fakeRfb();
    const cap = fakeCapabilities({
      DesktopStream: {
        ...fakeCapabilities().DesktopStream,
        requiresAcknowledgment: true,
        acknowledged: false,
      },
    }).DesktopStream;
    const r = await renderComponent(
      <DesktopViewer
        capability={cap}
        onAcknowledge={() => {
          accepted = true;
        }}
        rfbFactory={factory}
      />,
    );
    await flush();
    expect(r.container.textContent).toContain("un-redacted");
    const button = r.container.querySelector("button");
    expect(button).not.toBeNull();
    await actRun(() => button!.click());
    await flush();
    expect(accepted).toBe(true);
    await r.unmount();
  });

  test("the viewer-cap (429) renders a friendly notice", async () => {
    const cap = fakeCapabilities().DesktopStream;
    const r = await renderComponent(<DesktopViewer capability={cap} viewerCapReached />);
    await flush();
    expect(r.container.textContent).toContain("Too many viewers");
    await r.unmount();
  });

  test("an acknowledged warm desktop connects read-only via the RFB factory", async () => {
    const { factory, calls } = fakeRfb();
    const cap = fakeCapabilities().DesktopStream; // acknowledged:true, url present, vnc-ws
    const r = await renderComponent(<DesktopViewer capability={cap} rfbFactory={factory} />);
    await flush(5);
    expect(calls.length).toBeGreaterThan(0);
    // read-only is enforced (mode === "read-only" forces viewOnly).
    expect(calls[0]?.viewOnly).toBe(true);
    // The socket url was normalized to wss + websockify path.
    expect(calls[0]?.url.startsWith("wss://")).toBe(true);
    expect(calls[0]?.url).toContain("/websockify");
    // Fit-to-panel: the 1280x800 framebuffer SCALES to the container and is
    // never 1:1-clipped (the "zoomed in" regression).
    expect(calls[0]?.scaleViewport).toBe(true);
    expect(calls[0]?.clipViewport).toBe(false);
    await r.unmount();
  });

  // A fake RFB that keeps every constructed instance live so the test can read
  // their `viewOnly` AFTER an in-place update (the live take-control path).
  function trackingRfb(): { factory: DesktopRfbFactory; instances: DesktopRfbLike[] } {
    const instances: DesktopRfbLike[] = [];
    const factory: DesktopRfbFactory = () => {
      const rfb: DesktopRfbLike = {
        viewOnly: false,
        scaleViewport: false,
        clipViewport: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        disconnect: () => {},
      };
      instances.push(rfb);
      return rfb;
    };
    return { factory, instances };
  }

  test("taking control flips viewOnly in place — it does NOT reconnect the socket", async () => {
    const { factory, instances } = trackingRfb();
    // An interactive-mode warm cell so take-control is permitted.
    const cap = { ...fakeCapabilities().DesktopStream, mode: "interactive" as const };

    // Watching (read-only): connects once, viewOnly true.
    const r = await renderComponent(
      <DesktopViewer capability={cap} interactive={false} rfbFactory={factory} />,
    );
    await flush(5);
    expect(instances.length).toBe(1);
    expect(instances[0]?.viewOnly).toBe(true);

    // TAKE CONTROL: the same cell, only `interactive` flips true. This must NOT
    // tear down + rebuild the RFB (the old reconnect-loop / refresh bug) — the
    // existing socket's viewOnly is flipped live to false.
    await r.rerender(<DesktopViewer capability={cap} interactive={true} rfbFactory={factory} />);
    await flush(5);
    expect(instances.length).toBe(1); // still exactly one socket — no reconnect.
    expect(instances[0]?.viewOnly).toBe(false); // input enabled in place.

    // RETURN CONTROL: flips back, still no reconnect.
    await r.rerender(<DesktopViewer capability={cap} interactive={false} rfbFactory={factory} />);
    await flush(5);
    expect(instances.length).toBe(1);
    expect(instances[0]?.viewOnly).toBe(true);
    await r.unmount();
  });

  test("a benign capability refresh (same url/token) does not reconnect the socket", async () => {
    const { factory, instances } = trackingRfb();
    const base = fakeCapabilities().DesktopStream;
    const r = await renderComponent(<DesktopViewer capability={base} rfbFactory={factory} />);
    await flush(5);
    expect(instances.length).toBe(1);

    // A re-negotiation re-mints the cell object (new identity) but the SAME live
    // url + token. The connect effect keys on url/token, so it must not churn.
    const refreshed = { ...base, expiresAt: new Date(Date.now() + 900_000).toISOString() };
    await r.rerender(<DesktopViewer capability={refreshed} rfbFactory={factory} />);
    await flush(5);
    expect(instances.length).toBe(1); // survived the renegotiation — no reconnect.
    await r.unmount();
  });
});
