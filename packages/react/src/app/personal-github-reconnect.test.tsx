// Bendik's own GitHub grant went stale (GitHub refused the token refresh).
// The settings page said "Connected as @benyhh · 0 repos" and a passing
// "Your GitHub account is unavailable" toast vanished before he could act.
// When reconnecting is needed, the person gets one lasting Reconnect toast;
// when nothing is needed, a background read stays quiet.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ChatClient } from "@opengeni/sdk";
import { forwardRef } from "react";
import * as Sonner from "sonner";
import type { ClientConfig } from "@opengeni/sdk";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { actRun, flush, registerDom, renderHook } from "../../test/render-hook";
import {
  createSlackLinkPrepareController,
  PERSONAL_GITHUB_RECONNECT_TOAST_ID,
  useAppState,
  type AppStateHost,
} from "./app-state";
import { configurePageAppHost } from "./lib/app-host";
import { browserPage, type NavigationHost } from "./lib/navigation";

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

function personalConnection(status: "active" | "needs_reauth" | "revoked", version: number) {
  return {
    id: "personal-1",
    status,
    version,
    metadata: { githubLogin: "benyhh" },
  };
}

/** The person's GitHub API, as the settings page and every chat read it. */
function personalGitHubHost(api: {
  statuses: ReturnType<typeof personalConnection>[];
  repositories: () => unknown;
  oauthStarts: number;
  reconnectAccountIds?: Array<string | undefined>;
  disconnects?: Array<{ connectionId: string; expectedVersion: number }>;
  /** The live connection version; a disconnect naming another one is refused. */
  liveVersion?: number;
}) {
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
            permissions: ["connections:read", "connections:write", "workspace:read"],
          },
        ],
      }),
      listWorkspaces: async () => [{ id: WORKSPACE_ID, name: "Platform", settings: {} }],
      personalGitHubStatus: async () => ({
        enabled: true,
        connection: api.statuses.length > 1 ? api.statuses.shift() : api.statuses[0],
        reviewUrl: null,
      }),
      listPersonalGitHubRepositories: async () => api.repositories(),
      beginConnect: async (_workspaceId: string, request: { reconnectAccountId?: string }) => {
        api.oauthStarts += 1;
        api.reconnectAccountIds?.push(request.reconnectAccountId);
        return { nextAction: { type: "authorize", url: "https://github.com/login/oauth" } };
      },
      disconnectPersonalGitHub: async (
        _workspaceId: string,
        connectionId: string,
        request: { expectedVersion: number },
      ) => {
        api.disconnects?.push({ connectionId, expectedVersion: request.expectedVersion });
        if (api.liveVersion !== undefined && request.expectedVersion !== api.liveVersion) {
          throw new OpenGeniApiError(409, "personal GitHub connection changed", {
            correlationId: crypto.randomUUID(),
          });
        }
        return {};
      },
    } as Record<string, unknown>,
    { get: (target, key) => target[key as string] ?? (async () => ({})) },
  ) as unknown as ChatClient<OpenGeniBrowserClient>;
  const noop = async () => {};
  return {
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
}

async function openWorkspace(host: AppStateHost) {
  const rendered = await renderHook(
    () => useAppState(host, { bootstrapSuspended: false }),
    undefined,
  );
  for (let i = 0; i < 20 && !rendered.result.current.appContext; i++) await flush(10);
  await actRun(() => rendered.result.current.appContext!.prepareWorkspaceTransition(WORKSPACE_ID));
  await flush(10);
  return rendered;
}

const reconnectRefused = () => {
  throw new OpenGeniApiError(409, "Reconnect your GitHub account to keep working as you", {
    correlationId: crypto.randomUUID(),
  });
};

describe("a personal GitHub grant that needs reconnecting", () => {
  afterEach(() => {
    for (const method of ["error", "warning", "dismiss"] as const) {
      (Sonner.toast[method] as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });

  test("GitHub refusing the grant shows one lasting Reconnect toast, not a passing error", async () => {
    const toastError = spyOn(Sonner.toast, "error");
    const toastWarning = spyOn(Sonner.toast, "warning");
    // The status still said active when the repository read found the
    // refused grant; reading it again shows needs_reauth.
    const api = {
      statuses: [personalConnection("active", 3), personalConnection("needs_reauth", 4)],
      repositories: reconnectRefused,
      oauthStarts: 0,
      reconnectAccountIds: [] as Array<string | undefined>,
    };
    const rendered = await openWorkspace(personalGitHubHost(api));
    try {
      const refresh = () =>
        actRun(() => rendered.result.current.appContext!.refreshPersonalGitHub(WORKSPACE_ID));
      await refresh();
      await flush(10);

      const context = rendered.result.current.appContext!;
      expect(context.personalGitHubStatus?.connection?.status).toBe("needs_reauth");
      expect(context.personalGitHubSelection).toBeNull();
      expect(toastError).not.toHaveBeenCalled();
      expect(toastWarning).toHaveBeenCalledTimes(1);
      const [title, data] = toastWarning.mock.calls[0]!;
      expect(title).toBe("Reconnect your GitHub");
      expect(data).toMatchObject({
        id: PERSONAL_GITHUB_RECONNECT_TOAST_ID,
        description: "Opengeni can't work as @benyhh until you reconnect.",
        duration: Infinity,
        closeButton: true,
        action: { label: "Reconnect" },
      });

      // Its one action starts reconnecting this connection.
      await actRun(async () => {
        (data as unknown as { action: { onClick: () => void } }).action.onClick();
        await flush(10);
      });
      expect(api.oauthStarts).toBe(1);
      expect(api.reconnectAccountIds).toEqual(["personal-1"]);

      // A later background read of the same stale grant does not bring a
      // dismissed toast back.
      await refresh();
      await flush(10);
      expect(toastWarning).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("a stale grant reported by the status read shows the Reconnect toast too", async () => {
    const toastWarning = spyOn(Sonner.toast, "warning");
    const api = {
      statuses: [personalConnection("needs_reauth", 4)],
      repositories: () => ({ repositories: [], nextCursor: null, selection: null }),
      oauthStarts: 0,
    };
    const rendered = await openWorkspace(personalGitHubHost(api));
    try {
      await actRun(() => rendered.result.current.appContext!.refreshPersonalGitHub(WORKSPACE_ID));
      await flush(10);
      expect(toastWarning).toHaveBeenCalledTimes(1);
      expect(toastWarning.mock.calls[0]![0]).toBe("Reconnect your GitHub");
    } finally {
      await rendered.unmount();
    }
  });

  test("reconnecting clears the toast", async () => {
    const toastWarning = spyOn(Sonner.toast, "warning");
    const toastDismiss = spyOn(Sonner.toast, "dismiss");
    const selection = {
      connectionAuthorityGeneration: 5,
      credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      providerPrincipalId: "59779138",
      selectionGeneration: 1,
      repositories: [],
    };
    const api = {
      statuses: [personalConnection("needs_reauth", 4), personalConnection("active", 5)],
      repositories: () => ({ repositories: [], nextCursor: null, selection }),
      oauthStarts: 0,
    };
    const rendered = await openWorkspace(personalGitHubHost(api));
    try {
      const refresh = () =>
        actRun(() => rendered.result.current.appContext!.refreshPersonalGitHub(WORKSPACE_ID));
      await refresh();
      await flush(10);
      expect(toastWarning).toHaveBeenCalledTimes(1);
      await refresh();
      await flush(10);
      expect(toastDismiss).toHaveBeenCalledWith(PERSONAL_GITHUB_RECONNECT_TOAST_ID);
      expect(rendered.result.current.appContext!.personalGitHubSelection).toEqual(selection);
    } finally {
      await rendered.unmount();
    }
  });

  test("disconnecting instead of reconnecting clears the toast", async () => {
    const toastWarning = spyOn(Sonner.toast, "warning");
    const toastDismiss = spyOn(Sonner.toast, "dismiss");
    const api = {
      statuses: [personalConnection("needs_reauth", 4), personalConnection("revoked", 5)],
      repositories: () => ({ repositories: [], nextCursor: null, selection: null }),
      oauthStarts: 0,
    };
    const rendered = await openWorkspace(personalGitHubHost(api));
    try {
      const refresh = () =>
        actRun(() => rendered.result.current.appContext!.refreshPersonalGitHub(WORKSPACE_ID));
      await refresh();
      await flush(10);
      expect(toastWarning).toHaveBeenCalledTimes(1);
      await refresh();
      await flush(10);
      expect(toastDismiss).toHaveBeenCalledWith(PERSONAL_GITHUB_RECONNECT_TOAST_ID);
    } finally {
      await rendered.unmount();
    }
  });

  test("a background read that needs nothing from the person shows no toast", async () => {
    const toastError = spyOn(Sonner.toast, "error");
    const toastWarning = spyOn(Sonner.toast, "warning");
    const api = {
      statuses: [personalConnection("active", 3)],
      repositories: () => {
        throw new OpenGeniApiError(
          409,
          "personal GitHub connection changed; refresh and try again",
          { correlationId: crypto.randomUUID() },
        );
      },
      oauthStarts: 0,
    };
    const rendered = await openWorkspace(personalGitHubHost(api));
    try {
      await actRun(() => rendered.result.current.appContext!.refreshPersonalGitHub(WORKSPACE_ID));
      await flush(10);
      expect(toastError).not.toHaveBeenCalled();
      expect(toastWarning).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });
});

// Bendik reconnected and then pressed Disconnect in the dialog that was still
// open: the page held the connection version from before the reconnect
// finished, and Disconnect failed with "changed; refresh before
// disconnecting". Removing your own GitHub must always work.
describe("disconnecting your GitHub", () => {
  afterEach(() => {
    for (const method of ["error", "success"] as const) {
      (Sonner.toast[method] as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });

  test("a connection that changed while the page held it is still disconnected", async () => {
    const toastError = spyOn(Sonner.toast, "error");
    const toastSuccess = spyOn(Sonner.toast, "success");
    const api = {
      statuses: [personalConnection("needs_reauth", 4)],
      repositories: () => ({ repositories: [], nextCursor: null, selection: null }),
      oauthStarts: 0,
      disconnects: [] as Array<{ connectionId: string; expectedVersion: number }>,
      liveVersion: 4,
    };
    const rendered = await openWorkspace(personalGitHubHost(api));
    try {
      await actRun(() => rendered.result.current.appContext!.refreshPersonalGitHub(WORKSPACE_ID));
      await flush(10);
      expect(rendered.result.current.appContext!.personalGitHubStatus?.connection?.version).toBe(4);

      // A reconnect finishes elsewhere: the live connection is now version 5.
      api.statuses.splice(0, api.statuses.length, personalConnection("active", 5));
      api.liveVersion = 5;

      let disconnected = false;
      await actRun(async () => {
        disconnected =
          await rendered.result.current.appContext!.disconnectPersonalGitHub(WORKSPACE_ID);
      });
      await flush(10);

      expect(disconnected).toBe(true);
      expect(api.disconnects).toEqual([
        { connectionId: "personal-1", expectedVersion: 4 },
        { connectionId: "personal-1", expectedVersion: 5 },
      ]);
      expect(toastError).not.toHaveBeenCalled();
      expect(toastSuccess).toHaveBeenCalledWith("Your GitHub account was disconnected");
    } finally {
      await rendered.unmount();
    }
  });
});
