import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PluginDiscoveryItem, PluginInstallationSummary } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
let PluginDiscovery: typeof import("./plugin-discovery").PluginDiscovery;
let SlotContext: typeof import("./capability-page-slot").CapabilityPageSlotContext;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix detects DOM availability at module initialization.
  ({ PluginDiscovery } = await import("./plugin-discovery"));
  ({ CapabilityPageSlotContext: SlotContext } = await import("./capability-page-slot"));
});
afterAll(() => GlobalRegistrator.unregister());

const item: PluginDiscoveryItem = {
  id: "openai:research",
  name: "research",
  displayName: "Research suite",
  description: "Research tools",
  longDescription: "Research tools",
  provider: "openai",
  category: "Research category",
  logoUrl: null,
  darkLogoUrl: null,
  sourceUrl: "https://github.com/example/research",
  author: null,
  version: "1.0.0",
  skills: [{ name: "Research", sourceUrl: "https://github.com/example/research/SKILL.md" }],
  mcpServers: [{ name: "Research MCP", endpoint: "https://example.com/mcp", transport: "http" }],
  components: ["skills", "mcp"],
  installation: "available",
};
const installedPlugin: PluginInstallationSummary = {
  pluginKey: "marketplace/openai/research",
  name: item.displayName,
  description: item.description,
  version: "1.0.0",
  category: "Research category",
  tags: [],
  sourceUrl: item.sourceUrl,
  manifestDigest: "a".repeat(64),
  installationVersion: 1,
  componentCount: 2,
  status: "active",
  installedAt: "2026-09-14T00:00:00Z",
  updatedAt: "2026-09-14T00:00:00Z",
};

function client() {
  const calls = {
    discoverPlugins: mock(async () => ({ items: [item], total: 1, nextOffset: null })),
    listCapabilities: mock(async () => ({ items: [] })),
    getInstalledPluginDetails: mock(async () => item),
    previewPlugin: mock(async () => ({
      manifestDigest: "a".repeat(64),
      installationVersion: null,
      components: [
        { key: "skill:research", digest: "b".repeat(64) },
        { key: "mcp:research", digest: "c".repeat(64) },
      ],
    })),
    installPlugin: mock(async () => ({})),
    createCapability: mock(async (_workspaceId: string, input: unknown) => input),
  };
  return { calls, api: calls as unknown as OpenGeniBrowserClient };
}

/** The Capabilities route's page slot: the catalog hides while a page is open. */
function SlotHarness({ children }: { children: ReactNode }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(
    () => ({
      target,
      openKey,
      open: (key: string) => setOpenKey(key),
      close: () => setOpenKey(null),
    }),
    [target, openKey],
  );
  return (
    <SlotContext.Provider value={value}>
      <div hidden={openKey !== null}>{children}</div>
      <div ref={setTarget} />
    </SlotContext.Provider>
  );
}

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<SlotHarness>{node}</SlotHarness>));
  return {
    container,
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(<SlotHarness>{next}</SlotHarness>));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function openDiscovery(container: HTMLElement) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  const row = container.querySelector<HTMLButtonElement>("[data-plugin-id]")!;
  await act(async () => {
    row.focus();
    row.click();
  });
  return row;
}

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-capability-page] button")].find(
    (candidate) => candidate.textContent === label,
  );
}

function page() {
  return document.querySelector("[data-capability-page]");
}

async function back() {
  await act(async () => button("Capabilities")!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

test("plugin opens as a page, goes back to its opener, and is read-only without management authority", async () => {
  const { api, calls } = client();
  const rendered = await render(
    <PluginDiscovery client={api} workspaceId="workspace" query="" onOpenConnection={() => {}} />,
  );
  try {
    const row = await openDiscovery(rendered.container);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(page()?.querySelector("h1")?.textContent).toBe("Research suite");
    expect(page()?.textContent).toContain("Adds 1 skill");
    expect(page()?.textContent).toContain("Connections it needs");
    expect(button("Install plugin")).toBeUndefined();
    expect(button("Connect")).toBeUndefined();
    expect(calls.installPlugin).not.toHaveBeenCalled();
    expect(calls.createCapability).not.toHaveBeenCalled();
    await back();
    expect(page()).toBeNull();
    expect(document.activeElement).toBe(row);
  } finally {
    await rendered.unmount();
  }
});

test("installation stays explicit and digest-bound without authorizing connections", async () => {
  const { api, calls } = client();
  const onChanged = mock(() => {});
  const onOpenConnection = mock(() => {});
  const rendered = await render(
    <PluginDiscovery
      client={api}
      workspaceId="workspace"
      query=""
      canManage
      onChanged={onChanged}
      onOpenConnection={onOpenConnection}
    />,
  );
  try {
    const row = await openDiscovery(rendered.container);
    expect(calls.previewPlugin).not.toHaveBeenCalled();
    expect(calls.installPlugin).not.toHaveBeenCalled();
    await act(async () => button("Install plugin")!.click());
    expect(calls.previewPlugin).toHaveBeenCalledWith("workspace", {
      url: item.sourceUrl,
      bindings: {},
    });
    expect(calls.installPlugin).toHaveBeenCalledWith("workspace", {
      url: item.sourceUrl,
      bindings: {},
      expectedManifestDigest: "a".repeat(64),
      expectedComponents: [
        { key: "skill:research", digest: "b".repeat(64) },
        { key: "mcp:research", digest: "c".repeat(64) },
      ],
      idempotencyKey: expect.any(String),
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(calls.createCapability).not.toHaveBeenCalled();
    expect(onOpenConnection).not.toHaveBeenCalled();
    expect(button("Install plugin")).toBeUndefined();
    expect(page()?.querySelector("[data-slot=status-badge]")?.textContent).toBe("Installed");
    expect(row.querySelector('[data-status="added"]')).not.toBeNull();
    expect(calls.installPlugin).toHaveBeenCalledTimes(1);
    await act(async () => button("Connect")!.click());
    expect(calls.createCapability).toHaveBeenCalledTimes(1);
    expect(onOpenConnection).toHaveBeenCalledTimes(1);
    expect(calls.installPlugin).toHaveBeenCalledTimes(1);
  } finally {
    await rendered.unmount();
  }
});

test("installed rows use the same one-button presentation and discovery does not offer them as new", async () => {
  const { api, calls } = client();
  const onManageInstalled = mock(() => {});
  const rendered = await render(
    <PluginDiscovery
      client={api}
      workspaceId="workspace"
      query=""
      installedPlugins={[installedPlugin]}
      onManageInstalled={onManageInstalled}
    />,
  );
  try {
    const row = rendered.container.querySelector<HTMLButtonElement>(
      ".og-connection-installed button",
    )!;
    expect(row.getAttribute("aria-label")).toContain(installedPlugin.name);
    expect(row.querySelectorAll("button")).toHaveLength(0);
    expect(row.getAttribute("aria-label")).toContain("Installed");
    expect(row.textContent).not.toContain("Research category");
    expect(row.textContent).not.toContain("2");
    await act(async () => {
      row.focus();
      row.click();
    });
    expect(calls.getInstalledPluginDetails).toHaveBeenCalledWith(
      "workspace",
      installedPlugin.pluginKey,
    );
    expect(button("Check for update")).toBeUndefined();
    expect(onManageInstalled).not.toHaveBeenCalled();
    await back();
    await openDiscovery(rendered.container);
    expect(
      rendered.container.querySelector('[data-plugin-id] [data-status="added"]'),
    ).not.toBeNull();
    expect(button("Install plugin")).toBeUndefined();
  } finally {
    await rendered.unmount();
  }
});

test("the web catalog starts with every registry and clears installed badges after removal", async () => {
  const { api, calls } = client();
  const props = { client: api, workspaceId: "removal", query: "", canManage: true };
  const rendered = await render(
    <PluginDiscovery {...props} installedPlugins={[installedPlugin]} />,
  );
  try {
    await act(async () =>
      rendered.container
        .querySelector<HTMLButtonElement>(".og-connection-installed button")!
        .click(),
    );
    await back();
    const row = await openDiscovery(rendered.container);
    expect(calls.discoverPlugins).toHaveBeenLastCalledWith("removal", {
      query: "",
      provider: "",
      offset: 0,
    });
    expect(row.querySelector('[data-status="added"]')).not.toBeNull();
    await back();
    await rendered.rerender(<PluginDiscovery {...props} installedPlugins={[]} />);
    expect(row.querySelector('[data-status="added"]')).toBeNull();
    expect(row.querySelector('[data-status="available"]')).not.toBeNull();
    await act(async () => row.click());
    expect(button("Install plugin")).not.toBeUndefined();
  } finally {
    await rendered.unmount();
  }
});

test("an imported plugin is installed in its details without permanently marking its discovery ID", async () => {
  const { api, calls } = client();
  const plugin = { ...installedPlugin, pluginKey: "custom/research" };
  const props = { client: api, workspaceId: "imported", query: "", canManage: true };
  const rendered = await render(<PluginDiscovery {...props} installedPlugins={[plugin]} />);
  try {
    await act(async () =>
      rendered.container
        .querySelector<HTMLButtonElement>(".og-connection-installed button")!
        .click(),
    );
    expect(calls.getInstalledPluginDetails).toHaveBeenCalledWith("imported", plugin.pluginKey);
    expect(page()?.querySelector("[data-slot=status-badge]")?.textContent).toBe("Installed");
    expect(button("Install plugin")).toBeUndefined();
    expect(calls.installPlugin).not.toHaveBeenCalled();
    // The selected installation must still exist in the authoritative list.
    await rendered.rerender(<PluginDiscovery {...props} installedPlugins={[]} />);
    expect(button("Install plugin")?.disabled).toBe(false);
    await back();
    const row = await openDiscovery(rendered.container);
    expect(row.querySelector('[data-status="added"]')).toBeNull();
    expect(button("Install plugin")?.disabled).toBe(false);
  } finally {
    await rendered.unmount();
  }
});

test("installed attention state remains textual and management uses the exact installation", async () => {
  const { api } = client();
  const plugin = { ...installedPlugin, status: "needs_attention" as const };
  const onManageInstalled = mock(() => {});
  const rendered = await render(
    <PluginDiscovery
      client={api}
      workspaceId="workspace"
      query=" research "
      canManage
      installedPlugins={[plugin]}
      onManageInstalled={onManageInstalled}
    />,
  );
  try {
    const row = rendered.container.querySelector<HTMLButtonElement>(
      ".og-connection-installed button",
    )!;
    expect(row.getAttribute("aria-label")).toContain("Needs attention");
    expect(row.querySelector('[aria-label="Needs attention"]')).not.toBeNull();
    await act(async () => {
      row.focus();
      row.click();
    });
    expect(page()?.querySelector("[data-slot=status-badge]")?.textContent).toBe("Needs attention");
    await act(async () => button("Check for update")!.click());
    expect(onManageInstalled).toHaveBeenCalledWith(plugin, row);
  } finally {
    await rendered.unmount();
  }
});

test("an API install failure says what to do instead of the raw API string", async () => {
  const { api, calls } = client();
  calls.installPlugin.mockImplementation(async () => {
    throw Object.assign(
      new Error("OpenGeni API 409: plugin_manifest_changed Reference: req-plugin-install."),
      { status: 409 },
    );
  });
  const rendered = await render(
    <PluginDiscovery client={api} workspaceId="workspace" query="" canManage />,
  );
  try {
    await openDiscovery(rendered.container);
    await act(async () => button("Install plugin")!.click());
    expect(document.querySelector('[data-capability-page] [role="alert"]')?.textContent).toBe(
      "It changed since this page loaded. Reload the page and try again. Reference: req-plugin-install.",
    );
    expect(document.body.textContent).not.toContain("OpenGeni API");
  } finally {
    await rendered.unmount();
  }
});

test("install errors remain on the page and do not mark discovery as installed", async () => {
  const { api, calls } = client();
  calls.installPlugin.mockImplementation(async () => {
    throw new Error("Manifest changed; preview again.");
  });
  const rendered = await render(
    <PluginDiscovery client={api} workspaceId="workspace" query="" canManage />,
  );
  try {
    const row = await openDiscovery(rendered.container);
    await act(async () => button("Install plugin")!.click());
    expect(document.querySelector('[data-capability-page] [role="alert"]')?.textContent).toBe(
      "Manifest changed; preview again.",
    );
    expect(row.querySelector('[data-status="available"]')).not.toBeNull();
    expect(button("Install plugin")?.disabled).toBe(false);
  } finally {
    await rendered.unmount();
  }
});
