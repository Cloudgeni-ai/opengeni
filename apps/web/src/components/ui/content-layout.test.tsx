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
  test("keeps long workspace content reachable inside the fixed canvas", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ContentPage>
            {Array.from({ length: 24 }, (_, index) => (
              <article key={index}>Working set memory {index + 1}</article>
            ))}
          </ContentPage>,
        );
      });

      const page = container.querySelector<HTMLElement>('[data-slot="content-page"]');
      expect(page).not.toBeNull();
      expect(page!.className).toContain("min-h-0");
      expect(page!.className).toContain("overflow-x-hidden");
      expect(page!.className).toContain("overflow-y-auto");
      expect(page!.className).toContain("overscroll-y-contain");
      expect(page!.className).toContain("pb-[max(1.25rem,env(safe-area-inset-bottom))]");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
