import { describe, expect, test } from "bun:test";
import {
  CapabilityCatalogItem,
  effectiveNangoIntegrations,
  type CapabilityCatalogItem as CatalogItem,
  type IntegrationBackendSetting,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import {
  applyConnectorSetupGates,
  applyNangoBackendsToSettings,
  builtInConnectorCatalogItems,
  builtInIntegrationDuplicated,
  builtInIntegrationDuplicatedByEndpoint,
  builtInIntegrationKey,
  builtInIntegrationTurnedOffDetail,
  configuredMcpCatalogItems,
  pluginBuiltInIntegrationKeys,
  withoutBuiltInIntegrationDuplicates,
  withoutNangoReplacedSocialItems,
} from "../src";

const GMAIL_MCP = "https://gmailmcp.googleapis.com/mcp/v1";
const DRIVE_MCP = "https://drivemcp.googleapis.com/mcp/v1";

function item(input: Partial<CatalogItem> & Pick<CatalogItem, "id" | "name">): CatalogItem {
  return CapabilityCatalogItem.parse({
    kind: "mcp",
    source: "registry",
    category: "integrations",
    runtime: { available: true, notes: null },
    ...input,
  });
}

function setting(
  integrationKey: string,
  definition: IntegrationBackendSetting["definition"] = null,
): IntegrationBackendSetting {
  return {
    integrationKey,
    backend: "nango",
    providerConfigKey: `${integrationKey}-managed`,
    enabled: true,
    definition,
    revision: 1,
    changedAt: "2026-11-16T00:00:00.000Z",
  };
}

// The registry rows as the catalog importer stores them.
const registryGmail = item({
  id: "mcp:integrations-sh:gmailmcp-googleapis-com-1a2b3c",
  name: "Gmail",
  providerDomain: "gmailmcp.googleapis.com",
  mcpUrl: GMAIL_MCP,
  endpointUrl: GMAIL_MCP,
  authKind: "oauth2",
});
const registryX = item({
  id: "mcp:integrations-sh:x-com-4d5e6f",
  name: "x.com",
  providerDomain: "x.com",
  mcpUrl: "https://api.x.com/mcp",
  endpointUrl: "https://api.x.com/mcp",
  authKind: "oauth2",
});
const registryLinear = item({
  id: "mcp:integrations-sh:linear-app-7a8b9c",
  name: "Linear",
  providerDomain: "linear.app",
  mcpUrl: "https://mcp.linear.app/mcp",
  endpointUrl: "https://mcp.linear.app/mcp",
  authKind: "oauth2",
});
// A deployment that configures Gmail as its own server.
const configuredGmail = configuredMcpCatalogItems(
  testSettings({
    mcpServers: [
      {
        id: "gmail",
        name: "Gmail",
        url: GMAIL_MCP,
        connectionRef: {
          providerDomain: "gmailmcp.googleapis.com",
          subjectScope: "subject",
          kind: "oauth2",
        },
      },
    ],
  }),
)[0]!;

function socialItems(configured: boolean) {
  return builtInConnectorCatalogItems({
    settings: {
      ...testSettings(),
      socialOauthClientsJson: configured
        ? JSON.stringify({ x: { clientId: "x-client", clientSecret: "x-secret" } })
        : undefined,
    },
    socialConnections: [],
    workspaceConnections: [],
  }).filter((entry) => entry.metadata.providerAdapter === "social");
}

describe("registry entries that duplicate a built-in integration", () => {
  test("a registry Gmail row beside the deployment's own Gmail is left out; the built-in stays", () => {
    expect(builtInIntegrationKey(configuredGmail)).toBe("gmail");
    expect(builtInIntegrationDuplicated(registryGmail, [configuredGmail, registryGmail])).toBe(
      configuredGmail,
    );
    expect(
      withoutBuiltInIntegrationDuplicates([configuredGmail, registryGmail, registryLinear]).map(
        (entry) => entry.id,
      ),
    ).toEqual([configuredGmail.id, registryLinear.id]);
  });

  test("without a built-in of its own, the registry's reviewed Gmail row is the integration", () => {
    expect(builtInIntegrationKey(registryGmail)).toBe("gmail");
    expect(withoutBuiltInIntegrationDuplicates([registryGmail, registryLinear])).toEqual([
      registryGmail,
      registryLinear,
    ]);
  });

  test("a registry entry for another service is never a duplicate", () => {
    const catalog = [configuredGmail, ...socialItems(true), registryLinear];
    expect(builtInIntegrationDuplicated(registryLinear, catalog)).toBeNull();
    expect(withoutBuiltInIntegrationDuplicates(catalog)).toContain(registryLinear);
  });

  test("X's registry MCP gives way to the X connector only when the deployment can connect X", () => {
    const connectable = socialItems(true);
    const x = connectable.find((entry) => entry.metadata.provider === "x")!;
    expect(builtInIntegrationDuplicated(registryX, [...connectable, registryX])).toBe(x);
    // No X client here: the built-in can't connect, so the registry row stays.
    const unconfigured = socialItems(false);
    expect(builtInIntegrationDuplicated(registryX, [...unconfigured, registryX])).toBeNull();
    expect(withoutBuiltInIntegrationDuplicates([...unconfigured, registryX])).toContain(registryX);
  });

  test("while Nango serves X, X's registry MCP gives way to the Nango-backed X", () => {
    const backends = effectiveNangoIntegrations(
      [setting("x", { displayName: "X", tools: { source: "nango" } })],
      true,
    );
    const settings = applyNangoBackendsToSettings(testSettings({ mcpServers: [] }), backends);
    const nangoX = configuredMcpCatalogItems(settings, backends).find(
      (entry) => entry.metadata.nangoIntegrationKey === "x",
    )!;
    expect(nangoX.metadata.serviceDomain).toBe("x.com");
    expect(builtInIntegrationKey(nangoX)).toBe("x");
    const catalog = [...withoutNangoReplacedSocialItems(socialItems(true), backends), nangoX];
    expect(builtInIntegrationDuplicated(registryX, [...catalog, registryX])).toBe(nangoX);
  });

  test("a config-only Nango integration names its service by its account identity host", () => {
    const backends = effectiveNangoIntegrations(
      [
        setting("linkedin", {
          displayName: "LinkedIn",
          tools: { source: "nango" },
          accountIdentity: { url: "https://api.linkedin.com/v2/userinfo", field: "sub" },
        }),
      ],
      true,
    );
    const settings = applyNangoBackendsToSettings(testSettings({ mcpServers: [] }), backends);
    const linkedin = configuredMcpCatalogItems(settings, backends)[0]!;
    expect(linkedin.metadata.serviceDomain).toBe("linkedin.com");
    const registryLinkedIn = item({
      id: "mcp:integrations-sh:linkedin-com-0",
      name: "LinkedIn",
      providerDomain: "linkedin.com",
      endpointUrl: "https://mcp.linkedin.com/mcp",
    });
    expect(builtInIntegrationDuplicated(registryLinkedIn, [linkedin, registryLinkedIn])).toBe(
      linkedin,
    );
  });

  test("a Nango integration whose account is named on a shared API host claims no service domain", () => {
    const backends = effectiveNangoIntegrations(
      [
        setting("outlook-mail", {
          displayName: "Outlook Mail",
          tools: { source: "nango" },
          accountIdentity: { url: "https://graph.microsoft.com/v1.0/me", field: "id" },
        }),
      ],
      true,
    );
    const settings = applyNangoBackendsToSettings(testSettings({ mcpServers: [] }), backends);
    const outlook = configuredMcpCatalogItems(settings, backends)[0]!;
    expect(outlook.metadata.serviceDomain).toBeUndefined();
    const learn = item({
      id: "mcp:integrations-sh:learn-microsoft-com-0",
      name: "Microsoft Learn",
      providerDomain: "learn.microsoft.com",
      endpointUrl: "https://learn.microsoft.com/api/mcp",
    });
    expect(builtInIntegrationDuplicated(learn, [outlook, learn])).toBeNull();
  });

  test("a plugin whose homepage is the domain of a Nango integration stays listed", () => {
    const backends = effectiveNangoIntegrations(
      [
        setting("github", {
          displayName: "GitHub",
          tools: { source: "nango" },
          accountIdentity: { url: "https://api.github.com/user", field: "login" },
        }),
      ],
      true,
    );
    const settings = applyNangoBackendsToSettings(testSettings({ mcpServers: [] }), backends);
    const github = configuredMcpCatalogItems(settings, backends)[0]!;
    expect(github.metadata.serviceDomain).toBe("github.com");
    const homepagePlugin = CapabilityCatalogItem.parse({
      id: "plugin:marketplace/acme/triage",
      kind: "plugin",
      source: "public_registry",
      name: "Triage",
      description: "",
      surfaceType: "plugin_package",
      authKind: "none",
      enabled: false,
      providerDomain: "github.com",
      metadata: { skills: ["triage"], mcpEndpoints: [] },
    });
    expect(builtInIntegrationDuplicated(homepagePlugin, [github, homepagePlugin])).toBeNull();
  });

  test("a registry entry turned on in this workspace stays listed", () => {
    const installed = { ...registryGmail, enabled: true };
    expect(builtInIntegrationDuplicated(installed, [configuredGmail, installed])).toBeNull();
  });
});

describe("built-in integrations the organization turned off", () => {
  const restricted = { mode: "restricted" as const, allowedIntegrationKeys: ["custom:mcp"] };

  test("say the integration is turned off when the policy leaves its key out", () => {
    expect(builtInIntegrationTurnedOffDetail(registryGmail, restricted)).toContain(
      "Gmail is turned off for this organization",
    );
    expect(builtInIntegrationTurnedOffDetail(configuredGmail, restricted)).toContain(
      "turned off for this organization",
    );
    const x = socialItems(true).find((entry) => entry.metadata.provider === "x")!;
    expect(builtInIntegrationTurnedOffDetail(x, restricted)).toContain("turned off");
  });

  test("allowed, unrestricted, or not a built-in integration: nothing to say", () => {
    expect(
      builtInIntegrationTurnedOffDetail(registryGmail, {
        mode: "restricted",
        allowedIntegrationKeys: ["gmail"],
      }),
    ).toBeNull();
    expect(
      builtInIntegrationTurnedOffDetail(registryGmail, {
        mode: "unrestricted",
        allowedIntegrationKeys: [],
      }),
    ).toBeNull();
    expect(builtInIntegrationTurnedOffDetail(registryLinear, restricted)).toBeNull();
  });
});

describe("connector setup gates", () => {
  const settings = testSettings({ googleConnectorSetupEnabled: false });
  const noClient = () => false;
  const drive = item({
    id: "mcp:integrations-sh:drivemcp-googleapis-com-0",
    name: "Google Drive",
    mcpUrl: DRIVE_MCP,
    endpointUrl: DRIVE_MCP,
    authKind: "oauth2",
    metadata: { oauthClientRequirement: { issuer: "https://accounts.google.com" } },
  });

  test("a Google connector Nango serves is connectable without this deployment's Google setup", () => {
    const backends = effectiveNangoIntegrations([setting("google-drive"), setting("gmail")], true);
    expect(applyConnectorSetupGates(drive, settings, noClient, backends)).toBe(drive);
    expect(applyConnectorSetupGates(registryGmail, settings, noClient, backends)).toBe(
      registryGmail,
    );
  });

  test("a native Google connector keeps its setup gates", () => {
    const gated = applyConnectorSetupGates(drive, settings, noClient, new Map());
    expect(gated.runtime.operatorOAuthClient).toEqual({ configured: false });
    const gmail = applyConnectorSetupGates(registryGmail, settings, noClient, new Map());
    expect(gmail.runtime.operatorOAuthClient).toEqual({ configured: false });
  });
});

describe("a custom sign-in to a built-in integration's endpoint", () => {
  test("is that built-in by another route", () => {
    expect(builtInIntegrationDuplicatedByEndpoint(GMAIL_MCP, undefined)).toEqual({
      key: "gmail",
      label: "Gmail",
    });
    expect(builtInIntegrationDuplicatedByEndpoint(DRIVE_MCP, null)).toEqual({
      key: "google-drive",
      label: "Google Drive",
    });
    expect(
      builtInIntegrationDuplicatedByEndpoint("https://calendarmcp.googleapis.com/mcp/v1", null)
        ?.key,
    ).toBe("google-calendar");
  });

  test("not when it is the built-in itself, or another endpoint", () => {
    expect(builtInIntegrationDuplicatedByEndpoint(DRIVE_MCP, "google-drive")).toBeNull();
    expect(builtInIntegrationDuplicatedByEndpoint("https://mcp.linear.app/mcp", null)).toBeNull();
    expect(builtInIntegrationDuplicatedByEndpoint("not a url", null)).toBeNull();
    expect(builtInIntegrationDuplicatedByEndpoint(undefined, null)).toBeNull();
  });
});

function plugin(metadata: Record<string, unknown>, enabled = false): CapabilityCatalogItem {
  return CapabilityCatalogItem.parse({
    id: "plugin:marketplace/test/plugin",
    kind: "plugin",
    source: "public_registry",
    name: "Mail plugin",
    description: "",
    surfaceType: "plugin_package",
    authKind: "none",
    enabled,
    metadata,
  });
}

describe("plugins that are only a built-in integration", () => {
  const gmail = "https://gmailmcp.googleapis.com/mcp/v1";
  const restricted = { mode: "restricted" as const, allowedIntegrationKeys: ["custom:mcp"] };

  test("a plugin of only Gmail's reviewed endpoint is turned off with Gmail", () => {
    const mailPlugin = plugin({ skills: [], mcpEndpoints: [gmail] });
    expect(pluginBuiltInIntegrationKeys(mailPlugin)).toEqual(["gmail"]);
    expect(builtInIntegrationTurnedOffDetail(mailPlugin, restricted)).toContain(
      "Mail plugin is turned off for this organization",
    );
    expect(
      builtInIntegrationTurnedOffDetail(mailPlugin, {
        mode: "restricted",
        allowedIntegrationKeys: ["gmail"],
      }),
    ).toBeNull();
    expect(
      builtInIntegrationTurnedOffDetail(mailPlugin, {
        mode: "unrestricted",
        allowedIntegrationKeys: [],
      }),
    ).toBeNull();
  });

  test("plugins that add something else, or are installed, are not decided by the policy", () => {
    expect(
      pluginBuiltInIntegrationKeys(plugin({ skills: ["triage"], mcpEndpoints: [gmail] })),
    ).toBe(null);
    expect(
      pluginBuiltInIntegrationKeys(
        plugin({ skills: [], mcpEndpoints: [gmail, "https://mcp.example.com/mcp"] }),
      ),
    ).toBeNull();
    expect(pluginBuiltInIntegrationKeys(plugin({ skills: [], mcpEndpoints: [gmail] }, true))).toBe(
      null,
    );
  });
});
