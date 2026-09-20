import { expect, test } from "bun:test";
import { ConnectController, type ConnectProvider, type ConnectTransport } from "@opengeni/connect";
import type { CapabilityCatalogItem, OpenGeniClient } from "@opengeni/sdk";
import { ConnectionDiscovery } from "../src/connection-discovery";
import { actRun, registerDom, renderComponent } from "./render-hook";

registerDom();

const outlook: ConnectProvider = {
  id: "microsoft-outlook-mail",
  label: "Outlook Mail",
  family: "microsoft",
  readiness: "available",
  ownership: ["personal", "workspace"],
  setup: ["oauth"],
};
const gmail = {
  id: "gmail",
  name: "Gmail",
  kind: "mcp",
  authKind: "oauth2",
  mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
} as CapabilityCatalogItem;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function controller(catalog: ConnectTransport["catalog"] = async () => [outlook]) {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected mutation");
  };
  return new ConnectController(
    {
      catalog,
      accounts: async () => [],
      pending: async () => [],
      begin: unexpected,
      advance: unexpected,
      get: unexpected,
      cancel: unexpected,
      disconnect: unexpected,
    },
    "workspace",
  );
}
function client(
  listCapabilities: OpenGeniClient["listCapabilities"] = async () => ({
    items: [gmail],
    installations: [],
  }),
) {
  return { listCapabilities, listConnections: async () => [] } as unknown as OpenGeniClient;
}
function discovery(api: OpenGeniClient, connect: ConnectController) {
  return (
    <ConnectionDiscovery
      client={api}
      controller={connect}
      workspaceId="workspace"
      returnUrl="https://host.example/return"
    />
  );
}

test("Outlook remains selectable while MCP discovery stalls", async () => {
  const pending = deferred<Awaited<ReturnType<OpenGeniClient["listCapabilities"]>>>();
  const connect = controller();
  const view = await renderComponent(
    discovery(
      client(() => pending.promise),
      connect,
    ),
  );
  try {
    expect(view.container.textContent).toContain("Outlook Mail");
    expect(view.container.textContent).not.toContain("No services match");
    const row = [...view.container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Outlook Mail"),
    )!;
    await actRun(() => row.click());
    expect(view.container.textContent).toContain("Who can use this connection?");
  } finally {
    await view.unmount();
    connect.dispose();
  }
});

for (const synchronous of [false, true]) {
  test(`MCP failure (${synchronous ? "sync" : "async"}) preserves providers and retry restores catalog`, async () => {
    let failed = true;
    const api = client(() => {
      if (!failed) return Promise.resolve({ items: [gmail], installations: [] });
      if (synchronous) throw new Error("Private transport detail");
      return Promise.reject(new Error("Private transport detail"));
    });
    const connect = controller();
    const view = await renderComponent(discovery(api, connect));
    try {
      expect(view.container.textContent).toContain("Outlook Mail");
      expect(view.container.textContent).toContain("Some services could not be loaded");
      expect(view.container.textContent).not.toContain("Private transport detail");
      expect(view.container.textContent).not.toContain("No services match");
      failed = false;
      await actRun(() =>
        [...view.container.querySelectorAll("button")]
          .find((node) => node.textContent === "Retry")!
          .click(),
      );
      expect(view.container.textContent).toContain("Gmail");
      expect(view.container.textContent).toContain("Outlook Mail");
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await view.unmount();
      connect.dispose();
    }
  });

  test(`provider failure (${synchronous ? "sync" : "async"}) preserves MCP services`, async () => {
    const connect = controller(() => {
      if (synchronous) throw new Error("Private transport detail");
      return Promise.reject(new Error("Private transport detail"));
    });
    const view = await renderComponent(discovery(client(), connect));
    try {
      expect(view.container.textContent).toContain("Gmail");
      expect(view.container.textContent).toContain("Some services could not be loaded");
      expect(view.container.textContent).not.toContain("Private transport detail");
    } finally {
      await view.unmount();
      connect.dispose();
    }
  });
}

test("pending providers do not show a premature empty result", async () => {
  const pending = deferred<ConnectProvider[]>();
  const connect = controller(() => pending.promise);
  const view = await renderComponent(
    discovery(
      client(async () => ({ items: [], installations: [] })),
      connect,
    ),
  );
  try {
    expect(view.container.textContent).not.toContain("No services match");
    expect(view.container.querySelector('[aria-label="Loading services"]')).not.toBeNull();
    await actRun(() => pending.resolve([]));
    expect(view.container.textContent).toContain("No services match");
    expect(view.container.querySelector('[aria-label="Loading services"]')).toBeNull();
  } finally {
    await view.unmount();
    connect.dispose();
  }
});

test("actor replacement aborts provider reads and ignores late catalogs from either source", async () => {
  const oldProviders = deferred<ConnectProvider[]>();
  const oldCatalog = deferred<Awaited<ReturnType<OpenGeniClient["listCapabilities"]>>>();
  let oldSignal: AbortSignal | undefined;
  const previous = controller((_workspace, options) => {
    oldSignal = options?.signal;
    return oldProviders.promise;
  });
  const current = controller(async () => []);
  const view = await renderComponent(
    discovery(
      client(() => oldCatalog.promise),
      previous,
    ),
  );
  try {
    await view.rerender(
      discovery(
        client(async () => ({ items: [], installations: [] })),
        current,
      ),
    );
    expect(oldSignal?.aborted).toBe(true);
    await actRun(() => {
      oldProviders.resolve([{ ...outlook, label: "Old private provider" }]);
      oldCatalog.resolve({ items: [{ ...gmail, name: "Old private catalog" }], installations: [] });
    });
    expect(view.container.textContent).not.toContain("Old private");
    expect(view.container.textContent).toContain("No services match");
  } finally {
    await view.unmount();
    previous.dispose();
    current.dispose();
  }
});
