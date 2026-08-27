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

function renderControls(controlLabels?: { download?: string; close?: string }) {
  return renderToStaticMarkup(
    <Dialog.Root open>
      <ScreenshotLightboxControls
        src="blob:screenshot.png"
        downloadFilename="screenshot.png"
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
