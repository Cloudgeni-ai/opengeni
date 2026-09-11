import type { ConnectionCatalogService } from "@opengeni/react/connect";

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
