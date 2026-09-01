import { describe, expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "radix-ui";
import {
  createLightboxSourceOwner,
  LightboxProvider,
  ScreenshotLightboxControls,
  useLightboxOptional,
} from "../src/timeline/screenshot-lightbox";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

function renderControls(
  controlLabels?: { download?: string; close?: string },
  resolveDownloadUrl?: (() => Promise<string | undefined>) | null,
) {
  return renderToStaticMarkup(
    <Dialog.Root open>
      <ScreenshotLightboxControls
        src="blob:screenshot.png"
        downloadFilename="screenshot.png"
        resolveDownloadUrl={resolveDownloadUrl}
        controlLabels={controlLabels}
      />
    </Dialog.Root>,
  );
}

describe("ScreenshotLightboxControls", () => {
  test("renders the opened lightbox controls with default accessible names", () => {
    const markup = renderControls();

    expect(markup).toContain('aria-label="Download screenshot.png"');
    expect(markup).toContain('aria-label="Close"');
  });

  test("renders the opened lightbox controls with localized accessible names", () => {
    const markup = renderControls({
      download: "Descargar screenshot.png",
      close: "Cerrar",
    });

    expect(markup).toContain('aria-label="Descargar screenshot.png"');
    expect(markup).toContain('aria-label="Cerrar"');
    expect(markup).not.toContain('aria-label="Download screenshot.png"');
    expect(markup).not.toContain('aria-label="Close"');
  });

  test("renders an on-demand download control without retaining a signed URL", () => {
    const markup = renderControls(undefined, async () => "https://files.example.test/fresh");

    expect(markup).toContain('aria-label="Download screenshot.png"');
    expect(markup).not.toContain("files.example.test");
    expect(markup).not.toContain('href="blob:screenshot.png"');
  });

  test("can suppress an unsafe preview-source download fallback", () => {
    const markup = renderControls(undefined, null);

    expect(markup).not.toContain('aria-label="Download screenshot.png"');
    expect(markup).toContain('aria-label="Close"');
  });

  test("starts each download with the URL freshly returned by the resolver", async () => {
    const urls = [
      "https://files.example.test/screenshot.png?signature=first",
      "https://files.example.test/screenshot.png?signature=second",
    ];
    const clicked: Array<{ href: string; download: string; rel: string }> = [];
    let resolveCalls = 0;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      clicked.push({ href: this.href, download: this.download, rel: this.rel });
    };
    const rendered = await renderComponent(
      <Dialog.Root open>
        <ScreenshotLightboxControls
          src="https://files.example.test/expired-preview"
          downloadFilename="screenshot.png"
          resolveDownloadUrl={async () => urls[resolveCalls++]}
        />
      </Dialog.Root>,
    );
    try {
      const download = rendered.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Download screenshot.png"]',
      );
      for (const _url of urls) {
        await act(async () => {
          download?.click();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
    } finally {
      await rendered.unmount();
      HTMLAnchorElement.prototype.click = originalClick;
    }

    expect(resolveCalls).toBe(2);
    expect(clicked).toEqual(
      urls.map((href) => ({ href, download: "screenshot.png", rel: "noreferrer" })),
    );
    expect(document.querySelectorAll('a[href*="files.example.test"]')).toHaveLength(0);
  });
});

describe("LightboxProvider source ownership", () => {
  test("releases retained sources on replacement and provider unmount", async () => {
    let controller: ReturnType<typeof useLightboxOptional> = null;
    const released: string[] = [];

    function Probe() {
      controller = useLightboxOptional();
      return null;
    }

    const rendered = await renderComponent(
      <LightboxProvider>
        <Probe />
      </LightboxProvider>,
    );

    await act(async () => {
      controller?.open("blob:first", undefined, undefined, undefined, undefined, undefined, () => {
        released.push("first");
      });
    });
    expect(released).toEqual([]);

    await act(async () => {
      controller?.open("blob:second", undefined, undefined, undefined, undefined, undefined, () => {
        released.push("second");
      });
    });
    expect(released).toEqual(["first"]);
    await rendered.unmount();
    expect(released).toEqual(["first", "second"]);
  });

  test("source-owner release is idempotent for close and cleanup paths", () => {
    const released: string[] = [];
    const owner = createLightboxSourceOwner();

    owner.replace(() => released.push("first"));
    owner.release();
    owner.release();
    expect(released).toEqual(["first"]);

    owner.replace(() => released.push("second"));
    owner.replace(() => released.push("third"));
    expect(released).toEqual(["first", "second"]);
    owner.release();
    expect(released).toEqual(["first", "second", "third"]);
  });
});
