import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PluginDiscoveryItem, PluginInstallationSummary } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
let PluginDiscovery: typeof import("./plugin-discovery").PluginDiscovery;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix detects DOM availability at module initialization.
  ({ PluginDiscovery } = await import("./plugin-discovery"));
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

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(next));
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
  return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (candidate) => candidate.textContent === label,
  );
}

test("plugin opens in the shared centered dialog, closes to its opener, and is read-only without management authority", async () => {
  const { api, calls } = client();
  const rendered = await render(
    <PluginDiscovery client={api} workspaceId="workspace" query="" onOpenConnection={() => {}} />,
  );
  try {
    const row = await openDiscovery(rendered.container);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
    expect(dialog.className).toContain("sm:max-w-[42rem]");
    expect(dialog.className).toContain("sm:top-1/2");
    expect(dialog.querySelectorAll("h2:not(.sr-only)")).toHaveLength(1);
    expect(button("Install plugin")).toBeUndefined();
    expect(button("Connect")).toBeUndefined();
    expect(calls.installPlugin).not.toHaveBeenCalled();
    expect(calls.createCapability).not.toHaveBeenCalled();
    await act(async () => button("Close")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
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
    expect(button("Installed")?.disabled).toBe(true);
    expect(row.querySelector('[data-status="added"]')).not.toBeNull();
    await act(async () => button("Installed")!.click());
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
    expect(button("Manage installation")).toBeUndefined();
    expect(onManageInstalled).not.toHaveBeenCalled();
    await act(async () => button("Close")!.click());
    await openDiscovery(rendered.container);
    expect(
      rendered.container.querySelector('[data-plugin-id] [data-status="added"]'),
    ).not.toBeNull();
    expect(button("Install plugin")).toBeUndefined();
  } finally {
    await rendered.unmount();
  }
});

test("the web catalog starts with OpenAI and clears installed badges after removal", async () => {
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
    await act(async () => button("Close")!.click());
    const row = await openDiscovery(rendered.container);
    expect(calls.discoverPlugins).toHaveBeenLastCalledWith("removal", {
      query: "",
      provider: "openai",
      offset: 0,
    });
    expect(row.querySelector('[data-status="added"]')).not.toBeNull();
    await act(async () => button("Close")!.click());
    await rendered.rerender(<PluginDiscovery {...props} installedPlugins={[]} />);
    expect(row.querySelector('[data-status="added"]')).toBeNull();
    expect(row.querySelector('[data-status="available"]')).not.toBeNull();
    await act(async () => row.click());
    expect(button("Install plugin")).not.toBeUndefined();
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
    expect(button("Installed")?.disabled).toBe(true);
    await act(async () => button("Manage installation")!.click());
    expect(onManageInstalled).toHaveBeenCalledWith(plugin, row);
  } finally {
    await rendered.unmount();
  }
});

test("install errors remain in the dialog and do not mark discovery as installed", async () => {
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
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      "Manifest changed; preview again.",
    );
    expect(row.querySelector('[data-status="available"]')).not.toBeNull();
    expect(button("Install plugin")?.disabled).toBe(false);
  } finally {
    await rendered.unmount();
  }
});
