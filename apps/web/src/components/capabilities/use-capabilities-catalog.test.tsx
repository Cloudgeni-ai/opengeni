import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  IntegrationDefinitionSummary,
} from "@/types";

const context: { client: OpenGeniBrowserClient } = { client: {} as OpenGeniBrowserClient };

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
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
  } as unknown as OpenGeniBrowserClient;
}

describe("useCapabilitiesCatalog", () => {
  test("revoked connection access clears previously loaded rows without hiding the catalog", async () => {
    const connection = { id: "previously-visible" } as ConnectionMetadata;
    let denied = false;
    context.client = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listConnections: async () => {
        if (denied) throw { status: 403 };
        return [connection];
      },
    } as unknown as OpenGeniBrowserClient;

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => await latest!.refresh());
    expect(latest!.connections).toEqual([connection]);
    expect(latest!.connectionsAccessDenied).toBe(false);

    denied = true;
    await act(async () => await latest!.refresh());
    expect(latest!.connections).toBeNull();
    expect(latest!.connectionsLoadFailed).toBe(true);
    expect(latest!.connectionsAccessDenied).toBe(true);
    expect(latest!.items).toEqual([]);
    expect(latest!.loadError).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  test("a late older success cannot restore rows after a newer 403", async () => {
    const oldLoad = deferred<ConnectionMetadata[]>();
    const connection = { id: "stale" } as ConnectionMetadata;
    let calls = 0;
    context.client = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listConnections: async () => {
        if (++calls === 1) return oldLoad.promise;
        throw { status: 403 };
      },
    } as unknown as OpenGeniBrowserClient;

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => {
      void latest!.refresh();
    });
    await act(async () => await latest!.refresh());
    expect(latest!.connectionsAccessDenied).toBe(true);
    expect(latest!.connections).toBeNull();

    await act(async () => {
      oldLoad.resolve([connection]);
      await Bun.sleep(0);
    });
    expect(latest!.connections).toBeNull();
    expect(latest!.connectionsAccessDenied).toBe(true);
    expect(latest!.loading).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  test("an older 403 arriving after a newer 503 retires cached rows until a successful read", async () => {
    const older = deferred<ConnectionMetadata[]>();
    const newer = deferred<ConnectionMetadata[]>();
    const cached = { id: "cached" } as ConnectionMetadata;
    const restored = { id: "restored" } as ConnectionMetadata;
    let calls = 0;
    context.client = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listConnections: async () => {
        calls++;
        return calls === 1
          ? [cached]
          : calls === 2
            ? older.promise
            : calls === 3
              ? newer.promise
              : [restored];
      },
    } as unknown as OpenGeniBrowserClient;

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => await latest!.refresh());
    await act(async () => {
      void latest!.fetchConnections();
      void latest!.fetchConnections();
    });
    await act(async () => {
      newer.reject({ status: 503 });
      await Bun.sleep(0);
    });
    expect(latest!.connections).toEqual([cached]);
    await act(async () => {
      older.reject({ status: 403 });
      await Bun.sleep(0);
    });
    expect(latest!.connections).toBeNull();
    expect(latest!.connectionsAccessDenied).toBe(true);
    expect(latest!.connectionsLoadFailed).toBe(true);
    await act(async () => await latest!.fetchConnections());
    expect(latest!.connections).toEqual([restored]);
    expect(latest!.connectionsAccessDenied).toBe(false);
    await act(async () => root.unmount());
    container.remove();
  });

  test("a newer successful connection read restores access after an older 403", async () => {
    const older = deferred<ConnectionMetadata[]>();
    const newer = deferred<ConnectionMetadata[]>();
    const restored = { id: "restored" } as ConnectionMetadata;
    let calls = 0;
    context.client = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listConnections: async () => (++calls === 1 ? older.promise : newer.promise),
    } as unknown as OpenGeniBrowserClient;
    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => {
      void latest!.fetchConnections();
      void latest!.fetchConnections();
    });
    await act(async () => {
      older.reject({ status: 403 });
      await Bun.sleep(0);
    });
    expect(latest!.connectionsAccessDenied).toBe(true);
    await act(async () => {
      newer.resolve([restored]);
      await Bun.sleep(0);
    });
    expect(latest!.connections).toEqual([restored]);
    expect(latest!.connectionsAccessDenied).toBe(false);
    expect(latest!.connectionsLoadFailed).toBe(false);
    await act(async () => root.unmount());
    container.remove();
  });

  test("an old client's late 403 cannot revoke the new client's connection rows", async () => {
    const stale = deferred<ConnectionMetadata[]>();
    const current = { id: "current" } as ConnectionMetadata;
    const clientA = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listConnections: async () => stale.promise,
    } as unknown as OpenGeniBrowserClient;
    const clientB = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listConnections: async () => [current],
    } as unknown as OpenGeniBrowserClient;
    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    context.client = clientA;
    await act(async () => root.render(<Harness />));
    await act(async () => {
      void latest!.fetchConnections();
    });
    context.client = clientB;
    await act(async () => root.render(<Harness />));
    await act(async () => await latest!.fetchConnections());
    await act(async () => {
      stale.reject({ status: 403 });
      await Bun.sleep(0);
    });
    expect(latest!.connections).toEqual([current]);
    expect(latest!.connectionsAccessDenied).toBe(false);
    await act(async () => root.unmount());
    container.remove();
  });

  test("confirmed 403 retires cached rows even if the catalog concurrently fails", async () => {
    const catalogFailure = deferred<{ items: CapabilityCatalogItem[] }>();
    const connectionFailure = deferred<ConnectionMetadata[]>();
    const cached = { id: "cached" } as ConnectionMetadata;
    let fail = false;
    context.client = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listCapabilities: async () => (fail ? catalogFailure.promise : { items: [] }),
      listConnections: async () => (fail ? connectionFailure.promise : [cached]),
    } as unknown as OpenGeniBrowserClient;

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => await latest!.refresh());
    expect(latest!.connections).toEqual([cached]);

    fail = true;
    await act(async () => {
      void latest!.refresh();
      catalogFailure.reject(new Error("Catalog unavailable"));
      await Bun.sleep(0);
    });
    expect(latest!.loadError?.message).toBe("Catalog unavailable");
    expect(latest!.connections).toEqual([cached]);

    await act(async () => {
      connectionFailure.reject({ status: 403 });
      await Bun.sleep(0);
    });
    expect(latest!.connections).toBeNull();
    expect(latest!.connectionsLoadFailed).toBe(true);
    expect(latest!.connectionsAccessDenied).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });

  test("the OAuth-return connection read revokes cached rows even if its catalog read fails", async () => {
    const cached = { id: "oauth-cached" } as ConnectionMetadata;
    let denied = false;
    context.client = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listCapabilities: async () => {
        if (denied) throw new Error("Catalog unavailable on OAuth return");
        return { items: [] };
      },
      listConnections: async () => {
        if (denied) throw { status: 403 };
        return [cached];
      },
    } as unknown as OpenGeniBrowserClient;

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => await latest!.refresh());
    expect(latest!.connections).toEqual([cached]);
    denied = true;
    await act(async () => {
      await expect(
        Promise.all([context.client.listCapabilities("workspace-a"), latest!.fetchConnections()]),
      ).rejects.toThrow("Catalog unavailable on OAuth return");
    });
    expect(latest!.connections).toBeNull();
    expect(latest!.connectionsAccessDenied).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });

  test("transient connection refresh failures preserve previously loaded rows", async () => {
    const connection = { id: "cached" } as ConnectionMetadata;
    let failed = false;
    context.client = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listConnections: async () => {
        if (failed) throw new Error("Temporary failure");
        return [connection];
      },
    } as unknown as OpenGeniBrowserClient;

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => await latest!.refresh());
    failed = true;
    await act(async () => await latest!.refresh());
    expect(latest!.connections).toEqual([connection]);
    expect(latest!.connectionsLoadFailed).toBe(true);
    expect(latest!.connectionsAccessDenied).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  test("identifies connection authorization failures without hiding the readable catalog", async () => {
    const item = {
      id: "mail",
      name: "Mail",
      enabled: true,
      runtime: { mcpServerId: "mail" },
      connectionRef: { providerDomain: "example.com" },
    } as CapabilityCatalogItem;
    context.client = {
      ...fakeClient(Promise.resolve({ definitions: [] })),
      listCapabilities: async () => ({ items: [item] }),
      listConnections: async () => {
        throw { status: 403 };
      },
    } as unknown as OpenGeniBrowserClient;

    let latest: ReturnType<typeof useCapabilitiesCatalog> | null = null;
    function Harness() {
      latest = useCapabilitiesCatalog("workspace-a");
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => await latest!.refresh());

    expect(latest!.items).toEqual([item]);
    expect(latest!.loadError).toBeNull();
    expect(latest!.connectionsLoadFailed).toBe(true);
    expect(latest!.connectionsAccessDenied).toBe(true);
    expect(latest!.connections).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

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
    } as unknown as OpenGeniBrowserClient;
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
