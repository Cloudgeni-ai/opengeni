import type { ConnectProvider } from "@opengeni/connect";
import type { CapabilityCatalogItem, ConnectionMetadata, SocialConnection } from "@/types";
import type { IntegrationViewModel } from "./integration-view-model";

export type NativeConnectCatalog =
  | { status: "loading" | "error"; providers: [] }
  | { status: "ready"; providers: ConnectProvider[] };

export function nativeProviderAvailable(
  catalog: NativeConnectCatalog,
  providerId: string,
): boolean {
  return (
    catalog.status === "ready" &&
    catalog.providers.some(
      (provider) => provider.id === providerId && provider.readiness === "available",
    )
  );
}

/** Only these exact built-in endpoints use native provider setup prerequisites.
 * A similarly named catalog entry or a custom MCP server keeps its own flow. */
export function nativeCatalogProviderId(
  item: Pick<CapabilityCatalogItem, "kind" | "mcpUrl" | "endpointUrl" | "surfaceType" | "metadata">,
): string | null {
  if (item.surfaceType === "first_party_fiken") return "fiken-token";
  if (
    item.surfaceType === "first_party_social" ||
    (item.surfaceType === "provider_integration" && item.metadata.providerAdapter === "social")
  ) {
    if (item.metadata.provider === "x" || item.metadata.provider === "reddit")
      return item.metadata.provider;
  }
  if (item.kind !== "mcp") return null;
  const url = item.mcpUrl ?? item.endpointUrl;
  if (url === "https://gmailmcp.googleapis.com/mcp/v1") return "gmail";
  if (url === "https://mcp.slack.com/mcp") return "slack-personal";
  return null;
}

export function nativeSetupNotice(
  catalog: NativeConnectCatalog,
  providerId: string,
  retry: () => void,
): IntegrationViewModel["notice"] {
  if (nativeProviderAvailable(catalog, providerId)) return undefined;
  if (catalog.status === "loading")
    return {
      tone: "muted",
      title: "Checking connection availability…",
      description: "Setup will be available after this check finishes.",
    };
  if (catalog.status === "error")
    return {
      tone: "failed",
      title: "Couldn't check connection availability",
      description: "Try again to see whether you can connect here.",
      action: { label: "Retry", onClick: retry },
    };
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  return {
    tone: "muted",
    title: "This connection isn't available here",
    description:
      provider?.reason ??
      "This deployment or your current access doesn't support setting up this connection.",
  };
}

/** The stock Figma listing only accepts approved MCP clients. Preserve
 * configured/manual servers and already-enabled connection management. */
function restrictedStockFigma(item: CapabilityCatalogItem): boolean {
  return (
    item.kind === "mcp" &&
    item.source === "registry" &&
    item.mcpUrl === "https://mcp.figma.com/mcp" &&
    !item.enabled
  );
}

export type NativeConnectionFacts = {
  connections: ConnectionMetadata[] | null;
  socialConnections: SocialConnection[];
};

/** A credential can be saved before MCP installation/probing completes. The
 * visible account facts, including disabled history, must keep management
 * reachable without pretending the catalog entry was enabled. */
function hasCatalogAccount(item: CapabilityCatalogItem, facts?: NativeConnectionFacts): boolean {
  if (item.enabled) return true;
  if (!facts) return false;
  const providerId = nativeCatalogProviderId(item);
  if (providerId === "x" || providerId === "reddit") {
    return facts.socialConnections.some((connection) => connection.provider === providerId);
  }
  if (providerId === "fiken-token") {
    return (facts.connections ?? []).some(
      (connection) =>
        connection.subjectId === null &&
        (connection.kind === "oauth2" || connection.kind === "api_key") &&
        connection.providerDomain === "fiken.no" &&
        connection.metadata.credentialRole === "fiken_api_token",
    );
  }
  const url = item.mcpUrl ?? item.endpointUrl;
  return (facts.connections ?? []).some(
    (connection) =>
      connection.id === item.connectionRef?.connectionId ||
      (url !== null && url !== undefined && connection.metadata.mcpUrl === url),
  );
}

export function nativeCatalogItemNotice(
  item: CapabilityCatalogItem,
  catalog: NativeConnectCatalog,
  retry: () => void,
  facts?: NativeConnectionFacts,
): IntegrationViewModel["notice"] {
  if (hasCatalogAccount(item, facts)) return undefined;
  if (restrictedStockFigma(item))
    return {
      tone: "muted",
      title: "Figma requires an approved client",
      description:
        "Figma's hosted MCP server only accepts approved clients. Opengeni isn't currently listed, so this catalog connection is unavailable.",
    };
  const providerId = nativeCatalogProviderId(item);
  if (!providerId || item.enabled) return undefined;
  if (providerId === "fiken-token" && nativeProviderAvailable(catalog, "fiken-oauth"))
    return undefined;
  return nativeSetupNotice(catalog, providerId, retry);
}

export function nativeCatalogItemVisible(
  item: CapabilityCatalogItem,
  catalog: NativeConnectCatalog,
  facts?: NativeConnectionFacts,
): boolean {
  if (hasCatalogAccount(item, facts)) return true;
  // An unavailable metadata read cannot prove that a previous account vanished.
  if (facts?.connections === null && (nativeCatalogProviderId(item) || restrictedStockFigma(item)))
    return true;
  if (restrictedStockFigma(item)) return false;
  const providerId = nativeCatalogProviderId(item);
  return (
    !providerId ||
    item.enabled ||
    nativeProviderAvailable(catalog, providerId) ||
    (providerId === "fiken-token" && nativeProviderAvailable(catalog, "fiken-oauth"))
  );
}

/** Connection facts alone can describe an unconfigured server. They are not
 * evidence of an existing account or installation. */
function hasManagedConnection(model: IntegrationViewModel): boolean {
  return (
    model.access !== undefined ||
    model.footer.kind === "connected" ||
    model.footer.kind === "repair" ||
    ["Connected", "Needs attention", "Retired"].includes(model.chip.label)
  );
}

function primaryProviderId(modelId: string, slackBotMode: boolean): string | null {
  switch (modelId) {
    case "slack":
      return slackBotMode ? "slack-bot" : "slack-personal";
    case "github":
      return "github-app";
    case "google-drive":
      return "google-drive-knowledge";
    case "outlook-mail":
      return "microsoft-outlook-mail";
    case "outlook-calendar":
      return "microsoft-outlook-calendar";
    case "outlook-contacts":
      return "microsoft-outlook-contacts";
    case "onedrive":
      return "microsoft-onedrive";
    // Historical native Atlassian is absent from the Connect catalog but still
    // owns a disconnect surface. Unknown/custom providers keep their own flow.
    default:
      return null;
  }
}

export function nativeIntegrationVisible(
  model: IntegrationViewModel,
  catalog: NativeConnectCatalog,
  slackBotMode: boolean,
): boolean {
  const providerId = primaryProviderId(model.id, slackBotMode);
  return (
    !providerId ||
    hasManagedConnection(model) ||
    model.chip.label === "Loading" ||
    nativeProviderAvailable(catalog, providerId) ||
    (model.id === "github" && nativeProviderAvailable(catalog, "github-personal"))
  );
}

/** Guard setup separately from management: an existing account may still be
 * removed or repaired when starting a new provider connection is unavailable. */
export function nativeIntegrationModel(
  model: IntegrationViewModel,
  catalog: NativeConnectCatalog,
  slackBotMode: boolean,
  retry: () => void,
): IntegrationViewModel {
  const providerId = primaryProviderId(model.id, slackBotMode);
  if (!providerId) return model;
  const managed = hasManagedConnection(model);
  const available = nativeProviderAvailable(catalog, providerId);
  const options = model.options.filter((option) => {
    if (
      model.id === "github" &&
      option.id === "github-personal-identity" &&
      option.kind === "link" &&
      option.action.label === "Connect"
    ) {
      return nativeProviderAvailable(catalog, "github-personal");
    }
    if (
      model.id === "google-drive" &&
      option.id === "google-drive-publish" &&
      option.kind === "toggle" &&
      !option.checked
    ) {
      return nativeProviderAvailable(catalog, "google-drive-publish");
    }
    return true;
  });
  const accountProviderId = model.id === "google-drive" ? "google-drive" : providerId;
  const access =
    model.access?.editLabel === "Add account" &&
    !nativeProviderAvailable(catalog, accountProviderId)
      ? { ...model.access, editLabel: undefined, onEdit: undefined }
      : model.access;
  let footer = model.footer;
  let blockedSetup = false;
  if (!available && footer.kind === "setup") {
    footer = { kind: "locked", message: "" };
    blockedSetup = true;
  } else if (
    !available &&
    model.id === "github" &&
    footer.kind === "actions" &&
    footer.primary &&
    (!model.access || footer.primary.label === "Connect another account")
  ) {
    // Personal GitHub can be connected before the workspace App is installed.
    footer = footer.secondary ? { ...footer, primary: undefined } : { kind: "locked", message: "" };
    blockedSetup = true;
  }
  const blockedFresh = !available && !managed;
  return {
    ...model,
    options,
    ...(access ? { access } : {}),
    footer,
    ...(blockedFresh && model.chip.label !== "Loading"
      ? {
          chip: { label: catalog.status === "loading" ? "Loading" : "Unavailable", tone: "plain" },
        }
      : {}),
    ...(blockedFresh || blockedSetup
      ? { notice: nativeSetupNotice(catalog, providerId, retry) }
      : {}),
  };
}
