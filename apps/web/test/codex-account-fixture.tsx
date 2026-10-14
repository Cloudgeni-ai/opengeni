import { createRoot } from "react-dom/client";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { useOrganizationCodexSubscriptions } from "../src/components/organization-codex-subscriptions";
import { OrgCodexAccountPage } from "../src/components/models/organization-codex-models";
import { modelsScopeLabels } from "../src/components/models/models-ui";
import { AppearanceProvider } from "../src/lib/appearance";
import { Toaster } from "../src/components/ui/sonner";
import "../src/styles.css";

const organizationId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const account = {
  id: accountId,
  email: "subscription@example.test",
  plan: "pro",
  status: "active",
  active: true,
  allocatorEnabled: false,
  allocatorVersion: 1,
  extraCreditsEnabled: false,
  extraCreditsVersion: 1,
  appsDesignated: false,
  canEnableApps: false,
};
const client = new OpenGeniBrowserClient({
  baseUrl: location.origin,
  fetch: (async (input, init) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    let result: unknown;
    if (pathname.endsWith("/usage")) {
      result = {
        status: "ok",
        usage: {
          status: "ok",
          planType: "pro",
          limitReached: false,
          fetchedAt: new Date().toISOString(),
          fiveHour: null,
          weekly: {
            used: 25,
            limit: 100,
            remaining: 75,
            percent: 25,
            resetAt: new Date(Date.now() + 86_400_000).toISOString(),
            resetAfterSeconds: 86400,
            limitWindowSeconds: 604800,
          },
          credits: {
            hasCredits: true,
            unlimited: false,
            overageLimitReached: false,
            balance: "120.50",
          },
        },
      };
    } else if (pathname.endsWith("/access")) {
      result = {
        policy: {
          allowedModels: null,
          allowedWorkspaces: [],
          allowPersonalWorkspaces: false,
          version: 1,
        },
        models: [],
        workspaces: [],
        personalWorkspacesSupported: true,
      };
    } else if (pathname.endsWith("/extra-credits") && request.method === "PATCH") {
      const body = await request.json();
      account.extraCreditsEnabled = body.enabled;
      account.extraCreditsVersion += 1;
      result = { changed: true };
    } else if (pathname.endsWith("/accounts")) {
      result = {
        accounts: [account],
        activeAccountId: accountId,
        settings: {
          rotationEnabled: true,
          rotationStrategy: "sharded",
          activeCredentialId: accountId,
        },
      };
    } else {
      throw new Error(`Unexpected fixture request: ${request.method} ${pathname}`);
    }
    return Response.json(result, {
      headers: { [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION },
    });
  }) as typeof fetch,
});
function Fixture() {
  const codex = useOrganizationCodexSubscriptions({ client, organizationId });
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-8">
      <OrgCodexAccountPage
        codex={codex}
        accountId={accountId}
        places={{
          organizationName: "Example",
          scope: modelsScopeLabels("Example", false),
          openAccount: () => {},
          openConnect: () => {},
          openAccess: () => {},
          backToList: () => {},
        }}
      />
      <Toaster />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <AppearanceProvider>
    <Fixture />
  </AppearanceProvider>,
);
