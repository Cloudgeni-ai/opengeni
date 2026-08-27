import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "radix-ui";
import { ScreenshotLightboxControls } from "../src/timeline/screenshot-lightbox";

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
