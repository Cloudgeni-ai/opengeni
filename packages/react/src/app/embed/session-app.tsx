// The Opengeni session app for an embedding page that already holds an
// authenticated API client (a first-party side pane such as the Excel add-in,
// the desktop app, a playground). It renders the web app's own session shell,
// chat list, session page and new-chat page, backed by the same app state, with
// in-memory navigation and the host's credentials. Pages that only the web app
// has (settings, billing, schedules) open the web app beside the host page.
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  OpenGeniBrowserClient,
  type FetchLike,
} from "@opengeni/sdk/browser";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";

import { OpenGeniProvider } from "../../provider";
import { SecretsUiProvider } from "../../secrets-ui";
import { Button } from "../../ui/button";
import { PortalContainerProvider } from "../../ui/portal-container";
import { AppContext, useAppContext } from "../app-context";
import { createSlackLinkPrepareController, useAppState, type AppStateHost } from "../app-state";
import { LoadingPanel, ProblemPanel } from "../components/common";
import { RailProvider } from "../components/rail/rail-context";
import { SessionShell, type SessionShellSlots } from "../components/rail/session-shell";
import { CreditRequiredGate } from "../components/credit-required-gate";
import { Toaster } from "../components/toaster";
import { WorkspaceTenantBoundary } from "../components/workspace-tenant-boundary";
import { apiErrorFromResponseBody, type AppApiHost } from "../lib/app-api";
import { AppHostProvider, type AppHost } from "../lib/app-host";
import type { EditableArtifactSurfaceProps, PdfPreviewProps } from "../lib/app-surfaces";
import { AppearanceProvider, useAppearance } from "../lib/appearance";
import { parseComposerLaunchSearch } from "../lib/composer-launch";
import { createMessageContextStore, type MessageContextInput } from "../lib/message-context";
import { openBlankTab, useLocation } from "../lib/navigation";
import { toast } from "../lib/toast";
import { UiEventTargetProvider } from "../lib/ui-events";
import { cn } from "../lib/utils";
import { webSecretsUi } from "../lib/secrets-ui";
import { parseSessionSearchRoute } from "../lib/session-search-route";
import { useWorkspaceIntegrations } from "../lib/use-workspace-integrations";
import { authorizedWorkspaceFromList } from "../lib/workspace-scope-context";
import { SessionRoute } from "../routes/session";
import { SessionsIndexRoute } from "../routes/sessions-index";
import type { ClientConfig } from "../types";
import {
  SessionUiFeaturesProvider,
  type SessionUiFeatures,
  type SessionUiPreset,
} from "../lib/session-ui-features";
import { useMemoryNavigation } from "./memory-navigation";

/**
 * Heavy viewers the host can supply (they need bundler-specific workers):
 * PDF pages, and the document, spreadsheet and presentation editor. Without
 * one, PDFs open as a link and editable artifacts open in the web app.
 */
export type SessionAppSurfaces = Readonly<{
  pdfPreview?: ComponentType<PdfPreviewProps> | undefined;
  editableArtifact?: ComponentType<EditableArtifactSurfaceProps> | undefined;
}>;

export type { EditableArtifactSurfaceProps, PdfPreviewProps };

export type SessionAppProps = Readonly<{
  /** The Opengeni API origin, such as `https://api.example.com`. */
  apiBaseUrl: string;
  /** Headers that authenticate every API call, typically `Authorization: Bearer …`. */
  headers: () => Record<string, string>;
  /**
   * The Opengeni web app's origin, such as `https://app.example.com`, where
   * pages the embed doesn't show (settings, billing, schedules) open. App paths
   * resolve against the origin, so a path after it is ignored.
   */
  consoleUrl: string;
  workspaceId: string;
  /**
   * The open chat; null or absent for the new-chat page. Changing it opens
   * that chat. The person can open others inside the app: `onSessionChange`
   * reports each, so a host that stores this value stays in step.
   */
  sessionId?: string | null | undefined;
  /** Called when the person opens another chat (null: the new-chat page). */
  onSessionChange?: ((sessionId: string | null) => void) | undefined;
  /**
   * Which features show. `embed` (default) is the chat list, chats and
   * composer; `companion` (first-party side panes) adds the session panel and
   * Opengeni's brand; `app` is the web app. `features` switches single ones.
   */
  preset?: SessionUiPreset | undefined;
  features?: Partial<SessionUiFeatures> | undefined;
  /** Sections the host adds to the shell: a workspace picker, banners, a footer. */
  slots?: SessionShellSlots | undefined;
  /** Heavy viewers the host turns on. */
  surfaces?: SessionAppSurfaces | undefined;
  /** Light or dark from the host application; the person's own choice otherwise. */
  theme?: "light" | "dark" | undefined;
  /**
   * Opens a URL outside the embed: app-only pages, provider sign-in, checkout,
   * files and images opened in full. Defaults to a new tab, or a toast with an
   * Open button when the browser blocks it. When set, flows that would open a
   * tab in advance (checkout) wait for the URL and pass it here instead.
   */
  openUrl?: ((url: string) => void) | undefined;
  /** Classes for the app's root element (it fills its container by default). */
  className?: string | undefined;
  /** Called when the API rejects the credentials (any call answering 401). */
  onUnauthorized?: (() => void) | undefined;
  /**
   * Model context added to each new chat and message, such as where the person
   * is writing from and what they have selected. Items with a `label` show as
   * pills above the composer, and the person can leave one out; pass a new
   * value whenever it changes. A function is read when each message is sent
   * and shows nothing. Context for the model, never instructions.
   */
  messageContext?: MessageContextInput;
}>;

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

function sessionsPath(workspaceId: string, sessionId?: string | null): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/sessions`;
  return sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base;
}

/** The open chat in an in-embed path, or null for the new-chat page. */
function sessionIdIn(pathname: string): string | null {
  const match = /^\/workspaces\/[^/]+\/sessions\/([^/]+)/u.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** The embed renders its own workspace's chats; anything else opens the web app. */
function handlesPath(workspaceId: string, pathname: string): boolean {
  const base = sessionsPath(workspaceId);
  if (pathname === base || pathname === `${base}/`) return true;
  return (
    pathname.startsWith(`${base}/`) &&
    !pathname
      .slice(base.length + 1)
      .replace(/\/$/u, "")
      .includes("/")
  );
}

/** A new tab; when the browser blocks it (after an await), a toast to open it by hand. */
function openBeside(url: string): void {
  const opened = window.open(url, "_blank");
  if (opened) {
    opened.opener = null;
    return;
  }
  toast.info("Continue in a new tab", {
    action: { label: "Open", onClick: () => void window.open(url, "_blank", "noopener") },
  });
}

/** Every API call, the SDK client's included, reports a 401 to the host. */
function reportingFetch(onUnauthorized: () => void): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401) onUnauthorized();
    return response;
  };
}

function createEmbedApiHost(
  apiBaseUrl: string,
  headers: () => Record<string, string>,
  fetchImpl: FetchLike,
): AppApiHost {
  const requestResponse = async (path: string, init?: RequestInit) =>
    (await fetchImpl(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        ...headers(),
        ...init?.headers,
      },
    })) as Response;
  return {
    apiBaseUrl,
    requestResponse,
    request: async <T,>(path: string, init?: RequestInit) => {
      const response = await requestResponse(path, init);
      if (!response.ok) throw apiErrorFromResponseBody(response.status, await response.text());
      return (await response.json()) as T;
    },
    voiceRealtimeClient: (client) => client,
  };
}

function signInUnavailable(): never {
  throw new Error("The embedding page signs this app in.");
}

function createEmbedStateHost(
  apiBaseUrl: string,
  headers: () => Record<string, string>,
  api: AppApiHost,
  fetchImpl: FetchLike,
): AppStateHost {
  return {
    authority: "host",
    createOpenGeniClient: (beginSharedRead) =>
      new OpenGeniBrowserClient({
        baseUrl: apiBaseUrl,
        headers,
        fetch: fetchImpl,
        beginSharedRead,
        onDeprecation: false,
        apiContract: "compatible",
      }),
    fetchClientConfig: (signal, workspaceId) =>
      api.request<ClientConfig>(
        workspaceId
          ? `/v1/config/client?workspaceId=${encodeURIComponent(workspaceId)}`
          : "/v1/config/client",
        { signal: signal ?? null },
      ),
    captureProductEvent: () => undefined,
    fetchAuthSession: async () => null,
    signInEmail: signInUnavailable,
    signUpEmail: signInUnavailable,
    signOutManaged: async () => undefined,
    startManagedSocialSignIn: signInUnavailable,
    configureManagedActorEpoch: () => undefined,
    getStoredAccessKey: () => null,
    setStoredAccessKey: () => undefined,
    clearStoredAccessKey: () => undefined,
    slackLink: createSlackLinkPrepareController(null),
    initialInvalidSlackLinkQueryWorkspaceId: null,
  };
}

/**
 * The embed's own root: the `og-root` the published stylesheet is scoped to,
 * carrying the theme so the host page's <html> is never touched.
 */
function SessionAppRoot(props: { className?: string | undefined; children: ReactNode }) {
  const { resolvedTheme } = useAppearance();
  // Overlays (menus, dialogs, sheets, tooltips) portal into this root, inside
  // the scoped stylesheet and its theme.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // Requests between its parts (open find, chat search) stay inside this app.
  const [events] = useState(() => new EventTarget());
  return (
    <div
      ref={setRoot}
      className={cn(
        "og-root og-session-app flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-bg font-sans text-fg",
        resolvedTheme === "dark" && "dark",
        props.className,
      )}
      data-og-theme={resolvedTheme}
    >
      <PortalContainerProvider container={root}>
        <UiEventTargetProvider target={events}>{props.children}</UiEventTargetProvider>
      </PortalContainerProvider>
    </div>
  );
}

/** The session page or the new-chat page, from the in-memory location. */
function SessionAppRoutes({ workspaceId }: { workspaceId: string }) {
  const location = useLocation();
  const sessionId = sessionIdIn(location.pathname);
  const launch = parseComposerLaunchSearch(location.search);
  if (sessionId) {
    return (
      <SessionRoute
        key={sessionId}
        workspaceId={workspaceId}
        sessionId={sessionId}
        launch={launch}
        realtimeAutostartModel={launch.realtime}
        searchTarget={parseSessionSearchRoute(location.search)}
      />
    );
  }
  return <SessionsIndexRoute workspaceId={workspaceId} launch={launch} />;
}

/**
 * The routed workspace, as the web app's workspace route prepares it: the app
 * state switches to this workspace before anything renders, then its
 * integrations (repositories, GitHub, the MCP catalog the composer waits on)
 * load.
 */
function SessionAppWorkspace({
  workspaceId,
  slots,
}: {
  workspaceId: string;
  slots: SessionShellSlots | undefined;
}) {
  const context = useAppContext();
  const ready = context.workspaceStateOwnerId === workspaceId;
  const workspace = authorizedWorkspaceFromList({
    workspaceId,
    workspaces: context.workspaces,
    accessContext: context.accessContext,
  });
  useWorkspaceIntegrations(context, workspaceId, workspace !== null && ready);
  return (
    <WorkspaceTenantBoundary
      workspaceId={workspaceId}
      stateOwnerWorkspaceId={context.workspaceStateOwnerId}
      prepareTransition={context.prepareWorkspaceTransition}
    >
      {workspace ? (
        <OpenGeniProvider
          client={context.client}
          workspaceId={workspaceId}
          onWorkspaceControlEvent={(event) => {
            // Only workspace-wide controls change the workspace projection.
            if (event.scope === "workspace") void context.refreshWorkspace(workspaceId);
          }}
        >
          <SecretsUiProvider value={webSecretsUi}>
            <RailProvider workspaceId={workspaceId}>
              <SessionShell slots={slots}>
                <SessionAppRoutes workspaceId={workspaceId} />
              </SessionShell>
            </RailProvider>
          </SecretsUiProvider>
        </OpenGeniProvider>
      ) : (
        <ProblemPanel
          title="This workspace isn't available"
          description="It doesn't exist, or this account can't open it."
        />
      )}
    </WorkspaceTenantBoundary>
  );
}

function SessionAppGates({
  stateHost,
  workspaceId,
  slots,
}: {
  stateHost: AppStateHost;
  workspaceId: string;
  slots: SessionShellSlots | undefined;
}) {
  const state = useAppState(stateHost, { bootstrapSuspended: false });
  let content: ReactNode;
  if (!state.clientConfig && !state.configError) content = <LoadingPanel />;
  else if (state.configError) {
    content = (
      <ProblemPanel
        title={state.configError.title}
        description={state.configError.description}
        action={
          <Button type="button" variant="outline" onClick={state.retryClientConfig}>
            Try again
          </Button>
        }
      />
    );
  } else if (state.accessError && !state.accessLoading) {
    content = (
      <ProblemPanel
        title={state.accessError.title}
        description={state.accessError.description}
        action={
          <Button type="button" variant="outline" onClick={state.retryAccess}>
            Retry
          </Button>
        }
      />
    );
  } else if (state.accessLoading || !state.appContext) content = <LoadingPanel />;
  else {
    const context = state.appContext;
    content = (
      <AppContext.Provider value={context}>
        <SessionAppWorkspace workspaceId={workspaceId} slots={slots} />
        <CreditRequiredGate
          creditRequired={state.creditRequired}
          setCreditRequired={state.setCreditRequired}
          accessContext={state.accessContext}
        />
      </AppContext.Provider>
    );
  }
  return (
    <>
      {content}
      <Toaster embedded />
    </>
  );
}

/**
 * The full Opengeni session app inside a host page: chat list, session page,
 * new-chat page and composer, exactly as the web app renders them.
 */
export function SessionApp(props: SessionAppProps) {
  // The workspace and API are the host's choice: another one starts a fresh app.
  return (
    <SessionAppForWorkspace
      key={`${props.workspaceId}\u0000${props.apiBaseUrl}\u0000${props.consoleUrl}`}
      {...props}
    />
  );
}

function SessionAppForWorkspace(props: SessionAppProps) {
  const apiBaseUrl = trimSlash(props.apiBaseUrl);
  const consoleUrl = trimSlash(props.consoleUrl);
  const latest = useRef(props);
  latest.current = props;
  const reportedSessionId = useRef<string | null>(props.sessionId ?? null);
  const navigation = useMemoryNavigation({
    initialPath: sessionsPath(props.workspaceId, props.sessionId),
    consoleOrigin: consoleUrl,
    handles: (pathname) => handlesPath(latest.current.workspaceId, pathname),
    openUrl: (url) => (latest.current.openUrl ?? openBeside)(url),
    // A host that shows URLs its own way (Excel opens them in the system
    // browser) cannot take a tab opened in advance.
    openTab: () => (latest.current.openUrl ? null : openBlankTab()),
    onLocationChange: (location) => {
      const sessionId = sessionIdIn(location.pathname);
      if (sessionId === reportedSessionId.current) return;
      reportedSessionId.current = sessionId;
      latest.current.onSessionChange?.(sessionId);
    },
  });
  // A new `sessionId` from the host opens that chat.
  const requestedSessionId = props.sessionId ?? null;
  useEffect(() => {
    const current = sessionIdIn(new URL(navigation.page.href()).pathname);
    if (requestedSessionId !== current) {
      navigation.page.assign(sessionsPath(props.workspaceId, requestedSessionId));
    }
  }, [navigation, props.workspaceId, requestedSessionId]);
  const { api, stateHost } = useMemo(() => {
    const headers = () => latest.current.headers();
    const fetchImpl = reportingFetch(() => latest.current.onUnauthorized?.());
    const apiHost = createEmbedApiHost(apiBaseUrl, headers, fetchImpl);
    return {
      api: apiHost,
      stateHost: createEmbedStateHost(apiBaseUrl, headers, apiHost, fetchImpl),
    };
  }, [apiBaseUrl]);
  const [messageContext] = useState(() => createMessageContextStore(props.messageContext));
  useEffect(() => messageContext.set(props.messageContext), [messageContext, props.messageContext]);
  const pdfPreview = props.surfaces?.pdfPreview;
  const editableArtifact = props.surfaces?.editableArtifact;
  const host = useMemo<AppHost>(
    () => ({
      navigation,
      api,
      surfaces: {
        ...(pdfPreview ? { pdfPreview } : {}),
        ...(editableArtifact ? { editableArtifact } : {}),
      },
      messageContext,
    }),
    [api, editableArtifact, messageContext, navigation, pdfPreview],
  );
  return (
    <AppearanceProvider hostTheme={props.theme} scope="local">
      <AppHostProvider host={host}>
        <SessionUiFeaturesProvider preset={props.preset ?? "embed"} features={props.features}>
          <SessionAppRoot className={props.className}>
            <SessionAppGates
              stateHost={stateHost}
              workspaceId={props.workspaceId}
              slots={props.slots}
            />
          </SessionAppRoot>
        </SessionUiFeaturesProvider>
      </AppHostProvider>
    </AppearanceProvider>
  );
}
