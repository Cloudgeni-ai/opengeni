import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Toaster } from "../src/components/ui/sonner";
import { ArtifactDetailRoute } from "../src/routes/artifacts";
import { SitePlatformUsageSection } from "../src/components/usage/site-platform-usage-section";
import { SectionStack } from "../src/components/ui/section";
import { SiteAuthorizeRoute } from "../src/routes/site-auth";
import { artifactReturnSearch } from "../src/lib/routes";
import { siteAuthSearch } from "../src/lib/site-auth";
import { client, scenario, siteId, workspaceId } from "./site-publishing-context";
import "../src/styles.css";

const root = createRootRoute({
  component: () => (
    <main data-canvas className="flex h-dvh min-w-0 flex-col bg-bg text-fg">
      <Outlet />
      <Toaster />
    </main>
  ),
});
const site = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts/$artifactId",
  validateSearch: artifactReturnSearch,
  component: () => <ArtifactDetailRoute {...site.useParams()} />,
});
// Workspace settings > Usage, the published Sites section alone (the agent
// budget sections above it are covered by their own previews).
const usage = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/settings/usage",
  component: () => (
    <div className="mx-auto w-full max-w-3xl px-6 py-8 max-sm:px-4">
      <SectionStack>
        <SitePlatformUsageSection client={client} workspaceId={workspaceId} />
      </SectionStack>
    </div>
  ),
});
const library = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts",
  validateSearch: artifactReturnSearch,
  component: () => null,
});
const siteAuth = createRoute({
  getParentRoute: () => root,
  path: "/site-auth/authorize",
  validateSearch: siteAuthSearch,
  component: () => <SiteAuthorizeRoute search={siteAuth.useSearch()} />,
});

const host = "team-crm-4k9x.opengeni.site";
const authQuery = new URLSearchParams({
  host,
  state: "sample-state-0123456789abcdef",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  redirect_uri: `https://${host}/_og/auth/callback`,
  return: "/",
});
const sitePath = `/workspaces/${workspaceId}/artifacts/${siteId}`;
const initial = scenario.startsWith("auth")
  ? `/site-auth/authorize?${authQuery}`
  : scenario === "site"
    ? sitePath
    : scenario.startsWith("usage")
      ? `/workspaces/${workspaceId}/settings/usage`
      : `${sitePath}?view=publish`;
const router = createRouter({
  routeTree: root.addChildren([site, usage, library, siteAuth]),
  history: createMemoryHistory({ initialEntries: [initial] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
