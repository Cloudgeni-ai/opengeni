import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import type { ApiIntegrationInstallationSummary, IntegrationDefinitionSummary } from "@/types";

type ControlCenterViewProbe = {
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  loading: boolean;
  removeTarget: { instance: ApiIntegrationInstallationSummary } | null;
  onPreviewRemove: (instance: ApiIntegrationInstallationSummary) => void;
  onRemoveInstance: () => Promise<boolean>;
};

let latestControlCenterView: ControlCenterViewProbe | null = null;

const context: {
  client: OpenGeniCoreClient;
  accessContext: {
    subjectId: string;
    accountGrants: [];
    workspaceGrants: [];
  };
} = {
  client: {} as OpenGeniCoreClient,
  accessContext: {
    subjectId: "user:caller",
    accountGrants: [],
    workspaceGrants: [],
  },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

mock.module("@/components/capabilities/integration-control-center-view", () => ({
  IntegrationControlCenterView: (props: ControlCenterViewProbe) => {
    latestControlCenterView = props;
    return (
      <div data-workspace-id={props.workspaceId} data-loading={String(props.loading)}>
        {props.definitions.map((candidate) => candidate.name).join(",")}
      </div>
    );
  },
}));

const { IntegrationControlCenter } = await import("./integration-control-center");

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

describe("Integration Control Center load ownership", () => {
  test("does not let a stale workspace response overwrite the current workspace", async () => {
    const definitionsA = deferred<{ definitions: IntegrationDefinitionSummary[] }>();
    const instancesA = deferred<{ integrations: [] }>();
    const definitionsB = deferred<{ definitions: IntegrationDefinitionSummary[] }>();
    const instancesB = deferred<{ integrations: [] }>();
    const listIntegrationDefinitionsA = mock(async () => await definitionsA.promise);
    const listApiIntegrationsA = mock(async () => await instancesA.promise);
    const listIntegrationDefinitionsB = mock(async () => await definitionsB.promise);
    const listApiIntegrationsB = mock(async () => await instancesB.promise);
    const clientA = {
      listIntegrationDefinitions: listIntegrationDefinitionsA,
      listApiIntegrations: listApiIntegrationsA,
    } as unknown as OpenGeniCoreClient;
    const clientB = {
      listIntegrationDefinitions: listIntegrationDefinitionsB,
      listApiIntegrations: listApiIntegrationsB,
    } as unknown as OpenGeniCoreClient;
    context.client = clientA;
    const rendered = await renderControlCenter({ workspaceId: "workspace-a" });
    try {
      await waitFor(
        () =>
          listIntegrationDefinitionsA.mock.calls.length === 1 &&
          listApiIntegrationsA.mock.calls.length === 1,
      );

      context.client = clientB;
      await rendered.rerender({ workspaceId: "workspace-b" });
      await waitFor(
        () =>
          listIntegrationDefinitionsB.mock.calls.length === 1 &&
          listApiIntegrationsB.mock.calls.length === 1,
      );

      await act(async () => {
        definitionsB.resolve({
          definitions: [integrationDefinition("definition-b", "Workspace B")],
        });
        instancesB.resolve({ integrations: [] });
        await Promise.resolve();
      });
      await waitFor(() => rendered.container.textContent === "Workspace B");

      await act(async () => {
        definitionsA.resolve({
          definitions: [integrationDefinition("definition-a", "Workspace A")],
        });
        instancesA.resolve({ integrations: [] });
        await Promise.resolve();
      });
      await act(async () => await Bun.sleep(0));

      const view = rendered.container.querySelector<HTMLElement>("[data-workspace-id]");
      expect(view?.dataset.workspaceId).toBe("workspace-b");
      expect(view?.dataset.loading).toBe("false");
      expect(rendered.container.textContent).toBe("Workspace B");
      expect(rendered.container.textContent).not.toContain("Workspace A");
    } finally {
      await rendered.unmount();
    }
  });

  test("does not let a stale workspace operation invalidate the current workspace load", async () => {
    const instanceA = integrationInstance("definition-a", "Workspace A");
    const staleDefinitionsReloadA = deferred<{
      definitions: IntegrationDefinitionSummary[];
    }>();
    const staleInstancesReloadA = deferred<{ integrations: [] }>();
    const definitionsB = deferred<{ definitions: IntegrationDefinitionSummary[] }>();
    const instancesB = deferred<{ integrations: [] }>();
    const uninstallA = deferred<void>();
    let definitionCallsA = 0;
    let instanceCallsA = 0;
    const listIntegrationDefinitionsA = mock(async () => {
      definitionCallsA += 1;
      return definitionCallsA === 1
        ? { definitions: [integrationDefinition("definition-a", "Workspace A")] }
        : await staleDefinitionsReloadA.promise;
    });
    const listApiIntegrationsA = mock(async () => {
      instanceCallsA += 1;
      return instanceCallsA === 1
        ? { integrations: [instanceA] }
        : await staleInstancesReloadA.promise;
    });
    const previewApiIntegrationUninstallA = mock(async () => ({ removesDefinition: false }));
    const uninstallApiIntegrationA = mock(async () => await uninstallA.promise);
    const listIntegrationDefinitionsB = mock(async () => await definitionsB.promise);
    const listApiIntegrationsB = mock(async () => await instancesB.promise);
    const onChanged = mock(async () => undefined);
    const clientA = {
      listIntegrationDefinitions: listIntegrationDefinitionsA,
      listApiIntegrations: listApiIntegrationsA,
      previewApiIntegrationUninstall: previewApiIntegrationUninstallA,
      uninstallApiIntegration: uninstallApiIntegrationA,
    } as unknown as OpenGeniCoreClient;
    const clientB = {
      listIntegrationDefinitions: listIntegrationDefinitionsB,
      listApiIntegrations: listApiIntegrationsB,
    } as unknown as OpenGeniCoreClient;
    context.client = clientA;
    latestControlCenterView = null;
    const rendered = await renderControlCenter({ workspaceId: "workspace-a", onChanged });
    try {
      await waitFor(
        () => rendered.container.textContent === "Workspace A" && latestControlCenterView !== null,
      );

      await act(async () => {
        latestControlCenterView!.onPreviewRemove(instanceA);
        await Promise.resolve();
      });
      await waitFor(
        () =>
          previewApiIntegrationUninstallA.mock.calls.length === 1 &&
          latestControlCenterView?.removeTarget?.instance === instanceA,
      );

      let removalPromise!: Promise<boolean>;
      await act(async () => {
        removalPromise = latestControlCenterView!.onRemoveInstance();
        await Promise.resolve();
      });
      await waitFor(() => uninstallApiIntegrationA.mock.calls.length === 1);

      context.client = clientB;
      await rendered.rerender({ workspaceId: "workspace-b", onChanged });
      await waitFor(
        () =>
          listIntegrationDefinitionsB.mock.calls.length === 1 &&
          listApiIntegrationsB.mock.calls.length === 1,
      );

      await act(async () => {
        uninstallA.resolve();
        await Promise.resolve();
      });
      await act(async () => await Bun.sleep(0));

      expect(listIntegrationDefinitionsA.mock.calls.length).toBe(1);
      expect(listApiIntegrationsA.mock.calls.length).toBe(1);
      expect(await removalPromise).toBe(false);
      expect(onChanged.mock.calls.length).toBe(0);

      await act(async () => {
        definitionsB.resolve({
          definitions: [integrationDefinition("definition-b", "Workspace B")],
        });
        instancesB.resolve({ integrations: [] });
        await Promise.resolve();
      });
      await waitFor(() => rendered.container.textContent === "Workspace B");

      const view = rendered.container.querySelector<HTMLElement>("[data-workspace-id]");
      expect(view?.dataset.workspaceId).toBe("workspace-b");
      expect(view?.dataset.loading).toBe("false");
    } finally {
      await rendered.unmount();
    }
  });
});

async function renderControlCenter(
  props: Partial<ComponentProps<typeof IntegrationControlCenter>> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (
    nextProps: Partial<ComponentProps<typeof IntegrationControlCenter>> = props,
  ) => {
    await act(async () => {
      root.render(
        <IntegrationControlCenter
          workspaceId="workspace-a"
          connections={[]}
          canManage
          onChanged={() => undefined}
          {...nextProps}
        />,
      );
      await Promise.resolve();
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

function integrationDefinition(id: string, name: string): IntegrationDefinitionSummary {
  return {
    id,
    name,
    summary: `${name} integration`,
    protocol: "openapi",
    provider: { id: "google", domain: `${id}.example.com` },
    authentication: { kind: "oauth2", scopes: [] },
    facets: [],
  };
}

function integrationInstance(
  definitionId: string,
  displayName: string,
): ApiIntegrationInstallationSummary {
  return {
    capabilityId: `api:${definitionId}`,
    pluginKey: `integration/${definitionId}`,
    installationVersion: 1,
    instanceId: "00000000-0000-4000-8000-000000000104",
    instanceKey: "primary",
    displayName,
    instanceVersion: 1,
    serverId: `${definitionId}_primary`,
    name: displayName,
    description: `${displayName} integration`,
    protocol: "openapi",
    definitionId,
    definitionProvenance: "curated",
    providerDomain: `${definitionId}.example.com`,
    baseUrl: `https://${definitionId}.example.com/v1/`,
    sourceUrl: `https://${definitionId}.example.com/openapi.json`,
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
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => await Bun.sleep(0));
  }
  throw new Error("Timed out waiting for Integration Control Center state");
}
