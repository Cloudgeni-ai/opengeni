import type { ConnectAccount, ConnectProvider } from "@opengeni/connect";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import gmailLogo from "./assets/gmail.ico";
import outlookLogo from "./assets/outlook.ico";

/** Passive service identity only. Never selects an account or grants tool access. */
const services: Record<string, { name: string; logo: string; mcpUrl?: string }> = {
  gmail: { name: "Gmail", logo: gmailLogo, mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1" },
  "microsoft-outlook-mail": { name: "Outlook Mail", logo: outlookLogo },
  "microsoft-outlook-calendar": { name: "Outlook Calendar", logo: outlookLogo },
  "microsoft-outlook-contacts": { name: "Outlook Contacts", logo: outlookLogo },
};

export function connectionServicePresentation(provider: Pick<ConnectProvider, "id" | "label">) {
  return (
    (Object.hasOwn(services, provider.id) ? services[provider.id] : undefined) ?? {
      name: provider.label,
      logo: null,
    }
  );
}

export function capabilityConnectProviderId(
  item: Partial<Pick<CapabilityCatalogItem, "mcpUrl">>,
): string | undefined {
  return Object.entries(services).find(
    ([, service]) => service.mcpUrl && service.mcpUrl === item.mcpUrl,
  )?.[0];
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
