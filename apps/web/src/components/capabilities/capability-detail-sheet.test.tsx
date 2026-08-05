import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ConnectionHealth } from "@/lib/capabilities";
import type { CapabilityCatalogItem, ConnectionMetadata, SocialConnection } from "@/types";
import {
  ConnectionStatus,
  DEFAULT_CONNECTION_OWNERSHIP,
  OwnershipSelector,
  SocialConnectorControls,
} from "./capability-detail-sheet";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function item(connectionRef: CapabilityCatalogItem["connectionRef"]): CapabilityCatalogItem {
  return { connectionRef } as CapabilityCatalogItem;
}

function connection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    subjectId: null,
    providerDomain: "linear.app",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {},
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function socialConnection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    ownership: "workspace",
    provider: "x",
    accountHandle: "opengeni",
    accountName: "OpenGeni",
    externalAccountId: "x-account-1",
    status: "connected",
    scopes: ["tweet.read"],
    credentialRef: null,
    tokenMetadata: {},
    metadata: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("connection ownership UI", () => {
  test("defaults to workspace ownership and exposes two labeled radio choices", async () => {
    expect(DEFAULT_CONNECTION_OWNERSHIP).toBe("workspace");
    const onChange = mock((_value: "workspace" | "personal") => {});
    const rendered = await render(
      <OwnershipSelector value={DEFAULT_CONNECTION_OWNERSHIP} onChange={onChange} />,
    );
    try {
      const radios = [
        ...rendered.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ];
      expect(radios).toHaveLength(2);
      expect(radios[0]?.value).toBe("workspace");
      expect(radios[0]?.checked).toBe(true);
      expect(radios[1]?.value).toBe("personal");
      expect(radios[1]?.checked).toBe(false);
      expect(rendered.container.textContent).toContain("Who can use this connection?");
      expect(rendered.container.textContent).toContain("Connect for workspace");
      expect(rendered.container.textContent).toContain("Connect only for me");

      await act(async () => radios[1]!.click());
      expect(onChange).toHaveBeenCalledWith("personal");
    } finally {
      await rendered.unmount();
    }
  });

  test("a deleted workspace row is not misreported as personal", async () => {
    const health: ConnectionHealth = { state: "attention", connection: null };
    const rendered = await render(
      <ConnectionStatus
        item={item({
          connectionId: "11111111-1111-4111-8111-111111111111",
          providerDomain: "linear.app",
          kind: "oauth2",
          subjectScope: "workspace",
        })}
        health={health}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain(
        "Workspace connection needs to be reconnected.",
      );
      expect(rendered.container.textContent).not.toContain("Personal connection");
    } finally {
      await rendered.unmount();
    }
  });

  test("connected personal ownership is explicit without exposing its row id", async () => {
    const health: ConnectionHealth = {
      state: "connected",
      connection: connection({ subjectId: "subject-a" }),
    };
    const rendered = await render(
      <ConnectionStatus
        item={item({
          providerDomain: "linear.app",
          kind: "oauth2",
          subjectScope: "subject",
        })}
        health={health}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("Personal connection to linear.app");
      expect(rendered.container.textContent).toContain("only when explicitly delegated");
      expect(rendered.container.textContent).not.toContain("11111111-1111-4111-8111-111111111111");
    } finally {
      await rendered.unmount();
    }
  });
});

describe("first-party social connector UI", () => {
  const x = { id: "api:x", name: "X" } as CapabilityCatalogItem;

  test("shows workspace automation semantics and emits reconnect/disconnect actions", async () => {
    const onAction = mock((_action: unknown) => {});
    const connected = socialConnection();
    const rendered = await render(
      <SocialConnectorControls
        item={x}
        provider="x"
        connections={[connected]}
        ownership="workspace"
        onOwnershipChange={() => undefined}
        busy={false}
        canManage
        onAction={onAction}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("Connected as @opengeni");
      expect(rendered.container.textContent).toContain("Workspace shared");
      expect(rendered.container.textContent).toContain("scheduled automations");
      const buttons = [...rendered.container.querySelectorAll("button")];
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        "Reconnect X",
        "Disconnect",
      ]);
      await act(async () => buttons[0]!.click());
      await act(async () => buttons[1]!.click());
      expect(onAction).toHaveBeenNthCalledWith(1, {
        type: "social_oauth",
        item: x,
        provider: "x",
        ownership: "workspace",
      });
      expect(onAction).toHaveBeenNthCalledWith(2, {
        type: "disconnect_social",
        item: x,
        connectionId: connected.id,
      });
    } finally {
      await rendered.unmount();
    }
  });

  test("defaults to workspace connection copy and disables management without admin access", async () => {
    const rendered = await render(
      <SocialConnectorControls
        item={x}
        provider="x"
        connections={[]}
        ownership="workspace"
        onOwnershipChange={() => undefined}
        busy={false}
        canManage={false}
        onAction={() => undefined}
      />,
    );
    try {
      const button = rendered.container.querySelector("button");
      expect(button?.textContent).toContain("Connect X for workspace");
      expect(button?.disabled).toBe(true);
      expect(rendered.container.textContent).toContain("Workspace admin permission is required");
      expect(rendered.container.textContent).toContain("Connect only for me");
    } finally {
      await rendered.unmount();
    }
  });
});
