import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { forwardRef } from "react";
import * as Sonner from "sonner";
import type { ClientConfig } from "@opengeni/sdk";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { actRun, flush, registerDom, renderHook } from "../../test/render-hook";
import {
  createSlackLinkPrepareController,
  GITHUB_STATUS_TOAST_ID,
  useAppState,
  type AppStateHost,
} from "./app-state";
import { configurePageAppHost } from "./lib/app-host";
import { browserPage, type NavigationHost } from "./lib/navigation";

registerDom();

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

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

/** GET /github/app answers like a gateway that never reached the API. */
function failingGitHubHost() {
  let statusReads = 0;
  const client = new Proxy(
    {
      getAccessContext: async () => ({
        subjectId: "user:1",
        defaultWorkspaceId: WORKSPACE_ID,
        grants: [],
      }),
      listWorkspaces: async () => [{ id: WORKSPACE_ID, name: "Platform", settings: {} }],
      getGitHubApp: async () => {
        statusReads += 1;
        throw new OpenGeniApiError(502, "", { correlationId: crypto.randomUUID() });
      },
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
  return { host, statusReads: () => statusReads };
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

describe("GitHub status refresh failures", () => {
  afterEach(() => {
    (Sonner.toast.error as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("a background refresh records the failure without a toast", async () => {
    const toastError = spyOn(Sonner.toast, "error");
    const { host, statusReads } = failingGitHubHost();
    const rendered = await openWorkspace(host);
    try {
      // Two load/focus refreshes that both fail, as in the reported screenshot.
      await actRun(() => rendered.result.current.appContext!.refreshGitHub(WORKSPACE_ID));
      await actRun(() => rendered.result.current.appContext!.refreshGitHub(WORKSPACE_ID));
      await flush(10);
      expect(statusReads()).toBe(2);
      expect(rendered.result.current.appContext!.githubStatusFailed).toBe(true);
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  test("a refresh the person started shows one replaceable toast", async () => {
    const toastError = spyOn(Sonner.toast, "error");
    const { host } = failingGitHubHost();
    const rendered = await openWorkspace(host);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await actRun(() =>
          rendered.result.current.appContext!.refreshGitHub(WORKSPACE_ID, undefined, {
            sync: true,
            userInitiated: true,
          }),
        );
      }
      await flush(10);
      expect(toastError).toHaveBeenCalledTimes(2);
      for (const [title, data] of toastError.mock.calls) {
        expect(title).toBe("GitHub status unavailable");
        expect(data).toMatchObject({ id: GITHUB_STATUS_TOAST_ID });
      }
    } finally {
      await rendered.unmount();
    }
  });
});
