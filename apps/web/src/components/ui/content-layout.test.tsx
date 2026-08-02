import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ContentPage } from "./content-layout";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("ContentPage scroll contract", () => {
  test("full-width outer owns scroll; max-width is an inner column only", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ContentPage width="standard" className="gap-4">
            {Array.from({ length: 24 }, (_, index) => (
              <article key={index}>Working set memory {index + 1}</article>
            ))}
          </ContentPage>,
        );
      });

      const page = container.querySelector<HTMLElement>('[data-slot="content-page"]');
      const inner = container.querySelector<HTMLElement>('[data-slot="content-page-inner"]');
      expect(page).not.toBeNull();
      expect(inner).not.toBeNull();

      // Scrollport is the full-width shell child — not the centered column.
      expect(page!.className).toContain("min-h-0");
      expect(page!.className).toContain("overflow-x-hidden");
      expect(page!.className).toContain("overflow-y-auto");
      expect(page!.className).toContain("overscroll-y-contain");
      expect(page!.className).not.toContain("max-w-5xl");
      expect(page!.className).not.toContain("mx-auto");

      // Width + padding + consumer className live on the inner column.
      expect(inner!.className).toContain("max-w-5xl");
      expect(inner!.className).toContain("mx-auto");
      expect(inner!.className).toContain("gap-4");
      expect(inner!.className).toContain("pb-[max(1.25rem,env(safe-area-inset-bottom))]");
      expect(inner!.className).not.toContain("overflow-y-auto");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
