// What the session UI asks of the page that renders it: routing, the API calls
// it makes outside the SDK client, optional heavy surfaces and per-message
// context. There is one host per app. The page that owns the document (the
// web app) configures its host once with `configurePageAppHost`; an embedded
// app passes its own through `AppHostProvider`, so two embeds on one page never
// share one, and an embed never touches the page around it (its title, its
// URL, its find shortcut).
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { AppApiHost } from "./app-api";
import type { AppSurfaces } from "./app-surfaces";
import type { MessageContextPill, MessageContextStore } from "./message-context";
import type { NavigationHost } from "./navigation";

export type AppHost = Readonly<{
  navigation: NavigationHost;
  api: AppApiHost;
  /** Optional surfaces; an absent one renders its plain fallback or nothing. */
  surfaces?: Partial<AppSurfaces> | undefined;
  /**
   * Model context the page adds to each new chat and message (where the person
   * is writing from, such as an open workbook, and what they selected there).
   * Labeled items show as pills above the composer. Context, never
   * instructions.
   */
  messageContext?: MessageContextStore | undefined;
}>;

const AppHostContext = createContext<AppHost | null>(null);

let pageHost: Partial<AppHost> = {};

/**
 * Sets the host of the page that owns the document, before the session UI
 * renders. Parts merge into what is set (tests set only the parts they use).
 */
export function configurePageAppHost(host: Partial<AppHost>): void {
  pageHost = {
    ...pageHost,
    ...host,
    surfaces: { ...pageHost.surfaces, ...host.surfaces },
  };
}

export function AppHostProvider(props: { host: AppHost; children?: ReactNode }) {
  return <AppHostContext.Provider value={props.host}>{props.children}</AppHostContext.Provider>;
}

/** This app's host: the embed's own, or the page's. */
export function useAppHost(): Partial<AppHost> {
  return useContext(AppHostContext) ?? pageHost;
}

/** Whether this app is embedded in a page it does not own. */
export function useEmbedded(): boolean {
  return useContext(AppHostContext) !== null;
}

/** Reads the host's per-message model context at send time, if it supplies one. */
export function useHostMessageContext(): (() => string | undefined) | undefined {
  const store = useAppHost().messageContext;
  const read = useCallback(() => store?.forSend(), [store]);
  return store ? read : undefined;
}

const NO_PILLS: readonly MessageContextPill[] = [];
const noSubscription = () => () => {};

/** The host's context pills for the composer, with the controls to leave one out. */
export function useMessageContextPills(): {
  pills: readonly MessageContextPill[];
  exclude: (id: string) => void;
  include: (id: string) => void;
} {
  const store = useAppHost().messageContext;
  const pills = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.pills ?? (() => NO_PILLS),
    store?.pills ?? (() => NO_PILLS),
  );
  return {
    pills,
    exclude: (id) => store?.exclude(id),
    include: (id) => store?.include(id),
  };
}
