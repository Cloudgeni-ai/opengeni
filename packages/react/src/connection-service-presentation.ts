import type { ConnectAccount, ConnectProvider } from "@opengeni/connect";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import type { ConnectServiceMessageKey, OpenGeniText } from "./messages/runtime";
import teamsLogo from "./assets/microsoft-teams.svg";
import oneDriveLogo from "./assets/onedrive.svg";
import sharePointLogo from "./assets/sharepoint.svg";
import gmailLogo from "./assets/gmail.ico";
import googleCalendarLogo from "./assets/google-calendar.svg";
import googleDriveLogo from "./assets/google-drive.svg";
import outlookLogo from "./assets/outlook.ico";
import dynamicsLogo from "./assets/dynamics-365.svg";
import { microsoftDynamicsProductForMcpUrl } from "@opengeni/contracts/microsoft-dynamics";

/** Passive service identity only. Never selects an account or grants tool access. */
const services: Record<string, { name: string; logo: string; mcpUrl?: string }> = {
  "google-drive": {
    name: "Google Drive",
    logo: googleDriveLogo,
    mcpUrl: "https://drivemcp.googleapis.com/mcp/v1",
  },
  gmail: { name: "Gmail", logo: gmailLogo, mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1" },
  "google-calendar": {
    name: "Google Calendar",
    logo: googleCalendarLogo,
    mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
  },
  "microsoft-teams": { name: "Microsoft Teams", logo: teamsLogo },
  "microsoft-outlook-mail": { name: "Outlook Mail", logo: outlookLogo },
  "microsoft-outlook-calendar": { name: "Outlook Calendar", logo: outlookLogo },
  "microsoft-outlook-contacts": { name: "Outlook Contacts", logo: outlookLogo },
  "microsoft-onedrive": { name: "OneDrive", logo: oneDriveLogo },
  "microsoft-sharepoint": { name: "SharePoint", logo: sharePointLogo },
};

/**
 * The host's own words for a service (`connectService.<providerId>.name` and
 * `.description` messages), so it reads the same in discovery, connected
 * accounts, sign-in and approval help. Absent when the host supplies none.
 */
export function connectionServiceWording(
  t: OpenGeniText,
  providerId: string,
): { name?: string; description?: string } {
  const lookup = (part: "name" | "description") => {
    const key: ConnectServiceMessageKey = `connectService.${providerId}.${part}`;
    // These keys have no English default, so an unset one comes back as itself.
    const value = (t as unknown as (key: string) => string)(key).trim();
    return value && value !== key ? value : undefined;
  };
  const name = lookup("name");
  const description = lookup("description");
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

/**
 * How a service is shown: the host's name and description when it set them
 * (pass `t`), else the bundled name, else the provider's label.
 */
export function connectionServicePresentation(
  provider: Pick<ConnectProvider, "id" | "label">,
  t?: OpenGeniText,
): { name: string; description: string | null; logo: string | null } {
  const bundled = Object.hasOwn(services, provider.id) ? services[provider.id] : undefined;
  const own = t ? connectionServiceWording(t, provider.id) : {};
  return {
    name: own.name ?? bundled?.name ?? provider.label,
    description: own.description ?? null,
    logo: bundled?.logo ?? null,
  };
}

export function capabilityConnectProviderId(
  item: Partial<Pick<CapabilityCatalogItem, "mcpUrl">>,
): string | undefined {
  return Object.entries(services).find(
    ([, service]) => service.mcpUrl && service.mcpUrl === item.mcpUrl,
  )?.[0];
}

/** The registry id prefix the catalog import gives a service's MCP host. */
function registryCapabilityIdPrefix(mcpUrl: string): string {
  return `mcp:integrations-sh:${new URL(mcpUrl).hostname.replaceAll(".", "-")}-`;
}

/**
 * The bundled mark of a reviewed service, matched by its MCP identity (or the
 * registry id derived from it when a projection omits the URL). These rows
 * have no vendored catalog asset, so without this they show a letter.
 */
export function bundledServiceLogo(
  item: Pick<CapabilityCatalogItem, "id"> & Partial<Pick<CapabilityCatalogItem, "mcpUrl">>,
): string | null {
  // Every Dynamics environment has its own host.
  if (item.mcpUrl && microsoftDynamicsProductForMcpUrl(item.mcpUrl)) return dynamicsLogo;
  for (const service of Object.values(services)) {
    if (!service.mcpUrl) continue;
    if (
      item.mcpUrl === service.mcpUrl ||
      item.id.startsWith(registryCapabilityIdPrefix(service.mcpUrl))
    )
      return service.logo;
  }
  return null;
}

export function accountServiceCapability(account: ConnectAccount, items: CapabilityCatalogItem[]) {
  const exact = items.filter((item) => item.connectionRef?.connectionId === account.id);
  if (exact.length === 1) return exact[0];
  // Presentation may use the service definition even when a personal credential
  // has no workspace installation reference. The account id remains unchanged.
  return items.find((item) => capabilityConnectProviderId(item) === account.providerId);
}

export function isServiceConnectProvider(provider: ConnectProvider): boolean {
  return (
    provider.readiness === "available" &&
    provider.ownership.length > 0 &&
    provider.family !== "mcp" &&
    !provider.setup.some((kind) => ["installation", "openapi", "graphql"].includes(kind))
  );
}
