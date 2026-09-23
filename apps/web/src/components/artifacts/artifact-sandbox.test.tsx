import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX,
  PublishedHtmlArtifactFrame,
  openGeniSiteBridgePortFromBootstrap,
  publishedHtmlArtifactDocument,
} from "@opengeni/react/artifacts";
import { OPENGENI_SITE_BRIDGE_CONNECT, OPENGENI_SITE_BRIDGE_VERSION } from "@opengeni/sdk/site";

import { ArtifactSandbox } from "./artifact-sandbox";

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
    expect(markup).toContain("v4");
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
      await act(async () =>
        (
          container.querySelector('[aria-label="Open Site full screen"]') as HTMLButtonElement
        ).click(),
      );
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(dialog.querySelector("iframe")).toBe(iframe);
      expect(dialog.className).toContain("fixed");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Back")!
          .click(),
      );
      expect(show).toHaveBeenCalledTimes(1);
      expect(dialog.querySelector("iframe")).toBe(iframe);
      expect(dialog.open).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      showModal.mockRestore();
      show.mockRestore();
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
