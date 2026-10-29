// Where the session route's chat sits. On its own page it is the page's open
// chat: it publishes its session, connection and event feed to the app (the
// header, the sidebar's row projections and the command menu read them),
// remembers itself as the last chat and reports to an embedding host. In a
// panel beside another view (the Site view) it is not the page's chat, so it
// keeps all of that to itself.
import type { Session } from "@opengeni/sdk";
import type { SessionCreationHandoff } from "../app-context";

export type SessionRoutePlacement = "page" | "panel";

type AppStateTargets = {
  setSession: unknown;
  setConnectionState: unknown;
  sessionEventFeedStore: unknown;
};

/** A panel chat's updates to the page's open-chat state, which it doesn't own. */
function ignoreRoutedUpdate(): void {}

/**
 * The app-wide session state the route writes to. A panel chat gets no-op
 * setters and its own event feed store.
 */
export function sessionRouteAppState<T extends AppStateTargets>(
  placement: SessionRoutePlacement,
  context: T,
  panelEventFeed: T["sessionEventFeedStore"],
): {
  routed: boolean;
  setSession: T["setSession"];
  setConnectionState: T["setConnectionState"];
  sessionEventFeedStore: T["sessionEventFeedStore"];
} {
  if (placement === "page") {
    return {
      routed: true,
      setSession: context.setSession,
      setConnectionState: context.setConnectionState,
      sessionEventFeedStore: context.sessionEventFeedStore,
    };
  }
  return {
    routed: false,
    setSession: ignoreRoutedUpdate as T["setSession"],
    setConnectionState: ignoreRoutedUpdate as T["setConnectionState"],
    sessionEventFeedStore: panelEventFeed,
  };
}

/**
 * The creation handoff for `sessionId`: the one its host passed takes
 * precedence. The app's own handoff only applies to the page's open chat, so
 * a panel never picks up a chat the page itself just created.
 */
export function sessionRouteCreationHandoff(input: {
  sessionId: string;
  given: SessionCreationHandoff | null | undefined;
  app: SessionCreationHandoff | null;
  appSession: Pick<Session, "id"> | null;
  routed: boolean;
}): SessionCreationHandoff | null {
  const { sessionId, given, app, appSession, routed } = input;
  if (given?.session.id === sessionId) return given;
  if (routed && app?.session.id === sessionId && appSession?.id === sessionId) return app;
  return null;
}
