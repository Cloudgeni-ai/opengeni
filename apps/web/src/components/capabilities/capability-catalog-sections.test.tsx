import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";

import { CapabilityBrowseSection } from "./capability-catalog-sections";
import type { CapabilityCatalogItem } from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("CapabilityBrowseSection", () => {
  test("focuses the first appended connector when the final See more is activated", async () => {
    const items = Array.from({ length: 96 }, (_, index) =>
      catalogItem(`mcp:${index}`, `Connector ${index}`),
    );
    const rendered = await render(<PaginatedBrowseFixture items={items} />);

    try {
      expect(rendered.container.querySelectorAll("[data-capability-catalog-tile]")).toHaveLength(
        48,
      );

      const seeMore = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "See more",
      );
      expect(seeMore).toBeDefined();

      seeMore!.focus();
      await act(async () => seeMore!.click());
      expect(rendered.container.querySelectorAll("[data-capability-catalog-tile]")).toHaveLength(
        96,
      );
      const firstAppendedAction = rendered.container
        .querySelectorAll<HTMLElement>("[data-capability-catalog-tile]")[48]
        ?.querySelector("button");
      expect(firstAppendedAction === document.activeElement).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("does not move focus while See more remains", async () => {
    const items = Array.from({ length: 120 }, (_, index) =>
      catalogItem(`mcp:${index}`, `Connector ${index}`),
    );
    const rendered = await render(<PaginatedBrowseFixture items={items} />);

    try {
      const seeMore = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "See more",
      );
      expect(seeMore).toBeDefined();

      seeMore!.focus();
      await act(async () => seeMore!.click());

      expect(rendered.container.querySelectorAll("[data-capability-catalog-tile]")).toHaveLength(
        96,
      );
      expect(document.activeElement === seeMore).toBe(true);
      expect(seeMore!.isConnected).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });
});

function PaginatedBrowseFixture({ items }: { items: CapabilityCatalogItem[] }) {
  const [visibleCount, setVisibleCount] = useState(48);
  return (
    <CapabilityBrowseSection
      filter="all"
      query=""
      catalogView="ready"
      loadError={null}
      enabledCount={0}
      browseItems={items}
      visibleBrowse={items.slice(0, visibleCount)}
      registryBusy={false}
      registrySearched={null}
      registryResults={[]}
      logoUrl={() => null}
      onRetry={() => {}}
      onOpen={() => {}}
      onOpenRegistry={() => {}}
      onSearchRegistry={() => {}}
      onLoadMore={() => setVisibleCount((count) => Math.min(count + 48, items.length))}
    />
  );
}

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
    },
  };
}

function catalogItem(id: string, name: string): CapabilityCatalogItem {
  return {
    id,
    kind: "mcp",
    source: "public_registry",
    name,
    description: `${name} description.`,
    category: "integrations",
    tags: [],
    homepageUrl: null,
    endpointUrl: null,
    installUrl: null,
    authModel: null,
    providerDomain: null,
    surfaceType: "mcp",
    authKind: "none",
    tools: [],
    runtime: { available: true, notes: null },
    enabled: false,
    enabledReason: null,
    provenance: null,
    actions: [],
    logoAssetPath: null,
    metadata: {},
  } as unknown as CapabilityCatalogItem;
}
