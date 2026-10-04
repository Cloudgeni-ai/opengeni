import { OpenGeniBrowserClient, type FetchLike } from "@opengeni/sdk/browser";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionClientLike } from "../client";
import { OpenGeniProvider } from "../provider";

/** Request headers for every proxy call: static, or computed per request. */
export type SessionProxyHeaders = Record<string, string> | (() => Record<string, string>);

export type SessionProxyBaseUrl = {
  /**
   * Mount path of your `createSessionProxyHandler` (for example
   * `"/api/opengeni"`). The component then needs no `OpenGeniProvider`,
   * client, or workspace id: it creates the browser client for that path and
   * uses the workspace the proxy resolved for the signed-in user. An explicit
   * `workspaceId` skips that lookup. A `client` you pass is used instead of
   * the created one (point it at the same proxy).
   */
  baseUrl?: string | undefined;
  /**
   * `baseUrl` mode: headers added to every proxy request, for hosts that
   * authenticate with a bearer token instead of cookies. A function is called
   * per request, so it can return the current token.
   */
  headers?: SessionProxyHeaders | undefined;
  /** `baseUrl` mode: custom fetch for every proxy request (async auth, retries). */
  fetch?: FetchLike | undefined;
};

type ScopeState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string }
  | { status: "error"; message: string };

/**
 * `OpenGeniProvider` for a same-origin session proxy, from its base URL alone.
 * The proxy's client config names the resolved workspace, so the browser
 * never handles an Opengeni id. Provider-based usage is unchanged.
 */
export function SessionProxyScope({
  baseUrl,
  workspaceId,
  client: suppliedClient,
  headers,
  fetch,
  children,
}: Omit<SessionProxyBaseUrl, "baseUrl"> & {
  baseUrl: string;
  workspaceId?: string | undefined;
  client?: SessionClientLike | undefined;
  children: ReactNode;
}) {
  if (suppliedClient && (headers !== undefined || fetch !== undefined)) {
    throw new TypeError(
      "@opengeni/react: pass headers/fetch either to your own client or as props, not both.",
    );
  }
  // Latest values without recreating the client (inline props change identity).
  const headersRef = useRef(headers);
  headersRef.current = headers;
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const hasFetch = fetch !== undefined;
  // Version skew between this bundle and the server SDK is tolerated, as for
  // any embedded host: the proxy reports its own contract revision.
  const ownClient = useMemo(
    () =>
      new OpenGeniBrowserClient({
        baseUrl,
        apiContract: "compatible",
        headers: () => {
          const current = headersRef.current;
          return typeof current === "function" ? current() : (current ?? {});
        },
        ...(hasFetch
          ? { fetch: (input, init) => (fetchRef.current ?? globalThis.fetch)(input, init) }
          : {}),
      }),
    [baseUrl, hasFetch],
  );
  const client: SessionClientLike = suppliedClient ?? ownClient;
  const [state, setState] = useState<ScopeState>(
    workspaceId ? { status: "ready", workspaceId } : { status: "loading" },
  );
  useEffect(() => {
    if (workspaceId) {
      setState({ status: "ready", workspaceId });
      return;
    }
    let active = true;
    setState({ status: "loading" });
    client.getClientConfig().then(
      (config) => {
        if (!active) return;
        setState(
          config.workspaceId
            ? { status: "ready", workspaceId: config.workspaceId }
            : {
                status: "error",
                message:
                  "This server does not report its workspace. Update @opengeni/sdk on the server, or pass workspaceId.",
              },
        );
      },
      (error: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not load the conversation.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [client, workspaceId]);

  if (state.status === "error") {
    return (
      <div role="alert" className="og-root p-3 text-og-sm text-og-danger" data-og-proxy-error="">
        {state.message}
      </div>
    );
  }
  if (state.status === "loading") {
    return <div className="og-root" aria-busy="true" data-og-proxy-loading="" />;
  }
  return (
    <OpenGeniProvider client={client} workspaceId={state.workspaceId}>
      {children}
    </OpenGeniProvider>
  );
}
