/* ----------------------------------------------------------------------------
   Phase 5 component tests: the terminal/tree/diff/desktop components render
   against mocked SDK data; the desktop consent gate + unavailable + viewer-cap
   states render; SSR lazy-import (xterm/noVNC) does not crash on the server.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import type { DesktopRfbFactory, DesktopRfbLike } from "@opengeni/sdk";
import { registerDom, renderComponent, flush } from "./render-hook";
import { fakeCapabilities, fakeFileDiff, fakeHeadlessCapabilities } from "./sandbox-fixtures";
import { DesktopViewer } from "../src/components/desktop-viewer";
import { DiffView } from "../src/components/diff-view";
import { FileBrowser } from "../src/components/file-browser";
import type { UseSandboxFilesResult } from "../src/hooks/use-sandbox-files";

registerDom();

function filesResult(overrides: Partial<UseSandboxFilesResult> = {}): UseSandboxFilesResult {
  return {
    tree: [
      { path: "src", name: "src", kind: "dir", children: [
        { path: "src/app.ts", name: "app.ts", kind: "file", status: "modified" },
      ] },
      { path: "README.md", name: "README.md", kind: "file" },
    ],
    expand: async () => {},
    readFile: async () => ({ path: "", encoding: "utf8", content: "", sizeBytes: 0, truncated: false, isBinary: false, revision: 0 }),
    refresh: async () => {},
    loading: false,
    error: null,
    ...overrides,
  };
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
      <FileBrowser result={filesResult({ tree: [], error: new Error("boom") })} fallback="files off" />,
    );
    await flush();
    expect(r.container.textContent).toContain("files off");
    await r.unmount();
  });

  test("an empty tree shows the empty state (no crash)", async () => {
    const r = await renderComponent(<FileBrowser result={filesResult({ tree: [] })} emptyState="nothing here" />);
    await flush();
    expect(r.container.textContent).toContain("nothing here");
    await r.unmount();
  });
});

describe("DiffView", () => {
  test("renders unified hunks with add/del lines", async () => {
    const r = await renderComponent(<DiffView diff={[fakeFileDiff()]} />);
    await flush();
    const diff = r.container.querySelector("[data-opengeni-diff]");
    expect(diff).not.toBeNull();
    expect(r.container.textContent).toContain("src/app.ts");
    expect(r.container.textContent).toContain("const b = 3;");
    await r.unmount();
  });

  test("renders split layout (side-by-side) without crashing", async () => {
    const r = await renderComponent(<DiffView diff={[fakeFileDiff()]} layout="split" />);
    await flush();
    expect(r.container.querySelector("[data-opengeni-diff]")).not.toBeNull();
    await r.unmount();
  });

  test("distinguishes 'no changes' (repo) from 'no repository' (no repo)", async () => {
    const repo = await renderComponent(<DiffView diff={[]} isRepo={true} />);
    await flush();
    expect(repo.container.textContent).toContain("No changes.");
    await repo.unmount();

    const noRepo = await renderComponent(<DiffView diff={[]} isRepo={false} />);
    await flush();
    expect(noRepo.container.textContent).toContain("No repository mounted.");
    await noRepo.unmount();
  });

  test("binary files are not rendered as text", async () => {
    const r = await renderComponent(<DiffView diff={[fakeFileDiff({ isBinary: true, hunks: [] })]} />);
    await flush();
    expect(r.container.textContent).toContain("Binary file not shown.");
    await r.unmount();
  });
});

describe("DesktopViewer", () => {
  // A fake RFB that records construction + reports its viewOnly setting.
  function fakeRfb(): { factory: DesktopRfbFactory; calls: { url: string; viewOnly: boolean }[] } {
    const calls: { url: string; viewOnly: boolean }[] = [];
    const factory: DesktopRfbFactory = (_target, url) => {
      const rfb: DesktopRfbLike = {
        viewOnly: false,
        scaleViewport: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        disconnect: () => {},
      };
      // Record after the hook sets viewOnly on the next tick.
      queueMicrotask(() => calls.push({ url, viewOnly: rfb.viewOnly }));
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
    const cap = fakeCapabilities({
      DesktopStream: { ...fakeCapabilities().DesktopStream, requiresAcknowledgment: true, acknowledged: false },
    }).DesktopStream;
    const r = await renderComponent(<DesktopViewer capability={cap} onAcknowledge={() => { accepted = true; }} />);
    await flush();
    expect(r.container.textContent).toContain("un-redacted");
    const button = r.container.querySelector("button");
    expect(button).not.toBeNull();
    button!.click();
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
    await r.unmount();
  });
});
