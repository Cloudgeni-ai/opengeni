// Route assembly only — components live under src/routes, shared state in
// src/context.tsx, logic in src/lib. Route map:
//   /                                        → default-workspace redirect
//   /workspaces/:id                          → sessions redirect
//   /workspaces/:id/agent                    → sessions redirect (legacy URL)
//   /workspaces/:id/sessions                 → sessions index + create
//   /workspaces/:id/sessions/:sessionId      → session view (queue/goal rail)
//   /workspaces/:id/environments             → environments + variables
//   /workspaces/:id/packs                    → redirect to capabilities (Packs subsection)
//   /workspaces/:id/capabilities             → capability catalog + registry (incl. Packs subsection)
//   /workspaces/:id/schedules                → scheduled tasks + run history
//   /workspaces/:id/documents                → document bases + search
//   /workspaces/:id/account                  → account, usage, API keys
import {
  Navigate,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { ProblemPanel } from "@/components/common";
import { RootRouteComponent, useAppContext } from "@/context";
import { AccountRoute } from "@/routes/account";
import { CapabilitiesRoute } from "@/routes/capabilities";
import { DocumentsRoute } from "@/routes/documents";
import { EnvironmentsRoute } from "@/routes/environments";
import { SchedulesRoute } from "@/routes/schedules";
import { SessionRoute } from "@/routes/session";
import { SessionsIndexRoute } from "@/routes/sessions-index";
import { WorkspaceShellRoute } from "@/routes/workspace";

export { workspaceAgentPath, workspaceSessionPath, workspaceSessionsPath } from "@/lib/routes";

const rootRoute = createRootRoute({
  component: RootRouteComponent,
  notFoundComponent: NotFoundRoute,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RootIndexRoute,
});
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "workspaces/$workspaceId",
  component: WorkspaceShell,
});
const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/",
  component: WorkspaceIndexRedirect,
});
// Legacy URL from the previous console layout.
const workspaceAgentRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "agent",
  component: WorkspaceIndexRedirect,
});
const workspaceSessionsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "sessions",
  component: SessionsIndex,
});
const workspaceSessionRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "sessions/$sessionId",
  component: SessionView,
});
const workspaceEnvironmentsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "environments",
  component: Environments,
});
// Legacy standalone Packs route: packs are now a subsection of Capabilities,
// so this redirects there (focusing the Packs subsection) instead of mounting
// a separate page.
const workspacePacksRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "packs",
  component: PacksRedirect,
});
const workspaceCapabilitiesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "capabilities",
  // `?section=packs` focuses the Packs subsection (used by the legacy
  // /packs redirect and the nav). Unknown values fall back to the catalog.
  validateSearch: (search: Record<string, unknown>): { section?: "packs" } =>
    search.section === "packs" ? { section: "packs" } : {},
  component: Capabilities,
});
const workspaceSchedulesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "schedules",
  component: Schedules,
});
const workspaceDocumentsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "documents",
  component: Documents,
});
const workspaceAccountRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "account",
  component: Account,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  workspaceRoute.addChildren([
    workspaceIndexRoute,
    workspaceAgentRoute,
    workspaceSessionsRoute,
    workspaceSessionRoute,
    workspaceEnvironmentsRoute,
    workspacePacksRoute,
    workspaceCapabilitiesRoute,
    workspaceSchedulesRoute,
    workspaceDocumentsRoute,
    workspaceAccountRoute,
  ]),
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}

function RootIndexRoute() {
  const context = useAppContext();
  const workspaceId = context.accessContext.defaultWorkspaceId ?? context.workspaces[0]?.id ?? context.accessContext.workspaceGrants[0]?.workspaceId;
  if (!workspaceId) {
    return <ProblemPanel title="No workspace access" description="This subject does not have access to any OpenGeni workspace." />;
  }
  return <Navigate to="/workspaces/$workspaceId/sessions" params={{ workspaceId }} replace />;
}

function WorkspaceIndexRedirect() {
  const { workspaceId } = workspaceRoute.useParams();
  return <Navigate to="/workspaces/$workspaceId/sessions" params={{ workspaceId }} replace />;
}

function WorkspaceShell() {
  const { workspaceId } = workspaceRoute.useParams();
  return <WorkspaceShellRoute workspaceId={workspaceId} />;
}

function SessionsIndex() {
  const { workspaceId } = workspaceSessionsRoute.useParams();
  return <SessionsIndexRoute workspaceId={workspaceId} />;
}

function SessionView() {
  const { workspaceId, sessionId } = workspaceSessionRoute.useParams();
  return <SessionRoute workspaceId={workspaceId} sessionId={sessionId} />;
}

function Environments() {
  const { workspaceId } = workspaceEnvironmentsRoute.useParams();
  return <EnvironmentsRoute workspaceId={workspaceId} />;
}

function PacksRedirect() {
  const { workspaceId } = workspacePacksRoute.useParams();
  return (
    <Navigate
      to="/workspaces/$workspaceId/capabilities"
      params={{ workspaceId }}
      search={{ section: "packs" }}
      replace
    />
  );
}

function Capabilities() {
  const { workspaceId } = workspaceCapabilitiesRoute.useParams();
  const { section } = workspaceCapabilitiesRoute.useSearch();
  return <CapabilitiesRoute workspaceId={workspaceId} initialSection={section} />;
}

function Schedules() {
  const { workspaceId } = workspaceSchedulesRoute.useParams();
  return <SchedulesRoute workspaceId={workspaceId} />;
}

function Documents() {
  const { workspaceId } = workspaceDocumentsRoute.useParams();
  return <DocumentsRoute workspaceId={workspaceId} />;
}

function Account() {
  const { workspaceId } = workspaceAccountRoute.useParams();
  return <AccountRoute workspaceId={workspaceId} />;
}

function NotFoundRoute() {
  return <ProblemPanel title="Page not found" description="This OpenGeni console route does not exist. Workspace-scoped URLs are required." />;
}
