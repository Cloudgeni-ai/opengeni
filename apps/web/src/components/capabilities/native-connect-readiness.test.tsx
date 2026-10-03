import { describe, expect, mock, test } from "bun:test";
import type { ConnectProvider } from "@opengeni/connect";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilityCatalogItem, ConnectionMetadata, SocialConnection } from "@/types";
import { IntegrationPage } from "./integration-page";
import type { IntegrationViewModel } from "./integration-view-model";
import {
  nativeCatalogItemNotice,
  nativeCatalogItemVisible,
  nativeCatalogProviderId,
  nativeIntegrationModel,
  nativeIntegrationVisible,
  type NativeConnectCatalog,
} from "./native-connect-readiness";

function catalog(providers: Array<[string, ConnectProvider["readiness"]]>): NativeConnectCatalog {
  return {
    status: "ready",
    providers: providers.map(([id, readiness]) => ({
      id,
      label: id,
      family: id,
      readiness,
      ownership: ["personal"],
      setup: ["oauth"],
    })),
  };
}
function model(id: string, patch: Partial<IntegrationViewModel> = {}): IntegrationViewModel {
  return {
    id,
    name: id,
    description: "Read your connected account",
    mark: { monogram: "C" },
    chip: { label: "Not connected", tone: "idle" },
    connection: [],
    options: [],
    footer: { kind: "setup", onSetup: () => {} },
    ...patch,
  };
}
function connection(patch: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    accountId: "00000000-0000-4000-8000-000000000002",
    workspaceId: "00000000-0000-4000-8000-000000000003",
    subjectId: "user:test",
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {},
    createdBySubjectId: "user:test",
    updatedBySubjectId: "user:test",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...patch,
  };
}
function socialConnection(patch: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    accountId: "00000000-0000-4000-8000-000000000002",
    workspaceId: "00000000-0000-4000-8000-000000000003",
    provider: "x",
    status: "connected",
    ownership: "workspace",
    accountHandle: "existing-account",
    accountName: "Existing account",
    externalAccountId: null,
    scopes: [],
    credentialRef: null,
    tokenMetadata: {},
    metadata: {},
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...patch,
  };
}
function item(patch: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    kind: "mcp",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    endpointUrl: null,
    enabled: false,
    metadata: {},
    ...patch,
  } as CapabilityCatalogItem;
}

describe("native connection readiness", () => {
  test("fresh native rows use exact provider IDs and require available readiness", () => {
    for (const [row, provider] of [
      ["slack", "slack-personal"],
      ["github", "github-app"],
      ["google-drive", "google-drive-knowledge"],
      ["outlook-mail", "microsoft-outlook-mail"],
      ["outlook-calendar", "microsoft-outlook-calendar"],
      ["outlook-contacts", "microsoft-outlook-contacts"],
      ["onedrive", "microsoft-onedrive"],
    ]) {
      expect(
        nativeIntegrationVisible(model(row!), catalog([[provider!, "available"]]), false),
      ).toBe(true);
      for (const readiness of ["needs_configuration", "unsupported", "operator_only"] as const) {
        const unavailable = catalog([[provider!, readiness]]);
        expect(nativeIntegrationVisible(model(row!), unavailable, false)).toBe(false);
        expect(nativeIntegrationModel(model(row!), unavailable, false, () => {}).footer.kind).toBe(
          "locked",
        );
      }
      expect(nativeIntegrationVisible(model(row!), catalog([]), false)).toBe(false);
    }
    expect(
      nativeIntegrationVisible(model("slack"), catalog([["slack-personal", "available"]]), true),
    ).toBe(false);
    expect(
      nativeIntegrationVisible(model("slack"), catalog([["slack-bot", "available"]]), true),
    ).toBe(true);
  });

  test("a native direct link cannot expose Set up while pending, failed, or unsupported", () => {
    const retry = mock(() => {});
    for (const state of [
      { status: "loading", providers: [] },
      { status: "error", providers: [] },
      catalog([]),
    ] as NativeConnectCatalog[]) {
      const guarded = nativeIntegrationModel(model("outlook-mail"), state, false, retry);
      const markup = renderToStaticMarkup(<IntegrationPage model={guarded} onBack={() => {}} />);
      expect(markup).not.toContain(">Set up<");
      expect(markup).not.toContain("Not connected");
      expect(guarded.notice?.title).toBeDefined();
      if (state.status === "error") {
        expect(markup).toContain("Retry");
        guarded.notice!.action!.onClick();
      }
    }
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("connected, attention, and historical management survive unavailable setup", () => {
    const remove = mock(() => {});
    for (const label of ["Connected", "Needs attention"] as const) {
      const connected = model("google-drive", {
        chip: { label, tone: label === "Connected" ? "ok" : "warn" },
        footer: {
          kind: label === "Connected" ? "connected" : "repair",
          onReconnect: () => {},
          onDisconnect: remove,
        },
      });
      expect(nativeIntegrationVisible(connected, catalog([]), false)).toBe(true);
      const guarded = nativeIntegrationModel(connected, catalog([]), false, () => {});
      expect(guarded.footer).toBe(connected.footer);
      expect(guarded.chip).toBe(connected.chip);
    }
    const historical = model("atlassian", {
      chip: { label: "Retired", tone: "plain" },
      footer: { kind: "actions", primary: { label: "Disconnect", onClick: remove } },
    });
    expect(nativeIntegrationVisible(historical, catalog([]), false)).toBe(true);
    expect(nativeIntegrationModel(historical, catalog([]), false, () => {})).toBe(historical);
  });

  test("personal GitHub availability does not enable an unavailable workspace App", () => {
    const fresh = model("github", {
      footer: { kind: "actions", primary: { label: "Set up workspace App", onClick: () => {} } },
      options: [
        {
          kind: "link",
          id: "github-personal-identity",
          label: "Your GitHub identity",
          action: { label: "Connect", onClick: () => {} },
        },
      ],
    });
    const personalOnly = catalog([
      ["github-personal", "available"],
      ["github-app", "needs_configuration"],
    ]);
    const guarded = nativeIntegrationModel(fresh, personalOnly, false, () => {});
    expect(nativeIntegrationVisible(guarded, personalOnly, false)).toBe(true);
    expect(guarded.footer.kind).toBe("locked");
    expect(guarded.options).toHaveLength(1);
    expect(
      nativeIntegrationModel(fresh, catalog([["github-app", "available"]]), false, () => {})
        .options,
    ).toEqual([]);
    const connectedPersonal = {
      ...fresh,
      chip: { label: "Connected", tone: "ok" } as const,
      options: [
        {
          ...fresh.options[0]!,
          kind: "link",
          action: { label: "Manage", onClick: () => {} },
        } as const,
      ],
    };
    const managed = nativeIntegrationModel(connectedPersonal, catalog([]), false, () => {});
    expect(managed.options).toEqual(connectedPersonal.options);
    expect(managed.footer.kind).toBe("locked");
  });

  test("Drive write setup is checked separately from its existing read connection", () => {
    const connected = model("google-drive", {
      chip: { label: "Connected", tone: "ok" },
      footer: { kind: "connected", onReconnect: () => {}, onDisconnect: () => {} },
      options: [
        {
          kind: "toggle",
          id: "google-drive-publish",
          label: "Publish",
          checked: false,
          onChange: () => {},
        },
      ],
    });
    expect(
      nativeIntegrationModel(
        connected,
        catalog([["google-drive-knowledge", "available"]]),
        false,
        () => {},
      ).options,
    ).toEqual([]);
    const published = {
      ...connected,
      options: [
        { ...connected.options[0]!, kind: "toggle", checked: true, onChange: () => {} } as const,
      ],
    };
    expect(nativeIntegrationModel(published, catalog([]), false, () => {}).options).toEqual(
      published.options,
    );
  });

  test("new account controls use their own provider readiness without disabling existing account repair", () => {
    const add = mock(() => {});
    const change = mock(() => {});
    const drive = model("google-drive", {
      chip: { label: "Connected", tone: "ok" },
      access: {
        title: "Connected accounts",
        editLabel: "Add account",
        onEdit: add,
        items: [
          {
            name: "Existing account",
            actions: [
              { label: "Reconnect", onClick: change },
              { label: "Remove", onClick: change },
            ],
          },
        ],
      },
      footer: { kind: "connected", onReconnect: change, onDisconnect: change },
    });
    const readOnly = catalog([["google-drive-knowledge", "available"]]);
    const guarded = nativeIntegrationModel(drive, readOnly, false, () => {});
    expect(guarded.access?.onEdit).toBeUndefined();
    expect(guarded.access?.editLabel).toBeUndefined();
    expect(guarded.access?.items).toBe(drive.access?.items);
    expect(guarded.footer).toBe(drive.footer);
    expect(
      nativeIntegrationModel(drive, catalog([["google-drive", "available"]]), false, () => {})
        .access?.onEdit,
    ).toBe(add);
    const folders = {
      ...drive,
      access: { ...drive.access!, editLabel: "Change folders", onEdit: change },
    };
    expect(nativeIntegrationModel(folders, catalog([]), false, () => {}).access).toBe(
      folders.access,
    );
    for (const id of ["outlook-mail", "outlook-calendar", "outlook-contacts", "onedrive"]) {
      expect(
        nativeIntegrationModel({ ...drive, id }, catalog([]), false, () => {}).access?.onEdit,
      ).toBeUndefined();
    }
    const github = model("github", {
      chip: { label: "Connected", tone: "ok" },
      access: { title: "Repositories", items: [] },
      footer: {
        kind: "actions",
        primary: { label: "Connect another account", onClick: add },
        secondary: { label: "Disconnect workspace App", onClick: change },
      },
    });
    const blocked = nativeIntegrationModel(github, catalog([]), false, () => {});
    expect(blocked.footer.kind).toBe("actions");
    if (blocked.footer.kind === "actions") {
      expect(blocked.footer.primary).toBeUndefined();
      expect(blocked.footer.secondary?.onClick).toBe(change);
    }
    const repair = {
      ...github,
      footer: {
        ...github.footer,
        kind: "actions",
        primary: { label: "Repair workspace App", onClick: change },
      } as const,
    };
    expect(nativeIntegrationModel(repair, catalog([]), false, () => {}).footer).toBe(repair.footer);
  });

  test("saved native credentials and disabled social history remain reachable before catalog enablement", () => {
    for (const mcpUrl of [
      "https://gmailmcp.googleapis.com/mcp/v1",
      "https://mcp.slack.com/mcp",
      "https://mcp.figma.com/mcp",
    ]) {
      const disabled = item({ mcpUrl, source: "registry", enabled: false });
      const facts = {
        connections: [
          connection({
            providerDomain: new URL(mcpUrl).hostname,
            metadata: { mcpUrl },
            status: "needs_reauth",
          }),
        ],
        socialConnections: [],
      };
      expect(nativeCatalogItemVisible(disabled, catalog([]), facts)).toBe(true);
      expect(nativeCatalogItemNotice(disabled, catalog([]), () => {}, facts)).toBeUndefined();
      const unrelated = {
        ...facts,
        connections: [
          { ...facts.connections[0]!, metadata: { mcpUrl: "https://unrelated.example/mcp" } },
        ],
      };
      expect(nativeCatalogItemVisible(disabled, catalog([]), unrelated)).toBe(false);
    }
    for (const provider of ["x", "reddit"] as const) {
      const disabled = item({
        kind: "api",
        enabled: false,
        surfaceType: "provider_integration",
        metadata: { providerAdapter: "social", provider, connectionCounts: { connected: 1 } },
      });
      for (const status of ["connected", "needs_reauth", "disabled"] as const) {
        const facts = {
          connections: [],
          socialConnections: [socialConnection({ provider, status })],
        };
        expect(nativeCatalogItemVisible(disabled, catalog([]), facts)).toBe(true);
        expect(nativeCatalogItemNotice(disabled, catalog([]), () => {}, facts)).toBeUndefined();
      }
      expect(
        nativeCatalogItemVisible(disabled, catalog([]), { connections: [], socialConnections: [] }),
      ).toBe(false);
    }
    const fiken = item({ kind: "api", surfaceType: "first_party_fiken" });
    const facts = {
      connections: [
        connection({
          id: "00000000-0000-4000-8000-000000000005",
          subjectId: null,
          kind: "api_key",
          providerDomain: "fiken.no",
          metadata: { credentialRole: "fiken_api_token" },
        }),
      ],
      socialConnections: [],
    };
    expect(nativeCatalogItemVisible(fiken, catalog([]), facts)).toBe(true);
    expect(nativeCatalogItemNotice(fiken, catalog([]), () => {}, facts)).toBeUndefined();
    expect(
      nativeCatalogItemVisible(item(), catalog([]), { connections: null, socialConnections: [] }),
    ).toBe(true);
  });

  test("only a fresh registry Figma listing is withheld while approved-client access is unavailable", () => {
    const stock = item({ source: "registry", mcpUrl: "https://mcp.figma.com/mcp" });
    expect(nativeCatalogItemVisible(stock, catalog([]))).toBe(false);
    expect(nativeCatalogItemVisible(stock, { status: "loading", providers: [] })).toBe(false);
    expect(nativeCatalogItemNotice(stock, catalog([]), () => {})?.title).toBe(
      "Figma requires an approved client",
    );
    expect(nativeCatalogItemNotice(stock, catalog([]), () => {})?.description).toContain(
      "Opengeni isn't currently listed",
    );
    for (const source of ["manual", "configured", "public_registry"] as const) {
      const custom = { ...stock, source };
      expect(nativeCatalogItemVisible(custom, catalog([]))).toBe(true);
      expect(nativeCatalogItemNotice(custom, catalog([]), () => {})).toBeUndefined();
    }
    const existing = { ...stock, enabled: true };
    expect(nativeCatalogItemVisible(existing, catalog([]))).toBe(true);
    expect(nativeCatalogItemNotice(existing, catalog([]), () => {})).toBeUndefined();
    const otherEndpoint = { ...stock, mcpUrl: "https://figma.example/mcp" };
    expect(nativeCatalogItemVisible(otherEndpoint, catalog([]))).toBe(true);
  });

  test("native built-ins are gated by identity while historical and custom MCP stay visible", () => {
    expect(nativeCatalogItemVisible(item(), catalog([]))).toBe(false);
    expect(nativeCatalogItemVisible(item(), catalog([["gmail", "available"]]))).toBe(true);
    expect(
      nativeCatalogItemNotice(item(), { status: "error", providers: [] }, () => {})?.action?.label,
    ).toBe("Retry");
    expect(nativeCatalogItemVisible(item({ enabled: true }), catalog([]))).toBe(true);
    expect(nativeCatalogItemNotice(item({ enabled: true }), catalog([]), () => {})).toBeUndefined();
    for (const mcpUrl of [
      "https://mcp.linear.app/mcp",
      "https://custom.example/mcp",
      "https://gmailmcp.googleapis.com/another-path",
    ]) {
      expect(nativeCatalogProviderId(item({ mcpUrl }))).toBeNull();
      expect(nativeCatalogItemVisible(item({ mcpUrl }), catalog([]))).toBe(true);
    }
    expect(nativeCatalogProviderId(item({ mcpUrl: "https://mcp.slack.com/mcp" }))).toBe(
      "slack-personal",
    );
    expect(
      nativeCatalogProviderId(
        item({
          kind: "api",
          surfaceType: "provider_integration",
          metadata: { providerAdapter: "social", provider: "reddit" },
        }),
      ),
    ).toBe("reddit");
    const fiken = item({ kind: "api", surfaceType: "first_party_fiken" });
    expect(nativeCatalogItemVisible(fiken, catalog([["fiken-token", "available"]]))).toBe(true);
    expect(nativeCatalogItemVisible(fiken, catalog([["fiken-oauth", "available"]]))).toBe(true);
    expect(nativeCatalogItemVisible(fiken, catalog([]))).toBe(false);
  });
});
