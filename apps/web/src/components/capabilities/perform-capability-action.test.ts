import { describe, expect, mock, test } from "bun:test";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { ConnectionMetadata } from "@/types";
import { performCapabilityAction } from "./perform-capability-action";

const item = CapabilityCatalogItem.parse({
  id: "test-key",
  kind: "mcp",
  source: "manual",
  name: "Test",
  providerDomain: "api.example.com",
  mcpUrl: "https://api.example.com/mcp",
  authKind: "api_key",
  requiredHeaders: ["Authorization"],
  runtime: { available: true },
});
function harness(overrides: Record<string, unknown> = {}) {
  const createConnection = mock(async () => ({
    id: "connection",
    providerDomain: "canonical.example.com",
  }));
  const updateConnection = mock(async () => ({
    id: "existing",
    providerDomain: "canonical.example.com",
  }));
  const enableCapability = mock(
    async (..._args: Parameters<OpenGeniBrowserClient["enableCapability"]>) => {},
  );
  const options = {
    client: {
      createConnection,
      updateConnection,
      enableCapability,
      ...overrides,
    } as unknown as OpenGeniBrowserClient,
    workspaceId: "workspace",
    item,
    connections: [] as ConnectionMetadata[],
    canManageSkills: true,
    refresh: mock(async () => {}),
    onRuntimeChanged: mock(() => {}),
    onComplete: mock(async () => {}),
    onSkillRemoval: mock(() => {}),
    returnPathFor: () => "/workspaces/workspace/sessions/session",
    redirect: mock(() => {}),
  };
  return { options, createConnection, updateConnection, enableCapability };
}
const action = {
  type: "api_key" as const,
  item,
  ownership: "workspace" as const,
  headers: { Authorization: "private-input" },
};

describe("shared capability connection lifecycle", () => {
  test("preserves exact Connect returns and native conversation callback paths", async () => {
    const social = CapabilityCatalogItem.parse({
      ...item,
      id: "api:x",
      kind: "api",
      surfaceType: "provider_integration",
      metadata: { providerAdapter: "social", provider: "x" },
    });
    const beginConnect = mock(async () => ({
      nextAction: { type: "authorize", url: "https://provider.example/connect" },
    }));
    const startSocialOAuth = mock(async () => ({
      authorizationUrl: "https://provider.example/native",
    }));
    const h = harness({ beginConnect, startSocialOAuth });
    const socialAction = {
      type: "social_oauth" as const,
      item: social,
      provider: "x" as const,
      ownership: "workspace" as const,
    };
    const returnUrl = "https://HOST.example/settings?x=%2f#integrations";
    await performCapabilityAction(
      { ...h.options, item: social, connectReturnUrl: returnUrl },
      socialAction,
    );
    expect(beginConnect).toHaveBeenCalledWith("workspace", {
      providerId: "x",
      ownership: "workspace",
      returnUrl,
      idempotencyKey: expect.any(String),
    });
    expect(startSocialOAuth).not.toHaveBeenCalled();
    expect(h.options.redirect).toHaveBeenLastCalledWith("https://provider.example/connect");
    await performCapabilityAction({ ...h.options, item: social }, socialAction);
    expect(startSocialOAuth).toHaveBeenCalledWith("workspace", {
      provider: "x",
      ownership: "workspace",
      returnPath: h.options.returnPathFor(),
    });
    expect(h.options.redirect).toHaveBeenLastCalledWith("https://provider.example/native");
  });
  test("enables using the server's canonical connection, never the form's domain", async () => {
    const h = harness();
    await performCapabilityAction(h.options, action);
    expect(h.enableCapability.mock.calls[0]?.[2]).toMatchObject({
      connectionRef: { connectionId: "connection", providerDomain: "canonical.example.com" },
    });
    expect(h.options.onComplete).toHaveBeenCalledTimes(1);
  });
  test("a failed enable never announces completion and a retry reuses the existing credential", async () => {
    const h = harness();
    h.enableCapability.mockImplementationOnce(async () => {
      throw new Error("Enable unavailable");
    });
    await expect(performCapabilityAction(h.options, action)).rejects.toThrow("Enable unavailable");
    expect(h.options.onComplete).not.toHaveBeenCalled();
    h.options.connections = [
      {
        id: "existing",
        providerDomain: "api.example.com",
        kind: "api_key",
        subjectId: null,
        status: "active",
      } as ConnectionMetadata,
    ];
    await performCapabilityAction(h.options, action);
    expect(h.createConnection).toHaveBeenCalledTimes(1);
    expect(h.updateConnection).toHaveBeenCalledTimes(1);
    expect(h.options.onComplete).toHaveBeenCalledTimes(1);
  });
  test("an unreadable connection list cannot create duplicate credentials", async () => {
    const h = harness();
    await expect(
      performCapabilityAction({ ...h.options, connections: null }, action),
    ).rejects.toThrow("could not be checked");
    expect(h.createConnection).not.toHaveBeenCalled();
  });
  test("a stale credential form cannot silently turn into an unauthenticated enable", async () => {
    const h = harness();
    const changed = { ...item, authKind: "none" as const, requiredHeaders: [] };
    await expect(
      performCapabilityAction({ ...h.options, item: changed }, action),
    ).rejects.toThrow();
    expect(h.enableCapability).not.toHaveBeenCalled();
  });
  test("a failed session attachment leaves setup retryable", async () => {
    const h = harness();
    h.options.onComplete.mockImplementationOnce(async () => {
      throw new Error("Tool selection changed");
    });
    await expect(performCapabilityAction(h.options, action)).rejects.toThrow(
      "Tool selection changed",
    );
    expect(h.enableCapability).toHaveBeenCalledTimes(1);
  });
});
