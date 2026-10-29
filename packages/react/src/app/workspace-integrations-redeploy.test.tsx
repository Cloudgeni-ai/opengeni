// Bendik saw two "GitHub status unavailable" toasts in a chat while Opengeni
// was being redeployed. Every workspace view, the chat included, runs
// useWorkspaceIntegrations (GitHub status, the person's own GitHub, the
// workspace MCP tools) and refreshes GitHub when the window comes back into
// focus. During a deploy those reads get gateway 502s. They must stay quiet
// and recover by themselves once Opengeni answers again.
import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { forwardRef } from "react";
import * as Sonner from "sonner";
import type { ClientConfig } from "@opengeni/sdk";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { actRun, flush, registerDom, renderHook } from "../../test/render-hook";
import { createSlackLinkPrepareController, useAppState, type AppStateHost } from "./app-state";
import type { AppContextValue } from "./app-context";
import { configurePageAppHost } from "./lib/app-host";
import { browserPage, type NavigationHost } from "./lib/navigation";
import { useWorkspaceIntegrations } from "./lib/use-workspace-integrations";

registerDom();

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

const location = { pathname: "/", search: {}, searchStr: "", hash: "", state: {} };
configurePageAppHost({
  navigation: {
    useNavigate: () => async () => {},
    useLocation: () => location,
    useRouterState: ({ select }: { select: (state: { location: typeof location }) => unknown }) =>
      select({ location }),
    useRouter: () => ({ state: { location } }),
    useSearch: () => ({}),
    Link: forwardRef<HTMLAnchorElement>((props, ref) => <a ref={ref} {...props} />),
    stringifySearch: () => "",
    page: browserPage,
  } as unknown as NavigationHost,
});

const BOUND_STATUS = {
  configured: true,
  status: "bound",
  setupMode: "platform",
  appId: null,
  clientId: null,
  appSlug: null,
  installUrl: null,
  linkUrl: null,
  installations: [
    {
      installationId: 71,
      githubAccountId: 72,
      accountLogin: "Cloudgeni-ai",
      accountType: "Organization",
      lifecycle: "active",
      repositoryScope: "selected",
      repositoryCount: 1,
      configureUrl: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  ],
  missing: [],
};

/** An Opengeni API that answers like a gateway while `deploying` is set. */
function redeployingHost() {
  const api = { deploying: true, reads: { github: 0, personal: 0, mcp: 0 } };
  const duringDeploy = <T,>(read: () => T) => {
    if (api.deploying) throw new OpenGeniApiError(502, "", { correlationId: crypto.randomUUID() });
    return read();
  };
  const client = new Proxy(
    {
      getAccessContext: async () => ({
        mode: "managed",
        subjectId: "user:1",
        defaultWorkspaceId: WORKSPACE_ID,
        defaultAccountId: ACCOUNT_ID,
        accountGrants: [],
        workspaceGrants: [
          {
            workspaceId: WORKSPACE_ID,
            accountId: ACCOUNT_ID,
            subjectId: "user:1",
            permissions: ["github:use", "connections:read", "workspace:read"],
          },
        ],
      }),
      listWorkspaces: async () => [{ id: WORKSPACE_ID, name: "Platform", settings: {} }],
      getGitHubApp: async () => {
        api.reads.github += 1;
        return duringDeploy(() => BOUND_STATUS);
      },
      listGitHubRepositories: async () =>
        duringDeploy(() => ({
          repositories: [{ id: 1, installationId: 71, fullName: "Cloudgeni-ai/opengeni" }],
        })),
      personalGitHubStatus: async () => {
        api.reads.personal += 1;
        return duringDeploy(() => ({ enabled: true, connection: null, reviewUrl: null }));
      },
      listCapabilities: async () => {
        api.reads.mcp += 1;
        return duringDeploy(() => ({ items: [] }));
      },
      listApiIntegrations: async () => duringDeploy(() => ({ integrations: [] })),
    } as Record<string, unknown>,
    { get: (target, key) => target[key as string] ?? (async () => ({})) },
  ) as unknown as OpenGeniBrowserClient;
  const noop = async () => {};
  const host = {
    authority: "host",
    createOpenGeniClient: () => client,
    fetchClientConfig: async () =>
      ({
        deploymentRevision: "rev-1",
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        models: [],
        mcpServers: [],
        auth: { mode: "none" },
      }) as unknown as ClientConfig,
    captureProductEvent: () => {},
    fetchAuthSession: async () => null,
    signInEmail: noop,
    signUpEmail: noop,
    signOutManaged: noop,
    startManagedSocialSignIn: noop,
    configureManagedActorEpoch: () => {},
    getStoredAccessKey: () => null,
    setStoredAccessKey: () => {},
    clearStoredAccessKey: () => {},
    slackLink: createSlackLinkPrepareController(null),
    initialInvalidSlackLinkQueryWorkspaceId: null,
  } as unknown as AppStateHost;
  return { host, api };
}

const inert = {} as AppContextValue;

/** What a chat page runs for its workspace (the web workspace route and SessionApp). */
function useOpenChat({ host, ready }: { host: AppStateHost; ready: boolean }) {
  const state = useAppState(host, { bootstrapSuspended: false });
  const context = state.appContext;
  useWorkspaceIntegrations(context ?? inert, WORKSPACE_ID, ready && context !== null);
  return context;
}

describe("a chat open while Opengeni redeploys", () => {
  afterEach(() => {
    jest.useRealTimers();
    (Sonner.toast.error as unknown as { mockRestore?: () => void }).mockRestore?.();
    (Sonner.toast.warning as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("shows no toast and loads GitHub and tools by itself once Opengeni answers", async () => {
    const toastError = spyOn(Sonner.toast, "error");
    const toastWarning = spyOn(Sonner.toast, "warning");
    const { host, api } = redeployingHost();
    const rendered = await renderHook(useOpenChat, { host, ready: false });
    try {
      for (let i = 0; i < 20 && !rendered.result.current; i++) await flush(10);
      await actRun(() => rendered.result.current!.prepareWorkspaceTransition(WORKSPACE_ID));
      jest.useFakeTimers();
      await rendered.rerender({ host, ready: true });
      await flush();
      // The window comes back into focus mid-deploy: another background refresh.
      await actRun(() => window.dispatchEvent(new Event("focus")));
      await flush(2_000);
      expect(api.reads.github).toBeGreaterThanOrEqual(2);
      expect(rendered.result.current!.githubStatusFailed).toBe(true);

      // Still deploying: the quiet retries keep failing, quietly.
      await flush(2_000);
      await flush(4_000);
      const readsDuringDeploy = { ...api.reads };

      // The new version answers. Nobody clicks anything.
      api.deploying = false;
      await flush(8_000);
      await flush(16_000);

      const context = rendered.result.current!;
      expect(api.reads.github).toBeGreaterThan(readsDuringDeploy.github);
      expect(api.reads.personal).toBeGreaterThan(readsDuringDeploy.personal);
      expect(api.reads.mcp).toBeGreaterThan(readsDuringDeploy.mcp);
      expect(context.githubStatusFailed).toBe(false);
      expect(context.githubStatus?.status).toBe("bound");
      expect(context.githubCatalogReady).toBe(true);
      expect(context.personalGitHubStatus?.enabled).toBe(true);
      expect(toastError).not.toHaveBeenCalled();
      expect(toastWarning).not.toHaveBeenCalled();

      // Recovered: no further reads are scheduled.
      const settled = { ...api.reads };
      await flush(60_000);
      expect(api.reads).toEqual(settled);
    } finally {
      jest.useRealTimers();
      await rendered.unmount();
    }
  });
});
