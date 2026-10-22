import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { InsightsSiteUsageQuery } from "@opengeni/contracts/insights-usage";

import { Section } from "@opengeni/react/ui/section";

import { SiteAiUsageTable, useSiteAiUsage } from "./site-ai-usage-section";
import { SitePlatformUsageView, useSitePlatformUsage } from "./site-platform-usage-section";

/**
 * Insights > Sites: model costs by Site for the selected range, then this
 * month's platform activity. Flat on the page like Breakdown, never a card in a
 * card; the heading appears once something has loaded.
 */
export function SitesUsageSection({
  client,
  workspaceId,
  range,
}: {
  client: Pick<OpenGeniBrowserClient, "getWorkspaceInsightsSiteUsage" | "getSitePlatformUsage">;
  workspaceId: string;
  /** `null` for a custom range, which model costs by Site can't follow. */
  range: InsightsSiteUsageQuery["range"] | null;
}) {
  const models = useSiteAiUsage(client, workspaceId, range);
  const platform = useSitePlatformUsage(client, workspaceId);
  const showModels = models.state === "ready" || models.state === "failed";
  const showPlatform = platform.state === "ready" || platform.state === "failed";
  if (!showModels && !showPlatform) return null;
  return (
    // `open` even inside the settings shell, whose default `group` would box it.
    <Section title="Sites" variant="open" contentClassName="gap-6">
      {models.state === "ready" ? (
        <SiteAiUsageTable usage={models.usage} />
      ) : models.state === "failed" ? (
        <p className="text-sm text-fg-muted">Couldn't load Site model costs.</p>
      ) : null}
      {platform.state === "ready" ? (
        <SitePlatformUsageView usage={platform.usage} />
      ) : platform.state === "failed" ? (
        <p className="text-sm text-fg-muted">Couldn't load Site platform activity.</p>
      ) : null}
    </Section>
  );
}
