import type { SitePublishPageProps } from "./site-publishing";
import type { SiteManagement } from "./site-settings";

/**
 * The publish form's wiring from a Site's management. The Site's Settings tab
 * and the Site view's Publish both use it, so the two forms can't drift apart.
 */
export function sitePublishFormProps(
  management: Pick<
    SiteManagement,
    "workspaceName" | "isAdmin" | "showAudience" | "publication" | "audience"
  >,
  {
    client,
    workspaceId,
    site,
    sites,
  }: Pick<SitePublishPageProps, "client" | "workspaceId" | "site" | "sites">,
) {
  return {
    client,
    workspaceId,
    site,
    sites,
    workspaceName: management.workspaceName,
    load: management.publication.load,
    onReload: () => void management.publication.reload(),
    isAdmin: management.isAdmin,
    onShareWithWorkspace: management.showAudience ? management.audience.share : undefined,
    // A Personal workspace has no audience: Only me and the workspace are one person.
    personalWorkspace: !management.showAudience,
  } satisfies Partial<SitePublishPageProps>;
}
