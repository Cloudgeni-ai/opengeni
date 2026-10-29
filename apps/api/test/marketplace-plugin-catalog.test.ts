import { describe, expect, test } from "bun:test";
import { inChatCapabilitySetup } from "@opengeni/contracts/personal-integration-setup";
import { capabilitySetupReadiness } from "../src/capability-setup-readiness";
import {
  pluginCapabilityId,
  pluginCapabilityItems,
  pluginCapabilitySetup,
} from "../src/integrations/marketplace-plugin-catalog";

const FIGMA = "plugin:marketplace/openai/figma";

describe("marketplace plugins in the integration catalogue", () => {
  test("each installable plugin is a catalogue entry named by its install key", () => {
    const items = pluginCapabilityItems(new Set());
    const figma = items.find((item) => item.id === FIGMA);
    expect(figma).toMatchObject({
      kind: "plugin",
      surfaceType: "plugin_package",
      authKind: "none",
      enabled: false,
      lifecycle: { readiness: "setup_required" },
      metadata: { pluginKey: "marketplace/openai/figma", provider: "openai" },
    });
    expect((figma!.metadata.skills as string[]).length).toBeGreaterThan(0);
    expect(figma!.description).toMatch(/Plugin with \d+ Skills? and 1 MCP server\.$/u);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    // A plugin that would install nothing here is not offered.
    expect(items.some((item) => item.id === "plugin:marketplace/openai/teams")).toBe(false);
    expect(pluginCapabilityId({ provider: "anthropic", name: "sentry" })).toBe(
      "plugin:marketplace/anthropic/sentry",
    );
  });

  test("an installed plugin is ready; otherwise the person installs it from the card", () => {
    const offered = pluginCapabilityItems(new Set()).find((item) => item.id === FIGMA)!;
    const installed = pluginCapabilityItems(new Set(["marketplace/openai/figma"])).find(
      (item) => item.id === FIGMA,
    )!;
    expect(installed).toMatchObject({ enabled: true, lifecycle: { readiness: "ready" } });
    expect(pluginCapabilitySetup(offered)).toMatchObject({
      status: "authorization_required",
      action: "enable",
    });
    expect(pluginCapabilitySetup(installed)).toMatchObject({ status: "ready", action: null });

    const chat = { tools: [], firstPartyMcpTools: [], effectiveToolPolicy: null } as never;
    expect(capabilitySetupReadiness(FIGMA, offered, chat)).toBe("not_ready");
    expect(capabilitySetupReadiness(FIGMA, installed, chat)).toBe("ready");
  });

  test("installing from the chat needs the same permission as the Plugins page", () => {
    expect(
      inChatCapabilitySetup(
        { permissions: ["sessions:control", "capabilities:manage"], permissionMode: "explicit" },
        FIGMA,
        undefined,
      ),
    ).toEqual({ kind: "default" });
    expect(
      inChatCapabilitySetup(
        { permissions: ["sessions:control"], permissionMode: "explicit" },
        FIGMA,
        undefined,
      ),
    ).toEqual({ kind: "unavailable" });
  });
});
