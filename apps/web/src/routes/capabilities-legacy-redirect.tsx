import { Navigate } from "@tanstack/react-router";
import { slackSettingsSearch } from "@/lib/slack-settings-search";

/** Keep provider callback handling out of the eager session route graph. */
export function CapabilitiesLegacyRedirect({
  workspaceId,
  section,
}: {
  workspaceId: string;
  section?: "packs" | "skills";
}) {
  const callback = slackSettingsSearch(
    Object.fromEntries(new URLSearchParams(window.location.search)),
  );
  return (
    <Navigate
      to="/workspaces/$workspaceId/plugins"
      params={{ workspaceId }}
      search={{ ...(section ? { section } : {}), ...callback }}
      replace
    />
  );
}
