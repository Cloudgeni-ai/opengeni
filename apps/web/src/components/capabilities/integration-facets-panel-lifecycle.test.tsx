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
});

async function renderPanel(props: Partial<ComponentProps<typeof IntegrationFacetsPanel>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
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
        {...props}
      />,
    );
  });
  return {
    container,
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

function response(bindingValue: IntegrationFacetBindingSummary): IntegrationInstanceFacetsResponse {
  return {
    capabilityId: instance.capabilityId,
    instanceKey: instance.instanceKey,
    providerDomain: instance.providerDomain,
    connectionId: instance.connectionId,
    facets: [
      {
        definition: {
          facetKey: "inventory-source",
          kind: "knowledge_source",
          configSchema: { type: "object", properties: {} },
          capabilities: {},
        },
        binding: bindingValue,
      },
    ],
  };
}

function binding(
  status: IntegrationFacetBindingSummary["status"],
  version: number,
): IntegrationFacetBindingSummary {
  return {
    id: "00000000-0000-4000-8000-000000000102",
    facetKey: "inventory-source",
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
