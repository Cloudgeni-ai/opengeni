import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatClient, ClientConfig } from "@opengeni/sdk";
import { forwardRef } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { actRun, flush, registerDom, renderHook } from "../../test/render-hook";
import {
  createSlackLinkPrepareController,
  PRINCIPAL_RECHECK_INTERVAL_MS,
  useAppState,
  type AppStateHost,
} from "./app-state";
import { configurePageAppHost } from "./lib/app-host";
import { browserPage, type NavigationHost } from "./lib/navigation";
import {
  resetRouteRecoveryNoticeForTests,
  takeRouteRecoveryNotice,
} from "./lib/route-recovery-notice";

registerDom();

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const location = { pathname: "/", search: {}, searchStr: "", hash: "", state: {} };
// The page loads the app afresh to leave a destination: recorded, not followed.
const pageAssign = mock((_url: string, _options?: { replace?: boolean }) => {});
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
    page: { ...browserPage, assign: pageAssign },
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

/** Another person, signed in on this browser from another tab. */
const otherPerson = {
  user: { id: "user-2", email: "other@example.test", name: "Other" },
  session: { id: "auth-session-2" },
};

type SignInLostReason = "signed_out" | "forbidden";

/**
 * A signed-in web app whose session read answers `sessions` in turn, with a
 * sign-in-lost signal the test fires the way a refused API request does.
 */
function host(sessions: (typeof signedIn | null)[]) {
  const listeners = new Set<(reason?: SignInLostReason) => void>();
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
    subscribeSignInLost: (listener: (reason?: SignInLostReason) => void) => {
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
    signInLost: (reason?: SignInLostReason) => {
      for (const listener of [...listeners]) listener(reason);
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

beforeEach(() => {
  pageAssign.mockClear();
  window.sessionStorage.clear();
  resetRouteRecoveryNoticeForTests();
});

afterEach(() => {
  resetRouteRecoveryNoticeForTests();
});

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

describe("another account signed in from another tab", () => {
  test("a refused (403) request finds the new person and loads their own workspace afresh, with a notice", async () => {
    const fixture = host([signedIn, otherPerson]);
    const rendered = await signedInApp(fixture);
    try {
      // An unsent draft the previous person left in this tab.
      window.sessionStorage.setItem("opengeni.composerDraft:workspace:session", "private text");
      await actRun(() => {
        fixture.signInLost("forbidden");
        fixture.signInLost("forbidden");
      });
      for (let i = 0; i < 20 && pageAssign.mock.calls.length === 0; i++) await flush(10);
      // One check for the burst of refusals.
      expect(fixture.sessionReads()).toBe(2);
      // A full load from the app's root: nothing held for the first person survives.
      expect(pageAssign.mock.calls).toEqual([["/", { replace: true }]]);
      expect(window.sessionStorage.getItem("opengeni.composerDraft:workspace:session")).toBeNull();
      // The next page says why it opened.
      expect(takeRouteRecoveryNotice()).toBe("account_changed");
    } finally {
      await rendered.unmount();
    }
  });

  test("a refusal for the same person (a real 403) changes nothing and is checked at most every few seconds", async () => {
    const fixture = host([signedIn, signedIn, otherPerson]);
    const rendered = await signedInApp(fixture);
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await actRun(() => fixture.signInLost("forbidden"));
      await flush(20);
      expect(fixture.sessionReads()).toBe(2);
      // Polling keeps being refused: no session read per refusal.
      await actRun(() => {
        fixture.signInLost("forbidden");
        fixture.signInLost("forbidden");
      });
      await flush(20);
      expect(fixture.sessionReads()).toBe(2);
      expect(pageAssign).not.toHaveBeenCalled();
      expect(rendered.result.current.authSession?.user.id).toBe("user-1");
      expect(rendered.result.current.appContext).toBeTruthy();
      // Once the interval has passed, the next refusal checks again.
      now += PRINCIPAL_RECHECK_INTERVAL_MS;
      await actRun(() => fixture.signInLost("forbidden"));
      for (let i = 0; i < 20 && pageAssign.mock.calls.length === 0; i++) await flush(10);
      expect(fixture.sessionReads()).toBe(3);
      expect(pageAssign.mock.calls).toEqual([["/", { replace: true }]]);
    } finally {
      Date.now = realNow;
      await rendered.unmount();
    }
  });

  test("coming back to the tab checks who is signed in", async () => {
    const fixture = host([signedIn, otherPerson]);
    const rendered = await signedInApp(fixture);
    try {
      await actRun(() => {
        window.dispatchEvent(new Event("focus"));
      });
      for (let i = 0; i < 20 && pageAssign.mock.calls.length === 0; i++) await flush(10);
      expect(fixture.sessionReads()).toBe(2);
      expect(pageAssign.mock.calls).toEqual([["/", { replace: true }]]);
    } finally {
      await rendered.unmount();
    }
  });

  test("the tab becoming visible again checks who is signed in", async () => {
    const fixture = host([signedIn, otherPerson]);
    const rendered = await signedInApp(fixture);
    try {
      await actRun(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      for (let i = 0; i < 20 && pageAssign.mock.calls.length === 0; i++) await flush(10);
      expect(fixture.sessionReads()).toBe(2);
      expect(pageAssign.mock.calls).toEqual([["/", { replace: true }]]);
    } finally {
      await rendered.unmount();
    }
  });

  test("after the app unmounts, focus checks nothing", async () => {
    const fixture = host([signedIn, otherPerson]);
    const rendered = await signedInApp(fixture);
    await rendered.unmount();
    window.dispatchEvent(new Event("focus"));
    await flush(20);
    expect(fixture.sessionReads()).toBe(1);
    expect(pageAssign).not.toHaveBeenCalled();
  });

  test("a sign-out elsewhere still returns to sign-in without a reload", async () => {
    const fixture = host([signedIn, null]);
    const rendered = await signedInApp(fixture);
    try {
      await actRun(() => fixture.signInLost("forbidden"));
      for (let i = 0; i < 20 && rendered.result.current.authSession; i++) await flush(10);
      expect(rendered.result.current.authSession).toBeNull();
      expect(pageAssign).not.toHaveBeenCalled();
      expect(takeRouteRecoveryNotice()).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});
