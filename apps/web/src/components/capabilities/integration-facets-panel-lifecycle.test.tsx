import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import type {
  ApiIntegrationInstallationSummary,
  IntegrationFacetBindingSummary,
  IntegrationInstanceFacetsResponse,
} from "@/types";

import { IntegrationFacetsPanel } from "./integration-facets-panel";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("Integration Facet lifecycle state", () => {
  test("applies the authoritative lifecycle result without a stale list refetch", async () => {
    const active = binding("active", 1);
    const paused = binding("paused", 2);
    const listIntegrationFacets = mock(async () => response(active));
    const pauseIntegrationFacet = mock(async () => ({
      capabilityId: instance.capabilityId,
      instanceKey: instance.instanceKey,
      facetKey: "inventory-source",
      status: "paused" as const,
      binding: paused,
    }));
    const client = {
      listIntegrationFacets,
      pauseIntegrationFacet,
    } as unknown as OpenGeniCoreClient;
    const rendered = await renderPanel({ client });
    try {
      await act(async () => button(rendered.container, "Manage facets").click());
      await waitFor(() => rendered.container.textContent?.includes("Active") === true);

      await act(async () => button(rendered.container, "Pause").click());
      await waitFor(() => rendered.container.textContent?.includes("Paused") === true);

      expect(pauseIntegrationFacet).toHaveBeenCalledTimes(1);
      expect(listIntegrationFacets).toHaveBeenCalledTimes(1);
      expect(rendered.container.textContent).not.toContain("Active");
    } finally {
      await rendered.unmount();
    }
  });

  test("ignores an older lifecycle result after a newer instance list wins", async () => {
    const active = binding("active", 1);
    const paused = binding("paused", 2);
    const newerActive = binding("active", 3);
    let listCount = 0;
    const listIntegrationFacets = mock(async () =>
      response(listCount++ === 0 ? active : newerActive),
    );
    type LifecycleResult = {
      capabilityId: string;
      instanceKey: string;
      facetKey: string;
      status: "paused";
      binding: IntegrationFacetBindingSummary;
    };
    let resolvePause: (result: LifecycleResult) => void = () => undefined;
    const pauseResult = new Promise<LifecycleResult>((resolve) => {
      resolvePause = resolve;
    });
    const pauseIntegrationFacet = mock(async () => await pauseResult);
    const client = {
      listIntegrationFacets,
      pauseIntegrationFacet,
    } as unknown as OpenGeniCoreClient;
    const rendered = await renderPanel({ client });
    try {
      await act(async () => button(rendered.container, "Manage facets").click());
      await waitFor(() => rendered.container.textContent?.includes("Active") === true);

      await act(async () => button(rendered.container, "Pause").click());
      await waitFor(() => pauseIntegrationFacet.mock.calls.length === 1);

      await rendered.rerender({
        client,
        instance: { ...instance, instanceVersion: 2 },
      });
      await act(async () => button(rendered.container, "Manage facets").click());
      await waitFor(() => listIntegrationFacets.mock.calls.length === 2);
      await waitFor(() => rendered.container.textContent?.includes("Active") === true);

      await act(async () =>
        resolvePause({
          capabilityId: instance.capabilityId,
          instanceKey: instance.instanceKey,
          facetKey: "inventory-source",
          status: "paused",
          binding: paused,
        }),
      );
      await act(async () => await Bun.sleep(0));

      expect(rendered.container.textContent).toContain("Active");
      expect(rendered.container.textContent).not.toContain("Paused");
    } finally {
      await rendered.unmount();
    }
  });

  test("applies concurrent lifecycle results for different facets independently", async () => {
    const firstActive = binding("active", 1, "inventory-source", "102");
    const secondActive = binding("active", 1, "orders-source", "105");
    const firstPaused = binding("paused", 2, "inventory-source", "102");
    const secondPaused = binding("paused", 2, "orders-source", "105");
    type LifecycleResult = {
      capabilityId: string;
      instanceKey: string;
      facetKey: string;
      status: "paused";
      binding: IntegrationFacetBindingSummary;
    };
    const resolvers = new Map<string, (result: LifecycleResult) => void>();
    const pauseIntegrationFacet = mock(
      async (_workspaceId: string, _capabilityId: string, _instanceKey: string, facetKey: string) =>
        await new Promise<LifecycleResult>((resolve) => {
          resolvers.set(facetKey, resolve);
        }),
    );
    const client = {
      listIntegrationFacets: mock(async () => response(firstActive, secondActive)),
      pauseIntegrationFacet,
    } as unknown as OpenGeniCoreClient;
    const rendered = await renderPanel({ client, facetCount: 2 });
    try {
      await act(async () => button(rendered.container, "Manage facets").click());
      await waitFor(() => facet(rendered.container, "inventory-source") !== null);

      await act(async () =>
        button(requiredFacet(rendered.container, "inventory-source"), "Pause").click(),
      );
      await waitFor(() => resolvers.has("inventory-source"));
      await act(async () =>
        button(requiredFacet(rendered.container, "orders-source"), "Pause").click(),
      );
      await waitFor(() => resolvers.has("orders-source"));

      await act(async () =>
        resolvers.get("orders-source")?.({
          capabilityId: instance.capabilityId,
          instanceKey: instance.instanceKey,
          facetKey: "orders-source",
          status: "paused",
          binding: secondPaused,
        }),
      );
      await waitFor(
        () => facet(rendered.container, "orders-source")?.textContent?.includes("Paused") === true,
      );

      await act(async () =>
        resolvers.get("inventory-source")?.({
          capabilityId: instance.capabilityId,
          instanceKey: instance.instanceKey,
          facetKey: "inventory-source",
          status: "paused",
          binding: firstPaused,
        }),
      );
      await waitFor(
        () =>
          facet(rendered.container, "inventory-source")?.textContent?.includes("Paused") === true,
      );

      expect(pauseIntegrationFacet).toHaveBeenCalledTimes(2);
      expect(facet(rendered.container, "inventory-source")?.textContent).toContain("Paused");
      expect(facet(rendered.container, "orders-source")?.textContent).toContain("Paused");
    } finally {
      await rendered.unmount();
    }
  });
});

async function renderPanel(props: Partial<ComponentProps<typeof IntegrationFacetsPanel>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (
    nextProps: Partial<ComponentProps<typeof IntegrationFacetsPanel>> = props,
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <IntegrationFacetsPanel
          client={{} as OpenGeniCoreClient}
          workspaceId="00000000-0000-4000-8000-000000000101"
          instance={instance}
          facetCount={1}
          canManage
          canManagePersonalDestination
          canManageWorkspaceDestination
          canManageOrganizationDestination={false}
          GoogleDriveDialog={() => null}
          {...nextProps}
        />,
      );
    });
  };
  await render();
  return {
    container,
    rerender: render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => await Bun.sleep(0));
  }
  throw new Error("Timed out waiting for Integration Facet state");
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label")?.includes(label) ||
      candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function facet(container: ParentNode, facetKey: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-integration-facet="${facetKey}"]`);
}

function requiredFacet(container: ParentNode, facetKey: string): HTMLElement {
  const match = facet(container, facetKey);
  if (!match) throw new Error(`Missing facet: ${facetKey}`);
  return match;
}

function response(
  ...bindingValues: IntegrationFacetBindingSummary[]
): IntegrationInstanceFacetsResponse {
  return {
    capabilityId: instance.capabilityId,
    instanceKey: instance.instanceKey,
    providerDomain: instance.providerDomain,
    connectionId: instance.connectionId,
    facets: bindingValues.map((bindingValue) => ({
      definition: {
        facetKey: bindingValue.facetKey,
        kind: "knowledge_source",
        configSchema: { type: "object", properties: {} },
        capabilities: {},
      },
      binding: bindingValue,
    })),
  };
}

function binding(
  status: IntegrationFacetBindingSummary["status"],
  version: number,
  facetKey = "inventory-source",
  idSuffix = "102",
): IntegrationFacetBindingSummary {
  return {
    id: `00000000-0000-4000-8000-000000000${idSuffix}`,
    facetKey,
    kind: "knowledge_source",
    bindingKey: "finance",
    displayName: "Finance inventory",
    connectionId: "00000000-0000-4000-8000-000000000103",
    status,
    config: { collection: "finance" },
    version,
    hasCursor: false,
    lastSuccessAt: null,
    lastErrorCode: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

const instance: ApiIntegrationInstallationSummary = {
  capabilityId: "api:inventory",
  pluginKey: "integration/inventory",
  installationVersion: 1,
  instanceId: "00000000-0000-4000-8000-000000000104",
  instanceKey: "finance",
  displayName: "Inventory — Finance",
  instanceVersion: 1,
  serverId: "inventory_finance",
  name: "Inventory",
  description: "Inventory Integration",
  protocol: "openapi",
  definitionId: "inventory",
  definitionProvenance: "workspace",
  providerDomain: "inventory.example.com",
  baseUrl: "https://inventory.example.com/v1/",
  sourceUrl: "https://inventory.example.com/openapi.json",
  connected: true,
  requiresConnection: true,
  connectionId: "00000000-0000-4000-8000-000000000103",
  ownership: "personal",
  allowedTools: ["list_items"],
  toolCount: 1,
  approvalRequiredToolCount: 0,
  revisionId: "openapi:fixture",
  contentSha256: "a".repeat(64),
};
