// Opening a chat mounts its session panel once. The route shows a loading view
// until the chat's record and history arrive, then the loaded view: both must
// render the same dock element, or it remounts as the chat appears and repeats
// every panel read (capabilities, capture, links, artifacts).
import { describe, expect, mock, test } from "bun:test";
import type { AccessContext, ChatSession as Session } from "@opengeni/sdk";
import { forwardRef, useEffect } from "react";

import type { AppContextValue } from "../src/app/app-context";
import type { AppStateHost } from "../src/app/app-state";
import * as LinkedPanel from "../src/app/components/session/linked-panel";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

let dockMounts = 0;
const realUseSessionLinks = LinkedPanel.useSessionLinks;
mock.module("../src/app/components/session/linked-panel", () => ({
  ...LinkedPanel,
  useSessionLinks: (input: Parameters<typeof realUseSessionLinks>[0]) => {
    useEffect(() => {
      dockMounts += 1;
    }, []);
    return realUseSessionLinks(input);
  },
}));

const { AppContext } = await import("../src/app/app-context");
const { createSlackLinkPrepareController, useAppState } = await import("../src/app/app-state");
const { configurePageAppHost } = await import("../src/app/lib/app-host");
const { browserPage } = await import("../src/app/lib/navigation");
const { RailProvider } = await import("../src/app/components/rail/rail-context");
const { SessionUiFeaturesProvider } = await import("../src/app/lib/session-ui-features");
const { OpenGeniProvider } = await import("../src/provider");
const { SessionRoute } = await import("../src/app/routes/session");

registerDom();

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
  } as never,
  api: {
    apiBaseUrl: "",
    request: async () => {
      throw new Error("not available in this test");
    },
    requestResponse: async () => new Response(null, { status: 404 }),
    voiceRealtimeClient: (client: never) => client,
  } as never,
});

const session = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  lastSequence: 0,
  title: "Opened",
  titleSource: "user",
  status: "idle",
  resources: [],
  tools: [],
  toolPolicy: { mode: "default" },
  model: "model-x",
  reasoningEffort: "medium",
  latencyMode: "standard",
  effectiveControl: {
    state: "active",
    controlVersion: 0,
    controlEtag: "active-0",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
    blockers: [],
    resumeOptions: [],
    override: null,
    settlement: null,
  },
  createdAt: "2026-11-26T10:00:00.000Z",
  updatedAt: "2026-11-26T10:00:00.000Z",
} as unknown as Session;

const OPTIONAL = new Set(["findGoal", "listEventPage", "updateSessionAttention"]);
type StreamOptions = { onOpen?: () => void; signal?: AbortSignal };
const FAKE_DEFAULTS = new Set([
  "getClientConfig",
  "getComposerDraft",
  "listSiteAuthConnections",
  "saveComposerDraft",
  "submitComposerDraft",
]);

describe("opening a chat", () => {
  test("mounts the session panel once across the loading and loaded views", async () => {
    let resolveSession!: (value: Session) => void;
    const sessionRead = new Promise<Session>((resolve) => {
      resolveSession = resolve;
    });
    const own: Record<string, unknown> = {
      getSession: async () => await sessionRead,
      listEvents: async () => [],
      listSessionLinks: async () => ({ links: [] }),
      connectTransport: () => ({}),
      catalogAssetUrl: () => null,
      streamEvents: (_workspaceId: string, _sessionId: string, options: StreamOptions = {}) =>
        (async function* () {
          options.onOpen?.();
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* [];
        })(),
    };
    const base = fakeClient(own as never) as unknown as Record<string, unknown>;
    // The fake's drafts and config; every other read fails, as an API
    // without that feature would.
    const client = new Proxy(own, {
      get: (target, key) => {
        if (typeof key !== "string") return undefined;
        if (key in target) return target[key];
        if (FAKE_DEFAULTS.has(key)) return base[key];
        // Optional capabilities stay absent, so the page takes its fallback.
        if (OPTIONAL.has(key) || key.startsWith("stream")) return undefined;
        return async () => {
          throw new Error(`${key} is not available in this test`);
        };
      },
      // Optional streams and capabilities are absent.
      has: (target, key) => key in target || FAKE_DEFAULTS.has(String(key)),
    });
    own.getAccessContext = async () =>
      ({
        mode: "managed",
        subjectId: "user:one",
        defaultWorkspaceId: WORKSPACE_ID,
        defaultAccountId: ACCOUNT_ID,
        accountGrants: [],
        workspaceGrants: [
          {
            workspaceId: WORKSPACE_ID,
            accountId: ACCOUNT_ID,
            subjectId: "user:one",
            permissions: ["workspace:read", "sessions:read"],
          },
        ],
      }) as AccessContext;
    own.listWorkspaces = async () => [
      { id: WORKSPACE_ID, accountId: ACCOUNT_ID, name: "Platform", settings: {} },
    ];
    const host = {
      authority: "host",
      createOpenGeniClient: () => client,
      fetchClientConfig: async () => await (base.getClientConfig as () => Promise<unknown>)(),
      captureProductEvent: () => {},
      fetchAuthSession: async () => null,
      configureManagedActorEpoch: () => {},
      getStoredAccessKey: () => null,
      setStoredAccessKey: () => {},
      clearStoredAccessKey: () => {},
      slackLink: createSlackLinkPrepareController(null),
      initialInvalidSlackLinkQueryWorkspaceId: null,
    } as unknown as AppStateHost;
    let context: AppContextValue | null = null;
    function Console(props: { open: boolean }) {
      const state = useAppState(host, { bootstrapSuspended: false });
      context = state.appContext;
      if (!context || !props.open) return null;
      return (
        <AppContext.Provider value={context}>
          <OpenGeniProvider client={context.client} workspaceId={WORKSPACE_ID}>
            <SessionUiFeaturesProvider preset="app">
              <RailProvider workspaceId={WORKSPACE_ID}>
                <SessionRoute workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />
              </RailProvider>
            </SessionUiFeaturesProvider>
          </OpenGeniProvider>
        </AppContext.Provider>
      );
    }
    const view = await renderComponent(<Console open={false} />);
    // The app state reads access and workspaces before it has a context.
    const ready = () => context !== null;
    for (let i = 0; i < 20 && !ready(); i++) await flush(10);
    await actRun(() => context!.prepareWorkspaceTransition(WORKSPACE_ID));
    await view.rerender(<Console open />);
    try {
      await flush(50);
      // The history has loaded; the chat's record has not: the loading view.
      expect(view.container.textContent).not.toContain("Send a prompt to start");
      expect(dockMounts).toBe(1);
      await actRun(() => resolveSession(session));
      await flush(50);
      // The loaded view: the conversation and its composer.
      expect(view.container.textContent).toContain("Send a prompt to start");
      expect(dockMounts).toBe(1);
    } finally {
      await view.unmount();
    }
  });
});
