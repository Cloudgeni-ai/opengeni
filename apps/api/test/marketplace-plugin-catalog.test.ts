import { describe, expect, test } from "bun:test";
import { inChatCapabilitySetup } from "@opengeni/contracts/personal-integration-setup";
import { capabilitySetupReadiness } from "../src/capability-setup-readiness";
import {
  mcpConnectionEndpointKey,
  pluginCapabilityId,
  pluginCapabilityItems,
  pluginCapabilitySetup,
  pluginMcpEndpointKeys,
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

  test("a description ends with a full stop before what the plugin adds", () => {
    const gmail = pluginCapabilityItems(new Set()).find(
      (item) => item.id === "plugin:marketplace/openai/gmail",
    )!;
    expect(gmail.description).toBe("Read and manage Gmail. Plugin with 1 MCP server.");
    expect(pluginMcpEndpointKeys(gmail)).toEqual(["https://gmailmcp.googleapis.com/mcp/v1"]);
  });

  test("an uninstalled plugin names a connection to the same server for the person's own account", () => {
    const gmail = pluginCapabilityItems(new Set()).find(
      (item) => item.id === "plugin:marketplace/openai/gmail",
    )!;
    expect(pluginCapabilitySetup(gmail).detail).toBe(
      "Not installed. The person can review what the Gmail plugin adds and install it for the workspace from its card.",
    );
    expect(pluginCapabilitySetup(gmail, [{ capabilityId: "mcp:gmail", name: "Gmail" }])).toEqual({
      status: "authorization_required",
      action: "enable",
      detail:
        "Not installed. The person can review what the Gmail plugin adds and install it for the workspace from its card. For the person's own account, offer the Gmail connection (mcp:gmail) instead: call capability_authorization_request with its capabilityId. Installing the plugin is for everyone in the workspace.",
    });
    const installed = pluginCapabilityItems(new Set(["marketplace/openai/gmail"])).find(
      (item) => item.id === "plugin:marketplace/openai/gmail",
    )!;
    expect(
      pluginCapabilitySetup(installed, [{ capabilityId: "mcp:gmail", name: "Gmail" }]).detail,
    ).not.toContain("connection");
    expect(mcpConnectionEndpointKey("https://gmailmcp.googleapis.com/mcp/v1/")).toBe(
      "https://gmailmcp.googleapis.com/mcp/v1",
    );
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
