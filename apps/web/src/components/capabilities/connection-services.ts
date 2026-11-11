import {
  attentionFirst,
  connectionOptionNeedsAttention,
  type ConnectionCatalogService,
} from "@opengeni/react/connect";
import { capabilityCuration } from "@opengeni/react/app/lib/capabilities";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";

/**
 * One row per provider. A provider with several options becomes a single row
 * that opens its own page; that row needs attention when any option does.
 */
export function collapseConnectionService(
  service: ConnectionCatalogService,
  row: { description?: string | undefined; onOpen: () => void },
): ConnectionCatalogService {
  if (service.options.length < 2) return service;
  const attention = service.options.find(connectionOptionNeedsAttention);
  const working = service.options.some((option) => option.state === "loading");
  const connected = service.options.some((option) => option.connected);
  return {
    ...service,
    options: [
      {
        id: service.id,
        name: service.name,
        description: row.description,
        status: attention?.status ?? (connected ? "Connected" : "Not connected"),
        state: attention
          ? ("attention" as const)
          : working
            ? ("loading" as const)
            : connected
              ? ("added" as const)
              : ("available" as const),
        connected,
        onOpen: row.onOpen,
      },
    ],
  };
}

/**
 * The Connected section: everything connected or needing attention, with
 * anything that needs attention first so neither the short preview nor the
 * full list hides a problem further down.
 */
export function connectedConnectionServices(
  services: readonly ConnectionCatalogService[],
): ConnectionCatalogService[] {
  return attentionFirst(
    services.filter((service) =>
      service.options.some((option) => option.connected || connectionOptionNeedsAttention(option)),
    ),
  );
}

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
                item.id === "api:1password" ||
                item.id === "api:excel-addin" ||
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
