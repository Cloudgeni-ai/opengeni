import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { IntegrationDefinitionSummary } from "@/types";

const context: { client: OpenGeniCoreClient } = { client: {} as OpenGeniCoreClient };

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { error: () => {}, success: () => {} } }));

const { useCapabilitiesCatalog } = await import("./use-capabilities-catalog");

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function definition(id: string, name: string): IntegrationDefinitionSummary {
  return {
    id,
    name,
    summary: name,
    protocol: "openapi",
    provider: { id: "microsoft", domain: "graph.microsoft.com" },
    authentication: { kind: "oauth2", scopes: [] },
    facets: [],
  } as unknown as IntegrationDefinitionSummary;
}

/** A client whose definitions call resolves only when the test says so. */
function fakeClient(definitions: Promise<{ definitions: IntegrationDefinitionSummary[] }>) {
  return {
    listCapabilities: async () => ({ items: [] }),
    listConnections: async () => [],
    listSocialConnections: async () => [],
    listSlackInstallationBindings: async () => [],
    listIntegrationDefinitions: async () => await definitions,
    listApiIntegrations: async () => ({ integrations: [] }),
  } as unknown as OpenGeniCoreClient;
}

describe("useCapabilitiesCatalog", () => {
  test("a stale workspace response never populates the current workspace", async () => {
    const workspaceA = deferred<{ definitions: IntegrationDefinitionSummary[] }>();
    const workspaceB = deferred<{ definitions: IntegrationDefinitionSummary[] }>();
    const clientA = fakeClient(workspaceA.promise);
    const clientB = fakeClient(workspaceB.promise);

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness({ workspaceId }: { workspaceId: string }) {
      latest = useCapabilitiesCatalog(workspaceId);
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    context.client = clientA;
    await act(async () => root.render(<Harness workspaceId="workspace-a" />));
    await act(async () => {
      void latest!.refresh();
    });

    // The user switches workspaces while workspace A's load is still in flight.
    context.client = clientB;
    await act(async () => root.render(<Harness workspaceId="workspace-b" />));
    await act(async () => {
      void latest!.refresh();
    });

    await act(async () => {
      workspaceB.resolve({ definitions: [definition("microsoft-onedrive", "Workspace B")] });
      await Bun.sleep(0);
    });
    expect(latest!.apiIntegrationDefinitions.map((entry) => entry.name)).toEqual(["Workspace B"]);
    expect(latest!.loading).toBe(false);
    const revisionAfterB = latest!.revision;

    // Workspace A's response lands late; it must be dropped entirely.
    await act(async () => {
      workspaceA.resolve({ definitions: [definition("microsoft-outlook-mail", "Workspace A")] });
      await Bun.sleep(0);
    });
    expect(latest!.apiIntegrationDefinitions.map((entry) => entry.name)).toEqual(["Workspace B"]);
    expect(latest!.loading).toBe(false);
    expect(latest!.loadError).toBeNull();
    expect(latest!.revision).toBe(revisionAfterB);

    await act(async () => root.unmount());
    container.remove();
  });

  test("a stale workspace failure never raises an error on the current workspace", async () => {
    const failing = {
      listCapabilities: async () => {
        await Bun.sleep(5);
        throw new Error("workspace A is gone");
      },
      listConnections: async () => [],
      listSocialConnections: async () => [],
      listSlackInstallationBindings: async () => [],
      listIntegrationDefinitions: async () => ({ definitions: [] }),
      listApiIntegrations: async () => ({ integrations: [] }),
    } as unknown as OpenGeniCoreClient;
    const healthy = fakeClient(Promise.resolve({ definitions: [] }));

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness({ workspaceId }: { workspaceId: string }) {
      latest = useCapabilitiesCatalog(workspaceId);
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    context.client = failing;
    await act(async () => root.render(<Harness workspaceId="workspace-a" />));
    await act(async () => {
      void latest!.refresh();
    });

    context.client = healthy;
    await act(async () => root.render(<Harness workspaceId="workspace-b" />));
    await act(async () => {
      await latest!.refresh();
    });
    await act(async () => await Bun.sleep(20));

    expect(latest!.loadError).toBeNull();
    expect(latest!.loading).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });
});
