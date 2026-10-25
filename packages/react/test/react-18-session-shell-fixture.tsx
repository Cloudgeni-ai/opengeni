// The session shell as an embedding page mounts it, minus the data: the real
// SessionShell, rail, actions and in-memory navigation over an API whose
// requests never settle. The React 18 drawer test imports this only after
// it has swapped React 18 in, so every element here is a React 18 element.
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { ReactNode } from "react";

import type { AppContextValue } from "../src/app/app-context";
import { AppContext } from "../src/app/app-context";
import { RailProvider } from "../src/app/components/rail/rail-context";
import { SessionShell } from "../src/app/components/rail/session-shell";
import { useMemoryNavigation } from "../src/app/embed/memory-navigation";
import { ActionsProvider } from "../src/app/lib/actions/actions-provider";
import type { AppApiHost } from "../src/app/lib/app-api";
import { AppHostProvider, type AppHost } from "../src/app/lib/app-host";
import { SessionUiFeaturesProvider } from "../src/app/lib/session-ui-features";
import { OpenGeniProvider } from "../src/provider";
import { PortalContainerProvider } from "../src/ui/portal-container";

const WORKSPACE_ID = "w1";
const SESSIONS = `/workspaces/${WORKSPACE_ID}/sessions`;

const API = "https://api.example.com";
/** No request ever answers: the shell renders its chrome without data. */
const never = () => new Promise<never>(() => undefined);
const client = new OpenGeniBrowserClient({ baseUrl: API, fetch: never, onDeprecation: false });
const api: AppApiHost = {
  apiBaseUrl: API,
  request: never,
  requestResponse: never,
  voiceRealtimeClient: (current) => current,
};

const feedStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => null,
};

const appContext = new Proxy(
  {
    client,
    accessContext: {
      mode: "managed",
      subjectId: "subject-1",
      accountGrants: [],
      workspaceGrants: [],
      defaultAccountId: null,
      defaultWorkspaceId: WORKSPACE_ID,
    },
    workspaces: [],
    managedSelfContext: null,
    session: null,
    sessionEventFeedStore: feedStore,
  } as Record<string | symbol, unknown>,
  {
    // Actions the shell reaches for (resetSessionView, setInspectorOpen, …)
    // are no-ops; any other value is absent.
    get: (target, key) =>
      key in target
        ? target[key]
        : typeof key === "string" && /^(?:set|reset|refresh|clear|prepare)[A-Z]/u.test(key)
          ? () => undefined
          : undefined,
  },
) as unknown as AppContextValue;

function Host(props: { container: HTMLElement; children: ReactNode }) {
  const navigation = useMemoryNavigation({
    initialPath: SESSIONS,
    consoleOrigin: "https://app.example.com",
    handles: (pathname) => pathname.startsWith(SESSIONS),
    openUrl: () => undefined,
    openTab: () => null,
  });
  const host: AppHost = { navigation, api };
  return (
    <AppHostProvider host={host}>
      <PortalContainerProvider container={props.container}>
        {props.children}
      </PortalContainerProvider>
    </AppHostProvider>
  );
}

/** The embed's mobile shell: the chat list as a drawer behind "Open navigation". */
export function EmbeddedSessionShell(props: { container: HTMLElement }) {
  return (
    <Host container={props.container}>
      <SessionUiFeaturesProvider preset="embed">
        <AppContext.Provider value={appContext}>
          <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
            <RailProvider workspaceId={WORKSPACE_ID}>
              <ActionsProvider>
                <SessionShell>
                  <main>Session canvas</main>
                </SessionShell>
              </ActionsProvider>
            </RailProvider>
          </OpenGeniProvider>
        </AppContext.Provider>
      </SessionUiFeaturesProvider>
    </Host>
  );
}
