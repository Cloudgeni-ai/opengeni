export {
  createSiteToolBridge,
  isSiteCatalogStaleError,
  SiteToolConsentDeclinedError,
  SiteToolConnectionRequiredError,
} from "./site-tool-bridge";
export type {
  SiteToolConsentPrompt,
  SiteToolConsentDecision,
  SiteToolConnectPrompt,
  SiteToolBridge,
  SiteToolCaller,
  SiteToolCallRequest,
  CreateSiteToolBridgeOptions,
} from "./site-tool-bridge";
import {
  OpenGeniToolsClient,
  type OpenGeniToolTransport,
  type OpenGeniWorkspaceTools,
} from "./tools";
import { OpenGeniClient } from "./client";
import { sitePortFetch, siteSessionPath, SITE_WORKSPACE } from "./site-http";
import { createOpenGeniSiteData, type OpenGeniSiteData, type OpenGeniSiteFiles } from "./site-data";
import { createOpenGeniSiteSql, type OpenGeniSiteSql } from "./site-sql";
import { createOpenGeniSiteAi, type OpenGeniSiteAi } from "./site-ai";
export type {
  OpenGeniSiteAi,
  OpenGeniSiteAiRequest,
  OpenGeniSiteAiResult,
  OpenGeniSiteAiOptions,
} from "./site-ai";
export {
  OpenGeniSiteSqlError,
  type OpenGeniSiteSql,
  type OpenGeniSiteSqlErrorCode,
  type OpenGeniSiteSqlResult,
  type OpenGeniSiteSqlValue,
} from "./site-sql";
export {
  OpenGeniSiteDataError,
  SITE_DATA_PATH_PREFIX,
  type OpenGeniSiteData,
  type OpenGeniSiteDataCollection,
  type OpenGeniSiteDataErrorCode,
  type OpenGeniSiteDataFilter,
  type OpenGeniSiteDataListOptions,
  type OpenGeniSiteDataOperation,
  type OpenGeniSiteDataPage,
  type OpenGeniSiteDataRecord,
  type OpenGeniSiteDataRef,
  type OpenGeniSiteDataScalar,
  type OpenGeniSiteDataWriteResult,
  type OpenGeniSiteFile,
  type OpenGeniSiteFiles,
} from "./site-data";
export {
  isSiteHttpRequest,
  serveSiteHttp,
  siteSessionPath,
  type SiteHttpRequest,
} from "./site-http";
import type { SiteViewer, SiteViewerCapabilities } from "@opengeni/contracts";
import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayCatalog,
  ToolGatewayDeclarationsResponse,
  ToolGatewayResolveRequest,
  ToolGatewayResolvedTool,
  ToolGatewayInvokeRequest,
  ToolGatewayInvokeResponse,
} from "./types";

export const OPENGENI_SITE_BRIDGE_VERSION = 2 as const;
export const OPENGENI_SITE_BRIDGE_CONNECT = "opengeni.site.connect" as const;
export const OPENGENI_SITE_BRIDGE_READY = "opengeni.site.ready" as const;
export const OPENGENI_SITE_BRIDGE_REQUEST = "opengeni.site.request" as const;
export const OPENGENI_SITE_BRIDGE_RESPONSE = "opengeni.site.response" as const;
export const OPENGENI_SITE_BRIDGE_CANCEL = "opengeni.site.cancel" as const;
export const OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL = "__opengeniSiteBridgeBootstrapV2" as const;
export const OPENGENI_SITE_LOCAL_CODEMODE_PATH = "/__opengeni/site-tools" as const;
/** Bridge request method that returns the viewer (advertised by `viewer: 1`). */
export const OPENGENI_SITE_BRIDGE_VIEWER_METHOD = "viewer" as const;
/** Bridge request method that asks the host to sign the viewer in (advertised by `viewer: 1`). */
export const OPENGENI_SITE_BRIDGE_SIGN_IN_METHOD = "auth.signIn" as const;
/** Bridge request method that returns the Site's current location (advertised by `location: 1`). */
export const OPENGENI_SITE_BRIDGE_LOCATION_METHOD = "location" as const;
/** Bridge request method that moves the Site to another of its own addresses (advertised by `location: 1`). */
export const OPENGENI_SITE_BRIDGE_NAVIGATE_METHOD = "location.navigate" as const;
/** Host-to-Site notification on a connected port, such as a location change. */
export const OPENGENI_SITE_BRIDGE_EVENT = "opengeni.site.event" as const;

/**
 * Where a Site is, as the host's address shows it (the bridge's wire form):
 * `path` starts with `/`, `search` is empty or starts with `?`, and `hash`
 * is empty or starts with `#`. On a published Site this is the page's real
 * address; in the console it is the Site's own address inside the console page.
 */
export type OpenGeniSiteLocationValue = {
  path: string;
  search: string;
  hash: string;
};

/**
 * The Site's location with conveniences: `href` (`path + search + hash`) and
 * `params` (the query parsed, `params.get("t")`). Values come from the
 * address bar: treat them as untrusted input, never as proof of identity.
 */
export type OpenGeniSiteLocation = OpenGeniSiteLocationValue & {
  href: string;
  params: URLSearchParams;
};

export type OpenGeniSiteNavigateOptions = {
  /** Replace the current history entry instead of adding one (no extra Back step). */
  replace?: boolean;
};

const SITE_LOCATION_BASE = "https://site.opengeni.invalid";

/** `path + search + hash`. */
export function openGeniSiteLocationHref(location: OpenGeniSiteLocationValue): string {
  return `${location.path}${location.search}${location.hash}`;
}

/**
 * Resolve `to` (`/admin`, `?tab=2`, `#top`, `../x` or an address on the same
 * Site) against the current location. Returns null when `to` leaves the Site
 * (another origin, `javascript:` and so on), is longer than 2,048 characters
 * or is not a URL at all. A path never starts with `//` (`/.//x` is `/x`), so
 * no Site address reads as another origin's.
 */
export function resolveOpenGeniSiteLocation(
  current: OpenGeniSiteLocationValue,
  to: string,
  siteOrigin: string = SITE_LOCATION_BASE,
): OpenGeniSiteLocationValue | null {
  if (to.length > OPENGENI_SITE_LOCATION_MAX_LENGTH) return null;
  let url: URL;
  let origin: string;
  try {
    const root = new URL(siteOrigin);
    origin = root.origin;
    const base = new URL(
      openGeniSiteLocationHref({ ...current, path: openGeniSitePath(current.path) }),
      root,
    );
    url = new URL(to, base);
  } catch {
    return null;
  }
  if (origin === "null" || url.origin !== origin) return null;
  return { path: openGeniSitePath(url.pathname), search: url.search, hash: url.hash };
}

/** The longest address `navigate` accepts, as for sign-in return paths. */
export const OPENGENI_SITE_LOCATION_MAX_LENGTH = 2048;

/** `path` with repeated leading slashes collapsed (`//x` is `/x`), so it never reads as an origin. */
export function openGeniSitePath(path: string): string {
  return path.replace(/^\/{2,}/u, "/");
}

/**
 * Addresses a Site never moves to: `/_og/...` belongs to the Opengeni
 * gateway (sign-in, the Site's own frame) and `/__opengeni/...` to the
 * preview host, on every host alike.
 */
export function isOpenGeniReservedSitePath(path: string): boolean {
  return ["/_og", "/__opengeni"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The wire value when `value` is a well-formed location, else null. */
export function openGeniSiteLocationValue(value: unknown): OpenGeniSiteLocationValue | null {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    value.path.startsWith("//") ||
    typeof value.search !== "string" ||
    (value.search !== "" && !value.search.startsWith("?")) ||
    typeof value.hash !== "string" ||
    (value.hash !== "" && !value.hash.startsWith("#"))
  )
    return null;
  return { path: value.path, search: value.search, hash: value.hash };
}

function siteLocation(value: OpenGeniSiteLocationValue): OpenGeniSiteLocation {
  return {
    path: value.path,
    search: value.search,
    hash: value.hash,
    href: openGeniSiteLocationHref(value),
    params: new URLSearchParams(value.search),
  };
}

/**
 * The person viewing a Site, as the host reports it. Guests of public
 * published Sites have no name or email. `id` is stable per Site and is the
 * Site Data owner principal; it is not an Opengeni subject id usable elsewhere.
 */
export type OpenGeniSiteViewer = SiteViewer;

/**
 * What the current viewer may do on this published Site, so a page can hide
 * features instead of failing: `agent`, `workspaceTools` (workspace members
 * only), `siteData` (`"guest"` when a collection's guest access applies),
 * the Site SQL query audiences the viewer may call, and `viewAs` while a
 * member previews the Site as a visitor. Anything refused at call time
 * still answers with the error code `not_available_for_viewer`.
 */
export type OpenGeniSiteCapabilities = SiteViewerCapabilities;

/** Result of `site.auth.signIn()`: `started` is true when the host began a sign-in navigation. */
export type OpenGeniSiteSignInResult = { started: boolean };

export type OpenGeniSiteBridgeConnectMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_CONNECT;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
};

export type OpenGeniSiteBridgeReadyMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_READY;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
  targetTools?: 1;
  /** The host serves Site Data for this published Site over the Site HTTP channel. */
  siteData?: 1;
  /** The host answers the `viewer` and `auth.signIn` bridge methods. */
  viewer?: 1;
  /** The host answers the `location` and `location.navigate` bridge methods and posts location events. */
  location?: 1;
};

/** Site-originated calls cannot carry host-only approval tokens or Site-version authority. */
export type OpenGeniSiteToolCallRequest = Omit<
  ToolGatewayCallRequest,
  "approvalToken" | "siteArtifactId" | "siteVersionId"
>;

/** Host-filtered catalog projection. Tenant routing context never enters Site code. */
export type OpenGeniSiteToolCatalog = Omit<ToolGatewayCatalog, "accountId" | "workspaceId">;

export type OpenGeniSiteWorkspaceTools = OpenGeniWorkspaceTools<OpenGeniSiteToolCatalog>;

export type OpenGeniSiteBridgeRequestMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_REQUEST;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
  requestId: string;
} & (
  | { method: "catalog" }
  | { method: "call"; payload: OpenGeniSiteToolCallRequest }
  | { method: "declarations" }
  | { method: "resolve"; payload: ToolGatewayResolveRequest }
  | { method: "invoke"; payload: ToolGatewayInvokeRequest }
  | { method: typeof OPENGENI_SITE_BRIDGE_VIEWER_METHOD }
  | { method: typeof OPENGENI_SITE_BRIDGE_SIGN_IN_METHOD }
  | { method: typeof OPENGENI_SITE_BRIDGE_LOCATION_METHOD }
  | {
      method: typeof OPENGENI_SITE_BRIDGE_NAVIGATE_METHOD;
      payload: { to: string; replace?: boolean };
    }
);

/** The host's location changed (back/forward, the address bar, or a navigate call). */
export type OpenGeniSiteBridgeEventMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_EVENT;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
  event: "location";
  location: OpenGeniSiteLocationValue;
};

export type OpenGeniSiteBridgeCancelMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_CANCEL;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
  requestId: string;
};

export type OpenGeniSiteBridgeResponseMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_RESPONSE;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
  requestId: string;
} & (
  | {
      ok: true;
      value:
        | OpenGeniSiteToolCatalog
        | ToolGatewayCallResponse
        | ToolGatewayDeclarationsResponse
        | ToolGatewayResolvedTool
        | ToolGatewayInvokeResponse
        | OpenGeniSiteViewer
        | OpenGeniSiteSignInResult
        | OpenGeniSiteLocationValue;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        outcomeUnknown?: boolean;
      };
    }
);

export type OpenGeniSiteClient = {
  /** Ordinary SDK, including React session/composer methods and SSE streams. */
  readonly client: OpenGeniClient;
  /** Inline AI over ordinary Site sessions. No conversation component is required. */
  readonly ai: OpenGeniSiteAi;
  /** Host-bound routing alias, not a credential or a caller-selected tenant. */
  readonly workspaceId: string;
  /** Workspace-bound typed facade. The parent host owns workspace identity and credentials. */
  readonly tools: OpenGeniSiteWorkspaceTools;
  /** Persistent collections of JSON records that belong to this published Site. */
  readonly data: OpenGeniSiteData;
  /** Files stored with this published Site. */
  readonly files: OpenGeniSiteFiles;
  /**
   * The Site's optional SQL database: run the named queries its owner
   * defined (`await site.sql.run("top_votes", { limit: 10 })`). Served by
   * hosts bound to a published Site, like `data`; the owner turns it on.
   */
  readonly sql: OpenGeniSiteSql;
  /**
   * The person viewing this Site, resolved once from the host and cached for
   * the life of the client (`await site.viewer`). In the console this is the
   * signed-in workspace member; on a published Site it is the signed-in
   * viewer or an anonymous guest (`kind: "guest"`, `signedIn: false`).
   * Resolves `null` when the host does not report viewers (older hosts and
   * local previews). A failed lookup is not cached; reading again retries.
   */
  readonly viewer: Promise<OpenGeniSiteViewer | null>;
  /**
   * What this viewer may do on the published Site (`await site.capabilities`),
   * resolved once and cached like `viewer`. Resolves `null` when the host
   * does not report it (the console, older hosts and local previews): treat
   * null as "everything the Site declares", as for a workspace member.
   */
  readonly capabilities: Promise<OpenGeniSiteCapabilities | null>;
  /**
   * Where the Site is (`await site.location`): `{ path, search, hash, href,
   * params }`, read from the host each time. On a published Site this is the
   * visitor's address, so `/unsubscribe?t=abc` gives `path` `/unsubscribe`
   * and `params.get("t")` `"abc"`. Resolves `null` on hosts that don't report
   * it (older hosts). Treat the values as untrusted input.
   */
  readonly location: Promise<OpenGeniSiteLocation | null>;
  /**
   * Move to another address of this Site (`"/admin"`, `"?tab=2"`, `"#top"`)
   * without reloading the page, adding a history entry unless `replace` is
   * set, so Back and Forward work. Resolves the new location; rejects with
   * code `invalid_location` for addresses outside the Site (open those with
   * a link or `window.open`) and `location_unsupported` on older hosts.
   */
  navigate(to: string, options?: OpenGeniSiteNavigateOptions): Promise<OpenGeniSiteLocation>;
  /**
   * Call `listener` after every location change: Back/Forward, the address
   * bar's `#hash`, and `navigate`. Render the page from the location it gets.
   * Returns a function that stops listening.
   */
  onLocationChange(listener: (location: OpenGeniSiteLocation) => void): () => void;
  readonly auth: {
    /**
     * Ask the host to sign the viewer in. On a published Site the host
     * navigates the whole page to sign-in and returns `{ started: true }`;
     * the page reloads signed in afterwards. Resolves `{ started: false }`
     * when the viewer is already signed in or the host has no sign-in.
     */
    signIn(): Promise<OpenGeniSiteSignInResult>;
  };
  close(): void;
};

export type OpenGeniSiteClientOptions = {
  /** Explicit compatibility with hosts predating targeted tool calls; never an automatic fallback. */
  toolGatewayMode?: "catalog" | "target";
  /** Advanced embedding seam; ordinary Sites accept bootstrap only from their exact parent. */
  parentWindow?: MessageEventSource;
  /** Advanced embedding seam for listening to the host's document-bound bootstrap message. */
  siteWindow?: Pick<Window, "parent" | "addEventListener" | "removeEventListener">;
  /** Test/embedding seam for an already document-bound host bootstrap port. */
  bootstrapPort?: MessagePort;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  createMessageChannel?: () => MessageChannel;
  /** Local-preview seam. Top-level pages use this same-origin Codemode proxy automatically. */
  localCodemodePath?: string | false;
  /** Test/embedding seam for local-preview requests. */
  fetch?: typeof globalThis.fetch;
  /**
   * In an Opengeni host that reports the Site's location, ordinary clicks on
   * links to the Site's own pages (`<a href="/admin">`, `?tab=2`, `../x`)
   * move the Site with `navigate` instead of loading the address inside the
   * Site's frame, where it cannot open. Links with a `target`, `download`,
   * only a `#hash`, another origin, or a modifier key are left alone. Set
   * `false` to handle links yourself.
   */
  links?: boolean;
  /** Test/embedding seam for the window whose link clicks are handled. */
  linkTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
};

export class OpenGeniSiteBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "OpenGeniSiteBridgeError";
  }
}

/**
 * Create the browser client used by a Site. Published iframes use the parent
 * MessagePort; top-level sandbox previews use the same-origin Codemode adapter.
 * Credentials remain in the selected host and never enter Site code.
 */
export function createOpenGeniSiteClient(
  options: OpenGeniSiteClientOptions = {},
): OpenGeniSiteClient {
  const transport = shouldUseLocalCodemode(options)
    ? new OpenGeniSiteLocalCodemodeTransport(options)
    : new OpenGeniSiteBridgeTransport(options);
  const siteData = createOpenGeniSiteData(
    (path, init) => transport.fetch(`https://site.opengeni.invalid${path}`, init),
    () => transport.siteDataSupported(),
  );
  const siteSql = createOpenGeniSiteSql(
    (path, init) => transport.fetch(`https://site.opengeni.invalid${path}`, init),
    () => transport.siteDataSupported(),
  );
  let viewer: Promise<OpenGeniSiteViewer | null> | null = null;
  let capabilities: Promise<OpenGeniSiteCapabilities | null> | null = null;
  const client = new OpenGeniClient({
    baseUrl: "https://site.opengeni.invalid",
    toolGatewayMode: options.toolGatewayMode ?? "target",
    fetch: (input, init) => transport.fetch(input, init),
  });
  return {
    client,
    ai: createOpenGeniSiteAi(client, SITE_WORKSPACE),
    workspaceId: SITE_WORKSPACE,
    tools: new OpenGeniToolsClient(transport).forWorkspace("site-host"),
    data: siteData.data,
    files: siteData.files,
    sql: siteSql,
    get viewer() {
      if (!viewer) {
        const pending = transport.viewer();
        viewer = pending;
        pending.catch(() => {
          if (viewer === pending) viewer = null;
        });
      }
      return viewer;
    },
    get capabilities() {
      capabilities ??= readSiteCapabilities(transport);
      return capabilities;
    },
    get location() {
      return transport.location().then((value) => (value ? siteLocation(value) : null));
    },
    navigate: async (to, navigateOptions = {}) =>
      siteLocation(await transport.navigate(String(to), navigateOptions.replace === true)),
    onLocationChange: (listener) =>
      transport.subscribeLocation((value) => listener(siteLocation(value))),
    auth: { signIn: () => transport.signIn() },
    close: () => transport.close(),
  };
}

/** What both Site transports offer for the Site's location. */
type SiteLocationTransport = {
  location(): Promise<OpenGeniSiteLocationValue | null>;
  navigate(to: string, replace: boolean): Promise<OpenGeniSiteLocationValue>;
  subscribeLocation(listener: (location: OpenGeniSiteLocationValue) => void): () => void;
};

/** Call every listener, keeping one listener's failure from reaching the others. */
function notifyLocationListeners(
  listeners: ReadonlySet<(location: OpenGeniSiteLocationValue) => void>,
  location: OpenGeniSiteLocationValue,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(location);
    } catch (error) {
      // A Site's listener bug must not stop the other listeners.
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function invalidLocation(): OpenGeniSiteBridgeError {
  return new OpenGeniSiteBridgeError(
    "invalid_location",
    "Navigate only to addresses of this Site; open other addresses with a link or window.open",
  );
}

class OpenGeniSiteLocalCodemodeTransport implements OpenGeniToolTransport, SiteLocationTransport {
  readonly toolGatewayMode: "catalog" | "target";
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly basePath: string;
  private readonly stopListening = new Set<() => void>();

  constructor(options: OpenGeniSiteClientOptions) {
    this.toolGatewayMode = options.toolGatewayMode ?? "target";
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    const configured = options.localCodemodePath;
    this.basePath = (
      typeof configured === "string" ? configured : OPENGENI_SITE_LOCAL_CODEMODE_PATH
    ).replace(/\/+$/u, "");
  }

  close(): void {
    for (const stop of [...this.stopListening]) stop();
  }

  /** Local previews have no published Site, so no Site Data. */
  async siteDataSupported(): Promise<boolean> {
    return false;
  }

  /** Local previews run outside any host that knows the viewer. */
  async viewer(): Promise<OpenGeniSiteViewer | null> {
    return null;
  }

  async signIn(): Promise<OpenGeniSiteSignInResult> {
    return { started: false };
  }

  /** A local preview is the top-level page: its own address is the Site's. */
  async location(): Promise<OpenGeniSiteLocationValue | null> {
    return localPageLocation();
  }

  async navigate(to: string, replace: boolean): Promise<OpenGeniSiteLocationValue> {
    const current = localPageLocation();
    const history = globalThis.history;
    if (!current || !history) throw siteLocationUnsupported();
    const next = resolveOpenGeniSiteLocation(current, to, globalThis.location.origin);
    if (!next || isOpenGeniReservedSitePath(next.path)) throw invalidLocation();
    const href = openGeniSiteLocationHref(next);
    if (replace) history.replaceState(history.state, "", href);
    else history.pushState(null, "", href);
    const now = localPageLocation() ?? next;
    // Every client on the page hears it, as with a bridge host.
    notifyLocationListeners(localLocationListeners, now);
    return now;
  }

  subscribeLocation(listener: (location: OpenGeniSiteLocationValue) => void): () => void {
    const unwatch = watchLocalLocation(listener);
    const stop = () => {
      unwatch();
      this.stopListening.delete(stop);
    };
    this.stopListening.add(stop);
    return stop;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    siteSessionPath(path, SITE_WORKSPACE, request.method);
    return this.fetchImpl(`${this.basePath}/sdk${path}`, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      ...(request.body ? { body: await request.text() } : {}),
    });
  }

  async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    _query?: Record<string, string>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const suffix = localCodemodeSuffix(method, path);
    const response = await this.fetchImpl(`${this.basePath}${suffix}`, {
      method,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const value = (await response.json()) as unknown;
    if (response.ok) return value as T;
    const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
    throw new OpenGeniSiteBridgeError(
      typeof envelope.code === "string" ? envelope.code : "local_codemode_error",
      typeof envelope.message === "string"
        ? envelope.message
        : `Local Site tool request failed with HTTP ${response.status}`,
      envelope.retryable === true,
      envelope.outcomeUnknown === true,
    );
  }
}

function shouldUseLocalCodemode(options: OpenGeniSiteClientOptions): boolean {
  if (options.localCodemodePath === false || options.bootstrapPort) return false;
  if (typeof options.localCodemodePath === "string") return true;
  const siteWindow = options.siteWindow ?? globalThis.window;
  return Boolean(siteWindow && siteWindow.parent === siteWindow);
}

/** The top-level page's own location, or null outside a browser page. */
function localPageLocation(): OpenGeniSiteLocationValue | null {
  const location = (globalThis as { location?: Location }).location;
  if (!location || typeof location.pathname !== "string") return null;
  return openGeniSiteLocationValue({
    path: openGeniSitePath(location.pathname || "/"),
    search: location.search,
    hash: location.hash,
  });
}

/** Location listeners of every local-preview client on this page. */
const localLocationListeners = new Set<(location: OpenGeniSiteLocationValue) => void>();
let stopLocalPopState: (() => void) | null = null;

/** Listen for the page's location changes; Back/Forward is watched only while someone listens. */
function watchLocalLocation(listener: (location: OpenGeniSiteLocationValue) => void): () => void {
  localLocationListeners.add(listener);
  if (!stopLocalPopState && typeof globalThis.addEventListener === "function") {
    const onPopState = () => {
      const now = localPageLocation();
      if (now) notifyLocationListeners(localLocationListeners, now);
    };
    globalThis.addEventListener("popstate", onPopState);
    stopLocalPopState = () => globalThis.removeEventListener("popstate", onPopState);
  }
  return () => {
    localLocationListeners.delete(listener);
    if (localLocationListeners.size > 0) return;
    stopLocalPopState?.();
    stopLocalPopState = null;
  };
}

function siteLocationUnsupported(): OpenGeniSiteBridgeError {
  return new OpenGeniSiteBridgeError(
    "location_unsupported",
    "This Site host does not support navigation",
  );
}

type SiteLinkElement = {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
};

/**
 * The address a click should move the Site to: the raw `href` of an ordinary
 * left click on a link to another page of this Site, else null. Uses the
 * attribute as written, because the frame's own URL is not the Site's.
 */
export function openGeniSiteLinkTarget(event: Event): string | null {
  const click = event as Partial<MouseEvent>;
  if (
    event.defaultPrevented ||
    (typeof click.button === "number" && click.button !== 0) ||
    click.metaKey ||
    click.ctrlKey ||
    click.shiftKey ||
    click.altKey
  )
    return null;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  const link =
    target && typeof target.closest === "function"
      ? (target.closest("a[href]") as SiteLinkElement | null)
      : null;
  if (!link || link.hasAttribute("download")) return null;
  const frameTarget = (link.getAttribute("target") ?? "").trim().toLowerCase();
  if (frameTarget !== "" && frameTarget !== "_self") return null;
  const href = (link.getAttribute("href") ?? "").trim();
  // A bare #hash scrolls within the page, as it always has.
  if (href === "" || href.startsWith("#")) return null;
  try {
    const base = new URL("/", SITE_LOCATION_BASE);
    if (new URL(href, base).origin !== base.origin) return null;
  } catch {
    return null;
  }
  return href;
}

function localCodemodeSuffix(method: string, path: string): string {
  if (method === "GET" && path.endsWith("/tools/catalog")) return "/catalog";
  if (method === "GET" && path.endsWith("/tools/declarations")) return "/declarations";
  if (method === "POST" && path.endsWith("/tools/calls")) return "/calls";
  if (method === "POST" && path.endsWith("/tools/resolve")) return "/resolve";
  if (method === "POST" && path.endsWith("/tools/invoke")) return "/invoke";
  throw new OpenGeniSiteBridgeError("unsupported_request", "Unsupported Site tool request");
}

export function isOpenGeniSiteBridgeConnectMessage(
  value: unknown,
): value is OpenGeniSiteBridgeConnectMessage {
  return (
    isRecord(value) &&
    value.type === OPENGENI_SITE_BRIDGE_CONNECT &&
    value.version === OPENGENI_SITE_BRIDGE_VERSION
  );
}

export function isOpenGeniSiteBridgeRequestMessage(
  value: unknown,
): value is OpenGeniSiteBridgeRequestMessage {
  if (
    !isRecord(value) ||
    value.type !== OPENGENI_SITE_BRIDGE_REQUEST ||
    value.version !== OPENGENI_SITE_BRIDGE_VERSION ||
    typeof value.requestId !== "string" ||
    !value.requestId
  ) {
    return false;
  }
  if (
    value.method === "catalog" ||
    value.method === "declarations" ||
    value.method === OPENGENI_SITE_BRIDGE_VIEWER_METHOD ||
    value.method === OPENGENI_SITE_BRIDGE_SIGN_IN_METHOD ||
    value.method === OPENGENI_SITE_BRIDGE_LOCATION_METHOD
  )
    return true;
  if (value.method === OPENGENI_SITE_BRIDGE_NAVIGATE_METHOD)
    return isRecord(value.payload) && typeof value.payload.to === "string";
  return ["call", "resolve", "invoke"].includes(String(value.method)) && isRecord(value.payload);
}

export function isOpenGeniSiteBridgeEventMessage(
  value: unknown,
): value is OpenGeniSiteBridgeEventMessage {
  return (
    isRecord(value) &&
    value.type === OPENGENI_SITE_BRIDGE_EVENT &&
    value.version === OPENGENI_SITE_BRIDGE_VERSION &&
    value.event === "location" &&
    openGeniSiteLocationValue(value.location) !== null
  );
}

export function isOpenGeniSiteBridgeCancelMessage(
  value: unknown,
): value is OpenGeniSiteBridgeCancelMessage {
  return (
    isRecord(value) &&
    value.type === OPENGENI_SITE_BRIDGE_CANCEL &&
    value.version === OPENGENI_SITE_BRIDGE_VERSION &&
    typeof value.requestId === "string" &&
    Boolean(value.requestId)
  );
}

/** Strip every host-only field before a call crosses the Site boundary. */
export function sanitizeOpenGeniSiteToolCallRequest(
  value: ToolGatewayCallRequest,
): OpenGeniSiteToolCallRequest {
  return {
    ...(value.operationId === undefined ? {} : { operationId: value.operationId }),
    catalogDigest: value.catalogDigest,
    identity: value.identity,
    arguments: value.arguments,
  };
}

export function sanitizeOpenGeniSiteToolInvokeRequest(
  value: ToolGatewayInvokeRequest,
): ToolGatewayInvokeRequest {
  return {
    target: value.target,
    operationId: value.operationId,
    arguments: value.arguments,
    ...(value.expectedDefinitionDigest === undefined
      ? {}
      : { expectedDefinitionDigest: value.expectedDefinitionDigest }),
  };
}

class OpenGeniSiteBridgeTransport implements OpenGeniToolTransport, SiteLocationTransport {
  readonly toolGatewayMode: "catalog" | "target";
  private targetTools = false;
  private siteData = false;
  private viewerSupported = false;
  private locationSupported = false;
  private readonly locationListeners = new Set<(location: OpenGeniSiteLocationValue) => void>();
  private readonly options: OpenGeniSiteClientOptions;
  private readonly bootstrap: SiteBridgeBootstrap;
  private port: MessagePort | null = null;
  private connecting: Promise<MessagePort> | null = null;
  private closed = false;
  private stopHandlingLinks: (() => void) | null = null;

  constructor(options: OpenGeniSiteClientOptions) {
    this.toolGatewayMode = options.toolGatewayMode ?? "target";
    this.options = options;
    this.bootstrap = createSiteBridgeBootstrap(options);
    this.handleLinks();
  }

  /**
   * Send clicks on links to the Site's own pages through `navigate` once the
   * host reports location support. Listens on the window while the click
   * bubbles, so the Site's own handlers (on the link, the document or a
   * router) run first and a `preventDefault` there keeps the link theirs.
   * Connects right away so the first click already knows; a host that never
   * answers leaves every link alone.
   */
  private handleLinks(): void {
    if (this.options.links === false) return;
    const linkTarget =
      this.options.linkTarget ??
      (typeof window === "undefined" ? undefined : (window as Window | undefined));
    if (!linkTarget || typeof linkTarget.addEventListener !== "function") return;
    const onClick = (event: Event) => {
      if (!this.locationSupported || this.closed) return;
      const to = openGeniSiteLinkTarget(event);
      if (to === null) return;
      event.preventDefault();
      this.navigate(to, false).catch((error: unknown) => {
        // A refused address (for example under /_og) keeps the Site where it is.
        console.warn("Opengeni Site link was not followed", error);
      });
    };
    linkTarget.addEventListener("click", onClick);
    this.stopHandlingLinks = () => linkTarget.removeEventListener("click", onClick);
    queueMicrotask(() => void this.connect().catch(() => undefined));
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return sitePortFetch(await this.connect(), input, init);
  }

  async siteDataSupported(): Promise<boolean> {
    await this.connect();
    return this.siteData;
  }

  async viewer(): Promise<OpenGeniSiteViewer | null> {
    await this.connect();
    if (!this.viewerSupported) return null;
    const value = await this.request({ method: OPENGENI_SITE_BRIDGE_VIEWER_METHOD }, {});
    if (!isOpenGeniSiteViewer(value))
      throw new OpenGeniSiteBridgeError(
        "invalid_viewer",
        "The Site host returned an invalid viewer",
      );
    return value;
  }

  async signIn(): Promise<OpenGeniSiteSignInResult> {
    await this.connect();
    if (!this.viewerSupported) return { started: false };
    const value = await this.request({ method: OPENGENI_SITE_BRIDGE_SIGN_IN_METHOD }, {});
    return { started: isRecord(value) && value.started === true };
  }

  async location(): Promise<OpenGeniSiteLocationValue | null> {
    await this.connect();
    if (!this.locationSupported) return null;
    return this.locationResult(
      await this.request({ method: OPENGENI_SITE_BRIDGE_LOCATION_METHOD }, {}),
    );
  }

  async navigate(to: string, replace: boolean): Promise<OpenGeniSiteLocationValue> {
    await this.connect();
    if (!this.locationSupported) throw siteLocationUnsupported();
    return this.locationResult(
      await this.request(
        {
          method: OPENGENI_SITE_BRIDGE_NAVIGATE_METHOD,
          payload: { to, ...(replace ? { replace: true } : {}) },
        },
        {},
      ),
    );
  }

  subscribeLocation(listener: (location: OpenGeniSiteLocationValue) => void): () => void {
    this.locationListeners.add(listener);
    // Connect so the host's events reach this client. A slow host gets a few
    // more tries while someone listens; one that never answers simply never
    // calls the listener.
    const attempt = (retries: number): void => {
      this.connect().catch(() => {
        if (retries > 0 && !this.closed && this.locationListeners.size > 0)
          setTimeout(() => attempt(retries - 1), 1_000);
      });
    };
    attempt(2);
    return () => {
      this.locationListeners.delete(listener);
    };
  }

  private locationResult(value: unknown): OpenGeniSiteLocationValue {
    const location = openGeniSiteLocationValue(value);
    if (!location)
      throw new OpenGeniSiteBridgeError(
        "invalid_location",
        "The Site host returned an invalid location",
      );
    return location;
  }

  async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    _query?: Record<string, string>,
    requestOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (method === "POST" && (path.endsWith("/tools/resolve") || path.endsWith("/tools/invoke"))) {
      await this.connect();
      if (!this.targetTools)
        throw new OpenGeniSiteBridgeError(
          "target_tools_unsupported",
          "Upgrade the Site host to use targeted tools",
        );
      if (!isRecord(body)) throw new TypeError("Site target payload is required");
      const request = body as ToolGatewayInvokeRequest;
      return (await this.request(
        path.endsWith("/tools/resolve")
          ? { method: "resolve", payload: { target: request.target } }
          : { method: "invoke", payload: sanitizeOpenGeniSiteToolInvokeRequest(request) },
        requestOptions,
      )) as T;
    }
    if (method === "GET" && path.endsWith("/tools/catalog")) {
      return (await this.request({ method: "catalog" }, requestOptions)) as T;
    }
    if (method === "GET" && path.endsWith("/tools/declarations")) {
      return (await this.request({ method: "declarations" }, requestOptions)) as T;
    }
    if (method === "POST" && path.endsWith("/tools/calls")) {
      if (!isRecord(body)) throw new TypeError("Site tool call payload is required");
      return (await this.request(
        {
          method: "call",
          payload: sanitizeOpenGeniSiteToolCallRequest(body as ToolGatewayCallRequest),
        },
        requestOptions,
      )) as T;
    }
    throw new OpenGeniSiteBridgeError("unsupported_request", "Unsupported Site bridge request");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHandlingLinks?.();
    this.stopHandlingLinks = null;
    this.locationListeners.clear();
    this.bootstrap.close();
    this.port?.close();
    this.port = null;
  }

  private async request(
    request:
      | Omit<
          Extract<OpenGeniSiteBridgeRequestMessage, { method: "resolve" }>,
          "type" | "version" | "requestId"
        >
      | Omit<
          Extract<OpenGeniSiteBridgeRequestMessage, { method: "invoke" }>,
          "type" | "version" | "requestId"
        >
      | { method: "catalog" }
      | { method: "call"; payload: OpenGeniSiteToolCallRequest }
      | { method: "declarations" }
      | { method: typeof OPENGENI_SITE_BRIDGE_VIEWER_METHOD }
      | { method: typeof OPENGENI_SITE_BRIDGE_SIGN_IN_METHOD }
      | { method: typeof OPENGENI_SITE_BRIDGE_LOCATION_METHOD }
      | {
          method: typeof OPENGENI_SITE_BRIDGE_NAVIGATE_METHOD;
          payload: { to: string; replace?: boolean };
        },
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    const port = await this.connect();
    const requestId = crypto.randomUUID();
    const timeoutMs = positiveTimeout(
      options.timeoutMs ?? this.options.requestTimeoutMs ?? 120_000,
      "requestTimeoutMs",
    );
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        cancel(port, requestId);
        reject(
          request.method === "call" || request.method === "invoke"
            ? new OpenGeniSiteBridgeError(
                "timeout",
                "Site tool request timed out after execution may have started",
                false,
                true,
              )
            : new OpenGeniSiteBridgeError("timeout", "Site tool request timed out", true),
        );
      }, timeoutMs);
      const abort = () => {
        cleanup();
        cancel(port, requestId);
        reject(options.signal?.reason ?? new DOMException("Request aborted", "AbortError"));
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        const response = event.data;
        if (
          !isRecord(response) ||
          response.type !== OPENGENI_SITE_BRIDGE_RESPONSE ||
          response.version !== OPENGENI_SITE_BRIDGE_VERSION ||
          response.requestId !== requestId ||
          typeof response.ok !== "boolean"
        ) {
          return;
        }
        cleanup();
        if (response.ok) {
          resolve(response.value);
          return;
        }
        const error = isRecord(response.error) ? response.error : {};
        reject(
          new OpenGeniSiteBridgeError(
            typeof error.code === "string" ? error.code : "bridge_error",
            typeof error.message === "string" ? error.message : "Site tool request failed",
            error.retryable === true,
            error.outcomeUnknown === true,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        port.removeEventListener("message", onMessage);
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      port.addEventListener("message", onMessage);
      port.postMessage({
        type: OPENGENI_SITE_BRIDGE_REQUEST,
        version: OPENGENI_SITE_BRIDGE_VERSION,
        requestId,
        ...request,
      } satisfies OpenGeniSiteBridgeRequestMessage);
    });
  }

  private async connect(): Promise<MessagePort> {
    if (this.closed) throw new OpenGeniSiteBridgeError("closed", "Site bridge is closed");
    if (this.port) return this.port;
    if (this.connecting) return await this.connecting;
    const channel = (this.options.createMessageChannel ?? (() => new MessageChannel()))();
    const timeoutMs = positiveTimeout(this.options.connectTimeoutMs ?? 10_000, "connectTimeoutMs");
    this.connecting = new Promise<MessagePort>((resolve, reject) => {
      let active = true;
      const timeout = setTimeout(() => {
        cleanup();
        channel.port1.close();
        reject(new OpenGeniSiteBridgeError("host_timeout", "The Site host did not respond"));
      }, timeoutMs);
      const onMessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (
          !isRecord(message) ||
          message.type !== OPENGENI_SITE_BRIDGE_READY ||
          message.version !== OPENGENI_SITE_BRIDGE_VERSION
        ) {
          return;
        }
        cleanup();
        this.targetTools = message.targetTools === 1;
        this.siteData = message.siteData === 1;
        this.viewerSupported = message.viewer === 1;
        this.locationSupported = message.location === 1;
        if (this.locationSupported)
          channel.port1.addEventListener("message", (hostEvent: MessageEvent<unknown>) => {
            if (isOpenGeniSiteBridgeEventMessage(hostEvent.data))
              notifyLocationListeners(
                this.locationListeners,
                openGeniSiteLocationValue(hostEvent.data.location)!,
              );
          });
        this.port = channel.port1;
        resolve(channel.port1);
      };
      const cleanup = () => {
        active = false;
        clearTimeout(timeout);
        channel.port1.removeEventListener("message", onMessage);
      };
      channel.port1.addEventListener("message", onMessage);
      channel.port1.start();
      void this.bootstrap
        .port()
        .then((bootstrapPort) => {
          if (!active) return;
          if (this.closed) throw new OpenGeniSiteBridgeError("closed", "Site bridge is closed");
          bootstrapPort.postMessage(
            {
              type: OPENGENI_SITE_BRIDGE_CONNECT,
              version: OPENGENI_SITE_BRIDGE_VERSION,
            } satisfies OpenGeniSiteBridgeConnectMessage,
            [channel.port2],
          );
        })
        .catch((error) => {
          cleanup();
          channel.port1.close();
          reject(error);
        });
    }).finally(() => {
      this.connecting = null;
    });
    return await this.connecting;
  }
}

type SiteBridgeBootstrap = {
  port: () => Promise<MessagePort>;
  close: () => void;
};

function createSiteBridgeBootstrap(options: OpenGeniSiteClientOptions): SiteBridgeBootstrap {
  if (options.bootstrapPort) {
    return {
      port: async () => options.bootstrapPort!,
      close: () => options.bootstrapPort?.close(),
    };
  }
  const siteWindow = options.siteWindow ?? globalThis.window;
  const parentWindow = options.parentWindow ?? siteWindow?.parent;
  if (!siteWindow || !parentWindow || parentWindow === siteWindow) {
    return {
      port: async () => {
        throw new OpenGeniSiteBridgeError(
          "host_unavailable",
          "The Site client must run inside a hosted iframe",
        );
      },
      close: () => undefined,
    };
  }
  const retainedPort = retainedSiteBridgeBootstrapPort(siteWindow);
  if (retainedPort) {
    return {
      port: async () => retainedPort,
      close: () => undefined,
    };
  }
  let settledPort: MessagePort | null = null;
  let rejectBootstrap: ((reason?: unknown) => void) | null = null;
  const onMessage = (event: MessageEvent<unknown>) => {
    if (
      event.source !== parentWindow ||
      !isOpenGeniSiteBridgeReadyMessage(event.data) ||
      event.ports.length !== 1
    ) {
      return;
    }
    cleanup();
    settledPort = event.ports[0]!;
    settledPort.start();
    retainSiteBridgeBootstrapPort(siteWindow, settledPort);
    resolveBootstrap?.(settledPort);
  };
  let resolveBootstrap: ((port: MessagePort) => void) | null = null;
  const cleanup = () => siteWindow.removeEventListener("message", onMessage as EventListener);
  const port = new Promise<MessagePort>((resolve, reject) => {
    resolveBootstrap = resolve;
    rejectBootstrap = reject;
    siteWindow.addEventListener("message", onMessage as EventListener);
  });
  void port.catch(() => undefined);
  return {
    port: async () => await port,
    close: () => {
      cleanup();
      rejectBootstrap?.(new OpenGeniSiteBridgeError("closed", "Site bridge is closed"));
      resolveBootstrap = null;
      rejectBootstrap = null;
    },
  };
}

function retainedSiteBridgeBootstrapPort(
  siteWindow: OpenGeniSiteClientOptions["siteWindow"],
): MessagePort | null {
  const state = (siteWindow as unknown as Record<string, unknown>)[
    OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL
  ];
  if (!isRecord(state)) return null;
  const candidate = state.port as Partial<MessagePort> | undefined;
  return candidate &&
    typeof candidate.postMessage === "function" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.start === "function"
    ? (candidate as MessagePort)
    : null;
}

function retainSiteBridgeBootstrapPort(
  siteWindow: OpenGeniSiteClientOptions["siteWindow"],
  port: MessagePort,
): void {
  try {
    Object.defineProperty(siteWindow, OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL, {
      configurable: true,
      value: { port },
    });
  } catch {
    // The bootstrap event still serves the current client when the embedding
    // window refuses extension; only late construction loses this fallback.
  }
}

function isOpenGeniSiteBridgeReadyMessage(value: unknown): value is OpenGeniSiteBridgeReadyMessage {
  return (
    isRecord(value) &&
    value.type === OPENGENI_SITE_BRIDGE_READY &&
    value.version === OPENGENI_SITE_BRIDGE_VERSION
  );
}

const SITE_VIEWER_KINDS: readonly string[] = ["member", "invited", "user", "guest"];

/** `GET /site/config` over the Site HTTP channel; null when the host does not serve it. */
async function readSiteCapabilities(transport: {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  siteDataSupported(): Promise<boolean>;
}): Promise<OpenGeniSiteCapabilities | null> {
  try {
    if (!(await transport.siteDataSupported())) return null;
    const response = await transport.fetch(
      "https://site.opengeni.invalid/v1/workspaces/site-host/site/config",
      { method: "GET", headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const value = ((await response.json()) as { capabilities?: unknown } | null)?.capabilities;
    return isOpenGeniSiteCapabilities(value) ? value : null;
  } catch {
    return null;
  }
}

function isOpenGeniSiteCapabilities(value: unknown): value is OpenGeniSiteCapabilities {
  return (
    isRecord(value) &&
    typeof value.agent === "boolean" &&
    typeof value.workspaceTools === "boolean" &&
    (value.siteData === "viewer" || value.siteData === "guest") &&
    Array.isArray(value.sqlQueryAudiences) &&
    value.sqlQueryAudiences.every(
      (audience) => audience === "everyone" || audience === "signed_in",
    ) &&
    (value.viewAs === null || value.viewAs === "invited" || value.viewAs === "public")
  );
}

function isOpenGeniSiteViewer(value: unknown): value is OpenGeniSiteViewer {
  return (
    isRecord(value) &&
    SITE_VIEWER_KINDS.includes(String(value.kind)) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.name === null || typeof value.name === "string") &&
    (value.email === null || typeof value.email === "string") &&
    typeof value.signedIn === "boolean"
  );
}

function cancel(port: MessagePort, requestId: string): void {
  port.postMessage({
    type: OPENGENI_SITE_BRIDGE_CANCEL,
    version: OPENGENI_SITE_BRIDGE_VERSION,
    requestId,
  } satisfies OpenGeniSiteBridgeCancelMessage);
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
