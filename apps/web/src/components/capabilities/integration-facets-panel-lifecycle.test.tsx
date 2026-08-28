import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type {
  ApiIntegrationInstallationSummary,
  IntegrationFacetBindingSummary,
  IntegrationInstanceFacetsResponse,
} from "@/types";

import type {
  GoogleDriveFacetMutation,
  GoogleDriveKnowledgeSourceDialogProps,
} from "./google-drive-knowledge-source-dialog";

const toastSuccess = mock(() => undefined);
const toastError = mock(() => undefined);

mock.module("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
    info: mock(() => undefined),
    warning: mock(() => undefined),
  },
}));

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    onConfirm: () => void | boolean | Promise<void | boolean>;
  }) =>
    open ? (
      <div data-slot="dialog-content">
        <h2>{title}</h2>
        <p>{description}</p>
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

const { IntegrationFacetsPanel } = await import("./integration-facets-panel");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
});

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
    } as unknown as OpenGeniBrowserClient;
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
    } as unknown as OpenGeniBrowserClient;
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

  test("refreshes an open facet panel when the parent service list is refreshed", async () => {
    const active = binding("active", 1);
    const paused = binding("paused", 2);
    let listCount = 0;
    const listIntegrationFacets = mock(async () => response(listCount++ === 0 ? active : paused));
    const client = { listIntegrationFacets } as unknown as OpenGeniBrowserClient;
    const rendered = await renderPanel({ client });
    try {
      await act(async () => button(rendered.container, "Manage facets").click());
      await waitFor(() => rendered.container.textContent?.includes("Active") === true);

      await rendered.rerender({ client, refreshRevision: 1 });
      await waitFor(() => listIntegrationFacets.mock.calls.length === 2);
      await waitFor(() => rendered.container.textContent?.includes("Paused") === true);

      expect(rendered.container.textContent).not.toContain("Active");
      expect(
        rendered.container.querySelector('[data-integration-facets="finance"]'),
      ).not.toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  test("suppresses a pending lifecycle result and toast after unmount", async () => {
    const active = binding("active", 1);
    const paused = binding("paused", 2);
    type LifecycleResult = {
      capabilityId: string;
      instanceKey: string;
      facetKey: string;
      status: "paused";
      binding: IntegrationFacetBindingSummary;
    };
    let resolvePause!: (result: LifecycleResult) => void;
    const pendingPause = new Promise<LifecycleResult>((resolve) => {
      resolvePause = resolve;
    });
    const pauseIntegrationFacet = mock(async () => await pendingPause);
    const client = {
      listIntegrationFacets: mock(async () => response(active)),
      pauseIntegrationFacet,
    } as unknown as OpenGeniBrowserClient;
    const rendered = await renderPanel({ client });

    await act(async () => button(rendered.container, "Manage facets").click());
    await waitFor(() => rendered.container.textContent?.includes("Active") === true);
    await act(async () => button(rendered.container, "Pause").click());
    await waitFor(() => pauseIntegrationFacet.mock.calls.length === 1);

    await rendered.unmount();
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

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
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
    } as unknown as OpenGeniBrowserClient;
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

  test("keeps an older Google Drive success and close scoped to its originating instance", async () => {
    const instanceA = instance;
    const instanceB = {
      ...instance,
      instanceId: "00000000-0000-4000-8000-000000000204",
      instanceKey: "operations",
      displayName: "Inventory — Operations",
      instanceVersion: 2,
    };
    const activeA = binding("active", 1, "drive-content", "202");
    const pausedA = binding("paused", 2, "drive-content", "202");
    const activeB = binding("active", 1, "drive-content", "205");
    const pausedB = binding("paused", 2, "drive-content", "205");
    const listIntegrationFacets = mock(
      async (_workspaceId: string, _capabilityId: string, instanceKey: string) =>
        googleDriveResponse(
          instanceKey === instanceA.instanceKey ? instanceA : instanceB,
          {
            [instanceA.instanceKey]: activeA,
            [instanceB.instanceKey]: activeB,
          }[instanceKey]!,
        ),
    );
    let dialogA: GoogleDriveKnowledgeSourceDialogProps | null = null;
    let dialogB: GoogleDriveKnowledgeSourceDialogProps | null = null;
    const GoogleDriveDialog = (props: GoogleDriveKnowledgeSourceDialogProps) => {
      if (props.instance.instanceKey === instanceA.instanceKey) dialogA = props;
      else dialogB = props;
      return <div data-google-drive-dialog={props.instance.instanceKey} />;
    };
    const client = { listIntegrationFacets } as unknown as OpenGeniBrowserClient;
    const rendered = await renderPanel({ client, instance: instanceA, GoogleDriveDialog });
    try {
      await openGoogleDriveEditor(rendered.container, instanceA.instanceKey);
      let oldMutation!: GoogleDriveFacetMutation;
      await act(async () => {
        oldMutation = requiredDialog(dialogA).onMutationStart();
      });

      await rendered.rerender({ client, instance: instanceB, GoogleDriveDialog });
      await openGoogleDriveEditor(rendered.container, instanceB.instanceKey);
      const currentDialog = requiredDialog(dialogB);
      let currentMutation!: GoogleDriveFacetMutation;
      await act(async () => {
        currentMutation = currentDialog.onMutationStart();
      });

      let oldApplied = true;
      await act(async () => {
        oldApplied = oldMutation.apply(pausedA);
        requiredDialog(dialogA).onClose();
        oldMutation.finish();
      });

      expect(oldApplied).toBe(false);
      expect(currentMutation.isCurrent()).toBe(true);
      expect(
        rendered.container.querySelector(`[data-google-drive-dialog="${instanceB.instanceKey}"]`),
      ).not.toBeNull();
      expect(requiredFacet(rendered.container, "drive-content").textContent).toContain("Active");

      await act(async () => {
        expect(currentMutation.apply(pausedB)).toBe(true);
        currentDialog.onClose();
        currentMutation.finish();
      });
      await waitFor(
        () =>
          requiredFacet(rendered.container, "drive-content").textContent?.includes("Paused") ===
          true,
      );

      expect(rendered.container.querySelector("[data-google-drive-dialog]")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  test("does not let an older Google Drive finally consume a newer instance mutation", async () => {
    const instanceA = instance;
    const instanceB = {
      ...instance,
      instanceId: "00000000-0000-4000-8000-000000000304",
      instanceKey: "operations",
      displayName: "Inventory — Operations",
      instanceVersion: 2,
    };
    const activeA = binding("active", 1, "drive-content", "302");
    const activeB = binding("active", 1, "drive-content", "305");
    const pausedB = binding("paused", 2, "drive-content", "305");
    const listIntegrationFacets = mock(
      async (_workspaceId: string, _capabilityId: string, instanceKey: string) =>
        googleDriveResponse(
          instanceKey === instanceA.instanceKey ? instanceA : instanceB,
          {
            [instanceA.instanceKey]: activeA,
            [instanceB.instanceKey]: activeB,
          }[instanceKey]!,
        ),
    );
    let dialogA: GoogleDriveKnowledgeSourceDialogProps | null = null;
    let dialogB: GoogleDriveKnowledgeSourceDialogProps | null = null;
    const GoogleDriveDialog = (props: GoogleDriveKnowledgeSourceDialogProps) => {
      if (props.instance.instanceKey === instanceA.instanceKey) dialogA = props;
      else dialogB = props;
      return <div data-google-drive-dialog={props.instance.instanceKey} />;
    };
    const client = { listIntegrationFacets } as unknown as OpenGeniBrowserClient;
    const rendered = await renderPanel({ client, instance: instanceA, GoogleDriveDialog });
    try {
      await openGoogleDriveEditor(rendered.container, instanceA.instanceKey);
      let oldMutation!: GoogleDriveFacetMutation;
      await act(async () => {
        oldMutation = requiredDialog(dialogA).onMutationStart();
      });

      await rendered.rerender({ client, instance: instanceB, GoogleDriveDialog });
      await openGoogleDriveEditor(rendered.container, instanceB.instanceKey);
      let currentMutation!: GoogleDriveFacetMutation;
      await act(async () => {
        currentMutation = requiredDialog(dialogB).onMutationStart();
      });

      await act(async () => oldMutation.finish());

      expect(currentMutation.isCurrent()).toBe(true);
      await act(async () => {
        expect(currentMutation.apply(pausedB)).toBe(true);
        currentMutation.finish();
      });
      await waitFor(
        () =>
          requiredFacet(rendered.container, "drive-content").textContent?.includes("Paused") ===
          true,
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("renders a Pack-owned facet as shared and read-only", async () => {
    const packOwned = binding("active", 1, "inventory-source", "402", [packOwner]);
    const client = {
      listIntegrationFacets: mock(async () => response(packOwned)),
    } as unknown as OpenGeniBrowserClient;
    const rendered = await renderPanel({ client });
    try {
      await act(async () => button(rendered.container, "Manage facets").click());
      await waitFor(() => facet(rendered.container, "inventory-source") !== null);

      const row = requiredFacet(rendered.container, "inventory-source");
      expect(row.textContent).toContain("Shared");
      expect(row.textContent).toContain("Managed by another Pack");
      expect(button(row, "Edit").disabled).toBe(true);
      expect(optionalButton(row, "Pause")).toBeNull();
      expect(optionalButton(row, "Remove")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  test("does not treat another direct installation as this facet's owner", async () => {
    const otherDirectOwner = {
      kind: "direct" as const,
      id: "facet:another-direct-installation",
      removable: true,
    };
    const externallyManaged = binding(
      "active",
      1,
      "inventory-source",
      "452",
      [otherDirectOwner],
      false,
    );
    const client = {
      listIntegrationFacets: mock(async () => response(externallyManaged)),
    } as unknown as OpenGeniBrowserClient;
    const rendered = await renderPanel({ client });
    try {
      await act(async () => button(rendered.container, "Manage facets").click());
      await waitFor(() => facet(rendered.container, "inventory-source") !== null);

      const row = requiredFacet(rendered.container, "inventory-source");
      expect(row.textContent).toContain("Shared");
      expect(row.textContent).toContain("Managed by another direct installation");
      expect(button(row, "Edit").disabled).toBe(true);
      expect(optionalButton(row, "Pause")).toBeNull();
      expect(optionalButton(row, "Remove")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  test("removes only direct control when another owner retains the facet", async () => {
    const directlyShared = binding("active", 1, "inventory-source", "502", [
      directOwner,
      packOwner,
    ]);
    const retained = binding("active", 1, "inventory-source", "502", [packOwner]);
    const removeIntegrationFacet = mock(async () => ({
      capabilityId: instance.capabilityId,
      instanceKey: instance.instanceKey,
      facetKey: "inventory-source",
      status: "retained_by_other_owners" as const,
      binding: retained,
      remainingOwners: [packOwner],
    }));
    const client = {
      listIntegrationFacets: mock(async () => response(directlyShared)),
      removeIntegrationFacet,
    } as unknown as OpenGeniBrowserClient;
    const rendered = await renderPanel({ client });
    try {
      await act(async () => button(rendered.container, "Manage facets").click());
      await waitFor(() => facet(rendered.container, "inventory-source") !== null);

      const row = requiredFacet(rendered.container, "inventory-source");
      await act(async () => button(row, "Remove direct control").click());
      await waitFor(() => document.body.querySelector('[data-slot="dialog-content"]') !== null);
      const removeDialog = document.body.querySelector('[data-slot="dialog-content"]');
      if (!removeDialog) throw new Error("Missing remove-direct-control dialog");
      await act(async () => button(removeDialog, "Remove direct control").click());
      await waitFor(() => removeIntegrationFacet.mock.calls.length === 1);
      await waitFor(
        () =>
          requiredFacet(rendered.container, "inventory-source").textContent?.includes("Active") ===
          true,
      );

      const retainedRow = requiredFacet(rendered.container, "inventory-source");
      expect(retainedRow.textContent).toContain("Shared");
      expect(retainedRow.textContent).toContain("Managed by another Pack");
      expect(button(retainedRow, "Edit").disabled).toBe(true);
      expect(optionalButton(retainedRow, "Pause")).toBeNull();
      expect(optionalButton(retainedRow, "Remove")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});

async function openGoogleDriveEditor(container: ParentNode, instanceKey: string): Promise<void> {
  await act(async () => button(container, "Manage facets").click());
  await waitFor(() => facet(container, "drive-content") !== null);
  await act(async () => button(requiredFacet(container, "drive-content"), "Edit").click());
  await waitFor(
    () => container.querySelector(`[data-google-drive-dialog="${instanceKey}"]`) !== null,
  );
}

function requiredDialog(
  dialog: GoogleDriveKnowledgeSourceDialogProps | null,
): GoogleDriveKnowledgeSourceDialogProps {
  if (!dialog) throw new Error("Missing Google Drive dialog props");
  return dialog;
}

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
          client={{} as OpenGeniBrowserClient}
          workspaceId="00000000-0000-4000-8000-000000000101"
          instance={instance}
          facetCount={1}
          canManage
          canManagePersonalDestination
          canManageWorkspaceDestination
          canManageOrganizationDestination={false}
          refreshRevision={0}
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
  const match = optionalButton(container, label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function optionalButton(container: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label")?.includes(label) ||
        candidate.textContent?.includes(label),
    ) ?? null
  );
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

function googleDriveResponse(
  targetInstance: ApiIntegrationInstallationSummary,
  bindingValue: IntegrationFacetBindingSummary,
): IntegrationInstanceFacetsResponse {
  return {
    capabilityId: targetInstance.capabilityId,
    instanceKey: targetInstance.instanceKey,
    providerDomain: targetInstance.providerDomain,
    connectionId: targetInstance.connectionId,
    facets: [
      {
        definition: {
          facetKey: "drive-content",
          kind: "knowledge_source",
          configSchema: { type: "object", properties: {} },
          capabilities: { provider: "google-drive" },
        },
        binding: bindingValue,
      },
    ],
  };
}

function binding(
  status: IntegrationFacetBindingSummary["status"],
  version: number,
  facetKey = "inventory-source",
  idSuffix = "102",
  owners: IntegrationFacetBindingSummary["owners"] = [directOwner],
  directlyOwned = owners.some(
    (owner) => owner.kind === directOwner.kind && owner.id === directOwner.id,
  ),
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
    directlyOwned,
    owners,
  };
}

const directOwner = {
  kind: "direct" as const,
  id: "facet:inventory-source",
  removable: true,
};

const packOwner = {
  kind: "pack" as const,
  id: "pack:inventory-operations",
  removable: false,
};

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
