import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import type { AccessContext, CapabilityCatalogItem, ConnectionMetadata } from "@/types";
import type { ComposerPlusProps } from "@/components/composer-mobile-plus";

let composer: ComposerPlusProps | null = null;
const context: {
  client: OpenGeniBrowserClient;
  accessContext: AccessContext | null;
  refreshWorkspaceMcpServers: (workspaceId: string) => Promise<void>;
} = {
  client: {} as OpenGeniBrowserClient,
  accessContext: {
    mode: "managed",
    subjectId: "user-a",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: "workspace-a",
        accountId: "account-a",
        subjectId: "user-a",
        permissions: ["connections:read"],
      },
    ],
    defaultAccountId: "account-a",
    defaultWorkspaceId: "workspace-a",
  },
  refreshWorkspaceMcpServers: async () => {},
};

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@/components/composer-mobile-plus", () => ({
  ComposerMobilePlus: (props: ComposerPlusProps) => {
    composer = props;
    return null;
  },
}));
mock.module("sonner", () => ({ toast: { error: () => {}, success: () => {} } }));

const { WorkspaceComposerPlus } = await import("./workspace-composer-plus");

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("same-client grant loss masks composer status before old responses; restoration needs a fresh read", async () => {
  const entry = {
    id: "mcp:slack",
    name: "Slack",
    kind: "mcp",
    enabled: true,
    runtime: { available: true, mcpServerId: "slack" },
    lifecycle: { readiness: "ready" },
    connectionRef: { connectionId: "connection-1", providerDomain: "slack.com", kind: "oauth2" },
  } as CapabilityCatalogItem;
  const cached = {
    id: "connection-1",
    providerDomain: "slack.com",
    subjectId: null,
    status: "active",
  } as ConnectionMetadata;
  const fresh = { ...cached, status: "needs_reauth" } as ConnectionMetadata;
  const allowed = context.accessContext!;
  const withoutRead = {
    ...allowed,
    workspaceGrants: [{ ...allowed.workspaceGrants[0]!, permissions: ["sessions:create"] }],
  } as AccessContext;
  for (const oldResult of ["success", "403", "503"] as const) {
    const stale = deferred<ConnectionMetadata[]>();
    const restored = deferred<ConnectionMetadata[]>();
    let reads = 0;
    context.accessContext = allowed;
    context.client = {
      listCapabilities: async () => ({ items: [entry] }),
      listConnections: () => {
        reads++;
        return reads === 1
          ? Promise.resolve([cached])
          : reads === 2
            ? stale.promise
            : restored.promise;
      },
      catalogAssetUrl: () => null,
    } as unknown as OpenGeniBrowserClient;
    let sendCalls = 0;
    const props = {
      workspaceId: "workspace-a",
      servers: [
        { id: "slack", name: "Slack", detail: "Workspace connection", connectionStatus: "ready" },
      ],
      firstPartyTools: [],
      fileUploadsEnabled: false,
      onToolSelectionChange: () => {
        sendCalls++;
      },
    } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
    expect(composer!.servers[0]?.connectionStatus).toBe("ready");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(reads).toBe(2);

    context.accessContext = withoutRead;
    await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
    expect(reads).toBe(2);
    expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
    expect(composer!.servers[0]?.detail).toBeUndefined();
    expect(composer!.connectorActions?.error).toContain("doesn't allow connection discovery");
    // Connection discovery denial does not disable normal member composition.
    expect(composer!.disabled).not.toBe(true);
    composer!.onToolSelectionChange({} as ComposerPlusProps["selection"]);
    expect(sendCalls).toBe(1);

    context.accessContext = allowed;
    await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
    expect(reads).toBe(3);
    expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
    await act(async () => {
      if (oldResult === "success") stale.resolve([cached]);
      else stale.reject({ status: Number(oldResult) });
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).not.toBe("ready");
    await act(async () => {
      restored.resolve([fresh]);
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("reconnect");
    await act(async () => root.unmount());
    container.remove();
  }
  context.accessContext = allowed;
});

test("composer treats bootstrapping as unknown and accepts an admin read grant", async () => {
  const allowed = context.accessContext!;
  let reads = 0;
  context.accessContext = null;
  context.client = {
    listCapabilities: async () => ({ items: [] }),
    listConnections: async () => {
      reads++;
      return [];
    },
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const props = {
    workspaceId: "workspace-a",
    servers: [],
    firstPartyTools: [],
    fileUploadsEnabled: false,
    onToolSelectionChange: () => {},
  } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(reads).toBe(0);
  expect(composer!.connectorActions?.error).toBeNull();
  context.accessContext = {
    ...allowed,
    workspaceGrants: [{ ...allowed.workspaceGrants[0]!, permissions: ["workspace:admin"] }],
  };
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(reads).toBe(1);
  expect(composer!.connectorActions?.error).toBeNull();
  await act(async () => root.unmount());
  container.remove();
  context.accessContext = allowed;
});

test("a catalog failure and connection 403 mask cached composer account status", async () => {
  const entry = {
    id: "mcp:slack",
    name: "Slack",
    kind: "mcp",
    enabled: true,
    runtime: { available: true, mcpServerId: "slack" },
    lifecycle: { readiness: "ready" },
    connectionRef: { connectionId: "connection-1", providerDomain: "slack.com", kind: "oauth2" },
  } as CapabilityCatalogItem;
  const connection = {
    id: "connection-1",
    providerDomain: "slack.com",
    subjectId: null,
    status: "active",
  } as ConnectionMetadata;
  let failure: "none" | "transient" | "denied" = "none";
  context.client = {
    listCapabilities: async () => {
      if (failure !== "none") throw new Error("Catalog unavailable");
      return { items: [entry] };
    },
    listConnections: async () => {
      if (failure === "transient") throw new Error("Connections unavailable");
      if (failure === "denied") throw { status: 403 };
      return [connection];
    },
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;

  const props = {
    workspaceId: "workspace-a",
    servers: [],
    firstPartyTools: [],
    fileUploadsEnabled: false,
    onToolSelectionChange: () => {},
  } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");

  failure = "transient";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Bun.sleep(0);
  });
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");
  expect(composer!.connectorActions?.error).toBe("Catalog unavailable");

  failure = "denied";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Bun.sleep(0);
  });
  expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
  expect(composer!.connectorActions?.error).toContain("doesn't allow connection discovery");

  await act(async () => root.unmount());
  container.remove();
});

async function concurrentComposerReads(order: "late-denial" | "later-success" | "stale-success") {
  const entry = {
    id: "mcp:slack",
    name: "Slack",
    kind: "mcp",
    enabled: true,
    runtime: { available: true, mcpServerId: "slack" },
    lifecycle: { readiness: "ready" },
    connectionRef: { connectionId: "connection-1", providerDomain: "slack.com", kind: "oauth2" },
  } as CapabilityCatalogItem;
  const connection = {
    id: "connection-1",
    providerDomain: "slack.com",
    subjectId: null,
    status: "active",
  } as ConnectionMetadata;
  const first = deferred<ConnectionMetadata[]>();
  const second = deferred<ConnectionMetadata[]>();
  const third = deferred<ConnectionMetadata[]>();
  let calls = 0;
  context.client = {
    listCapabilities: async () => {
      if (calls > 1 && !(order === "later-success" && calls >= 3))
        throw new Error("Catalog unavailable");
      return { items: [entry] };
    },
    listConnections: async () => {
      calls++;
      return calls === 1
        ? [connection]
        : calls === 2
          ? first.promise
          : calls === 3
            ? second.promise
            : third.promise;
    },
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const props = {
    workspaceId: "workspace-a",
    servers: [],
    firstPartyTools: [],
    fileUploadsEnabled: false,
    onToolSelectionChange: () => {},
  } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(calls).toBe(3);

  if (order === "late-denial") {
    await act(async () => {
      second.reject({ status: 503 });
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("ready");
    await act(async () => {
      first.reject({ status: 403 });
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
    expect(composer!.connectorActions?.error).toContain("doesn't allow connection discovery");
    // A later transient failure cannot unset the denial either.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      third.reject({ status: 503 });
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
    expect(composer!.connectorActions?.error).toContain("doesn't allow connection discovery");
  } else if (order === "later-success") {
    await act(async () => {
      first.reject({ status: 403 });
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
    await act(async () => {
      second.resolve([connection]);
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("ready");
    expect(composer!.connectorActions?.error).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      third.reject({ status: 503 });
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("ready");
  } else {
    await act(async () => {
      second.reject({ status: 403 });
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
    await act(async () => {
      first.resolve([connection]);
      await Bun.sleep(0);
    });
    expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
    expect(composer!.connectorActions?.error).toContain("doesn't allow connection discovery");
  }
  await act(async () => root.unmount());
  container.remove();
}

test("composer retires cached rows when an older 403 arrives after a newer 503", async () => {
  await concurrentComposerReads("late-denial");
});

test("composer restores rows only after a newer successful connection read", async () => {
  await concurrentComposerReads("later-success");
});

test("an older composer success cannot restore access after a newer 403", async () => {
  await concurrentComposerReads("stale-success");
});

test("a late denial from a replaced client cannot mask the current composer", async () => {
  const stale = deferred<ConnectionMetadata[]>();
  const entry = {
    id: "mcp:slack",
    name: "Slack",
    kind: "mcp",
    enabled: true,
    runtime: { available: true, mcpServerId: "slack" },
    lifecycle: { readiness: "ready" },
    connectionRef: { connectionId: "connection-1", providerDomain: "slack.com", kind: "oauth2" },
  } as CapabilityCatalogItem;
  const connection = {
    id: "connection-1",
    providerDomain: "slack.com",
    subjectId: null,
    status: "active",
  } as ConnectionMetadata;
  const oldClient = {
    listCapabilities: async () => ({ items: [entry] }),
    listConnections: async () => stale.promise,
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const newClient = {
    listCapabilities: async () => ({ items: [entry] }),
    listConnections: async () => [connection],
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const props = {
    workspaceId: "workspace-a",
    servers: [],
    firstPartyTools: [],
    fileUploadsEnabled: false,
    onToolSelectionChange: () => {},
  } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  context.client = oldClient;
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  context.client = newClient;
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");
  await act(async () => {
    stale.reject({ status: 403 });
    await Bun.sleep(0);
  });
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");
  expect(composer!.connectorActions?.error).toBeNull();
  await act(async () => root.unmount());
  container.remove();
});

test("A -> B -> A masks cached composer status before the new A read and fences old requests", async () => {
  const entry = {
    id: "mcp:slack",
    name: "Slack",
    kind: "mcp",
    enabled: true,
    runtime: { available: true, mcpServerId: "slack" },
    lifecycle: { readiness: "ready" },
    connectionRef: { connectionId: "connection-1", providerDomain: "slack.com", kind: "oauth2" },
  } as CapabilityCatalogItem;
  const connection = {
    id: "connection-1",
    providerDomain: "slack.com",
    subjectId: null,
    status: "active",
  } as ConnectionMetadata;
  const staleA = deferred<ConnectionMetadata[]>();
  const freshA = deferred<ConnectionMetadata[]>();
  const staleB = deferred<ConnectionMetadata[]>();
  let aReads = 0;
  const clientA = {
    listCapabilities: async () => ({ items: [entry] }),
    listConnections: async () => {
      aReads++;
      return aReads === 1 ? [connection] : aReads === 2 ? staleA.promise : freshA.promise;
    },
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const clientB = {
    listCapabilities: async () => ({ items: [entry] }),
    listConnections: async () => staleB.promise,
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const props = {
    workspaceId: "workspace-a",
    servers: [],
    firstPartyTools: [],
    fileUploadsEnabled: false,
    onToolSelectionChange: () => {},
  } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  context.client = clientA;
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(aReads).toBe(2);

  context.client = clientB;
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(composer!.servers[0]?.connectionStatus).toBeUndefined();
  context.client = clientA;
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(aReads).toBe(3);
  expect(composer!.servers[0]?.connectionStatus).toBeUndefined();

  await act(async () => {
    staleA.resolve([connection]);
    staleB.reject({ status: 403 });
    await Bun.sleep(0);
  });
  expect(composer!.servers[0]?.connectionStatus).toBeUndefined();
  expect(composer!.connectorActions?.error).toBeNull();
  await act(async () => {
    freshA.resolve([connection]);
    await Bun.sleep(0);
  });
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");
  await act(async () => root.unmount());
  container.remove();
});

test("a new identity's transient connection failure does not inherit another identity's denial", async () => {
  const clientA = {
    listCapabilities: async () => ({ items: [] }),
    listConnections: async () => {
      throw { status: 403 };
    },
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const clientB = {
    listCapabilities: async () => ({ items: [] }),
    listConnections: async () => {
      throw { status: 503 };
    },
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const props = {
    workspaceId: "workspace-a",
    servers: [],
    firstPartyTools: [],
    fileUploadsEnabled: false,
    onToolSelectionChange: () => {},
  } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  context.client = clientA;
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(composer!.connectorActions?.error).toContain("doesn't allow connection discovery");
  context.client = clientB;
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(composer!.connectorActions?.error).toContain("couldn't be checked");
  expect(composer!.connectorActions?.error).not.toContain("doesn't allow connection discovery");
  await act(async () => root.unmount());
  container.remove();
});

test("a pending OAuth start cannot redirect after a connection 403, even after a newer successful read", async () => {
  const allowed = context.accessContext!;
  const entry = {
    id: "mcp:slack",
    name: "Slack",
    kind: "mcp",
    enabled: true,
    runtime: { available: true, mcpServerId: "slack" },
    lifecycle: { readiness: "ready" },
    connectionRef: {
      connectionId: "connection-1",
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectScope: "workspace",
    },
  } as CapabilityCatalogItem;
  const connection = {
    id: "connection-1",
    providerDomain: "slack.com",
    subjectId: null,
    status: "needs_reauth",
  } as ConnectionMetadata;
  const oldStart = deferred<{ authorizationUrl: string }>();
  const preRevocationStart = deferred<{ authorizationUrl: string }>();
  let reads = 0;
  let starts = 0;
  context.client = {
    listCapabilities: async () => ({ items: [entry] }),
    listConnections: async () => {
      reads++;
      if (reads === 2) throw { status: 403 };
      return [connection];
    },
    startConnectionOAuth: async () => {
      starts++;
      return starts === 1
        ? oldStart.promise
        : starts === 3
          ? preRevocationStart.promise
          : { authorizationUrl: "https://provider.example/new" };
    },
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;
  const props = {
    workspaceId: "workspace-a",
    servers: [],
    firstPartyTools: [],
    fileUploadsEnabled: false,
    onToolSelectionChange: () => {},
  } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const redirect = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    context.accessContext = allowed;
    await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
    expect(composer!.servers[0]?.connectionStatus).toBe("reconnect");
    await act(async () => composer!.connectorActions?.onReconnect?.("slack"));
    expect(starts).toBe(1);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(composer!.connectorActions?.error).toContain("doesn't allow connection discovery");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(composer!.servers[0]?.connectionStatus).toBe("reconnect");
    await act(async () => {
      oldStart.resolve({ authorizationUrl: "https://provider.example/stale" });
      await Bun.sleep(0);
    });
    expect(redirect).not.toHaveBeenCalled();
    await act(async () => composer!.connectorActions?.onReconnect?.("slack"));
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("https://provider.example/new");
    await act(async () => composer!.connectorActions?.onReconnect?.("slack"));
    expect(starts).toBe(3);
    context.accessContext = {
      ...allowed,
      workspaceGrants: [{ ...allowed.workspaceGrants[0]!, permissions: ["sessions:create"] }],
    };
    await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
    context.accessContext = allowed;
    await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
    await act(async () => {
      preRevocationStart.resolve({ authorizationUrl: "https://provider.example/old-grant" });
      await Bun.sleep(0);
    });
    expect(redirect).toHaveBeenCalledTimes(1);
  } finally {
    context.accessContext = allowed;
    redirect.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  }
});
