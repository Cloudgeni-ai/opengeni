import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { UsageDashboard } from "@/components/insights/usage-dashboard";
import { parseUsageSearch, type UsageSearch } from "@/components/insights/usage-search";
import { ContentPage } from "@/components/ui/content-layout";
import { PageHeader } from "@/components/ui/page-header";
import { workspaceSessionPath } from "@/lib/routes";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";

/**
 * Organization settings > Insights: the workspace Insights dashboard across
 * every workspace in the organization, with a workspace filter and group-by.
 * Other people's private chats and Personal workspaces count as amounts only.
 */
export function OrganizationInsightsPage(props: {
  organizationId: string;
  organizationName: string;
  /** The workspace the URL is anchored on; its catalog names the models. */
  anchorWorkspaceId: string;
  canRead: boolean;
  search: Record<string, string>;
  onSearchChange: (next: UsageSearch) => void;
}) {
  const navigate = useNavigate();
  const search = useMemo(() => parseUsageSearch(props.search), [props.search]);
  const catalog = useWorkspaceModelCatalog(props.canRead ? props.anchorWorkspaceId : null);
  return (
    <ContentPage width="wide" data-insights className="gap-6">
      <PageHeader
        title="Insights"
        description={`Spend, tokens and model calls across ${props.organizationName}.`}
      />
      {props.canRead ? (
        <UsageDashboard
          scope={{ kind: "organization", accountId: props.organizationId, workspaceId: null }}
          search={search}
          onSearchChange={props.onSearchChange}
          modelLabels={catalog.models}
          onOpenSession={(sessionId, workspaceId) =>
            workspaceId
              ? void navigate({ href: workspaceSessionPath(workspaceId, sessionId) })
              : undefined
          }
          deniedMessage="Only organization owners and billing admins can see Insights. Ask an owner for access."
        />
      ) : (
        <p role="alert" className="text-sm text-fg-muted">
          Only organization owners and billing admins can see Insights. Ask an owner for access.
        </p>
      )}
    </ContentPage>
  );
}
