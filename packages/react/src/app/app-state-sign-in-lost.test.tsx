import { describe, expect, test } from "bun:test";
import type { ChatClient, ClientConfig } from "@opengeni/sdk";
import { forwardRef } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { actRun, flush, registerDom, renderHook } from "../../test/render-hook";
import { createSlackLinkPrepareController, useAppState, type AppStateHost } from "./app-state";
import { configurePageAppHost } from "./lib/app-host";
import { browserPage, type NavigationHost } from "./lib/navigation";

registerDom();

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
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

const clientConfig = {
  deploymentRevision: "rev-1",
  defaultModel: "gpt-5.6-sol",
  allowedModels: ["gpt-5.6-sol"],
  models: [],
  defaultReasoningEffort: "medium",
  allowedReasoningEfforts: ["medium"],
  mcpServers: [],
  fileUploads: { enabled: true, maxSizeBytes: 1024 },
  auth: { mode: "managedSession" },
  managedAuthSessionSetMode: "legacy",
} as unknown as ClientConfig;

const signedIn = {
  user: { id: "user-1", email: "person@example.test", name: "Person" },
  session: { id: "auth-session-1" },
};

/**
 * A signed-in web app whose session read answers `sessions` in turn, with a
 * sign-in-lost signal the test fires the way a refused API request does.
 */
function host(sessions: (typeof signedIn | null)[]) {
  const listeners = new Set<() => void>();
  let sessionReads = 0;
  const client = new Proxy(
    {
      getAccessContext: async () => ({
        subjectId: "user:user-1",
        defaultWorkspaceId: WORKSPACE_ID,
        grants: [],
      }),
      listWorkspaces: async () => [{ id: WORKSPACE_ID, name: "Platform", settings: {} }],
    } as Record<string, unknown>,
    { get: (target, key) => target[key as string] ?? (async () => ({})) },
  ) as unknown as ChatClient<OpenGeniBrowserClient>;
  const noop = async () => {};
  const appHost = {
    authority: "app",
    createOpenGeniClient: () => client,
    fetchClientConfig: async () => clientConfig,
    captureProductEvent: () => {},
    fetchAuthSession: async () => sessions[Math.min(sessionReads++, sessions.length - 1)],
    subscribeSignInLost: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
  return {
    appHost,
    sessionReads: () => sessionReads,
    listeners,
    signInLost: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

async function signedInApp(fixture: ReturnType<typeof host>) {
  const rendered = await renderHook(
    () => useAppState(fixture.appHost, { bootstrapSuspended: false }),
    undefined,
  );
  for (let i = 0; i < 40 && !rendered.result.current.appContext; i++) await flush(10);
  expect(rendered.result.current.authSession?.user.id).toBe("user-1");
  expect(rendered.result.current.appContext).toBeTruthy();
  return rendered;
}

describe("a sign-in lost while the app is open", () => {
  test("leaves the signed-in app for sign-in after one session check", async () => {
    const fixture = host([signedIn, null]);
    const rendered = await signedInApp(fixture);
    try {
      expect(fixture.sessionReads()).toBe(1);
      // Every background read is refused at once; one session check answers all.
      await actRun(() => {
        fixture.signInLost();
        fixture.signInLost();
        fixture.signInLost();
      });
      for (let i = 0; i < 20 && rendered.result.current.authSession; i++) await flush(10);
      expect(fixture.sessionReads()).toBe(2);
      expect(rendered.result.current.authSession).toBeNull();
      expect(rendered.result.current.appContext).toBeNull();
      expect(rendered.result.current.accessContext).toBeNull();
      // Signed out, nothing listens for more refusals.
      expect(fixture.listeners.size).toBe(0);
    } finally {
      await rendered.unmount();
    }
  });

  test("stays signed in when the session check still finds the person", async () => {
    const fixture = host([signedIn]);
    const rendered = await signedInApp(fixture);
    try {
      await actRun(() => fixture.signInLost());
      await flush(20);
      expect(fixture.sessionReads()).toBe(2);
      expect(rendered.result.current.authSession?.user.id).toBe("user-1");
      expect(rendered.result.current.appContext).toBeTruthy();
    } finally {
      await rendered.unmount();
    }
  });
});
