import type { ConnectionCatalogService } from "@opengeni/react/connect";
import { capabilityCuration } from "@/lib/capabilities";
import type { CapabilityCatalogItem } from "@/types";

/** Partition already-grouped services in the same order shown on the page. */
export function partitionConnectionServices(
  services: ConnectionCatalogService[],
  showFeatured: boolean,
  featured: readonly CapabilityCatalogItem[],
  integrationIds: readonly string[],
  connectors: readonly CapabilityCatalogItem[],
) {
  const featuredServiceIds = showFeatured
    ? [
        ...new Set([
          ...featured.map(
            (item) => catalogServiceIdentity(item.id, item.name, item.providerDomain).id,
          ),
          ...integrationIds,
          ...connectors
            .filter(
              (item) =>
                capabilityCuration(item).curated ||
                item.id === "api:fiken" ||
                ["dropbox.com", "front.com"].includes(item.providerDomain ?? ""),
            )
            .map((item) => catalogServiceIdentity(item.id, item.name, item.providerDomain).id),
        ]),
      ]
    : [];
  return {
    featuredServices: featuredServiceIds.flatMap(
      (id) => services.find((service) => service.id === id) ?? [],
    ),
    remainingServices: services.filter((service) => !featuredServiceIds.includes(service.id)),
  };
}

/** Deliberate product identities. Unrecognized providers retain their own ID;
 * display-name similarity must never silently merge distinct services. */
const identities: Record<string, { id: string; name: string }> = {
  "slack.com": { id: "slack", name: "Slack" },
  "github.com": { id: "github", name: "GitHub" },
  "atlassian.com": { id: "atlassian", name: "Jira & Confluence" },
  "jira.com": { id: "atlassian", name: "Jira & Confluence" },
};
export function catalogServiceIdentity(
  id: string,
  name: string,
  providerDomain: string | null | undefined,
) {
  return identities[providerDomain?.toLowerCase() ?? ""] ?? { id, name };
}
export function mergeConnectionServices(
  entries: ConnectionCatalogService[],
): ConnectionCatalogService[] {
  const services = new Map<string, ConnectionCatalogService>();
  for (const entry of entries) {
    const previous = services.get(entry.id);
    services.set(
      entry.id,
      previous
        ? {
            ...previous,
            options: [
              ...previous.options,
              ...entry.options.filter(
                (option) => !previous.options.some((existing) => existing.id === option.id),
              ),
            ],
          }
        : { ...entry, options: [...entry.options] },
    );
  }
  return [...services.values()];
}
