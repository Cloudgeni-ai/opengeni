import type {
  CodexAccount,
  CodexAccountOverview,
  ModelConnectionAccessResponse,
} from "@opengeni/sdk";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { currentWorkspace, organization } from "../../fixtures";

/** A transport fixture, not a second implementation of the Models UI/cache. */
export function createModelsCacheFixture(holdDetails = false) {
  let reads = 0;
  let release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const gate = holdDetails
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  const accounts: CodexAccount[] = ["Team plan", "Backup plan"].map((label, index) => ({
    id: `preview-codex-${index + 1}`,
    source: "organization",
    label,
    email: index === 0 ? "team@example.com" : "backup@example.com",
    plan: "pro",
    status: "active",
    active: index === 0,
    allocatorEnabled: true,
    allocatorVersion: 1,
    appsDesignated: false,
    canEnableApps: false,
  }));
  const settings = {
    rotationEnabled: true,
    rotationStrategy: "sharded",
    activeCredentialId: accounts[0]!.id,
  };
  let policy: ModelConnectionAccessResponse["policy"] = {
    allowedModels: null,
    allowedWorkspaces: [currentWorkspace.id],
    allowPersonalWorkspaces: true,
    version: 1,
  };
  const overview = (account: CodexAccount): CodexAccountOverview => {
    const fetchedAt = new Date().toISOString();
    const window = (remaining: number, hours: number) => ({
      used: 100 - remaining,
      limit: 100,
      remaining,
      percent: 100 - remaining,
      resetAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
      resetAfterSeconds: hours * 3600,
      limitWindowSeconds: hours * 3600,
    });
    return {
      accountId: account.id,
      usage: {
        source: "provider",
        fetchedAt,
        stale: false,
        error: null,
        value: {
          status: "ok",
          planType: "pro",
          weekly: window(74, 48),
          fiveHour: window(88, 3),
          limitReached: false,
          fetchedAt,
          credits: {
            balance: "1250.50",
            unlimited: false,
            hasCredits: true,
            overageLimitReached: false,
          },
        },
      },
      resetCredits: {
        source: "provider",
        fetchedAt,
        stale: false,
        error: null,
        detailState: "detailed",
        detailsComplete: true,
        availableCount: 0,
        credits: [],
      },
      canRedeem: false,
      canResumeRedemption: false,
      redemptions: [],
      redemptionAccess: { ownership: "unowned", canClaimUnownedViaReconnect: false },
    };
  };
  const client = new OpenGeniBrowserClient({
    baseUrl: "https://models-preview.invalid",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      reads += 1;
      for (const notify of listeners) notify();
      if (path.endsWith("/access")) {
        await gate;
        if (request.method === "PATCH" || request.method === "PUT") {
          policy = { ...(await request.json()), version: policy.version + 1 };
        }
        return Response.json({
          policy,
          personalWorkspacesSupported: true,
          models: [{ id: "codex/gpt-6-astra", label: "GPT-6 Astra" }],
          workspaces: [currentWorkspace],
          localWorkspaceIds: [],
        } satisfies ModelConnectionAccessResponse);
      }
      if (path.endsWith("/overview")) {
        await gate;
        const account = accounts.find((item) => path.includes(`/${item.id}/`));
        return Response.json(
          account
            ? overview(account)
            : { accounts: Object.fromEntries(accounts.map((item) => [item.id, overview(item)])) },
        );
      }
      if (request.method === "GET" && path.endsWith("/codex/accounts")) {
        return Response.json({
          accounts,
          activeAccountId: accounts[0]!.id,
          settings,
          source: {
            accountId: organization.id,
            workspaceId: currentWorkspace.id,
            workspaceKind: "shared",
            mode: "automatic",
            effectiveSource: "organization",
            workspaceAvailable: false,
            organizationAvailable: true,
          },
        });
      }
      // Preview mutations never reach a backend or a real provider.
      return Response.json(
        { error: { message: "This preview supports reads and availability edits only." } },
        { status: 400 },
      );
    },
  });
  return {
    client,
    finishLoading: () => release?.(),
    getSnapshot: () => reads,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    accountId: accounts[0]!.id,
  };
}
