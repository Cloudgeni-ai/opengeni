// Real billing page, controller and SDK. Only responses are fixtures: no payments.
import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { SectionVariantProvider } from "@opengeni/react/ui/section";
import { OrganizationBillingPage } from "../src/components/organization/billing-page";
import { OrganizationDirectoryProvider } from "../src/components/organization/organization-directory";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.ogTheme = theme;
document.documentElement.classList.toggle("dark", theme === "dark");
const scenario = params.get("scenario") ?? "ready";
const canManage = scenario !== "readonly";
const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const identity = {
  organizationId: accountId,
  workspaceId,
  subjectId: "user:preview",
  principalGeneration: 0,
};
const calls: { url: string; method: string }[] = [];
let threshold = 10_000_000;
let topUp = {
  accountId,
  enabled: scenario !== "failed",
  thresholdMicros: 10_000_000,
  amountMicros: 25_000_000,
  monthlyCapMicros: 100_000_000,
  spentThisMonthMicros: 25_000_000,
  status: scenario === "failed" ? "payment_failed" : "ready",
  paymentMethod: { brand: "visa", last4: "4242" },
  failureReason:
    scenario === "failed" ? "Update your saved card, then turn on automatic top-ups again." : null,
};
const client = new OpenGeniBrowserClient({
  baseUrl: "https://credit-billing-fixture.invalid",
  fetch: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ url: url.pathname + url.search, method });
    if (url.pathname === "/v1/billing")
      return Response.json({
        mode: "stripe",
        balance: {
          accountId,
          balanceMicros: 25_000_000,
          creditsMicros: 25_000_000,
          generalBalanceMicros: 25_000_000,
          byokPlatformFeeMonthMicros: 0,
          currency: "usd",
          updatedAt: "2026-11-03T19:00:00Z",
        },
      });
    if (url.pathname === "/v1/billing/entitlements")
      return Response.json({ accountId, mode: "managed", entitlements: {} });
    if (url.pathname === "/v1/billing/alerts") {
      if (method === "PUT") threshold = JSON.parse(String(init?.body)).lowBalanceThresholdMicros;
      return Response.json({ accountId, lowBalanceThresholdMicros: threshold });
    }
    if (url.pathname === "/v1/billing/auto-top-up") {
      if (scenario === "unavailable")
        return Response.json(
          { error: { message: "Automatic top-ups are unavailable." } },
          { status: 404 },
        );
      if (method === "PUT") {
        const next = JSON.parse(String(init?.body));
        topUp = { ...topUp, ...next, status: next.enabled ? "ready" : "off" };
      }
      return Response.json(topUp);
    }
    if (url.pathname.endsWith("/privacy-settings"))
      return Response.json({ organizationId: accountId, personalWorkspaces: false });
    if (url.pathname.endsWith("/overview"))
      return Response.json({
        organization: { id: accountId, name: "Preview organization" },
        workspaces: [],
      });
    if (url.pathname.endsWith("/members")) return Response.json({ members: [] });
    if (url.pathname.endsWith("/invitations"))
      return Response.json({ invitations: [], nextCursor: null });
    return Response.json(
      { error: { message: "Preview-only endpoint is unavailable." } },
      { status: 404 },
    );
  },
});
const context = {
  client,
  clientConfig: { auth: { mode: "managedSession" } },
  accessKeyVersion: 0,
  authSession: { user: { id: "preview", email: "preview@example.test" } },
  accessContext: {
    mode: "managed",
    subjectId: identity.subjectId,
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
    workspaceGrants: [],
    accountGrants: [
      {
        accountId,
        subjectId: identity.subjectId,
        role: canManage ? "owner" : "admin",
        permissions: ["billing:read", ...(canManage ? ["billing:manage"] : [])],
      },
    ],
  },
  workspaces: [{ id: workspaceId, accountId, name: "Preview" }],
} as AppContextValue;
Object.assign(window, { creditBillingPreview: { calls } });
const rootRoute = createRootRoute({
  component: () => (
    <AppContext.Provider value={context}>
      <TooltipProvider>
        <OrganizationDirectoryProvider
          client={client}
          identity={identity}
          actorRole={canManage ? "owner" : "admin"}
          managedSession
          singleUser={false}
          accessibleWorkspaceIds={new Set([workspaceId])}
          onAuthorityChanged={() => {}}
          onCreateWorkspace={async () => null}
          onDeleteWorkspace={async () => {}}
        >
          <main data-canvas className="h-dvh overflow-y-auto bg-canvas px-6 py-8 text-fg">
            <div className="mx-auto max-w-[960px]">
              <p className="mb-4 text-xs text-fg-muted">
                Implementation preview · Sample data · No payments
              </p>
              <h1 className="mb-6 text-xl font-semibold">Billing &amp; usage</h1>
              <SectionVariantProvider variant="group">
                <OrganizationBillingPage
                  identity={identity}
                  canReadBilling
                  canManageBilling={canManage}
                  canManageAutomaticTopUp={canManage}
                />
              </SectionVariantProvider>
            </div>
          </main>
        </OrganizationDirectoryProvider>
      </TooltipProvider>
    </AppContext.Provider>
  ),
});
createRoot(document.getElementById("root")!).render(
  <RouterProvider router={createRouter({ routeTree: rootRoute })} />,
);
