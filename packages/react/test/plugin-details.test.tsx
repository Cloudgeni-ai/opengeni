import { expect, mock, test } from "bun:test";
import type { PluginDiscoveryItem } from "@opengeni/sdk";
import { PluginDetails } from "../src/plugin-details";
import { actRun, registerDom, renderComponent } from "./render-hook";

registerDom();

const item: PluginDiscoveryItem = {
  id: "openai:research",
  name: "research",
  displayName: "Research suite",
  description: "Research tools for your workspace.",
  longDescription: "Research tools for your workspace.",
  provider: "openai",
  category: "research",
  logoUrl: "https://example.com/logo.svg",
  darkLogoUrl: null,
  sourceUrl: "https://github.com/example/research",
  author: { name: "Example" },
  version: "1.0.0",
  skills: [{ name: "Research", sourceUrl: "https://github.com/example/research/SKILL.md" }],
  mcpServers: [{ name: "Research MCP", transport: "http", endpoint: "https://example.com/mcp" }],
  components: ["skills", "mcp", "hooks"],
  installation: "available",
};

test("plugin detail shares the logo treatment and keeps one visible title", async () => {
  const rendered = await renderComponent(<PluginDetails item={item} />);
  try {
    expect(rendered.container.querySelectorAll("h2")).toHaveLength(1);
    expect(rendered.container.querySelector("h2")?.textContent).toBe(item.displayName);
    expect(rendered.container.querySelector(".og-connection-logo img")).not.toBeNull();
    await actRun(() => rendered.container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(rendered.container.querySelector(".og-connection-logo svg")).not.toBeNull();
    expect(rendered.container.textContent).toContain("Not installed here: Hooks");
    expect(rendered.container.querySelector(".og-plugin-install")).toBeNull();
    expect(
      [...rendered.container.querySelectorAll("button")].some(
        (button) => button.textContent === "Connect",
      ),
    ).toBe(false);
  } finally {
    await rendered.unmount();
  }
});

test("install and authorization remain explicit, independent actions", async () => {
  const onInstall = mock(() => {});
  const onConnect = mock(() => {});
  const rendered = await renderComponent(
    <PluginDetails item={item} onInstall={onInstall} onConnect={onConnect} />,
  );
  try {
    expect(onInstall).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    await actRun(() =>
      rendered.container.querySelector<HTMLButtonElement>(".og-plugin-install")!.click(),
    );
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onConnect).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Connect each server separately.");
    await actRun(() =>
      [...rendered.container.querySelectorAll("button")]
        .find((button) => button.textContent === "Connect")!
        .click(),
    );
    expect(onConnect).toHaveBeenCalledWith(item.mcpServers![0]);
  } finally {
    await rendered.unmount();
  }
});

test("installed and busy states prevent duplicate installation and busy connection actions", async () => {
  const onInstall = mock(() => {});
  const onConnect = mock(() => {});
  const rendered = await renderComponent(
    <PluginDetails
      item={item}
      onInstall={onInstall}
      onConnect={onConnect}
      busy
      error="Installation failed"
    />,
  );
  try {
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Installation failed",
    );
    expect(
      [...rendered.container.querySelectorAll("button")].every((button) => button.disabled),
    ).toBe(true);
    expect(rendered.container.querySelector(".og-plugin-install")?.textContent).toBe("Installing…");
    await rendered.rerender(
      <PluginDetails
        item={item}
        onInstall={onInstall}
        onConnect={onConnect}
        installed
        connections={{ "https://example.com/mcp": true }}
      />,
    );
    const install = rendered.container.querySelector<HTMLButtonElement>(".og-plugin-install")!;
    expect(install.textContent).toBe("Installed");
    expect(install.disabled).toBe(true);
    await actRun(() => install.click());
    expect(onInstall).not.toHaveBeenCalled();
    expect(
      [...rendered.container.querySelectorAll("button")].some(
        (button) => button.textContent === "Manage" && !button.disabled,
      ),
    ).toBe(true);
  } finally {
    await rendered.unmount();
  }
});

test("unindexed, empty, unsupported-only, and oversized plugins cannot install", async () => {
  const unsupported = [
    { name: "Local", transport: "stdio", endpoint: null },
    { name: "SSE", transport: "sse", endpoint: "https://example.com/events" },
    { name: "Custom", transport: "http", endpoint: "https://example.com/{key}" },
    { name: "Insecure", transport: "http", endpoint: "http://example.com/mcp" },
  ];
  for (const overrides of [
    { skills: null },
    { mcpServers: null },
    { skills: [], mcpServers: [] },
    { skills: [], mcpServers: unsupported },
    {
      skills: Array.from({ length: 65 }, (_, index) => ({
        name: `Skill ${index}`,
        sourceUrl: `https://example.com/${index}`,
      })),
    },
  ]) {
    const rendered = await renderComponent(
      <PluginDetails item={{ ...item, ...overrides }} onInstall={() => {}} onConnect={() => {}} />,
    );
    try {
      expect(
        rendered.container.querySelector<HTMLButtonElement>(".og-plugin-install")?.disabled,
      ).toBe(true);
      if (overrides.mcpServers === unsupported) {
        expect(
          rendered.container.querySelectorAll(".og-plugin-server-heading button"),
        ).toHaveLength(0);
        for (const reason of [
          "Requires a local runtime",
          "Unsupported transport: sse",
          "Requires custom connection configuration",
          "Requires a valid HTTPS endpoint",
        ]) {
          expect(rendered.container.textContent).toContain(reason);
        }
      }
    } finally {
      await rendered.unmount();
    }
  }
});

test("existing connections remain manageable even when source requirements are unsupported", async () => {
  const rendered = await renderComponent(
    <PluginDetails
      item={{
        ...item,
        mcpServers: [{ name: "Existing", transport: "sse", endpoint: "https://example.com/mcp" }],
      }}
      connections={{ "https://example.com/mcp": true }}
      onConnect={() => {}}
    />,
  );
  try {
    expect(rendered.container.querySelector(".og-plugin-server-heading button")?.textContent).toBe(
      "Manage",
    );
    expect(rendered.container.textContent).not.toContain("Unsupported transport");
  } finally {
    await rendered.unmount();
  }
});
