import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CapabilityCatalogItem as CapabilityCatalogItemSchema } from "@opengeni/contracts";

import type { ConnectionHealth } from "@/lib/capabilities";
import type { CapabilityCatalogItem, ConnectionMetadata, SocialConnection } from "@/types";
import { EnabledCapabilitiesSection } from "./capability-catalog-sections";
import { Sheet } from "@/components/ui/sheet";
import {
  ConnectionStatus,
  DEFAULT_CONNECTION_OWNERSHIP,
  DetailBody,
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

function installedCuratedSkill(): CapabilityCatalogItem {
  return CapabilityCatalogItemSchema.parse({
    id: "skill:terraform-style-guide",
    kind: "skill",
    source: "library",
    name: "Terraform Style Guide",
    description: "Reviewed Terraform conventions.",
    category: "infrastructure",
    enabled: true,
    runtime: { available: true, notes: null },
    lifecycle: {
      status: "installed",
      readiness: "ready",
      detail: "installed",
      managedBy: "workspace",
    },
    actions: ["configure", "update", "uninstall", "inspect"],
    metadata: {
      libraryId: "terraform-style-guide",
      version: "1.0.0",
      contentSha256: "a".repeat(64),
      updateAvailable: true,
    },
  });
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

  test("official Gmail exposes only a personal connect action and explains isolation", async () => {
    const gmail = CapabilityCatalogItemSchema.parse({
      id: "registry:gmail",
      kind: "mcp",
      source: "registry",
      name: "Gmail",
      category: "integrations",
      providerDomain: "gmailmcp.googleapis.com",
      mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      authKind: "oauth2",
      runtime: { available: true, mcpServerId: "gmail-runtime", notes: null },
      metadata: { connectionOwnership: "personal_only" },
    });
    const onAction = mock((_action: unknown) => {});
    const rendered = await render(
      <Sheet open>
        <DetailBody
          item={gmail}
          health={{ state: "none" }}
          logoSrc={null}
          busy={false}
          errorMessage={null}
          canManageSocial={false}
          onAction={onAction}
        />
      </Sheet>,
    );
    try {
      expect(rendered.container.textContent).toContain(
        "Other workspace members cannot discover or use",
      );
      expect(rendered.container.textContent).toContain("Each member connects their own");
      expect(rendered.container.textContent).toContain(
        "content added to a session follows that session's visibility",
      );
      expect(rendered.container.textContent).not.toContain("Connect for workspace");
      const connect = [...rendered.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Connect only for me"),
      );
      expect(connect).toBeDefined();
      await act(async () => connect!.click());
      expect(onAction).toHaveBeenCalledWith({
        type: "oauth",
        item: gmail,
        ownership: "personal",
      });
    } finally {
      await rendered.unmount();
    }
  });

  test("an installed MCP exposes only the authoritative disconnect action", async () => {
    const mcp = CapabilityCatalogItemSchema.parse({
      id: "mcp:internal-tools",
      kind: "mcp",
      source: "manual",
      name: "Internal Tools",
      category: "custom",
      endpointUrl: "https://mcp.example.com/sse",
      enabled: true,
      runtime: { available: true, mcpServerId: "internal-tools", notes: null },
      lifecycle: {
        status: "ready",
        readiness: "ready",
        detail: "enabled",
        managedBy: "workspace",
      },
      actions: ["configure", "disconnect", "inspect"],
    });
    const onAction = mock((_action: unknown) => {});
    const rendered = await render(
      <Sheet open>
        <DetailBody
          item={mcp}
          health={{ state: "none" }}
          logoSrc={null}
          busy={false}
          errorMessage={null}
          canManageSocial={false}
          onAction={onAction}
        />
      </Sheet>,
    );
    try {
      const disconnect = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Disconnect",
      );
      expect(disconnect).toBeDefined();
      expect(rendered.container.textContent).not.toContain("Disable");
      await act(async () => disconnect!.click());
      expect(onAction).toHaveBeenCalledWith({ type: "disconnect", item: mcp });
    } finally {
      await rendered.unmount();
    }
  });

  test("non-MCP capabilities never expose the generic disconnect mutation", async () => {
    const plugin = CapabilityCatalogItemSchema.parse({
      id: "plugin:source-package",
      kind: "plugin",
      source: "manual",
      name: "Source Package",
      category: "developer-tools",
      enabled: true,
      runtime: { available: true, notes: null },
      lifecycle: {
        status: "installed",
        readiness: "ready",
        detail: "installed",
        managedBy: "workspace",
      },
      actions: ["configure", "update", "uninstall", "inspect"],
    });
    const onAction = mock((_action: unknown) => {});
    const rendered = await render(
      <Sheet open>
        <DetailBody
          item={plugin}
          health={{ state: "none" }}
          logoSrc={null}
          busy={false}
          errorMessage={null}
          canManageSocial={false}
          onAction={onAction}
        />
      </Sheet>,
    );
    try {
      expect(rendered.container.textContent).toContain(
        "Manage this capability from its dedicated controls.",
      );
      expect(rendered.container.textContent).not.toContain("Disconnect");
      expect(rendered.container.textContent).not.toContain("Disable");
      expect(onAction).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });
});

describe("Skill installation authority UI", () => {
  test("keeps Skill mutations disabled with administrator guidance for non-admin members", async () => {
    const skill = installedCuratedSkill();
    const onAction = mock((_action: unknown) => {});
    const rendered = await render(
      <Sheet open>
        <DetailBody
          item={skill}
          health={{ state: "none" }}
          logoSrc={null}
          busy={false}
          errorMessage={null}
          canManageSocial={false}
          canManageSkills={false}
          onAction={onAction}
        />
      </Sheet>,
    );
    try {
      const update = [...rendered.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Update Skill"),
      );
      const remove = [...rendered.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Remove Skill"),
      );
      expect(update?.disabled).toBe(true);
      expect(remove?.disabled).toBe(true);
      expect(rendered.container.textContent).toContain(
        "Workspace administrator permission is required to install, update, or remove Skills.",
      );
      await act(async () => update!.click());
      await act(async () => remove!.click());
      expect(onAction).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  test("keeps read access while disabling the enabled-strip removal shortcut", async () => {
    const skill = installedCuratedSkill();
    const onOpen = mock((_item: CapabilityCatalogItem) => {});
    const onDisable = mock((_item: CapabilityCatalogItem) => {});
    const rendered = await render(
      <EnabledCapabilitiesSection
        items={[skill]}
        busyId={null}
        connectionHealth={() => ({ state: "none" })}
        logoUrl={() => null}
        canManageSkills={false}
        onOpen={onOpen}
        onDisable={onDisable}
      />,
    );
    try {
      const inspect = rendered.container.querySelector<HTMLButtonElement>(
        '[data-capability-id="skill:terraform-style-guide"]',
      );
      const remove = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Remove",
      );
      expect(inspect?.disabled).toBe(false);
      expect(remove?.disabled).toBe(true);
      expect(remove?.title).toContain("Workspace administrator permission is required");
      await act(async () => inspect!.click());
      await act(async () => remove!.click());
      expect(onOpen).toHaveBeenCalledWith(skill);
      expect(onDisable).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });
});

describe("social provider integration UI", () => {
  const x = { id: "api:x", name: "X" } as CapabilityCatalogItem;

  test("shows every workspace account and emits exact disconnect plus add/reconnect actions", async () => {
    const onAction = mock((_action: unknown) => {});
    const connected = socialConnection();
    const needsReauth = socialConnection({
      id: "55555555-5555-4555-8555-555555555555",
      accountHandle: "opengeni_support",
      accountName: "OpenGeni Support",
      externalAccountId: "x-account-2",
      status: "needs_reauth",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    const rendered = await render(
      <SocialConnectorControls
        item={x}
        provider="x"
        connections={[needsReauth, connected]}
        ownership="workspace"
        onOwnershipChange={() => undefined}
        busy={false}
        canManage
        onAction={onAction}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("OpenGeni");
      expect(rendered.container.textContent).toContain("OpenGeni Support");
      expect(rendered.container.textContent).toContain("Needs reconnection");
      expect(rendered.container.textContent).toContain("Workspace shared");
      expect(rendered.container.textContent).toContain("scheduled automations");
      const buttons = [...rendered.container.querySelectorAll("button")];
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        "Disconnect",
        "Disconnect",
        "Reconnect or add X account",
      ]);
      await act(async () => buttons[2]!.click());
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
      expect(onAction).toHaveBeenNthCalledWith(3, {
        type: "disconnect_social",
        item: x,
        connectionId: needsReauth.id,
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
