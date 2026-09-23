import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CodexOverviewResponse } from "@opengeni/sdk";
import { createRoot } from "react-dom/client";
import { CodexSubscriptionsCardWithClient } from "../src/components/codex-connection";
import "../src/styles.css";

// Real production card, deterministic sample accounts; no provider requests.
const state = new URLSearchParams(location.search).get("state") ?? "ready";
const window = {
  used: 90,
  limit: 100,
  remaining: 10,
  percent: 90,
  resetAt: null,
  resetAfterSeconds: null,
  limitWindowSeconds: 18000,
};
const accounts = ["Design", "Engineering", "Research"].map((label, index) => ({
  id: `sample-${index}`,
  label,
  source: "organization",
  status: "active",
  plan: "team",
  active: index === 0,
  allocatorEnabled: true,
  fiveHour: window,
  weekly: window,
}));
const client = {
  listCodexAccounts: async () => ({
    accounts,
    activeAccountId: "sample-0",
    settings: { rotationEnabled: false },
    source: {
      accountId: "sample-org",
      workspaceId: "sample-workspace",
      workspaceKind: "shared",
      mode: "automatic",
      effectiveSource: "organization",
      workspaceAvailable: false,
      organizationAvailable: true,
    },
  }),
  codexOverview: async (): Promise<CodexOverviewResponse> => {
    if (state === "loading") return new Promise(() => {});
    if (state === "error") throw new Error("Sample provider failure");
    return {
      accounts: Object.fromEntries(
        accounts.map((account, index) => [
          account.id,
          {
            accountId: account.id,
            usage: {
              source: "provider",
              fetchedAt: new Date().toISOString(),
              stale: false,
              error: null,
              value:
                index === 2
                  ? null
                  : {
                      status: "ok",
                      planType: "team",
                      fiveHour:
                        index === 0 ? { ...window, used: 15, percent: 15, remaining: 85 } : null,
                      weekly: {
                        ...window,
                        used: 35 + index * 20,
                        percent: 35 + index * 20,
                        remaining: 65 - index * 20,
                        limitWindowSeconds: 604800,
                      },
                      limitReached: false,
                      fetchedAt: new Date().toISOString(),
                    },
            },
            resetCredits: {
              source: "none",
              fetchedAt: null,
              stale: false,
              error: null,
              detailState: "unknown",
              detailsComplete: false,
              availableCount: null,
              credits: [],
            },
            canRedeem: false,
            canResumeRedemption: false,
            redemptions: [],
            redemptionAccess: { ownership: "unowned", canClaimUnownedViaReconnect: false },
          },
        ]),
      ),
    };
  },
} as unknown as OpenGeniBrowserClient;
const route = createRootRoute({
  component: () => (
    <main className="mx-auto max-w-4xl p-6 text-fg">
      <h1 className="mb-6 text-lg font-semibold">Models</h1>
      <CodexSubscriptionsCardWithClient
        client={client}
        workspaceId="sample-workspace"
        canManage={false}
      />
    </main>
  ),
});
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
