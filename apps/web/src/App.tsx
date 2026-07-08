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
//   /workspaces/:id/settings                 → workspace settings (name, API keys, danger zone)
//   /workspaces/:id/organization             → organization settings (billing, usage, plan, members)
//   /workspaces/:id/account                  → legacy redirect to /organization
//   /billing?checkout=success|cancelled      → Stripe return → default organization
//   /device?user_code=…                      → self-hosted enrollment approve page
import {
  Navigate,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { ProblemPanel } from "@/components/common";
import { RootRouteComponent, useAppContext } from "@/context";
import { parseCheckoutOutcome, type CheckoutOutcome } from "@/lib/routes";
import { CapabilitiesRoute } from "@/routes/capabilities";
import { DeviceRoute } from "@/routes/device";
import { DocumentsRoute } from "@/routes/documents";
import { EnvironmentsRoute } from "@/routes/environments";
import { MachinesRoute } from "@/routes/machines";
import { OrgSettingsRoute } from "@/routes/org-settings";
import { ResetPasswordRoute } from "@/routes/reset-password";
import { SchedulesRoute } from "@/routes/schedules";
import { SessionRoute } from "@/routes/session";
import { SessionsIndexRoute } from "@/routes/sessions-index";
import { WorkspaceSettingsRoute } from "@/routes/workspace-settings";
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
const workspaceMachinesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "machines",
  component: Machines,
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
  // `?memory=<id>` deep-links a memory record (from a timeline memory step): the
  // Documents page reveals + highlights that memory even when the filters would
  // otherwise hide it. Unknown values are ignored.
  validateSearch: (search: Record<string, unknown>): { memory?: string } =>
    typeof search.memory === "string" ? { memory: search.memory } : {},
  component: Documents,
});
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "settings",
  component: WorkspaceSettings,
});
const workspaceOrganizationRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "organization",
  // `?checkout=success|cancelled` arrives via the /billing Stripe-return
  // redirect so the organization page can confirm the top-up.
  validateSearch: (search: Record<string, unknown>): { checkout?: CheckoutOutcome } => {
    const checkout = parseCheckoutOutcome(search);
    return checkout ? { checkout } : {};
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
  billingReturnRoute,
  deviceRoute,
  resetPasswordRoute,
  workspaceRoute.addChildren([
    workspaceIndexRoute,
    workspaceAgentRoute,
    workspaceSessionsRoute,
    workspaceSessionRoute,
    workspaceEnvironmentsRoute,
    workspaceMachinesRoute,
    workspacePacksRoute,
    workspaceCapabilitiesRoute,
    workspaceSchedulesRoute,
    workspaceDocumentsRoute,
    workspaceSettingsRoute,
    workspaceOrganizationRoute,
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

function Machines() {
  const { workspaceId } = workspaceMachinesRoute.useParams();
  return <MachinesRoute workspaceId={workspaceId} />;
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
  const { memory } = workspaceDocumentsRoute.useSearch();
  return <DocumentsRoute workspaceId={workspaceId} focusMemoryId={memory} />;
}

function WorkspaceSettings() {
  const { workspaceId } = workspaceSettingsRoute.useParams();
  return <WorkspaceSettingsRoute workspaceId={workspaceId} />;
}

function Organization() {
  const { workspaceId } = workspaceOrganizationRoute.useParams();
  const { checkout } = workspaceOrganizationRoute.useSearch();
  return <OrgSettingsRoute workspaceId={workspaceId} checkout={checkout} />;
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
  return <DeviceRoute userCode={user_code} />;
}

function ResetPassword() {
  const { token } = resetPasswordRoute.useSearch();
  return <ResetPasswordRoute token={token} />;
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
