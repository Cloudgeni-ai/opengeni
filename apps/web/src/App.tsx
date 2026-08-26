// Route assembly only — components live under src/routes, shared state in
// src/context.tsx, logic in src/lib. Route map:
//   /                                        → default-workspace redirect
//   /workspaces/:id                          → sessions redirect
//   /workspaces/:id/agent                    → sessions redirect (legacy URL)
//   /workspaces/:id/sessions                 → sessions index + create
//   /workspaces/:id/sessions/:sessionId      → session view (queue/goal rail)
//   /workspaces/:id/priority                 → "For you" priority feed (agent-time-lost ledger)
//   /workspaces/:id/agents                   → workspace agent topology
//   /sessions/:sessionId                     → authorized compatibility redirect
//   /workspaces/:id/variable-sets            → variable sets + variables
//   /workspaces/:id/rigs                     → rigs list + create
//   /workspaces/:id/rigs/:rigId              → rig detail (overview/setup/versions/changes)
//   /workspaces/:id/packs                    → redirect to plugins (Packs subsection)
//   /workspaces/:id/plugins                  → plugin catalog + registry (incl. Packs subsection)
//   /workspaces/:id/capabilities             → legacy redirect to /plugins
//   /workspaces/:id/schedules                → scheduled tasks + run history
//   /workspaces/:id/documents                → document bases + search
//   /workspaces/:id/memory                   → durable workspace memory
//   /workspaces/:id/insights                 → workspace insights (admin usage rollup)
//   /workspaces/:id/settings                 → workspace settings (name, API keys, danger zone)
//   /workspaces/:id/organization             → organization settings (billing, usage, plan, members)
//   /workspaces/:id/account                  → legacy redirect to /organization
//   /billing?checkout=success|cancelled      → Stripe return → default organization
//   /device?user_code=…                      → self-hosted enrollment approve page
//   /dev/composer-chrome                     → DEV-only SessionChrome harness (mocked)
//   /dev/agent-topology                      → DEV-only agent tree preview (mocked)
//   /dev/onboarding                          → DEV-only production onboarding components
import {
  Navigate,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { ProblemPanel } from "@/components/common";
import { ROUTER_PENDING_OPTIONS } from "@/components/route-pending";
import { RootRouteComponent, useAppContext } from "@/context";
import { parseComposerLaunchSearch, type ComposerLaunchSearch } from "@/lib/composer-launch";
import { parseCheckoutOutcome, type CheckoutOutcome } from "@/lib/routes";
import type { DocumentAuthorityKind } from "@opengeni/sdk";

type OrganizationAdminSection = "overview" | "knowledge" | "people" | "retention" | "billing";
type WorkspaceSettingsSection =
  | "general"
  | "members"
  | "tools"
  | "plugins"
  | "models"
  | "api-keys"
  | "danger";

export { workspaceAgentPath, workspaceSessionPath, workspaceSessionsPath } from "@/lib/routes";

const LazyCapabilitiesRoute = lazyRouteComponent(
  () => import("@/routes/capabilities"),
  "CapabilitiesRoute",
);
const LazyAgentsRoute = lazyRouteComponent(() => import("@/routes/agents"), "AgentsRoute");
const LazyAgentTopologyPreviewRoute = lazyRouteComponent(
  () => import("@/routes/agents"),
  "AgentTopologyPreviewRoute",
);
const LazyDeviceRoute = lazyRouteComponent(() => import("@/routes/device"), "DeviceRoute");
const LazyDocumentsRoute = lazyRouteComponent(() => import("@/routes/documents"), "DocumentsRoute");
const LazyMemoryRoute = lazyRouteComponent(() => import("@/routes/memory"), "MemoryRoute");
const LazyVariableSetsRoute = lazyRouteComponent(
  () => import("@/routes/variable-sets"),
  "VariableSetsRoute",
);
const LazyMachinesRoute = lazyRouteComponent(() => import("@/routes/machines"), "MachinesRoute");
const LazyInsightsRoute = lazyRouteComponent(() => import("@/routes/insights"), "InsightsRoute");
const LazyPriorityRoute = lazyRouteComponent(() => import("@/routes/priority"), "PriorityRoute");
const LazyOrgSettingsRoute = lazyRouteComponent(
  () => import("@/routes/org-settings"),
  "OrgSettingsRoute",
);
const LazyResetPasswordRoute = lazyRouteComponent(
  () => import("@/routes/reset-password"),
  "ResetPasswordRoute",
);
const LazySetupAccountRoute = lazyRouteComponent(
  () => import("@/routes/setup-account"),
  "SetupAccountRoute",
);
const LazyOnboardingPreviewRoute = lazyRouteComponent(
  () => import("@/routes/onboarding-preview"),
  "OnboardingPreviewRoute",
);
const LazyRigsRoute = lazyRouteComponent(() => import("@/routes/rigs"), "RigsRoute");
const LazyRigDetailRoute = lazyRouteComponent(
  () => import("@/routes/rig-detail"),
  "RigDetailRoute",
);
const LazySchedulesRoute = lazyRouteComponent(() => import("@/routes/schedules"), "SchedulesRoute");
const LazySessionRoute = lazyRouteComponent(() => import("@/routes/session"), "SessionRoute");
const LazySessionDeepLinkRoute = lazyRouteComponent(
  () => import("@/routes/session-deep-link"),
  "SessionDeepLinkRoute",
);
const LazySessionsIndexRoute = lazyRouteComponent(
  () => import("@/routes/sessions-index"),
  "SessionsIndexRoute",
);
const LazyWorkspaceSettingsRoute = lazyRouteComponent(
  () => import("@/routes/workspace-settings"),
  "WorkspaceSettingsRoute",
);
const LazyWorkspaceStateRoute = lazyRouteComponent(
  () => import("@/routes/workspace-state"),
  "WorkspaceStateRoute",
);
const LazyArtifactsRoute = lazyRouteComponent(() => import("@/routes/artifacts"), "ArtifactsRoute");
const LazyEditableArtifactRoute = lazyRouteComponent(
  () => import("@/routes/editable-artifact"),
  "EditableArtifactRoute",
);
const LazyWorkspaceShellRoute = lazyRouteComponent(
  () => import("@/routes/workspace"),
  "WorkspaceShellRoute",
);
const LazyComposerChromeGalleryRoute = lazyRouteComponent(
  () => import("@/routes/composer-chrome"),
  "ComposerChromeGalleryRoute",
);

const rootRoute = createRootRoute({
  component: RootRouteComponent,
  notFoundComponent: NotFoundRoute,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RootIndexRoute,
});
const sessionDeepLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "sessions/$sessionId",
  component: SessionDeepLink,
});
// Stripe checkout return target. The API bakes `/billing?checkout=…` into every
// checkout session's success_url/cancel_url; this top-level route forwards the
// shopper onto their default workspace's organization settings (where the
// balance lives) so the redirect resolves instead of hitting the not-found page.
const billingReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "billing",
  validateSearch: (search: Record<string, unknown>): { checkout?: CheckoutOutcome } => {
    const checkout = parseCheckoutOutcome(search);
    return checkout ? { checkout } : {};
  },
  component: BillingReturnRoute,
});
// Self-hosted device-flow APPROVE page (design 11 §B). Top-level (sibling of
// /billing, NOT workspace-scoped): the agent prints `${origin}/device?user_code=…`
// when it starts an enrollment; the page resolves the owning workspace from the
// code via `lookupDeviceEnrollment`, so no workspace lives in the URL.
const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "device",
  validateSearch: (search: Record<string, unknown>): { user_code?: string } =>
    typeof search.user_code === "string" && search.user_code ? { user_code: search.user_code } : {},
  component: Device,
});
// Password-reset completion page. Top-level and PUBLIC: the emailed link
// (`<PUBLIC_BASE_URL>/reset-password?token=…`) is opened by a signed-out user,
// so `RootRouteComponent` renders this route ahead of the auth gate (see the
// `isPublicAuthRoute` branch there). Only `token` is read from the query.
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "reset-password",
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search.token === "string" && search.token ? { token: search.token } : {},
  component: ResetPassword,
});
const setupAccountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup-account",
  component: SetupAccount,
});
// DEV-only visual harness for the Session composer chrome stack (queue / goal /
// agents / composer). Public so it needs no live auth or session; omitted from
// production route trees.
const composerChromeGalleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "dev/composer-chrome",
  component: ComposerChromeGallery,
});
const agentTopologyPreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "dev/agent-topology",
  component: AgentTopologyPreview,
});
const onboardingPreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "dev/onboarding",
  component: LazyOnboardingPreviewRoute,
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
  validateSearch: (search: Record<string, unknown>): ComposerLaunchSearch =>
    parseComposerLaunchSearch(search),
  component: SessionsIndex,
});
const workspaceSessionRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "sessions/$sessionId",
  validateSearch: (search: Record<string, unknown>): ComposerLaunchSearch =>
    parseComposerLaunchSearch(search),
  component: SessionView,
});
const workspaceAgentsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "agents",
  component: Agents,
});
const workspaceVariableSetsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "variable-sets",
  component: VariableSets,
});
const workspaceEnvironmentsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "environments",
  component: VariableSetsRedirect,
});
const workspaceRigsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "rigs",
  component: Rigs,
});
const workspaceRigDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "rigs/$rigId",
  component: RigDetail,
});
const workspaceMachinesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "machines",
  component: Machines,
});
const workspaceInsightsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "insights",
  component: Insights,
});
const workspacePriorityRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "priority",
  component: Priority,
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
  path: "plugins",
  // `?section=packs` focuses the Packs subsection (used by the legacy
  // /packs redirect and the nav). Unknown values fall back to the catalog.
  validateSearch: (search: Record<string, unknown>): { section?: "packs" } => ({
    ...(search.section === "packs" ? { section: "packs" as const } : {}),
  }),
  component: Capabilities,
});
const workspaceLegacyCapabilitiesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "capabilities",
  validateSearch: (search: Record<string, unknown>): { section?: "packs" } => ({
    ...(search.section === "packs" ? { section: "packs" as const } : {}),
  }),
  component: CapabilitiesLegacyRedirect,
});
const SCHEDULES_SEARCH_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const workspaceSchedulesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "schedules",
  validateSearch: (
    search: Record<string, unknown>,
  ): { sourceSessionId?: string; taskId?: string } => ({
    ...(typeof search.sourceSessionId === "string" &&
    SCHEDULES_SEARCH_UUID.test(search.sourceSessionId)
      ? { sourceSessionId: search.sourceSessionId }
      : {}),
    // Set when arriving from a session that a schedule started, so the page can
    // reveal that one task instead of leaving the reader to find it.
    ...(typeof search.taskId === "string" && SCHEDULES_SEARCH_UUID.test(search.taskId)
      ? { taskId: search.taskId }
      : {}),
  }),
  component: Schedules,
});
const workspaceDocumentsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "documents",
  // Memory used to live inside Documents, so existing timeline links and
  // bookmarks can still carry `?memory=<id>`. Preserve that public URL as a
  // compatibility redirect to the first-class Memory surface.
  validateSearch: (
    search: Record<string, unknown>,
  ): { memory?: string; from?: "brain"; authority?: DocumentAuthorityKind } => ({
    ...(typeof search.memory === "string" ? { memory: search.memory } : {}),
    ...(search.from === "brain" ? { from: "brain" as const } : {}),
    ...(search.authority === "organization" ||
    search.authority === "workspace" ||
    search.authority === "personal"
      ? { authority: search.authority }
      : {}),
  }),
  component: Documents,
});
const workspaceMemoryRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "memory",
  // `?memory=<id>` deep-links a memory record (from a timeline memory step): the
  // Memory page reveals + highlights that record even when the filters would
  // otherwise hide it. Unknown values are ignored.
  validateSearch: (search: Record<string, unknown>): { memory?: string; from?: "brain" } => ({
    ...(typeof search.memory === "string" ? { memory: search.memory } : {}),
    ...(search.from === "brain" ? { from: "brain" as const } : {}),
  }),
  component: Memory,
});
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "settings",
  validateSearch: (search: Record<string, unknown>): { section?: WorkspaceSettingsSection } => {
    const section =
      search.section === "general" ||
      search.section === "members" ||
      search.section === "tools" ||
      search.section === "plugins" ||
      search.section === "models" ||
      search.section === "api-keys" ||
      search.section === "danger"
        ? search.section
        : search.section === "capabilities" || search.section === "permissions"
          ? "tools"
          : undefined;
    return section ? { section } : {};
  },
  component: WorkspaceSettings,
});
const workspaceStateRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "state",
  validateSearch: (search: Record<string, unknown>): { view?: "instructions" | "skills" } =>
    search.view === "instructions" || search.view === "skills" ? { view: search.view } : {},
  component: WorkspaceState,
});
const workspaceArtifactsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "artifacts",
  component: Artifacts,
});
const workspaceArtifactDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "artifacts/$artifactId",
  component: ArtifactDetail,
});
const workspaceEditableArtifactRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "artifacts/editable/$artifactId",
  component: EditableArtifact,
});
const workspaceOrganizationRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "organization",
  // `?checkout=success|cancelled` arrives via the /billing Stripe-return
  // redirect so the organization page can confirm the top-up.
  validateSearch: (
    search: Record<string, unknown>,
  ): { checkout?: CheckoutOutcome; section?: OrganizationAdminSection } => {
    const checkout = parseCheckoutOutcome(search);
    const section =
      search.section === "overview" ||
      search.section === "knowledge" ||
      search.section === "people" ||
      search.section === "retention" ||
      search.section === "billing"
        ? search.section
        : undefined;
    return { ...(checkout ? { checkout } : {}), ...(section ? { section } : {}) };
  },
  component: Organization,
});
// Legacy URL: the old "account" surface is now "organization". Forward, keeping
// the checkout outcome so post-payment confirmations still land.
const workspaceAccountRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "account",
  validateSearch: (search: Record<string, unknown>): { checkout?: CheckoutOutcome } => {
    const checkout = parseCheckoutOutcome(search);
    return checkout ? { checkout } : {};
  },
  component: AccountRedirect,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionDeepLinkRoute,
  billingReturnRoute,
  deviceRoute,
  resetPasswordRoute,
  setupAccountRoute,
  ...(import.meta.env.DEV
    ? [composerChromeGalleryRoute, agentTopologyPreviewRoute, onboardingPreviewRoute]
    : []),
  workspaceRoute.addChildren([
    workspaceIndexRoute,
    workspaceAgentRoute,
    workspaceSessionsRoute,
    workspaceSessionRoute,
    workspaceAgentsRoute,
    workspaceVariableSetsRoute,
    workspaceEnvironmentsRoute,
    workspaceRigsRoute,
    workspaceRigDetailRoute,
    workspaceMachinesRoute,
    workspaceInsightsRoute,
    workspacePriorityRoute,
    workspacePacksRoute,
    workspaceCapabilitiesRoute,
    workspaceLegacyCapabilitiesRoute,
    workspaceSchedulesRoute,
    workspaceDocumentsRoute,
    workspaceMemoryRoute,
    workspaceStateRoute,
    workspaceArtifactsRoute,
    workspaceArtifactDetailRoute,
    workspaceEditableArtifactRoute,
    workspaceSettingsRoute,
    workspaceOrganizationRoute,
    workspaceAccountRoute,
  ]),
]);
// Every match needs its own Suspense boundary. Without a default pending
// component, a cold lazy workspace page suspends through WorkspaceShell and is
// caught only by the root Outlet, briefly replacing the rail along with the
// canvas. The leaf boundary keeps the persistent workspace chrome mounted.
const router = createRouter({ routeTree, ...ROUTER_PENDING_OPTIONS });

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
  const workspaceId =
    context.accessContext.defaultWorkspaceId ??
    context.workspaces[0]?.id ??
    context.accessContext.workspaceGrants[0]?.workspaceId;
  if (!workspaceId) {
    return (
      <ProblemPanel
        title="No workspace access"
        description="You don't have access to any workspace yet."
      />
    );
  }
  return <Navigate to="/workspaces/$workspaceId/sessions" params={{ workspaceId }} replace />;
}

function WorkspaceIndexRedirect() {
  const { workspaceId } = workspaceRoute.useParams();
  return <Navigate to="/workspaces/$workspaceId/sessions" params={{ workspaceId }} replace />;
}

function WorkspaceShell() {
  const { workspaceId } = workspaceRoute.useParams();
  return <LazyWorkspaceShellRoute workspaceId={workspaceId} />;
}

function SessionsIndex() {
  const { workspaceId } = workspaceSessionsRoute.useParams();
  const launch = workspaceSessionsRoute.useSearch();
  return <LazySessionsIndexRoute workspaceId={workspaceId} launch={launch} />;
}

function SessionView() {
  const { workspaceId, sessionId } = workspaceSessionRoute.useParams();
  const launch = workspaceSessionRoute.useSearch();
  return (
    <LazySessionRoute
      workspaceId={workspaceId}
      sessionId={sessionId}
      launch={launch}
      realtimeAutostartModel={launch.realtime}
    />
  );
}

function Agents() {
  const { workspaceId } = workspaceAgentsRoute.useParams();
  return <LazyAgentsRoute workspaceId={workspaceId} />;
}

function SessionDeepLink() {
  const { sessionId } = sessionDeepLinkRoute.useParams();
  return <LazySessionDeepLinkRoute sessionId={sessionId} />;
}

function VariableSets() {
  const { workspaceId } = workspaceVariableSetsRoute.useParams();
  return <LazyVariableSetsRoute workspaceId={workspaceId} />;
}

function VariableSetsRedirect() {
  const { workspaceId } = workspaceEnvironmentsRoute.useParams();
  return <Navigate to="/workspaces/$workspaceId/variable-sets" params={{ workspaceId }} replace />;
}

function Rigs() {
  const { workspaceId } = workspaceRigsRoute.useParams();
  return <LazyRigsRoute workspaceId={workspaceId} />;
}

function RigDetail() {
  const { workspaceId, rigId } = workspaceRigDetailRoute.useParams();
  return <LazyRigDetailRoute workspaceId={workspaceId} rigId={rigId} />;
}

function Machines() {
  const { workspaceId } = workspaceMachinesRoute.useParams();
  return <LazyMachinesRoute workspaceId={workspaceId} />;
}

function Insights() {
  const { workspaceId } = workspaceInsightsRoute.useParams();
  return <LazyInsightsRoute workspaceId={workspaceId} />;
}

function Priority() {
  const { workspaceId } = workspacePriorityRoute.useParams();
  return <LazyPriorityRoute workspaceId={workspaceId} />;
}

function PacksRedirect() {
  const { workspaceId } = workspacePacksRoute.useParams();
  return (
    <Navigate
      to="/workspaces/$workspaceId/plugins"
      params={{ workspaceId }}
      search={{ section: "packs" }}
      replace
    />
  );
}

function CapabilitiesLegacyRedirect() {
  const { workspaceId } = workspaceLegacyCapabilitiesRoute.useParams();
  const { section } = workspaceLegacyCapabilitiesRoute.useSearch();
  return (
    <Navigate
      to="/workspaces/$workspaceId/plugins"
      params={{ workspaceId }}
      search={section ? { section } : {}}
      replace
    />
  );
}

function Capabilities() {
  const { workspaceId } = workspaceCapabilitiesRoute.useParams();
  const { section } = workspaceCapabilitiesRoute.useSearch();
  return <LazyCapabilitiesRoute workspaceId={workspaceId} initialSection={section} />;
}

function Schedules() {
  const { workspaceId } = workspaceSchedulesRoute.useParams();
  const { sourceSessionId, taskId } = workspaceSchedulesRoute.useSearch();
  return (
    <LazySchedulesRoute
      workspaceId={workspaceId}
      sourceSessionId={sourceSessionId}
      focusTaskId={taskId}
    />
  );
}

function Documents() {
  const { workspaceId } = workspaceDocumentsRoute.useParams();
  const { memory, from, authority } = workspaceDocumentsRoute.useSearch();
  if (memory) {
    return (
      <Navigate
        to="/workspaces/$workspaceId/memory"
        params={{ workspaceId }}
        search={{ memory, ...(from ? { from } : {}) }}
        replace
      />
    );
  }
  return (
    <LazyDocumentsRoute
      key={`${workspaceId}:${authority ?? "all"}`}
      workspaceId={workspaceId}
      returnToBrain={from === "brain"}
      authorityKind={authority}
    />
  );
}

function Memory() {
  const { workspaceId } = workspaceMemoryRoute.useParams();
  const { memory, from } = workspaceMemoryRoute.useSearch();
  return (
    <LazyMemoryRoute
      workspaceId={workspaceId}
      focusMemoryId={memory}
      returnToBrain={from === "brain"}
    />
  );
}

function WorkspaceSettings() {
  const { workspaceId } = workspaceSettingsRoute.useParams();
  const { section } = workspaceSettingsRoute.useSearch();
  return <LazyWorkspaceSettingsRoute workspaceId={workspaceId} section={section ?? "general"} />;
}

function WorkspaceState() {
  const { workspaceId } = workspaceStateRoute.useParams();
  const { view } = workspaceStateRoute.useSearch();
  return <LazyWorkspaceStateRoute workspaceId={workspaceId} view={view} />;
}

function Artifacts() {
  return <LazyArtifactsRoute {...workspaceArtifactsRoute.useParams()} />;
}

function ArtifactDetail() {
  return <LazyArtifactsRoute {...workspaceArtifactDetailRoute.useParams()} />;
}

function EditableArtifact() {
  return <LazyEditableArtifactRoute {...workspaceEditableArtifactRoute.useParams()} />;
}

function Organization() {
  const { workspaceId } = workspaceOrganizationRoute.useParams();
  const { checkout, section } = workspaceOrganizationRoute.useSearch();
  return <LazyOrgSettingsRoute workspaceId={workspaceId} checkout={checkout} section={section} />;
}

function AccountRedirect() {
  const { workspaceId } = workspaceAccountRoute.useParams();
  const { checkout } = workspaceAccountRoute.useSearch();
  return (
    <Navigate
      to="/workspaces/$workspaceId/organization"
      params={{ workspaceId }}
      search={checkout ? { checkout } : {}}
      replace
    />
  );
}

function Device() {
  const { user_code } = deviceRoute.useSearch();
  return <LazyDeviceRoute userCode={user_code} />;
}

function ResetPassword() {
  const { token } = resetPasswordRoute.useSearch();
  return <LazyResetPasswordRoute token={token} />;
}

function SetupAccount() {
  return <LazySetupAccountRoute />;
}

function ComposerChromeGallery() {
  return <LazyComposerChromeGalleryRoute />;
}

function AgentTopologyPreview() {
  return <LazyAgentTopologyPreviewRoute />;
}

function BillingReturnRoute() {
  const context = useAppContext();
  const { checkout } = billingReturnRoute.useSearch();
  const workspaceId =
    context.accessContext.defaultWorkspaceId ??
    context.workspaces[0]?.id ??
    context.accessContext.workspaceGrants[0]?.workspaceId;
  if (!workspaceId) {
    return (
      <ProblemPanel
        title="No workspace access"
        description="You don't have access to any workspace yet."
      />
    );
  }
  return (
    <Navigate
      to="/workspaces/$workspaceId/organization"
      params={{ workspaceId }}
      search={checkout ? { checkout } : {}}
      replace
    />
  );
}

function NotFoundRoute() {
  return (
    <ProblemPanel
      title="Page not found"
      description="This page doesn't exist. Open a workspace to continue."
    />
  );
}
