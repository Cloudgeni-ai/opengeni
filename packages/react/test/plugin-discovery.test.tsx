import { expect, mock, test } from "bun:test";
import type { PluginDiscoveryItem } from "@opengeni/sdk";
import { PluginDiscovery } from "../src/plugin-discovery";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const item: PluginDiscoveryItem = {
  id: "openai:research",
  name: "research",
  displayName: "Research-suite",
  description: "Research tools",
  longDescription: "Research tools",
  provider: "openai",
  category: "Hidden category",
  logoUrl: null,
  darkLogoUrl: null,
  sourceUrl: "https://github.com/example/research",
  author: null,
  version: "1.0.0",
  skills: [],
  mcpServers: [],
  components: ["skills", "mcp"],
  installation: "available",
};

test("plugin discovery uses one full-row action without catalog metadata and updates installed state", async () => {
  const client = {
    discoverPlugins: mock(async () => ({ items: [item], total: 1, nextOffset: null })),
  };
  const onOpen = mock(() => {});
  const props = { client, workspaceId: "workspace", query: "", onOpen };
  const rendered = await renderComponent(<PluginDiscovery {...props} />);
  try {
    await flush(250);
    const row = rendered.container.querySelector<HTMLButtonElement>(
      '[data-plugin-id="openai:research"]',
    )!;
    expect(row.classList.contains("og-capability-catalog-row")).toBe(true);
    expect(row.querySelectorAll("button")).toHaveLength(0);
    expect(row.querySelector("strong")?.textContent).toBe("Research suite");
    expect(row.querySelector(".og-connection-logo svg")).not.toBeNull();
    expect(row.querySelector('[data-status="available"] svg')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(row.textContent).not.toContain("registry");
    expect(row.textContent).not.toContain("Hidden category");
    expect(row.textContent).not.toContain("skills");
    expect(rendered.container.querySelector('[aria-label="Plugin registry"]')).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    await actRun(() => row.click());
    expect(onOpen).toHaveBeenCalledWith(item);
    await rendered.rerender(<PluginDiscovery {...props} installedIds={new Set([item.id])} />);
    expect(row.querySelector('[data-status="added"]')).not.toBeNull();
    expect(row.querySelector('[data-status="available"]')).toBeNull();
    expect(client.discoverPlugins).toHaveBeenCalledTimes(1);
    await actRun(() => row.click());
    expect(onOpen).toHaveBeenCalledTimes(2);
  } finally {
    await rendered.unmount();
  }
});

test("plugin discovery preserves loading, retry, and registry filters", async () => {
  let fail = true;
  const client = {
    discoverPlugins: mock(async () => {
      if (fail) throw new Error("Unavailable");
      return { items: [item], total: 1, nextOffset: null };
    }),
  };
  const rendered = await renderComponent(
    <PluginDiscovery client={client} workspaceId="workspace" query="research" onOpen={() => {}} />,
  );
  try {
    expect(rendered.container.textContent).toContain("Loading plugins…");
    await flush(250);
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load plugins.",
    );
    fail = false;
    await actRun(() =>
      rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await flush(250);
    expect(rendered.container.querySelector("[data-plugin-id]")).not.toBeNull();
    await actRun(() =>
      [
        ...rendered.container.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Plugin registry"] button',
        ),
      ]
        .find((button) => button.textContent === "Anthropic plugin registry")!
        .click(),
    );
    await flush(250);
    expect(client.discoverPlugins).toHaveBeenLastCalledWith("workspace", {
      query: "research",
      provider: "anthropic",
      offset: 0,
    });
  } finally {
    await rendered.unmount();
  }
});

test("overview limits plugins to six and delegates View all without fetching another page", async () => {
  const client = {
    discoverPlugins: mock(async () => ({
      items: Array.from({ length: 10 }, (_, i) => ({ ...item, id: String(i) })),
      total: 100,
      nextOffset: 10,
    })),
  };
  const more = mock(() => {});
  const view = await renderComponent(
    <PluginDiscovery
      client={client}
      workspaceId="overview"
      query=""
      onOpen={() => {}}
      resultLimit={6}
      onShowMore={more}
    />,
  );
  try {
    await flush(250);
    expect(view.container.querySelectorAll(".og-capability-catalog-row")).toHaveLength(6);
    expect(view.container.querySelector("h3")?.textContent).toBe("Plugins");
    expect(view.container.querySelector('[aria-label="Plugin registry"]')).toBeNull();
    const button = view.container.querySelector<HTMLButtonElement>(".og-catalog-more")!;
    await actRun(() => button.click());
    expect(more).toHaveBeenCalledTimes(1);
    expect(client.discoverPlugins).toHaveBeenCalledTimes(1);
  } finally {
    await view.unmount();
  }
});
