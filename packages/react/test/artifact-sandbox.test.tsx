import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChatInteractiveBlock,
  PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX,
  PublishedHtmlArtifactFrame,
  openGeniSiteBridgePortFromBootstrap,
  publishedHtmlArtifactDocument,
} from "../src/artifacts";
import { OPENGENI_SITE_BRIDGE_CONNECT, OPENGENI_SITE_BRIDGE_VERSION } from "@opengeni/sdk/site";

import { ArtifactSandbox } from "../src/components/artifacts/artifact-sandbox";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

describe("published HTML artifacts", () => {
  it("runs exact source without parent-origin or top-navigation authority", () => {
    expect(PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX).toContain("allow-scripts");
    expect(PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX).toContain("allow-forms");
    expect(PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX).toContain("allow-popups");
    expect(PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX).toContain("allow-downloads");
    expect(PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-top-navigation");

    const html = '<script>document.body.dataset.ran="yes"</script><form></form>';
    const markup = renderToStaticMarkup(<PublishedHtmlArtifactFrame html={html} title="App" />);
    expect(markup).toContain(
      html.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    );
    expect(markup).toContain(`sandbox="${PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX}"`);
    expect(markup).toContain('referrerPolicy="no-referrer"');
  });

  it("renders polished platform-owned live, reload, full-screen, and version controls", () => {
    const markup = renderToStaticMarkup(
      <ArtifactSandbox html="<h1>App</h1>" title="Status" versionLabel="v4" />,
    );
    expect(markup).toContain("Live");
    expect(markup).toContain('aria-label="Reload Site"');
    expect(markup).toContain('aria-label="Open Site full screen"');
    expect(markup).toContain('aria-label="Status"');
    expect(markup).toContain("v4");
    expect(
      renderToStaticMarkup(
        <ArtifactSandbox html="<h1>App</h1>" title="Preview" showTitle={false} />,
      ),
    ).toContain('aria-label="Preview"');
  });

  it("lets the host replace or hide the Live indicator", () => {
    const replaced = renderToStaticMarkup(
      <ArtifactSandbox
        html="<h1>App</h1>"
        title="Status"
        liveStatus={<a href="https://status.sites.example/">Open status</a>}
      />,
    );
    expect(replaced).toContain('href="https://status.sites.example/"');
    expect(replaced).not.toContain(">Live<");
    const hidden = renderToStaticMarkup(
      <ArtifactSandbox html="<h1>App</h1>" title="Status" liveStatus={null} />,
    );
    expect(hidden).not.toContain("Live");
    expect(hidden).toContain('aria-label="Reload Site"');
  });

  it("promotes the chat preview to the modal top layer without replacing its iframe", async () => {
    const showModal = spyOn(HTMLDialogElement.prototype, "showModal");
    const show = spyOn(HTMLDialogElement.prototype, "show");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ArtifactSandbox html="<h1>App</h1>" title="Site" />));
      const dialog = container.querySelector("dialog")!;
      const iframe = dialog.querySelector("iframe")!;
      expect(dialog.open).toBe(true);
      expect(dialog.hasAttribute("data-artifact-fullscreen")).toBe(false);
      expect(dialog.querySelector("[data-window-drag]")).toBeNull();
      await act(async () =>
        (
          container.querySelector('[aria-label="Open Site full screen"]') as HTMLButtonElement
        ).click(),
      );
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(dialog.querySelector("iframe")).toBe(iframe);
      expect(dialog.className).toContain("fixed");
      expect(dialog.getAttribute("data-artifact-fullscreen")).toBe("true");
      expect(dialog.querySelector("[data-window-drag]")?.contains(iframe)).toBe(false);
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Back")!
          .click(),
      );
      expect(show).toHaveBeenCalledTimes(1);
      expect(dialog.querySelector("iframe")).toBe(iframe);
      expect(dialog.open).toBe(true);
      expect(dialog.hasAttribute("data-artifact-fullscreen")).toBe(false);
      expect(dialog.querySelector("[data-window-drag]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      showModal.mockRestore();
      show.mockRestore();
    }
  });

  it("lets the host control full screen and reports the person's requests", async () => {
    const showModal = spyOn(HTMLDialogElement.prototype, "showModal");
    const requests: boolean[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (fullScreen: boolean) =>
      root.render(
        <ArtifactSandbox
          html="<h1>App</h1>"
          title="Site"
          fullScreen={fullScreen}
          onFullScreenChange={(next) => requests.push(next)}
        />,
      );
    try {
      await act(async () => render(true));
      const dialog = container.querySelector("dialog")!;
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(dialog.getAttribute("data-artifact-fullscreen")).toBe("true");
      const back = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Back",
      )!;
      await act(async () => back.click());
      // The host owns the state: a request alone does not leave full screen.
      expect(requests).toEqual([false]);
      expect(dialog.getAttribute("data-artifact-fullscreen")).toBe("true");
      await act(async () => render(false));
      expect(dialog.hasAttribute("data-artifact-fullscreen")).toBe(false);
      await act(async () =>
        (
          container.querySelector('[aria-label="Open Site full screen"]') as HTMLButtonElement
        ).click(),
      );
      expect(requests).toEqual([false, true]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      showModal.mockRestore();
    }
  });

  it("sizes an inline chat visual to its content, up to a bound", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = {
      getWorkspaceArtifact: async () => {
        throw new Error("not used");
      },
      getWorkspaceArtifactHtml: async () => {
        throw new Error("not used");
      },
    } as unknown as Parameters<typeof ChatInteractiveBlock>[0]["client"];
    try {
      await act(async () =>
        root.render(
          <ChatInteractiveBlock
            workspaceId="ws-1"
            kind="html"
            content='<div class="chart">five bars</div>'
            client={client}
          />,
        ),
      );
      // Load the deferred preview, as scrolling it into view would.
      await act(async () => container.querySelector("button")!.click());
      const iframe = container.querySelector("iframe")!;
      // No fixed-height slot around the frame: the frame decides the height.
      expect(iframe.closest("[style*='height: 410px']")).toBeNull();
      expect(iframe.style.height).toBe("360px");
      const report = async (height: number) =>
        act(async () => {
          window.dispatchEvent(
            new MessageEvent("message", {
              data: { type: "opengeni.preview.height", height },
              source: iframe.contentWindow,
            }),
          );
        });
      // A short chart whose content is slightly taller than the old fixed
      // viewport gets its full height, so no inner scrollbar.
      await report(372.4);
      expect(iframe.style.height).toBe("373px");
      await report(214);
      expect(iframe.style.height).toBe("214px");
      // Very tall content stops at the bound and scrolls inside.
      await report(5000);
      expect(iframe.style.height).toBe("640px");
      // Reports from any other window are ignored.
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "opengeni.preview.height", height: 100 },
            source: window,
          }),
        );
      });
      expect(iframe.style.height).toBe("640px");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("accepts a tool port only through the parent-issued document bootstrap", () => {
    const port = {} as MessagePort;
    const connect = {
      type: OPENGENI_SITE_BRIDGE_CONNECT,
      version: OPENGENI_SITE_BRIDGE_VERSION,
    };

    expect(openGeniSiteBridgePortFromBootstrap(connect, [port])).toBe(port);
    expect(openGeniSiteBridgePortFromBootstrap(connect, [])).toBeNull();
    expect(openGeniSiteBridgePortFromBootstrap(connect, [port, port])).toBeNull();
  });

  it("installs the document bootstrap receiver before Site application code", () => {
    const html =
      "<!doctype html><html><body><script>window.siteStarted = true</script></body></html>";
    const bridged = publishedHtmlArtifactDocument(html, true);

    expect(bridged.startsWith("<!doctype html><script>")).toBe(true);
    expect(bridged.indexOf("__opengeniSiteBridgeBootstrapV2")).toBeLessThan(
      bridged.indexOf("window.siteStarted"),
    );
    expect(publishedHtmlArtifactDocument(html, false)).toBe(html);
    const doctypeLiteral = '<script>window.literal = "<!doctype html>"</script>';
    expect(publishedHtmlArtifactDocument(doctypeLiteral, true).startsWith("<script>(()=>")).toBe(
      true,
    );
  });
});
