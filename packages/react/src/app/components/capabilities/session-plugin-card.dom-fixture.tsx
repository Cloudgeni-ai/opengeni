// Run explicitly through session-plugin-card.test.tsx so Radix sees the DOM at import time.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

import type { AuthNeededItem } from "../../../timeline";

const plugin = {
  id: "anthropic:sentry",
  provider: "anthropic",
  name: "sentry",
  displayName: "sentry",
  description: "Triage Sentry errors from your agent.",
  category: "Monitoring",
  sourceUrl: "https://github.com/example/plugins/tree/main/sentry",
  logoUrl: null,
  author: { name: "Sentry" },
  skills: [
    {
      name: "triage-errors",
      description: "Triage the newest errors.",
      sourceUrl: "https://github.com/example/plugins/tree/main/sentry/skills/triage-errors",
    },
  ],
  mcpServers: [],
};
let installedKeys: string[] = [];
const discoverPlugins = mock(async (_workspaceId: string, _input: { id: string }) => ({
  items: [plugin],
}));
const listInstalledPlugins = mock(async () => ({
  plugins: installedKeys.map((pluginKey) => ({ pluginKey })),
}));
const previewPlugin = mock(async () => ({
  manifestDigest: "digest",
  components: [{ key: "skill:triage-errors", digest: "c1" }],
  installationVersion: null,
}));
const installPlugin = mock(async (_workspaceId: string, _input: Record<string, unknown>) => ({
  ok: true,
}));
const continueAfterCapabilitySetup = mock(
  async (_workspaceId: string, _sessionId: string, _input: { capabilityId: string }) => ({}),
);
const everyone = ["sessions:control", "capabilities:manage"];
const context = {
  client: {
    discoverPlugins,
    listInstalledPlugins,
    previewPlugin,
    installPlugin,
    continueAfterCapabilitySetup,
  },
  accessContext: {
    subjectId: "member",
    workspaceGrants: [{ workspaceId: "workspace", permissions: everyone }],
  },
  workspaces: [{ id: "workspace", kind: "shared" }],
  workspaceCapabilityCatalog: [],
};
mock.module("../../app-context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
GlobalRegistrator.register();
const { createRoot } = await import("react-dom/client");
const { SessionCapabilityCard } = await import("./session-capability-card");
const { pluginDiscoveryId } = await import("./session-plugin-card");

const PLUGIN_ID = "plugin:marketplace/anthropic/sentry";
const notice = {
  id: "plugin-notice",
  kind: "auth-needed",
  serverId: "opengeni",
  providerDomain: "sentry.io",
  reason: "missing_connection",
  toolName: "capability_authorization_request",
  capability: {
    id: PLUGIN_ID,
    name: "sentry",
    kind: "plugin",
    action: "enable",
    rationale: "Triage the errors you asked about.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }).IS_REACT_ACT_ENVIRONMENT =
    true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  installedKeys = [];
  for (const fn of [discoverPlugins, listInstalledPlugins, previewPlugin, installPlugin]) {
    fn.mockClear();
  }
  continueAfterCapabilitySetup.mockClear();
  context.accessContext.workspaceGrants = [{ workspaceId: "workspace", permissions: everyone }];
});
// A failed assertion must not leave its card behind for the next test to find.
const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SessionCapabilityCard item={notice} workspaceId="workspace" sessionId="session" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  let live = true;
  const unmount = () => {
    if (!live) return;
    live = false;
    act(() => root.unmount());
    container.remove();
  };
  mounted.push(unmount);
  return {
    text: () => document.body.textContent ?? "",
    button: (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === name,
      ) ?? null,
    settle,
    unmount,
  };
}

describe("plugin card", () => {
  test("maps a plugin capability id to its marketplace entry", () => {
    expect(pluginDiscoveryId(PLUGIN_ID)).toBe("anthropic:sentry");
    expect(pluginDiscoveryId("plugin:marketplace/anthropic")).toBeNull();
    expect(pluginDiscoveryId("api:github-app")).toBeNull();
  });

  test("reviews the plugin, installs it for the workspace and lets the agent continue", async () => {
    const card = await render();
    expect(discoverPlugins).toHaveBeenCalledWith("workspace", { id: "anthropic:sentry" });
    // The card leads with the agent's reason and says what installing adds.
    expect(card.text()).toContain("Triage the errors you asked about.");
    expect(card.text()).toContain("1 Skill");
    await act(async () => card.button("Review plugin")!.click());
    await card.settle();
    expect(card.text()).toContain("Plugin · ");
    expect(card.text()).toContain("Triage Sentry errors from your agent.");
    expect(card.text()).toContain("triage-errors");
    const install = document.querySelector<HTMLButtonElement>(".og-plugin-install")!;
    expect(install.disabled).toBe(false);
    await act(async () => install.click());
    await card.settle();
    expect(previewPlugin).toHaveBeenCalledTimes(1);
    expect(installPlugin.mock.calls[0]?.[1]).toMatchObject({
      url: plugin.sourceUrl,
      expectedManifestDigest: "digest",
      expectedComponents: [{ key: "skill:triage-errors", digest: "c1" }],
    });
    expect(continueAfterCapabilitySetup).toHaveBeenCalledWith("workspace", "session", {
      capabilityId: PLUGIN_ID,
    });
    expect(card.text()).toContain("Installed in this workspace.");
    card.unmount();
  });

  test("an already installed plugin shows as done", async () => {
    installedKeys = ["marketplace/anthropic/sentry"];
    const card = await render();
    await card.settle();
    expect(card.text()).toContain("Installed in this workspace.");
    expect(installPlugin).not.toHaveBeenCalled();
    card.unmount();
  });

  test("someone who can't install plugins sees why instead of the card", async () => {
    context.accessContext.workspaceGrants = [
      { workspaceId: "workspace", permissions: ["sessions:control"] },
    ];
    const card = await render();
    expect(card.button("Review plugin")).toBeNull();
    expect(card.text()).toContain("Install sentry");
    expect(card.text()).toContain(
      "Installing sentry needs permission to manage this workspace's plugins.",
    );
    expect(card.text()).not.toContain("connected");
    expect(discoverPlugins).not.toHaveBeenCalled();
    card.unmount();
  });
});
