// Production route, rail link, SDK, store and styles. Only API responses and
// surrounding navigation state are fixtures; no billing settings page is rendered.
import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { BillingCreditNotification, InboxItem } from "@opengeni/sdk";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { RailSurface, ShellRail } from "@opengeni/react/app/components/rail/rail-surface";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { Toaster } from "sonner";
import { InboxRoute } from "../src/routes/inbox";
import { InboxLink } from "../src/components/rail/inbox-link";
import { workspaceId } from "./billing-inbox-preview-state";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.ogTheme = theme;
document.documentElement.classList.toggle("dark", theme === "dark");
const accountId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const scenario = params.get("scenario") ?? "all";
const calls: { url: string; method: string }[] = [];
const notifications: BillingCreditNotification[] = [
  "low_balance",
  "exhausted",
  "unusual_spend",
  "topup_success",
  "topup_failed",
  "cap_reached",
].map((kind, index) => ({
  id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`,
  accountId,
  kind,
  eventType: `billing.credits.${kind}`,
  read: false,
  details: {
    availableBalanceMicros: 5_000_000,
    amountMicros: 25_000_000,
    lastHourSpendMicros: 18_500_000,
  },
  createdAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
  action: {
    label: "Manage billing",
    path: `/workspaces/${workspaceId}/organization?section=billing`,
  },
})) as BillingCreditNotification[];
const items: InboxItem[] =
  scenario === "mixed"
    ? ([
        {
          id: "66666666-6666-4666-8666-666666666666",
          workspaceId: otherWorkspaceId,
          sessionId: "77777777-7777-4777-8777-777777777777",
          kind: "notification",
          title: "Your research is ready",
          body: "The summary is ready to read.",
          subtitle: "",
          facts: [],
          choices: [],
          sessionTitle: "Research",
          sessionAvailable: true,
          unread: true,
          snoozedUntil: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ] as InboxItem[])
    : [];
const client = new OpenGeniBrowserClient({
  baseUrl: "https://billing-inbox-fixture.invalid",
  fetch: async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname + url.search, method: init?.method ?? "GET" });
    if (url.pathname === "/v1/inbox")
      return Response.json({
        items,
        needsYouCount: 0,
        unreadCount: items.filter((item) => item.unread).length,
        ...(scenario === "old-backend"
          ? {}
          : { billingNotifications: scenario === "empty" ? [] : notifications }),
      });
    if (/^\/v1\/billing\/notifications\/[^/]+\/read$/.test(url.pathname)) {
      if (scenario === "read-error") return Response.json({ error: "Try again" }, { status: 503 });
      const notification = notifications.find((notice) => url.pathname.includes(notice.id));
      if (notification && url.searchParams.get("accountId") === accountId) notification.read = true;
      return Response.json({ ok: Boolean(notification) });
    }
    if (url.pathname === "/v1/inbox/settings")
      return Response.json({ tidyPolicy: "own_sessions", pausedGoals: false, replies: true });
    if (url.pathname.endsWith("/members")) return Response.json([]);
    if (url.pathname.endsWith("/member-notifications"))
      return Response.json({ allowOthers: false });
    if (url.pathname.startsWith("/v1/inbox/")) {
      for (const item of items) item.unread = false;
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unimplemented fixture endpoint" }, { status: 404 });
  },
});
const context = {
  client,
  accessKeyVersion: 0,
  authSession: null,
  accessContext: {
    mode: "managed",
    subjectId: "user:preview",
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
    workspaceGrants: [],
    accountGrants:
      scenario === "workspace-viewer"
        ? []
        : [
            {
              accountId,
              subjectId: "user:preview",
              role: "owner",
              permissions: ["billing:read", "billing:manage"],
            },
          ],
  },
  workspaces: [
    {
      id: workspaceId,
      accountId: scenario === "other-org" ? "88888888-8888-4888-8888-888888888888" : accountId,
      name: "Personal",
    },
    { id: otherWorkspaceId, accountId, name: "Team" },
  ],
} as AppContextValue;
Object.assign(window, { billingInboxPreview: { calls } });
const rootRoute = createRootRoute({
  component: () => (
    <AppContext.Provider value={context}>
      <TooltipProvider>
        <div className="flex h-dvh min-w-0 flex-col bg-bg text-fg sm:flex-row">
          <ShellRail as="nav" aria-label="Preview navigation" className="sm:w-60">
            <RailSurface className="p-3">
              <p className="mb-3 px-2.5 text-sm font-medium">Opengeni</p>
              <InboxLink />
              <p className="mt-3 px-2.5 text-xs text-fg-muted">Preview · sample data</p>
            </RailSurface>
          </ShellRail>
          <main data-canvas className="flex min-h-0 min-w-0 flex-1 bg-canvas">
            <InboxRoute workspaceId={workspaceId} />
          </main>
          <Toaster />
        </div>
      </TooltipProvider>
    </AppContext.Provider>
  ),
});
const router = createRouter({ routeTree: rootRoute });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
